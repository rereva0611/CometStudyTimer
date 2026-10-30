const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');

const frontend = path.resolve(__dirname, '../frontend');
const key = 'xueshi.study-log.v1';
let server, browser, origin;
before(async () => {
  server = http.createServer(async (req, res) => {
    const name = req.url === '/' ? 'index.html' : req.url.slice(1);
    if (!/^[a-z-]+\.(html|css|mjs|js)$/.test(name)) { res.writeHead(404).end(); return; }
    try {
      const data = await fs.readFile(path.join(frontend, name));
      res.setHeader('Content-Type', name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css' : 'text/javascript');
      res.end(data);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true});
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });

async function fixture(t, recordSeconds = 8319, preciseSession = false) {
  const context = await browser.newContext({viewport: {width: 1180, height: 860}});
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.addInitScript(({key, recordSeconds, preciseSession}) => {
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    d.setHours(9,0,3,125);const start=d.getTime();
    const sessions=preciseSession?[{id:'precise-timer',seconds:17,note:'Original',start,end:start+17000,source:'timer'}]:undefined;
    localStorage.setItem(key, JSON.stringify({version: 1, goal: 120, records: {[date]: {seconds: recordSeconds, note: 'Original',sessions}}, timer: {startedAt: null, allocations: {}, note: ''}}));
  }, {key, recordSeconds, preciseSession});
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('#heatmap .today'));
  return page;
}

async function editToday(page) {
  if(await page.locator('#day-dialog').isVisible())await page.locator('#day-dialog .close-dialog').click();
  await page.locator('#heatmap .today').click();
  await page.locator('#day-dialog .session-row').first().click();
}

test('cross-timezone editing and actual backup export/import retain clocks and Continue last identity',async t=>{
  const context=await browser.newContext({viewport:{width:1180,height:860},timezoneId:'America/Los_Angeles'});t.after(()=>context.close());
  await context.addInitScript(key=>{
    if(localStorage.getItem(key))return;
    const make=(id,note,hour)=>{const start=Date.parse(`2026-10-10T${hour}:00:00+08:00`);return {id,note,start,end:start+60000,seconds:60,source:'timer',utcOffsets:{start:480,end:480}};};
    const a=make('older','Earlier saved task','10'),b=make('latest','Last saved task','09');
    localStorage.setItem(key,JSON.stringify({version:1,goal:120,records:{'2026-10-10':{seconds:120,note:b.note,sessions:[a,b]}},timer:{startedAt:null,allocations:{},note:'',intervals:[]},lastTimerSessionId:'latest'}));
  },key);
  const page=await context.newPage();page.setDefaultTimeout(6000);await page.goto(origin);await page.locator('#heatmap .today').waitFor();
  const row=page.locator('#records-list .record-row').filter({hasText:'Last saved task'});
  assert.match(await row.innerText(),/09:00–09:01/);await row.click();
  assert.equal(await page.locator('#record-start').inputValue(),'09:00');
  await page.locator('#record-note').fill('Last saved task edited');await page.locator('#record-form [type=submit]').click();await page.locator('#record-dialog').waitFor({state:'hidden'});
  assert.equal(await page.locator('#continue-last').getAttribute('title'),'Last saved task edited');
  const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#export-button').click()]);
  const backup=JSON.parse(await fs.readFile(await download.path(),'utf8'));
  assert.equal(backup.version,1);assert.equal(backup.lastTimerSessionId,'latest');
  assert.deepEqual(backup.records['2026-10-10'].sessions[1].utcOffsets,{start:480,end:480});
  await page.evaluate(key=>localStorage.setItem(key,JSON.stringify({version:1,goal:120,records:{},timer:{startedAt:null,allocations:{},note:'',intervals:[]}})),key);
  await page.reload();await page.locator('#heatmap .today').waitFor();
  await page.locator('#import-file').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});
  await page.locator('#import-dialog').waitFor({state:'visible'});await page.locator('#confirm-import').click();await page.locator('#import-dialog').waitFor({state:'hidden'});
  assert.equal(await page.locator('#continue-last').getAttribute('title'),'Last saved task edited');
  assert.match(await page.locator('#records-list .record-row').filter({hasText:'Last saved task edited'}).innerText(),/09:00–09:01/);
});

