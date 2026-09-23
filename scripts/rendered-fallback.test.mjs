// Built candidate regression and supplied-manual acceptance. Disposable data only.
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {spawn,execFileSync} from "node:child_process";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,readdirSync,statSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {createHash} from "node:crypto";
import {PDFDocument,StandardFonts} from "pdf-lib";
import {chromium} from "playwright";
import JSZip from "jszip";
import Database from "better-sqlite3";
const root=resolve(import.meta.dirname,".."),base="http://127.0.0.1:5194";
let temp,server,browser,types,restricted,output="",manualId;
const evidence={checks:[],manual:null};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const json=async path=>(await fetch(base+path)).json();
async function start(){
  server=spawn(process.execPath,["dist/index.cjs"],{cwd:root,env:{...process.env,
    NODE_ENV:"production",PORT:"5194",LOCALAPPDATA:temp,RAG_DB_PATH:join(temp,"advisepoint.db"),
    RAG_PAGES_DIR:join(temp,"pages"),APD_LOG_DIR:join(temp,"logs"),
    RAG_NO_SEED:"1",RAG_NO_IDLE_SHUTDOWN:"1",APD_OPEN_BROWSER:"0",APD_LOCAL_TEST:"1"},stdio:["ignore","pipe","pipe"]});
  server.stdout.on("data",b=>output+=b);server.stderr.on("data",b=>output+=b);
  for(let n=0;n<200;n++){if(server.exitCode!==null)throw Error(output);try{if((await fetch(base+"/api/health")).ok)return;}catch{}await delay(100);}
  throw Error(output);
}
async function stop(){if(server?.exitCode===null){server.kill();await new Promise(r=>server.once("exit",r));}}
async function upload(name,bytes,mode){
  const f=new FormData();f.append("file",new Blob([bytes]),name);
  f.append("metadata",JSON.stringify({title:name,document_type:types[0].key}));
  if(mode)f.append("pdf_import_mode",mode);
  const r=await fetch(base+"/api/upload",{method:"POST",body:f});
  return {status:r.status,data:await r.json(),id:r.headers.get("x-upload-id")};
}
async function rendered(id,timeout=900000){
  const deadline=Date.now()+timeout;let status;
  while(Date.now()<deadline){
    status=await json(`/api/documents/${id}/pages/status`);
    const s=status.status;
    if(s==="ready"){assert.equal(status.error,null);assert.equal(status.rendered,status.total);return status;}
    if(s==="error")throw Error(JSON.stringify(status));
    await delay(1000);
  }throw Error("Rendering deadline: "+JSON.stringify(status));
}
before(async()=>{
  temp=mkdtempSync(join(tmpdir(),"apd-fallback-"));mkdirSync(join(root,"verification"),{recursive:true});
  await start();types=(await json("/api/document-types")).types;
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
  for(let n=1;n<=2;n++)pdf.addPage().drawText("FallbackSearchToken searchable printer manual page "+n,{font,x:30,y:600,size:12});
  writeFileSync(join(temp,"plain.pdf"),await pdf.save());
  restricted=join(temp,"restricted.pdf");
  execFileSync("qpdf",["--encrypt","","owner-secret","256","--extract=n","--",join(temp,"plain.pdf"),restricted]);
  browser=await chromium.launch({headless:true});
});
after(async()=>{
  await browser?.close();await stop();
  writeFileSync(join(root,"verification/fallback-results.json"),JSON.stringify({...evidence,temp},null,2));
  writeFileSync(join(root,"verification/fallback-server.log"),output);
});
test("restriction is actionable without residue; malformed, password and no-print requests fail safely",async()=>{
  const count=(await json("/api/stats")).documents;
  const r=await upload("restricted.pdf",readFileSync(restricted));
  assert.equal(r.status,422);assert.equal(r.data.fallback_available,true);assert.equal(r.id,r.data.upload_id);
  assert.equal((await json("/api/stats")).documents,count);
  assert.equal((await upload("wrong.txt",Buffer.from("a long enough text input for testing"),"rendered")).status,400);
  assert.equal((await upload("bad.pdf",Buffer.from("not a PDF"),"rendered")).status,500);
  for(const [name,password,options,code] of [
    ["password.pdf","secret",[],"PDF_PASSWORD_REQUIRED"],
    ["lowprint.pdf","",["--extract=n","--print=low"],"PDF_RENDER_RESTRICTED"],
    ["noprint.pdf","",["--extract=n","--print=none"],"PDF_RENDER_RESTRICTED"]]){
    const file=join(temp,name);
    execFileSync("qpdf",["--encrypt",password,"owner-secret","256",...options,"--",join(temp,"plain.pdf"),file]);
    const response=await upload(name,readFileSync(file),"rendered");
    assert.equal(response.status,422);assert.equal(response.data.code,code);assert.equal(response.data.fallback_available,false);
  }
  assert.equal((await json("/api/stats")).documents,count);
  evidence.checks.push("Restriction, malformed PDF, password, no-print and invalid mode leave no documents.");
});
test("real browser shows storage warning; cancel/skip do not import; explicit retry renders and remains searchable",async()=>{
  const p=await browser.newPage();await p.goto(base+"/#/upload");
  await p.locator('input[type=file]:not([webkitdirectory])').setInputFiles(restricted);
  await p.getByTestId("button-ingest").click();
  await p.getByTestId("button-rendered-fallback").click();
  await p.getByTestId("dialog-rendered-fallback").waitFor();
  await p.getByText(/library and backups can become substantially larger/).waitFor();
  await p.screenshot({path:join(root,"verification/fallback-warning.png")});
  await p.getByRole("button",{name:"Not now",exact:true}).click();
  assert.equal((await json("/api/stats")).documents,0);
  await p.getByRole("button",{name:"Skip this file",exact:true}).click();
  assert.equal(await p.getByTestId("button-rendered-fallback").count(),0);
  await p.locator('input[type=file]:not([webkitdirectory])').setInputFiles(restricted);
  await p.getByTestId("button-ingest").click();await p.getByTestId("button-rendered-fallback").click();
  const response=p.waitForResponse(r=>r.url()===base+"/api/upload"&&r.status()===200);
  await p.getByTestId("button-confirm-rendered-fallback").click();
  const data=await (await response).json();assert.equal(data.viewer,"page-images");await rendered(data.document.id,60000);
  const s=await fetch(base+"/api/search",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({query:"FallbackSearchToken",top_k:5})});
  assert.ok((await s.json()).results.some(r=>r.parent?.id===data.document.id));
  assert.equal((await fetch(base+`/api/documents/${data.document.id}/pages/2.jpg`)).status,200);
  assert.equal((await json("/api/backup/size")).original_bytes,statSync(restricted).size);
  assert.equal((await json(`/api/documents/${data.document.id}/pages`)).viewer,"page-images");
  assert.deepEqual(Buffer.from(await (await fetch(base+`/api/documents/${data.document.id}/original`)).arrayBuffer()),readFileSync(restricted));
  await p.close();evidence.checks.push("Explicit confirmation, cancel/skip, legacy search, rendered image delivery, unchanged original retained without switching viewer.");
});
test("mixed batch continues after one rejection and journals all three outcomes",async()=>{
  const p=await browser.newPage(),responses=[];
  p.on("response",r=>{if(r.url()===base+"/api/upload")responses.push(r);});
  const count=(await json("/api/stats")).documents;
  await p.goto(base+"/#/upload");
  await p.getByTestId("input-file").setInputFiles([
    {name:"batch-first.txt",mimeType:"text/plain",buffer:Buffer.from("First batch item has searchable printer maintenance information.")},
    {name:"batch-restricted.pdf",mimeType:"application/pdf",buffer:readFileSync(restricted)},
    {name:"batch-last.txt",mimeType:"text/plain",buffer:Buffer.from("Last batch item has searchable scanner maintenance information.")},
  ]);
  await p.getByTestId("button-ingest").click();
  await p.waitForFunction(()=>document.querySelectorAll('[data-testid^="file-row-"]').length===1);
  assert.deepEqual(responses.map(r=>r.status()),[200,422,200]);
  assert.equal((await json("/api/stats")).documents,count+2);
  assert.equal(await p.getByTestId("button-rendered-fallback").count(),1);
  const lines=readFileSync(join(temp,"logs/uploads.log"),"utf8").trim().split("\n").map(JSON.parse);
  for(const name of ["batch-first.txt","batch-restricted.pdf","batch-last.txt"])
    assert.ok(lines.some(r=>r.filename===name&&r.event==="request_finished"));
  await p.close();evidence.checks.push("Mixed batch completes 2/3; rejected PDF stays actionable; all outcomes logged.");
});
test("supplied 724-page manual: all pages render, search index and hashes survive restart",{timeout:1200000},async()=>{
  const file=process.env.APD_RESTRICTED_MANUAL;
  assert.ok(file,"APD_RESTRICTED_MANUAL must point to the supplied manual.");
  const bytes=readFileSync(file),began=Date.now(),r=await upload("7353ci_8353ciENOGR2019_6.pdf",bytes,"rendered");
  assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.extraction.page_count,724);
  assert.ok(r.data.chunks.length>0);manualId=r.data.document.id;
  const status=await rendered(manualId);
  const db=new Database(join(temp,"advisepoint.db"),{readonly:true});
  const doc=db.prepare("SELECT * FROM documents WHERE id=?").get(manualId);
  assert.equal(doc.file_hash_sha256,createHash("sha256").update(bytes).digest("hex"));
  assert.equal(doc.original_ext,"pdf");assert.equal(doc.pdf_rendered,1);db.close();
  const imageDir=join(temp,"pages",manualId),images=readdirSync(imageDir);
  assert.equal(images.length,724);
  const imageBytes=images.reduce((s,f)=>s+statSync(join(imageDir,f)).size,0);
  for(const n of [1,362,724]){
    const response=await fetch(base+`/api/documents/${manualId}/pages/${n}.jpg`);
    assert.equal(response.status,200);assert.ok((await response.arrayBuffer()).byteLength>1000);
  }
  const p=await browser.newPage();await p.goto(base+`/#/library/${manualId}`);
  await p.getByTestId("button-view-pages").click();
  await p.getByTestId("input-page-jump").fill("724");await p.getByTestId("input-page-jump").press("Enter");
  await p.waitForFunction(()=>[...document.querySelectorAll("img")].some(i=>i.src.includes("/pages/724.jpg")&&i.complete&&i.naturalWidth>0),null,{timeout:30000});
  await p.screenshot({path:join(root,"verification/fallback-manual-last-page.png")});await p.close();
  evidence.manual={pages:724,rendered:status.rendered,input_bytes:bytes.length,image_bytes:imageBytes,
    excerpts:r.data.chunks.length,elapsed_seconds:(Date.now()-began)/1000,document_id:manualId};
  console.log("MANUAL_RESULT",JSON.stringify(evidence.manual));
  await stop();await start();assert.equal((await json(`/api/documents/${manualId}/pages/status`)).rendered,724);
  const logs=readFileSync(join(temp,"logs/uploads.log"),"utf8").trim().split("\n").map(JSON.parse);
  assert.ok(logs.filter(r=>r.event==="session_started").length>=2);
  assert.ok(logs.some(r=>r.event==="render_finished"&&r.document_id===manualId&&r.rendered===724));
  const diagnostic=await fetch(base+"/api/diagnostics/export");assert.equal(diagnostic.status,200);
  const z=await JSZip.loadAsync(await diagnostic.arrayBuffer());
  const logName=Object.keys(z.files).find(n=>n.endsWith("uploads.log"));assert.ok(logName);
  assert.match(await z.file(logName).async("string"),/render_finished/);
  evidence.checks.push("724 complete page images, binary hash, indexed excerpts, restart persistence, ordinary diagnostics includes journal.");
});
