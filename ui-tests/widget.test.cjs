const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'../frontend'),key='xueshi.study-log.v1';
let browser,server,origin;
before(async()=>{
  server=http.createServer(async(req,res)=>{
    const name=req.url==='/'?'index.html':req.url.split('?')[0].slice(1);
    if(!/^[a-z-]+\.(html|css|mjs|js)$/.test(name))return res.writeHead(404).end();
    try{const data=await fs.readFile(path.join(root,name));res.setHeader('Content-Type',name.endsWith('.html')?'text/html':name.endsWith('.css')?'text/css':'text/javascript');res.end(data);}
    catch{res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
async function fixture(t,{controlledClock=false}={}){
  const context=await browser.newContext();t.after(()=>context.close());
  const main=await context.newPage();await main.setViewportSize({width:1180,height:860});
  if(controlledClock){const time=Math.floor(Date.now()/1000)*1000+125;await main.clock.install({time:time-60000});await main.clock.pauseAt(time);}
  await main.goto(origin);
  const date=await main.evaluate(key=>{
    const d=new Date(),date=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    localStorage.setItem(key,JSON.stringify({version:1,goal:240,records:{[date]:{seconds:3600,note:'Original'}},timer:{startedAt:null,allocations:{},note:'',intervals:[]}}));return date;
  },key);
  await main.reload();await main.locator('#heatmap .today').waitFor();
  if(controlledClock)await main.clock.runFor(375);
  const widget=await context.newPage();await widget.setViewportSize({width:320,height:300});
  if(controlledClock){const time=await main.evaluate(()=>Date.now());await widget.clock.install({time:time-60000});await widget.clock.pauseAt(time);}
  const errors=[];for(const p of [main,widget]){p.setDefaultTimeout(6000);p.on('pageerror',e=>errors.push(e.message));}t.after(()=>assert.deepEqual(errors,[]));
  const response=await widget.goto(`${origin}/widget.html`);
  assert.equal(response.status(),200,'desktop widget entrypoint must exist');
  await widget.locator('#widget-start:not(:disabled)').waitFor();
  return {main,widget,date,context};
}
test('main and widget display the same elapsed second despite different window launch times',async t=>{
  const {main,widget}=await fixture(t,{controlledClock:true});
  await main.locator('#toggle-timer').dispatchEvent('click');await widget.locator('#timer-view').waitFor({state:'visible'});
  for(const elapsed of [1000,1000,550]){
    await main.clock.runFor(elapsed);await widget.clock.runFor(elapsed);
    assert.equal(await main.locator('#timer-display').textContent(),await widget.locator('#widget-timer').textContent(),'both visible clocks must use the same elapsed-second boundary');
  }
  await widget.locator('#widget-toggle').dispatchEvent('click');await main.getByRole('button',{name:'Resume',exact:true}).waitFor();
  const paused=await main.locator('#timer-display').textContent();
  await main.clock.runFor(725);await widget.clock.runFor(725);
  assert.equal(await main.locator('#timer-display').textContent(),paused);assert.equal(await widget.locator('#widget-timer').textContent(),paused);
  await main.locator('#toggle-timer').dispatchEvent('click');await widget.getByRole('button',{name:'Pause',exact:true}).waitFor();
  await main.clock.runFor(450);await widget.clock.runFor(450);
  const expected=await main.evaluate(async key=>{
    const {timerMilliseconds,timerText}=await import('./core.mjs');
    return timerText(Math.floor(timerMilliseconds(JSON.parse(localStorage.getItem(key)).timer)/1000));
  },key);
  assert.equal(await main.locator('#timer-display').textContent(),expected);
  assert.equal(await widget.locator('#widget-timer').textContent(),expected);
});
test('two-view widget fits 320×300 and shows 84 square cells with today progress',async t=>{
  const {widget}=await fixture(t);
  assert.equal(await widget.locator('#widget-heatmap button').count(),84);
  const geometry=await widget.evaluate(()=>{
    const card=document.querySelector('#widget-card').getBoundingClientRect();
    const cells=[...document.querySelectorAll('#widget-heatmap button')].map(x=>{const r=x.getBoundingClientRect();return [r.width,r.height];});
    return {width:card.width,height:card.height,cells,overflow:document.documentElement.scrollHeight>300||document.documentElement.scrollWidth>320};
  });
  assert.equal(geometry.width,320);assert.equal(geometry.height,300);assert.equal(geometry.overflow,false);
  assert(geometry.cells.every(([w,h])=>w===h&&w>10));
  assert.match(await widget.locator('#widget-today').innerText(),/1h.*4h/);
  assert.equal(await widget.locator('dialog').count(),0);
  assert.equal(await widget.locator('#timer-view').isVisible(),false);
});
test('cell hover dismisses and click opens the corresponding main-app day',async t=>{
  const {main,widget,date}=await fixture(t);
  const today=widget.locator(`#widget-heatmap button[data-date="${date}"]`);
  await today.hover();await widget.locator('#widget-tooltip').waitFor({state:'visible'});
  assert.match(await widget.locator('#widget-tooltip').innerText(),/1h/);
  await widget.locator('#widget-start').hover();await widget.locator('#widget-tooltip').waitFor({state:'hidden'});
  await today.click();await main.locator('#day-dialog').waitFor({state:'visible'});
  assert.match(await main.locator('#day-sessions').innerText(),/Original/);
  assert.equal(await widget.locator('dialog').count(),0);
  const future=widget.locator('#widget-heatmap button[data-future="true"]');
  for(const cell of await future.all())assert.equal(await cell.isDisabled(),true);
});
test('widget starts immediately, edits subject, pauses, finishes and Undo restores paused exact timer',async t=>{
  const {main,widget,date}=await fixture(t);
  await widget.locator('#widget-start').click();await widget.locator('#timer-view').waitFor({state:'visible'});
  const sizeBefore=await widget.locator('#widget-card').boundingBox();
  await widget.locator('#widget-subject').fill('Linear algebra');await widget.locator('#widget-subject').press('Tab');
  await widget.waitForFunction(()=>document.querySelector('#widget-timer').textContent!=='00:00:00');
  await widget.locator('#widget-toggle').click();
  await widget.getByRole('button',{name:'Resume',exact:true}).waitFor();
  const paused=await main.evaluate(key=>JSON.parse(localStorage.getItem(key)).timer,key);
  assert.equal(paused.startedAt,null);assert.equal(paused.note,'Linear algebra');
  assert.equal(await main.locator('#subject').inputValue(),'Linear algebra');
  await widget.locator('#widget-finish').click();await widget.locator('#heatmap-view').waitFor({state:'visible'});
  await widget.locator('#widget-undo').waitFor({state:'visible'});
  const saved=await main.evaluate(({key,date})=>JSON.parse(localStorage.getItem(key)).records[date],{key,date});
  assert.equal(saved.sessions.length,2);assert.equal(saved.sessions[1].note,'Linear algebra');
  assert.deepEqual(await widget.locator('#widget-card').boundingBox(),sizeBefore);
  await widget.locator('#widget-undo').click();await widget.locator('#timer-view').waitFor({state:'visible'});
  const after=await main.evaluate(key=>JSON.parse(localStorage.getItem(key)),key);
  assert.deepEqual(after.timer,paused);assert.equal(after.records[date].seconds,3600);
  assert.equal(await widget.getByRole('button',{name:'Resume',exact:true}).isVisible(),true);
  assert.equal(await widget.locator('#widget-undo').isVisible(),false);
});
test('main timer updates widget and no third interface appears while paused',async t=>{
  const {main,widget}=await fixture(t);
  await main.locator('#subject').fill('English');await main.locator('#toggle-timer').click();
  await widget.locator('#timer-view').waitFor({state:'visible'});
  assert.equal(await widget.locator('#widget-subject').inputValue(),'English');
  await main.locator('#toggle-timer').click();await widget.getByRole('button',{name:'Resume',exact:true}).waitFor();
  assert.equal(await widget.locator('#heatmap-view').isVisible(),false);
  assert.equal(await widget.locator('#widget-start').isVisible(),false);
});
test('collapse becomes 48×48 icon and reopening preserves active timer',async t=>{
  const {main,widget}=await fixture(t);
  await widget.locator('#widget-start').click();await widget.locator('#timer-view').waitFor({state:'visible'});
  const started=await main.evaluate(key=>JSON.parse(localStorage.getItem(key)).timer.startedAt,key);
  await widget.locator('#widget-collapse').click();await widget.locator('#widget-icon').waitFor({state:'visible'});
  const icon=await widget.locator('#widget-icon').boundingBox();assert.equal(icon.width,48);assert.equal(icon.height,48);
  assert.equal(await widget.locator('#widget-card').isVisible(),false);
  await widget.locator('#widget-icon').click();await widget.locator('#timer-view').waitFor({state:'visible'});
  assert.equal(await main.evaluate(key=>JSON.parse(localStorage.getItem(key)).timer.startedAt,key),started);
});
test('collapsed hover reveals the current clock to the right, retracts and preserves click behavior',async t=>{
  const {main,widget}=await fixture(t);
  await widget.locator('#widget-collapse').click();await widget.locator('#widget-icon').waitFor({state:'visible'});
  assert.equal(await widget.locator('#widget-peek-timer').count(),1,'collapsed icon needs a hover clock');
  const original=await main.evaluate(key=>localStorage.getItem(key),key);
  await widget.locator('#widget-icon').hover();await widget.locator('#widget-peek-timer').waitFor({state:'visible'});
  assert.equal(await widget.locator('#widget-peek-timer').textContent(),'00:00:00');
  assert.equal((await widget.locator('#collapsed-shell').boundingBox()).width,176);
  if(process.env.COMET_HOVER_SCREENSHOTS)await widget.locator('#collapsed-shell').screenshot({path:path.join(process.env.COMET_HOVER_SCREENSHOTS,'rose-hover.png')});
  await main.locator('#appearance-toggle').click();await widget.waitForFunction(()=>document.documentElement.dataset.theme==='github-dark');
  assert.equal(await widget.locator('#widget-peek-timer').evaluate(el=>getComputedStyle(el).color),'rgb(230, 237, 243)');
  await widget.locator('#widget-icon').hover();await widget.locator('#widget-peek-timer').waitFor({state:'visible'});
  if(process.env.COMET_HOVER_SCREENSHOTS)await widget.locator('#collapsed-shell').screenshot({path:path.join(process.env.COMET_HOVER_SCREENSHOTS,'dark-hover.png')});
  await widget.locator('#widget-peek-timer').hover();assert.equal(await widget.locator('#widget-peek-timer').isVisible(),true);
  assert.equal(await main.evaluate(key=>localStorage.getItem(key),key),original);
  await widget.mouse.move(250,100);await widget.locator('#widget-peek-timer').waitFor({state:'hidden'});
  assert.equal((await widget.locator('#collapsed-shell').boundingBox()).width,48);
  await main.locator('#toggle-timer').click();await widget.locator('#widget-icon').hover();await widget.locator('#widget-peek-timer').waitFor({state:'visible'});
  await widget.waitForFunction(()=>document.querySelector('#widget-peek-timer').textContent!=='00:00:00');
  await main.locator('#toggle-timer').click();await main.getByRole('button',{name:'Resume',exact:true}).waitFor();
  assert.equal(await widget.locator('#widget-peek-timer').textContent(),await main.locator('#timer-display').textContent());
  await widget.locator('#widget-icon').click();await widget.locator('#timer-view').waitFor({state:'visible'});
  assert.equal(await widget.locator('#widget-peek-timer').isVisible(),false);
});
test('new timer invalidates finish Undo without layout change',async t=>{
  const {widget}=await fixture(t);
  await widget.locator('#widget-start').click();await widget.waitForFunction(()=>document.querySelector('#widget-timer').textContent!=='00:00:00');
  await widget.locator('#widget-finish').click();await widget.locator('#widget-undo').waitFor({state:'visible'});
  await widget.locator('#widget-start').click();await widget.locator('#timer-view').waitFor({state:'visible'});
  assert.equal(await widget.locator('#widget-undo').isVisible(),false);
});
test('opening a widget date keeps unsaved main-app record edits intact',async t=>{
  const {main,widget,date}=await fixture(t);
  await main.locator('#heatmap .today').click();await main.locator('#day-sessions .session-row').first().click();
  await main.locator('#record-note').fill('Unsaved correction');
  await widget.locator(`#widget-heatmap button[data-date="${date}"]`).click();
  await main.locator('#toast-message').filter({hasText:'Close the current dialog first.'}).waitFor();
  assert.equal(await main.locator('#record-dialog').isVisible(),true);
  assert.equal(await main.locator('#record-note').inputValue(),'Unsaved correction');
});
test('failed initialization shows a widget error and cannot replace unreadable data',async t=>{
  const context=await browser.newContext();t.after(()=>context.close());
  const main=await context.newPage();await main.goto(origin);
  await main.evaluate(key=>localStorage.setItem(key,'unreadable data'),key);await main.reload();
  const widget=await context.newPage();await widget.setViewportSize({width:320,height:300});await widget.goto(`${origin}/widget.html`);
  await widget.locator('#widget-message').filter({hasText:'Unable to load your data.'}).waitFor({state:'visible'});
  assert.equal(await widget.locator('#widget-start').isDisabled(),true);
  assert.equal(await main.evaluate(key=>localStorage.getItem(key),key),'unreadable data');
});
test('failed Finish retains the timer and retry saves only once',async t=>{
  const {main,widget,date}=await fixture(t);
  await widget.locator('#widget-start').click();await widget.waitForFunction(()=>document.querySelector('#widget-timer').textContent!=='00:00:00');
  await main.evaluate(key=>{
    const original=Storage.prototype.setItem;window.restoreWrites=()=>{Storage.prototype.setItem=original;};
    Storage.prototype.setItem=function(k,v){if(k===key)throw new Error('Storage unavailable');return original.call(this,k,v);};
  },key);
  await widget.locator('#widget-finish').click();await widget.locator('#widget-message').filter({hasText:'Storage unavailable'}).waitFor();
  assert.equal(await widget.locator('#timer-view').isVisible(),true);
  assert.equal(await widget.locator('#widget-undo').isVisible(),false);
  assert.equal(await main.evaluate(({key,date})=>JSON.parse(localStorage.getItem(key)).records[date].seconds,{key,date}),3600);
  await main.evaluate(()=>window.restoreWrites());await widget.locator('#widget-finish').click();
  await widget.locator('#heatmap-view').waitFor({state:'visible'});
  assert.equal(await main.evaluate(({key,date})=>JSON.parse(localStorage.getItem(key)).records[date].sessions.length,{key,date}),2);
});
test('paused zero-ms session stays on timer and Finish clears it without adding a record',async t=>{
  const {main,widget,date}=await fixture(t);
  await main.evaluate(({key,date})=>{const state=JSON.parse(localStorage.getItem(key));state.timer.allocations={[date]:0};localStorage.setItem(key,JSON.stringify(state));},{key,date});
  await main.reload();await widget.locator('#timer-view').waitFor({state:'visible'});
  assert.equal(await widget.getByRole('button',{name:'Resume',exact:true}).isVisible(),true);
  assert.equal(await main.getByRole('button',{name:'Resume',exact:true}).isVisible(),true);
  await widget.locator('#widget-finish').click();await widget.locator('#heatmap-view').waitFor({state:'visible'});
  assert.equal(await main.evaluate(({key,date})=>JSON.parse(localStorage.getItem(key)).records[date].seconds,{key,date}),3600);
  assert.equal(await widget.locator('#widget-undo').isVisible(),false);
});
test('failed Undo keeps its error readable and allows retry before the original expiry',async t=>{
  const {main,widget}=await fixture(t);
  await widget.locator('#widget-start').click();await widget.waitForFunction(()=>document.querySelector('#widget-timer').textContent!=='00:00:00');
  await widget.locator('#widget-finish').click();await widget.locator('#widget-undo').waitFor({state:'visible'});
  await main.evaluate(key=>{
    const original=Storage.prototype.setItem;window.restoreWrites=()=>{Storage.prototype.setItem=original;};
    Storage.prototype.setItem=function(k,v){if(k===key)throw new Error('Storage unavailable');return original.call(this,k,v);};
  },key);
  await widget.locator('#widget-undo').click();await widget.locator('#widget-message').filter({hasText:'Storage unavailable'}).waitFor();
  // Ensure periodic timer rendering does not overwrite the failure message.
  await widget.waitForTimeout(600);
  assert.equal(await widget.locator('#widget-message').innerText(),'Storage unavailable');
  assert.equal(await widget.locator('#widget-undo').isVisible(),true);
  await main.evaluate(()=>window.restoreWrites());await widget.locator('#widget-undo').click();
  await widget.locator('#timer-view').waitFor({state:'visible'});
  assert.equal(await widget.getByRole('button',{name:'Resume',exact:true}).isVisible(),true);
});

// Native fixture uses isolated memory and the actual snapshot/CAS and event shapes.
async function nativeFixture(t){
  const context=await browser.newContext({reducedMotion:'reduce'});t.after(()=>context.close());
  const main=await context.newPage(),widget=await context.newPage(),errors=[];
  const transport={revision:7,value:{version:1,goal:240,records:{},timer:{startedAt:Date.now()-5000,allocations:{},note:'Committed subject',intervals:[]}},rejectRead:false,rejectWrite:false,holdWrites:false,held:[],publications:[],replies:[],cached:null,position:[100,120],moves:[],dragEnds:0,collapses:[],geometry:[],holdMoves:false,heldMoves:[],dragging:false,collapsed:false};
  const emit=async(page,name,payload)=>{if(!page.isClosed())await page.evaluate(({name,payload})=>window.nativeEvents?.[name]?.({payload}),{name,payload});};
  await context.exposeBinding('nativeInvoke',async({page},name,args)=>{
    if(name==='load_snapshot'){if(transport.rejectRead)throw new Error('Read unavailable');return {value:transport.value,revision:transport.revision};}
    if(name==='save_state'){
      if(transport.holdWrites)await new Promise(resolve=>transport.held.push(resolve));
      if(transport.rejectWrite)throw new Error('Subject save unavailable');
      if(args.expectedRevision!==transport.revision)throw new Error('COMET_STATE_CONFLICT');
      transport.value=structuredClone(args.value);transport.revision++;return {value:transport.value,revision:transport.revision};
    }
    if(name==='controller_publish'){transport.cached=structuredClone(args.snapshot);transport.publications.push(transport.cached);await emit(widget,'comet-controller-state',transport.cached);return;}
    if(name==='widget_controller_ready'||name==='backup_status')return null;
    if(name==='widget_snapshot')return transport.cached;
    if(name==='widget_preferences')return {pinned:false,collapsed:transport.collapsed,autostart:true,previewing:!!transport.previewing,previewDirection:transport.previewDirection||'right'};
    if(name==='widget_set_preview'){
      transport.previewCalls??=[];transport.previewCalls.push(args.expanded);transport.geometry.push(args.expanded?'peek-open':'peek-close');
      if(transport.holdPreviews)await new Promise(resolve=>(transport.heldPreviews??=[]).push(resolve));
      const expanded=args.expanded&&transport.collapsed&&!transport.dragging;
      if(expanded&&!transport.previewing){
        transport.previewAnchor=[...transport.position];transport.previewDirection=transport.position[0]+176<=500?'right':'left';
        transport.position=[transport.position[0]-(transport.previewDirection==='left'?128:0),transport.position[1]];
      }
      else if(!expanded&&transport.previewing)transport.position=[...transport.previewAnchor];
      transport.previewing=expanded;const value={expanded,direction:transport.previewDirection||'right'};await emit(widget,'comet-widget-preview',value);return value;
    }
    if(name==='widget_begin_dragging'){transport.geometry.push('begin');if(transport.holdBegins)await new Promise(resolve=>(transport.heldBegins??=[]).push(resolve));transport.dragging=true;if(transport.previewing){transport.position=[...transport.previewAnchor];transport.previewing=false;await emit(widget,'comet-widget-preview',{expanded:false,direction:transport.previewDirection||'right'});}return [...transport.position];}
    if(name==='widget_move_dragging'){
      transport.geometry.push('move');
      if(transport.holdMoves)await new Promise(resolve=>transport.heldMoves.push(resolve));
      if(!transport.dragging)throw new Error('Widget drag is not active.');
      transport.position=[args.x,args.y];transport.moves.push(transport.position);return [...transport.position];
    }
    if(name==='widget_end_dragging'){transport.geometry.push('end');transport.dragging=false;transport.dragEnds++;return;}
    if(name==='widget_set_collapsed'){
      transport.geometry.push('collapse');transport.collapses.push(args.collapsed);
      if(transport.collapsed!==args.collapsed)transport.position=[transport.position[0]+(args.collapsed?272:-272),transport.position[1]];
      transport.collapsed=args.collapsed;
      await emit(widget,'comet-widget-preferences',{pinned:false,collapsed:args.collapsed,autostart:true});return {pinned:false,collapsed:args.collapsed,autostart:true};
    }
    if(name==='widget_dispatch'){await emit(main,'comet-widget-action',args);return;}
    if(name==='widget_reply'){transport.replies.push(structuredClone(args.result));await emit(widget,'comet-widget-reply',args);return;}
    throw new Error('Unexpected native command '+name);
  });
  await context.addInitScript(()=>{window.nativeEvents={};window.__TAURI__={event:{listen:async(name,fn)=>{window.nativeEvents[name]=fn;return ()=>{delete window.nativeEvents[name];};}},core:{invoke:(name,args)=>window.nativeInvoke(name,args)}};});
  for(const page of [main,widget]){page.setDefaultTimeout(6000);page.on('pageerror',e=>errors.push(e.message));}
  t.after(()=>assert.deepEqual(errors,[]));
  await main.goto(origin);await main.locator('#toggle-timer:not(:disabled)').waitFor();
  await widget.setViewportSize({width:320,height:300});await widget.goto(origin+'/widget.html');await widget.locator('#widget-toggle:not(:disabled)').waitFor();
  return {main,widget,transport,emit};
}

test('native widget header and icon follow real pointer drags without invoking a window drag loop',async t=>{
  const {widget,transport}=await nativeFixture(t);
  const header=await widget.locator('#widget-header .brand').boundingBox();
  await widget.mouse.move(header.x+10,header.y+10);await widget.mouse.down();
  await widget.mouse.move(header.x+28,header.y+24,{steps:3});await widget.mouse.up();
  for(let i=0;i<100&&transport.dragEnds<1;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.deepEqual(transport.position,[118,134]);assert.equal(transport.dragEnds,1);
  assert.equal(await widget.locator('#widget-card').isVisible(),true);
  assert.equal(await widget.evaluate(()=>getComputedStyle(document.querySelector('#widget-header .brand')).webkitUserSelect),'none');
  await widget.locator('#widget-collapse').click();await widget.locator('#widget-icon').waitFor({state:'visible'});
  const icon=await widget.locator('#widget-icon').boundingBox();
  await widget.mouse.move(icon.x+20,icon.y+20);await widget.mouse.down();
  await widget.mouse.move(icon.x+34,icon.y+32,{steps:2});await widget.mouse.up();
  for(let i=0;i<100&&transport.dragEnds<2;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.deepEqual(transport.position,[404,146]);assert.equal(transport.dragEnds,2);
  assert.deepEqual(transport.collapses,[true]);
  await widget.locator('#widget-icon').click();assert.deepEqual(transport.collapses,[true,false]);assert.deepEqual(transport.position,[132,146]);
});

test('native hover opens left near the right edge and keeps the icon fixed through retract and direction changes',async t=>{
  const {widget,transport}=await nativeFixture(t);
  await widget.locator('#widget-collapse').click();await widget.locator('#widget-icon').waitFor({state:'visible'});
  const anchor=[...transport.position];assert.deepEqual(anchor,[372,120]);
  await widget.locator('#widget-icon').hover();await widget.locator('#widget-peek-timer').waitFor({state:'visible'});
  assert.deepEqual(transport.position,[244,120]);assert.deepEqual(transport.previewAnchor,anchor);
  let icon=await widget.locator('#widget-icon').boundingBox(),label=await widget.locator('#widget-peek-timer').boundingBox();
  assert.equal(transport.position[0]+icon.x,anchor[0],'the icon must stay at its saved screen position');
  assert.equal(label.x+label.width,icon.x,'time belongs to the left of the stationary icon');
  assert.equal((await widget.locator('#collapsed-shell').boundingBox()).width,176);
  for(const theme of ['rose','github-dark']){
    await widget.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    const borders=await widget.locator('#widget-peek-timer').evaluate(el=>{const s=getComputedStyle(el);return [s.borderLeftWidth,s.borderRightWidth,s.borderTopLeftRadius,s.borderTopRightRadius];});
    assert.deepEqual(borders,['1px','0px','13px','0px']);
    if(process.env.COMET_DIRECTION_SCREENSHOTS)await widget.locator('#collapsed-shell').screenshot({path:path.join(process.env.COMET_DIRECTION_SCREENSHOTS,`${theme}-left.png`)});
  }
  await widget.locator('#widget-peek-timer').hover();await widget.waitForTimeout(250);
  assert.equal(transport.previewing,true,'moving from icon to clock must not retract the strip');
  await widget.mouse.move(250,100);await widget.locator('#widget-peek-timer').waitFor({state:'hidden'});
  assert.deepEqual(transport.position,anchor);assert.deepEqual(transport.previewCalls,[true,false]);
  icon=await widget.locator('#widget-icon').boundingBox();assert.equal(transport.position[0]+icon.x,anchor[0]);
  transport.position=[100,120];
  await widget.locator('#widget-icon').hover();await widget.locator('#widget-peek-timer').waitFor({state:'visible'});
  icon=await widget.locator('#widget-icon').boundingBox();label=await widget.locator('#widget-peek-timer').boundingBox();
  assert.deepEqual(transport.position,[100,120]);assert.equal(icon.x,0);assert.equal(label.x,48);
  assert.equal(await widget.locator('#collapsed-shell').getAttribute('data-direction'),'right');
  await widget.mouse.move(250,100);await widget.locator('#widget-peek-timer').waitFor({state:'hidden'});
  assert.equal(transport.revision,7,'hover geometry must never write study data');
});

test('native preference bootstrap restores the direction of an already expanded left preview',async t=>{
  const {widget,transport}=await nativeFixture(t);
  await widget.locator('#widget-collapse').click();await widget.locator('#widget-icon').hover();
  await widget.locator('#widget-peek-timer').waitFor({state:'visible'});
  await widget.reload();await widget.locator('#widget-peek-timer').waitFor({state:'visible'});
  const icon=await widget.locator('#widget-icon').boundingBox();
  assert.equal(await widget.locator('#collapsed-shell').getAttribute('data-direction'),'left');
  assert.equal(transport.position[0]+icon.x,transport.previewAnchor[0]);
});

test('native hover opens and remains visible without DOM hover or application focus',async t=>{
  const {main,widget,transport,emit}=await nativeFixture(t);
  await widget.locator('#widget-collapse').click();await widget.locator('#widget-icon').waitFor({state:'visible'});
  await widget.mouse.move(250,100);await main.bringToFront();
  await widget.evaluate(()=>window.dispatchEvent(new Event('blur')));
  assert.equal(await widget.locator('#collapsed-shell').evaluate(e=>e.matches(':hover')),false);
  const anchor=[...transport.position];
  await emit(widget,'comet-widget-hover',{inside:true});
  await widget.locator('#widget-peek-timer').waitFor({state:'visible'});
  await widget.waitForTimeout(350);
  assert.equal(transport.previewing,true,'native hover must survive absent WebKit :hover');
  await widget.evaluate(()=>window.dispatchEvent(new Event('blur')));
  await widget.waitForTimeout(200);
  assert.equal(transport.previewing,true,'deactivation must not retract an actually hovered strip');
  await emit(widget,'comet-widget-hover',{inside:false});
  await widget.locator('#widget-peek-timer').waitFor({state:'hidden'});
  assert.deepEqual(transport.position,anchor);assert.equal(transport.revision,7);
});

test('dragging the time area moves the entire strip and keeps pointer capture when the label hides',async t=>{
  const {widget,transport}=await nativeFixture(t);
  await widget.locator('#widget-collapse').click();await widget.locator('#widget-icon').hover();
  await widget.locator('#widget-peek-timer').waitFor({state:'visible'});
  const label=await widget.locator('#widget-peek-timer').boundingBox();
  await widget.mouse.move(label.x+35,label.y+20);await widget.mouse.down();
  await widget.mouse.move(label.x+53,label.y+34,{steps:3});await widget.mouse.up();
  await waitGeometry(()=>transport.dragEnds===1);
  assert.deepEqual(transport.position,[390,134]);assert.deepEqual(transport.collapses,[true]);
  assert.equal(await widget.locator('#widget-peek-timer').isVisible(),false);
  assert.equal(await widget.locator('#widget-card').isVisible(),false);
});

test('leaving during a delayed native hover request retracts after resize completes',async t=>{
  const {widget,transport}=await nativeFixture(t);
  await widget.locator('#widget-collapse').click();await widget.locator('#widget-icon').waitFor({state:'visible'});
  const anchor=[...transport.position];transport.holdPreviews=true;
  await widget.locator('#widget-icon').hover();await waitGeometry(()=>transport.heldPreviews?.length===1);
  await widget.mouse.move(250,100);transport.holdPreviews=false;for(const release of transport.heldPreviews.splice(0))release();
  await waitGeometry(()=>transport.previewCalls?.includes(false));
  await widget.locator('#widget-peek-timer').waitFor({state:'hidden'});assert.deepEqual(transport.position,anchor);
});
test('dragging a left-opening strip starts at its stationary icon and never opens the card',async t=>{
  const {widget,transport}=await nativeFixture(t);
  await widget.locator('#widget-collapse').click();await widget.locator('#widget-icon').waitFor({state:'visible'});
  await widget.locator('#widget-icon').hover();await widget.locator('#widget-peek-timer').waitFor({state:'visible'});
  assert.deepEqual(transport.position,[244,120]);
  const icon=await widget.locator('#widget-icon').boundingBox();
  await widget.mouse.move(icon.x+15,icon.y+15);await widget.mouse.down();await widget.mouse.move(icon.x+33,icon.y+29,{steps:3});await widget.mouse.up();
  await waitGeometry(()=>transport.dragEnds===1);
  assert.deepEqual(transport.position,[390,134]);assert.equal(transport.previewing,false);
  assert.deepEqual(transport.collapses,[true]);assert.equal(await widget.locator('#widget-card').isVisible(),false);
});

test('left-preview icon stays anchored while native drag startup is delayed',async t=>{
  const {widget,transport}=await nativeFixture(t);
  await widget.locator('#widget-collapse').click();await widget.locator('#widget-icon').hover();
  await widget.locator('#widget-peek-timer').waitFor({state:'visible'});
  const anchor=[...transport.previewAnchor],icon=await widget.locator('#widget-icon').boundingBox();
  transport.holdBegins=true;
  await widget.mouse.move(icon.x+15,icon.y+15);await widget.mouse.down();await widget.mouse.move(icon.x+33,icon.y+29);
  await waitGeometry(()=>transport.heldBegins?.length===1);
  const pendingIcon=await widget.locator('#widget-icon').boundingBox();
  assert.equal(transport.position[0]+pendingIcon.x,anchor[0],'hiding the clock must not shift its right-hand icon before native resize');
  assert.equal(await widget.locator('#widget-peek-timer').isVisible(),false);
  transport.holdBegins=false;for(const release of transport.heldBegins.splice(0))release();
  await widget.mouse.up();await waitGeometry(()=>transport.dragEnds===1);
  assert.deepEqual(transport.position,[390,134]);
});

test('dragging while hover expansion is in flight preserves the pointerdown icon origin',async t=>{
  const {widget,transport}=await nativeFixture(t);
  await widget.locator('#widget-collapse').click();await widget.locator('#widget-icon').waitFor({state:'visible'});
  transport.holdPreviews=true;
  await widget.locator('#widget-icon').hover();await waitGeometry(()=>transport.heldPreviews?.length===1);
  const icon=await widget.locator('#widget-icon').boundingBox();
  await widget.mouse.move(icon.x+15,icon.y+15);await widget.mouse.down();await widget.mouse.move(icon.x+33,icon.y+29,{steps:3});
  transport.holdPreviews=false;for(const release of transport.heldPreviews.splice(0))release();
  await waitGeometry(()=>transport.dragging);
  assert.equal(await widget.locator('#widget-peek-timer').isVisible(),false);
  await widget.mouse.up();await waitGeometry(()=>transport.dragEnds===1);
  assert.deepEqual(transport.position,[390,134]);assert.equal(transport.previewing,false);
  assert.deepEqual(transport.collapses,[true]);
});

async function headerGesture(widget,dx,dy){
  const header=await widget.locator('#widget-header .brand').boundingBox();
  await widget.mouse.move(header.x+10,header.y+10);await widget.mouse.down();
  await widget.mouse.move(header.x+10+dx,header.y+10+dy);await widget.mouse.up();
}
async function waitGeometry(predicate){
  for(let i=0;i<200&&!predicate();i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert(predicate(),'native geometry operation should finish');
}
test('two quick native drags serialize begin, coalesced moves and end with delayed positioning',async t=>{
  const {widget,transport}=await nativeFixture(t);
  transport.holdMoves=true;
  await headerGesture(widget,18,14);await waitGeometry(()=>transport.heldMoves.length===1);
  await headerGesture(widget,17,12);
  assert.equal(transport.geometry.filter(x=>x==='begin').length,1,'second begin must wait for the whole first drag');
  transport.holdMoves=false;for(const release of transport.heldMoves.splice(0))release();
  await waitGeometry(()=>transport.dragEnds===2);
  assert.deepEqual(transport.position,[135,146]);assert.equal(transport.dragging,false);
  const secondBegin=transport.geometry.indexOf('begin',1);
  assert(transport.geometry.indexOf('end')<secondBegin);
  assert.equal(await widget.locator('#widget-toast').isVisible(),false);
});
test('native collapse waits for the delayed final drag position and expansion preserves its anchor',async t=>{
  const {widget,transport}=await nativeFixture(t);
  transport.holdMoves=true;await headerGesture(widget,18,14);await waitGeometry(()=>transport.heldMoves.length===1);
  await widget.locator('#widget-collapse').click();assert.deepEqual(transport.collapses,[]);
  transport.holdMoves=false;for(const release of transport.heldMoves.splice(0))release();
  await widget.locator('#widget-icon').waitFor({state:'visible'});
  assert.deepEqual(transport.position,[390,134]);assert(transport.geometry.indexOf('end')<transport.geometry.indexOf('collapse'));
  await widget.locator('#widget-icon').click();await widget.locator('#widget-card').waitFor({state:'visible'});
  assert.deepEqual(transport.position,[118,134]);
});
test('native pointer cancellation and blur release capture and end once before another drag',async t=>{
  const {widget,transport}=await nativeFixture(t);
  for(const cancellation of ['pointercancel','blur']){
    transport.holdMoves=true;
    await widget.evaluate(()=>document.querySelector('#widget-header').addEventListener('pointerdown',event=>window.dragPointerId=event.pointerId,{once:true}));
    const header=await widget.locator('#widget-header .brand').boundingBox();
    await widget.mouse.move(header.x+10,header.y+10);await widget.mouse.down();await widget.mouse.move(header.x+22,header.y+18);
    await waitGeometry(()=>transport.heldMoves.length===1);
    await widget.evaluate(type=>{
      const header=document.querySelector('#widget-header');
      if(type==='blur')window.dispatchEvent(new Event('blur'));
      else header.dispatchEvent(new PointerEvent(type,{pointerId:window.dragPointerId,bubbles:true}));
    },cancellation);
    assert.equal(await widget.evaluate(()=>document.querySelector('#widget-header').hasPointerCapture(window.dragPointerId)),false);
    await widget.mouse.up();const ended=transport.dragEnds;
    await headerGesture(widget,9,7);
    assert.equal(transport.geometry.filter(x=>x==='begin').length,ended+1);
    transport.holdMoves=false;for(const release of transport.heldMoves.splice(0))release();
    await waitGeometry(()=>transport.dragEnds===ended+2);
    assert.equal(transport.dragging,false);
  }
  assert.deepEqual(transport.position,[142,150]);
  assert.equal(await widget.locator('#widget-toast').isVisible(),false);
});

test('dirty main subject survives native window blur, slow save and widget Pause',async t=>{
  const {main,widget,transport,emit}=await nativeFixture(t);
  transport.holdWrites=true;await main.locator('#subject').fill('Draft from main');
  await main.evaluate(()=>{document.hasFocus=()=>false;window.subjectChangeCount=0;document.querySelector('#subject').addEventListener('change',()=>window.subjectChangeCount++);window.dispatchEvent(new Event('blur'));});
  assert.equal(await main.evaluate(()=>document.activeElement.id),'subject');
  await widget.locator('#widget-toggle').click();
  // Re-render an earlier committed snapshot while the draft write is pending.
  await emit(widget,'comet-controller-state',transport.cached);
  transport.holdWrites=false;for(const release of transport.held.splice(0))release();
  await widget.getByRole('button',{name:'Resume',exact:true}).waitFor();
  assert.equal(await main.locator('#subject').inputValue(),'Draft from main');
  assert.equal(await main.evaluate(()=>window.subjectChangeCount),0);
  assert.equal(transport.value.timer.note,'Draft from main');
});

test('failed main subject save remains dirty through blur and a remote transition retry',async t=>{
  const {main,widget,transport}=await nativeFixture(t);
  transport.rejectWrite=true;await main.locator('#subject').fill('Recoverable main draft');
  await main.evaluate(()=>{document.hasFocus=()=>false;window.dispatchEvent(new Event('blur'));});
  await widget.locator('#widget-toggle').click();await widget.locator('#widget-message').filter({hasText:'Subject save unavailable'}).waitFor();
  assert.equal(await main.locator('#subject').inputValue(),'Recoverable main draft');assert.equal(transport.value.timer.note,'Committed subject');
  transport.rejectWrite=false;await widget.locator('#widget-toggle').click();await widget.getByRole('button',{name:'Resume',exact:true}).waitFor();
  assert.equal(transport.value.timer.note,'Recoverable main draft');assert.equal(await main.locator('#subject').inputValue(),'Recoverable main draft');
});

test('widget typing never dims controls or rewrites unchanged focused text while subject saves',async t=>{
  const {widget,transport}=await nativeFixture(t);
  await widget.evaluate(()=>{
    const input=document.querySelector('#widget-subject');
    const descriptor=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');
    window.redundantSubjectWrites=0;window.disabledDuringTyping=[];
    Object.defineProperty(input,'value',{get(){return descriptor.get.call(this);},set(value){
      if(value===descriptor.get.call(this))window.redundantSubjectWrites++;
      descriptor.set.call(this,value);
    }});
    new MutationObserver(changes=>{
      for(const change of changes)if(change.oldValue===null&&change.target.disabled)window.disabledDuringTyping.push(change.target.id);
    }).observe(document.querySelector('#timer-view'),{subtree:true,attributes:true,attributeFilter:['disabled'],attributeOldValue:true});
  });
  transport.holdWrites=true;
  await widget.locator('#widget-subject').fill('Linear ');
  await waitGeometry(()=>transport.held.length>0);
  const during=await widget.evaluate(()=>({disabled:document.querySelector('#widget-toggle').disabled,opacity:getComputedStyle(document.querySelector('#widget-toggle')).opacity}));
  transport.holdWrites=false;for(const release of transport.held.splice(0))release();
  await waitGeometry(()=>transport.value.timer.note==='Linear '&&transport.replies.length>0);
  await widget.locator('#widget-subject').pressSequentially('algebra',{delay:15});
  await waitGeometry(()=>transport.value.timer.note==='Linear algebra');
  const result=await widget.evaluate(()=>({disabled:window.disabledDuringTyping,redundant:window.redundantSubjectWrites,focused:document.activeElement.id,text:document.querySelector('#widget-subject').value}));
  assert.deepEqual(during,{disabled:false,opacity:'1'});
  assert.deepEqual(result,{disabled:[],redundant:0,focused:'widget-subject',text:'Linear algebra'});
});

test('widget Chinese composition stays local until committed and survives older snapshots',async t=>{
  const {widget,transport,emit}=await nativeFixture(t);
  await widget.locator('#widget-subject').focus();
  await widget.evaluate(()=>{
    const input=document.querySelector('#widget-subject');
    input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));
    input.value='xian xing';
    input.dispatchEvent(new InputEvent('input',{bubbles:true,data:'xian xing',inputType:'insertCompositionText',isComposing:true}));
    input.setSelectionRange(4,8);
  });
  await emit(widget,'comet-controller-state',transport.cached);
  assert.equal(transport.value.timer.note,'Committed subject');
  assert.equal(await widget.locator('#widget-subject').inputValue(),'xian xing');
  assert.equal(await widget.locator('#widget-toggle').isDisabled(),false);
  await widget.evaluate(()=>{
    const input=document.querySelector('#widget-subject');input.value='线性代数';
    input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'线性代数'}));
    input.dispatchEvent(new InputEvent('input',{bubbles:true,data:'线性代数',inputType:'insertText',isComposing:false}));
  });
  await waitGeometry(()=>transport.value.timer.note==='线性代数');
  assert.equal(await widget.locator('#widget-subject').inputValue(),'线性代数');
});

test('main Finish waits for a slow widget draft and saves its new content',async t=>{
  const {main,widget,transport}=await nativeFixture(t);
  transport.holdWrites=true;await widget.locator('#widget-subject').fill('New widget task');
  await waitGeometry(()=>transport.held.length>0);
  assert.equal(await main.locator('#subject').inputValue(),'Committed subject');
  await main.locator('#finish-timer').click();
  transport.holdWrites=false;for(const release of transport.held.splice(0))release();
  await waitGeometry(()=>Object.values(transport.value.records).some(day=>day.sessions?.length));
  assert.equal(Object.values(transport.value.records).flatMap(day=>day.sessions)[0].note,'New widget task');
});

test('repeated main Finish clicks share one pending draft preparation',async t=>{
  const {main,widget,transport}=await nativeFixture(t);
  transport.holdWrites=true;await widget.locator('#widget-subject').fill('Only one saved task');
  await waitGeometry(()=>transport.held.length>0);
  await main.evaluate(()=>{const button=document.querySelector('#finish-timer');button.click();button.click();});
  assert.equal(await main.locator('#finish-timer').isDisabled(),true);
  transport.holdWrites=false;for(const release of transport.held.splice(0))release();
  await waitGeometry(()=>Object.values(transport.value.records).some(day=>day.sessions?.length));
  await main.locator('#toggle-timer:not(:disabled)').waitFor();
  const tokens=new Set(transport.publications.map(s=>s.subjectRequest).filter(Boolean));assert.equal(tokens.size,1);
  assert.equal(Object.values(transport.value.records).flatMap(day=>day.sessions).length,1);
});

test('widget Finish preserves Chinese composition in the main window',async t=>{
  const {main,widget,transport}=await nativeFixture(t);
  await main.locator('#subject').focus();
  await main.evaluate(()=>{
    const input=document.querySelector('#subject');input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));
    input.value='英语听力';input.dispatchEvent(new InputEvent('input',{bubbles:true,data:'英语听力',inputType:'insertCompositionText',isComposing:true}));
  });
  await widget.locator('#widget-finish').click();
  await widget.locator('#widget-message').filter({hasText:'Finish choosing text in the main window first.'}).waitFor();
  assert.deepEqual(transport.value.records,{});assert.equal(transport.value.timer.startedAt!==null,true);
  assert.equal(await main.locator('#subject').inputValue(),'英语听力');
  await main.evaluate(()=>document.querySelector('#subject').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'英语听力'})));
  await waitGeometry(()=>transport.value.timer.note==='英语听力');await widget.locator('#widget-finish').click();
  await waitGeometry(()=>Object.values(transport.value.records).some(day=>day.sessions?.length));
  assert.equal(Object.values(transport.value.records).flatMap(day=>day.sessions)[0].note,'英语听力');
});

