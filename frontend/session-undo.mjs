import {applySession} from './sessions.mjs';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const locate=(state,id)=>{for(const [key,day] of Object.entries(state.records)){const session=day.sessions?.find(s=>s.id===id);if(session)return {key,session:structuredClone(session)};}return null;};
export function createSessionUndo({store,now=Date.now,ttl=10000}) {
 let pending=null,sequence=0,undoing=false;
 const unavailable=()=>new Error('Undo is no longer available.');
 function peek(){if(pending){try{if(now()>=pending.expiresAt||!same(locate(store.read(),pending.sessionId),pending.after))pending=null;}catch{pending=null;}}return pending?structuredClone(pending):null;}
 return {peek,discard(){pending=null;},async edit(key,id,updater,{newKey=key,requireExisting=false}={}){
  let before,after,originalOrder,emptyDestination,timerIdentity;
  const result=await store.update(current=>{
   before=locate(current,id);if(before&&before.key!==key)throw new Error('This session changed. Reopen it before editing.');
   timerIdentity=before&&current.lastTimerSessionId===id?{before:id}:null;
   originalOrder=before?current.records[before.key].sessions.map(s=>s.id):null;
   const destination=current.records[newKey];
   emptyDestination=destination?.seconds===0&&!destination.sessions?.length?{key:newKey,note:destination.note??''}:null;
   if(requireExisting&&!before)throw new Error('This session no longer exists.');
   const value=updater(before?structuredClone(before.session):null);
   let records=current.records;
   if(newKey!==key&&before)records=applySession(records,key,id,null);
   records=applySession(records,newKey,id,value);after=value===null?null:{key:newKey,session:structuredClone(value)};
   return {...current,records};
  });
  after=locate(result,id);
  if(timerIdentity)timerIdentity.after=result.lastTimerSessionId;
  if(!same(before,after))pending={id:++sequence,sessionId:id,key,newKey,before,after,originalOrder,emptyDestination,timerIdentity,expiresAt:now()+ttl};
  return result;
 },async undo(){
  const intent=peek();if(!intent||undoing)throw unavailable();undoing=true;
  try{const result=await store.update(current=>{
   if(pending?.id!==intent.id||now()>=intent.expiresAt||!same(locate(current,intent.sessionId),intent.after)){if(pending?.id===intent.id)pending=null;throw unavailable();}
   let records=current.records;if(intent.after)records=applySession(records,intent.after.key,intent.sessionId,null);
   if(intent.after&&intent.emptyDestination&&!records[intent.emptyDestination.key])records[intent.emptyDestination.key]={seconds:0,note:intent.emptyDestination.note,sessions:[]};
   if(intent.before){
    records=applySession(records,intent.before.key,intent.sessionId,intent.before.session);
    const day=records[intent.before.key],list=day.sessions,target=list.splice(list.findIndex(s=>s.id===intent.sessionId),1)[0],originalIndex=intent.originalOrder.indexOf(intent.sessionId);
    // Restore between surviving original neighbors; later additions stay after the original tail.
    const successor=intent.originalOrder.slice(originalIndex+1).find(id=>list.some(s=>s.id===id));
    const predecessor=intent.originalOrder.slice(0,originalIndex).reverse().find(id=>list.some(s=>s.id===id));
    const index=successor!==undefined?list.findIndex(s=>s.id===successor):predecessor!==undefined?list.findIndex(s=>s.id===predecessor)+1:Math.min(originalIndex,list.length);
    list.splice(index,0,target);day.note=list.at(-1).note;
   }
   return {...current,records,...(intent.timerIdentity&&current.lastTimerSessionId===intent.timerIdentity.after?{lastTimerSessionId:intent.timerIdentity.before}:{})};
  });if(pending?.id===intent.id)pending=null;return result;}finally{undoing=false;}
 }};
}
