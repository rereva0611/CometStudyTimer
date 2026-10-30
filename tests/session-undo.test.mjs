import test from 'node:test';import assert from 'node:assert/strict';
import * as domain from '../frontend/session-undo.mjs';import {applySession,normalizeStudyState} from '../frontend/sessions.mjs';import {createStateStore} from '../frontend/storage.mjs';import {lastTimerTask} from '../frontend/last-task.mjs';
const key='2026-10-10',other='2026-10-09';const s=(id='a',note='Math')=>({id,note,seconds:61,start:null,end:null,source:'manual'});
async function fixture(validate=v=>v){let disk={version:1,goal:120,timer:{startedAt:null,allocations:{},note:''},records:applySession({},key,'a',s())},fail=false,clock=100;
const store=createStateStore({initial:()=>disk,validate,readRaw:async()=>JSON.stringify(disk),writeRaw:async raw=>{if(fail)throw Error('Disk full');disk=JSON.parse(raw);}});await store.load();return {store,undo:domain.createSessionUndo({store,now:()=>clock}),fail:v=>fail=v,time:v=>clock=v};}
test('Undo restores target edit and keeps concurrent same-day session timer and goal',async()=>{const {store,undo}=await fixture();await undo.edit(key,'a',p=>({...p,note:'Changed'}));await store.update(v=>({...v,goal:240,timer:{...v.timer,note:'New'},records:applySession(v.records,key,'b',s('b'))}));await undo.undo();assert.equal(store.read().records[key].sessions[0].note,'Math');assert.equal(store.read().records[key].sessions.length,2);assert.equal(store.read().goal,240);});
test('Undo addition deletion move and no-op',async()=>{const {store,undo}=await fixture();await undo.edit(key,'b',()=>s('b'));await undo.undo();assert.equal(store.read().records[key].sessions.length,1);await undo.edit(key,'a',()=>null);assert.deepEqual(store.read().records,{});await undo.undo();await undo.edit(key,'a',p=>p,{newKey:other,requireExisting:true});assert.equal(store.read().records[key],undefined);await undo.undo();assert.ok(store.read().records[key]);await undo.edit(key,'a',p=>p);assert.equal(undo.peek(),null);});
test('failed writes preserve retryable Undo and expiry ends intent',async()=>{const {store,undo,fail,time}=await fixture();fail(true);await assert.rejects(undo.edit(key,'a',()=>null));assert.equal(undo.peek(),null);fail(false);await undo.edit(key,'a',()=>null);fail(true);await assert.rejects(undo.undo());assert.ok(undo.peek());fail(false);await undo.undo();await undo.edit(key,'a',()=>null);time(10100);assert.equal(undo.peek(),null);assert.deepEqual(store.read().records,{});});
test('queued edit captures latest target and conflict invalidates undo',async()=>{const {store,undo}=await fixture();const pending=store.update(v=>({...v,records:applySession(v.records,key,'a',s('a','Concurrent'))}));await undo.edit(key,'a',p=>({...p,note:'Changed'}));await pending;await undo.undo();assert.equal(store.read().records[key].note,'Concurrent');await undo.edit(key,'a',()=>null);await store.update(v=>({...v,records:applySession(v.records,other,'a',s())}));assert.equal(undo.peek(),null);await assert.rejects(undo.edit(key,'a',p=>p,{requireExisting:true}));});
test('queued Undo checks conflicting durable target after pending write completes',async()=>{const {store,undo}=await fixture();await undo.edit(key,'a',p=>({...p,note:'Changed'}));const writing=store.update(v=>({...v,records:applySession(v.records,key,'a',s('a','External'))}));const reverting=undo.undo();await writing;await assert.rejects(reverting,/Undo/);assert.equal(store.read().records[key].note,'External');assert.equal(undo.peek(),null);});
test('no-op leaves previous useful Undo available and failed edit does not replace it',async()=>{const {undo,fail}=await fixture();await undo.edit(key,'a',p=>({...p,note:'Changed'}));const first=undo.peek();await undo.edit(key,'a',p=>p);assert.deepEqual(undo.peek(),first);fail(true);await assert.rejects(undo.edit(key,'a',()=>null));assert.deepEqual(undo.peek(),first);undo.discard();assert.equal(undo.peek(),null);});
test('absent deletion through Undo preserves zero days and creates no intent',async()=>{
 const {store,undo}=await fixture();await store.update(v=>({...v,records:{[key]:{seconds:0,note:'Zero',sessions:[]}}}));
 await undo.edit(key,'missing',()=>null);assert.deepEqual(store.read().records[key],{seconds:0,note:'Zero',sessions:[]});assert.equal(undo.peek(),null);
});
for(const note of ['', 'Legacy zero note'])for(const move of [false,true])test(`Undo ${move?'move':'addition'} restores preexisting empty day with note=${JSON.stringify(note)}`,async()=>{
 const {store,undo}=await fixture();await store.update(v=>({...v,records:{...v.records,[other]:{seconds:0,note}}}));
 await undo.edit(move?key:other,move?'a':'b',p=>move?p:s('b','Added'),move?{newKey:other}:{});
 await undo.undo();assert.deepEqual(store.read().records[other],{seconds:0,note,sessions:[]});assert.deepEqual(store.read().records[key].sessions,[s()]);
});
for(const move of [false,true])test(`Undo ${move?'move':'addition'} into empty day keeps concurrent sessions and state`,async()=>{
 const {store,undo}=await fixture();await store.update(v=>({...v,records:{...v.records,[other]:{seconds:0,note:'Old zero',sessions:[]}}}));
 await undo.edit(move?key:other,move?'a':'b',p=>move?p:s('b','Added'),move?{newKey:other}:{});const expiry=undo.peek().expiresAt;
 await store.update(v=>({...v,goal:360,timer:{...v.timer,note:'Concurrent timer'},records:applySession(applySession(v.records,other,'c',s('c','Concurrent destination')),key,'d',s('d','Concurrent source'))}));
 assert.equal(undo.peek().expiresAt,expiry);await undo.undo();const state=store.read();
 assert.deepEqual(state.records[other],{seconds:61,note:'Concurrent destination',sessions:[s('c','Concurrent destination')]});
 assert.deepEqual(state.records[key].sessions.map(v=>v.id),['a','d']);assert.equal(state.records[key].note,'Concurrent source');assert.equal(state.goal,360);assert.equal(state.timer.note,'Concurrent timer');
});
test('Undo empty-day restoration preserves concurrent removal and edited empty note on other days',async()=>{
 const {store,undo}=await fixture(),third='2026-10-08';await store.update(v=>({...v,records:{...v.records,[other]:{seconds:0,note:'Old zero',sessions:[]},[third]:{seconds:0,note:'Original empty note',sessions:[]}}}));
 await undo.edit(other,'b',()=>s('b','Added'));
 await store.update(v=>({...v,records:{...applySession(v.records,key,'a',null),[third]:{seconds:0,note:'Edited empty note',sessions:[]}}}));
 await undo.undo();assert.deepEqual(store.read().records,{[other]:{seconds:0,note:'Old zero',sessions:[]},[third]:{seconds:0,note:'Edited empty note',sessions:[]}});
});
test('replacing the target with an edited empty day invalidates Undo without overwriting its note',async()=>{
 const {store,undo}=await fixture();await store.update(v=>({...v,records:{...v.records,[other]:{seconds:0,note:'Old zero',sessions:[]}}}));
 await undo.edit(other,'b',()=>s('b'));await store.update(v=>({...v,records:{...v.records,[other]:{seconds:0,note:'Edited zero',sessions:[]}}}));
 assert.equal(undo.peek(),null);await assert.rejects(undo.undo(),/Undo/);assert.deepEqual(store.read().records[other],{seconds:0,note:'Edited zero',sessions:[]});
});
test('failed empty-day Undo keeps original intent and expiry for retry',async()=>{
 const {store,undo,fail,time}=await fixture();await store.update(v=>({...v,records:{...v.records,[other]:{seconds:0,note:'Zero',sessions:[]}}}));
 await undo.edit(other,'b',()=>s('b'));const intent=undo.peek();fail(true);time(500);await assert.rejects(undo.undo(),/Disk full/);assert.deepEqual(undo.peek(),intent);assert.deepEqual(store.read().records[other].sessions,[s('b')]);
 fail(false);await undo.undo();assert.deepEqual(store.read().records[other],{seconds:0,note:'Zero',sessions:[]});assert.equal(undo.peek(),null);
});
for(const concurrent of [false,true])test(`Undo latest timer deletion preserves saved task identity with newer finish=${concurrent}`,async()=>{
 const {store,undo,fail}=await fixture(v=>normalizeStudyState(v,key));
 const timer=(id,hour)=>({...s(id,`Task ${id}`),source:'timer',start:new Date(`${key}T${hour}:00:00`).getTime(),end:new Date(`${key}T${hour}:01:01`).getTime()});
 const a=timer('a','10'),b=timer('b','09'),c=timer('c','08');
 await store.update(v=>({...v,records:applySession(applySession({},key,'a',a),key,'b',b),lastTimerSessionId:'b'}));
 assert.equal(lastTimerTask(store.read()).id,'b');await undo.edit(key,'b',()=>null);assert.equal(store.read().lastTimerSessionId,null);
 if(concurrent)await store.update(v=>({...v,records:applySession(v.records,key,'c',c),lastTimerSessionId:'c'}));
 fail(true);await assert.rejects(undo.undo(),/Disk full/);assert.equal(store.read().lastTimerSessionId,concurrent?'c':null);assert.ok(undo.peek());fail(false);
 await undo.undo();assert.equal(store.read().lastTimerSessionId,concurrent?'c':'b');assert.equal(lastTimerTask(store.read()).id,concurrent?'c':'b');assert.deepEqual(store.read().records[key].sessions.map(v=>v.id),concurrent?['a','b','c']:['a','b']);
});
for(const id of ['a','b'])for(const move of [false,true])for(const concurrent of [false,true])test(`Undo restores ${id} order after ${move?'move':'delete'} with concurrent=${concurrent}`,async()=>{
 const {store,undo}=await fixture();await store.update(v=>({...v,records:applySession(v.records,key,'b',s('b','Physics'))}));
 await undo.edit(key,id,p=>move?p:null,move?{newKey:other}:{});
 if(concurrent)await store.update(v=>({...v,records:applySession(v.records,key,'c',s('c','New'))}));
 await undo.undo();const day=store.read().records[key];assert.deepEqual(day.sessions.map(v=>v.id),concurrent?['a','b','c']:['a','b']);assert.equal(day.note,concurrent?'New':'Physics');
});
