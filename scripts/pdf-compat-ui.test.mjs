// Integrated real UI and converted range checks. Disposable library only.
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {chromium,firefox} from "playwright";
import {PDFDocument} from "pdf-lib";
const root=resolve(import.meta.dirname,".."),base="http://127.0.0.1:5222";
let temp,server,log="";
const delay=ms=>new Promise(r=>setTimeout(r,ms));
before(async()=>{
  temp=mkdtempSync(join(tmpdir(),"apd-v131-ui-"));
  server=spawn(process.execPath,["dist/index.cjs"],{cwd:root,env:{...process.env,
    NODE_ENV:"production",PORT:"5222",RAG_DB_PATH:join(temp,"advisepoint.db"),
    RAG_PAGES_DIR:join(temp,"pages"),APD_LOG_DIR:join(temp,"logs"),
    RAG_NO_SEED:"1",RAG_NO_IDLE_SHUTDOWN:"1",APD_LOCAL_TEST:"1"},stdio:["ignore","pipe","pipe"]});
  server.stdout.on("data",b=>log+=b);server.stderr.on("data",b=>log+=b);
  for(let i=0;i<150;i++){try{if((await fetch(base+"/api/health")).ok)return}catch{}await delay(100)}
  throw Error(log);
});
after(async()=>{if(server?.exitCode===null){server.kill();await new Promise(r=>server.once("exit",r))}
  writeFileSync(join(root,"verification/compat-ui-server.log"),log);rmSync(temp,{recursive:true,force:true})});
for(const [name,driver] of [["Chromium",chromium],["Firefox",firefox]]){
 test(`${name}: real mixed upload, live type counters, recovery warning, download and exact converted range`,async()=>{
  const browser=await driver.launch({headless:true}),p=await browser.newPage({viewport:{width:1400,height:1000}});
  const errors=[];p.on("pageerror",e=>errors.push(e.message));
  const nav=async route=>{await p.evaluate(r=>{location.hash=r},route);await delay(300)};
  try{
    await p.goto(base+"/#/schema");await p.getByTestId("tab-formats").click();
    await p.getByText("Document types",{exact:true}).first().waitFor();
    // Prime the settings cache before importing within the same SPA session.
    await nav("/upload");
    const responses=[];p.on("response",async r=>{if(r.url().endsWith("/api/upload")&&r.request().method()==="POST")responses.push(await r.json())});
    await p.getByTestId("input-file").setInputFiles([
      {name:`DEALER-${name}.pdf`,mimeType:"application/pdf",buffer:readFileSync(process.env.APD_SAMPLE_PDF)},
      {name:`DEVICE-${name}.txt`,mimeType:"text/plain",buffer:Buffer.from("Dealer and device configuration support notes for a mixed import test.")}
    ]);
    await p.getByTestId("button-ingest").click();
    await p.getByText("All files added to your library.",{exact:true}).waitFor({timeout:120000});
    assert.equal(responses.length,2);const result=responses.find(r=>r.pdf_prepared);
    assert.ok(result?.document);const id=result.document.id;
    assert.equal(await p.getByTestId("button-rendered-fallback").count(),0);
    assert.doesNotMatch(result.document.title,/DE ALER|DE VICE/i);
    await p.screenshot({path:join(root,`verification/compat-upload-${name}.png`)});
    await nav("/schema");await p.getByTestId("tab-formats").click();
    const types=(await(await fetch(base+"/api/document-types")).json()).types;
    const used=types.find(t=>t.key===result.document.document_type);
    assert.ok(used.document_count>0);
    const row=p.getByTestId(`document-type-row-${used.key}`);
    // Compare rendered manager text with the server's actual count.
    await row.getByText(new RegExp(`^${used.document_count} documents?`)).waitFor();
    await nav(`/library/${id}`);
    await p.getByTestId("button-delete").click();
    const warning=await p.getByRole("alertdialog").innerText();
    assert.match(warning,/restore this document/);assert.doesNotMatch(warning,/cannot be undone/i);
    await p.getByTestId("button-delete-cancel").click();
    assert.equal(await p.getByTestId("button-download-original-pdf").getAttribute("aria-label"),"Download compatible PDF");
    let dialogs=0;p.on("dialog",async dialog=>{dialogs++;await dialog.dismiss()});
    let openFails=false;
    await p.route("**/api/pdf/open-original/**",r=>r.fulfill({
      status:openFails?500:200,json:{message:openFails?"Test opening failure":"Windows was asked to open a temporary copy."}
    }));
    await p.getByTestId("button-view-pages").click();
    const opened=p.waitForResponse(r=>r.url().includes("/api/pdf/open-original/"));
    await p.getByTestId("button-open-original-pdf").click();
    await opened;
    await p.waitForTimeout(300);
    assert.equal(dialogs,0);
    openFails=true;
    const failure=p.waitForEvent("dialog");
    await p.getByTestId("button-open-original-pdf").click();await failure;
    assert.equal(dialogs,1);
    await p.keyboard.press("Escape");
    const preview=await browser.newPage();
    await preview.addInitScript(()=>{window.__opened=[];window.open=u=>{window.__opened.push(u);return null}});
    await preview.goto(`${base}/api/pdf/print/${id}?from=2&to=5&embedded=1`);
    await preview.waitForFunction(()=>document.body.dataset.ready==="true",null,{timeout:120000});
    assert.equal(await preview.getByRole("button",{name:"Open in PC PDF app"}).isVisible(),false);
    await preview.getByRole("button",{name:"Open PDF to print",exact:true}).click();
    const bytes=await preview.evaluate(async()=>Array.from(new Uint8Array(await(await fetch(window.__opened[0])).arrayBuffer())));
    const selected=await PDFDocument.load(new Uint8Array(bytes));assert.equal(selected.getPageCount(),4);
    const {getDocument}=await import("pdfjs-dist/legacy/build/pdf.mjs");
    const a=getDocument({data:new Uint8Array(bytes)}),b=getDocument({data:new Uint8Array(readFileSync(process.env.APD_SAMPLE_PDF))});
    const [ad,bd]=await Promise.all([a.promise,b.promise]);
    for(let n=1;n<=4;n++){
      const text=async(doc,page)=>(await(await doc.getPage(page)).getTextContent()).items.map(x=>x.str).join(" ").replace(/\s+/g," ").trim();
      assert.equal(await text(ad,n),await text(bd,n+1));
    }
    await a.destroy();await b.destroy();
    const url=await preview.evaluate(()=>window.__opened[0]);
    await preview.evaluate(()=>window.apdFinishPrint());
    assert.equal(await preview.evaluate(async u=>{try{await fetch(u);return true}catch{return false}},url),false);
    await preview.close();
    await p.getByTestId("button-delete").click();await p.getByTestId("button-delete-confirm").click();
    await p.getByTestId("text-library-count").waitFor();
    await nav("/schema");await p.getByTestId("tab-formats").click();
    const expected=used.document_count-1;
    await p.getByTestId(`document-type-row-${used.key}`).getByText(new RegExp(`^${expected} documents?`)).waitFor();
    assert.deepEqual(errors,[]);
  }finally{await browser.close()}
 });
}