test('Undo after manual entry restores an existing empty day and its original note',async t=>{
  const page=await fixture(t,0);await page.locator('#manual-button').click();
  await page.locator('#record-minutes').fill('20');await page.locator('#record-note').fill('Temporary entry');
  await page.locator('#record-form [type=submit]').click();await page.locator('#record-dialog').waitFor({state:'hidden'});
  await page.locator('#undo-button').click();
  const records=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).records,key),days=Object.values(records);
  assert.equal(days.length,1);assert.deepEqual(days[0],{seconds:0,note:'Original',sessions:[]});
});

test('Continue last is main-only, stable across layouts and starts a fresh timer from the saved timer task',async t=>{
  const page=await fixture(t,17,true);
  const button=page.locator('#continue-last');
  assert.equal(await button.isVisible(),true);
  assert.equal(await button.getAttribute('title'),'Original');
  await page.locator('#manual-button').click();
  await page.locator('#record-minutes').fill('20');
  await page.locator('#record-note').fill('Manual entry');
  await page.locator('#record-form [type=submit]').click();
  await page.locator('#record-dialog').waitFor({state:'hidden'});
  assert.equal(await button.getAttribute('title'),'Original');
  for(const width of [1180,760,601,360]){
    await page.setViewportSize({width,height:860});
    const fits=await page.locator('.timer-controls').evaluate(el=>{
      const card=el.closest('.timer-card').getBoundingClientRect();
      return [...el.querySelectorAll('button')].every(button=>{
        const r=button.getBoundingClientRect();return r.left>=card.left&&r.right<=card.right&&button.scrollWidth<=button.clientWidth;
      });
    });
    assert.equal(fits,true,`Timer controls must fit at ${width}px`);
  }
  await page.setViewportSize({width:1180,height:860});
  if(process.env.COMET_CONTINUE_PROOF)await page.locator('.timer-card').screenshot({path:process.env.COMET_CONTINUE_PROOF});
  const before=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).records,key);
  const bounds=await page.locator('#toggle-timer').boundingBox();
  await button.click();
  assert.equal(await page.locator('#subject').inputValue(),'Original');
  assert.equal(await page.locator('#timer-state').innerText(),'Running');
  assert.equal(await button.isVisible(),false);
  assert.deepEqual(await page.locator('#toggle-timer').boundingBox(),bounds);
  await page.waitForFunction(()=>document.querySelector('#timer-display').textContent!=='00:00:00');
  await page.locator('#toggle-timer').click();
  assert.equal(await page.locator('#timer-state').innerText(),'Paused');
  assert.equal(await button.isVisible(),false);
  await page.locator('#finish-timer').click();
  await page.waitForFunction(()=>document.querySelector('#timer-state').textContent==='Ready');
  assert.equal(await button.isVisible(),true);
  const saved=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),key);
  const date=Object.keys(before)[0];
  assert.deepEqual(saved.records[date].sessions.slice(0,2),before[date].sessions);
  assert.equal(saved.records[date].sessions.at(-1).note,'Original');
  assert.equal(saved.records[date].sessions.at(-1).source,'timer');
  await page.reload();await page.waitForFunction(()=>document.querySelector('#heatmap .today'));
  assert.equal(await button.isVisible(),true);
  const widget=await (await page.request.get(`${origin}/widget.html`)).text();
  assert.doesNotMatch(widget,/Continue last|continue-last/);
});

test('Continue last stays hidden without a named timer task',async t=>{
  const page=await fixture(t,3600);
  assert.equal(await page.locator('#continue-last').isVisible(),false);
  assert.equal(await page.locator('#subject').inputValue(),'');
});

test('precise same-minute timer keeps timestamps on note save and date move with Undo',async t=>{
  const page=await fixture(t,17,true);
  const saved=()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)).records,key);
  const before=await saved(),today=Object.keys(before)[0],original=before[today].sessions[0];
  await editToday(page);
  assert.equal(await page.locator('#record-start').inputValue(),'09:00');
  assert.equal(await page.locator('#record-end').inputValue(),'09:00');
  await page.locator('#record-note').fill('Brief review');
  await page.locator('#record-form [type=submit]').click();
  await page.locator('#record-dialog').waitFor({state:'hidden'});
  assert.deepEqual((await saved())[today].sessions[0],{...original,note:'Brief review'});
  await editToday(page);
  const relocation=await page.evaluate(({start,end})=>{
    const a=new Date(start),b=new Date(end);a.setDate(a.getDate()-1);b.setDate(b.getDate()-1);
    return {date:`${a.getFullYear()}-${String(a.getMonth()+1).padStart(2,'0')}-${String(a.getDate()).padStart(2,'0')}`,start:a.getTime(),end:b.getTime()};
  },original);
  await page.locator('#record-date').fill(relocation.date);await page.locator('#record-date').dispatchEvent('change');
  await page.locator('#record-form [type=submit]').click();
  await page.locator('#record-dialog').waitFor({state:'hidden'});
  const moved=await saved();assert.equal(moved[today],undefined);
  assert.deepEqual(moved[relocation.date].sessions[0],{...original,note:'Brief review',start:relocation.start,end:relocation.end});
  await page.locator('#undo-button').click();
  assert.deepEqual(await saved(),{[today]:{...before[today],note:'Brief review',sessions:[{...original,note:'Brief review'}]}});
});

