// Every mutation is computed inside one queue. Native candidates remain private
// until CAS succeeds, so a failed retry never publishes a speculative state.
export function createStateStore({readRaw,writeRaw,readSnapshot,writeSnapshot,validate,initial}) {
  const native=typeof readSnapshot==='function';
  let cached,raw=null,ready=false,revision=0,queue=Promise.resolve();
  const listeners=new Set();
  const unavailable=()=>new Error('Your data is unavailable. Keep a backup and restart Comet.');
  function publish(){for(const listener of listeners){try{listener(structuredClone(cached));}catch{/* A subscriber cannot undo a durable write. */}}}
  function checkedSnapshot(snapshot){
    if(!snapshot||!Number.isSafeInteger(snapshot.revision)||snapshot.revision<0)throw new Error('Invalid storage revision.');
    return {value:validate(snapshot.value===null?initial():snapshot.value),revision:snapshot.revision};
  }
  function accept(value,nextRevision,serialized=JSON.stringify(value)){
    cached=structuredClone(value);raw=serialized;revision=nextRevision;ready=true;
    publish();return structuredClone(cached);
  }
  function enqueue(work){const operation=queue.then(work);queue=operation.catch(()=>{});return operation;}
  return {
    load(){return enqueue(async()=>{
      ready=false;
      if(native){const next=checkedSnapshot(await readSnapshot());return accept(next.value,next.revision);}
      raw=await readRaw();const next=validate(raw===null?initial():JSON.parse(raw));return accept(next,revision,raw);
    });},
    read(){if(!ready)throw unavailable();return structuredClone(cached);},
    raw:()=>raw,
    revision:()=>revision,
    subscribe(listener){listeners.add(listener);return ()=>listeners.delete(listener);},
    refresh(external){return enqueue(async()=>{
      try{
        const returned=external?await external():undefined;
        if(native){const next=checkedSnapshot(await readSnapshot());return accept(next.value,next.revision);}
        const updatedRaw=returned===undefined?await readRaw():JSON.stringify(returned);
        return accept(validate(updatedRaw===null?initial():JSON.parse(updatedRaw)),revision+1,updatedRaw);
      }catch(error){ready=false;throw error;}
    });},
    update(transform){return enqueue(async()=>{
      if(!ready)throw unavailable();
      let basis=structuredClone(cached),expected=revision;
      for(let retry=0;;retry++){
        const next=validate(transform(structuredClone(basis))),serialized=JSON.stringify(next);
        if(!native){await writeRaw(serialized);return accept(next,revision+1,serialized);}
        try{
          const saved=checkedSnapshot(await writeSnapshot(next,expected));
          return accept(saved.value,saved.revision);
        }catch(error){
          if(!String(error).includes('COMET_STATE_CONFLICT')||retry>=3)throw error;
          const latest=checkedSnapshot(await readSnapshot());basis=latest.value;expected=latest.revision;
        }
      }
    });}
  };
}
