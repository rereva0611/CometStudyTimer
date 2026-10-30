import test from 'node:test';
import assert from 'node:assert/strict';
import {connectController,createWidgetClient} from '../frontend/widget-bridge.mjs';
const state={version:1,records:{},goal:120,timer:{startedAt:1000,allocations:{},note:'Old',intervals:[]}};
async function fixture(t,onBeforeTransition){
  const listeners=new Map();let cached=null,generation=0;
  const handlers=new Set(),events=[];
  const emit=async(name,payload)=>{for(const listener of listeners.get(name)||[])listener({payload});};
  const original=globalThis.window;
  globalThis.window={__TAURI__:{event:{listen:async(name,fn)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);return ()=>listeners.get(name).delete(fn);}},core:{invoke:async(name,args)=>{
    events.push({name,args});
    if(name==='controller_publish'){cached=structuredClone(args.snapshot);await emit('comet-controller-state',cached);}
    else if(name==='widget_snapshot')return cached;
    else if(name==='widget_preferences')return {};
    else if(name==='widget_dispatch')await emit('comet-widget-action',args);
    else if(name==='widget_reply')await emit('comet-widget-reply',args);
    else if(name!=='widget_controller_ready')throw new Error('Unexpected '+name);
  }}}};
  const controller={snapshot:()=>({state:structuredClone(state),ready:true,error:null,undo:null,revision:++generation}),subscribe:fn=>(handlers.add(fn),()=>handlers.delete(fn)),dispatch:async()=>{throw new Error('Protocol messages must not reach the timer controller');}};
  const bridge=await connectController(controller);
  t.after(()=>{bridge();globalThis.window=original;});
  const client=await createWidgetClient({onBeforeTransition});
  await new Promise(resolve=>setImmediate(resolve));
  return {bridge,client,events};
}
test('transition waits for widget draft completion through the existing transport',async t=>{
  let finish,called=0;
  const f=await fixture(t,async()=>{called++;await new Promise(resolve=>finish=resolve);});
  assert.equal(typeof f.bridge.prepareSubject,'function');
  let settled=false;const preparation=f.bridge.prepareSubject().then(()=>settled=true);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(called,1);assert.equal(settled,false);
  finish();await preparation;assert.equal(settled,true);
});
test('composition or failed draft save rejects transition without dispatching Finish',async t=>{
  const f=await fixture(t,async()=>{throw new Error('Finish choosing text in the widget first.');});
  await assert.rejects(f.bridge.prepareSubject(),/Finish choosing/);
  assert.equal(f.events.some(event=>event.args?.action?.type==='finish'),false);
});
test('main-only use does not wait for an absent widget',async t=>{
  const f=await fixture(t,undefined);
  await f.bridge.prepareSubject();
  assert.equal(f.events.some(event=>event.args?.snapshot?.subjectRequest),false);
});
