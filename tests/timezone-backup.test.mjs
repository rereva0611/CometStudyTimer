import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import * as sessions from '../frontend/sessions.mjs';
import {lastTimerTask} from '../frontend/last-task.mjs';
const today='2026-10-15',key='2026-10-10';
const timed={id:'timer:one',source:'timer',note:'Original',seconds:3600,start:Date.parse('2026-10-10T00:00:00+08:00'),end:Date.parse('2026-10-10T01:00:00+08:00')};
const record=s=>({seconds:s.seconds,note:s.note,sessions:[s]});
const state=(s=timed)=>({version:1,goal:120,records:{[key]:record(s)},timer:{startedAt:null,allocations:{},note:''},lastTimerSessionId:s.id});
function child(zone,script,data){const result=spawnSync(process.execPath,['--input-type=module','-e',`import * as s from './frontend/sessions.mjs'; const value=JSON.parse(process.env.COMET_TEST_DATA); ${script}`],{cwd:new URL('..',import.meta.url),encoding:'utf8',env:{...process.env,TZ:zone,COMET_TEST_DATA:JSON.stringify(data)}});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);}
test('legacy clock ranges load unchanged after changing local timezone',()=>{
 for(const zone of ['UTC','America/Los_Angeles','Pacific/Honolulu'])assert.deepEqual(child(zone,`console.log(JSON.stringify(s.normalizeStudyState(value,'${today}')));`,state()).records,state().records);
});
test('recorded offsets survive normalization and render the original clock',()=>{
 const value={...timed,utcOffsets:{start:480,end:480}},r=sessions.normalizeStudyState(state(value),today);
 assert.deepEqual(r.records[key].sessions[0],value);
 assert.deepEqual(child('America/New_York',`console.log(JSON.stringify([s.sessionClockText(value,'start'),s.sessionClockText(value,'end')]));`,value),['00:00','01:00']);
});
test('timezone-independent validation still rejects unrelated epochs and invalid offsets',()=>{
 for(const value of [{...timed,start:0,end:3600000},{...timed,utcOffsets:{start:0,end:0}},{...timed,utcOffsets:{start:841,end:480}},{...timed,utcOffsets:{start:480}},{...timed,start:null,end:null,utcOffsets:{start:480,end:480}}])assert.throws(()=>sessions.normalizeStudyState(state(value),today));
});
test('new local clock ranges record per-endpoint offsets including DST and midnight',()=>{
 const a=child('America/New_York',`console.log(JSON.stringify(s.clockRange('2026-11-01','00:30','02:30')));`,{});
 assert.deepEqual(a.utcOffsets,{start:-240,end:-300});assert.equal(a.end-a.start,3*3600000);
 const value={...timed,...a,seconds:10800};assert.doesNotThrow(()=>sessions.normalizeRecords({'2026-11-01':record(value)},'2026-11-02'));
 const midnight=child('Asia/Shanghai',`console.log(JSON.stringify(s.clockRange('${key}','23:00','00:00')));`,{});assert.deepEqual(midnight.utcOffsets,{start:480,end:480});
 assert.doesNotThrow(()=>sessions.normalizeRecords({[key]:record({...timed,...midnight})},today));
});
test('range relocation retains original offsets and timestamp precision',()=>{
 const value={...timed,start:timed.start+123,end:timed.end+456,utcOffsets:{start:480,end:480}};
 assert.deepEqual(sessions.relocateSessionRange(value,key,key),{start:value.start,end:value.end,utcOffsets:value.utcOffsets});
 const moved=sessions.relocateSessionRange(value,key,'2026-10-11');assert.equal(moved.start,value.start+86400000);assert.deepEqual(moved.utcOffsets,value.utcOffsets);
});
test('backup roundtrip retains last saved identity after a later session timestamp edit',()=>{
 const other={...timed,id:'timer:two',note:'Latest saved',start:timed.end,end:timed.end+3600000};
 let current=state({...timed,end:timed.end+7200000});current.records[key]={seconds:7200,note:other.note,sessions:[current.records[key].sessions[0],other]};current.lastTimerSessionId=other.id;
 const exported=sessions.makeBackup(current,'2026-10-15T00:00:00.000Z');const normalized=sessions.normalizeBackup(JSON.parse(JSON.stringify(exported)),today);
 assert.equal(normalized.lastTimerSessionId,other.id);assert.equal(lastTimerTask({...current,...normalized}).note,other.note);
 const imported=sessions.mergeBackup({...state(),lastTimerSessionId:timed.id},normalized,today);assert.equal(lastTimerTask(imported).id,other.id);
});
test('old backups remain compatible and importing replaced records clears stale identity',()=>{
 const old={version:1,goal:60,records:{[key]:record({...timed,id:'legacy:other'})}};
 assert.equal(Object.hasOwn(sessions.normalizeBackup(old,today),'lastTimerSessionId'),false);
 assert.equal(sessions.mergeBackup(state(),old,today).lastTimerSessionId,null);
 for(const lastTimerSessionId of [12,'bad space','missing'])assert.throws(()=>sessions.normalizeBackup({...old,lastTimerSessionId},today));
 const manual={...timed,id:'manual',source:'manual'};assert.throws(()=>sessions.normalizeBackup({...old,records:{[key]:record(manual)},lastTimerSessionId:'manual'},today));
});
test('merged backups reject duplicate session IDs across distinct dates',()=>{
 const incoming={version:1,goal:120,records:{'2026-10-09':record({...timed,start:null,end:null})}};
 assert.throws(()=>sessions.mergeBackup(state(),incoming,today));
});
test('an existing session edits its original clock with its recorded offsets',()=>{
 const range=sessions.clockRange(key,'00:15','01:15',{start:480,end:480});
 assert.equal(range.start,timed.start+15*60000);assert.deepEqual(range.utcOffsets,{start:480,end:480});
 const fold=sessions.clockRange('2026-11-01','01:45','01:15',{start:-240,end:-300});assert.equal(fold.end-fold.start,30*60000);
});
test('loading after moving west permits only the current worldwide day, while manual entry stays local',()=>{
 const script=`const OriginalDate=Date;globalThis.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:['2026-10-10T22:00:00Z']));}static now(){return OriginalDate.parse('2026-10-10T22:00:00Z');}}; const r=s.normalizeStudyState(value); let rejected=false;try{s.applySession({},'2026-10-11','manual',{id:'manual',seconds:1,note:'',start:null,end:null,source:'manual'});}catch{rejected=true;}console.log(JSON.stringify({r,rejected}));`;
 const value={version:1,goal:120,records:{'2026-10-11':{seconds:60,note:'Legacy'}},timer:{startedAt:null,allocations:{'2026-10-11':1000},note:''}};
 const result=child('Pacific/Honolulu',script,value);assert.equal(result.r.records['2026-10-11'].seconds,60);assert.equal(result.rejected,true);
 assert.throws(()=>child('Pacific/Honolulu',script,{...value,records:{'2026-10-12':{seconds:60,note:'Future'}}}));
});
test('deleting the saved timer clears state identity without making exported dangling pointers valid',()=>{
 const current=state();current.records={};assert.equal(sessions.normalizeStudyState(current,today).lastTimerSessionId,null);assert.throws(()=>sessions.normalizeBackup(current,today));
});
test('finishing a timed session stores offsets for both endpoints',()=>{
 const result=child('Asia/Shanghai',`const out=s.finishSession(value,Date.parse('2026-10-10T01:00:00+08:00'),'finish','${today}');console.log(JSON.stringify(out.records['${key}'].sessions[0]));`,{...state(),records:{},lastTimerSessionId:null,timer:{startedAt:timed.start,allocations:{},note:'New',intervals:[]}});
 assert.deepEqual(result.utcOffsets,{start:480,end:480});
});
test('a timer ending at skipped midnight records the previous day boundary clock',()=>{
 const value={version:1,goal:120,records:{},timer:{startedAt:1541300340000,allocations:{},note:'DST',intervals:[]}};
 const result=child('America/Sao_Paulo',`console.log(JSON.stringify(s.finishSession(value,1541300400000,'dst','2018-11-05')));`,value);
 const saved=result.records['2018-11-03'].sessions[0];assert.equal(saved.end,1541300400000);assert.equal(sessions.sessionClockText(saved,'end'),'00:00');assert.deepEqual(saved.utcOffsets,{start:-180,end:-180});
});
test('pre-travel next-day records remain editable and accumulated timers can finish',()=>{
 const script=`const OriginalDate=Date;globalThis.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:['2026-10-10T22:00:00Z']));}static now(){return OriginalDate.parse('2026-10-10T22:00:00Z');}};const old=value.records['2026-10-11'].sessions[0];const records=s.applySession(value.records,'2026-10-11',old.id,{...old,note:'Edited'});console.log(JSON.stringify(s.finishSession({...value,records},Date.now(),'saved')));`;
 const value={version:1,goal:120,records:{'2026-10-11':record({...timed,start:null,end:null})},timer:{startedAt:null,allocations:{'2026-10-11':1000},note:'Earlier',intervals:[]},lastTimerSessionId:timed.id};
 const result=child('Pacific/Honolulu',script,value);assert.equal(result.records['2026-10-11'].sessions[0].note,'Edited');assert.equal(result.records['2026-10-11'].sessions[1].seconds,1);
});
