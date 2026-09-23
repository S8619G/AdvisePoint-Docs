export {};
const el=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
const params=new URLSearchParams(location.search),job=params.get("job")||crypto.randomUUID();
const id=document.body.dataset.document!,from=Number(document.body.dataset.from),to=Number(document.body.dataset.to);
const headers={"X-APD-PDF-Action":"open-original"};
let closed=false,attaching=false;
async function cleanup(){
  const r=await fetch(`/api/pdf/print-jobs/${job}/done`,{method:"POST",headers,keepalive:true});
  if(!r.ok)throw Error("Cleanup could not be confirmed.");return r.json();
}
async function finish(){closed=true;clearInterval(heartbeat);return cleanup();}
(window as any).apdFinishPrint=finish;
window.addEventListener("keydown",e=>{
  if(e.key==="Escape"&&window.parent!==window){e.preventDefault();window.parent.postMessage({type:"apd-print-done"},location.origin);}
});
el("attach").onclick=async()=>{
  const file=el<HTMLInputElement>("original-file").files?.[0];
  if(!file||attaching||closed)return;
  if(file.size>150*1024*1024){el("error").textContent="Choose a PDF no larger than 150 MiB.";el("error").hidden=false;return;}
  attaching=true;el<HTMLButtonElement>("attach").disabled=true;el<HTMLButtonElement>("fallback").disabled=true;
  el("error").hidden=true;el("status").textContent="Verifying and storing the exact original PDF…";
  try{
    const body=new FormData();body.append("file",file);
    const r=await fetch(`/api/pdf/attach-original/${encodeURIComponent(id)}`,{
      method:"POST",headers:{"X-APD-PDF-Action":"attach-original"},body});
    const j=await r.json();if(!r.ok)throw Error(j.message);
    if(closed)return;
    el("attach-section").hidden=true;el("handoff").hidden=false;
    el("status").textContent="Original verified and attached. Ready to open without preparing page images.";
    document.body.dataset.available="true";
  }catch(e:any){
    if(!closed){el("error").textContent=e.message||"Attachment could not be confirmed. Reopen Print to check, or retry.";
      el("error").hidden=false;el("status").textContent="Original handoff is not ready.";}
  }finally{attaching=false;el<HTMLButtonElement>("attach").disabled=false;el<HTMLButtonElement>("fallback").disabled=false;}
};
el("fallback").onclick=async()=>{
  if(closed||attaching)return;
  el<HTMLButtonElement>("fallback").disabled=true;
  try{
    await cleanup();if(closed)return;
    // A new token prevents cleanup tombstones from cancelling the fallback.
    const url=new URL(`/api/rendered-print/${encodeURIComponent(id)}`,location.origin);
    url.searchParams.set("from",String(from));url.searchParams.set("to",String(to));
    url.searchParams.set("prepared","1");url.searchParams.set("embedded",params.get("embedded")||"0");
    url.searchParams.set("job",crypto.randomUUID());
    location.replace(url.href);
  }catch{el("error").textContent="Cleanup could not be confirmed. Close and reopen Print to retry.";el("error").hidden=false;el<HTMLButtonElement>("fallback").disabled=false;}
};
const heartbeat=setInterval(()=>{
  void fetch("/api/heartbeat",{method:"GET"}).catch(()=>{});
  void fetch(`/api/pdf/print-jobs/${job}/touch`,{method:"POST",headers}).catch(()=>{});
},30000);
window.addEventListener("pagehide",()=>{void finish().catch(()=>{});});