test('main Finish preserves an uncommitted Chinese widget draft and succeeds after composition ends',async t=>{
  const {main,widget,transport}=await nativeFixture(t);
  await widget.locator('#widget-subject').focus();
  await widget.evaluate(()=>{
    const input=document.querySelector('#widget-subject');
    input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));input.value='线性代数';
    input.dispatchEvent(new InputEvent('input',{bubbles:true,data:'线性代数',inputType:'insertCompositionText',isComposing:true}));
  });
  await main.locator('#finish-timer').click();
  await main.locator('#toast-message').filter({hasText:'Finish choosing text in the widget first.'}).waitFor();
  assert.equal(transport.value.timer.startedAt!==null,true);assert.deepEqual(transport.value.records,{});
  assert.equal(await widget.locator('#widget-subject').inputValue(),'线性代数');
  await widget.evaluate(()=>document.querySelector('#widget-subject').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'线性代数'})));
  await waitGeometry(()=>transport.value.timer.note==='线性代数');
  await main.locator('#finish-timer').click();
  await waitGeometry(()=>Object.values(transport.value.records).some(day=>day.sessions?.length));
  assert.equal(Object.values(transport.value.records).flatMap(day=>day.sessions)[0].note,'线性代数');
});

test('main Pause uses a newer widget subject and does not replace it with pristine main text',async t=>{
  const {main,widget,transport}=await nativeFixture(t);
  transport.holdWrites=true;await widget.locator('#widget-subject').fill('New paused task');
  await waitGeometry(()=>transport.held.length>0);await main.locator('#toggle-timer').click();
  transport.holdWrites=false;for(const release of transport.held.splice(0))release();
  await waitGeometry(()=>transport.value.timer.startedAt===null);
  assert.equal(transport.value.timer.note,'New paused task');
});

