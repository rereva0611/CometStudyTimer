// Hover resizing shares the widget's drag/collapse queue. Native moves can
// generate a synthetic leave, so verify actual hover after the new frame lands.
export function createWidgetPreview({element,collapsed,isDragging,resize,enqueue,onError}) {
  let expanded=false,timer=null,intent=0,resizing=false,nativeInside=null;
  const cancel=()=>{intent++;clearTimeout(timer);timer=null;};
  function accept(value){
    expanded=!!value?.expanded&&collapsed();
    if(value?.direction==='left'||value?.direction==='right')element.dataset.direction=value.direction;
    else if(!element.dataset.direction)element.dataset.direction='right';
    const visible=expanded&&!isDragging();
    // Keep a left preview's icon at x=128 until native drag startup restores
    // its window origin. The clock can hide without moving the icon early.
    const anchored=expanded&&isDragging()&&element.dataset.direction==='left';
    element.dataset.preview=String(visible||anchored);
    element.querySelector('[role="timer"]').hidden=!visible;
  }
  function request(value,delay=0){
    cancel();const token=intent;
    if(!value&&!expanded&&!resizing)return;
    timer=setTimeout(()=>{
      timer=null;
      void enqueue(async()=>{
        if(token!==intent||value&&(!collapsed()||isDragging()))return;
        resizing=true;
        try{accept(await resize(value));}finally{resizing=false;}
        if(expanded)requestAnimationFrame(()=>{
          if(expanded&&!(nativeInside??element.matches(':hover'))&&!isDragging())request(false,120);
        });
      }).catch(onError);
    },delay);
  }
  const enter=()=>{if(!isDragging()&&collapsed())request(true,150);};
  const leave=()=>{if(!resizing)request(false,120);};
  element.addEventListener('pointerenter',()=>{if(nativeInside===null)enter();});
  element.addEventListener('pointerleave',()=>{if(nativeInside===null)leave();});
  return {
    accept,
    hover(inside){nativeInside=inside;if(inside)enter();else leave();},
    blur(){if(nativeInside!==true)request(false);},
    isExpanded:()=>expanded,
    cancelOpen:cancel,
    suspend(){cancel();accept({expanded});},
    close(){request(false);},
    update(){if(!collapsed()){cancel();accept({expanded:false});}}
  };
}
