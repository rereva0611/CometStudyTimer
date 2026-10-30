export const dayKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
export const localDate = key => { const [y,m,d]=key.split('-').map(Number); return new Date(y,m-1,d); };
export const validDate = key => typeof key === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(key) && key.slice(0,4) >= '1900' && dayKey(localDate(key)) === key;
export const offsetDate = (key, delta) => { const d=localDate(key); d.setDate(d.getDate()+delta); return dayKey(d); };
export function calendarCells(year) {
  const result=Array(new Date(year,0,1).getDay()).fill(null);
  for(let d=new Date(year,0,1);d.getFullYear()===year;d.setDate(d.getDate()+1)) result.push({key:dayKey(d),weekday:d.getDay(),month:d.getMonth()});
  while(result.length%7) result.push(null);
  return result;
}
export function setRecord(records, key, seconds, note='', mode='replace', today=dayKey()) {
  if(!validDate(key)||key>today) throw new Error('Choose a valid date on or before today.');
  if(!Number.isInteger(seconds)||seconds<0||seconds>86400) throw new Error('Duration must be between 0 and 24 hours.');
  if(!['add','replace'].includes(mode)) throw new Error('Invalid recording mode.');
  const total=seconds+(mode==='add'?(records[key]?.seconds||0):0);
  if(total>86400) throw new Error('Daily total exceeds 24 hours. Check the existing record.');
  return {...records,[key]:{seconds:total,note:String(note).trim().slice(0,120)}};
}
export function splitInterval(from,to) {
  if(!Number.isFinite(from)||!Number.isFinite(to)||to<from) throw new Error('Your device clock changed. Check the time settings.');
  const result={};
  while(from<to) {
    const date=new Date(from),key=dayKey(date);
    const midnight=new Date(date.getFullYear(),date.getMonth(),date.getDate()+1).getTime();
    const end=Math.min(to,midnight);
    result[key]=(result[key]||0)+end-from;
    from=end;
  }
  return result;
}
export const emptyTimer = () => ({startedAt:null,allocations:{},note:'',intervals:[]});
export function validTimer(timer) {
  return !!timer && (timer.startedAt===null || (Number.isFinite(timer.startedAt)&&timer.startedAt>=0)) &&
    timer.allocations && !Array.isArray(timer.allocations) && typeof timer.allocations==='object' &&
    Object.entries(timer.allocations).every(([key,ms])=>validDate(key)&&Number.isFinite(ms)&&ms>=0) &&
    (!Object.hasOwn(timer,'intervals') || (Array.isArray(timer.intervals)&&timer.intervals.every((v,i)=>v&&Number.isSafeInteger(v.start)&&Number.isSafeInteger(v.end)&&v.start>=0&&v.end>v.start&&(i===0||timer.intervals[i-1].end<=v.start)) && (timer.startedAt===null||!timer.intervals.length||timer.intervals.at(-1).end<=timer.startedAt))); 
}
export function startTimer(timer, now=Date.now()) {
  return timer.startedAt===null?{...timer,startedAt:now,intervals:timer.intervals??[]}:timer;
}
export function pauseTimer(timer, now=Date.now()) {
  if(timer.startedAt===null) return timer;
  const allocations={...timer.allocations};
  for(const [key,ms] of Object.entries(splitInterval(timer.startedAt,now))) allocations[key]=(allocations[key]||0)+ms;
  const intervals=[...(timer.intervals||[])];
  if(now>timer.startedAt)intervals.push({start:timer.startedAt,end:now});
  return {...timer,startedAt:null,allocations,intervals};
}
export function timerMilliseconds(timer, now=Date.now()) {
  return Object.values(timer.allocations).reduce((a,b)=>a+b,0)+(timer.startedAt===null?0:Math.max(0,now-timer.startedAt));
}
export function finishTimer(records,timer,now=Date.now(),today=dayKey()) {
  const done=pauseTimer(timer,now);
  if(timerMilliseconds(done)<1000) throw new Error('Record at least 1 second before saving.');
  let result={...records};
  for(const [key,ms] of Object.entries(done.allocations)) {
    const seconds=Math.floor(ms/1000);
    if(seconds) result=setRecord(result,key,seconds,done.note||result[key]?.note||'','add',today);
  }
  return result;
}
export function statistics(records,today=dayKey()) {
  const dates=Object.keys(records).filter(k=>validDate(k)&&k<=today&&records[k].seconds>0).sort();
  const weekday=localDate(today).getDay();
  const weekStart=offsetDate(today,-((weekday+6)%7));
  let longest=0,run=0,previous=null;
  for(const key of dates) { run=previous&&offsetDate(previous,1)===key?run+1:1; longest=Math.max(longest,run); previous=key; }
  let cursor=records[today]?.seconds>0?today:offsetDate(today,-1),streak=0;
  while(records[cursor]?.seconds>0) {streak++;cursor=offsetDate(cursor,-1);}
  return {total:dates.reduce((a,k)=>a+records[k].seconds,0),week:dates.filter(k=>k>=weekStart).reduce((a,k)=>a+records[k].seconds,0),days:dates.length,streak,longest};
}
export function validateBackup(data,today=dayKey()) {
  if(!data||data.version!==1||!data.records||typeof data.records!=='object'||Array.isArray(data.records)) throw new Error('This is not a valid Comet backup (version 1).');
  const entries=Object.entries(data.records);
  if(entries.length>50000) throw new Error('This backup contains too many records.');
  const records={};
  for(const [key,record] of entries) {
    if(!record||typeof record.note!=='undefined'&&typeof record.note!=='string') throw new Error('This backup contains an invalid subject.');
    Object.assign(records,setRecord({},key,record.seconds,record.note||'','replace',today));
  }
  return {records,goal:Number.isInteger(data.goal)&&data.goal>=5&&data.goal<=1440?data.goal:120};
}
export const heatLevel = seconds => seconds===0?0:seconds<1800?1:seconds<7200?2:seconds<14400?3:seconds<21600?4:seconds<28800?5:6;
export function durationText(seconds) {
  if(seconds===0) return '0min';
  if(seconds<60) return '<1min';
  const m=Math.floor(seconds/60),h=Math.floor(m/60);
  return h?`${h}h${m%60?` ${m%60}min`:''}`:`${m}min`;
}
export const timerText = seconds => [Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60].map(n=>String(n).padStart(2,'0')).join(':');
