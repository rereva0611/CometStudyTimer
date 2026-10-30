import test from 'node:test';
import assert from 'node:assert/strict';
import {createStateStore} from '../frontend/storage.mjs';
import {createRecordUndo} from '../frontend/undo.mjs';

const key='2026-10-10',other='2026-10-09';
const initial=()=>({version:1,goal:120,records:{[key]:{seconds:8319,note:'Math'},[other]:{seconds:300,note:'Other'}},timer:{startedAt:1234,allocations:{},note:'Reading'}});
async function fixture(){
  let disk=JSON.stringify(initial()),fail=false,clock=100;
  const store=createStateStore({initial,validate:value=>value,readRaw:async()=>disk,writeRaw:async value=>{if(fail)throw new Error('Disk full');disk=value;}});
  await store.load();const undo=createRecordUndo({store,now:()=>clock});
  return {store,undo,setFail:value=>fail=value,setClock:value=>clock=value,disk:()=>JSON.parse(disk)};
}
test('undo restores exact pre-edit record while keeping concurrent timer, goal and other dates',async()=>{
  const {store,undo,disk}=await fixture();assert.equal(undo.peek(),null);
  await undo.edit(key,()=>({seconds:10800,note:'Changed'}));
  await store.update(s=>({...s,goal:240,timer:{...s.timer,startedAt:5678},records:{...s.records,[other]:{seconds:600,note:'New'}}}));
  await undo.undo();const result=disk();assert.deepEqual(result.records[key],{seconds:8319,note:'Math'});
  assert.equal(result.timer.startedAt,5678);assert.equal(result.goal,240);assert.equal(result.records[other].seconds,600);assert.equal(undo.peek(),null);
});
test('new records are removed by undo and deleted records are fully restored',async()=>{
  const {undo,store}=await fixture();await undo.edit('2026-10-08',()=>({seconds:60,note:'New'}));await undo.undo();
  assert.equal(Object.hasOwn(store.read().records,'2026-10-08'),false);
  await undo.edit(key,()=>null);assert.equal(Object.hasOwn(store.read().records,key),false);
  await undo.undo();assert.deepEqual(store.read().records[key],{seconds:8319,note:'Math'});
});
test('only the last successful edit can be undone and undo expires after ten seconds',async()=>{
  const {undo,store,setClock}=await fixture();await undo.edit(key,()=>({seconds:9000,note:'First'}));await undo.edit(key,()=>({seconds:10000,note:'Second'}));
  await undo.undo();assert.equal(store.read().records[key].seconds,9000);
  await undo.edit(key,()=>({seconds:11000,note:'Third'}));setClock(10100);assert.equal(undo.peek(),null);
  await assert.rejects(undo.undo(),/Undo/);assert.equal(store.read().records[key].seconds,11000);
});
test('failed edits create no undo and failed undo retains the original intent for retry',async()=>{
  const {undo,store,setFail,disk}=await fixture();setFail(true);await assert.rejects(undo.edit(key,()=>null),/Disk full/);
  assert.equal(undo.peek(),null);assert.equal(disk().records[key].seconds,8319);
  setFail(false);await undo.edit(key,()=>({seconds:10000,note:'Changed'}));setFail(true);await assert.rejects(undo.undo(),/Disk full/);
  assert.ok(undo.peek());assert.equal(store.read().records[key].seconds,10000);
  setFail(false);await undo.undo();assert.equal(disk().records[key].seconds,8319);
});
test('intervening same-day writes invalidate undo and queued undo checks the latest durable state',async()=>{
  const {undo,store}=await fixture();await undo.edit(key,()=>({seconds:10000,note:'Changed'}));
  const writing=store.update(s=>({...s,records:{...s.records,[key]:{seconds:11000,note:'Timer saved'}}}));
  const reverting=undo.undo();await writing;await assert.rejects(reverting,/Undo/);assert.equal(store.read().records[key].seconds,11000);assert.equal(undo.peek(),null);
});
test('external recovery reload shares the write queue and subsequent edits keep restored records',async()=>{
  let disk=JSON.stringify(initial());const store=createStateStore({initial,validate:value=>value,readRaw:async()=>disk,writeRaw:async value=>disk=value});await store.load();
  const refreshing=store.refresh(async()=>{disk=JSON.stringify({...initial(),goal:300,records:{[other]:{seconds:120,note:'Restored'}}});});
  const editing=store.update(s=>({...s,timer:{...s.timer,note:'Current'}}));await Promise.all([refreshing,editing]);
  assert.equal(store.read().goal,300);assert.deepEqual(store.read().records,{[other]:{seconds:120,note:'Restored'}});assert.equal(store.read().timer.note,'Current');
});
test('recovery adopts returned durable state without a second fallible load',async()=>{
  let disk=JSON.stringify(initial()),failRead=false;
  const store=createStateStore({initial,validate:value=>value,readRaw:async()=>{if(failRead)throw new Error('Read failed');return disk;},writeRaw:async value=>disk=value});await store.load();
  const restored={...initial(),goal:300,records:{}};
  await store.refresh(async()=>{disk=JSON.stringify(restored);failRead=true;return restored;});
  assert.deepEqual(store.read(),restored);
  await store.update(s=>({...s,timer:{...s.timer,note:'Changed'}}));assert.deepEqual(JSON.parse(disk).records,{});
});
test('ambiguous post-recovery load failure blocks stale writes until refresh succeeds',async()=>{
  let disk=JSON.stringify(initial()),failRead=false;
  const store=createStateStore({initial,validate:value=>value,readRaw:async()=>{if(failRead)throw new Error('Read failed');return disk;},writeRaw:async value=>disk=value});await store.load();
  await assert.rejects(store.refresh(async()=>{disk=JSON.stringify({...initial(),goal:300});failRead=true;}),/Read failed/);
  await assert.rejects(store.update(s=>({...s,goal:100})),/unavailable/);assert.equal(JSON.parse(disk).goal,300);
  failRead=false;await store.refresh();assert.equal(store.read().goal,300);
});
test('a lost native restore response cannot leave old records writable',async()=>{
  let disk=JSON.stringify(initial());
  const store=createStateStore({initial,validate:value=>value,readRaw:async()=>disk,writeRaw:async value=>disk=value});await store.load();
  await assert.rejects(store.refresh(async()=>{disk=JSON.stringify({...initial(),records:{}});throw new Error('Lost response');}),/Lost response/);
  await assert.rejects(store.update(s=>({...s,goal:100})),/unavailable/);assert.deepEqual(JSON.parse(disk).records,{});
  await store.refresh();assert.deepEqual(store.read().records,{});
});