test('sessions show their own times and subjects and edit without replacing the day', async t => {
  const page = await fixture(t, 3600);
  await page.locator('#heatmap .today').click();
  assert.equal(await page.locator('#day-dialog').isVisible(), true);
  assert.equal(await page.locator('#day-sessions .session-clock').count(), 0);
  assert.match(await page.locator('#day-sessions').innerText(), /Original/);
  await page.locator('#day-add-record').click();
  assert.equal(await page.locator('#mode-replace').count(), 0);
  await page.locator('#record-start').fill('09:00');
  await page.locator('#record-end').fill('10:30');
  await page.locator('#record-note').fill('Mathematics');
  assert.equal(await page.locator('#record-hours').inputValue(), '1');
  assert.equal(await page.locator('#record-minutes').inputValue(), '30');
  await page.locator('#record-form [type=submit]').click();
  await page.locator('#record-dialog').waitFor({state:'hidden'});
  await page.locator('#day-dialog').waitFor({state:'visible'});
  assert.equal(await page.locator('#day-dialog .session-row').count(), 2);
  const row = page.locator('#day-dialog .session-row').filter({hasText:'Mathematics'});
  assert.match(await row.innerText(), /09:00–10:30/);
  await row.click();
  await page.locator('#record-minutes').fill('15');
  await page.locator('#record-form [type=submit]').click();
  await page.locator('#record-dialog').waitFor({state:'hidden'});
  const saved = await page.evaluate(key => Object.values(JSON.parse(localStorage.getItem(key)).records)[0], key);
  assert.equal(saved.seconds, 8100);
  assert.equal(saved.sessions[0].note, 'Original');
  assert.equal(saved.sessions[1].note, 'Mathematics');
  assert.equal(saved.sessions[1].seconds, 4500);
  if(process.env.COMET_SESSION_PROOF) await page.screenshot({path:process.env.COMET_SESSION_PROOF});
  await page.locator('#undo-button').click({timeout:2500});
  assert.match(await page.locator('#day-sessions').innerText(), /1h 30min/);
});

test('missing timestamps omit the time line for legacy and manual sessions in both lists',async t=>{
  const page=await fixture(t,3600);
  await page.locator('#manual-button').click();
  await page.locator('#record-minutes').fill('20');
  await page.locator('#record-note').fill('Untimed reading');
  await page.locator('#record-form [type=submit]').click();
  await page.locator('#record-dialog').waitFor({state:'hidden'});
  await page.locator('#manual-button').click();
  await page.locator('#record-start').fill('09:00');
  await page.locator('#record-end').fill('09:10');
  await page.locator('#record-note').fill('Timed review');
  await page.locator('#record-form [type=submit]').click();
  await page.locator('#record-dialog').waitFor({state:'hidden'});
  const saved=()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)),key);
  const before=await saved(),record=Object.values(before.records)[0];
  assert.equal(record.seconds,5400);
  assert.deepEqual(record.sessions.filter(s=>s.start===null).map(s=>[s.note,s.seconds,s.end,s.source]),[
    ['Original',3600,null,'legacy'],['Untimed reading',1200,null,'manual']
  ]);
  assert.equal(await page.locator('#records-list .record-clock').count(),1);
  assert.equal(await page.locator('#records-list .record-clock').innerText(),'09:00–09:10');
  for(const note of ['Original','Untimed reading']){
    const row=page.locator('#records-list .record-row').filter({hasText:note});
    assert.equal(await row.locator('.record-clock').count(),0);
    assert.doesNotMatch(await row.innerText(),/Daily total|—/);
    assert.ok(await row.evaluate(el=>{
      const a=el.getBoundingClientRect(),b=el.querySelector('.record-note').getBoundingClientRect();
      return Math.abs(a.top+a.height/2-b.top-b.height/2)<1;
    }));
  }
  await page.locator('#heatmap .today').click();
  assert.equal(await page.locator('#day-sessions .session-clock').count(),1);
  assert.equal(await page.locator('#day-sessions .session-clock').innerText(),'09:00–09:10');
  for(const note of ['Original','Untimed reading']){
    const row=page.locator('#day-sessions .session-row').filter({hasText:note});
    assert.equal(await row.locator('.session-clock').count(),0);
    assert.doesNotMatch(await row.innerText(),/Daily total|—/);
    assert.ok(await row.evaluate(el=>{
      const a=el.getBoundingClientRect(),b=el.querySelector('.session-subject').getBoundingClientRect();
      return Math.abs(a.top+a.height/2-b.top-b.height/2)<1;
    }));
  }
  assert.deepEqual(await saved(),before);
  if(process.env.COMET_MISSING_TIME_PROOF)await page.locator('#day-dialog').screenshot({path:process.env.COMET_MISSING_TIME_PROOF});
});

