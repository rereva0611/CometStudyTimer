import {dayKey,localDate,offsetDate,calendarCells,emptyTimer,timerMilliseconds,statistics,heatLevel,durationText,timerText} from './core.mjs';
import {createStateStore} from './storage.mjs';
import {normalizeStudyState,normalizeBackup,clockRange,sessionClockText,relocateSessionRange,makeBackup,mergeBackup} from './sessions.mjs';
import {createSessionUndo} from './session-undo.mjs';
import {createStudyController} from './controller.mjs';
import {connectController} from './widget-bridge.mjs';
import {lastTimerTask} from './last-task.mjs';
import {createTimerRefresh} from './timer-refresh.mjs';

const $=id=>document.getElementById(id);
document.documentElement.dataset.inputMode='pointer';
const STORAGE_KEY='xueshi.study-log.v1';
const defaultState=()=>({version:1,records:{},goal:120,timer:emptyTimer()});
const native=window.__TAURI__?.core.invoke;
const store=createStateStore({
  initial:defaultState,validate:validateState,
  ...(native?{
    readSnapshot:()=>native('load_snapshot'),
    writeSnapshot:(value,revision)=>native('save_state',{value,expectedRevision:revision})
  }:{}),
  readRaw:async()=>{if(!native)return localStorage.getItem(STORAGE_KEY);const value=await native('load_state');return value===null?null:JSON.stringify(value);},
  writeRaw:async raw=>{if(native)await native('save_state',{value:JSON.parse(raw)});else localStorage.setItem(STORAGE_KEY,raw);}
});
let recordUndo=createSessionUndo({store}),controller=null,disconnectController=null;
let undoNotice='Saved',backupSelection=null,backupBusy=false,lastBackupWarning=null;
let state=defaultState(),today=dayKey(),year=Number(today.slice(0,4)),recordId=null,recordOrigin=null,recordOriginal=null,daySelection=null,returnDay=null,importData=null,toastTimeout,blocked=false,recordSaving=false;
let subjectDirty=false,subjectVersion=0,subjectComposing=false,compositionCommit=null,timerTransition=null;
const timerRefresh=createTimerRefresh({readTimer:()=>state.timer,onTick:()=>{if(dayKey()!==today)render();else renderTimer();}});
const HISTORY_PAGE_SIZE=5;
let historyPage=1,historyMonth='',historyMonthOptionsKey='',historySessionIds=null;
let tooltipTimeout,tooltipTarget,keyboardTooltipFrame,tooltipTabPending=false,recordDurationEdited=false,recordTimeEdited=false;
const icon=name=>`<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
function placeToast() {
  const parent=document.querySelector('dialog[open]')||document.body;
  if($('toast').parentElement!==parent)parent.append($('toast'));
}
function notify(message,error=false) {
  placeToast();
  const intent=latestUndo(),toast=$('toast');
  $('toast-message').textContent=intent&&!error?(intent.type==='finish'?'Time recorded':undoNotice):message;
  $('undo-button').hidden=!intent;toast.classList.toggle('error',error);toast.hidden=false;
  clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>{toast.hidden=true;$('undo-button').hidden=true;},intent?Math.max(0,intent.expiresAt-Date.now()):error?9000:4000);
}
window.addEventListener('comet-appearance-error',event=>notify(event.detail,true));
async function checkBackupStatus() {
  if(!native)return;
  try {const warning=await native('backup_status');if(warning&&warning!==lastBackupWarning)notify(String(warning),true);lastBackupWarning=warning;}
  catch(error){if(String(error)!==lastBackupWarning){lastBackupWarning=String(error);notify('Automatic backup unavailable. Use Export to keep a copy.',true);}}
}
function savedState(next) {
  state=next;render();
  if(!latestUndo()&&!$('undo-button').hidden){$('undo-button').hidden=true;$('toast').hidden=true;}
  void checkBackupStatus();
}
function latestUndo(){
  if(blocked)return null;
  const record=recordUndo.peek(),finish=controller?.snapshot().undo;
  if(finish&&finish.expiresAt>Date.now()&&(!record||finish.expiresAt>=record.expiresAt))return {...finish,type:'finish'};
  return record?{...record,type:'record'}:null;
}
async function activateController(error=null){
  disconnectController?.();
  if(error){
    controller={
      snapshot:()=>({state:defaultState(),revision:0,undo:null,ready:false,error}),
      subscribe:()=>()=>{},dispatch:async()=>{throw new Error(error);}
    };
  }else{
    controller=createStudyController({store});recordUndo=controller.recordUndo;
    controller.subscribe(snapshot=>savedState(snapshot.state));
  }
  const bridgeController={...controller,dispatch:async(requestId,action)=>{
    // Flush this view's recoverable draft before a remote transition. Keep the
    // remote request/action unchanged so controller request-ID dedup still holds.
    if(subjectComposing&&['pause','resume','finish'].includes(action.type))throw new Error('Finish choosing text in the main window first.');
    if(subjectDirty&&['pause','resume','finish'].includes(action.type))await dispatchSubject(crypto.randomUUID(),{type:'subject',note:$('subject').value.trim()});
    return controller.dispatch(requestId,action);
  }};
  disconnectController=await connectController(bridgeController,{openDay:navigateDay,onError:error=>notify(error.message||String(error),true)});
}
async function dispatchSubject(requestId,action){
  const version=subjectVersion;
  const result=await controller.dispatch(requestId,action);
  if(version===subjectVersion){subjectDirty=false;render();}
  return result;
}
function unavailableData(error){
  blocked=true;render();void disconnectController?.unavailable(error);notify(error.message||String(error),true);
}
function validateState(data) {return normalizeStudyState(data,dayKey());}
function readState() {return store.read();}
async function commit(transform) {
  if(blocked)throw new Error('Your data is unavailable. Keep a backup and restart Comet.');
  savedState(await store.update(transform));
}
async function changeState(transform) {
  try {
    await commit(transform);return true;
  } catch(error) {notify(error.message||String(error),true);return false;}
}
function displayDate(key,options={month:'short',day:'numeric'}) {return localDate(key).toLocaleDateString('en-US',options);}
function renderTimer() {
  const seconds=Math.floor(timerMilliseconds(state.timer)/1000),active=state.timer.startedAt!==null,unfinished=active||Object.keys(state.timer.allocations).length>0;
  const parts=timerText(seconds).split(':');
  $('timer-display').innerHTML=parts.join('<span>:</span>');
  const status=$('timer-state');status.textContent=active?'Running':unfinished?'Paused':'Ready';status.classList.toggle('running',active);
  const action=active?'Pause':unfinished?'Resume':'Start';
  if($('toggle-timer').dataset.action!==action){
    $('toggle-timer').innerHTML=icon(active?'pause':'play')+`<span>${action}</span>`;
    $('toggle-timer').dataset.action=action;
  }
  $('toggle-timer').disabled=blocked||!!timerTransition;
  $('finish-timer').disabled=blocked||!!timerTransition||!unfinished;
  const last=lastTimerTask(state),continuation=$('continue-last');
  continuation.hidden=unfinished||!last;continuation.disabled=blocked||!!timerTransition;
  continuation.title=last?.note||'';
  document.title=active?`${timerText(seconds)} · Comet`:'Comet';
}
function renderToday() {
  const date=localDate(today),seconds=state.records[today]?.seconds||0,minutes=Math.floor(seconds/60);
  $('today-short-date').textContent=`${displayDate(today)} · ${date.toLocaleDateString('en-US',{weekday:'short'})}`;
  $('today-amount').innerHTML=seconds>0&&minutes===0?'<strong>&lt;1</strong><span>min</span>':`<strong>${Math.floor(minutes/60)}</strong><span>h</span><strong>${minutes%60}</strong><span>min</span>`;
  const ratio=Math.min(100,Math.floor(seconds/(state.goal*60)*100));
  $('progress-fill').style.width=`${ratio}%`;$('goal-progress').setAttribute('aria-valuenow',String(ratio));
  $('goal-status').textContent=ratio>=100?'100% ✓':`${ratio}%`;
  $('goal-button').innerHTML=`Goal ${durationText(state.goal*60)} ${icon('edit')}`;
  const values=Array.from({length:7},(_,i)=>({key:offsetDate(today,i-6),seconds:state.records[offsetDate(today,i-6)]?.seconds||0}));
  const max=Math.max(...values.map(v=>v.seconds),state.goal*60);
  $('mini-chart').replaceChildren(...values.map(v=>{
    const bar=document.createElement('div');bar.className='mini-bar';bar.style.height=`${Math.max(3,Math.round(v.seconds/max*24))}px`;bar.title=`${displayDate(v.key)}: ${durationText(v.seconds)}`;return bar;
  }));
}
function renderStats() {
  const stats=statistics(state.records,today);
  renderStudyTotal($('stat-total'),stats.total);
  renderStudyTotal($('stat-week'),stats.week);
  $('stat-days').innerHTML=`${stats.days}<span>${stats.days===1?'day':'days'}</span>`;
  $('stat-streak').innerHTML=`${stats.streak}<span>${stats.streak===1?'day':'days'}</span>`;
  $('streak-foot').textContent=`Best: ${stats.longest} ${stats.longest===1?'day':'days'}`;
}
function renderStudyTotal(element,seconds) {
  const minutes=Math.floor(seconds/60),hours=Math.floor(minutes/60);
  const unit=text=>`<span class="stat-unit">${text}</span>`;
  element.innerHTML=seconds>0&&minutes===0?`&lt;1${unit('min')}`:hours?`${hours}${unit('h')}${minutes%60?` ${minutes%60}${unit('min')}`:''}`:`${minutes}${unit('min')}`;
  element.title=durationText(seconds);
}
function sizeCalendar() {
  const heatmap=$('heatmap'),scroll=$('heatmap-scroll'),weeks=heatmap.children.length/7;
  if(!weeks)return;
  const style=getComputedStyle(scroll),gap=Number.parseFloat(getComputedStyle(heatmap).columnGap)||0;
  const available=scroll.clientWidth-Number.parseFloat(style.paddingLeft)-Number.parseFloat(style.paddingRight);
  const size=Math.max(13,(available-gap*(weeks-1))/weeks);
  scroll.parentElement.style.setProperty('--heat-cell-size',`${size}px`);
}
function renderCalendar() {
  dismissTooltip();
  const cells=calendarCells(year),weeks=cells.length/7;
  $('year-label').textContent=year;$('next-year').disabled=year>=Number(today.slice(0,4));$('previous-year').disabled=year<=1900;
  const months=$('month-labels');months.style.gridTemplateColumns=`repeat(${weeks},var(--heat-cell-size))`;months.style.gridAutoFlow='unset';months.replaceChildren();
  const used=new Set();
  cells.forEach((cell,index)=>{
    if(!cell||used.has(cell.month))return;used.add(cell.month);
    const label=document.createElement('span');label.textContent=new Date(year,cell.month,1).toLocaleDateString('en-US',{month:'short'});label.className='month-label';label.style.gridColumn=`${Math.floor(index/7)+1}`;months.append(label);
  });
  const heatmap=$('heatmap');heatmap.replaceChildren();
  cells.forEach((cell,index)=>{
    if(!cell) {const blank=document.createElement('span');blank.className='day blank';heatmap.append(blank);return;}
    const seconds=state.records[cell.key]?.seconds||0,button=document.createElement('button');
    button.className=`day level-${heatLevel(seconds)}${cell.key===today?' today':''}`;button.dataset.date=cell.key;button.dataset.index=index;
    button.disabled=cell.key>today;
    button.tabIndex=cell.key===today||year!==Number(today.slice(0,4))&&cell.key===`${year}-01-01`?0:-1;
    const desc=`${displayDate(cell.key,{year:'numeric',month:'long',day:'numeric',weekday:'long'})}, ${seconds?durationText(seconds):'No record'}${cell.key===today?', Today':''}${cell.key>today?', Upcoming':''}`;
    button.setAttribute('aria-label',desc);button.addEventListener('click',()=>openDay(cell.key));
    button.addEventListener('mouseenter',()=>scheduleTooltip(button));button.addEventListener('mouseleave',dismissTooltip);
    button.addEventListener('focus',()=>{if(tooltipTabPending){tooltipTabPending=false;inspectDay(button);}});button.addEventListener('blur',dismissTooltip);
    button.addEventListener('keydown',event=>{
      const delta={ArrowUp:-1,ArrowDown:1,ArrowLeft:-7,ArrowRight:7}[event.key];
      if(delta===undefined)return;event.preventDefault();const next=heatmap.querySelector(`[data-index="${index+delta}"]:not(:disabled)`);
      if(next){heatmap.querySelectorAll('[tabindex="0"]').forEach(b=>b.tabIndex=-1);next.tabIndex=0;next.focus();inspectDay(next);}
    });heatmap.append(button);
  });
  sizeCalendar();
  const days=Object.keys(state.records).filter(k=>k.startsWith(`${year}-`)&&state.records[k].seconds>0),total=days.reduce((n,key)=>n+state.records[key].seconds,0);
  $('year-summary').textContent=`${days.length} study ${days.length===1?'day':'days'} · ${durationText(total)}`;
}
function scheduleTooltip(button) {
  dismissTooltip();tooltipTimeout=setTimeout(()=>showTooltip(button),180);
}
function inspectDay(button) {
  dismissTooltip();
  // Focus may scroll the calendar. Show after that scroll event has been handled.
  keyboardTooltipFrame=requestAnimationFrame(()=>{
    keyboardTooltipFrame=null;
    if(document.activeElement===button)showTooltip(button);
  });
}
function showTooltip(button) {
  if(!button.isConnected||document.querySelector('dialog[open]'))return;
  const tooltip=$('heat-tooltip'),key=button.dataset.date,seconds=state.records[key]?.seconds||0;
  tooltip.textContent=`${displayDate(key)} · ${seconds?durationText(seconds):'—'}`;
  tooltipTarget=button;button.setAttribute('aria-describedby','heat-tooltip');
  tooltip.hidden=false;const rect=button.getBoundingClientRect(),width=tooltip.offsetWidth;
  tooltip.style.left=`${Math.max(8,Math.min(window.innerWidth-width-8,rect.left+rect.width/2-width/2))}px`;
  tooltip.style.top=`${Math.max(8,rect.top-tooltip.offsetHeight-10)}px`;
}
function hideTooltip() {
  clearTimeout(tooltipTimeout);$('heat-tooltip').hidden=true;
  tooltipTarget?.removeAttribute('aria-describedby');tooltipTarget=null;
}
function dismissTooltip() {
  cancelAnimationFrame(keyboardTooltipFrame);keyboardTooltipFrame=null;hideTooltip();
}
function sessionClock(session) {
  return session.start!==null&&session.end!==null?`${sessionClockText(session)}–${sessionClockText(session,'end')}`:'';
}
function sessionRows() {
  return Object.keys(state.records).sort().reverse().flatMap(key=>
    [...state.records[key].sessions].reverse().sort((a,b)=>(b.start??-1)-(a.start??-1)).map(session=>({key,session})));
}
function historyEntries(rows=sessionRows()) {
  return historyMonth?rows.filter(({key})=>key.startsWith(`${historyMonth}-`)):rows;
}
function renderHistoryMonths() {
  const years=[...new Set([today.slice(0,4),...Object.keys(state.records).map(key=>key.slice(0,4)),...(historyMonth?[historyMonth.slice(0,4)]:[])])].sort().reverse();
  const optionsKey=JSON.stringify([years,today.slice(0,7)]),select=$('history-month');
  if(optionsKey!==historyMonthOptionsKey){
    select.replaceChildren(new Option('All time',''));
    for(const year of years){
      const group=document.createElement('optgroup');group.label=year;
      for(let month=12;month>=1;month--){
        const key=`${year}-${String(month).padStart(2,'0')}`;
        if(key>today.slice(0,7))continue;
        group.append(new Option(displayDate(`${key}-01`,{month:'short',year:'numeric'}),key));
      }
      select.append(group);
    }
    historyMonthOptionsKey=optionsKey;
  }
  select.value=historyMonth;select.disabled=blocked;
}
function renderRecords() {
  renderHistoryMonths();
  const allEntries=sessionRows(),entries=historyEntries(allEntries),list=$('records-list');list.replaceChildren();
  const ids=new Set(allEntries.map(({session})=>session.id));
  if(historySessionIds&&entries.some(({session})=>!historySessionIds.has(session.id)))historyPage=1;
  historySessionIds=ids;
  const pageCount=Math.max(1,Math.ceil(entries.length/HISTORY_PAGE_SIZE));
  historyPage=Math.min(historyPage,pageCount);
  const offset=(historyPage-1)*HISTORY_PAGE_SIZE,paged=entries.length>HISTORY_PAGE_SIZE;
  list.classList.toggle('paged',paged);
  $('history-pagination').hidden=!paged;
  $('history-range').textContent=entries.length?`${offset+1}–${Math.min(offset+HISTORY_PAGE_SIZE,entries.length)} of ${entries.length}`:'';
  $('history-page').textContent=`${historyPage} / ${pageCount}`;
  $('history-previous').disabled=blocked||historyPage===1;
  $('history-next').disabled=blocked||historyPage===pageCount;
  $('history-summary').textContent=`${durationText(entries.reduce((sum,{session})=>sum+session.seconds,0))} · ${entries.length} ${entries.length===1?'session':'sessions'}`;
  if(!entries.length){list.innerHTML='<div class="empty-state"><div class="empty-icon" aria-hidden="true">'+('<i></i>'.repeat(9))+'</div><div><strong>No records yet</strong></div></div>';return;}
  entries.slice(offset,offset+HISTORY_PAGE_SIZE).forEach(({key,session})=>{
    const row=document.createElement('button');row.className='record-row';
    const date=document.createElement('span');date.className='record-date';const square=document.createElement('i');square.className=`level-${heatLevel(session.seconds)}`;date.append(square,document.createTextNode(key===today?'Today':displayDate(key)));
    const context=document.createElement('span');context.className='record-context';
    const note=document.createElement('span');note.className='record-note';note.textContent=session.note||'Study';
    const time=sessionClock(session);context.append(note);
    if(time){const clock=document.createElement('span');clock.className='record-clock';clock.textContent=time;context.append(clock);}
    const duration=document.createElement('span');duration.className='record-duration';duration.textContent=durationText(session.seconds);
    row.append(date,context,duration);row.insertAdjacentHTML('beforeend',icon('right'));row.setAttribute('aria-label',[key,time,session.note||'Study',durationText(session.seconds),'Edit session'].filter(Boolean).join(', '));row.addEventListener('click',()=>openRecord(key,session.id));list.append(row);
  });
}
$('history-previous').addEventListener('click',()=>{if(historyPage>1){historyPage--;renderRecords();}});
$('history-next').addEventListener('click',()=>{if(historyPage*HISTORY_PAGE_SIZE<historyEntries().length){historyPage++;renderRecords();}});
$('history-month').addEventListener('change',()=>{historyMonth=$('history-month').value;historyPage=1;renderRecords();});
function adjacentRecordedDays() {
  const dates=Object.keys(state.records).filter(key=>key<=dayKey()&&state.records[key].sessions.length>0).sort();
  return {previous:dates.filter(key=>key<daySelection).at(-1),next:dates.find(key=>key>daySelection)};
}
function changeDay(direction) {
  if(blocked)return;
  try{
    state=readState();const key=adjacentRecordedDays()[direction];
    if(key){daySelection=key;renderDay();$('day-sessions').scrollTop=0;}
  }catch(error){notify(error.message||String(error),true);}
}
$('day-previous').addEventListener('click',()=>changeDay('previous'));
$('day-next').addEventListener('click',()=>changeDay('next'));
function renderDay() {
  if(!daySelection)return;
  $('day-title').textContent=displayDate(daySelection,{month:'short',day:'numeric',year:'numeric'});
  const adjacent=adjacentRecordedDays();
  $('day-previous').disabled=blocked||!adjacent.previous;$('day-next').disabled=blocked||!adjacent.next;
  $('day-total').textContent=durationText(state.records[daySelection]?.seconds||0);
  const list=$('day-sessions');list.replaceChildren();
  [...(state.records[daySelection]?.sessions||[])].sort((a,b)=>(a.start??-1)-(b.start??-1)).forEach(session=>{
    const row=document.createElement('button');row.className='session-row';row.type='button';
    const context=document.createElement('span');context.className='session-context';
    const time=sessionClock(session);
    if(time){const clock=document.createElement('span');clock.className='session-clock';clock.textContent=time;context.append(clock);}
    const note=document.createElement('span');note.className='session-subject';note.textContent=session.note||'Study';context.append(note);
    const duration=document.createElement('span');duration.className='record-duration';duration.textContent=durationText(session.seconds);
    row.append(context,duration);row.insertAdjacentHTML('beforeend',icon('right'));row.addEventListener('click',()=>openRecord(daySelection,session.id));list.append(row);
  });
}
function openDay(key=today) {
  if(blocked){notify('Your data is unavailable. Restart Comet.',true);return;}
  try {state=readState();}catch(error){notify(error.message,true);return;}
  tooltipTabPending=false;dismissTooltip();daySelection=key;renderDay();$('day-dialog').showModal();
}
function navigateDay(key){
  if(typeof key!=='string'||key>dayKey()||dayKey(localDate(key))!==key)return;
  const open=document.querySelector('dialog[open]');
  if(open&&open.id!=='day-dialog'){notify('Close the current dialog first.');return;}
  if(open)open.close();openDay(key);
}
function render() {
  today=dayKey();renderTimer();renderToday();renderStats();renderCalendar();renderRecords();
  timerRefresh.reschedule();
  if($('day-dialog').open)renderDay();
  if(!subjectDirty&&!subjectComposing&&$('subject').value!==(state.timer.note||''))$('subject').value=state.timer.note||'';
  const storage=$('storage-status');storage.classList.toggle('error',blocked);storage.lastChild.textContent=blocked?'Storage error':'Saved locally';
}
function openRecord(key=today,id=null) {
  if(blocked){notify('Your data is unavailable. Restart Comet.',true);return;}
  try {state=readState();}catch(error){notify(error.message,true);return;}
  const session=id?state.records[key]?.sessions.find(entry=>entry.id===id):null;
  if(id&&!session){notify('This session has changed. Open it again.',true);return;}
  returnDay=$('day-dialog').open?daySelection:null;
  if($('day-dialog').open)$('day-dialog').close();
  recordId=id||crypto.randomUUID();recordOrigin=key;recordOriginal=session;
  recordDurationEdited=false;recordTimeEdited=false;tooltipTabPending=false;dismissTooltip();
  $('record-title').textContent=session?'Edit session':'Log time';
  $('record-date').max=session&&key>dayKey()?key:dayKey();$('record-date').value=key;
  $('record-start').value=session?sessionClockText(session):'';
  $('record-end').value=session?sessionClockText(session,'end'):'';
  $('record-hours').value=session?Math.floor(session.seconds/3600):'';
  $('record-minutes').value=session?Math.floor(session.seconds/60)%60:'';
  $('record-note').value=session?.note||'';$('record-error').textContent='';
  $('delete-record').hidden=!session;$('record-dialog').showModal();
}
async function downloadJSON(content,name) {
  if(native)return native('export_backup',{content,filename:name});
  const blob=new Blob([content],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  return true;
}

$('toggle-timer').addEventListener('click',()=>{
  const type=state.timer.startedAt!==null?'pause':Object.keys(state.timer.allocations).length>0?'resume':'start';
  timerAction(type).catch(error=>notify(error.message||String(error),true));
});
function timerAction(type){
  if(timerTransition)return timerTransition;
  if(subjectComposing)return Promise.reject(new Error('Finish choosing text in the main window first.'));
  const timer=state.timer,expectedTimer=structuredClone({startedAt:timer.startedAt,allocations:timer.allocations,intervals:timer.intervals||[]});
  const operation=(async()=>{
    if(['pause','resume','finish'].includes(type))await disconnectController?.prepareSubject?.();
    const action={type,...(type==='start'?{}:{expectedTimer})};
    if(type==='start'||subjectDirty)action.note=$('subject').value.trim();
    return dispatchSubject(crypto.randomUUID(),action);
  })();
  timerTransition=operation;renderTimer();
  const complete=()=>{if(timerTransition===operation){timerTransition=null;renderTimer();}};
  operation.then(complete,complete);return operation;
}
$('continue-last').addEventListener('click',()=>{
  dispatchSubject(crypto.randomUUID(),{type:'continue-last'}).catch(error=>notify(error.message||String(error),true));
});
$('finish-timer').addEventListener('click',async()=>{
  try{await timerAction('finish');notify('Time recorded');}
  catch(error){notify(error.message||String(error),true);}
});
function saveMainSubject(){dispatchSubject(crypto.randomUUID(),{type:'subject',note:$('subject').value}).catch(error=>notify(error.message||String(error),true));}
$('subject').addEventListener('compositionstart',()=>{subjectComposing=true;subjectDirty=true;subjectVersion++;compositionCommit=null;});
$('subject').addEventListener('compositionend',()=>{subjectComposing=false;subjectDirty=true;subjectVersion++;compositionCommit=$('subject').value;saveMainSubject();});
$('subject').addEventListener('input',event=>{
  if(!subjectComposing&&!event.isComposing&&compositionCommit===$('subject').value){compositionCommit=null;return;}
  compositionCommit=null;subjectDirty=true;subjectVersion++;
  if(!subjectComposing&&!event.isComposing)saveMainSubject();
});
['manual-button','add-record'].forEach(id=>$(id).addEventListener('click',()=>openRecord(dayKey())));
$('day-add-record').addEventListener('click',()=>openRecord(daySelection));
['record-hours','record-minutes'].forEach(id=>$(id).addEventListener('input',()=>{recordDurationEdited=true;}));
['record-start','record-end'].forEach(id=>$(id).addEventListener('input',()=>{
  recordTimeEdited=true;
  if(recordDurationEdited||recordOriginal)return;
  try {
    const range=clockRange($('record-date').value,$('record-start').value,$('record-end').value);
    if(range.start!==null){const minutes=Math.floor((range.end-range.start)/60000);$('record-hours').value=Math.floor(minutes/60);$('record-minutes').value=minutes%60;}
  }catch { /* Validate incomplete input on Save. */ }
}));
function setRecordBusy(busy) {
  recordSaving=busy;$('record-form').querySelector('[type="submit"]').disabled=busy;$('delete-record').disabled=busy;
}
function enteredRange(key) {
  const start=$('record-start').value,end=$('record-end').value;
  if(!!start!==!!end)throw new Error('Enter both start and end times.');
  try {return clockRange(key,start,end,recordOriginal?.utcOffsets);}
  catch {throw new Error('End must be after start. Use 00:00 for midnight.');}
}
function preservedRange(previous,origin,key) {
  return relocateSessionRange(previous,origin,key);
}
$('record-form').addEventListener('submit',async event=>{
  event.preventDefault();if(recordSaving)return;
  if($('record-hours').value===''&&$('record-minutes').value===''){
    $('record-error').textContent='Enter hours or minutes.';return;
  }
  const hours=Number($('record-hours').value),minutes=Number($('record-minutes').value),key=$('record-date').value,note=$('record-note').value.trim();
  if(![hours,minutes].every(Number.isInteger)||hours<0||minutes<0||minutes>59){$('record-error').textContent='Enter a valid duration using whole numbers.';return;}
  const enteredSeconds=hours*3600+minutes*60;
  if(!recordOriginal&&enteredSeconds===0){$('record-error').textContent='Enter a duration greater than 0.';return;}
  setRecordBusy(true);
  try {
    const original=recordOriginal,origin=recordOrigin,id=recordId;
    const range=!original||recordTimeEdited?enteredRange(key):null;
    savedState(await recordUndo.edit(origin,id,previous=>{
      const seconds=original&&!recordDurationEdited?previous.seconds:enteredSeconds;
      if(seconds===0)return null;
      const times=range||preservedRange(previous,origin,key);
      if(seconds>86400)throw new Error('Duration cannot exceed 24 hours.');
      if(times.start!==null&&seconds>Math.floor((times.end-times.start)/1000))throw new Error('Duration cannot exceed the time range.');
      return {id,seconds,note,...times,source:previous?.source||'manual'};
    },{newKey:key,requireExisting:!!original}));
    $('record-dialog').close();undoNotice=state.records[key]?.sessions.some(entry=>entry.id===id)?'Saved':'Deleted';notify(undoNotice);
  }catch(error){$('record-error').textContent=error.message||String(error);}
  finally {setRecordBusy(false);}
});
$('delete-record').addEventListener('click',async()=>{
  if(recordSaving||!recordOriginal)return;setRecordBusy(true);
  try {savedState(await recordUndo.edit(recordOrigin,recordId,()=>null,{requireExisting:true}));$('record-dialog').close();undoNotice='Deleted';notify(undoNotice);}
  catch(error){$('record-error').textContent=error.message||String(error);}
  finally {setRecordBusy(false);}
});
$('record-dialog').addEventListener('close',()=>{
  if(returnDay){const key=returnDay;returnDay=null;openDay(key);}
});
$('day-dialog').addEventListener('close',()=>{
  if(!$('record-dialog').open)$('heatmap').querySelector(`[data-date="${daySelection}"]`)?.focus({preventScroll:true});
});
$('undo-button').addEventListener('click',async()=>{
  $('undo-button').disabled=true;
  try {if(latestUndo()?.type==='finish')await controller.dispatch(crypto.randomUUID(),{type:'undo'});else savedState(await recordUndo.undo());notify('Restored');}
  catch(error){notify(error.message||String(error),true);}
  finally {$('undo-button').disabled=false;}
});
async function openBackups() {
  if(backupBusy||document.querySelector('dialog[open]'))return;
  backupSelection=null;$('backup-status').textContent='';$('restore-backup').disabled=true;$('backup-error').textContent='';$('backup-list').textContent='Loading…';$('backup-preview').hidden=true;
  $('backup-dialog').showModal();backupBusy=true;
  try {
    const backups=await native('list_auto_backups');$('backup-list').replaceChildren();
    const latest=backups.filter(backup=>backup.kind==='daily').sort((a,b)=>Date.parse(b.exportedAt)-Date.parse(a.exportedAt))[0];
    $('backup-status').textContent=latest?`Last automatic backup · ${new Date(latest.exportedAt).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}`:'No automatic backups yet.';
    if(!backups.length)$('backup-list').textContent='No automatic backups yet.';
    backups.forEach(backup=>{
      const button=document.createElement('button');button.type='button';button.className='backup-row';button.setAttribute('aria-pressed','false');
      const date=document.createElement('strong');
      date.textContent=backup.kind==='recovery'?`Before restore · ${new Date(backup.exportedAt).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'})}`:displayDate(backup.date,{year:'numeric',month:'short',day:'numeric'});
      const detail=document.createElement('span');detail.textContent=`${backup.days} study ${backup.days===1?'day':'days'} · ${durationText(backup.totalSeconds)}`;button.append(date,detail);
      button.addEventListener('click',()=>{
        backupSelection=backup.id;$('backup-list').querySelectorAll('button').forEach(row=>row.setAttribute('aria-pressed',String(row===button)));
        $('restore-backup').disabled=false;$('backup-preview').hidden=false;
      });$('backup-list').append(button);
    });
  }catch(error){$('backup-list').replaceChildren();$('backup-error').textContent=String(error);}
  finally {backupBusy=false;}
}
$('show-backup-folder').addEventListener('click',async()=>{
  try {await native('show_backup_folder');}catch(error){$('backup-error').textContent=error.message||String(error);}
});
$('restore-backup').addEventListener('click',async()=>{
  if(!backupSelection||backupBusy)return;backupBusy=true;
  $('backup-dialog').querySelectorAll('button').forEach(button=>button.disabled=true);
  try {
    const id=backupSelection;state=await store.refresh(()=>native('restore_auto_backup',{id}));recordUndo.discard();blocked=false;
    if(controller?.snapshot().ready===false)await activateController();
    savedState(state);$('backup-dialog').close();notify('Backup restored');
  }catch(error){
    $('backup-error').textContent=error.message||String(error);
    try {state=await store.refresh();recordUndo.discard();blocked=false;if(controller?.snapshot().ready===false)await activateController();savedState(state);}
    catch(error){unavailableData(error);}
  }
  finally {backupBusy=false;$('backup-dialog').querySelectorAll('button').forEach(button=>button.disabled=false);}
});
$('goal-button').addEventListener('click',()=>{$('goal-input').value=state.goal;$('goal-error').textContent='';$('goal-dialog').showModal();});
$('goal-form').addEventListener('submit',async event=>{
  event.preventDefault();const goal=Number($('goal-input').value);
  if(!Number.isInteger(goal)||goal<5||goal>1440){$('goal-error').textContent='Daily goal must be between 5 and 1440 minutes.';return;}
  try {await commit(current=>({...current,goal}));$('goal-dialog').close();notify('Goal updated');}
  catch(error){$('goal-error').textContent=error.message||String(error);}
});
$('previous-year').addEventListener('click',()=>{year--;hideTooltip();renderCalendar();$('heatmap-scroll').scrollLeft=0;});
$('next-year').addEventListener('click',()=>{year++;hideTooltip();renderCalendar();$('heatmap-scroll').scrollLeft=0;});
$('heatmap-scroll').addEventListener('scroll',hideTooltip);
$('legend-button').addEventListener('click',()=>{$('legend-detail').hidden=!$('legend-detail').hidden;$('legend-button').setAttribute('aria-expanded',String(!$('legend-detail').hidden));});
$('export-button').addEventListener('click',async()=>{
  try {
    const raw=store.raw();
    if(blocked){if(!raw)throw new Error('Unable to read your data. Keep the database and restart Comet.');if(await downloadJSON(raw,`comet-raw-data-${dayKey()}.json`))notify('Raw data exported. Keep this file for recovery.');return;}
    const latest=readState(),backup=makeBackup(latest);
    if(await downloadJSON(JSON.stringify(backup,null,2),`comet-backup-${dayKey()}.json`))notify('Backup exported. Finish your current timer to include it.');
  }catch(error){notify(error.message||String(error),true);}
});
$('import-button').addEventListener('click',async()=>{
  if(blocked){notify('Export your raw data and resolve the storage issue first.',true);return;}
  if(!native){$('import-file').click();return;}
  try {const content=await native('import_backup');if(content!==null)prepareImport(content);}catch(error){notify(String(error),true);}
});
function prepareImport(content) {
  importData=normalizeBackup(JSON.parse(content),dayKey());state=readState();
  const keys=Object.keys(importData.records),overlaps=keys.filter(k=>Object.hasOwn(state.records,k)).length;
  $('import-summary').textContent=`${keys.length} ${keys.length===1?'day':'days'}, ${overlaps} overlapping. Daily goal will be set to ${durationText(importData.goal*60)}.`;
  $('import-error').textContent='';
  $('import-dialog').showModal();
}
$('import-file').addEventListener('change',async event=>{
  const file=event.target.files[0];event.target.value='';if(!file)return;
  try {
    if(file.size>5*1024*1024)throw new Error('Choose a JSON backup smaller than 5 MB.');
    prepareImport(await file.text());
  }catch(error){importData=null;notify(error instanceof SyntaxError?'This is not valid JSON. Your records are unchanged.':error.message,true);}
});
$('confirm-import').addEventListener('click',async()=>{
  if(!importData)return;
  // Revalidate at confirmation in case a midnight boundary or another tab changed data.
  const pendingImport=importData;
  try {
    await commit(current=>mergeBackup(current,{version:1,...pendingImport},dayKey()));
    importData=null;$('import-dialog').close();notify('Imported');
  }catch(error){$('import-error').textContent=error.message||String(error);}
});
document.querySelectorAll('.close-dialog').forEach(button=>button.addEventListener('click',()=>button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{
  if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}
}));
window.addEventListener('storage',async event=>{
  if(native)return;
  if(event.key!==STORAGE_KEY&&event.key!==null)return;
  try {state=await store.refresh();blocked=false;if(controller?.snapshot().ready===false)await activateController();savedState(state);}catch(error){unavailableData(error);}
});
window.addEventListener('resize',dismissTooltip);
window.addEventListener('scroll',hideTooltip,true);
window.addEventListener('wheel',dismissTooltip,{capture:true,passive:true});
window.addEventListener('touchstart',dismissTooltip,{capture:true,passive:true});
window.addEventListener('blur',dismissTooltip);
document.addEventListener('pointerdown',()=>{
  document.documentElement.dataset.inputMode='pointer';tooltipTabPending=false;dismissTooltip();
},true);
document.addEventListener('keydown',event=>{
  if(event.key==='Tab'||event.key.startsWith('Arrow')||event.key==='Enter'||event.key===' ')document.documentElement.dataset.inputMode='keyboard';
  tooltipTabPending=event.key==='Tab';
  if(event.key==='Escape')dismissTooltip();
});
document.querySelectorAll('dialog').forEach(dialog=>{
  dialog.addEventListener('close',dismissTooltip);
  new MutationObserver(placeToast).observe(dialog,{attributes:true,attributeFilter:['open']});
});
document.addEventListener('visibilitychange',()=>{
  if(!document.hidden){try {state=readState();render();}catch(error){notify(error.message,true);}}
});
document.querySelectorAll('button').forEach(button=>button.disabled=true);
if(native){
  await window.__TAURI__.event.listen('comet-restore-backup',openBackups);
  await window.__TAURI__.event.listen('comet-storage-error',event=>{
    $('quit-error-message').textContent=String(event.payload);
    if(!$('quit-error-dialog').open)$('quit-error-dialog').showModal();
  });
  await window.__TAURI__.event.listen('comet-state-changed',async()=>{
    try{state=await store.refresh();blocked=false;if(controller?.snapshot().ready===false)await activateController();savedState(state);}catch(error){unavailableData(error);}
  });
  await window.__TAURI__.event.listen('comet-open-day',event=>{
    const key=typeof event.payload==='string'?event.payload:event.payload?.date;
    navigateDay(key);
  });
}
try {state=await store.load();}catch(error){blocked=true;notify('Unable to load your data. Keep a backup and restart Comet.',true);}
await activateController(blocked?'Unable to load your data. Open Comet to recover it.':null);
document.querySelectorAll('button').forEach(button=>button.disabled=false);
render();
void checkBackupStatus();
new ResizeObserver(sizeCalendar).observe($('heatmap-scroll'));
requestAnimationFrame(()=>{const current=$('heatmap').querySelector('.today');if(current&&window.innerWidth<1100)$('heatmap-scroll').scrollLeft=Math.max(0,current.offsetLeft-$('heatmap').offsetLeft-$('heatmap-scroll').clientWidth+80);});
window.addEventListener('focus',()=>timerRefresh.refresh());
