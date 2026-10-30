import test from 'node:test';
import assert from 'node:assert/strict';
const {lastTimerTask}=await import('../frontend/last-task.mjs').catch(()=>({}));
const session=(id,note,source,end=null)=>({id,note,source,end});
const state=(sessions,extra={})=>({records:{'2026-10-14':{sessions}},...extra});
test('last task only uses timer sessions and supports existing records without metadata',()=>{
  assert.equal(typeof lastTimerTask,'function');
  const older=session('a','Math','timer',100),latest=session('b','Reading','timer',200);
  assert.deepEqual(lastTimerTask(state([latest,older,session('c','Backfill','manual',300),session('d','Old','legacy') ])),latest);
  assert.equal(lastTimerTask(state([session('c','Backfill','manual')])),null);
});
test('saved task ID survives edited times, follows note edits and falls back after deletion',()=>{
  const a=session('a','Math','timer',300),b=session('b','Updated reading','timer',100);
  assert.deepEqual(lastTimerTask(state([a,b],{lastTimerSessionId:'b'})),b);
  assert.deepEqual(lastTimerTask(state([a],{lastTimerSessionId:'b'})),a);
});
test('a blank latest timer task hides continuation rather than selecting an older subject',()=>{
  assert.equal(lastTimerTask(state([session('a','Math','timer',100),session('b','  ','timer',200)])),null);
  assert.equal(lastTimerTask(state([session('a','Math','timer',200),session('b','','timer',100)],{lastTimerSessionId:'b'})),null);
});
test('old timer records with unknown ranges use date and session order without changing data',()=>{
  const value=state([session('a','Math','timer'),session('b','Reading','timer')]);
  value.records['2026-10-13']={sessions:[session('c','Older','timer')]};
  const original=structuredClone(value);
  assert.equal(lastTimerTask(value).id,'b');assert.deepEqual(value,original);
});