test('manual clock range rejects incomplete, reversed and shorter-than-duration periods',async t=>{
  const page=await fixture(t);
  await page.locator('#manual-button').click();
  await page.locator('#record-minutes').fill('30');
  await page.locator('#record-start').fill('09:00');
  await page.locator('#record-form [type=submit]').click();
  assert.equal(await page.locator('#record-dialog').isVisible(),true);
  assert.equal(await page.locator('#record-error').innerText(),'Enter both start and end times.');
  await page.locator('#record-end').fill('08:00');
  await page.locator('#record-form [type=submit]').click();
  assert.match(await page.locator('#record-error').innerText(),/End must be after start/);
  await page.locator('#record-end').fill('09:10');
  await page.locator('#record-form [type=submit]').click();
  assert.equal(await page.locator('#record-error').innerText(),'Duration cannot exceed the time range.');
  await page.locator('#record-end').fill('09:30');
  await page.locator('#record-form [type=submit]').click();
  await page.locator('#record-dialog').waitFor({state:'hidden'});
});

test('two finished timers retain different subjects and actual time ranges',async t=>{
  const page=await fixture(t,0);
  for(const subject of ['Calculus','English']){
    await page.locator('#subject').fill(subject);
    await page.locator('#toggle-timer').click();
    await page.waitForFunction(()=>document.querySelector('#timer-display').textContent!=='00:00:00').catch(async error=>{
      const detail=await page.evaluate(key=>({timer:JSON.parse(localStorage.getItem(key)).timer,status:document.querySelector('#timer-state').textContent,message:document.querySelector('#toast-message').textContent}),key);
      throw new Error(`${error.message}; ${JSON.stringify(detail)}`);
    });
    await page.locator('#finish-timer').click();
    await page.waitForFunction(()=>document.querySelector('#timer-state').textContent==='Ready');
  }
  const record=await page.evaluate(key=>Object.values(JSON.parse(localStorage.getItem(key)).records)[0],key);
  assert.deepEqual(record.sessions.map(s=>s.note),['Calculus','English']);
  assert.ok(record.sessions.every(s=>s.start!==null&&s.end>s.start&&s.seconds>0));
  assert.equal(record.seconds,record.sessions.reduce((n,s)=>n+s.seconds,0));
});

test('a sub-minute subject edit remains a saved session',async t=>{
  const page=await fixture(t,17);
  await editToday(page);await page.locator('#record-note').fill('Brief review');
  await page.locator('#record-form [type=submit]').click();
  await page.locator('#record-dialog').waitFor({state:'hidden'});
  assert.equal(await page.locator('#toast-message').innerText(),'Saved');
  assert.equal(await page.evaluate(key=>Object.values(JSON.parse(localStorage.getItem(key)).records)[0].seconds,key),17);
});

test('moving one session and undoing preserves its times, subject and other sessions',async t=>{
  const page=await fixture(t);
  await page.locator('#manual-button').click();
  await page.locator('#record-start').fill('10:00');await page.locator('#record-end').fill('11:00');
  await page.locator('#record-note').fill('Reading');await page.locator('#record-form [type=submit]').click();
  await page.locator('#record-dialog').waitFor({state:'hidden'});
  const saved=()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)).records,key);
  const before=await saved();const current=Object.keys(before)[0];
  await page.locator('#records-list .record-row').first().click();
  const previous=await page.evaluate(()=>{const d=new Date();d.setDate(d.getDate()-1);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;});
  await page.locator('#record-date').fill(previous);await page.locator('#record-date').dispatchEvent('change');
  await page.locator('#record-form [type=submit]').click();await page.locator('#record-dialog').waitFor({state:'hidden'});
  const moved=await saved();assert.equal(moved[current].seconds,8319);assert.equal(moved[previous].sessions[0].note,'Reading');
  await page.locator('#undo-button').click();assert.deepEqual(await saved(),before);
});

