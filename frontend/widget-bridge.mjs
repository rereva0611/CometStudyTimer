const CHANNEL='comet-widget-controller-v1';
const PREFS='comet.widget.preferences.v1';
const message=error=>error?.message||String(error);

// Main is the only frontend writer. The widget receives committed snapshots.
export async function connectController(controller,{openDay=()=>{},onError=()=>{}}={}) {
  const native=window.__TAURI__?.core.invoke;
  const channel=native?null:new BroadcastChannel(CHANNEL);
  const unlisten=[];
  let publication=Promise.resolve(),generation=0,lastSnapshot=null,subjectViewReady=false;
  const subjectPreparations=new Map();
  const controllerId=crypto.randomUUID();
  const capture=snapshot=>(lastSnapshot={...structuredClone(snapshot),controllerId,generation:++generation});
  const publish=value=>{
    const snapshot=capture(value);
    publication=publication.then(async()=>{if(native)await native('controller_publish',{snapshot});else channel.postMessage({type:'state',snapshot});}).catch(onError);
    return publication;
  };
  const handle=async({requestId,action})=>{
    let result;
    try{
      if(action?.type==='subject-view-ready')subjectViewReady=true;
      else if(action?.type==='subject-flushed'){
        const waiting=subjectPreparations.get(action.token);
        if(waiting){clearTimeout(waiting.timeout);subjectPreparations.delete(action.token);if(action.error)waiting.reject(new Error(String(action.error)));else waiting.resolve();}
      }
      else if(action?.type==='open-day')openDay(action.date);
      else await controller.dispatch(requestId,action);
      // Capture current metadata now, including same-revision Undo expiry and
      // invalidation. A delayed reply carries this generation, not delivery time.
      result={ok:true,snapshot:capture(controller.snapshot())};
    }catch(error){result={ok:false,error:message(error)};}
    try{if(native)await native('widget_reply',{requestId,result});else channel.postMessage({type:'reply',requestId,result});}
    catch(error){onError(error);}
  };
  if(native)unlisten.push(await window.__TAURI__.event.listen('comet-widget-action',event=>void handle(event.payload)));
  else channel.onmessage=event=>{if(event.data?.type==='request')void handle(event.data);};
  const unsubscribe=controller.subscribe(snapshot=>void publish(snapshot));
  await publish(controller.snapshot());
  if(native)await native('widget_controller_ready');
  const disconnect=()=>{
    unsubscribe();for(const stop of unlisten)stop();channel?.close();
    for(const waiting of subjectPreparations.values()){clearTimeout(waiting.timeout);waiting.reject(new Error('Comet reloaded. Try again.'));}subjectPreparations.clear();
  };
  disconnect.prepareSubject=()=>{
    if(!subjectViewReady)return Promise.resolve();
    return new Promise((resolve,reject)=>{
      const token=crypto.randomUUID();
      const timeout=setTimeout(()=>{subjectPreparations.delete(token);reject(new Error('Widget did not respond. Your timer has been kept.'));},8000);
      subjectPreparations.set(token,{resolve,reject,timeout});
      void publish({...controller.snapshot(),subjectRequest:token});
    });
  };
  disconnect.unavailable=error=>publish({...lastSnapshot,ready:false,undo:null,error:message(error)});
  return disconnect;
}

