const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const {chromium}=require('playwright');
const frontend=path.resolve(__dirname,'../frontend'),storageKey='xueshi.study-log.v1';
let server,browser,origin;
before(async()=>{
  server=http.createServer(async(req,res)=>{
    const name=req.url==='/'?'index.html':req.url.slice(1);
    if(!/^[a-z-]+\.(html|css|mjs|js)$/.test(name)){res.writeHead(404).end();return;}
    try{res.setHeader('Content-Type',name.endsWith('.html')?'text/html':name.endsWith('.css')?'text/css':'text/javascript');res.end(await fs.readFile(path.join(frontend,name)));}
    catch{res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
async function fixture(t,count=13,width=1180,customRecords=null){
  const context=await browser.newContext({viewport:{width,height:860}});t.after(()=>context.close());
  const page=await context.newPage();page.setDefaultTimeout(4000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));t.after(()=>assert.deepEqual(errors,[]));
  await page.addInitScript(({storageKey,count,customRecords})=>{
    const date=new Date(),day=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
    date.setHours(8,0,0,0);const base=date.getTime();
    const sessions=Array.from({length:count},(_,i)=>({id:`session-${i+1}`,seconds:60,note:`Session ${i+1}`,start:base+i*60000,end:base+(i+1)*60000,source:'manual'}));
    localStorage.setItem(storageKey,JSON.stringify({version:1,goal:120,records:customRecords||(count?{[day]:{seconds:count*60,note:sessions.at(-1).note,sessions}}:{}),timer:{startedAt:null,allocations:{},note:''}}));
  },{storageKey,count,customRecords});
  await page.goto(origin);await page.waitForFunction(()=>document.querySelector('#heatmap .today'));
  return page;
}
const notes=page=>page.locator('#records-list .record-note').allTextContents();
async function editFirst(page,note){
  await page.locator('#records-list .record-row').first().click();
  await page.locator('#record-note').fill(note);
  await page.locator('#record-form [type=submit]').click();await page.locator('#record-dialog').waitFor({state:'hidden'});
}
test('history pages expose every session in order without changing list height or scroll',async t=>{
  const page=await fixture(t);
  assert.equal(await page.locator('#records-heading').textContent(),'Study history');
  assert.deepEqual(await notes(page),['Session 13','Session 12','Session 11','Session 10','Session 9']);
  if(process.env.COMET_HISTORY_SCREENSHOT)await page.locator('.records-card').screenshot({path:process.env.COMET_HISTORY_SCREENSHOT});
  await page.locator('#history-pagination').scrollIntoViewIfNeeded();
  const geometry=()=>page.evaluate(()=>({scroll:scrollY,height:document.getElementById('records-list').getBoundingClientRect().height}));
  const initial=await geometry();
  assert.equal(await page.locator('#history-range').textContent(),'1–5 of 13');
  assert.equal(await page.locator('#history-previous').isDisabled(),true);
  await page.locator('#history-next').click();
  assert.deepEqual(await notes(page),['Session 8','Session 7','Session 6','Session 5','Session 4']);
  assert.equal(await page.locator('#history-page').textContent(),'2 / 3');
  await page.locator('#history-next').click();
  assert.deepEqual(await notes(page),['Session 3','Session 2','Session 1']);
  assert.equal(await page.locator('#history-range').textContent(),'11–13 of 13');
  assert.equal(await page.locator('#history-next').isDisabled(),true);
  assert.deepEqual(await geometry(),initial);
  await page.locator('#history-previous').click();assert.equal(await page.locator('#history-page').textContent(),'2 / 3');
});
test('pagination is hidden for zero through five sessions',async t=>{
  for(const count of [0,1,5]){
    const page=await fixture(t,count);
    assert.equal(await page.locator('#history-pagination').count(),1);
    assert.equal(await page.locator('#history-pagination').isVisible(),false);
    assert.equal(await page.locator('#records-list .record-row').count(),count);
  }
});
test('editing keeps the page, deleting fills it, and an empty last page clamps',async t=>{
  const page=await fixture(t,11);await page.locator('#history-next').click();
  await editFirst(page,'Edited subject');
  assert.equal(await page.locator('#history-page').textContent(),'2 / 3');
  assert.equal((await notes(page))[0],'Edited subject');
  await page.locator('#records-list .record-row').first().click();await page.locator('#delete-record').click();
  await page.locator('#record-dialog').waitFor({state:'hidden'});
  assert.deepEqual(await notes(page),['Session 5','Session 4','Session 3','Session 2','Session 1']);
  assert.equal(await page.locator('#history-page').textContent(),'2 / 2');
  const last=await fixture(t,6);await last.locator('#history-next').click();
  await last.locator('#records-list .record-row').click();await last.locator('#delete-record').click();
  await last.locator('#record-dialog').waitFor({state:'hidden'});
  assert.deepEqual(await notes(last),['Session 6','Session 5','Session 4','Session 3','Session 2']);
  assert.equal(await last.locator('#history-pagination').isVisible(),false);
});
test('a new saved record returns to page one; unrelated goal edits do not',async t=>{
  const page=await fixture(t);await page.locator('#history-next').click();
  await page.locator('#add-record').click();await page.locator('#record-minutes').fill('10');await page.locator('#record-note').fill('New session');
  await page.locator('#record-form [type=submit]').click();await page.locator('#record-dialog').waitFor({state:'hidden'});
  assert.equal(await page.locator('#history-page').textContent(),'1 / 3');
  assert.equal(await page.locator('#history-range').textContent(),'1–5 of 14');
  await page.locator('#history-next').click();
  await page.evaluate(key=>{const value=JSON.parse(localStorage.getItem(key));value.goal=180;localStorage.setItem(key,JSON.stringify(value));dispatchEvent(new StorageEvent('storage',{key}));},storageKey);
  await page.waitForTimeout(100);assert.equal(await page.locator('#history-page').textContent(),'2 / 3');
});
test('long subjects stay on one line on a narrow screen and remain fully editable',async t=>{
  const page=await fixture(t,6,390),subject='A long study subject '.repeat(5).trim();
  await editFirst(page,subject);
  assert.equal((await notes(page))[0],subject);
  assert.equal(await page.locator('#records-list .record-note').first().evaluate(el=>getComputedStyle(el).whiteSpace),'nowrap');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.locator('#records-list .record-row').first().click();assert.equal(await page.locator('#record-note').inputValue(),subject);
});

function multiMonthRecords(){
  const now=new Date(),year=now.getFullYear(),month=now.getMonth();
  const key=date=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  const dates={today:key(now),later:key(new Date(year,month-1,10)),earlier:key(new Date(year,month-1,3)),older:key(new Date(year,month-2,28)),oldest:key(new Date(year-1,5,1))};
  const records={};
  for(const [name,date,hours,seconds] of [
    ['today',dates.today,[9],600],['later',dates.later,[11,9],1200],
    ['earlier',dates.earlier,[11,9,12,8,14,10],600],['older',dates.older,[9],1800],['oldest',dates.oldest,[9],2400]
  ]){
    const sessions=hours.map((hour,i)=>{const d=new Date(`${date}T00:00:00`);d.setHours(hour);return {id:`${name}-${i}`,seconds,note:`${name} ${i}`,start:d.getTime(),end:d.getTime()+seconds*1000,source:'manual'};});
    records[date]={seconds:seconds*sessions.length,note:sessions.at(-1).note,sessions};
  }
  return {records,dates,month:dates.later.slice(0,7)};
}
test('month selection filters five-row pages, resets page, and summarizes the whole scope',async t=>{
  const data=multiMonthRecords(),page=await fixture(t,0,1180,data.records);
  assert.equal(await page.locator('#history-month').inputValue(),'');
  assert.equal(await page.locator('#history-summary').textContent(),'3h · 11 sessions');
  const total=await page.locator('#stat-total').textContent();
  await page.locator('#history-next').click();await page.locator('#history-next').click();
  await page.locator('#history-month').selectOption(data.month);
  assert.equal(await page.locator('#history-page').textContent(),'1 / 2');
  assert.equal(await page.locator('#history-range').textContent(),'1–5 of 8');
  assert.equal(await page.locator('#history-summary').textContent(),'1h 40min · 8 sessions');
  assert.equal(await page.locator('#stat-total').textContent(),total);
  assert.equal(await page.locator('#records-list .record-row').count(),5);
  await page.locator('#history-next').click();
  assert.equal(await page.locator('#history-range').textContent(),'6–8 of 8');
  assert.equal(await page.locator('#history-summary').textContent(),'1h 40min · 8 sessions');
  if(process.env.COMET_MONTH_SCREENSHOT)await page.locator('.records-card').screenshot({path:process.env.COMET_MONTH_SCREENSHOT});
  await page.locator('#history-month').selectOption(data.dates.today.slice(0,7));
  assert.equal(await page.locator('#history-summary').textContent(),'10min · 1 session');
  assert.equal(await page.locator('#history-pagination').isVisible(),false);
  await page.locator('#history-month').selectOption('');
  assert.equal(await page.locator('#history-page').textContent(),'1 / 3');
  assert.equal(await page.locator('#history-summary').textContent(),'3h · 11 sessions');
});
test('filtered edits retain month and page, moving out updates totals, and empty scope is retained',async t=>{
  const data=multiMonthRecords(),page=await fixture(t,0,390,data.records);
  await page.locator('#history-month').selectOption(data.month);await page.locator('#history-next').click();
  await editFirst(page,'Updated content');
  assert.equal(await page.locator('#history-month').inputValue(),data.month);
  assert.equal(await page.locator('#history-page').textContent(),'2 / 2');
  await page.locator('#records-list .record-row').first().click();
  await page.locator('#record-date').fill(data.dates.today);await page.locator('#record-date').dispatchEvent('change');
  await page.locator('#record-form [type=submit]').click();await page.locator('#record-dialog').waitFor({state:'hidden'});
  assert.equal(await page.locator('#history-month').inputValue(),data.month);
  assert.equal(await page.locator('#history-page').textContent(),'2 / 2');
  assert.equal(await page.locator('#history-summary').textContent(),'1h 30min · 7 sessions');
  await page.locator('#history-month').selectOption(data.dates.oldest.slice(0,7));
  await page.locator('#records-list .record-row').click();await page.locator('#delete-record').click();
  await page.locator('#record-dialog').waitFor({state:'hidden'});
  assert.equal(await page.locator('#history-month').inputValue(),data.dates.oldest.slice(0,7));
  assert.equal(await page.locator('#history-summary').textContent(),'0min · 0 sessions');
  assert.equal(await page.locator('#history-pagination').isVisible(),false);
  assert.match(await page.locator('#records-list').textContent(),/No records yet/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  if(process.env.COMET_MONTH_NARROW_SCREENSHOT)await page.locator('.records-card').screenshot({path:process.env.COMET_MONTH_NARROW_SCREENSHOT});
});
test('day arrows skip empty dates across months and years and editing returns to the selected day',async t=>{
  const data=multiMonthRecords(),page=await fixture(t,0,1180,data.records);
  await page.locator('#history-month').selectOption(data.dates.oldest.slice(0,7));
  await page.locator('#heatmap .today').click();
  assert.equal(await page.locator('#day-next').isDisabled(),true);
  await page.locator('#day-previous').click();
  const title=date=>new Date(`${date}T00:00:00`).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
  assert.equal(await page.locator('#day-title').textContent(),title(data.dates.later));
  assert.deepEqual(await page.locator('#day-sessions .session-subject').allTextContents(),['later 1','later 0']);
  await page.locator('#day-previous').click();
  assert.equal(await page.locator('#day-title').textContent(),title(data.dates.earlier));
  assert.deepEqual(await page.locator('#day-sessions .session-subject').allTextContents(),['earlier 3','earlier 1','earlier 5','earlier 0','earlier 2','earlier 4']);
  await page.locator('#day-sessions .session-row').first().click();
  await page.locator('#record-note').fill('Day edit');await page.locator('#record-form [type=submit]').click();
  await page.locator('#record-dialog').waitFor({state:'hidden'});await page.locator('#day-dialog').waitFor({state:'visible'});
  assert.equal(await page.locator('#day-title').textContent(),title(data.dates.earlier));
  await page.locator('#day-previous').click();assert.equal(await page.locator('#day-title').textContent(),title(data.dates.older));
  await page.locator('#day-previous').click();assert.equal(await page.locator('#day-title').textContent(),title(data.dates.oldest));
  assert.equal(await page.locator('#day-previous').isDisabled(),true);
  await page.locator('#day-next').click();assert.equal(await page.locator('#day-title').textContent(),title(data.dates.older));
  if(process.env.COMET_DAY_SCREENSHOT)await page.locator('#day-dialog').screenshot({path:process.env.COMET_DAY_SCREENSHOT});
});
