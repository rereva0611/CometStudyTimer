// Classic head script: resolve appearance before the application's first paint.
(() => {
  'use strict';
  const key='comet.appearance.v1',root=document.documentElement;
  const native=window.__TAURI__?.core?.invoke;
  const normalize=value=>value==='github-dark'?'github-dark':'rose';
  let theme='rose',busy=false;
  function controls(){
    const button=document.getElementById('appearance-toggle');if(!button)return;
    const dark=theme==='github-dark',label=dark?'Switch to Rose':'Switch to GitHub Dark';
    button.title=label;button.setAttribute('aria-label',label);button.setAttribute('aria-pressed',String(dark));
    button.querySelector('use').setAttribute('href',dark?'#i-sun':'#i-moon');
    button.disabled=busy;
  }
  function apply(value){
    theme=normalize(value);root.dataset.theme=theme;root.style.colorScheme=theme==='github-dark'?'dark':'light';
    const meta=document.querySelector('meta[name="theme-color"]');if(meta)meta.content=theme==='github-dark'?'#0d1117':'#fffcf9';
    const favicon=document.querySelector('link[rel="icon"]');
    if(favicon){const dark=theme==='github-dark';favicon.href='data:image/svg+xml,'+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><rect width="36" height="36" rx="8" fill="${dark?'#161b22':'#fffcf9'}"/><path d="M4 14l10 10M10 5l12 12M7 8l12 12" stroke="${dark?'#7ee787':'#dcaebc'}" stroke-width="2.4"/><path d="m25 17 2.1 5.9L33 25l-5.9 2.1L25 33l-2.1-5.9L17 25l5.9-2.1Z" fill="${dark?'#3fb950':'#b88778'}"/></svg>`);}
    controls();
  }
  function error(value){
    const text=value?.message||String(value);window.cometAppearance.error=text;
    window.dispatchEvent(new CustomEvent('comet-appearance-error',{detail:text}));
  }
  async function toggle(){
    if(busy)return;
    busy=true;controls();
    try{
      if(native){const value=await native('widget_toggle_theme');apply(value.theme);}
      else{const next=theme==='rose'?'github-dark':'rose';localStorage.setItem(key,next);apply(next);}
    }catch(value){error(value);}
    finally{busy=false;controls();}
  }
  window.cometAppearance={toggle,error:null,ready:null};
  if(native){
    root.style.visibility='hidden';
    window.cometAppearance.ready=(async()=>{
      let updates=0;
      await window.__TAURI__.event.listen('comet-widget-preferences',event=>{updates++;apply(event.payload?.theme);});
      const readingVersion=updates,value=await native('widget_preferences');
      if(updates===readingVersion)apply(value?.theme);
    })().catch(value=>{if(!root.dataset.theme)apply('rose');error(value);}).finally(()=>{root.style.visibility='';});
  }else{
    try{apply(localStorage.getItem(key));}catch(value){apply('rose');error(value);}
    window.addEventListener('storage',event=>{if(event.key===key||event.key===null)apply(event.newValue);});
    window.cometAppearance.ready=Promise.resolve();
  }
  document.addEventListener('DOMContentLoaded',()=>{
    controls();document.getElementById('appearance-toggle')?.addEventListener('click',toggle);
  });
})();