export async function createWidgetClient({onState,onPreferences,onPreview,onHover,onError,onBusy,onBeforeTransition}={}) {
  const native=window.__TAURI__?.core.invoke;
  const channel=native?null:new BroadcastChannel(CHANNEL),pending=new Map();
  const retiredControllers=new Set();
  const handledSubjects=new Set();let subjectController=null;
  let current=null,prefs={pinned:false,collapsed:false,autostart:true},busy=false;
  const updateBusy=()=>{
    const next=[...pending.values()].some(request=>request.blocking);
    if(next!==busy){busy=next;onBusy?.(busy);}
  };
  const state=snapshot=>{
    if(!snapshot||typeof snapshot.ready!=='boolean'||!snapshot.state)return;
    if(current&&Number.isFinite(current.revision)&&Number.isFinite(snapshot.revision)&&snapshot.revision<current.revision)return;
    if(current?.controllerId){
      if(typeof snapshot.controllerId!=='string'||!Number.isSafeInteger(snapshot.generation))return;
      if(retiredControllers.has(snapshot.controllerId))return;
      if(snapshot.controllerId===current.controllerId&&snapshot.generation<current.generation)return;
      if(snapshot.controllerId!==current.controllerId)retiredControllers.add(current.controllerId);
    }
    current=snapshot;onState?.(snapshot);
    if(onBeforeTransition&&snapshot.ready){
      const identity=snapshot.controllerId||'legacy';
      if(subjectController!==identity){subjectController=identity;void send({type:'subject-view-ready'}).catch(onError);}
      const token=snapshot.subjectRequest;
      if(typeof token==='string'&&!handledSubjects.has(token)){
        handledSubjects.add(token);if(handledSubjects.size>128)handledSubjects.delete(handledSubjects.values().next().value);
        void Promise.resolve().then(onBeforeTransition).then(()=>send({type:'subject-flushed',token}),error=>send({type:'subject-flushed',token,error:message(error)})).catch(onError);
      }
    }
  };
  const reply=({requestId,result})=>{
    const request=pending.get(requestId);if(!request)return;
    clearTimeout(request.timeout);pending.delete(requestId);updateBusy();
    if(result?.ok){state(result.snapshot);request.resolve(result.snapshot);}
    else request.reject(new Error(result?.error||'Unable to complete this action.'));
  };
  const acceptPrefs=value=>{prefs={...prefs,...value};onPreferences?.(prefs);if(typeof value?.previewing==='boolean')onPreview?.({expanded:value.previewing,direction:value.previewDirection});return prefs;};
  const send=action=>new Promise((resolve,reject)=>{
    const requestId=crypto.randomUUID();
    const timeout=setTimeout(()=>{pending.delete(requestId);updateBusy();reject(new Error('Comet did not respond. Open the main app to check.'));},8000);
    pending.set(requestId,{resolve,reject,timeout,blocking:!['subject','subject-view-ready','subject-flushed'].includes(action.type)});updateBusy();
    const outgoing=native?native('widget_dispatch',{requestId,action}):Promise.resolve(channel.postMessage({type:'request',requestId,action}));
    outgoing.catch(error=>{clearTimeout(timeout);pending.delete(requestId);updateBusy();reject(error);});
  });
  if(native){
    await window.__TAURI__.event.listen('comet-controller-state',event=>state(event.payload));
    await window.__TAURI__.event.listen('comet-widget-reply',event=>reply(event.payload));
    await window.__TAURI__.event.listen('comet-widget-preferences',event=>acceptPrefs(event.payload));
    await window.__TAURI__.event.listen('comet-widget-preview',event=>onPreview?.(event.payload));
    await window.__TAURI__.event.listen('comet-widget-hover',event=>onHover?.(event.payload));
    await window.__TAURI__.event.listen('comet-storage-error',event=>onError?.(new Error(String(event.payload))));
    state(await native('widget_snapshot'));acceptPrefs(await native('widget_preferences'));
  }else{
    channel.onmessage=event=>{const value=event.data;if(value?.type==='state')state(value.snapshot);else if(value?.type==='reply')reply(value);};
    try{const stored=JSON.parse(localStorage.getItem(PREFS)||'null');if(stored&&typeof stored.pinned==='boolean'&&typeof stored.collapsed==='boolean')acceptPrefs(stored);else acceptPrefs(prefs);}catch{acceptPrefs(prefs);}
  }
  // Native listeners + cache read cover initialization: the ready handshake
  // publishes before showing the widget. Only browser preview needs a query.
  if(!native&&!current)send({type:'snapshot'}).catch(error=>onError?.(error));
  async function preference(name,value){
    if(native)return acceptPrefs(await native(`widget_set_${name}`,{[name]:value}));
    const next={...prefs,[name]:value};localStorage.setItem(PREFS,JSON.stringify(next));return acceptPrefs(next);
  }
  return {
    dispatch:send,
    pin:value=>preference('pinned',value),collapse:value=>preference('collapsed',value),
    preview:expanded=>native?native('widget_set_preview',{expanded}):Promise.resolve({expanded}),
    openDay:date=>native?native('widget_open_main',{date}):send({type:'open-day',date}),
    beginDrag:()=>native?native('widget_begin_dragging'):Promise.resolve([0,0]),
    moveDrag:(x,y)=>native?native('widget_move_dragging',{x,y}):Promise.resolve([x,y]),
    endDrag:()=>native?native('widget_end_dragging'):Promise.resolve(),
    native:!!native
  };
}