test('rich backup import retains separate sessions and clock ranges',async t=>{
  const page=await fixture(t);
  const fixtureData=await page.evaluate(()=>{const d=new Date();const key=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;d.setHours(9,0,0,0);const start=d.getTime();return {version:1,goal:90,records:{[key]:{seconds:3600,note:'Physics',sessions:[{id:'imported-physics',seconds:3600,note:'Physics',start,end:start+3600000,source:'manual'}]}}};});
  await page.locator('#import-file').setInputFiles({name:'study.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixtureData))});
  await page.locator('#confirm-import').click();await page.locator('#import-dialog').waitFor({state:'hidden'});
  const saved=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),key);
  assert.deepEqual(saved.records,fixtureData.records);assert.equal(saved.goal,90);
  assert.match(await page.locator('#records-list').innerText(),/09:00–10:00/);
});

test('starting and pausing the timer leave the calendar in the same position', async t => {
  const page = await fixture(t);
  const y = () => page.locator('.heatmap-card').evaluate(el => el.getBoundingClientRect().top);
  const initial = await y();
  await page.locator('#toggle-timer').click();
  await page.waitForFunction(() => document.querySelector('#timer-state').textContent === 'Running');
  assert.equal(await y(), initial);
  await page.waitForFunction(() => document.querySelector('#timer-display').textContent !== '00:00:00');
  await page.locator('#toggle-timer').click();
  await page.waitForFunction(() => document.querySelector('#timer-state').textContent === 'Paused');
  assert.equal(await y(), initial);
});

test('day tooltip closes with the editor and only reappears on intentional inspection', async t => {
  const page = await fixture(t);
  const day = page.locator('#heatmap .today');
  await day.hover();
  await page.locator('#heat-tooltip').waitFor({state: 'visible'});
  await day.click();
  await page.locator('#day-dialog').waitFor({state: 'visible'});
  assert.equal(await page.locator('#heat-tooltip').isVisible(), false);
  await page.locator('#day-dialog .close-dialog').click();
  await page.waitForTimeout(400);
  assert.equal(await page.locator('#heat-tooltip').isVisible(), false, 'restored focus must not open tooltip');
  await page.mouse.move(0, 0);
  await day.hover();
  await page.locator('#heat-tooltip').waitFor({state: 'visible'});
  const text = await page.locator('#heat-tooltip').innerText();
  assert.match(text, /^\w{3} \d{1,2} · 2h 18min$/);
  assert.equal(text.includes('\n'), false);
  await page.mouse.move(0, 0);
  assert.equal(await page.locator('#heat-tooltip').isVisible(), false);
  await day.focus();
  await page.keyboard.press('ArrowLeft');
  await page.locator('#heat-tooltip').waitFor({state: 'visible'});
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#heat-tooltip').isVisible(), false);
});

test('minute-only entry preserves existing seconds on a note-only edit and adds whole minutes', async t => {
  const page = await fixture(t);
  await editToday(page);
  assert.equal(await page.locator('#record-seconds').count(), 0);
  await page.locator('#record-note').fill('Updated note');
  await page.locator('#record-form [type=submit]').click();
  await page.locator('#record-dialog').waitFor({state: 'hidden'});
  if(await page.locator('#day-dialog').isVisible())await page.locator('#day-dialog .close-dialog').click();
  const saved = () => page.evaluate(key => Object.values(JSON.parse(localStorage.getItem(key)).records)[0], key);
  assert.equal((await saved()).seconds,8319);assert.equal((await saved()).sessions[0].note,'Updated note');
  await page.locator('#manual-button').click();
  await page.locator('#record-hours').fill('0');
  await page.locator('#record-minutes').fill('1');
  await page.locator('#record-form [type=submit]').click();
  await page.locator('#record-dialog').waitFor({state: 'hidden'});
  if(await page.locator('#day-dialog').isVisible())await page.locator('#day-dialog .close-dialog').click();
  assert.equal((await saved()).seconds, 8379);
  await page.locator('#records-list .record-row').first().click();
  await page.locator('#record-hours').fill('1');
  await page.locator('#record-minutes').fill('5');
  await page.locator('#record-form [type=submit]').click();
  await page.locator('#record-dialog').waitFor({state: 'hidden'});
  if(await page.locator('#day-dialog').isVisible())await page.locator('#day-dialog .close-dialog').click();
  assert.equal((await saved()).seconds,12219);assert.equal((await saved()).sessions[1].seconds,3900);
});