test('a failed widget draft save prevents main Finish from recording stale content',async t=>{
  const {main,widget,transport}=await nativeFixture(t);
  transport.holdWrites=true;await widget.locator('#widget-subject').fill('Recoverable widget task');
  await waitGeometry(()=>transport.held.length>0);await main.locator('#finish-timer').click();
  transport.rejectWrite=true;transport.holdWrites=false;for(const release of transport.held.splice(0))release();
  await main.locator('#toast-message').filter({hasText:'Subject save unavailable'}).waitFor();
  assert.equal(transport.value.timer.startedAt!==null,true);assert.deepEqual(transport.value.records,{});
  transport.rejectWrite=false;await main.locator('#finish-timer').click();
  await waitGeometry(()=>Object.values(transport.value.records).some(day=>day.sessions?.length));
  assert.equal(Object.values(transport.value.records).flatMap(day=>day.sessions)[0].note,'Recoverable widget task');
});

test('widget dirty subject survives an older publication while saving after blur',async t=>{
  const {widget,transport,emit}=await nativeFixture(t);
  transport.holdWrites=true;await widget.locator('#widget-subject').fill('Pending widget draft');
  await widget.evaluate(()=>{document.hasFocus=()=>false;window.dispatchEvent(new Event('blur'));});
  await emit(widget,'comet-controller-state',transport.cached);
  assert.equal(await widget.locator('#widget-subject').inputValue(),'Pending widget draft');
  transport.rejectWrite=true;transport.holdWrites=false;for(const release of transport.held.splice(0))release();
  await widget.locator('#widget-message').filter({hasText:'Subject save unavailable'}).waitFor();
  await emit(widget,'comet-controller-state',transport.cached);assert.equal(await widget.locator('#widget-subject').inputValue(),'Pending widget draft');
  transport.rejectWrite=false;await widget.locator('#widget-toggle').click();await widget.getByRole('button',{name:'Resume',exact:true}).waitFor();
  assert.equal(transport.value.timer.note,'Pending widget draft');
});

