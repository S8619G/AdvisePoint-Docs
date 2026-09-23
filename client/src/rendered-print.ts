export {};
const el=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
const params=new URLSearchParams(location.search);
let token="",generation=0,timer:ReturnType<typeof setTimeout>|undefined,finished=false;
let firstJob=params.get("job"),closed=false;
const headers={"Content-Type":"application/json","X-APD-PDF-Action":"rendered-print"};
let cancellation:Promise<{pending?:boolean}>=Promise.resolve({});
function cancelRequest(id:string){
  if(id)cancellation=fetch(`/api/rendered-print-jobs/${id}/cancel`,{method:"POST",headers,keepalive:true})
    .then(async r=>{if(!r.ok)throw Error("Cleanup was not confirmed.");return r.json();});
  return cancellation;
}
const finish=()=>{
  closed=true;++generation;clearTimeout(timer);clearInterval(heartbeat);
  const id=token;token="";finished=false;
  return cancelRequest(id);
};
(window as any).apdFinishPrint=finish;
window.addEventListener("keydown",e=>{if(e.key==="Escape"&&window.parent!==window){e.preventDefault();window.parent.postMessage({type:"apd-print-done"},location.origin);}});
async function prepare(){
  if(closed)return;
  const stopped=cancelRequest(token);token=firstJob||crypto.randomUUID();firstJob=null;const run=++generation;finished=false;clearTimeout(timer);
  el("ready").hidden=true;el("error").hidden=true;el("warning").hidden=true;
  el("cancel").hidden=false;el("cancel").textContent="Cancel preparation";el("retry").hidden=true;
  el<HTMLProgressElement>("progress").value=0;el("status").textContent="Starting preparation…";el("external").textContent="";
  try{
    await stopped;if(run!==generation)return;
    const response=await fetch("/api/rendered-print-jobs",{method:"POST",headers,body:JSON.stringify({
      id:token,documentId:document.body.dataset.document,from:Number(document.body.dataset.from),to:Number(document.body.dataset.to),
    })});
    const data=await response.json();if(run!==generation)return;
    if(!response.ok)throw Error(data.message||"Could not start preparation.");
    await poll(run);
  }catch(e:any){if(run===generation)fail(e.message);}
}
function fail(message:string){
  el("error").textContent=message;el("error").hidden=false;el("status").textContent="Preparation did not complete. No incomplete PDF is offered.";
  el("retry").hidden=false;el("cancel").hidden=true;el("ready").hidden=true;
}
async function poll(run:number){
  try{
    const response=await fetch(`/api/rendered-print-jobs/${token}`);const j=await response.json();
    if(run!==generation)return;
    if(!response.ok)throw Error(j.message);
    if(!finished){
      el("status").textContent=j.message;el<HTMLProgressElement>("progress").value=j.completed;
      el("warning").hidden=!(j.state==="preparing"&&j.elapsed_ms>=60000);
    }
    if(j.state==="error"||j.state==="cancelled")throw Error(j.message);
    if(j.state==="ready"&&!finished){
      finished=true;el("ready").hidden=false;el("warning").hidden=true;
      el("selection").textContent=`Prepared ${j.total} pages (original pages ${j.from}–${j.to}). Choose All pages in this prepared PDF.`;
      el<HTMLAnchorElement>("open").href=`/api/rendered-print-jobs/${token}/pdf`;
      el<HTMLAnchorElement>("download").href=`/api/rendered-print-jobs/${token}/pdf?download=1`;
      el("cancel").textContent="Clear prepared PDF";el("retry").hidden=false;
    }
    timer=setTimeout(()=>void poll(run),finished?60000:500);
  }catch(e:any){if(run===generation)fail(e.message||"Connection to print preparation was lost. Check the app, then retry.");}
}
el("cancel").onclick=()=>{++generation;clearTimeout(timer);
  void cancelRequest(token).then(j=>{el("status").textContent=j.pending?"Cleanup pending while files are in use; it will retry automatically.":"Temporary print files cleared.";})
    .catch(()=>{el("status").textContent="Cleanup could not be confirmed. Automatic expiry cleanup remains the fallback.";});
  token="";finished=false;
  el("ready").hidden=true;el("warning").hidden=true;el("status").textContent="Stopping preparation and clearing temporary files…";
  el("cancel").hidden=true;el("retry").hidden=false;};
el("retry").onclick=()=>void prepare();
el("pc").onclick=async()=>{
  const button=el<HTMLButtonElement>("pc");button.disabled=true;el("external").textContent="Requesting your PC PDF program…";
  try{const r=await fetch(`/api/rendered-print-jobs/${token}/open`,{method:"POST",headers});const j=await r.json();el("external").textContent=j.message||"Could not open the PDF program.";}
  catch{el("external").textContent="Could not open the PDF program. Use Download prepared PDF.";}
  finally{button.disabled=false;}
};
window.addEventListener("pagehide",()=>{void finish().catch(()=>{});});
const heartbeat=setInterval(()=>void fetch("/api/heartbeat",{method:"GET"}).catch(()=>{}),30000);
window.addEventListener("pagehide",()=>clearInterval(heartbeat));
void prepare();
