import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {spawn,execFileSync} from "node:child_process";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,readdirSync,rmSync} from "node:fs";
import {join,resolve,basename} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {createRequire} from "node:module";
import {PDFDocument,StandardFonts} from "pdf-lib";
import JSZip from "jszip";
import Database from "better-sqlite3";
const require=createRequire(import.meta.url),compat=require("../server/workers/pdf-compat.cjs");
const root=resolve(import.meta.dirname,".."),base="http://127.0.0.1:5221";
const digest=b=>createHash("sha256").update(b).digest("hex");
const engine=process.env.APD_ENGINE_TEST_EXE;
let temp,server,log="",kind,plain,restricted,convertedId,backup;
const json=async p=>(await fetch(base+p)).json();
async function start(){
  server=spawn(process.execPath,["dist/index.cjs"],{cwd:root,env:{...process.env,
    NODE_ENV:"production",PORT:"5221",RAG_DB_PATH:join(temp,"advisepoint.db"),
    RAG_PAGES_DIR:join(temp,"pages"),APD_LOG_DIR:join(temp,"logs"),
    RAG_NO_SEED:"1",RAG_NO_IDLE_SHUTDOWN:"1",APD_LOCAL_TEST:"1"},stdio:["ignore","pipe","pipe"]});
  server.stdout.on("data",b=>log+=b);server.stderr.on("data",b=>log+=b);
  for(let i=0;i<200;i++){if(server.exitCode!==null)throw Error(log);
    try{if((await fetch(base+"/api/health")).ok)return}catch{}await new Promise(r=>setTimeout(r,100))}
  throw Error("Server startup timeout");
}
async function stop(){if(server?.exitCode===null){server.kill();await new Promise(r=>server.once("exit",r))}}
async function upload(name,bytes,mode){
  const fd=new FormData();fd.append("file",new Blob([bytes]),name);
  fd.append("metadata",JSON.stringify({title:name,document_type:kind}));
  if(mode)fd.append("pdf_import_mode",mode);
  const r=await fetch(base+"/api/upload",{method:"POST",body:fd});
  return {status:r.status,data:await r.json()};
}
const count=async()=> (await json("/api/document-types")).types.find(t=>t.key===kind).document_count;
before(async()=>{
  assert.ok(engine,"Set APD_ENGINE_TEST_EXE to pinned Linux QPDF 12.4.1");
  temp=mkdtempSync(join(tmpdir(),"apd-v131-"));mkdirSync(join(root,"verification"),{recursive:true});
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
  for(let n=1;n<=54;n++)pdf.addPage([200,250]).drawText(`Page ${n} Dealer service manual searchable text`,{x:5,y:100,size:6,font});
  plain=Buffer.from(await pdf.save());writeFileSync(join(temp,"plain.pdf"),plain);
  execFileSync(engine,["--encrypt","","owner","256","--extract=n","--",join(temp,"plain.pdf"),join(temp,"restricted.pdf")]);
  restricted=readFileSync(join(temp,"restricted.pdf"));await start();
  kind=(await json("/api/document-types")).types[0].key;
});
after(async()=>{await stop();writeFileSync(join(root,"verification/v131-server.log"),log);
  writeFileSync(join(root,"verification/v131-test-library.txt"),temp+"\n")});
