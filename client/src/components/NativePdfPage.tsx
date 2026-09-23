import {forwardRef,useEffect,useRef,useState,useImperativeHandle,type CSSProperties} from "react";
import {acquirePdf,withPdfRenderSlot} from "@/lib/native-pdf";
import type {RenderTask,PDFPageProxy} from "pdfjs-dist";

type Props={documentId:string;page:number;width:number;height:number;
  pixelBudget?:number;priority?:number;className?:string;style?:CSSProperties;
  onReady?:()=>void};
// No canvas or rendered image is written to disk. Unmount cancels work and
// zeros the backing buffer; overscan is the only rendered-page cache.
export const NativePdfPage=forwardRef<HTMLCanvasElement,Props>(function NativePdfPage(
  {documentId,page,width,height,pixelBudget=4_000_000,priority=0,className,style,onReady},ref){
  const canvas=useRef<HTMLCanvasElement>(null);
  const ready=useRef(onReady);ready.current=onReady;
  const [state,setState]=useState("loading");
  const [attempt,setAttempt]=useState(0);
  // Ignore raw overscan-budget changes when the actual allocation is identical.
  // 0.1 recreated every mounted canvas as the window changed from e.g. 5 to 6 pages.
  const effectiveBudget=Math.min(4_000_000,pixelBudget);
  const [showLoading,setShowLoading]=useState(false);
  useEffect(()=>{
    setShowLoading(false);
    if(state!=="loading")return;
    const timer=setTimeout(()=>setShowLoading(true),250);
    return ()=>clearTimeout(timer);
  },[state,documentId,page,attempt]);
  useImperativeHandle(ref,()=>canvas.current!,[documentId,page,width,height,effectiveBudget,attempt]);
  useEffect(()=>{
    const el=canvas.current!;
    const abort=new AbortController();
    const lease=acquirePdf(documentId);
    let render:RenderTask|undefined,pdfPage:PDFPageProxy|undefined;
    el.dataset.renderStarts=String(Number(el.dataset.renderStarts||0)+1);
    setState("loading");
    let timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;abort.abort();render?.cancel();setState("Page rendering timed out. Retry this page.");},45000);
    void withPdfRenderSlot(abort.signal,priority,async()=>{
      const pdf=await lease.promise;
      if(abort.signal.aborted)return;
      pdfPage=await pdf.getPage(page);
      if(abort.signal.aborted)return;
      const base=pdfPage.getViewport({scale:1});
      const targetScale=Math.max(width/base.width,height/base.height)*Math.min(2,devicePixelRatio||1);
      const maxScale=Math.sqrt(effectiveBudget/(base.width*base.height));
      const view=pdfPage.getViewport({scale:Math.min(targetScale,maxScale)});
      el.width=Math.max(1,Math.floor(view.width));el.height=Math.max(1,Math.floor(view.height));
      render=pdfPage.render({canvas:el,viewport:view,background:"rgb(255,255,255)"});
      await render.promise;
      if(!abort.signal.aborted){setState("ready");ready.current?.();}
    }).catch(e=>{
      if(!abort.signal.aborted)setState(e?.name==="PasswordException"
        ?"This PDF requires an opening password. Use Open original PDF; password entry is not supported in this version."
        :`Could not render page ${page}. ${e?.message || "Please retry."}`);
    }).finally(()=>{
      clearTimeout(timer);
      // Release decoded page operators/images, not shared fonts.
      try{pdfPage?.cleanup();}catch{}
      if(abort.signal.aborted&&!timedOut){el.width=0;el.height=0;}
    });
    return ()=>{
      abort.abort();clearTimeout(timer);render?.cancel();lease.release();
      // Immediate release of unmounted buffers. New effect creates its own task.
      el.width=0;el.height=0;
    };
  },[documentId,page,width,height,effectiveBudget,attempt]);
  return <div className="relative shrink-0" style={{width,height,maxWidth:"100%",...style}}
    data-testid={`native-page-${page}`} data-state={state==="ready"?"ready":state==="loading"?"loading":"error"}>
    {state!=="ready"&&<div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-white text-slate-700 text-sm"
      role={state==="loading"?"status":"alert"}>
      <span aria-live="polite">{state==="loading"?(showLoading?`Loading page ${page}…`:""):state}</span>
      {state!=="loading"&&<button className="border rounded px-3 py-2" onClick={()=>setAttempt(n=>n+1)}>Retry page {page}</button>}
    </div>}
    <canvas key={`${documentId}:${page}:${width}:${height}:${effectiveBudget}:${attempt}`} ref={canvas} role="img" aria-label={`Page ${page}`} className={className}
      style={{width:"100%",height:"100%",display:"block",visibility:state==="ready"?"visible":"hidden"}}
      data-testid={`canvas-page-${page}`}/>
  </div>;
});