test('statistics use hours and minutes, including meaningful sub-minute totals', async t => {
  const page = await fixture(t);
  assert.equal(await page.locator('#stat-total').innerText(), '2h 18min');
  assert.equal(await page.locator('#stat-week').innerText(), '2h 18min');
  assert.equal(await page.locator('#stat-days').innerText(), '1day');
  const short = await fixture(t, 17);
  assert.equal(await short.locator('#stat-total').innerText(), '<1min');
  assert.equal(await short.locator('#today-amount').textContent(), '<1min');
});

test('keyboard day inspection survives automatic calendar scrolling in a narrow window', async t => {
  const page = await fixture(t);
  await page.setViewportSize({width:700,height:860});
  await page.reload();
  await page.waitForSelector('#heatmap .today');
  await page.locator('#heatmap-scroll').focus();
  await page.keyboard.press('Tab');
  const scroll = () => page.locator('#heatmap-scroll').evaluate(el => el.scrollLeft);
  const initial = await scroll();
  assert.ok(initial > 0, 'current date begins in the scrolled portion of the year');
  for(let i=0;i<53&&(await scroll())===initial;i++) await page.keyboard.press('ArrowLeft');
  assert.ok(await scroll() < initial, 'arrow focus caused automatic horizontal scrolling');
  await page.waitForTimeout(80);
  assert.equal(await page.locator('#heat-tooltip').isVisible(), true);
  await page.mouse.wheel(0,300);
  await page.locator('#heat-tooltip').waitFor({state:'hidden'});
});

test('closing a pointer-opened day editor leaves no focus ring, while arrow navigation keeps one', async t => {
  const page = await fixture(t);
  const day = page.locator('#heatmap button.day:not(.today):not(:disabled)').first();
  await day.click();
  await page.locator('#day-dialog').waitFor({state:'visible'});
  await page.keyboard.press('Escape');
  await page.locator('#day-dialog').waitFor({state:'hidden'});
  await page.mouse.move(0,0);
  const outline = () => page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  assert.equal(await outline(), 'none', 'pointer-opened editor must not leave a persistent day outline');
  for(const key of ['Enter','Space']) {
    await page.keyboard.press(key);
    await page.locator('#day-dialog').waitFor({state:'visible'});
    await page.keyboard.press('Escape');
    await page.locator('#day-dialog').waitFor({state:'hidden'});
    assert.notEqual(await outline(), 'none', `${key} activation restores a keyboard focus indicator`);
    await day.click();
    await page.locator('#day-dialog .close-dialog').click();
    await page.locator('#day-dialog').waitFor({state:'hidden'});
    await page.mouse.move(0,0);
    assert.equal(await outline(), 'none', 'a subsequent pointer close removes the keyboard outline');
  }
  await page.keyboard.press('ArrowDown');
  await page.locator('#heat-tooltip').waitFor({state:'visible'});
  assert.notEqual(await outline(), 'none', 'keyboard navigation still has a visible focus indicator');
  await page.keyboard.press('Enter');
  await page.locator('#day-dialog').waitFor({state:'visible'});
  await page.keyboard.press('Escape');
  await page.locator('#day-dialog').waitFor({state:'hidden'});
  assert.notEqual(await outline(), 'none', 'keyboard-opened editor restores the keyboard focus indicator');
});


