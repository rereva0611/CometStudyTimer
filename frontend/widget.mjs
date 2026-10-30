import {dayKey,localDate,offsetDate,heatLevel,durationText,timerText,timerMilliseconds} from './core.mjs';
import {createWidgetClient} from './widget-bridge.mjs';
import {createTimerRefresh} from './timer-refresh.mjs';
import {createWidgetPreview} from './widget-preview.mjs';
const $=id=>document.getElementById(id);
let client,preview,snapshot=null,prefs={collapsed:false,pinned:false},busy=false,calendarDate=null,noticeTimer,noticeKind=null,hovered=null;
let subjectDirty=false,subjectVersion=0,subjectComposing=false,compositionCommit=null,subjectPending=null;
const empty={version:1,records:{},goal:120,timer:{startedAt:null,allocations:{},note:''}};
const timerRefresh=createTimerRefresh({readTimer:()=>snapshot?.state.timer||empty.timer,onTick:()=>{
  if(calendarDate!==dayKey()||snapshot?.undo)render();
  else if(snapshot)renderClocks();
}});
function renderClocks(){
  const value=timerText(Math.floor(timerMilliseconds((snapshot?.state||empty).timer)/1000));
  $('widget-timer').textContent=value;$('widget-peek-timer').textContent=value;
}
function errorNotice(error){noticeKind='error';$('widget-message').textContent=error?.message||String(error);$('widget-undo').hidden=!(snapshot?.undo?.expiresAt>Date.now());$('widget-toast').classList.add('error');$('widget-toast').hidden=false;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>{$('widget-toast').hidden=true;noticeKind=null;render();},9000);}
function clearTooltip(){hovered=null;$('widget-tooltip').hidden=true;}
function tooltip(cell){
  if(cell.disabled)return;hovered=cell;
  const date=localDate(cell.dataset.date).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
  const tip=$('widget-tooltip');tip.textContent=`${date} · ${durationText((snapshot?.state||empty).records[cell.dataset.date]?.seconds||0)}`;tip.hidden=false;
  const card=$('widget-card').getBoundingClientRect(),rect=cell.getBoundingClientRect();
  tip.style.left=`${Math.min(320-tip.offsetWidth-10,Math.max(10,rect.left-card.left-8))}px`;
  tip.style.top=`${rect.top-card.top>tip.offsetHeight+8?rect.top-card.top-tip.offsetHeight-5:rect.bottom-card.top+5}px`;
}
function calendar(){
  const today=dayKey(),start=offsetDate(today,-localDate(today).getDay()-77),grid=$('widget-heatmap');
  grid.replaceChildren();$('widget-months').replaceChildren();
  let previousMonth=null;
  for(let i=0;i<84;i++){
    const key=offsetDate(start,i),date=localDate(key),cell=document.createElement('button');
    cell.type='button';cell.dataset.date=key;cell.dataset.future=String(key>today);
    if(key===today)cell.classList.add('today');
    cell.addEventListener('pointerenter',()=>tooltip(cell));cell.addEventListener('pointerleave',clearTooltip);
    cell.addEventListener('focus',()=>{if(document.documentElement.dataset.inputMode==='keyboard')tooltip(cell);});cell.addEventListener('blur',clearTooltip);
    cell.addEventListener('click',()=>{clearTooltip();client.openDay(key).catch(errorNotice);cell.blur();});grid.append(cell);
    if(i%7===0){const month=document.createElement('span'),name=date.toLocaleDateString('en-US',{month:'short'});month.textContent=name!==previousMonth?name:'';$('widget-months').append(month);previousMonth=name;}
  }
  calendarDate=today;
}
function render(){
  if(calendarDate!==dayKey()){clearTooltip();calendar();}
  const state=snapshot?.state||empty,ready=snapshot?.ready===true;
  const active=state.timer.startedAt!==null||Object.keys(state.timer.allocations).length>0;
  $('widget-card').hidden=prefs.collapsed;$('widget-icon').hidden=!prefs.collapsed;
  $('collapsed-shell').hidden=!prefs.collapsed;preview?.update();
  $('heatmap-view').hidden=active;$('timer-view').hidden=!active;
  $('widget-running-dot').hidden=state.timer.startedAt===null;
  $('widget-pin').setAttribute('aria-pressed',String(prefs.pinned));$('widget-pin').setAttribute('aria-label',prefs.pinned?'Unpin widget':'Pin widget');
  for(const cell of $('widget-heatmap').children){
    const seconds=state.records[cell.dataset.date]?.seconds||0,level=heatLevel(seconds);
    cell.className=`level-${level}${cell.dataset.date===dayKey()?' today':''}`;cell.disabled=!ready||cell.dataset.future==='true';
    cell.setAttribute('aria-label',`${localDate(cell.dataset.date).toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'})}, ${durationText(seconds)}`);
  }
  const seconds=state.records[dayKey()]?.seconds||0,progress=Math.min(100,Math.floor(seconds/(state.goal*60)*100));
  $('widget-today').textContent=`Today ${durationText(seconds)} / ${durationText(state.goal*60)}`;
  $('widget-progress').style.width=`${progress}%`;$('widget-progress').parentElement.setAttribute('aria-valuenow',String(progress));
  renderClocks();
  timerRefresh.reschedule();
  if(!subjectDirty&&!subjectComposing&&$('widget-subject').value!==(state.timer.note||''))$('widget-subject').value=state.timer.note||'';
  const action=state.timer.startedAt===null?'Resume':'Pause';
  if($('widget-toggle').dataset.action!==action){$('widget-toggle').querySelector('span').textContent=action;$('widget-toggle').querySelector('use').setAttribute('href',action==='Pause'?'#pause':'#play');$('widget-toggle').dataset.action=action;}
  for(const id of ['widget-start','widget-toggle','widget-finish'])$(id).disabled=!ready||busy;
  $('widget-subject').disabled=!ready;
  const undo=snapshot?.undo;
  if(noticeKind==='error'){
    $('widget-undo').hidden=!(undo&&undo.expiresAt>Date.now());$('widget-undo').disabled=busy;
  }else if(undo&&undo.expiresAt>Date.now()){
    noticeKind='saved';$('widget-message').textContent='Saved ·';$('widget-toast').classList.remove('error');$('widget-undo').hidden=false;$('widget-undo').disabled=busy;$('widget-toast').hidden=false;
  }else if(noticeKind==='saved'){noticeKind=null;$('widget-toast').hidden=true;$('widget-undo').hidden=true;}
  if(active||prefs.collapsed)clearTooltip();else if(hovered)tooltip(hovered);
}
async function dispatchSubject(action){
  const version=subjectVersion;
  const result=await client.dispatch(action);
  if(version===subjectVersion){subjectDirty=false;render();}
  return result;
}
async function action(type){
  clearTooltip();
  if(type==='finish'&&subjectComposing){errorNotice(new Error('Finish choosing text in the widget first.'));return;}
  try{const outgoing={type,...(['pause','resume','finish'].includes(type)&&subjectDirty?{note:$('widget-subject').value.trim()}:{})};await (Object.hasOwn(outgoing,'note')?dispatchSubject(outgoing):client.dispatch(outgoing));if(noticeKind==='error'){clearTimeout(noticeTimer);noticeKind=null;$('widget-toast').hidden=true;render();}}
  catch(error){errorNotice(error);}
}
$('widget-start').addEventListener('click',()=>void action('start'));
$('widget-toggle').addEventListener('click',()=>void action(snapshot?.state.timer.startedAt===null?'resume':'pause'));
$('widget-finish').addEventListener('click',()=>void action('finish'));
$('widget-undo').addEventListener('click',()=>void action('undo'));
function saveSubject(){
  const pending=dispatchSubject({type:'subject',note:$('widget-subject').value});subjectPending=pending;
  pending.then(()=>{if(subjectPending===pending)subjectPending=null;},error=>{if(subjectPending===pending)subjectPending=null;errorNotice(error);});
  return pending;
}
async function flushSubject(){
  if(subjectComposing)throw new Error('Finish choosing text in the widget first.');
  while(subjectDirty||subjectPending){
    await (subjectPending||saveSubject());
    if(subjectComposing)throw new Error('Finish choosing text in the widget first.');
  }
}
$('widget-subject').addEventListener('compositionstart',()=>{subjectComposing=true;subjectDirty=true;subjectVersion++;compositionCommit=null;});
$('widget-subject').addEventListener('compositionend',()=>{
  subjectComposing=false;subjectDirty=true;subjectVersion++;compositionCommit=$('widget-subject').value;saveSubject();
});
$('widget-subject').addEventListener('input',event=>{
  if(!subjectComposing&&!event.isComposing&&compositionCommit===$('widget-subject').value){compositionCommit=null;return;}
  compositionCommit=null;subjectDirty=true;subjectVersion++;
  if(!subjectComposing&&!event.isComposing)saveSubject();
});
$('widget-pin').addEventListener('click',()=>{clearTooltip();client.pin(!prefs.pinned).catch(errorNotice);});
$('widget-collapse').addEventListener('click',()=>{clearTooltip();collapseWidget(true);});
let drag=null,suppressIconClick=false,geometry=Promise.resolve();
preview=createWidgetPreview({element:$('collapsed-shell'),collapsed:()=>prefs.collapsed,isDragging:()=>!!drag,
  resize:value=>client.preview(value),
  enqueue:work=>{const operation=geometry.then(work);geometry=operation.catch(()=>{});return operation;},onError:errorNotice});
