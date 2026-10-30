import test from 'node:test';
import assert from 'node:assert/strict';
import {createStateStore} from '../frontend/storage.mjs';

const initial=()=>({version:1,goal:120,records:{},timer:{startedAt:null,allocations:{},note:''}});
const valid=value=>{if(value.version!==1)throw new Error('Invalid state');return value;};

test('queued edits keep both records and goal, and survive reopening',async()=>{
  let disk=null;
  const options={initial,validate:valid,readRaw:async()=>disk,writeRaw:async raw=>{await new Promise(resolve=>setTimeout(resolve,10));disk=raw;}};
  const store=createStateStore(options);await store.load();
  const a=store.update(s=>({...s,records:{'2026-10-10':{seconds:600,note:'Math'}}}));
  const b=store.update(s=>({...s,goal:60}));await Promise.all([a,b]);
  const reopened=createStateStore(options);await reopened.load();
  assert.equal(reopened.read().goal,60);
  assert.equal(reopened.read().records['2026-10-10'].seconds,600);
});

test('failed saves preserve durable state and later edits can retry',async()=>{
  let fail=true,disk=JSON.stringify(initial());
  const store=createStateStore({initial,validate:valid,readRaw:async()=>disk,writeRaw:async raw=>{if(fail)throw new Error('Disk full');disk=raw;}});
  await store.load();await assert.rejects(store.update(s=>({...s,goal:60})),/Disk full/);
  assert.equal(store.read().goal,120);assert.equal(JSON.parse(disk).goal,120);
  fail=false;await store.update(s=>({...s,goal:90}));assert.equal(store.read().goal,90);
});

test('invalid input cannot overwrite records, and callers cannot mutate cached state',async()=>{
  let writes=0;const store=createStateStore({initial,validate:valid,readRaw:async()=>null,writeRaw:async()=>writes++});await store.load();
  const snapshot=store.read();snapshot.goal=5;assert.equal(store.read().goal,120);
  await assert.rejects(store.update(s=>({...s,version:2})),/Invalid state/);assert.equal(writes,0);
});

test('corrupt data is preserved for export and writes stay blocked',async()=>{
  let writes=0;const store=createStateStore({initial,validate:valid,readRaw:async()=>'{broken',writeRaw:async()=>writes++});
  await assert.rejects(store.load());assert.equal(store.raw(),'{broken');
  await assert.rejects(store.update(initial));assert.equal(writes,0);
});
