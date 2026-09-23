// Candidate 7 QA inventory: real in-app controls, no prep tab, both PDF types,
// PDF/download handoff without dismissal or regeneration, Done/Escape/Close,
// cancellation/retry, inaccessible cleanup, invalid origins, source preservation.
// Linux Chromium/Firefox automation does not certify Windows printing or Edge.
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {get as httpGet} from "node:http";
import {mkdtempSync,mkdirSync,readdirSync,linkSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {randomUUID,createHash} from "node:crypto";
import Database from "better-sqlite3";
import {PDFDocument,StandardFonts} from "pdf-lib";
import {chromium,firefox} from "playwright";
const root=resolve(import.meta.dirname,".."),base="http://127.0.0.1:5198",fixture=process.env.APD_RENDER_FIXTURE;
const headers={"Content-Type":"application/json",Origin:base,"X-APD-PDF-Action":"rendered-print"};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const evidence={checks:[],browsers:[],errors:[],windows:"NOT TESTED",physical_print:"NOT TESTED"};
let temp,server,manual,native,originalHash,output="";
const digest=b=>createHash("sha256").update(b).digest("hex");
const api=(path,body,h=headers)=>fetch(base+path,body?{method:"POST",headers:h,body:JSON.stringify(body)}:undefined);
before(async()=>{
  assert.ok(fixture,"APD_RENDER_FIXTURE must point to the disposable 724-page fixture.");
  temp=mkdtempSync(join(tmpdir(),"apd-print-dialog-"));
  const old=new Database(join(fixture,"advisepoint.db"),{readonly:true});
  manual=old.prepare("SELECT d.id FROM documents d JOIN document_render_status r ON r.document_id=d.id WHERE d.original_ext IS NULL AND r.total=724 AND d.title LIKE '%7353%'").get().id;
  await old.backup(join(temp,"advisepoint.db"));old.close();
  mkdirSync(join(temp,"pages",manual),{recursive:true});
  for(const name of readdirSync(join(fixture,"pages",manual)))linkSync(join(fixture,"pages",manual,name),join(temp,"pages",manual,name));
  server=spawn(process.execPath,["dist/index.cjs"],{cwd:root,env:{...process.env,NODE_ENV:"production",PORT:"5198",
    RAG_DB_PATH:join(temp,"advisepoint.db"),RAG_PAGES_DIR:join(temp,"pages"),APD_LOG_DIR:join(temp,"logs"),
    RAG_NO_SEED:"1",RAG_NO_IDLE_SHUTDOWN:"1",APD_LOCAL_TEST:"1"},stdio:["ignore","pipe","pipe"]});
  server.stdout.on("data",b=>output+=b);server.stderr.on("data",b=>output+=b);
  for(let n=0;n<200;n++){try{if((await api("/api/health")).ok)break;}catch{}await delay(100);}
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
  for(let n=1;n<=120;n++){const p=pdf.addPage();p.drawText(`Candidate seven retained print PageToken${n}`,{font,x:30,y:100,size:14});}
  const bytes=await pdf.save();originalHash=digest(bytes);
  const types=await (await api("/api/document-types")).json(),form=new FormData();
  form.append("file",new Blob([bytes]),"Candidate-seven-print.pdf");
  form.append("metadata",JSON.stringify({title:"Candidate seven print fixture",document_type:types.types[0].key}));
  const r=await fetch(base+"/api/upload",{method:"POST",body:form}),j=await r.json();
  assert.equal(r.status,200,JSON.stringify(j));native=j.document.id;
});
after(async()=>{
  if(server?.exitCode===null){server.kill();await new Promise(r=>server.once("exit",r));}
  writeFileSync(join(root,"verification/candidate13-dialog-results.json"),JSON.stringify({...evidence,temp},null,2));
  writeFileSync(join(root,"verification/candidate13-dialog-server.log"),output);
  rmSync(temp,{recursive:true,force:true});
});
async function viewer(browser,id){
  const context=await browser.newContext({viewport:{width:1280,height:920}});
  const p=await context.newPage();p.on("pageerror",e=>evidence.errors.push(e.message));
  await p.goto(`${base}/#/library/${id}`);await p.getByTestId("button-view-pages").click();
  await p.getByTestId("button-print-page").waitFor();
  return {context,p};
}
async function prepare(p,from=1,to=2,mode="range"){
  await p.getByTestId("button-print-page").click();await p.getByTestId(`radio-print-${mode}`).check();
  if(mode==="range"){await p.getByTestId("input-print-from").fill(String(from));await p.getByTestId("input-print-to").fill(String(to));}
  await p.getByTestId("button-print-confirm").click();
  const frame=p.frameLocator('[data-testid="print-preparation-frame"]');
  return frame;
}
for(const [name,engine]of [["Chromium",chromium],["Firefox",firefox]]){
  test(`${name}: print range supports click replacement, empty drafts and full page numbers`,{timeout:60000},async()=>{
    const b=await engine.launch({headless:true});
    try{for(const [kind,id,last]of [["rendered",manual,724],["retained",native,120]]){
      const {context,p}=await viewer(b,id);
      try{
        await p.getByTestId("button-print-page").click();
        await p.getByTestId("radio-print-range").check();
        const from=p.getByTestId("input-print-from"),to=p.getByTestId("input-print-to");
        for(const input of [from,to]){
          await input.click();await p.keyboard.press("Backspace");
          assert.equal(await input.inputValue(),"","Backspace must leave an empty draft");
          await p.keyboard.type(String(last));
          assert.equal(await input.inputValue(),String(last),"All digits remain intact");
          await input.click();await p.keyboard.type("100");
          assert.equal(await input.inputValue(),"100","Click selects the full existing value");
        }
        // Keyboard focus also selects all; out-of-bounds values normalize only on blur.
        await from.click();await p.keyboard.type("9999");
        assert.equal(await from.inputValue(),"9999");
        await p.keyboard.press("Tab");assert.equal(await from.inputValue(),String(last));
        await p.keyboard.type("110");assert.equal(await to.inputValue(),"110");
        await from.click();await p.keyboard.type("0");await to.click();
        assert.equal(await from.inputValue(),"1");
        await p.keyboard.press("Backspace");assert.equal(await to.inputValue(),"");
        await from.click();assert.equal(await to.inputValue(),"1");
        // Reversed endpoints still become the exact ordered range in preparation.
        await p.keyboard.type("110");await to.click();await p.keyboard.type("100");
        await p.getByTestId("button-print-confirm").click();
        const frame=p.getByTestId("print-preparation-frame");
        await frame.waitFor();
        const url=new URL(await frame.getAttribute("src"));
        assert.equal(url.searchParams.get("from"),"100");
        assert.equal(url.searchParams.get("to"),"110");
        assert.equal(url.pathname,`${kind==="rendered"?"/api/rendered-print":"/api/pdf/print"}/${id}`);
        await p.getByTestId("print-preparation-done").click();
        await p.getByTestId("print-preparation-dialog").waitFor({state:"hidden"});
        evidence.checks.push(`${name} ${kind}: real click and keyboard replacement, empty drafts, three-digit pages, Tab select-all, bounds and reversed range.`);
      }finally{await context.close();}
    }}finally{await b.close();}
  });
  test(`${name}: both PDF flows stay in dialog; handoff, downloads and Done preserve originals`,{timeout:180000},async()=>{
    const b=await engine.launch({headless:true,...(name==="Firefox"?{firefoxUserPrefs:{"pdfjs.disabled":false}}:{})});
    evidence.browsers.push({name,version:b.version(),os:"Linux"});
    try{for(const [kind,id]of [["rendered",manual],["retained",native]]){
      const {context,p}=await viewer(b,id);
      try{
        const f=await prepare(p);
        await f.locator(kind==="rendered"?"#ready":"body[data-ready=true]").waitFor({state:"visible",timeout:30000});
        assert.equal(context.pages().length,1,"No preparation browser tab");
        await p.evaluate(()=>window.postMessage({type:"apd-print-done"},location.origin));
        assert.equal(await p.getByTestId("print-preparation-dialog").isVisible(),true,"Messages not from the owned frame must be ignored");
        assert.equal(await f.locator("canvas,.sheet").count(),0,"PDF handoff, not raster preview");
        const url=kind==="rendered"?await f.locator("#open").getAttribute("href"):await f.locator("#prepared-download").getAttribute("href");
        const job=kind==="rendered"?url.split("/")[3]:null;
        const beforeJob=job?await (await api(`/api/rendered-print-jobs/${job}`)).json():null;
        const downloadEvent=p.waitForEvent("download");
        await f.locator(kind==="rendered"?"#download":"#prepared-download").click();
        const download=await downloadEvent;const file=await download.path();
        const bytes=readFileSync(file),pdf=await PDFDocument.load(bytes);assert.equal(pdf.getPageCount(),2);
        const popupEvent=context.waitForEvent("page");
        await f.locator(kind==="rendered"?"#open":"#print").click();
        const popup=await popupEvent;await delay(400);
        assert.equal(await p.getByTestId("print-preparation-dialog").isVisible(),true);
        assert.equal(context.pages().length,2,"Only the PDF reader is an additional tab");
        if(job){
          const afterJob=await (await api(`/api/rendered-print-jobs/${job}`)).json();
          assert.equal(afterJob.bytes,beforeJob.bytes);assert.equal(afterJob.state,"ready");
        }
        // No Windows launch is possible here; verify a clear alternate-action error.
        await f.locator(kind==="rendered"?"#pc":"#open-original").click();
        await f.locator(kind==="rendered"?"#external":"#external-status").filter({hasText:/Windows/}).waitFor();
        if(name==="Chromium"){
          await p.screenshot({path:join(root,`verification/candidate9-${kind}-desktop.png`)});
          await p.setViewportSize({width:375,height:812});
          await p.screenshot({path:join(root,`verification/candidate9-${kind}-mobile.png`)});
          const box=await p.getByTestId("print-preparation-dialog").boundingBox();
          assert.ok(box.x>=0&&box.x+box.width<=376);
          assert.ok(await f.locator("body").evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
          await p.setViewportSize({width:1280,height:920});
          await p.emulateMedia({colorScheme:"dark"});
        }
        await p.getByTestId("print-preparation-done").click();
        await p.getByTestId("print-preparation-dialog").waitFor({state:"hidden"});
        assert.equal(popup.isClosed(),false,"Done must leave the PDF reader open");
        assert.equal(digest(readFileSync(file)),digest(bytes),"Downloaded copy survives Done");
        if(job){
          assert.equal((await api(`/api/rendered-print-jobs/${job}`)).status,404);
          assert.equal((await api(url)).status,409);
        }
        // New job must prepare normally; Escape from INSIDE the iframe is a cleanup dismissal.
        const again=await prepare(p);
        await again.locator(kind==="rendered"?"#ready":"body[data-ready=true]").waitFor({state:"visible",timeout:30000});
        const nextUrl=kind==="rendered"?await again.locator("#open").getAttribute("href"):null;
        if(nextUrl)assert.notEqual(nextUrl,url);
        await again.locator(kind==="rendered"?"#cancel":"#print").focus();await p.keyboard.press("Escape");
        await p.getByTestId("print-preparation-dialog").waitFor({state:"hidden"});
        if(nextUrl)assert.equal((await api(nextUrl)).status,409);
        evidence.checks.push(`${name} ${kind}: in-app PDF preparation, 2-page download, reader remains open, dialog persists after handoff, Done, fresh job and Escape cleanup.`);
      }finally{await context.close();}
    }}finally{await b.close();}
  });
}
test("Done during full rendering cancels; Close dismisses; cleanup errors do not claim success",{timeout:60000},async()=>{
  const b=await chromium.launch({headless:true}),{p,context}=await viewer(b,manual);
  try{
    const f=await prepare(p,1,724,"all");
    await f.locator("#fallback").click();
    await f.locator("#progress").waitFor();
    const job=await f.locator("body").evaluate(()=>new URL(location.href).searchParams.get("job"));
    await p.getByTestId("print-preparation-done").click();
    await p.getByTestId("print-preparation-dialog").waitFor({state:"hidden"});
    assert.equal((await api(`/api/rendered-print-jobs/${job}`)).status,404);
    const retry=await prepare(p);await retry.locator("#ready").waitFor({timeout:30000});
    const url=await retry.locator("#open").getAttribute("href");
    await p.getByTestId("print-preparation-dialog").getByRole("button",{name:"Close",exact:true}).click();
    await p.getByTestId("print-preparation-dialog").waitFor({state:"hidden"});
    assert.equal((await api(url)).status,409);
    const failure=await prepare(p);await failure.locator("#ready").waitFor({timeout:30000});
    const failedUrl=await failure.locator("#open").getAttribute("href");
    await p.route("**/api/rendered-print-jobs/*/cancel",r=>r.abort());
    await p.getByTestId("print-preparation-done").click();
    await p.getByTestId("print-preparation-dialog").waitFor({state:"hidden"});
    await p.getByText(/Cleanup could not be confirmed/).waitFor();
    await api(failedUrl.replace("/pdf","/cancel"),{});
    evidence.checks.push("Cancel a full-manual job, retry, Close cleanup, and disconnected cleanup messaging.");
  }finally{await context.close();await b.close();}
});
test("cleanup origin protection and original library preservation",async()=>{
  const id=randomUUID();
  assert.equal((await api(`/api/pdf/print-jobs/${id}/done`,{},{...headers,"X-APD-PDF-Action":"open-original",Origin:"https://evil.test"})).status,403);
  assert.equal((await api(`/api/pdf/print-jobs/${id}/done`,{},{...headers,"X-APD-PDF-Action":"open-original"})).status,200);
  assert.equal(digest(Buffer.from(await (await api(`/api/documents/${native}/original`)).arrayBuffer())),originalHash);
  assert.equal((await api(`/api/documents/${manual}/pages/724.jpg`)).status,200);
  assert.deepEqual(evidence.errors,[]);
  evidence.checks.push("Hostile cleanup rejected; retained original bytes and rendered page 724 preserved.");
});
test("Done defers deletion until an active PDF transfer finishes",{timeout:60000},async()=>{
  const id=randomUUID();
  const r=await api("/api/rendered-print-jobs",{id,documentId:manual,from:1,to:30});
  assert.equal(r.status,200,await r.text());
  for(let n=0;n<300;n++){
    const j=await (await api(`/api/rendered-print-jobs/${id}`)).json();
    if(j.state==="ready")break;
    assert.notEqual(j.state,"error",j.message);await delay(100);
  }
  const response=await new Promise((yes,no)=>httpGet(base+`/api/rendered-print-jobs/${id}/pdf`,r=>{r.pause();yes(r);}).on("error",no));
  try{
    const done=await (await api(`/api/rendered-print-jobs/${id}/cancel`,{})).json();
    assert.equal(done.pending,true,"An in-progress transfer must defer removal");
    let size=0;response.on("data",b=>size+=b.length);
    await new Promise((yes,no)=>{response.on("end",yes);response.on("error",no);response.resume();});
    assert.ok(size>1000000,"Existing transfer is allowed to finish");
    for(let n=0;n<30;n++){if((await api(`/api/rendered-print-jobs/${id}`)).status===404)break;await delay(100);}
    assert.equal((await api(`/api/rendered-print-jobs/${id}`)).status,404);
    evidence.checks.push("Done returns pending during a paused HTTP transfer, allows completion and removes the job afterward.");
  }finally{response.destroy();await api(`/api/rendered-print-jobs/${id}/cancel`,{});}
});
test("Firefox download-only PDF settings keep preparation usable",{timeout:60000},async()=>{
  const b=await firefox.launch({headless:true,firefoxUserPrefs:{"pdfjs.disabled":true}});
  const {p,context}=await viewer(b,native);
  try{
    const f=await prepare(p);await f.locator("body[data-ready=true]").waitFor({timeout:30000});
    // Firefox may close the short-lived handoff tab itself when it downloads.
    let downloaded;context.on("page",popup=>popup.on("download",d=>downloaded=d));
    p.on("download",d=>downloaded=d);
    await f.locator("#print").click();
    for(let n=0;n<100&&!downloaded;n++)await delay(100);
    assert.ok(downloaded,"PDF handoff follows browser's download preference");
    assert.ok(await downloaded.path());
    assert.equal(await p.getByTestId("print-preparation-dialog").isVisible(),true);
    await p.getByTestId("print-preparation-done").click();
    await p.getByTestId("print-preparation-dialog").waitFor({state:"hidden"});
    evidence.checks.push("Firefox download-only preference hands off the PDF without closing the preparation dialog.");
  }finally{await context.close();await b.close();}
});
