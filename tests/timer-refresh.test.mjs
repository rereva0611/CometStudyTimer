import test from 'node:test';
import assert from 'node:assert/strict';
import {createTimerRefresh} from '../frontend/timer-refresh.mjs';
import {timerMilliseconds} from '../frontend/core.mjs';

function fixture(){
  let time=2500,timer={startedAt:2125,allocations:{},note:''},task=null,ticks=0;
  const refresh=createTimerRefresh({readTimer:()=>timer,now:()=>time,onTick:()=>ticks++,
    setTimer:(fn,delay)=>(task={fn,delay}),clearTimer:()=>{task=null;}});
  return {refresh,get task(){return task;},get ticks(){return ticks;},time:value=>time=value,timer:value=>timer=value,fire(){const fn=task.fn;task=null;fn();}};
}
test('refresh aligns to elapsed seconds including fractional paused allocations',()=>{
  const f=fixture();f.refresh.reschedule();assert.equal(f.task.delay,625);
  f.time(3125);f.fire();assert.equal(f.ticks,1);assert.equal(f.task.delay,1000);
  f.timer({startedAt:3200,allocations:{'2026-10-16':2550},note:''});f.time(3200);f.refresh.reschedule();assert.equal(f.task.delay,450);
  f.time(3650);f.fire();assert.equal(f.task.delay,1000);
});
test('late callbacks catch up to current time and reschedule from the real boundary',()=>{
  const f=fixture();f.refresh.reschedule();f.time(10050);f.fire();
  assert.equal(f.task.delay,75);assert.equal(f.ticks,1);
  f.time(10125);f.fire();assert.equal(f.task.delay,1000);
});
test('pause remains frozen and visible refresh preserves timer data',()=>{
  const f=fixture(),paused={startedAt:null,allocations:{'2026-10-16':2550},note:'Task'};
  f.timer(paused);f.refresh.refresh();assert.equal(f.task.delay,1000);
  f.time(9000);f.fire();assert.equal(timerMilliseconds(paused,9000),2550);
  assert.deepEqual(paused,{startedAt:null,allocations:{'2026-10-16':2550},note:'Task'});
  f.refresh.stop();assert.equal(f.task,null);f.refresh.refresh();assert.equal(f.task,null);
});
