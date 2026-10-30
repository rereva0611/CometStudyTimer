import {timerMilliseconds} from './core.mjs';

// Each window wakes at the timer's next elapsed-second boundary, rather than
// at an interval relative to when that window happened to load.
export function createTimerRefresh({readTimer,onTick,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}) {
  let pending=null,stopped=false;
  function reschedule(){
    if(stopped)return;
    if(pending!==null)clearTimer(pending);
    const timer=readTimer(),elapsed=timerMilliseconds(timer,now());
    const delay=timer.startedAt===null?1000:Math.max(1,1000-elapsed%1000);
    pending=setTimer(()=>{
      pending=null;
      try{onTick();}finally{reschedule();}
    },delay);
  }
  return {
    reschedule,
    refresh(){if(stopped)return;try{onTick();}finally{reschedule();}},
    stop(){stopped=true;if(pending!==null)clearTimer(pending);pending=null;}
  };
}
