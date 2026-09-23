import {lstat,realpath,readFile,mkdir,readdir,writeFile,unlink} from "node:fs/promises";
import {join,resolve,dirname} from "node:path";
import {createHash,randomUUID} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";

const execFileAsync=promisify(execFile);
const MAX_TEMP_BYTES=512*1024*1024;
const filePattern=/^original-[a-f0-9]{64}-[a-f0-9-]{36}\.pdf$/;
type PrintCopies={paths:Set<string>;busy:number;done:boolean;last:number};
const printCopies=new Map<string,PrintCopies>();
const ownedCopy=(path:string)=>[...printCopies.values()].some(j=>j.paths.has(path));
const PRINT_TTL=30*60*1000;
function copyJob(id:string){
  let j=printCopies.get(id);
  if(!j){if(printCopies.size>=100)throw Error("Too many temporary PDF jobs.");j={paths:new Set(),busy:0,done:false,last:Date.now()};printCopies.set(id,j);}
  return j;
}
async function cleanCopyJob(j:PrintCopies){
  if(!j.done||j.busy)return;
  for(const path of j.paths){
    try{await unlink(path);j.paths.delete(path);}catch(e:any){if(e.code==="ENOENT")j.paths.delete(path);}
  }
}
export async function finishExternalPrint(id:string){
  const j=copyJob(id);j.done=true;j.last=Date.now();await cleanCopyJob(j);
  return {ok:true,pending:j.busy>0||j.paths.size>0};
}
export function touchExternalPrint(id:string){
  const j=printCopies.get(id);if(j&&!j.done)j.last=Date.now();
}
const copySweep=setInterval(()=>{void (async()=>{
  for(const [id,j]of printCopies){
    if(Date.now()-j.last>PRINT_TTL)j.done=true;
    await cleanCopyJob(j);
    // Retain a bounded tombstone so a late open cannot recreate a finished job.
    if(j.done&&!j.busy&&!j.paths.size&&Date.now()-j.last>PRINT_TTL)printCopies.delete(id);
  }
})().catch(()=>{});},60000);
copySweep.unref();
export async function cleanOldExternalCopies(root:string){
  const folder=join(root,"temp","external-pdf");
  try{
    for(const entry of await readdir(folder,{withFileTypes:true})){
      if(!entry.isFile()||entry.isSymbolicLink()||!filePattern.test(entry.name))continue;
      const path=join(folder,entry.name);if(ownedCopy(path))continue;await plainPath(path);
      if(Date.now()-(await lstat(path)).mtimeMs>24*60*60*1000){
        try{await unlink(path);}catch{/* Locked copies are retried at the next sweep. */}
      }
    }
  }catch{/* No folder yet, or unsafe/unavailable directory. */}
}
async function plainPath(path:string){
  // Windows junctions are reported by lstat as symlinks. Walk ancestors as
  // well as the leaf so a linked temp/originals directory cannot redirect us.
  let at=resolve(path);
  for(;;){
    if((await lstat(at)).isSymbolicLink())throw Error("Linked PDF paths are not allowed.");
    const parent=dirname(at);if(parent===at)break;at=parent;
  }
  if(!(await lstat(path)).isFile())throw Error("Original PDF is not a regular file.");
}
export async function prepareExternalCopy(root:string,source:string,unique=false):Promise<string>{
  await plainPath(source);
  const actual=await realpath(source),originalDir=await realpath(join(root,"originals"));
  if(dirname(actual)!==originalDir||!actual.toLowerCase().endsWith(".pdf"))throw Error("Original is outside library storage.");
  const bytes=await readFile(actual);
  if(!bytes.subarray(0,1024).includes(Buffer.from("%PDF-")))throw Error("Original file is not a PDF.");
  const folder=join(root,"temp","external-pdf");
  await mkdir(join(root,"temp"),{recursive:true});
  let parentCheck=join(root,"temp");for(;;){if((await lstat(parentCheck)).isSymbolicLink())throw Error("Linked temporary paths are not allowed.");const parent=dirname(parentCheck);if(parent===parentCheck)break;parentCheck=parent;}
  await mkdir(folder,{recursive:true});
  // Verify the directory and all parents through a generated file-independent walk.
  let at=folder;for(;;){if((await lstat(at)).isSymbolicLink())throw Error("Linked temporary paths are not allowed.");const parent=dirname(at);if(parent===at)break;at=parent;}
  const sha=createHash("sha256").update(bytes).digest("hex");
  let total=0,cached:string|undefined;
  for(const entry of await readdir(folder,{withFileTypes:true})){
    if(entry.isSymbolicLink())throw Error("Linked temporary files are not allowed.");
    if(!entry.isFile()||!filePattern.test(entry.name))continue;
    const path=join(folder,entry.name),info=await lstat(path);
    if(ownedCopy(path)){total+=info.size;continue;}
    if(Date.now()-info.mtimeMs>24*60*60*1000){
      try{await unlink(path);continue;}catch{/* An external reader may still have this copy open. */}
    }
    total+=info.size;
    if(entry.name.startsWith(`original-${sha}-`)&&info.size===bytes.length&&
      createHash("sha256").update(await readFile(path)).digest("hex")===sha)cached=path;
  }
  if(cached&&!unique)return cached;
  if(total+bytes.length>MAX_TEMP_BYTES)throw Error("The temporary PDF-copy limit is reached. Use Download original PDF instead. Old temporary copies are cleaned on a later open after 24 hours.");
  const copy=join(folder,`original-${sha}-${randomUUID()}.pdf`);
  await writeFile(copy,bytes,{flag:"wx",mode:0o600});
  return copy;
}
export function windowsPdfLaunch(copy:string,systemRoot:string){
  // The command is constant. The validated generated path is passed as an
  // environment value, never interpolated into PowerShell or cmd syntax.
  return {executable:join(systemRoot,"System32","WindowsPowerShell","v1.0","powershell.exe"),
    args:["-NoLogo","-NoProfile","-NonInteractive","-Command",
      "Start-Process -FilePath $env:ADVISEPOINT_PDF_COPY -ErrorAction Stop"],
    env:{...process.env,ADVISEPOINT_PDF_COPY:copy}};
}
export async function openExternalPdf(root:string,source:string,jobId?:string){
  if(process.platform!=="win32")throw Object.assign(Error("Opening the default PDF app is available in the Windows package. Use Download original PDF instead."),{status:501});
  const systemRoot=process.env.SystemRoot;
  if(!systemRoot||! /^[A-Za-z]:\\/.test(systemRoot))throw Error("Windows system directory was not found. Use Download original PDF instead.");
  await withExternalPrintCopy(root,source,jobId,async copy=>{
    const launch=windowsPdfLaunch(copy,systemRoot);
    await execFileAsync(launch.executable,launch.args,{env:launch.env,windowsHide:true,timeout:15000,maxBuffer:64*1024,shell:false});
  });
}
export async function withExternalPrintCopy(root:string,source:string,jobId:string|undefined,useCopy:(copy:string)=>Promise<void>){
  const job=jobId?copyJob(jobId):undefined;
  if(job?.done)throw Error("This print job has finished.");
  if(job){job.busy++;job.last=Date.now();}
  try{
    const copy=await prepareExternalCopy(root,source,!!job);
    if(job){job.paths.add(copy);if(job.done)return;}
    await useCopy(copy);
  }finally{if(job){job.busy--;await cleanCopyJob(job);}}
}
