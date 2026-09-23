import {useEffect, useRef, useState} from "react";
import {Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle} from "@/components/ui/dialog";

type PrintFrame = Window & {apdFinishPrint?: () => Promise<{pending?: boolean}>};
export function PrintPreparationDialog({url,onDone}: {url:string;onDone:(message:string)=>void}) {
  const frame=useRef<HTMLIFrameElement>(null);
  const closing=useRef(false);
  const [busy,setBusy]=useState(false);
  const [loaded,setLoaded]=useState(false);
  const job=new URL(url).searchParams.get("job")!;
  const fallback=async()=>{
    // The same frame can switch from original handoff to saved-page preparation.
    // If its script did not finish loading, clean both job types idempotently.
    let currentJob=job;
    try{currentJob=new URL(frame.current?.contentWindow?.location.href||url).searchParams.get("job")||job;}catch{/* original token remains safe */}
    const results=await Promise.all([["rendered-print-jobs","cancel","rendered-print"],["pdf/print-jobs","done","open-original"]].map(
      async([route,action,header])=>{
        const r=await fetch(`/api/${route}/${currentJob}/${action}`,{
          method:"POST",headers:{"X-APD-PDF-Action":header},keepalive:true});
        if(!r.ok)throw Error("Cleanup request failed");return r.json();
      }));
    return {pending:results.some(r=>r.pending)};
  };
  const finish=async()=>{
    if(closing.current)return;
    closing.current=true;setBusy(true);
    let message="Print preparation closed. Library documents and downloaded copies were not changed.";
    try{
      const cleanup=(frame.current?.contentWindow as PrintFrame|null)?.apdFinishPrint;
      const result=await Promise.race([
        cleanup?cleanup():fallback(),
        new Promise<{pending:boolean}>(resolve=>setTimeout(()=>resolve({pending:true}),5000)),
      ]);
      if(result.pending)message="Print preparation closed. Temporary-file cleanup is pending and will be retried when files are free.";
    }catch{message="Print preparation closed. Cleanup could not be confirmed; automatic expiry cleanup remains the fallback.";}
    onDone(message);
  };
  useEffect(()=>{
    const receive=(e:MessageEvent)=>{
      if(e.origin===location.origin&&e.source===frame.current?.contentWindow&&e.data?.type==="apd-print-done")void finish();
    };
    window.addEventListener("message",receive);
    return ()=>{
      window.removeEventListener("message",receive);
      if(!closing.current){
        const cleanup=(frame.current?.contentWindow as PrintFrame|null)?.apdFinishPrint;
        void (cleanup?cleanup():fallback()).catch(()=>{});
      }
    };
  },[url]);
  return <Dialog open onOpenChange={v=>{if(!v)void finish();}}>
    <DialogContent data-testid="print-preparation-dialog" className="max-w-3xl w-[calc(100%-24px)] p-0 gap-0 flex flex-col max-h-[90vh]"
      onInteractOutside={e=>e.preventDefault()}>
      <DialogHeader className="px-5 py-4 border-b pr-12">
        <DialogTitle>Prepare for printing</DialogTitle>
        <DialogDescription>Open the PDF in your browser or PDF reader, then print from there.</DialogDescription>
      </DialogHeader>
      {!loaded&&<p role="status" className="px-5 py-2 text-sm">Loading preparation controls…</p>}
      <iframe ref={frame} src={url} title="Print preparation controls" data-testid="print-preparation-frame"
        className="w-full border-0 h-[48vh] min-h-[180px] bg-background" onLoad={()=>setLoaded(true)}/>
      <div className="px-5 py-4 border-t flex gap-4 items-center">
        <p className="text-sm text-muted-foreground flex-1">Click Done after you finish printing or viewing the PDF. This clears this job’s temporary files, not your library or downloaded copies. The PDF-reader tab stays open, but its temporary PDF may no longer reload.</p>
        <button type="button" data-testid="print-preparation-done" disabled={busy} onClick={()=>void finish()}
          className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium disabled:opacity-50">
          {busy?"Cleaning up…":"Done"}
        </button>
      </div>
    </DialogContent>
  </Dialog>;
}