test('failed authoritative refresh retains last data, disables widget and recovers at the same revision',async t=>{
  const {main,widget,transport,emit}=await nativeFixture(t);const before=structuredClone(transport.cached);
  transport.rejectRead=true;await emit(main,'comet-state-changed',null);
  await widget.locator('#widget-message').filter({hasText:'Read unavailable'}).waitFor();
  for(const id of ['widget-toggle','widget-finish','widget-subject'])assert.equal(await widget.locator('#'+id).isDisabled(),true);
  const unavailable=transport.publications.at(-1);assert.equal(unavailable.ready,false);assert.equal(unavailable.revision,before.revision);assert.deepEqual(unavailable.state,before.state);assert.equal(unavailable.undo,null);
  transport.rejectRead=false;await emit(main,'comet-state-changed',null);await widget.locator('#widget-toggle:not(:disabled)').waitFor();
  assert.equal(transport.cached.ready,true);assert.equal(transport.cached.revision,before.revision);assert.deepEqual(transport.cached.state,before.state);
});

test('client rejects late equal-revision Undo replies and accepts a new controller generation',async t=>{
  const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage();await page.goto(origin+'/widget.html');
  const accepted=await page.evaluate(async()=>{
    const listeners={},accepted=[],requests=[];
    const initial={ready:true,state:{timer:{startedAt:null,allocations:{},note:''},records:{},goal:120},revision:9,undo:{expiresAt:Date.now()+10000},error:null,controllerId:'first',generation:1};
    window.__TAURI__={event:{listen:async(name,fn)=>{listeners[name]=fn;}},core:{invoke:async(name,args)=>{if(name==='widget_snapshot')return initial;if(name==='widget_preferences')return {};if(name==='widget_dispatch')requests.push(args);}}};
    const {createWidgetClient}=await import('./widget-bridge.mjs');const client=await createWidgetClient({onState:s=>accepted.push({controller:s.controllerId,generation:s.generation,undo:!!s.undo})});
    const delayed=client.dispatch({type:'snapshot'});listeners['comet-controller-state']({payload:{...initial,generation:2,undo:null}});
    listeners['comet-widget-reply']({payload:{requestId:requests[0].requestId,result:{ok:true,snapshot:initial}}});await delayed;
    listeners['comet-controller-state']({payload:{...initial,controllerId:'second',generation:1,undo:null}});
    listeners['comet-controller-state']({payload:{...initial,generation:3}});
    listeners['comet-controller-state']({payload:{...initial,controllerId:'second',generation:2,undo:{expiresAt:Date.now()+10000}}});
    listeners['comet-controller-state']({payload:{...initial,controllerId:'second',generation:3,undo:null}});
    listeners['comet-controller-state']({payload:{...initial,controllerId:'second',generation:2}});return accepted;
  });
  assert.deepEqual(accepted,[{controller:'first',generation:1,undo:true},{controller:'first',generation:2,undo:false},{controller:'second',generation:1,undo:false},{controller:'second',generation:2,undo:true},{controller:'second',generation:3,undo:false}]);
});