test('manual additions require an entered duration and accept either hours or minutes alone', async t => {
  const page = await fixture(t);
  const saved = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)).records, key);
  const original = await saved();
  for(const entry of ['#manual-button','#add-record']) {
    await page.locator(entry).click();
    assert.equal(await page.locator('#record-hours').inputValue(), '');
    assert.equal(await page.locator('#record-minutes').inputValue(), '');
    await page.locator('#record-form [type=submit]').click();
    assert.equal(await page.locator('#record-dialog').isVisible(), true);
    assert.deepEqual(await saved(), original);
    await page.locator('#record-dialog .close-dialog').click();
  }
  await page.locator('#manual-button').click();
  await page.locator('#record-minutes').fill('15');
  await page.locator('#record-form [type=submit]').click();
  await page.locator('#record-dialog').waitFor({state:'hidden'});
  if(await page.locator('#day-dialog').isVisible())await page.locator('#day-dialog .close-dialog').click();
  assert.equal(Object.values(await saved())[0].seconds, 9219);
  await page.locator('#add-record').click();
  await page.locator('#record-hours').fill('1');
  await page.locator('#record-form [type=submit]').click();
  await page.locator('#record-dialog').waitFor({state:'hidden'});
  if(await page.locator('#day-dialog').isVisible())await page.locator('#day-dialog .close-dialog').click();
  assert.equal(Object.values(await saved())[0].seconds, 12819);
  await editToday(page);
  assert.equal(await page.locator('#record-hours').inputValue(), '2');
  assert.equal(await page.locator('#record-minutes').inputValue(), '18');
  await page.locator('#record-note').fill('Note only');
  await page.locator('#record-form [type=submit]').click();
  await page.locator('#record-dialog').waitFor({state:'hidden'});
  if(await page.locator('#day-dialog').isVisible())await page.locator('#day-dialog .close-dialog').click();
  assert.equal(Object.values(await saved())[0].seconds, 12819);
});

test('undo is transient, restores exact edits, and delete can be undone',async t=>{
  const page=await fixture(t);
  const saved=()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)),key);
  assert.equal(await page.locator('#undo-button').isVisible(),false);
  await editToday(page);await page.locator('#record-note').fill('Changed');
  await page.locator('#record-form [type=submit]').click();await page.locator('#record-dialog').waitFor({state:'hidden'});
  if(await page.locator('#day-dialog').isVisible())await page.locator('#day-dialog .close-dialog').click();
  if(process.env.COMET_UI_PROOF)await page.screenshot({path:process.env.COMET_UI_PROOF});
  await page.locator('#undo-button').click();assert.equal(Object.values((await saved()).records)[0].sessions[0].seconds,8319);assert.equal(Object.values((await saved()).records)[0].sessions[0].note,'Original');
  assert.equal(await page.locator('#undo-button').isVisible(),false);
  await editToday(page);await page.locator('#delete-record').click();
  await page.locator('#record-dialog').waitFor({state:'hidden'});
  if(await page.locator('#day-dialog').isVisible())await page.locator('#day-dialog .close-dialog').click();assert.deepEqual((await saved()).records,{});
  await page.locator('#undo-button').click();assert.equal(Object.values((await saved()).records)[0].seconds,8319);
  await page.locator('#manual-button').click();await page.locator('#record-minutes').fill('1');
  await page.locator('#record-form [type=submit]').click();await page.locator('#record-dialog').waitFor({state:'hidden'});
  if(await page.locator('#day-dialog').isVisible())await page.locator('#day-dialog .close-dialog').click();
  assert.equal(await page.locator('#undo-button').isVisible(),true);
  await page.waitForTimeout(10300);assert.equal(await page.locator('#undo-button').isVisible(),false);
});

test('failed saves offer no undo and a failed undo can be retried',async t=>{
  const page=await fixture(t);
  await page.evaluate(()=>{const write=Storage.prototype.setItem;Storage.prototype.setItem=function(...args){if(window.failWrites)throw new Error('Disk full');return write.apply(this,args);};window.failWrites=true;});
  await editToday(page);await page.locator('#record-note').fill('Changed');
  await page.locator('#record-form [type=submit]').click();await page.waitForFunction(()=>document.querySelector('#record-error').textContent.includes('Disk full'));
  assert.equal(await page.locator('#undo-button').isVisible(),false);
  await page.evaluate(()=>window.failWrites=false);await page.locator('#record-form [type=submit]').click();
  await page.locator('#record-dialog').waitFor({state:'hidden'});
  if(await page.locator('#day-dialog').isVisible())await page.locator('#day-dialog .close-dialog').click();await page.evaluate(()=>window.failWrites=true);
  await page.locator('#undo-button').click();await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('Disk full'));
  assert.equal(await page.locator('#undo-button').isVisible(),true);
  await page.evaluate(()=>window.failWrites=false);await page.locator('#undo-button').click();
  assert.equal(await page.evaluate(key=>Object.values(JSON.parse(localStorage.getItem(key)).records)[0].note,key),'Original');
});

