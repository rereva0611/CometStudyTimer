import {dayKey,validDate,localDate,offsetDate,emptyTimer,validTimer,pauseTimer,splitInterval} from './core.mjs';
import {validSessionRange,localRangeOffsets} from './session-time.mjs';
export {clockRange,sessionClockText,relocateSessionRange} from './session-time.mjs';
const fail=()=>{throw new Error('Invalid study session or daily total.');};
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const subject=v=>typeof v==='string'&&[...v].length<=120;
// Current loads may contain a day already reached in the original timezone.
// Explicit historical cutoffs remain deterministic for callers and tests.
const recordCutoff=today=>today===dayKey()?([today,new Date(Date.now()+14*3600000).toISOString().slice(0,10)].sort().at(-1)):today;
export function normalizeRecords(records,today=dayKey()) {
 if(!object(records)||Object.keys(records).length>50000)fail();
 const result={},ids=new Set(),cutoff=recordCutoff(today);let count=0;
 for(const [key,record] of Object.entries(records)) {
  if(!validDate(key)||key>cutoff||!object(record)||!Number.isInteger(record.seconds)||record.seconds<0||record.seconds>86400)fail();
  const note=Object.hasOwn(record,'note')?record.note:'';if(!subject(note)||(Object.hasOwn(record,'sessions')&&!Object.hasOwn(record,'note')))fail();
  const list=Object.hasOwn(record,'sessions')?record.sessions:record.seconds?[{id:`legacy:${key}`,seconds:record.seconds,note,start:null,end:null,source:'legacy'}]:[];
  if(!Array.isArray(list))fail();
  const sessions=list.map(s=>{
   if(!object(s)||typeof s.id!=='string'||! /^[A-Za-z0-9_:-]{1,100}$/.test(s.id)||ids.has(s.id)||!Number.isInteger(s.seconds)||s.seconds<1||s.seconds>86400||!subject(s.note)||!['legacy','manual','timer'].includes(s.source))fail();
   ids.add(s.id);if(++count>50000)fail();
   if(!validSessionRange(key,s))fail();
   return {id:s.id,seconds:s.seconds,note:s.note,start:s.start,end:s.end,source:s.source,...(Object.hasOwn(s,'utcOffsets')?{utcOffsets:structuredClone(s.utcOffsets)}:{})};
  });
  if(sessions.reduce((n,s)=>n+s.seconds,0)!==record.seconds)fail();
  if(sessions.length&&note!==sessions.at(-1).note)fail();
  result[key]={seconds:record.seconds,note,sessions};
 }
 return result;
}
const timerSession=(records,id)=>Object.values(records).some(day=>day.sessions.some(s=>s.id===id&&s.source==='timer'));
function backupIdentity(data,records) {
 if(!Object.hasOwn(data,'lastTimerSessionId'))return {};
 const id=data.lastTimerSessionId;
 if(id!==null&&(typeof id!=='string'||! /^[A-Za-z0-9_:-]{1,100}$/.test(id)||!timerSession(records,id)))fail();
 return {lastTimerSessionId:id};
}
export function normalizeBackup(data,today=dayKey()) {
 if(!object(data)||data.version!==1)fail();const records=normalizeRecords(data.records,today);
 return {records,goal:Number.isInteger(data.goal)&&data.goal>=5&&data.goal<=1440?data.goal:120,...backupIdentity(data,records)};
}
export function makeBackup(state,exportedAt=new Date().toISOString()) {
 const normalized=normalizeStudyState(state);
 return {version:1,exportedAt,goal:normalized.goal,records:normalized.records,...(Object.hasOwn(normalized,'lastTimerSessionId')?{lastTimerSessionId:normalized.lastTimerSessionId}:{})};
}
export function mergeBackup(current,backup,today=dayKey()) {
 const valid=normalizeBackup({version:1,...backup},today),records=normalizeRecords({...current.records,...valid.records},today);
 let lastTimerSessionId=valid.lastTimerSessionId??null;
 if(!Object.hasOwn(valid,'lastTimerSessionId')&&timerSession(records,current.lastTimerSessionId)&&!Object.values(valid.records).some(day=>day.sessions.some(s=>s.id===current.lastTimerSessionId)))lastTimerSessionId=current.lastTimerSessionId;
 return normalizeStudyState({...current,records,goal:valid.goal,lastTimerSessionId},today);
}
export function normalizeStudyState(data,today=dayKey()) {
 let candidate=data;
 if(object(data)&&Object.hasOwn(data,'lastTimerSessionId')){const id=data.lastTimerSessionId;if(id!==null&&(typeof id!=='string'||! /^[A-Za-z0-9_:-]{1,100}$/.test(id)))fail();if(id!==null&&object(data.records)&&!Object.values(data.records).some(day=>Array.isArray(day?.sessions)&&day.sessions.some(s=>s?.id===id&&s.source==='timer')))candidate={...data,lastTimerSessionId:null};}
 const normalized=normalizeBackup(candidate,today),timer=Object.hasOwn(data,'timer')?data.timer:emptyTimer();if(!validTimer(timer)||!subject(timer.note)||Object.keys(timer.allocations).length>50000||(timer.intervals?.length??0)>50000)fail();
 for(const key of Object.keys(timer.allocations))if(key>recordCutoff(today))fail();
 return {...data,version:1,...normalized,timer:structuredClone(timer)};
}
export function applySession(records,key,id,value,today=dayKey()) {
 if(!validDate(key)||typeof id!=='string')fail();
 const result=normalizeRecords(records,today),list=result[key]?.sessions??[],index=list.findIndex(s=>s.id===id);
 if(key>today&&index<0&&value!==null)fail();
 if(value===null&&index<0)return result;
 if(value!==null&&value.id!==id)fail();
 if(value===null){if(index>=0)list.splice(index,1);}else if(index>=0)list[index]=structuredClone(value);else list.push(structuredClone(value));
 if(list.length)result[key]={seconds:list.reduce((n,s)=>n+s.seconds,0),note:list.at(-1).note,sessions:list};else delete result[key];
 return normalizeRecords(result,today);
}
export function finishSession(state,now=Date.now(),id=crypto.randomUUID(),today=dayKey()) {
 const current=normalizeStudyState(state,today),done=pauseTimer(current.timer,now);let records=current.records,saved=false,lastTimerSessionId=null;
 for(const [key,ms] of Object.entries(done.allocations)) {
  const seconds=Math.floor(ms/1000);if(!seconds)continue;
  let start=null,end=null,known=0;
  for(const interval of done.intervals??[]){const chunks=splitInterval(interval.start,interval.end);if(chunks[key]){known+=chunks[key];const lo=localDate(key).getTime(),hi=localDate(offsetDate(key,1)).getTime();start=start===null?Math.max(lo,interval.start):Math.min(start,Math.max(lo,interval.start));end=Math.max(end??0,Math.min(hi,interval.end));}}
  if(known!==ms){start=null;end=null;}
  if(Object.values(records).some(day=>day.sessions.some(s=>s.id===`${id}:${key}`)))fail();
  records=applySession(records,key,`${id}:${key}`,{id:`${id}:${key}`,seconds,note:done.note,start,end,source:'timer',...(start===null?{}:{utcOffsets:localRangeOffsets(key,start,end)})},recordCutoff(today));saved=true;lastTimerSessionId=`${id}:${key}`;
 }
 if(!saved)throw new Error('Record at least 1 second before saving.');
 return {...current,records,timer:emptyTimer(),lastTimerSessionId};
}