test("normal PDF stays byte-identical; restricted PDF imports automatically as one validated file",async()=>{
  const a=await upload("normal.pdf",plain);assert.equal(a.status,200,JSON.stringify(a));
  assert.equal(a.data.pdf_prepared,false);assert.equal(a.data.document.pdf_compatibility,null);
  assert.deepEqual(Buffer.from(await(await fetch(base+`/api/documents/${a.data.document.id}/original`)).arrayBuffer()),plain);
  const b=await upload("restricted.pdf",restricted);assert.equal(b.status,200,JSON.stringify(b));
  convertedId=b.data.document.id;assert.equal(b.data.pdf_prepared,true);
  const stored=readFileSync(join(temp,"originals",convertedId+".pdf"));
  assert.notEqual(digest(stored),digest(restricted));assert.equal(b.data.document.file_hash_sha256,digest(stored));
  assert.equal(JSON.parse(b.data.document.pdf_compatibility).source_sha256,digest(restricted));
  assert.equal(readdirSync(join(temp,"originals")).length,2);
  assert.equal(readdirSync(join(temp,".pdf-import-work")).length,0);
  assert.ok(!existsSync(join(temp,"pages",convertedId)));
  assert.equal((await json(`/api/documents/${convertedId}/pages`)).pages.length,54);
  assert.equal(await count(),2);
});
test("supplied 76-page manual: complete import, source unchanged, one smaller PDF",async()=>{
  if(!process.env.APD_SAMPLE_PDF)throw Error("Provide the supplied manual using APD_SAMPLE_PDF");
  const source=readFileSync(process.env.APD_SAMPLE_PDF);
  const u=await upload("CloudCaptureENOGR2025_12_17-CustomerAdminGuide.pdf",source);
  assert.equal(u.status,200,JSON.stringify(u));assert.equal(u.data.extraction.page_count,76);
  const stored=readFileSync(join(temp,"originals",u.data.document.id+".pdf"));
  assert.equal(digest(readFileSync(process.env.APD_SAMPLE_PDF)),digest(source));
  assert.ok(stored.length<source.length);assert.equal(u.data.pdf_prepared,true);
  writeFileSync(join(root,"verification/converted-sample.pdf"),stored);
  writeFileSync(join(root,"verification/sample-result.json"),JSON.stringify({
    id:u.data.document.id,pages:76,inputBytes:source.length,outputBytes:stored.length,
    sourceSHA256:digest(source),retainedSHA256:digest(stored)},null,2));
});
test("password, no-print, low-quality-only and malformed PDFs leave no imported row",async()=>{
  const beforeCount=await count(),files=readdirSync(join(temp,"originals")).length;
  for(const [name,args,code] of [
    ["password",["--encrypt","secret","owner","256","--"],"PDF_PASSWORD_REQUIRED"],
    ["no-print",["--encrypt","","owner","256","--extract=n","--print=none","--"],"PDF_RENDER_RESTRICTED"],
    ["low-print",["--encrypt","","owner","256","--extract=n","--print=low","--"],"PDF_RENDER_RESTRICTED"]]){
    const file=join(temp,name+".pdf");execFileSync(engine,[...args,join(temp,"plain.pdf"),file]);
    const r=await upload(name+".pdf",readFileSync(file));assert.equal(r.status,422);
    assert.equal(r.data.code,code);assert.equal(r.data.fallback_available,false);
  }
  const broken=await upload("broken.pdf",Buffer.from("%PDF-1.7 broken"));
  assert.notEqual(broken.status,200);assert.equal(await count(),beforeCount);
  assert.equal(readdirSync(join(temp,"originals")).length,files);
});
test("native and compatible deletion restores PDF, geometry, search, provenance and type count",async()=>{
  const beforeCount=await count(),bytes=readFileSync(join(temp,"originals",convertedId+".pdf"));
  const removed=await(await fetch(base+`/api/documents/${convertedId}`,{method:"DELETE"})).json();
  assert.equal(await count(),beforeCount-1);assert.equal(removed.reversible,true);
  assert.ok(existsSync(join(removed.quarantine_dir,"page-rows.json")));
  const restored=await fetch(base+`/api/documents/removed/${encodeURIComponent(basename(removed.quarantine_dir))}/restore`,{method:"POST"});
  assert.equal(restored.status,200,await restored.text());assert.equal(await count(),beforeCount);
  assert.deepEqual(readFileSync(join(temp,"originals",convertedId+".pdf")),bytes);
  assert.equal((await json(`/api/documents/${convertedId}/pages`)).pages.length,54);
  assert.equal((await json(`/api/documents/${convertedId}/pages/status`)).status,"ready");
  assert.equal((await json(`/api/documents/${convertedId}`)).document.pdf_prepared,true);
  // Older quarantine folder: derive geometry from its retained PDF.
  const old=await(await fetch(base+`/api/documents/${convertedId}`,{method:"DELETE"})).json();
  rmSync(join(old.quarantine_dir,"page-rows.json"));
  const again=await fetch(base+`/api/documents/removed/${encodeURIComponent(basename(old.quarantine_dir))}/restore`,{method:"POST"});
  assert.equal(again.status,200,await again.text());
  assert.equal((await json(`/api/documents/${convertedId}/pages`)).pages.length,54);
});
test("whole-document handoff identifies compatible copy; subsets remain prepared",async()=>{
  const whole=await(await fetch(base+`/api/pdf/print/${convertedId}?from=1&to=54`)).text();
  assert.match(whole,/Open compatible PDF/);assert.doesNotMatch(whole,/Open original PDF/);
  const range=await(await fetch(base+`/api/pdf/print/${convertedId}?from=2&to=53`)).text();
  assert.match(range,/pdf-print.js/);assert.doesNotMatch(range,/pdf-handoff.js/);
});
test("backup carries only retained PDFs and provenance; merge restore retains viewer geometry",async()=>{
  const r=await fetch(base+"/api/backup/export");assert.equal(r.status,200);
  backup=Buffer.from(await r.arrayBuffer());const z=await JSZip.loadAsync(backup);
  assert.equal(Object.keys(z.files).filter(n=>n.startsWith("originals/")&&n.endsWith(".pdf")).length,3);
  assert.equal(Object.keys(z.files).some(n=>n.includes("pdf-import-work")),false);
  const originalTemp=temp;await stop();temp=mkdtempSync(join(tmpdir(),"apd-v131-restore-"));await start();
  const fd=new FormData();fd.append("file",new Blob([backup]),"test.zip");fd.append("mode","merge");
  const merged=await fetch(base+"/api/backup/import",{method:"POST",body:fd});
  assert.equal(merged.status,200,await merged.text());assert.equal(await count(),3);
  assert.equal((await json(`/api/documents/${convertedId}/pages`)).pages.length,54);
  assert.equal((await json(`/api/documents/${convertedId}`)).document.pdf_prepared,true);
  assert.deepEqual(readFileSync(join(temp,"originals",convertedId+".pdf")),readFileSync(join(originalTemp,"originals",convertedId+".pdf")));
});
test("document type counts track reassignment, zero-use types and deletion without restart",async()=>{
  let r=await fetch(base+"/api/document-types",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({label:"Compatibility Test"})});
  assert.equal(r.status,201);const registry=await r.json();
  const target=registry.types.find(t=>t.label==="Compatibility Test");assert.equal(target.document_count,0);
  const beforeCount=await count();
  r=await fetch(base+`/api/documents/${convertedId}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({document_type:target.key})});
  assert.equal(r.status,200);assert.equal(await count(),beforeCount-1);
  assert.equal((await json("/api/document-types")).types.find(t=>t.key===target.key).document_count,1);
});
test("cancelled, missing-engine and mismatched-content preparations fail closed and clean temporary files",async()=>{
  const work=join(temp,"unit-work"),controller=new AbortController();controller.abort();
  await assert.rejects(compat.prepare(restricted,{root:work,engine,signal:controller.signal}));
  assert.deepEqual(readdirSync(work),[]);
  await assert.rejects(compat.prepare(restricted,{root:work,engine:join(temp,"missing.exe")}));
  assert.deepEqual(readdirSync(work),[]);
  const page={width:100,height:200},a={pages:[page],canCopy:false,pageTextHashes:["a"]};
  assert.throws(()=>compat.validate(a,{pages:[page],canCopy:true,pageTextHashes:["b"]}));
  assert.equal(compat.isBusy(),false);
});
test("engine warnings, timeout and in-flight cancellation never count as success",async()=>{
  await assert.rejects(compat.runEngine(process.execPath,["-e","process.exit(3)"]),/warnings/);
  await assert.rejects(compat.runEngine(process.execPath,["-e","setInterval(()=>{},1000)"],{timeout:50}),/timed out/);
  const controller=new AbortController();
  const running=compat.runEngine(process.execPath,["-e","setInterval(()=>{},1000)"],{signal:controller.signal});
  setTimeout(()=>controller.abort(),50);
  await assert.rejects(running,/cancelled/);
});
