import {existsSync,lstatSync,mkdtempSync,readdirSync,rmdirSync,realpathSync,rmSync,statSync,statfsSync,renameSync,openSync,readSync,closeSync} from "node:fs";
import {join,dirname,resolve} from "node:path";
import {tmpdir,freemem} from "node:os";
import {fileURLToPath} from "node:url";
import {execFile,fork,type ChildProcess,type ForkOptions} from "node:child_process";
import {promisify} from "node:util";
import type {Express,Request} from "express";
import {storage} from "./storage";
import {resolvePageImageOnDisk,pageDirForDoc} from "./pages";
import {windowsPdfLaunch} from "./pdf-open";
import {uploadLog} from "./upload-log";
import {originalExists} from "./originals";
import {pdfHandoffHtml,ORIGINAL_HANDOFF_THRESHOLD} from "./pdf-handoff";
const LIMIT=1024*1024*1024,TTL=30*60*1000,DEADLINE=10*60*1000;
const tokenPattern=/^[a-f0-9-]{36}$/;
type Job={id:string;documentId:string;from:number;to:number;total:number;completed:number;bytes:number;
  state:"preparing"|"ready"|"error"|"cancelled";message:string;dir:string;file:string;last:number;started:number;
  worker?:ChildProcess;cancel?:()=>Promise<void>;readers:number;cleanupRequested?:boolean};
const jobs=new Map<string,Job>();
const cancelled=new Map<string,number>();
let active:Job|undefined,opening=false,lastOpened=0;
export function isRenderedPrintBusy(){return active!==undefined;}
// Recover only our known, old temporary outputs after an interrupted session.
// Never recurse through unknown contents, links, or another Unix user's files.
function cleanOrphans(){
  try{for(const name of readdirSync(tmpdir())){
    if(!/^advisepoint-rendered-print-[a-zA-Z0-9]{6}$/.test(name))continue;
    const dir=join(tmpdir(),name),info=lstatSync(dir);
    if(!info.isDirectory()||info.isSymbolicLink()||Date.now()-info.mtimeMs<24*60*60*1000)continue;
    if(process.getuid&&info.uid!==process.getuid())continue;
    const names=readdirSync(dir);
    if(names.some(n=>!["preparing.part","prepared.pdf"].includes(n)))continue;
    if(names.some(n=>{const s=lstatSync(join(dir,n));return !s.isFile()||s.isSymbolicLink();}))continue;
    try{for(const n of names)rmSync(join(dir,n));rmdirSync(dir);}catch{/* open in a PDF reader */}
  }}catch{/* cleanup is best effort */}
}
cleanOrphans();
function safeLocal(req:Request){
  const host=req.headers.host,port=req.socket.localPort;
  return (host===`127.0.0.1:${port}`||host===`localhost:${port}`)&&
    req.get("origin")===`http://${host}`&&req.get("X-APD-PDF-Action")==="rendered-print";
}
function workerFile(){
  const url=(import.meta as any)?.url;
  const here=url?dirname(fileURLToPath(url)):__dirname;
  const path=[join(here,"workers/rendered-print-worker.cjs"),
    resolve("server/workers/rendered-print-worker.cjs"),resolve("dist/workers/rendered-print-worker.cjs")].find(existsSync);
  if(!path)throw Error("The print worker is missing. Re-extract the complete application.");
  return path;
}
function plain(path:string){
  let at=resolve(path);
  for(;;){if(lstatSync(at).isSymbolicLink())throw Error("Linked page paths are not supported for printing.");
    const parent=dirname(at);if(parent===at)break;at=parent;}
  if(!lstatSync(path).isFile())throw Error("A stored page image is missing.");
}
function clean(){
  const now=Date.now();
  for(const [id,j]of jobs)if(j!==active&&j.readers===0&&(j.cleanupRequested||now-j.last>TTL)){
    try{rmSync(j.dir,{recursive:true,force:true});jobs.delete(id);}catch{/* locked by reader */}
  }
  for(const [id,t]of cancelled)if(now-t>TTL)cancelled.delete(id);
}
const sweeper=setInterval(clean,60000);sweeper.unref();
function snapshot(j:Job){return {id:j.id,state:j.state,completed:j.completed,total:j.total,bytes:j.bytes,
  from:j.from,to:j.to,message:j.message,elapsed_ms:Date.now()-j.started};}
