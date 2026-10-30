import test from 'node:test';
import assert from 'node:assert/strict';
import {createStateStore} from '../frontend/storage.mjs';
const initial=()=>({version:1,goal:120,records:{},timer:{startedAt:null,allocations:{},intervals:[],note:''}});
const validate=v=>{if(v.version!==1)throw Error('Invalid state');return v;};
function transport(){let disk={value:initial(),revision:7},fail=false,conflicts=0,writes=0;
 return {readSnapshot:async()=>structuredClone(disk),writeSnapshot:async(value,revision)=>{writes++;if(fail)throw Error('Disk full');if(conflicts){conflicts--;disk={value:{...disk.value,goal:240,records:{remote:{seconds:2}}},revision:disk.revision+1};}if(revision!==disk.revision)throw Error('COMET_STATE_CONFLICT: stale');disk={value:structuredClone(value),revision:revision+1};return structuredClone(disk);},fail:v=>fail=v,conflicts:v=>conflicts=v,disk:()=>structuredClone(disk),writes:()=>writes,external:value=>disk={value,revision:disk.revision+1}};
}
async function setup(){const io=transport(),store=createStateStore({...io,initial,validate});await store.load();return {io,store};}
test('revision store recomputes same transform against CAS latest preserving concurrent data',async()=>{const {io,store}=await setup();io.conflicts(1);let computed=0;await store.update(s=>{computed++;return {...s,timer:{...s.timer,note:'Local'}};});assert.equal(computed,2);assert.equal(store.read().goal,240);assert.equal(store.read().records.remote.seconds,2);assert.equal(store.revision(),9);assert.deepEqual(JSON.parse(store.raw()),store.read());});
test('native failures keep cached durable prior state and do not publish',async()=>{const {io,store}=await setup();const seen=[];store.subscribe(s=>seen.push(s));io.fail(true);await assert.rejects(store.update(s=>({...s,goal:60})),/Disk full/);assert.equal(store.read().goal,120);assert.equal(store.revision(),7);assert.equal(seen.length,0);io.fail(false);await store.update(s=>({...s,goal:60}));assert.equal(seen.length,1);});
test('conflict retries are bounded and never overwrite stale state',async()=>{const {io,store}=await setup();io.conflicts(9);await assert.rejects(store.update(s=>({...s,goal:60})),/COMET_STATE_CONFLICT/);assert.equal(io.writes(),4);assert.equal(store.read().goal,120);assert.equal(io.disk().value.goal,240);assert.equal(store.revision(),7);});
test('queued mutations publish only successful writes with authoritative revisions',async()=>{const {store}=await setup();const seen=[];const unsubscribe=store.subscribe(s=>seen.push({state:s,revision:store.revision()}));await Promise.all([store.update(s=>({...s,goal:60})),store.update(s=>({...s,timer:{...s.timer,note:'Math'}}))]);assert.deepEqual(seen.map(v=>v.revision),[8,9]);assert.equal(seen[1].state.goal,60);unsubscribe();await store.update(s=>({...s,goal:90}));assert.equal(seen.length,2);});
test('native refresh runs external then reads authoritative snapshot ignoring raw return',async()=>{const {io,store}=await setup();let seen=0;store.subscribe(()=>seen++);await store.refresh(async()=>{io.external({...initial(),goal:90});return {...initial(),goal:5};});assert.equal(store.read().goal,90);assert.equal(store.revision(),8);assert.equal(seen,1);});
test('browser revision increments after durable writes and refresh publications',async()=>{let disk=null;const store=createStateStore({initial,validate,readRaw:async()=>disk,writeRaw:async v=>disk=v});await store.load();assert.equal(store.revision(),0);await store.update(s=>({...s,goal:60}));assert.equal(store.revision(),1);await store.refresh();assert.equal(store.revision(),2);});
for(const failure of ['corrupt','rejected'])test(`browser failed ${failure} reload blocks cached reads and writes until successful load`,async()=>{
 let disk=JSON.stringify(initial()),readFailure=false,writes=0;
 const store=createStateStore({initial,validate,readRaw:async()=>{if(readFailure)throw Error('Read failed');return disk;},writeRaw:async raw=>{writes++;disk=raw;}});
 await store.load();assert.equal(store.read().goal,120);const originalRaw=store.raw();
 if(failure==='corrupt')disk='{broken';else readFailure=true;
 await assert.rejects(store.load(),failure==='corrupt'?SyntaxError:/Read failed/);
 const failedDisk=disk;assert.throws(()=>store.read(),/unavailable/);
 await assert.rejects(store.update(s=>({...s,goal:60})),/unavailable/);
 assert.equal(writes,0);assert.equal(disk,failedDisk);assert.equal(store.raw(),failure==='corrupt'?'{broken':originalRaw);
 disk=JSON.stringify({...initial(),goal:240});readFailure=false;await store.load();assert.equal(store.read().goal,240);
 await store.update(s=>({...s,goal:60}));assert.equal(writes,1);assert.equal(JSON.parse(disk).goal,60);
});
for(const failure of ['invalid','rejected'])test(`native failed ${failure} reload blocks reads and writes without replacing cache diagnostics`,async()=>{
 let disk={value:initial(),revision:7},readFailure=false,writes=0;
 const store=createStateStore({initial,validate,readSnapshot:async()=>{if(readFailure)throw Error('Read failed');return structuredClone(disk);},writeSnapshot:async(value,revision)=>{writes++;disk={value:structuredClone(value),revision:revision+1};return structuredClone(disk);}});
 await store.load();const originalRaw=store.raw();assert.equal(store.read().goal,120);
 if(failure==='invalid')disk={value:{...initial(),version:2},revision:8};else readFailure=true;
 await assert.rejects(store.load(),failure==='invalid'?/Invalid state/:/Read failed/);
 const failedDisk=structuredClone(disk);assert.throws(()=>store.read(),/unavailable/);
 await assert.rejects(store.update(s=>({...s,goal:60})),/unavailable/);
 assert.equal(writes,0);assert.deepEqual(disk,failedDisk);assert.equal(store.raw(),originalRaw);assert.equal(store.revision(),7);
 disk={value:{...initial(),goal:240},revision:9};readFailure=false;await store.load();assert.equal(store.read().goal,240);assert.equal(store.revision(),9);
 await store.update(s=>({...s,goal:60}));assert.equal(writes,1);assert.equal(disk.value.goal,60);assert.equal(store.revision(),10);
});