test('bridge stamps independent generations on publications and replies across main reload',async t=>{
  const {main,widget,transport}=await nativeFixture(t);const first=transport.cached;
  assert(Number.isSafeInteger(first.generation)&&first.generation>0);assert.equal(typeof first.controllerId,'string');
  await widget.locator('#widget-toggle').click();await widget.getByRole('button',{name:'Resume',exact:true}).waitFor();await widget.locator('#widget-toggle:not(:disabled)').waitFor();assert(transport.publications.at(-1).generation>first.generation);
  const reply=transport.replies.at(-1).snapshot;assert(reply.generation>transport.publications.at(-1).generation);assert.equal(reply.controllerId,first.controllerId);
  const oldId=transport.cached.controllerId;await main.reload();await main.locator('#toggle-timer:not(:disabled)').waitFor();await main.waitForFunction(async previous=>(await window.__TAURI__.core.invoke('widget_snapshot'))?.controllerId!==previous,oldId);assert.notEqual(transport.cached.controllerId,oldId);
  await widget.locator('#widget-toggle').click();await widget.getByRole('button',{name:'Pause',exact:true}).waitFor();assert.equal(transport.value.timer.startedAt!==null,true);
});

test('native null startup cache waits for publication without a lost bootstrap request or timeout',async t=>{
  const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage();await page.goto(origin+'/widget.html');
  const result=await page.evaluate(async()=>{
    const listeners={},requests=[],errors=[],busy=[],states=[],timeouts=[];
    const originalTimeout=window.setTimeout;window.setTimeout=(callback,delay,...args)=>delay===8000?(timeouts.push(callback),-timeouts.length):originalTimeout(callback,delay,...args);
    window.__TAURI__={event:{listen:async(name,fn)=>{listeners[name]=fn;}},core:{invoke:async(name,args)=>{if(name==='widget_snapshot')return null;if(name==='widget_preferences')return {};if(name==='widget_dispatch')requests.push(args);}}};
    const {createWidgetClient}=await import('./widget-bridge.mjs');await createWidgetClient({onState:s=>states.push(s),onError:e=>errors.push(e.message),onBusy:b=>busy.push(b)});
    const snapshot={ready:true,state:{timer:{startedAt:null,allocations:{},note:''},records:{},goal:120},revision:7,undo:null,error:null,controllerId:'startup',generation:1};
    listeners['comet-controller-state']({payload:snapshot});for(const callback of timeouts)callback();await Promise.resolve();
    return {requests,errors,busy,states};
  });
  assert.deepEqual(result.requests,[]);assert.deepEqual(result.errors,[]);assert.deepEqual(result.busy,[]);assert.equal(result.states.length,1);assert.equal(result.states[0].ready,true);
});