function start(id:string,documentId:string,from:number,to:number):Job{
  clean();
  if(cancelled.has(id))throw Error("Preparation was cancelled. Use Prepare again.");
  const existing=jobs.get(id);
  if(existing){
    if(existing.documentId!==documentId||existing.from!==from||existing.to!==to)throw Error("Print request token already used.");
    return existing;
  }
  if(active)throw Error("Another rendered-page PDF is being prepared. Wait for it or cancel it first.");
  if(jobs.size>=8)throw Error("Too many temporary print jobs. Close old print jobs and try again later.");
  const doc=storage.getDocument(documentId),total=storage.getRenderStatus(documentId)?.total||0;
  if(!doc||(doc.original_ext==="pdf"&&!doc.pdf_rendered)||!pageDirForDoc(documentId))throw Error("Rendered-page document not found.");
  if(!Number.isInteger(from)||!Number.isInteger(to)||from<1||to<from||to>total)throw Error("Invalid page range.");
  const rows=new Map(storage.listPages(documentId).map(p=>[p.page_number,p]));
  const pages=[];
  for(let n=from;n<=to;n++){
    const row=rows.get(n),path=resolvePageImageOnDisk(documentId,n);
    if(!row||!path)throw Error(`Page ${n} is not available. Wait for rendering to finish, or choose a ready range.`);
    plain(path);
    const root=realpathSync(pageDirForDoc(documentId)!);
    if(dirname(realpathSync(path))!==root)throw Error("Page is outside its document folder.");
    if(!Number.isSafeInteger(row.width)||!Number.isSafeInteger(row.height)||row.width<1||row.height<1||row.width*row.height>32_000_000)
      throw Error(`Page ${n} exceeds the safe image size. Use the source PDF in your PDF reader instead.`);
    pages.push({number:n,path,width:row.width,height:row.height});
  }
  const cached=[...jobs.values()].reduce((n,j)=>n+j.bytes,0);
  const maxBytes=LIMIT-cached;
  if(maxBytes<16*1024*1024)throw Error("Temporary print storage is full. Close old print jobs before trying again.");
  const disk=statfsSync(tmpdir());
  if(disk.bavail*disk.bsize<maxBytes+128*1024*1024)throw Error("Not enough temporary disk space. Free at least 1.2 GiB and try again.");
  const dir=mkdtempSync(join(tmpdir(),"advisepoint-rendered-print-"));
  const file=join(dir,"prepared.pdf"),part=join(dir,"preparing.part");
  const j:Job={id,documentId,from,to,total:pages.length,completed:0,bytes:0,state:"preparing",
    message:"Preparing saved page images…",dir,file,last:Date.now(),started:Date.now(),readers:0};
  let w:ChildProcess;
  // Use the current packaged architecture's Node executable. Never a shell or
  // PATH-resolved Node. Native rendering no longer shares the server process.
  const env={...process.env};delete env.NODE_OPTIONS;
  const forkOptions:ForkOptions & {windowsHide:boolean}={execPath:process.execPath,execArgv:[],env,
    windowsHide:true,stdio:["ignore","ignore","pipe","ipc"]};
  try{w=fork(workerFile(),[],forkOptions);}
  catch(e){rmSync(dir,{recursive:true,force:true});throw e;}
  jobs.set(id,j);active=j;j.worker=w;
  let closed=false,stopping=false,done=false,stage:NodeJS.Timeout|undefined,exitTimer:NodeJS.Timeout|undefined;
  let outcome:{state:Job["state"];message:string}|undefined,resolveSettled:()=>void;
  const settled=new Promise<void>(r=>{resolveSettled=r;});
  const diagnostic=(event:string,fields:Record<string,unknown>={})=>uploadLog(event,{
    job_id:id,document_id:documentId,pid:w.pid,pages:j.completed,bytes:j.bytes,
    elapsed_ms:Date.now()-j.started,free_memory_bytes:freemem(),...fields});
  const deadline=setTimeout(()=>stop("error","Preparation exceeded ten minutes. Choose a smaller range."),DEADLINE);
  function stop(state:Job["state"],message:string):Promise<void>{
    if(closed)return settled;
    // Explicit cancellation wins a race with a validated but not yet exited job.
    if(!stopping||state==="cancelled")outcome={state,message};
    if(!stopping){
      stopping=true;clearTimeout(deadline);clearTimeout(stage);clearTimeout(exitTimer);
      diagnostic("rendered_print_stop_requested",{status:state});
      try{w.kill("SIGKILL");}catch{diagnostic("rendered_print_stop_failed",{code:"KILL_FAILED"});}
      // Retain the busy slot and files until actual process close. A failed
      // kill must not permit a second writer or delete a still-open output.
    }
    return new Promise(resolve=>{
      const timer=setTimeout(()=>{
        if(!closed){j.state="error";j.message="Print preparation could not be stopped yet. The library remains available; please wait before retrying.";
          diagnostic("rendered_print_stop_pending",{code:"EXIT_NOT_CONFIRMED"});}
        resolve();
      },5000);
      settled.then(()=>{clearTimeout(timer);resolve();});
    });
  }
  j.cancel=()=>stop("cancelled","Cancelled. No incomplete PDF is available.");
  // Bound and redact native stderr before writing it to the rotated journal.
  let stderrLeft=8192;
  w.stderr?.on("data",(data:Buffer)=>{
    if(stderrLeft<=0)return;
    const chunk=data.subarray(0,stderrLeft);stderrLeft-=chunk.length;
    const text=chunk.toString("utf8")
      .replace(/[A-Za-z]:[\\/][^\r\n"<>]*/g,"[path]")
      .replace(/\/(?:home|tmp|Users|var)\/[^\s"<>]*/g,"[path]");
    for(let i=0;i<text.length;i+=240)diagnostic("rendered_print_worker_stderr",{diagnostic:text.slice(i,i+240)});
  });
  w.on("error",()=>{diagnostic("rendered_print_process_error",{code:"CHILD_PROCESS_ERROR"});
    void stop("error","The print preparation process could not continue. The library is still available. Try preparing again.");});
  w.on("close",(code,signal)=>{
    closed=true;clearTimeout(deadline);clearTimeout(stage);clearTimeout(exitTimer);
    diagnostic("rendered_print_worker_exit",{exit_code:code,signal:signal||"none",stage:done?"validated":"incomplete"});
    let result=outcome||{state:"error" as const,message:"Print preparation stopped unexpectedly. The library is still available. Try preparing again or choose fewer pages."};
    if(done&&!stopping&&code===0&&!signal){
      try{renameSync(part,file);result={state:"ready",message:`${j.total} pages ready. Open the prepared PDF, then choose All pages to print this selection.`};}
      catch{result={state:"error",message:"The completed PDF could not be saved. Check temporary disk space and try again."};}
    }
    j.state=result.state;j.message=result.message;j.last=Date.now();j.worker=undefined;
    if(result.state!=="ready"){try{rmSync(part,{force:true});rmSync(file,{force:true});}catch{}j.bytes=0;}
    if(active===j)active=undefined;
    diagnostic("rendered_print_finished",{status:j.state,code:j.state==="ready"?"READY":"PRINT_INCOMPLETE"});
    resolveSettled!();clean();
  });
  w.on("message",(m:any)=>{
    if(closed||stopping)return;
    try{
      if(!m||typeof m!=="object"||done)throw Error("Unexpected print worker message.");
      if(!storage.getDocument(documentId))throw Error("The document was removed during preparation.");
      if(m.type==="stage"){
        clearTimeout(stage);stage=setTimeout(()=>stop("error",`Page ${m.page} took too long. Choose a smaller range or use the source PDF.`),60000);
      }else if(m.type==="progress"){
        if(m.completed!==j.completed+1||m.completed>j.total)throw Error("Unexpected page sequence.");
        if(!Number.isSafeInteger(m.bytes)||m.bytes<j.bytes||m.bytes>maxBytes)throw Error("Unexpected print output size.");
        j.completed=m.completed;j.bytes=m.bytes;j.message=`Prepared ${j.completed} of ${j.total} pages`;j.last=Date.now();
        if(j.completed===1||j.completed%50===0||j.completed===j.total)
          diagnostic("rendered_print_progress",{rss_bytes:m.memory?.rss,heap_used_bytes:m.memory?.heapUsed,
            external_bytes:m.memory?.external,array_buffers_bytes:m.memory?.arrayBuffers});
      }else if(m.type==="phase"){
        if(!["finalizing","flushing","closed"].includes(m.phase))throw Error("Unknown preparation phase.");
        j.message="Finishing the prepared PDF…";
        diagnostic("rendered_print_phase",{stage:m.phase,rss_bytes:m.memory?.rss,heap_used_bytes:m.memory?.heapUsed,
          external_bytes:m.memory?.external,array_buffers_bytes:m.memory?.arrayBuffers});
      }else if(m.type==="done"){
        if(m.completed!==j.total||j.completed!==j.total||statSync(part).size!==m.bytes)throw Error("The requested PDF is incomplete.");
        // Only a completely written, closed file with a final trailer is exposed.
        const fd=openSync(part,"r"),tail=Buffer.alloc(64);
        try{readSync(fd,tail,0,64,Math.max(0,m.bytes-64));}finally{closeSync(fd);}
        if(!tail.includes(Buffer.from("%%EOF")))throw Error("The prepared PDF has no completion trailer.");
        done=true;j.bytes=m.bytes;clearTimeout(stage);
        diagnostic("rendered_print_phase",{stage:"validated_waiting_for_exit"});
        // No forced termination on success. Expose only after a clean exit;
        // a native teardown crash after 'done' remains a failed job.
        exitTimer=setTimeout(()=>stop("error","Print preparation did not finish closing safely. Please prepare again."),5000);
      }else if(m.type==="error")void stop("error",String(m.message||"Print preparation failed.").slice(0,500));
      else throw Error("Unknown print worker message.");
    }catch(e:any){void stop("error",e.message);}
  });
  diagnostic("rendered_print_started",{pages:pages.length,stage:"spawned"});
  w.send({pages,output:part,maxBytes},error=>{
    if(error&&!closed)void stop("error","The print preparation process could not start. Try again.");
  });
  return j;
}
export function renderedPrintRoutes(app:Express){
  app.get("/api/rendered-print/:id",(req,res)=>{
    const doc=storage.getDocument(req.params.id),total=storage.getRenderStatus(req.params.id)?.total||0;
    const from=Number(req.query.from),to=Number(req.query.to);
    if(!doc||(doc.original_ext==="pdf"&&!doc.pdf_rendered)||!/^[a-zA-Z0-9_-]+$/.test(doc.id))return res.status(404).json({message:"Rendered-page document not found."});
    if(!Number.isInteger(from)||!Number.isInteger(to)||from<1||to<from||to>total)return res.status(400).json({message:"Invalid page range."});
    res.setHeader("Cache-Control","no-store");
    res.setHeader("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
    res.type("html").send(to-from+1>ORIGINAL_HANDOFF_THRESHOLD&&req.query.prepared!=="1"
      ?pdfHandoffHtml(doc.id,from,to,total,doc.original_ext==="pdf"&&originalExists(doc.id,"pdf"),true,
        /^[a-f0-9]{64}$/i.test(doc.file_hash_sha256||""))
      :printHtml(doc.id,from,to));
  });
  app.post("/api/rendered-print-jobs",(req,res)=>{
    if(!safeLocal(req))return res.status(403).json({message:"Use the Print button in this local application."});
    const {id,documentId,from,to}=req.body||{};
    if(typeof id!=="string"||!tokenPattern.test(id)||typeof documentId!=="string")return res.status(400).json({message:"Invalid print request."});
    try{res.json(snapshot(start(id,documentId,from,to)));}catch(e:any){res.status(400).json({message:e.message});}
  });
  app.get("/api/rendered-print-jobs/:id",(req,res)=>{
    const j=jobs.get(req.params.id);if(!j)return res.status(404).json({message:"Print job expired. Prepare again."});
    j.last=Date.now();res.setHeader("Cache-Control","no-store");res.json(snapshot(j));
  });
  app.post("/api/rendered-print-jobs/:id/cancel",async(req,res)=>{
    if(!safeLocal(req))return res.sendStatus(403);
    if(!tokenPattern.test(req.params.id))return res.sendStatus(400);
    if(cancelled.size<100)cancelled.set(req.params.id,Date.now());
    const j=jobs.get(req.params.id);if(j?.state==="preparing")await j.cancel?.();
    if(j){j.cleanupRequested=true;if(j!==active){j.state="cancelled";j.message="Cleared. Prepare again to create another PDF.";}}
    clean();
    res.json({ok:true,pending:jobs.has(req.params.id)});
  });
  app.get("/api/rendered-print-jobs/:id/pdf",(req,res)=>{
    const j=jobs.get(req.params.id);
    if(!j||j.state!=="ready"||!storage.getDocument(j.documentId))return res.status(409).json({message:"A complete prepared PDF is not available."});
    j.last=Date.now();j.readers++;
    res.setHeader("Cache-Control","no-store");res.setHeader("Content-Type","application/pdf");
    res.setHeader("Content-Disposition",`${req.query.download==="1"?"attachment":"inline"}; filename="AdvisePoint-pages-${j.from}-${j.to}.pdf"`);
    res.sendFile(j.file,err=>{j.readers--;clean();if(err&&!res.headersSent)res.status(500).end();});
  });
  app.post("/api/rendered-print-jobs/:id/open",(req,res)=>{
    if(!safeLocal(req))return res.sendStatus(403);
    const j=jobs.get(req.params.id);
    if(!j||j.state!=="ready"||!storage.getDocument(j.documentId))return res.status(409).json({message:"Prepare the complete PDF first."});
    if(process.platform!=="win32")return res.status(501).json({message:"The PC PDF app opens only on Windows. Use Open prepared PDF or Download instead."});
    if(opening||Date.now()-lastOpened<3000)return res.status(429).json({message:"Please wait before opening another PDF."});
    if(!process.env.SystemRoot||!/^[A-Za-z]:\\/.test(process.env.SystemRoot))return res.status(500).json({message:"Windows PDF association is unavailable. Use Download instead."});
    opening=true;j.last=Date.now();j.readers++;
    const launch=windowsPdfLaunch(j.file,process.env.SystemRoot);
    promisify(execFile)(launch.executable,launch.args,{env:launch.env,windowsHide:true,timeout:15000,maxBuffer:65536,shell:false})
      .then(()=>{lastOpened=Date.now();res.json({message:"Windows was asked to open the prepared PDF. Choose All pages to print this selection."});})
      .catch(()=>res.status(500).json({message:"Could not open the PC PDF app. Use Open prepared PDF or Download."}))
      .finally(()=>{opening=false;j.readers--;clean();});
  });
}
function printHtml(id:string,from:number,to:number){
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AdvisePoint Docs - Prepare rendered pages</title><style>
:root{font:15px/1.5 system-ui;color:#222;background:#eef0f3}*{box-sizing:border-box}
main{max-width:800px;margin:24px auto;padding:24px;background:white;border:1px solid #ccc;border-radius:8px}
h1{font-size:22px;margin-top:0}button,a{display:inline-block;font:inherit;color:inherit;background:white;border:1px solid #888;border-radius:5px;padding:7px 12px;text-decoration:none;cursor:pointer;margin:4px 4px 4px 0}
a.primary{background:#273c43;color:white}button:focus-visible,a:focus-visible{outline:3px solid #2675ad}
progress{width:100%}#error{color:#a00}#warning{padding:12px;background:#fff4ce}
[hidden]{display:none!important}small{color:#555}@media(max-width:820px){main{margin:12px}}
@media print{main{display:none}body:after{content:"This is a preparation page. Cancel this dialog and use Open prepared PDF to print the complete selection.";display:block;padding:30px}}
</style></head><body data-document="${id}" data-from="${from}" data-to="${to}"><main>
<h1>Prepare pages ${from}–${to} for printing</h1>
<p>This document uses saved page images. A temporary PDF is prepared one page at a time; your library is not changed.</p>
<p id="status" role="status">Starting preparation…</p><progress id="progress" max="${to-from+1}" value="0"></progress>
<p id="error" role="alert" hidden></p><p id="warning" hidden>Preparation has taken a minute. You can keep waiting or cancel and choose a smaller range. For selections over 50 pages, reopen Print to use the original-PDF handoff if an original is available.</p>
<div id="ready" hidden><p id="selection"></p><a class="primary" id="open" target="_blank" rel="noopener noreferrer">Open prepared PDF</a>
<a id="download">Download prepared PDF</a><button id="pc">Open in PC PDF app</button></div>
<button id="cancel">Cancel preparation</button><button id="retry" hidden>Prepare again</button>
<p id="external" role="status"></p><small>Nothing prints automatically. Your browser still needs to load the prepared PDF; that is not a second preparation job. Chrome, Edge and Firefox may open a reader or download the file according to your settings. Preparation stops on missing pages, a 1 GiB temporary-storage budget or a ten-minute deadline. Keep these controls open until finished. Temporary results expire after 30 minutes without activity. The result contains images, not searchable original PDF text.</small>
</main><script type="module" src="/rendered-print.js"></script></body></html>`;
}