function collapseWidget(collapsed){
  preview.cancelOpen();
  finishDrag();
  geometry=geometry.then(()=>client.collapse(collapsed)).catch(errorNotice);
}
function dragPosition(state,event){
  const delta={x:event.screenX-state.startX,y:event.screenY-state.startY};
  state.latest=delta;
  state.pending=state.pending.then(()=>{
    // Only send the newest queued point while a native operation is pending.
    if(state.latest!==delta)return;
    state.latest=null;
    return client.moveDrag(state.origin[0]+delta.x,state.origin[1]+delta.y);
  });
  // Preserve rejection for finishDrag while handling it immediately.
  state.pending.catch(()=>{});
}
function finishDrag(event){
  const state=drag;
  if(!state||event?.pointerId!==undefined&&event.pointerId!==state.pointerId)return;
  drag=null;
  if(state.target.hasPointerCapture?.(state.pointerId))state.target.releasePointerCapture(state.pointerId);
  if(!state.started)return;
  if(event?.type==='pointerup')dragPosition(state,event);
  void state.pending.catch(errorNotice).then(()=>state.begun?client.endDrag():undefined).catch(errorNotice).finally(state.complete);
}
for(const target of [$('widget-header'),$('collapsed-shell')]){
  target.addEventListener('pointerdown',event=>{
    if(event.button!==0||drag||target!==$('collapsed-shell')&&event.target.closest('button'))return;
    if(target===$('collapsed-shell'))suppressIconClick=false;
    if(!client)return;
    preview.cancelOpen();
    // Avoid WebKit button click tracking while capturing a drag.
    event.preventDefault();
    drag={pointerId:event.pointerId,target,startX:event.screenX,startY:event.screenY,restoreAnchor:target===$('collapsed-shell')&&!preview.isExpanded(),started:false,begun:false,latest:null,pending:Promise.resolve(),origin:null,complete:null};
    target.setPointerCapture(event.pointerId);
  });
  target.addEventListener('pointermove',event=>{
    const state=drag;
    if(!state||state.pointerId!==event.pointerId)return;
    // Captured native WebKit moves may report buttons=0; end on up/cancel instead.
    const dx=event.screenX-state.startX,dy=event.screenY-state.startY;
    if(!state.started){
      if(Math.hypot(dx,dy)<=4)return;
      state.started=true;clearTooltip();preview.suspend();
      if(target===$('collapsed-shell'))suppressIconClick=true;
      const previous=geometry;
      // Reserve the complete lifecycle now: the next begin/resize waits for end.
      geometry=new Promise(resolve=>{state.complete=resolve;});
      state.pending=previous.then(async()=>{
        // A hover request already in flight may move the icon after pointerdown.
        // Restore that anchor before deriving the drag origin. An already visible
        // strip instead keeps its current icon position when dragging begins.
        if(state.restoreAnchor)await client.preview(false);
        return client.beginDrag();
      }).then(origin=>{state.origin=origin;state.begun=true;});
    }
    dragPosition(state,event);
  });
  target.addEventListener('pointerup',finishDrag);
  target.addEventListener('pointercancel',finishDrag);
  target.addEventListener('lostpointercapture',finishDrag);
}
$('collapsed-shell').addEventListener('click',event=>{
  if(suppressIconClick){suppressIconClick=false;event.preventDefault();return;}
  collapseWidget(false);
});
document.addEventListener('pointerdown',()=>{document.documentElement.dataset.inputMode='pointer';});
document.addEventListener('keydown',event=>{if(event.key==='Tab'||event.key.startsWith('Arrow'))document.documentElement.dataset.inputMode='keyboard';if(event.key==='Escape')clearTooltip();});
window.addEventListener('blur',()=>{clearTooltip();finishDrag();preview.blur();});window.addEventListener('resize',clearTooltip);
document.addEventListener('visibilitychange',()=>{clearTooltip();if(document.hidden){finishDrag();preview.close();}else render();});
render();
try{client=await createWidgetClient({onState:value=>{snapshot=value;render();if(value.error)errorNotice(value.error);},onPreferences:value=>{prefs=value;clearTooltip();render();},onPreview:value=>preview.accept(value),onHover:value=>preview.hover(value.inside),onError:errorNotice,onBusy:value=>{busy=value;render();},onBeforeTransition:flushSubject});}
catch(error){errorNotice(error);}
window.addEventListener('focus',()=>timerRefresh.refresh());

