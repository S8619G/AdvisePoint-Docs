'use strict';
// Browser-free, single-copy import preparation. The validated lab engine and
// inspector run out of process; no restricted input is committed to the library.
const fs=require('node:fs'), fsp=fs.promises, path=require('node:path');
const {spawn}=require('node:child_process');
const {runInspection}=require('./compat-inspection-process.cjs');
const LIMIT=150*1024*1024;
let busy=false;
const active=new Set();
function runEngine(executable,args,{signal,output,timeout=180000}={}){
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(Error('PDF preparation cancelled.'));
    const child=spawn(executable,args,{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    let text='',failure;
    const stop=e=>{failure ||= e;if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')};
    const capture=b=>{text=(text+b.toString()).slice(-16000)};
    child.stdout.on('data',capture);child.stderr.on('data',capture);
    child.once('error',e=>{failure=e});
    const abort=()=>stop(Error('PDF preparation cancelled.'));
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const timer=setTimeout(()=>stop(Error('PDF engine timed out.')),timeout);
    const monitor=setInterval(()=>{
      if(output)try{if(fs.statSync(output).size>LIMIT)stop(Error('Prepared PDF exceeds 150 MiB.'))}
      catch(e){if(e.code!=='ENOENT')stop(e)}
    },150);
    child.once('close',(code,exitSignal)=>{
      clearTimeout(timer);clearInterval(monitor);signal?.removeEventListener('abort',abort);
      if(failure)return reject(failure);
      if(code!==0||exitSignal)return reject(Error(`PDF engine failed or reported warnings (${code}): ${text}`));
      resolve(text.trim());
    });
  });
}
function validate(a,b){
  if(!b.canCopy||a.pages.length!==b.pages.length)throw Error('PDF page count or permissions changed unexpectedly.');
  for(let i=0;i<a.pages.length;i++){
    if(Math.abs(a.pages[i].width-b.pages[i].width)>0.2||
       Math.abs(a.pages[i].height-b.pages[i].height)>0.2||
       a.pageTextHashes[i]!==b.pageTextHashes[i])
      throw Error(`PDF page ${i+1} did not match the source.`);
  }
}
async function cleanStale(root){
  await fsp.mkdir(root,{recursive:true});
  for(const name of await fsp.readdir(root)){
    if(!/^job-[A-Za-z0-9_-]+$/.test(name))continue;
    const dir=path.join(root,name);
    if(active.has(dir))continue;
    const st=await fsp.lstat(dir);
    if(st.isDirectory()&&!st.isSymbolicLink()&&Date.now()-st.mtimeMs>24*3600000)
      await fsp.rm(dir,{recursive:true,force:true});
  }
}
async function prepare(buffer,{root,engine,signal,onStage=()=>{}}){
  if(busy)throw Error('Another PDF is being prepared. Retry this file when it finishes.');
  busy=true;
  const local=new AbortController(),abort=()=>local.abort();
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const deadline=setTimeout(abort,600000);
  let work;
  try{
    if(buffer.length>LIMIT||buffer.length<5)throw Error('PDF preparation accepts files up to 150 MiB.');
    await cleanStale(root);
    work=await fsp.mkdtemp(path.join(root,'job-'));active.add(work);
    const input=path.join(work,'input.pdf'),output=path.join(work,'prepared.pdf');
    await fsp.writeFile(input,buffer,{flag:'wx'});
    onStage('checking_pdf_permissions');
    const before=await runInspection(input,'original',{signal:local.signal});
    if(before.canCopy||!before.canPrint)throw Error('This PDF is not eligible for compatibility preparation.');
    const version=await runEngine(engine,['--version'],{signal:local.signal});
    if(!/^qpdf version 12\.4\.1\b/.test(version))throw Error('The bundled PDF engine is unavailable or mismatched.');
    onStage('preparing_compatible_pdf');
    await runEngine(engine,['--decrypt','--object-streams=generate','--recompress-flate',
      '--compression-level=9',input,output],{signal:local.signal,output});
    const size=(await fsp.stat(output)).size;
    if(size<5||size>LIMIT)throw Error('Prepared PDF has an invalid size.');
    onStage('validating_compatible_pdf');
    await runEngine(engine,['--check',output],{signal:local.signal});
    const after=await runInspection(output,'converted',{signal:local.signal});
    validate(before,after);
    if(local.signal.aborted)throw Error('PDF preparation cancelled.');
    return await fsp.readFile(output);
  }finally{
    clearTimeout(deadline);signal?.removeEventListener('abort',abort);
    try{if(work)await fsp.rm(work,{recursive:true,force:true,maxRetries:4,retryDelay:150})}
    finally{active.delete(work);busy=false}
  }
}
module.exports={prepare,validate,runEngine,cleanStale,isBusy:()=>busy};
