import {getDocument,GlobalWorkerOptions,PermissionFlag,type PDFDocumentLoadingTask,type PDFDocumentProxy,type RenderTask} from "pdfjs-dist";
import {PDFDocument as OutputPdf} from "pdf-lib";
GlobalWorkerOptions.workerSrc="/pdfjs/pdf.worker.min.mjs";
const $=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
const status=$("status"),error=$("error"),pages=$("pages"),css=$("page-sizes");
const print=$<HTMLButtonElement>("print"),cancel=$<HTMLButtonElement>("cancel"),retry=$<HTMLButtonElement>("retry");
const id=document.body.dataset.document!,from=Number(document.body.dataset.from),to=Number(document.body.dataset.to);
const params=new URLSearchParams(location.search),embedded=params.get("embedded")==="1",job=params.get("job")||crypto.randomUUID();
let closed=false;
const finish=async()=>{
  closed=true;++generation;dispose();clearInterval(heartbeat);
  const r=await fetch(`/api/pdf/print-jobs/${job}/done`,{method:"POST",headers:{"X-APD-PDF-Action":"open-original"},keepalive:true});
  if(!r.ok)throw Error("Cleanup was not confirmed.");return r.json();
};
(window as any).apdFinishPrint=finish;
window.addEventListener("keydown",e=>{if(e.key==="Escape"&&window.parent!==window){e.preventDefault();window.parent.postMessage({type:"apd-print-done"},location.origin);}});
// These bound the small raster preview, NOT the permitted PDF page range.
const MAX_PIXELS=32_000_000,MAX_PAGE_PIXELS=8_000_000;
const PREPARE_TIMEOUT_MS=120_000;
let generation=0,loading:PDFDocumentLoadingTask|null=null,render:RenderTask|null=null;
let urls:string[]=[],canvas:HTMLCanvasElement|null=null;
let worker:Worker|null=null,stopWorker:(()=>void)|null=null,timer:ReturnType<typeof setTimeout>|null=null;
let warningTimer:ReturnType<typeof setTimeout>|null=null;
let printPdfUrl:string|null=null;
function stopTimer(){if(timer!==null)clearTimeout(timer);timer=null;if(warningTimer!==null)clearTimeout(warningTimer);warningTimer=null;}
function clear(){
  document.body.dataset.ready="false";print.disabled=true;
  document.body.dataset.printMode="";printPdfUrl=null;print.textContent="Print selected pages";
  delete document.body.dataset.preparation;delete document.body.dataset.dpi;
  $("prepared-download").hidden=true;
  $("pdf-help").hidden=true;
  $("fallback-offer").hidden=true;
  pages.replaceChildren();css.textContent="";
  for(const url of urls)URL.revokeObjectURL(url);urls=[];
  if(canvas){canvas.width=canvas.height=0;canvas=null;}
}
function dispose(){stopTimer();stopWorker?.();stopWorker=null;worker?.terminate();worker=null;render?.cancel();render=null;const task=loading;loading=null;void task?.destroy().catch(()=>{});clear();}
function offerOriginal(message:string){
  $("fallback-message").textContent=`${message} You can open the unchanged original in your PC's default PDF program. In its print dialog, choose original pages ${from}–${to}. Nothing is printed automatically.`;
  $("fallback-offer").hidden=false;
}
function fail(message:string){error.textContent=message;error.hidden=false;status.textContent="Print preparation did not complete.";retry.hidden=false;cancel.hidden=true;offerOriginal("Try a smaller range, or use another PDF program.");}
function showPreparedPdf(url:string,originalOnly:boolean){
  printPdfUrl=url;document.body.dataset.printMode=originalOnly?"original-range":"pdf";
  $("pdf-help").hidden=false;
  $("pdf-instructions").textContent=originalOnly
    ?`This PDF's protection settings are preserved. The full original will open. In its print dialog, select original pages ${from}–${to}; do not leave All pages selected.`
    :`The PDF contains ${to-from+1} selected page${to===from?"":"s"}. Open it, then use the PDF reader's Print button or Ctrl+P. Keep these preparation controls open until finished.`;
  $("pdf-range").textContent=originalOnly
    ?`Required print range: ${from}–${to} in the original PDF.`
    :`Selection: original pages ${from}–${to}. Choose All pages in the prepared PDF's print dialog.`;
  print.textContent=originalOnly?"Open original to choose range":"Open PDF to print";
  const download=$<HTMLAnchorElement>("prepared-download");download.href=url;download.hidden=false;
  download.download=originalOnly?"AdvisePoint-original.pdf":`AdvisePoint-pages-${from}-${to}.pdf`;
  status.textContent=originalOnly?"Ready to open the original and select your print range.":`${to-from+1} pages ready as PDF · no stored page images`;
  document.body.dataset.ready="true";print.disabled=false;cancel.hidden=false;cancel.textContent="Clear prepared PDF";
  stopTimer();$("fallback-offer").hidden=true;
}
async function preparePdf(run:number,totalPages:number,highQuality:boolean):Promise<boolean|undefined>{
  const originalUrl=`/api/documents/${encodeURIComponent(id)}/original`;
  let url=originalUrl,originalOnly=from!==1||to!==totalPages;
  status.textContent="Preparing a PDF for printing without full-size page images…";
  if(originalOnly&&!highQuality)return false;
  if(originalOnly&&highQuality){
    const result=await new Promise<{bytes?:ArrayBuffer;originalOnly?:boolean}>((resolve,reject)=>{
      const w=worker=new Worker("/pdf-print-worker.js",{type:"module"});
      const cleanup=()=>{w.terminate();if(worker===w)worker=null;stopWorker=null;};
      stopWorker=()=>{cleanup();reject(new DOMException("Cancelled","AbortError"));};
      w.onerror=()=>{cleanup();reject(Error("The PDF preparation worker failed. Try Open original PDF."));};
      w.onmessage=e=>{cleanup();e.data.error?reject(Error(e.data.error)):resolve(e.data);};
      w.postMessage({url:originalUrl,from,to});
    });
    if(run!==generation)return;
    // pdf-lib intentionally refuses encrypted input. PDF.js has already
    // checked that printing is permitted; let the caller make a temporary
    // print-quality selected-page PDF instead of opening the whole original.
    if(result.originalOnly)return false;
    if(!result.bytes)throw Error("The selected-page PDF was not produced. Try again or choose a smaller range.");
    if(result.bytes){
      url=URL.createObjectURL(new Blob([result.bytes],{type:"application/pdf"}));urls.push(url);originalOnly=false;
    }
  }
  if(run!==generation)return;
  showPreparedPdf(url,originalOnly);return true;
}
async function preparePrintableSubset(run:number,pdf:PDFDocumentProxy,dpi:number){
  const output=await OutputPdf.create();
  const MAX_BYTES=128*1024*1024;let imageBytes=0;
  for(let n=from;n<=to;n++){
    if(run!==generation)return;
    status.textContent=`Preparing selected page ${n-from+1} of ${to-from+1} (original page ${n})…`;
    const page=await pdf.getPage(n);if(run!==generation)return;
    const points=page.getViewport({scale:1}),view=page.getViewport({scale:dpi/72});
    const pixels=Math.ceil(view.width)*Math.ceil(view.height);
    if(!Number.isFinite(pixels)||pixels>MAX_PAGE_PIXELS)
      throw Error("This page exceeds the temporary print-image budget. Use Open original PDF and select the range there.");
    const c=document.createElement("canvas");canvas=c;
    c.width=Math.ceil(view.width);c.height=Math.ceil(view.height);
    const renderTask=page.render({canvas:c,viewport:view,intent:"print",background:"white"});render=renderTask;
    await renderTask.promise;if(run!==generation)return;render=null;
    const blob=await new Promise<Blob>((resolve,reject)=>c.toBlob(b=>b?resolve(b):reject(Error("Could not prepare a print page.")),"image/jpeg",0.9));
    if(run!==generation)return;
    imageBytes+=blob.size;
    if(imageBytes>MAX_BYTES)throw Error("The selected PDF exceeds the temporary-copy budget. Choose a smaller range.");
    const image=await output.embedJpg(await blob.arrayBuffer());
    if(run!==generation)return;
    const target=output.addPage([points.width,points.height]);
    target.drawImage(image,{x:0,y:0,width:points.width,height:points.height});
    c.width=c.height=0;canvas=null;page.cleanup();
  }
  if(run!==generation)return;
  status.textContent="Finishing selected-page PDF…";
  const bytes=await output.save({useObjectStreams:true});
  if(run!==generation)return;
  if(bytes.byteLength>MAX_BYTES)throw Error("The selected PDF exceeds the temporary-copy budget. Choose a smaller range.");
  const url=URL.createObjectURL(new Blob([bytes],{type:"application/pdf"}));urls.push(url);
  document.body.dataset.preparation="print-images";document.body.dataset.dpi=String(dpi);
  showPreparedPdf(url,false);
}
async function prepare(){
  if(closed)return;
  const run=++generation;dispose();error.hidden=true;retry.hidden=true;cancel.hidden=false;
  cancel.textContent="Cancel preparation";
  warningTimer=setTimeout(()=>{
    if(run===generation)offerOriginal("Preparation has taken one minute. You can keep waiting, cancel, or switch to your PC's PDF program.");
  },60_000);
  timer=setTimeout(()=>{
    if(run!==generation)return;
    ++generation;dispose();fail("Preparation took longer than two minutes and was stopped. Try a smaller range, or use Open original PDF to print from your PDF app.");
  },PREPARE_TIMEOUT_MS);
  status.textContent="Preparing selected pages locally…";
  try{
    if(!Number.isInteger(from)||!Number.isInteger(to)||from<1||to<from)throw Error("Invalid page range.");
    const task=loading=getDocument({url:`/api/documents/${encodeURIComponent(id)}/original`,
      cMapUrl:"/pdfjs/cmaps/",cMapPacked:true,standardFontDataUrl:"/pdfjs/standard_fonts/",
      wasmUrl:"/pdfjs/wasm/",isEvalSupported:false,enableXfa:false,disableAutoFetch:true,disableStream:true});
    const pdf=await task.promise;if(run!==generation)return;
    const permissions=await pdf.getPermissions();if(run!==generation)return;
    if(permissions && !permissions.includes(PermissionFlag.PRINT) && !permissions.includes(PermissionFlag.PRINT_HIGH_QUALITY))
      throw Error("This PDF does not allow printing. AdvisePoint Docs will not bypass that restriction. Open original PDF to review its permissions in your PDF app.");
    const dpi=permissions&&!permissions.includes(PermissionFlag.PRINT_HIGH_QUALITY)?150:200;
    if(to>pdf.numPages)throw Error("The selected page range exceeds the original PDF.");
    if(embedded){
      const totalPages=pdf.numPages,highQuality=!permissions||permissions.includes(PermissionFlag.PRINT_HIGH_QUALITY);
      const prepared=await preparePdf(run,totalPages,highQuality);
      if(run!==generation)return;
      if(!prepared)await preparePrintableSubset(run,pdf,dpi);
      await task.destroy();if(loading===task)loading=null;return;
    }
    // Size the entire selection before allocating raster buffers.
    const plan:{number:number;width:number;height:number;pixels:number}[]=[];let total=0;
    for(let n=from;n<=to;n++){
      const page=await pdf.getPage(n);if(run!==generation)return;
      const view=page.getViewport({scale:1}),raster=page.getViewport({scale:dpi/72});
      const pixels=Math.ceil(raster.width)*Math.ceil(raster.height);page.cleanup();
      if(!Number.isFinite(pixels))throw Error("This PDF has invalid page dimensions.");
      if(pixels>MAX_PAGE_PIXELS||total+pixels>MAX_PIXELS){
        const totalPages=pdf.numPages,highQuality=!permissions||permissions.includes(PermissionFlag.PRINT_HIGH_QUALITY);
        const prepared=await preparePdf(run,totalPages,highQuality);
        if(run!==generation)return;
        if(!prepared)await preparePrintableSubset(run,pdf,dpi);
        await task.destroy();if(loading===task)loading=null;return;
      }
      total+=pixels;plan.push({number:n,width:view.width,height:view.height,pixels});
    }
    document.body.dataset.pixelBudget=String(total);document.body.dataset.dpi=String(dpi);
    for(const [index,item]of plan.entries()){
      if(run!==generation)return;
      status.textContent=`Preparing page ${index+1} of ${plan.length} (original page ${item.number}, ${dpi} DPI)…`;
      const page=await pdf.getPage(item.number);if(run!==generation)return;
      const view=page.getViewport({scale:dpi/72}),c=document.createElement("canvas");canvas=c;
      c.width=Math.ceil(view.width);c.height=Math.ceil(view.height);
      render=page.render({canvas:c,viewport:view,intent:"print",background:"white"});
      await render.promise;if(run!==generation)return;render=null;
      const blob=await new Promise<Blob>((resolve,reject)=>c.toBlob(b=>b?resolve(b):reject(Error("Could not prepare a print image.")),"image/png"));
      if(run!==generation)return;
      const url=URL.createObjectURL(blob);urls.push(url);
      const img=new Image();img.alt=`Original PDF page ${item.number}`;img.src=url;await img.decode();
      if(run!==generation)return;
      const sheet=document.createElement("section");sheet.className="sheet";sheet.dataset.originalPage=String(item.number);
      sheet.style.width=`${item.width/72}in`;
      const caption=document.createElement("div");caption.className="caption";caption.textContent=`Original page ${item.number}`;
      sheet.append(img,caption);pages.append(sheet);
      css.textContent+=`@media print{@page selected${index}{size:${item.width}pt ${item.height}pt;margin:0}.sheet[data-original-page="${item.number}"]{page:selected${index};width:${item.width}pt;height:${item.height}pt}}`;
      c.width=c.height=0;canvas=null;page.cleanup();
    }
    if(run!==generation)return;
    await task.destroy();if(loading===task)loading=null;
    stopTimer();$("fallback-offer").hidden=true;document.body.dataset.printMode="images";
    document.body.dataset.ready="true";print.disabled=false;cancel.hidden=true;
    status.textContent=`${plan.length} page${plan.length===1?"":"s"} ready · ${dpi} DPI`;
  }catch(e:any){
    if(run!==generation)return;dispose();
    fail(e?.name==="PasswordException"
      ?"This PDF requires an opening password. Password entry is not supported in this version. Open original PDF in your PDF app."
      :e?.message||"The PDF could not be prepared. Try Open original PDF.");
  }
}
cancel.onclick=()=>{++generation;dispose();status.textContent="Cancelled. Temporary images cleared.";retry.hidden=false;cancel.hidden=true;};
retry.onclick=()=>void prepare();
print.onclick=()=>{
  if(document.body.dataset.ready!=="true")return;
  if(printPdfUrl){window.open(printPdfUrl,"_blank","noopener,noreferrer");return;}
  window.focus();window.print();
};
window.addEventListener("afterprint",()=>{
  ++generation;dispose();status.textContent="Print dialog closed. Temporary images cleared.";retry.hidden=false;
});
window.addEventListener("pagehide",()=>{void finish().catch(()=>{});});
// Keep the prototype alive while this standalone tab is active. It is not
// a fix for suspended browser tabs and never touches production heartbeats.
const heartbeat=setInterval(()=>{
  void fetch("/api/heartbeat",{method:"POST"}).catch(()=>{});
  void fetch(`/api/pdf/print-jobs/${job}/touch`,{method:"POST",headers:{"X-APD-PDF-Action":"open-original"}}).catch(()=>{});
},30_000);
window.addEventListener("pagehide",()=>clearInterval(heartbeat),{once:true});
async function openOriginal(){
  const button=$<HTMLButtonElement>("open-original"),fallback=$<HTMLButtonElement>("fallback-open"),message=$("external-status");
  if(button.disabled)return;button.disabled=true;fallback.disabled=true;
  if(document.body.dataset.ready!=="true"){
    ++generation;dispose();status.textContent="In-app preparation stopped. Opening the original instead.";
    retry.hidden=false;cancel.hidden=true;
  }
  message.textContent="Requesting the Windows default PDF app…";
  try{
    const response=await fetch(`/api/pdf/open-original/${encodeURIComponent(id)}?job=${job}`,{
      method:"POST",headers:{"X-APD-PDF-Action":"open-original"}});
    const result=await response.json();if(!response.ok)throw Error(result.message);
    message.textContent=`${result.message} For this job, select original pages ${from}–${to} in your PDF program's print dialog.`;
  }catch(e:any){message.textContent=e?.message||"Could not open the PDF app. Use Download original PDF instead.";}
  finally{button.disabled=false;fallback.disabled=false;}
}
$<HTMLButtonElement>("open-original").onclick=()=>void openOriginal();
$<HTMLButtonElement>("fallback-open").onclick=()=>void openOriginal();
void prepare();