test('main input saves retain spaces between words while typing',async t=>{
  const {main,widget}=await fixture(t);
  await main.locator('#subject').fill('Linear ');
  await main.waitForFunction(key=>JSON.parse(localStorage.getItem(key)).timer.note.startsWith('Linear'),key);
  assert.equal(await main.locator('#subject').inputValue(),'Linear ');
  await main.locator('#subject').pressSequentially('algebra');
  await main.waitForFunction(key=>JSON.parse(localStorage.getItem(key)).timer.note==='Linear algebra',key);
  await widget.waitForFunction(()=>document.querySelector('#widget-subject').value==='Linear algebra');
});

 test('native captured moves with zero buttons still move the icon and suppress expansion',async t=>{
  const {widget,transport}=await nativeFixture(t);
  await widget.locator('#widget-collapse').click();
  await widget.locator('#widget-icon').waitFor({state:'visible'});
  await widget.evaluate(()=>{
    const icon=document.querySelector('#widget-icon');
    icon.dispatchEvent(new PointerEvent('pointerdown',{pointerId:1,button:0,buttons:0,screenX:100,screenY:100,bubbles:true}));
    icon.dispatchEvent(new PointerEvent('pointermove',{pointerId:1,button:0,buttons:0,screenX:125,screenY:115,bubbles:true}));
    icon.dispatchEvent(new PointerEvent('pointerup',{pointerId:1,button:0,buttons:0,screenX:125,screenY:115,bubbles:true}));
    icon.click();
  });
  await waitGeometry(()=>transport.dragEnds===1);
  assert.deepEqual(transport.position,[397,135]);
  assert.deepEqual(transport.collapses,[true]);
});
