import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
GlobalWorkerOptions.workerSrc=workerUrl;
type Session={task:ReturnType<typeof getDocument>;users:number;timer?:ReturnType<typeof setTimeout>};
const sessions=new Map<string,Session>();
export function acquirePdf(id:string) {
  let session=sessions.get(id);
  if (!session) {
    session={users:0,task:getDocument({
      url:`/api/documents/${encodeURIComponent(id)}/original`,
      cMapUrl:"/pdfjs/cmaps/",cMapPacked:true,
      standardFontDataUrl:"/pdfjs/standard_fonts/",wasmUrl:"/pdfjs/wasm/",
      isEvalSupported:false,enableXfa:false,disableAutoFetch:true,
      disableStream:true,
    })};
    sessions.set(id,session);
    const failed=session;
    // No password collection or persistence in this prototype.
    // getDocument rejects PasswordException, surfaced by NativePdfPage.
    void session.task.promise.catch(()=>{
      if(sessions.get(id)===failed)sessions.delete(id);
    });
  }
  const s=session;
  clearTimeout(s.timer);s.users++;
  return {promise:s.task.promise as Promise<PDFDocumentProxy>,
    release:()=>{
      if (--s.users===0) s.timer=setTimeout(()=>{
        if(s.users) return;
        if(sessions.get(id)===s)sessions.delete(id);
        void s.task.destroy();
      },250);
    }};
}
let running=0;
type Job={signal:AbortSignal;start:()=>void;cancel:()=>void;priority:number};
const queue:Job[]=[];
function drain() {
  queue.sort((a,b)=>a.priority-b.priority);
  while(running<2 && queue.length) {
    const job=queue.shift()!;
    if(job.signal.aborted){job.cancel();continue;}
    job.start();
  }
}
export function withPdfRenderSlot<T>(signal:AbortSignal,priority:number,run:()=>Promise<T>):Promise<T> {
  return new Promise((resolve,reject)=>{
    const cancel=()=>reject(new DOMException("Render cancelled","AbortError"));
    const job:Job={signal,priority,cancel,start:()=>{
      running++;
      run().then(resolve,reject).finally(()=>{running--;drain();});
    }};
    signal.addEventListener("abort",()=>{
      const index=queue.indexOf(job);
      if(index>=0){queue.splice(index,1);cancel();}
    },{once:true});
    queue.push(job);drain();
  });
}
