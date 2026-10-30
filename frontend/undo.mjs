const record=(state,key)=>Object.hasOwn(state.records,key)?structuredClone(state.records[key]):null;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

export function createRecordUndo({store,now=Date.now,ttl=10000}) {
  let pending=null,sequence=0,undoing=false;
  function peek() {
    if(!pending)return null;
    try {
      if(now()>=pending.expiresAt||!same(record(store.read(),pending.key),pending.after))pending=null;
    }catch {pending=null;}
    return pending?structuredClone(pending):null;
  }
  return {
    peek,
    discard(){pending=null;},
    async edit(key,updater) {
      let before,after;
      const result=await store.update(current=>{
        before=record(current,key);after=updater(structuredClone(before));
        const records={...current.records};
        if(after===null)delete records[key];else records[key]=structuredClone(after);
        return {...current,records};
      });
      after=record(result,key);
      if(!same(before,after))pending={id:++sequence,key,before,after,expiresAt:now()+ttl};
      return result;
    },
    async undo() {
      const intent=peek();
      if(!intent||undoing)throw new Error('Undo is no longer available.');
      undoing=true;
      try {
        const result=await store.update(current=>{
          if(pending?.id!==intent.id||now()>=intent.expiresAt||!same(record(current,intent.key),intent.after)){
            if(pending?.id===intent.id)pending=null;
            throw new Error('Undo is no longer available.');
          }
          const records={...current.records};
          if(intent.before===null)delete records[intent.key];else records[intent.key]=structuredClone(intent.before);
          return {...current,records};
        });
        if(pending?.id===intent.id)pending=null;
        return result;
      }finally {undoing=false;}
    }
  };
}
