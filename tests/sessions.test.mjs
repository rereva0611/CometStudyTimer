import test from 'node:test';
import assert from 'node:assert/strict';
import * as sessions from '../frontend/sessions.mjs';
import {emptyTimer,startTimer,pauseTimer} from '../frontend/core.mjs';
const key='2026-10-10',today='2026-10-11';
const entry=(id='one',seconds=61)=>({id,seconds,note:'Math',start:null,end:null,source:'manual'});
test('starting a legacy empty timer enables native quit interval capture',()=>{
 const legacy={startedAt:null,allocations:{},note:'Reading'};
 const started=startTimer(legacy,Date.parse('2026-10-10T09:00:00'));
 assert.deepEqual(started.intervals,[]);
 assert.equal(started.note,'Reading');
 assert.equal(legacy.startedAt,null);
 const withUnknown=startTimer({...legacy,allocations:{[key]:1500}},Date.parse('2026-10-10T09:00:00'));
 assert.deepEqual(withUnknown.intervals,[]);
 assert.deepEqual(withUnknown.allocations,{[key]:1500});
});
test('absent ID removal preserves legacy zero day',()=>{
 const records={[key]:{seconds:0,note:'Zero'}};
 assert.deepEqual(sessions.applySession(records,key,'missing',null,today),sessions.normalizeRecords(records,today));
});
test('JSON rich days require a string note while legacy omission remains compatible',()=>{
 for(const seconds of [0,61])for(const note of [null,undefined]){
  const record={seconds,note,sessions:seconds?[{...entry(),note:''}]:[]};
  assert.throws(()=>sessions.normalizeRecords(JSON.parse(JSON.stringify({[key]:record})),today));
 }
 assert.throws(()=>sessions.normalizeRecords({[key]:{seconds:0,note:null}},today));
 assert.equal(sessions.normalizeRecords({[key]:{seconds:0}},today)[key].note,'');
});
test('state without timer uses empty timer and present timer retains shape',()=>{
 const state={version:1,goal:120,records:{}};
 assert.deepEqual(sessions.normalizeStudyState(state,today).timer,emptyTimer());
 const timer={startedAt:null,allocations:{},note:'Old'};
 assert.deepEqual(sessions.normalizeStudyState({...state,timer},today).timer,timer);
 assert.throws(()=>sessions.normalizeStudyState({...state,timer:null},today));
});
test('state timer enforces native subject allocation and interval limits',()=>{
 const state={version:1,records:{},timer:emptyTimer()};
 assert.equal(sessions.normalizeStudyState({...state,timer:{...state.timer,note:'📚'.repeat(120)}},today).timer.note.length,240);
 assert.throws(()=>sessions.normalizeStudyState({...state,timer:{...state.timer,note:'📚'.repeat(121)}},today));
});
test('state rejects more than 50000 timer intervals',()=>{
 const state={version:1,records:{},timer:emptyTimer()};
 const intervals=Array.from({length:50001},(_,i)=>({start:i*2,end:i*2+1}));
 assert.throws(()=>sessions.normalizeStudyState({...state,timer:{...state.timer,intervals}},today));
});
test('state rejects more than 50000 timer allocations',()=>{
 const state={version:1,records:{},timer:emptyTimer()};
 const allocations={};for(let i=0;i<50000;i++){const date=new Date(1900,0,1+i);allocations[`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`]=1;}
 assert.equal(Object.keys(sessions.normalizeStudyState({...state,timer:{...state.timer,allocations}},'2100-01-01').timer.allocations).length,50000);
 allocations['2099-12-31']=1;assert.throws(()=>sessions.normalizeStudyState({...state,timer:{...state.timer,allocations}},'2100-01-01'));
});
test('legacy migration keeps exact positive and zero records',()=>{
 const r=sessions.normalizeRecords({[key]:{seconds:8319,note:'Math'},[today]:{seconds:0,note:'Zero'}},today);
 assert.equal(r[key].sessions[0].seconds,8319);assert.equal(r[key].sessions[0].start,null);assert.equal(r[key].sessions[0].source,'legacy');assert.deepEqual(r[today],{seconds:0,note:'Zero',sessions:[]});assert.deepEqual(sessions.normalizeRecords(r,today),r);
});
test('rich backup roundtrip rejects corrupt totals duplicate ids and time boundaries',()=>{
 const r=sessions.applySession({},key,'one',entry(),today);assert.deepEqual(sessions.normalizeBackup({version:1,records:r,goal:240},today),{records:r,goal:240});
 for(const records of [{[key]:{...r[key],seconds:62}},{...r,[today]:r[key]},{[key]:{...r[key],sessions:[{...entry(),start:0,end:61000}]}},{'2026-10-12':r[key]}])assert.throws(()=>sessions.normalizeRecords(records,today));
 assert.throws(()=>sessions.applySession(r,key,'two',entry('two',86400),today));
});
test('separate sessions and subject edits preserve exact duration and timestamp precision',()=>{
 let r=sessions.applySession({},key,'one',entry(),today);r=sessions.applySession(r,key,'two',entry('two'),today);assert.equal(r[key].seconds,122);
 r=sessions.applySession(r,key,'one',{...r[key].sessions[0],note:'Physics'},today);assert.equal(r[key].sessions[0].seconds,61);r=sessions.applySession(r,key,'one',null,today);assert.equal(r[key].seconds,61);r=sessions.applySession(r,key,'two',null,today);assert.deepEqual(r,{});
});
test('manual clock range permits next midnight and rejects incomplete or zero ranges',()=>{
 const range=sessions.clockRange(key,'23:59','00:00');assert.equal(range.end-range.start,60000);assert.deepEqual(sessions.clockRange(key,'',''),{start:null,end:null});
 for(const pair of [['12:00',''],['12:00','12:00'],['24:00','00:00'],['13:00','12:00']])assert.throws(()=>sessions.clockRange(key,...pair));
});
test('timer pause resume records known intervals across midnight without counting pauses',()=>{
 const begin=new Date(2026,9,10,23,59,30).getTime();let timer=startTimer(emptyTimer(),begin);timer=pauseTimer(timer,begin+60000);timer=startTimer(timer,begin+120000);
 const result=sessions.finishSession({version:1,goal:120,records:{},timer},begin+180000,'timer',today);
 assert.equal(result.records[key].seconds,30);assert.equal(result.records[today].seconds,90);assert.equal(result.records[today].sessions[0].end,begin+180000);assert.deepEqual(result.timer,emptyTimer());assert.equal(timer.intervals.length,1);
});
test('old timer allocations retain unknown timestamps',()=>{
 const result=sessions.finishSession({version:1,goal:120,records:{},timer:{startedAt:null,allocations:{[key]:61000},note:'Old'}},0,'old',today);assert.equal(result.records[key].sessions[0].start,null);
});
test('state validation preserves old timer and rejects overlapping intervals',()=>{
 const timer={startedAt:null,allocations:{[key]:61000},note:'Old'};assert.deepEqual(sessions.normalizeStudyState({version:1,goal:120,records:{},timer},today).timer,timer);
 assert.throws(()=>sessions.normalizeStudyState({version:1,records:{},timer:{...timer,intervals:[{start:10,end:30},{start:20,end:40}]}},today));
 assert.throws(()=>sessions.normalizeStudyState({version:1,records:{},timer:{...timer,startedAt:15,intervals:[{start:10,end:30}]}},today));
});
test('manual range can end later today and preserves milliseconds and Unicode note',()=>{
 const range=sessions.clockRange(today,'22:00','23:00'),value={...entry(),...range,start:range.start+123,seconds:61,note:'📚'.repeat(120)};const r=sessions.applySession({},today,'one',value,today);assert.equal(r[today].sessions[0].start,range.start+123);assert.equal(r[today].note,value.note);
 assert.throws(()=>sessions.applySession({},today,'one',{...value,note:value.note+'a'},today));
});
test('finishing with an already used timer id cannot overwrite an existing session',()=>{
 const id=`timer:${key}`,records=sessions.applySession({},key,id,entry(id),today);
 assert.throws(()=>sessions.finishSession({version:1,goal:120,records,timer:{startedAt:null,allocations:{[key]:61000},note:'New'}},0,'timer',today));
});
