// QA: real built HTTP routes + browser controls against disposable data only.
// Strict family/combined filters/top-k/history/URL; Query Reset + delayed replies;
// Upload Reset + active guard/tab persistence; backup mode/label/rotation/restore
// content/defaults/mode switches. Desktop/mobile/light/dark screenshots retained.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import Database from "better-sqlite3";
const root = resolve(import.meta.dirname, ".."), base = "http://127.0.0.1:5199";
const evidence = join(root, "verification/features133");
let temp, server, browser, log = "", types, docs = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
async function api(path, body) {
  const r = await fetch(base + path, body === undefined ? {} : {
    method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(body),
  });
  const data = await r.json(); assert.ok(r.ok, JSON.stringify(data)); return data;
}
async function start() {
  server = spawn(process.execPath, ["dist/index.cjs"], { cwd: root, env: {
    ...process.env, NODE_ENV:"production", PORT:"5199", RAG_DB_PATH:join(temp,"test.db"),
    RAG_PAGES_DIR:join(temp,"pages"), APD_LOG_DIR:join(temp,"logs"), LOCALAPPDATA:temp,
    APPDATA:temp, RAG_NO_SEED:"1", APD_OPEN_BROWSER:"0", APD_LOCAL_TEST:"1",
  }, stdio:["ignore","pipe","pipe"] });
  server.stdout.on("data", b=>log+=b); server.stderr.on("data", b=>log+=b);
  for(let i=0;i<150;i++) { try { if((await fetch(base+"/api/health")).ok)return; } catch {} await delay(100); }
  throw Error(log);
}
async function page(path="/#/query") {
  const p=await browser.newPage({viewport:{width:1440,height:1000}});
  await p.route("https://api.github.com/**",r=>r.abort());
  await p.goto(base+path); return p;
}
before(async()=>{
  temp=mkdtempSync(join(tmpdir(),"apd-features133-")); mkdirSync(evidence,{recursive:true});
  await start(); browser=await chromium.launch({headless:true});
  types=(await api("/api/document-types")).types;
  for(const [i,fam] of ["Alpha"," alpha ","Beta",null,"","   "].entries()){
    const form=new FormData();
    form.append("file",new Blob(["Calibration procedure for common sensor equipment."]),`Fixture-${i}.txt`);
    form.append("metadata",JSON.stringify({title:`Fixture ${i}`,document_type:types[0].key,
      product_model:i===1?"M2":"M1",product_family:fam ?? undefined,tags:["fixture"]}));
    const r=await fetch(base+"/api/upload",{method:"POST",body:form});
    const d=await r.json(); assert.equal(r.status,200,JSON.stringify(d)); docs.push(d.document);
  }
});
after(async()=>{
  await browser?.close();
  if(server?.exitCode===null){server.kill();await new Promise(r=>server.once("exit",r));}
  writeFileSync(join(evidence,"server.log"),log); rmSync(temp,{recursive:true,force:true});
});
test("family filtering: blank/default/strict/case/combined/Any/limit/zero matches",async()=>{
  const search=filters=>api("/api/search",{query:"calibration",top_k:50,filters});
  const ids=r=>[...new Set(r.results.map(x=>x.chunk.parent_id))].sort();
  assert.deepEqual(ids(await search({product_family:"Alpha"})),docs.filter((_,i)=>i!==2).map(d=>d.id).sort());
  assert.deepEqual(ids(await search({product_family:" ALPHA ",selected_family_only:true})),docs.slice(0,2).map(d=>d.id).sort());
  assert.equal(ids(await search({selected_family_only:true})).length,6);
  assert.equal(ids(await search({product_family:"No such family",selected_family_only:true})).length,0);
  assert.deepEqual(ids(await search({product_family:"alpha",selected_family_only:true,product_model:["M1"],
    document_type:[types[0].key],tags:["fixture"]})),[docs[0].id]);
  const limited=await api("/api/search",{query:"calibration",top_k:1,
    filters:{product_family:"Alpha",selected_family_only:true}});
  assert.equal(limited.results.length,1); assert.ok(docs.slice(0,2).some(d=>d.id===limited.results[0].chunk.parent_id));
});
test("Query checkbox/history/URL/reset and persisted empty results",async()=>{
  const p=await page();
  try {
    const box=p.getByTestId("checkbox-selected-family-only");
    assert.equal(await box.isChecked(),false); assert.equal(await box.isDisabled(),true);
    await p.getByTestId("select-filter-family").click(); await p.getByRole("option",{name:"Alpha",exact:true}).click();
    await box.check(); await p.getByTestId("input-query").fill("calibration");
    let response=p.waitForResponse(r=>r.url().endsWith("/api/search"));
    await p.getByTestId("button-search").click(); assert.equal((await response).status(),200);
    await p.waitForFunction(()=>document.querySelectorAll('[data-testid^="card-result-"]').length>0);
    await p.screenshot({path:join(evidence,"query-desktop.png"),fullPage:true});
    await p.waitForURL(/family_only=1/);
    await p.reload(); assert.equal(await box.isChecked(),true);
    response=p.waitForResponse(r=>r.url().endsWith("/api/search"));
    await p.getByTestId("button-search").click(); await response;
    await p.getByTestId("button-reset-query").click();
    assert.equal(await p.getByTestId("input-query").inputValue(),"");
    assert.equal(await box.isChecked(),false); assert.equal(await box.isDisabled(),true);
    assert.equal(await p.locator('[data-testid^="card-result-"]').count(),0);
    assert.equal(await p.getByTestId("input-query").evaluate(e=>e===document.activeElement),true);
    await p.waitForFunction(()=>!location.hash.includes("family=")&&!location.hash.includes("q="));
    const history=await api("/api/query-history");
    assert.ok(history.history.some(e=>e.q==="calibration"&&e.filters.selectedFamilyOnly));
    // History rerun must use restored state, not a stale React closure.
    const historyButton=p.locator('[data-testid^="button-history-row-"]');
    await historyButton.first().waitFor();
    {
      response=p.waitForResponse(r=>r.url().endsWith("/api/search"));
      await historyButton.first().click();
      const req=(await response).request().postDataJSON();
      assert.equal(req.filters.selected_family_only,true);
    }
    await p.getByTestId("button-reset-query").click();
    await p.getByRole("link",{name:"Upload",exact:true}).click();
    await p.getByRole("link",{name:"Query",exact:true}).click();
    assert.equal(await p.locator('[data-testid^="card-result-"]').count(),0);
    await p.setViewportSize({width:375,height:900});
    await p.screenshot({path:join(evidence,"query-mobile.png"),fullPage:true});
    await p.emulateMedia({colorScheme:"dark"});
    await p.evaluate(()=>document.documentElement.classList.add("dark"));
    await p.screenshot({path:join(evidence,"query-dark.png"),fullPage:true});
  } finally {await p.close();}
});
test("Query Reset ignores a delayed pre-reset success and keeps new results",async()=>{
  const p=await page(); let release, seen;
  const started=new Promise(r=>seen=r), paused=new Promise(r=>release=r);
  try {
    const data=await api("/api/search",{query:"calibration",top_k:10});
    await p.route("**/api/search",async route=>{seen();await paused;await route.fulfill({json:data});});
    await p.getByTestId("input-query").fill("old request");
    await p.getByTestId("button-search").click(); await started;
    await p.getByTestId("button-reset-query").click();
    await p.getByRole("link",{name:"Upload",exact:true}).click();
    await p.getByRole("link",{name:"Query",exact:true}).click();
    release(); await delay(250);
    assert.equal(await p.locator('[data-testid^="card-result-"]').count(),0);
    assert.equal(await p.getByTestId("input-query").inputValue(),"");
    await p.unroute("**/api/search");
    await p.getByTestId("input-query").fill("calibration");
    const r=p.waitForResponse(r=>r.url().endsWith("/api/search"));
    await p.getByTestId("button-search").click(); await r;
    await p.waitForFunction(()=>document.querySelectorAll('[data-testid^="card-result-"]').length>0);
  } finally {release?.();await p.close();}
});
test("Upload Reset clears completed feedback, preserves failed/pending rows and active guard",async()=>{
  const p=await page("/#/upload");
  try {
    await p.getByTestId("input-file").setInputFiles([
      {name:"Good.txt",mimeType:"text/plain",buffer:Buffer.from("Service setup instructions for upload reset testing.")},
      {name:"Broken.pdf",mimeType:"application/pdf",buffer:Buffer.from("not a PDF")},
    ]);
    await p.getByTestId("button-ingest").click();
    await p.getByTestId("card-preview").getByText("Added 1 document to your library.",{exact:true}).waitFor();
    await p.waitForFunction(()=>!document.querySelector('[data-testid="button-reset-upload-results"]').disabled);
    const before=(await api("/api/search",{query:"service",top_k:50})).results.length;
    await p.screenshot({path:join(evidence,"upload-results-desktop.png"),fullPage:true});
    await p.getByTestId("button-reset-upload-results").click();
    await p.getByTestId("text-preview-empty").waitFor();
    assert.equal(await p.locator('[data-testid^="text-file-name-"]').getByText("Broken.pdf",{exact:true}).count(),1);
    assert.equal((await api("/api/search",{query:"service",top_k:50})).results.length,before);
    await p.getByRole("link",{name:"Query",exact:true}).click(); await p.getByRole("link",{name:"Upload",exact:true}).click();
    await p.getByTestId("text-preview-empty").waitFor();
    await p.getByTestId("button-clear-all").click();
    // Pasted text may finish while the route is unmounted. Reset must remain guarded.
    await p.getByTestId("input-title").fill("Pasted reset test");
    await p.getByTestId("input-body").fill("Pasted service setup guide.");
    let release, seen;
    const started=new Promise(r=>seen=r), paused=new Promise(r=>release=r);
    await p.route("**/api/ingest",async r=>{seen();await paused;await r.continue();});
    await p.getByTestId("button-ingest").click(); await started;
    assert.equal(await p.getByTestId("button-reset-upload-results").isDisabled(),true);
    await p.getByRole("link",{name:"Query",exact:true}).click(); await p.getByRole("link",{name:"Upload",exact:true}).click();
    assert.equal(await p.getByTestId("button-reset-upload-results").isDisabled(),true);
    release();
    await p.getByTestId("card-preview").getByText(/Added \d+ searchable excerpts/).waitFor();
    await p.getByTestId("button-reset-upload-results").click();
    await p.getByTestId("text-preview-empty").waitFor();
    await p.setViewportSize({width:375,height:900});
    await p.screenshot({path:join(evidence,"upload-mobile.png"),fullPage:true});
  } finally {await p.close();}
});
async function runBackup(folder, mode, extra={}) {
  const prev=(await api("/api/backup/settings")).settings.last_run_finished_at;
  await api("/api/backup/settings",{folder,mode,cadence:"off",run_now:true,...extra});
  for(let i=0;i<200;i++){
    const s=(await api("/api/backup/settings")).settings;
    if(s.last_run_finished_at!==prev) {assert.equal(s.last_run_status,"success",JSON.stringify(s));return s;}
    await delay(75);
  }
  throw Error("backup timed out");
}
test("real ZIP pair verifies restore data, preserves old/manual files and modes/defaults",async()=>{
  await delay(10200); // Respect the real server's 30 writes/10s limit; never disable it.
  // Exercise required retained originals, not only metadata-only text entries.
  const { PDFDocument } = await import("pdf-lib");
  const pdf = await PDFDocument.create(); pdf.addPage().drawText("Backup verification sample");
  const pdfForm = new FormData();
  pdfForm.append("file", new Blob([await pdf.save()]), "PairSample.pdf");
  pdfForm.append("metadata",JSON.stringify({title:"Pair sample PDF",document_type:types[0].key}));
  const pdfReply = await fetch(base+"/api/upload",{method:"POST",body:pdfForm});
  const pdfData=await pdfReply.json();assert.equal(pdfReply.status,200,JSON.stringify(pdfData));
  const folder=join(temp,"backups");mkdirSync(folder);
  const initial=(await api("/api/backup/settings")).settings;
  assert.equal(initial.mode,"count"); assert.equal(initial.retention_count,7);
  writeFileSync(join(folder,"manual-master.zip"),"private manual sentinel");
  let s=await runBackup(folder,"pair");
  assert.ok(s.pair.latest);assert.equal(s.pair.previous,null);
  const first=s.pair.latest;
  s=await runBackup(folder,"pair");assert.deepEqual(s.pair.previous,first);
  s=await runBackup(folder,"pair");
  const dir=join(folder,"AdvisePoint-Scheduled-Pair");
  assert.equal(readdirSync(dir).filter(n=>n.endsWith(".zip")).length,2);
  // Real read-only restore preflight against BOTH retained archives.
  for(const c of [s.pair.latest,s.pair.previous]){
    // Independently extract for database/content verification; never invoke a
    // production restore route or mutate even the running synthetic library.
    const { execFileSync }=await import("node:child_process");
    const out=join(temp,`inspect-${c.file}`);mkdirSync(out);
    execFileSync("unzip",["-q",join(dir,c.file),"-d",out]);
    const db=new Database(join(out,"db/data.db"),{readonly:true});
    assert.equal(db.pragma("integrity_check",{simple:true}),"ok");
    assert.ok(db.prepare("SELECT count(*) AS n FROM documents").get().n>=docs.length);
    assert.ok(readFileSync(join(out,"originals",`${pdfData.document.id}.pdf`)).includes(Buffer.from("%PDF-")));
    db.close();
  }
  // Missing required original rejects the candidate and leaves both roles unchanged.
  const originalPath=join(temp,"originals",`${pdfData.document.id}.pdf`);
  const originalBytes=readFileSync(originalPath);rmSync(originalPath);
  const roles={latest:s.pair.latest,previous:s.pair.previous};
  await assert.rejects(runBackup(folder,"pair"), /failed/);
  const afterFailure=(await api("/api/backup/settings")).settings.pair;
  assert.deepEqual({latest:afterFailure.latest,previous:afterFailure.previous},roles);
  writeFileSync(originalPath,originalBytes);
  s=await runBackup(folder,"pair");
  const pairBytes=readFileSync(join(dir,"pair-state.json"));
  await runBackup(folder,"count",{retention_count:1});
  assert.deepEqual(readFileSync(join(dir,"pair-state.json")),pairBytes);
  assert.equal(readFileSync(join(folder,"manual-master.zip"),"utf8"),"private manual sentinel");
  assert.equal((await api("/api/backup/settings",{mode:"pair"})).settings.retention_count,1);
  assert.equal((await api("/api/backup/settings",{mode:"count"})).settings.retention_count,1);
  const invalid=await fetch(base+"/api/backup/settings",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mode:"invalid"})});
  assert.equal(invalid.status,400);
});
test("backup label, mode controls, retained count and desktop/mobile layout",async()=>{
  const p=await page("/#/schema");
  try {
    await p.getByTestId("tab-backup-restore").click();
    await p.getByLabel("Backups to keep",{exact:true}).fill("7");
    await p.getByTestId("select-backup-mode").click();
    await p.getByRole("option",{name:"Latest backup + previous backup",exact:true}).click();
    assert.equal(await p.getByTestId("input-backups-to-keep").inputValue(),"2");
    assert.equal(await p.getByTestId("input-backups-to-keep").isDisabled(),true);
    await p.getByTestId("schedule-save").click();
    await p.getByTestId("backup-pair-status").waitFor();
    await p.evaluate(()=>window.scrollTo(0,0));
    await p.screenshot({path:join(evidence,"backup-pair-desktop.png"),fullPage:true});
    await p.getByTestId("select-backup-mode").click();
    await p.getByRole("option",{name:"Keep a set number of backups",exact:true}).click();
    assert.equal(await p.getByTestId("input-backups-to-keep").inputValue(),"7");
    await p.getByTestId("select-backup-mode").click();
    await p.getByRole("option",{name:"Latest backup + previous backup",exact:true}).click();
    await p.setViewportSize({width:375,height:900});
    await p.screenshot({path:join(evidence,"backup-pair-mobile.png"),fullPage:true});
    assert.equal(await p.getByTestId("backup-scheduled").evaluate(e=>e.scrollWidth<=e.clientWidth+1),true);
  } finally {await p.close();}
});
