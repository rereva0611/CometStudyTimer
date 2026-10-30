const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'../frontend'),studyKey='xueshi.study-log.v1',themeKey='comet.appearance.v1';
let browser,server,origin;
before(async()=>{
  server=http.createServer(async(req,res)=>{
    const name=req.url==='/'?'index.html':req.url.split('?')[0].slice(1);
    if(name==='bootstrap.html'){res.setHeader('Content-Type','text/html');return res.end('<!doctype html><html><head><script src="./appearance.js"></script><link rel="stylesheet" href="./appearance.css"></head><body>Comet</body></html>');}
    if(!/^[a-z-]+\.(html|css|mjs|js)$/.test(name))return res.writeHead(404).end();
    try{const data=await fs.readFile(path.join(root,name));res.setHeader('Content-Type',name.endsWith('.html')?'text/html':name.endsWith('.css')?'text/css':'text/javascript');res.end(data);}catch{res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
async function fixture(t,{theme,viewport={width:1180,height:860}}={}){
  const context=await browser.newContext({viewport});t.after(()=>context.close());
  await context.addInitScript(({studyKey,themeKey,theme})=>{
    if(!localStorage.getItem(studyKey)){
      const d=new Date(),key=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      localStorage.setItem(studyKey,JSON.stringify({version:1,goal:120,records:{[key]:{seconds:3600,note:'Learning',sessions:[{id:'study-1',seconds:3600,note:'Learning',start:null,end:null,source:'manual'}]}},timer:{startedAt:null,allocations:{},note:'',intervals:[]}}));
      if(theme)localStorage.setItem(themeKey,theme);
    }
  },{studyKey,themeKey,theme});
  const main=await context.newPage();main.setDefaultTimeout(6000);await main.goto(origin);await main.locator('#heatmap .today').waitFor();
  const widget=await context.newPage();widget.setDefaultTimeout(6000);await widget.setViewportSize({width:320,height:300});await widget.goto(origin+'/widget.html');await widget.locator('#widget-start:not(:disabled)').waitFor();
  const errors=[];for(const p of [main,widget])p.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
  return {main,widget,context};
}
test('one icon toggles the complete main and widget appearance without changing study data',async t=>{
  const {main,widget}=await fixture(t);
  assert.equal(await main.locator('#appearance-toggle').count(),1,'one appearance icon belongs in the main header');
  const original=await main.evaluate(key=>localStorage.getItem(key),studyKey);
  await main.getByRole('button',{name:'Switch to GitHub Dark',exact:true}).click();
  await widget.waitForFunction(()=>document.documentElement.dataset.theme==='github-dark');
  assert.equal(await main.locator('dialog[open]').count(),0);
  assert.equal(await main.locator('#appearance-toggle span').count(),0);
  assert.equal(await widget.locator('#appearance-toggle').count(),0);
  assert.equal(await main.evaluate(()=>getComputedStyle(document.body).backgroundColor),'rgb(13, 17, 23)');
  assert.equal(await widget.locator('#widget-card').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(22, 27, 34)');
  assert.equal(await main.locator('#appearance-toggle use').getAttribute('href'),'#i-sun');
  const mainColors=await main.locator('.legend i').evaluateAll(els=>els.map(el=>getComputedStyle(el).backgroundColor));
  const widgetColors=await widget.evaluate(()=>Array.from({length:7},(_,level)=>{const el=document.createElement('button');el.className=`level-${level}`;document.querySelector('#widget-heatmap').append(el);const color=getComputedStyle(el).backgroundColor;el.remove();return color;}));
  assert.deepEqual(mainColors,widgetColors);assert.equal(new Set(mainColors).size,7);
  if(process.env.COMET_APPEARANCE_SCREENSHOTS){const dir=process.env.COMET_APPEARANCE_SCREENSHOTS;await main.screenshot({path:path.join(dir,'dark-main.png'),fullPage:true});await widget.screenshot({path:path.join(dir,'dark-widget.png')});}
  await main.locator('#goal-button').click();assert.equal(await main.locator('#goal-dialog').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(22, 27, 34)');
  if(process.env.COMET_APPEARANCE_SCREENSHOTS)await main.screenshot({path:path.join(process.env.COMET_APPEARANCE_SCREENSHOTS,'dark-dialog.png')});
  assert.equal(await main.locator('#goal-input').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(13, 17, 23)');
  await main.locator('#goal-dialog .close-dialog').click();
  await widget.locator('#widget-collapse').click();await widget.locator('#widget-icon').waitFor({state:'visible'});
  assert.equal(await widget.locator('#widget-icon').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(22, 27, 34)');
  if(process.env.COMET_APPEARANCE_SCREENSHOTS)await widget.screenshot({path:path.join(process.env.COMET_APPEARANCE_SCREENSHOTS,'dark-collapsed.png')});
  await main.reload();await main.getByRole('button',{name:'Switch to Rose',exact:true}).waitFor();
  await main.getByRole('button',{name:'Switch to Rose',exact:true}).click();await widget.waitForFunction(()=>document.documentElement.dataset.theme==='rose');
  assert.equal(await main.evaluate(()=>getComputedStyle(document.body).backgroundColor),'rgb(255, 252, 249)');
  assert.equal(await main.evaluate(key=>localStorage.getItem(key),studyKey),original);
});
test('failed appearance persistence leaves the visible theme and study state unchanged',async t=>{
  const {main,widget}=await fixture(t);const original=await main.evaluate(key=>localStorage.getItem(key),studyKey);
  await main.evaluate(themeKey=>{const save=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key===themeKey)throw Error('Appearance could not be saved.');return save.call(this,key,value);};},themeKey);
  await main.getByRole('button',{name:'Switch to GitHub Dark',exact:true}).click();
  await main.locator('#toast-message').filter({hasText:'Appearance could not be saved.'}).waitFor();
  assert.equal(await main.locator('html').getAttribute('data-theme'),'rose');assert.equal(await widget.locator('html').getAttribute('data-theme'),'rose');
  assert.equal(await main.evaluate(key=>localStorage.getItem(key),studyKey),original);
});
test('dark appearance survives reopening and remains usable in a narrow main window',async t=>{
  const {main,widget}=await fixture(t,{theme:'github-dark',viewport:{width:360,height:800}});
  await main.getByRole('button',{name:'Switch to Rose',exact:true}).waitFor();
  assert.equal(await widget.locator('html').getAttribute('data-theme'),'github-dark');
  assert.equal(await main.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  if(process.env.COMET_APPEARANCE_SCREENSHOTS)await main.screenshot({path:path.join(process.env.COMET_APPEARANCE_SCREENSHOTS,'dark-narrow.png'),fullPage:true});
  await main.locator('#appearance-toggle').focus();await main.keyboard.press('Enter');await main.waitForFunction(()=>document.documentElement.dataset.theme==='rose');
});
test('native bootstrap waits for the saved theme before revealing content',async t=>{
  const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage();
  await page.addInitScript(()=>{window.__TAURI__={event:{listen:async()=>()=>{}},core:{invoke:async name=>{if(name!=='widget_preferences')throw Error(name);return new Promise(resolve=>window.finishAppearance=()=>resolve({theme:'github-dark'}));}}};});
  await page.goto(origin+'/bootstrap.html');await page.waitForFunction(()=>typeof window.finishAppearance==='function');
  assert.equal(await page.locator('html').evaluate(el=>getComputedStyle(el).visibility),'hidden');
  await page.evaluate(()=>window.finishAppearance());await page.waitForFunction(()=>document.documentElement.dataset.theme==='github-dark');
  assert.equal(await page.locator('html').evaluate(el=>getComputedStyle(el).visibility),'visible');
});
test('native toggles serialize clicks, use saved preferences and retain theme on failure',async t=>{
  const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage();
  await page.addInitScript(()=>{
    window.toggleCalls=0;window.themeListener=null;
    window.__TAURI__={event:{listen:async(name,fn)=>{window.themeListener=fn;return ()=>{};}},core:{invoke:async name=>{
      if(name==='widget_preferences')return {theme:'github-dark'};
      if(name==='widget_toggle_theme'){window.toggleCalls++;return new Promise((resolve,reject)=>{window.finishToggle=()=>{window.themeListener({payload:{theme:'rose'}});resolve({theme:'rose'});};window.rejectToggle=()=>reject(Error('Preference disk full'));});}
      throw Error(name);
    }}};
  });
  await page.goto(origin+'/bootstrap.html');await page.waitForFunction(()=>document.documentElement.dataset.theme==='github-dark');
  await page.evaluate(()=>{window.cometAppearance.toggle();window.cometAppearance.toggle();});
  assert.equal(await page.evaluate(()=>window.toggleCalls),1);
  assert.equal(await page.locator('html').getAttribute('data-theme'),'github-dark');
  await page.evaluate(()=>window.finishToggle());await page.waitForFunction(()=>document.documentElement.dataset.theme==='rose');
  await page.evaluate(()=>{void window.cometAppearance.toggle();});
  await page.evaluate(()=>window.rejectToggle());await page.waitForFunction(()=>window.cometAppearance.error==='Preference disk full');
  assert.equal(await page.locator('html').getAttribute('data-theme'),'rose');
});
test('late startup preference replies cannot replace a newer native theme event',async t=>{
  const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage();
  await page.addInitScript(()=>{
    window.__TAURI__={event:{listen:async(name,fn)=>{window.receiveAppearance=fn;return ()=>{};}},core:{invoke:async name=>{
      if(name!=='widget_preferences')throw Error(name);
      return new Promise(resolve=>window.finishAppearance=()=>resolve({theme:'rose'}));
    }}};
  });
  await page.goto(origin+'/bootstrap.html');await page.waitForFunction(()=>typeof window.finishAppearance==='function');
  await page.evaluate(()=>{window.receiveAppearance({payload:{theme:'github-dark'}});window.finishAppearance();});
  await page.evaluate(()=>window.cometAppearance.ready);
  assert.equal(await page.locator('html').getAttribute('data-theme'),'github-dark');
  assert.equal(await page.locator('html').evaluate(el=>getComputedStyle(el).visibility),'visible');
});