test('native recovery requires selection and replaces records and goal while keeping timer',async t=>{
  const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage();
  await page.addInitScript(()=>{
    const date=new Date().toLocaleDateString('en-CA');
    window.nativeState={version:1,goal:120,records:{[date]:{seconds:60,note:'Current'}},timer:{startedAt:null,allocations:{[date]:3000},note:'Keep'}};
    window.nativeRevision=0;
    window.events={};window.__TAURI__={event:{listen:async(name,fn)=>{window.events[name]=fn;return ()=>{};}},core:{invoke:async(name,args)=>{
      if(name==='load_state')return window.nativeState;
      if(name==='load_snapshot')return {value:window.nativeState,revision:window.nativeRevision};
      if(name==='save_state'){if(args.expectedRevision!==window.nativeRevision)throw new Error('COMET_STATE_CONFLICT');window.nativeState=args.value;return {value:window.nativeState,revision:++window.nativeRevision};}
      if(name==='controller_publish'){window.controllerState=args.snapshot;return;}
      if(name==='widget_controller_ready')return;
      if(name==='backup_status')return null;
      if(name==='show_backup_folder'){window.backupFolderOpened=true;return;}
      if(name==='list_auto_backups')return [{id:'auto-2026-01-01.json',kind:'daily',date:'2026-01-01',exportedAt:'2026-01-01T12:00:00Z',days:1,totalSeconds:7200},{id:'recovery-0000000000000000001-0000.json',kind:'recovery',date:'2026-01-01',exportedAt:'2026-01-01T12:01:00Z',days:1,totalSeconds:7200}];
      if(name==='restore_auto_backup'){window.nativeState={...window.nativeState,goal:180,records:{'2026-01-01':{seconds:7200,note:'Restored'}}};window.nativeRevision++;return window.nativeState;}
    }}};
  });
  await page.goto(origin);await page.waitForSelector('#heatmap .today');
  await page.evaluate(()=>window.events['comet-restore-backup']({}));await page.locator('#backup-dialog').waitFor({state:'visible'});
  assert.equal(await page.locator('#restore-backup').isDisabled(),true);
  assert.equal(await page.locator('#backup-dialog h2').innerText(),'Backups');
  assert.match(await page.locator('#backup-status').innerText(),/Last automatic backup/);
  await page.locator('#show-backup-folder').click();assert.equal(await page.evaluate(()=>window.backupFolderOpened),true);
  assert.match(await page.locator('#backup-list button').nth(1).innerText(),/Before restore/);
  await page.locator('#backup-list button').first().click();await page.locator('#restore-backup').click();
  await page.locator('#backup-dialog').waitFor({state:'hidden'});
  const saved=await page.evaluate(()=>window.nativeState);
  assert.equal(saved.goal,180);assert.deepEqual(saved.records,{'2026-01-01':{seconds:7200,note:'Restored'}});
  assert.equal(saved.timer.note,'Keep');assert.equal(await page.locator('#undo-button').isVisible(),false);
});

test('new-day undo removes its record and latest-only undo preserves a concurrent goal and timer',async t=>{
  const page=await fixture(t);
  const saved=()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)),key);
  const original=await saved();
  await page.locator('#heatmap button:not(:disabled)').first().click();await page.locator('#day-add-record').click();await page.locator('#record-minutes').fill('5');
  await page.locator('#record-form [type=submit]').click();await page.locator('#record-dialog').waitFor({state:'hidden'});
  if(await page.locator('#day-dialog').isVisible())await page.locator('#day-dialog .close-dialog').click();
  await page.locator('#undo-button').click();assert.equal(Object.keys((await saved()).records).length,1);assert.equal(Object.values((await saved()).records)[0].seconds,8319);
  for(const note of ['First','Second']){
    await editToday(page);await page.locator('#record-note').fill(note);
    await page.locator('#record-form [type=submit]').click();await page.locator('#record-dialog').waitFor({state:'hidden'});
  if(await page.locator('#day-dialog').isVisible())await page.locator('#day-dialog .close-dialog').click();
  }
  await page.locator('#goal-button').click();await page.locator('#goal-input').fill('180');await page.locator('#goal-form [type=submit]').click();
  await page.locator('#goal-dialog').waitFor({state:'hidden'});await page.locator('#toggle-timer').click();
  await page.waitForFunction(()=>document.querySelector('#timer-state').textContent==='Running');
  await page.locator('#undo-button').click();const result=await saved();
  assert.equal(Object.values(result.records)[0].note,'First');assert.equal(result.goal,180);assert.notEqual(result.timer.startedAt,null);
});
