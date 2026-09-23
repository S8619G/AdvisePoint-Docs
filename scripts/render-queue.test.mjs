import {test,after} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,existsSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {PDFDocument} from "pdf-lib";
const dir=mkdtempSync(join(tmpdir(),"apd-render-queue-"));
process.env.RAG_DB_PATH=join(dir,"test.db");
process.env.RAG_PAGES_DIR=join(dir,"pages");
process.env.APD_LOG_DIR=join(dir,"logs");
const {scheduleRender,purgePagesForDoc,getRenderQueueSnapshot}=await import("../server/pages.ts");
const {storage,rawDb}=await import("../server/storage.ts");
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(predicate){
  const end=Date.now()+20000;
  while(!predicate()){assert.ok(Date.now()<end,"queue deadline");await delay(25);}
}
function seed(id){
  rawDb.prepare(`INSERT INTO documents (id,title,document_type,audience_json,language,product_model,ingested_at,updated_at,total_chunks)
    VALUES (?,?,'manual','[]','en','',datetime('now'),datetime('now'),0)`).run(id,id);
}
async function pdf(count){
  const d=await PDFDocument.create();
  for(let i=0;i<count;i++)d.addPage([300,300]).drawText(`Page ${i+1}`);
  return Buffer.from(await d.save());
}
after(async()=>{await until(()=>!getRenderQueueSnapshot().running);rawDb.close();rmSync(dir,{recursive:true,force:true});});
test("serial queue deduplicates, cancels deleted active/queued documents and never recreates files",{timeout:30000},async()=>{
  const bytes=await pdf(80);
  for(const id of ["active","deleted-queued","next"])seed(id);
  scheduleRender("active",bytes);scheduleRender("active",bytes);
  scheduleRender("deleted-queued",bytes);scheduleRender("next",await pdf(2));
  assert.equal(getRenderQueueSnapshot().queue_depth,3);
  await until(()=>storage.listPages("active").length>=1);
  purgePagesForDoc("deleted-queued");storage.deleteDocument("deleted-queued");
  purgePagesForDoc("active");storage.deleteDocument("active");
  await until(()=>storage.getRenderStatus("next")?.status==="ready");
  await until(()=>!getRenderQueueSnapshot().running);
  assert.equal(storage.listPages("next").length,2);
  for(const id of ["active","deleted-queued"]){
    assert.equal(storage.getDocument(id),undefined);
    assert.equal(storage.listPages(id).length,0);
    assert.equal(existsSync(join(dir,"pages",id)),false);
  }
});
test("a malformed PDF does not block the next document",{timeout:30000},async()=>{
  seed("broken");seed("recovery");
  scheduleRender("broken",Buffer.from("not a PDF"));
  scheduleRender("recovery",await pdf(1));
  await until(()=>storage.getRenderStatus("recovery")?.status==="ready");
  assert.equal(storage.getRenderStatus("broken").status,"error");
  assert.equal(storage.listPages("recovery").length,1);
});
