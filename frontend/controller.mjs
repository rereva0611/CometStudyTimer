import {dayKey,emptyTimer,startTimer,pauseTimer,timerMilliseconds} from './core.mjs';
import {normalizeStudyState,finishSession} from './sessions.mjs';
import {createSessionUndo} from './session-undo.mjs';
import {sameValue} from './value-equality.mjs';
import {lastTimerTask} from './last-task.mjs';
const idle=timer=>timer.startedAt===null&&!Object.keys(timer.allocations).length&&!(timer.intervals?.length);
const locate=(state,id)=>{for(const [date,day] of Object.entries(state.records)){const session=day.sessions.find(s=>s.id===id);if(session)return {date,session};}return null;};
const unavailable=()=>new Error('Undo is no longer available.');
const subject=value=>{
  if(typeof value!=='string')throw new Error('Subject must be text.');
  return [...value].slice(0,120).join('');
};
// Version 1 has no paused flag. An allocation key with 0ms retains session
// identity when pause and start happen at the same instant.
function paused(timer,at,key){
  const result=pauseTimer(timer,at);
  if(timer.startedAt!==null&&!Object.keys(result.allocations).length){
    result.allocations={[key(new Date(timer.startedAt))]:0};
  }
  return result;
}
export function createStudyController({store,now=Date.now,key=dayKey,id=()=>crypto.randomUUID(),validate=normalizeStudyState}) {
  let pending=null,queue=Promise.resolve();
  const listeners=new Set(),requests=new Map();
  const recordUndo=createSessionUndo({store,now});
  function eligible(state,intent){
    return now()<intent.expiresAt&&sameValue(state.timer,emptyTimer())&&intent.generated.every(target=>sameValue(locate(state,target.session.id),target));
  }
  function peek(){if(pending&&!eligible(store.read(),pending))pending=null;return pending?structuredClone(pending):null;}
  function snapshot(){const undo=peek();return {state:store.read(),revision:store.revision(),undo:undo?{expiresAt:undo.expiresAt}:null,ready:true,error:null};}
  function publish(){const value=snapshot();for(const listener of listeners){try{listener(structuredClone(value));}catch{/* State remains durable if a view fails. */}}}
  store.subscribe(()=>publish());
  function discard(){if(pending){pending=null;publish();}}
  async function undo(){
    const intent=peek();if(!intent)throw unavailable();
    let result;
    try{result=await store.update(current=>{
      if(pending!==null&&pending.token===intent.token&&eligible(current,intent)){
        const records=structuredClone(current.records);
        for(const {date,session} of intent.generated){
          const day=records[date],remaining=day.sessions.filter(s=>s.id!==session.id);
          if(remaining.length)records[date]={seconds:remaining.reduce((n,s)=>n+s.seconds,0),note:remaining.at(-1).note,sessions:remaining};
          else if(intent.beforeDays[date])records[date]={seconds:0,note:intent.beforeDays[date].note,sessions:[]};
          else delete records[date];
        }
        const restored={...current,records,timer:structuredClone(intent.timer)};
        if(intent.previousLastTimerSessionId===undefined)delete restored.lastTimerSessionId;
        else restored.lastTimerSessionId=intent.previousLastTimerSessionId;
        return validate(restored);
      }
      pending=null;throw unavailable();
    });}catch(error){if(!pending)publish();throw error;}
    if(pending?.token===intent.token)pending=null;
    publish();return result;
  }
  async function process(action){
    if(action.type==='snapshot')return snapshot();
    if(action.type==='undo'){await undo();return snapshot();}
    const at=now(),date=key(new Date(at));
    const note=Object.hasOwn(action,'note')?subject(action.note):undefined;
    // Capture once per intent. Retries keep timestamps and generated IDs stable.
    const finishId=action.type==='finish'?id():null;
    let finishCapture=null,clearUndo=false;
    await store.update(current=>{
      finishCapture=null;clearUndo=false;
      const timer=current.timer;
      if(action.expectedTimer&&!sameValue(action.expectedTimer,{startedAt:timer.startedAt,allocations:timer.allocations,intervals:timer.intervals||[]}))throw new Error('Timer changed. Try the action again.');
      let next=timer;
      switch(action.type){
        case 'continue-last':{
          if(!idle(timer))return current;
          const last=lastTimerTask(current);
          if(!last)throw new Error('No previous task to continue.');
          next=startTimer({...emptyTimer(),note:last.note},at);clearUndo=true;break;
        }
        case 'start':
          if(!idle(timer))return current;
          next=startTimer({...timer,...(note===undefined?{}:{note})},at);clearUndo=true;break;
        case 'pause':
          if(timer.startedAt===null)return current;
          next=paused({...timer,...(note===undefined?{}:{note})},at,key);break;
        case 'resume':
          if(timer.startedAt!==null||idle(timer))return current;
          next=startTimer({...timer,...(note===undefined?{}:{note})},at);clearUndo=true;break;
        case 'subject':
          next={...timer,note:note??''};clearUndo=true;break;
        case 'finish':{
          if(idle(timer))return current;
          const done=paused({...timer,...(note===undefined?{}:{note})},at,key);
          // finishSession deliberately rejects empty saves; the controller treats
          // them as a durable reset without creating a day or an Undo intent.
          if(timerMilliseconds(done)<1000||!Object.values(done.allocations).some(ms=>ms>=1000)){
            clearUndo=true;return validate({...current,timer:emptyTimer()});
          }
          const finished=finishSession({...current,timer:done},at,finishId,date);
          const generated=[],beforeDays={};
          for(const [day,record] of Object.entries(finished.records)){
            const generatedSession=record.sessions.find(s=>s.id===`${finishId}:${day}`);
            if(generatedSession){generated.push({date:day,session:structuredClone(generatedSession)});beforeDays[day]=current.records[day]?structuredClone(current.records[day]):null;}
          }
          finishCapture={token:finishId,timer:structuredClone(done),generated,beforeDays,previousLastTimerSessionId:current.lastTimerSessionId};
          return validate(finished);
        }
        default:throw new Error('Unknown timer action.');
      }
      return validate({...current,timer:next});
    });
    if(clearUndo)pending=null;
    if(finishCapture)pending={...finishCapture,expiresAt:now()+10000};
    publish();return snapshot();
  }
  function trimRequests(){
    // Never evict pending requests; settled entries are a bounded retry cache.
    if(requests.size<=512)return;
    for(const [requestId,entry] of requests){if(entry.settled){requests.delete(requestId);if(requests.size<=512)break;}}
  }
  function dispatch(requestId,action){
    if(typeof requestId!=='string'||!/^[A-Za-z0-9_:-]{1,128}$/.test(requestId))return Promise.reject(new Error('Invalid request ID.'));
    if(!action||typeof action!=='object'||Array.isArray(action)||!['start','continue-last','pause','resume','subject','finish','undo','snapshot'].includes(action.type))return Promise.reject(new Error('Unknown timer action.'));
    const intent=structuredClone(action),signature=JSON.stringify(Object.fromEntries(Object.entries(intent).sort(([a],[b])=>a.localeCompare(b))));
    const existing=requests.get(requestId);
    if(existing)return existing.signature===signature?existing.promise:Promise.reject(new Error('Request ID was already used for a different action.'));
    if(requests.size>=512){
      const settled=[...requests].find(([,entry])=>entry.settled);
      if(settled)requests.delete(settled[0]);
      else return Promise.reject(new Error('Too many pending requests. Try again after the current action completes.'));
    }
    const promise=queue.then(()=>process(intent));queue=promise.catch(()=>{});
    const entry={signature,promise,settled:false};requests.set(requestId,entry);
    promise.then(()=>{entry.settled=true;trimRequests();},()=>{entry.settled=true;trimRequests();});trimRequests();
    return promise;
  }
  return {store,recordUndo,dispatch,snapshot,subscribe(listener){listeners.add(listener);return ()=>listeners.delete(listener);},refresh(external){return store.refresh(external).then(()=>snapshot());},finishUndo:{peek,discard,undo:()=>dispatch(crypto.randomUUID(),{type:'undo'})}};
}
