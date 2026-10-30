import {validDate,localDate,dayKey} from './core.mjs';
const DAY=86400000,MINUTE=60000,MAX_OFFSET=840;
const fail=()=>{throw new Error('Invalid study session or daily total.');};
const midnight=key=>Date.parse(`${key}T00:00:00.000Z`);
const hasOffsets=session=>Object.hasOwn(session,'utcOffsets');
// Legacy files cannot reveal their original zone. Accept only a possible civil
// day in the supported UTC-14..UTC+14 window, with at most a 26-hour DST day.
export function validSessionRange(key,session) {
 const {start,end,seconds}=session,offsets=session.utcOffsets,lo=midnight(key),hi=lo+DAY;
 if(start===null&&end===null)return !hasOffsets(session);
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||end<=start||end-start>26*3600000||seconds>Math.floor((end-start)/1000))return false;
 if(!hasOffsets(session))return start>=lo-MAX_OFFSET*MINUTE&&start<hi+MAX_OFFSET*MINUTE&&end>lo-MAX_OFFSET*MINUTE&&end<=hi+MAX_OFFSET*MINUTE;
 if(!offsets||typeof offsets!=='object'||Array.isArray(offsets)||Object.keys(offsets).length!==2||!['start','end'].every(edge=>Number.isInteger(offsets[edge])&&Math.abs(offsets[edge])<=MAX_OFFSET))return false;
 const a=start+offsets.start*MINUTE,b=end+offsets.end*MINUTE;
 return a>=lo&&a<hi&&b>=lo&&b<=hi;
}
export function sessionClockText(session,edge='start') {
 if(!['start','end'].includes(edge))fail();const timestamp=session[edge];if(timestamp===null)return '';
 const offset=session.utcOffsets?.[edge],date=new Date(timestamp+(offset??0)*MINUTE);
 const hour=offset===undefined?date.getHours():date.getUTCHours(),minute=offset===undefined?date.getMinutes():date.getUTCMinutes();
 return `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`;
}
export function relocateSessionRange(session,origin,key) {
 if(!validDate(origin)||!validDate(key)||!validSessionRange(origin,session))fail();
 const result={start:session.start,end:session.end};if(hasOffsets(session))result.utcOffsets=structuredClone(session.utcOffsets);
 if(origin===key||session.start===null)return result;
 const days=(midnight(key)-midnight(origin))/DAY;
 if(hasOffsets(session)){result.start+=days*DAY;result.end+=days*DAY;}
 else {for(const edge of ['start','end']){const date=new Date(result[edge]);date.setDate(date.getDate()+days);result[edge]=date.getTime();}}
 if(!validSessionRange(key,{...session,...result}))fail();return result;
}
export function localRangeOffsets(key,start,end) {
 const boundary=dayKey(new Date(end))!==key&&dayKey(new Date(end-1))===key;
 return {start:-new Date(start).getTimezoneOffset(),end:-new Date(boundary?end-1:end).getTimezoneOffset()};
}
export function clockRange(key,startClock,endClock,utcOffsets) {
 if(!validDate(key))fail();if(!startClock&&!endClock)return {start:null,end:null};
 const parse=v=>{if(typeof v!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(v))fail();return v.split(':').map(Number);};
 const [sh,sm]=parse(startClock),[eh,em]=parse(endClock);
 if(utcOffsets!==undefined){
  const start=midnight(key)+(sh*60+sm)*MINUTE-utcOffsets?.start*MINUTE,end=midnight(key)+(eh*60+em)*MINUTE+(eh===0&&em===0&&(sh!==0||sm!==0)?DAY:0)-utcOffsets?.end*MINUTE;
  const result={start,end,utcOffsets:structuredClone(utcOffsets)};if(!validSessionRange(key,{...result,seconds:1}))fail();return result;
 }
 const start=localDate(key),end=localDate(key);start.setHours(sh,sm,0,0);end.setHours(eh,em,0,0);
 if(eh===0&&em===0&&(sh!==0||sm!==0))end.setDate(end.getDate()+1);
 // A nonexistent clock during a spring transition must not silently move forward.
 if(start.getHours()!==sh||start.getMinutes()!==sm||((eh!==0||em!==0)&&(end.getHours()!==eh||end.getMinutes()!==em))||end<=start)fail();
 const result={start:start.getTime(),end:end.getTime(),utcOffsets:localRangeOffsets(key,start.getTime(),end.getTime())};if(!validSessionRange(key,{...result,seconds:1}))fail();return result;
}
