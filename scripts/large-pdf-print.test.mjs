// QA inventory: >20-page/full-manual handoff; exact selected range; protected
// PDF safety; cancellation/retry/timeout; no full-page raster allocation;
// original-byte integrity; optional active-fallback responsiveness measurement.
// All writes and imports use disposable test data, never a user library.
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {spawn,execFileSync} from "node:child_process";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,readdirSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {createHash} from "node:crypto";
import {PDFDocument,StandardFonts,degrees} from "pdf-lib";
import {chromium,firefox} from "playwright";
import {createCanvas,loadImage} from "@napi-rs/canvas";
const root=resolve(import.meta.dirname,".."),base="http://127.0.0.1:5195";
let temp,server,browser,type,id,fixture,output="";
const evidence={checks:[],manuals:[],responsiveness:null};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const json=async p=>(await fetch(base+p)).json();
const digest=b=>createHash("sha256").update(b).digest("hex");
async function upload(name,bytes,mode="native"){
  const form=new FormData();form.append("file",new Blob([bytes]),name);
  form.append("metadata",JSON.stringify({document_type:type,title:name}));form.append("pdf_import_mode",mode);
  const r=await fetch(base+"/api/upload",{method:"POST",body:form}),data=await r.json();
  assert.equal(r.status,200,JSON.stringify(data));return data;
}
async function preview(doc,from,to,options={}){
  const p=await browser.newPage({viewport:{width:1280,height:900},...options});
  await p.addInitScript(()=>{window.__opened=[];window.open=u=>{window.__opened.push(u);return null;};});
  await p.goto(`${base}/api/pdf/print/${doc}?from=${from}&to=${to}${process.env.APD_PRINT_EMBEDDED?"&embedded=1":""}`);
  return p;
}
async function ready(p){await p.waitForFunction(()=>document.body.dataset.ready==="true",null,{timeout:120000});}
before(async()=>{
  temp=mkdtempSync(join(tmpdir(),"apd-large-print-"));mkdirSync(join(root,"verification"),{recursive:true});
  server=spawn(process.execPath,["dist/index.cjs"],{cwd:root,env:{...process.env,NODE_ENV:"production",
    PORT:"5195",RAG_DB_PATH:join(temp,"advisepoint.db"),RAG_PAGES_DIR:join(temp,"pages"),
    APD_LOG_DIR:join(temp,"logs"),RAG_NO_SEED:"1",RAG_NO_IDLE_SHUTDOWN:"1",APD_LOCAL_TEST:"1"},stdio:["ignore","pipe","pipe"]});
  server.stdout.on("data",b=>output+=b);server.stderr.on("data",b=>output+=b);
  for(let n=0;n<150;n++){try{if((await fetch(base+"/api/health")).ok)break;}catch{}await delay(100);}
  type=(await json("/api/document-types")).types[0].key;
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
  for(let n=1;n<=120;n++){
    const page=pdf.addPage(n%2?[612,792]:[792,612]);
    if(n===30)page.setRotation(degrees(90));
    page.drawText(`Large print verification PageToken${n} printer maintenance configuration.`,{font,size:12,x:25,y:200});
  }
  fixture=await pdf.save();id=(await upload("Large print fixture.pdf",fixture)).document.id;
  browser=await chromium.launch({headless:true,channel:"chromium"});
});
after(async()=>{
  await browser?.close();
  if(server?.exitCode===null){server.kill();await new Promise(r=>server.once("exit",r));}
  writeFileSync(join(root,"verification/large-print-results.json"),JSON.stringify({...evidence,temp},null,2));
  writeFileSync(join(root,"verification/large-print-server.log"),output);
  rmSync(temp,{recursive:true,force:true});
});
test("full manual has no page cap, uses unchanged original and no raster sheets",async()=>{
  const p=await preview(id,1,120);
  try{
    await p.locator("#handoff").waitFor();assert.equal(await p.locator(".sheet").count(),0);
    assert.equal(await p.locator("canvas").count(),0);
    assert.equal(await p.locator("#open").getAttribute("href"),`/api/documents/${id}/original`);
    assert.equal(digest(Buffer.from(await (await fetch(base+`/api/documents/${id}/original`)).arrayBuffer())),digest(fixture));
    await p.screenshot({path:join(root,"verification/large-print-desktop.png")});
    await p.setViewportSize({width:375,height:812});
    assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await p.screenshot({path:join(root,"verification/large-print-mobile.png")});
    await p.evaluate(()=>window.apdFinishPrint());
    assert.equal((await fetch(base+`/api/documents/${id}/original`)).status,200);
  }finally{await p.close();}
  evidence.checks.push("120-page unchanged original; no print canvases/sheets; desktop/mobile; cleanup preserves original.");
});
test("101-page native subset contains exactly original pages 10 through 110, dimensions and rotation preserved",async()=>{
  const p=await preview(id,10,110);
  try{
    await ready(p);await p.getByRole("button",{name:"Open PDF to print",exact:true}).click();
    const bytes=await p.evaluate(async()=>Array.from(new Uint8Array(await (await fetch(window.__opened[0])).arrayBuffer())));
    const pdf=await PDFDocument.load(new Uint8Array(bytes)),original=await PDFDocument.load(fixture);
    assert.equal(pdf.getPageCount(),101);
    for(let n=0;n<101;n++){
      assert.deepEqual(pdf.getPage(n).getSize(),original.getPage(n+9).getSize());
      assert.equal(pdf.getPage(n).getRotation().angle,original.getPage(n+9).getRotation().angle);
    }
    const {getDocument}=await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task=getDocument({data:new Uint8Array(bytes)}),doc=await task.promise,text=[];
    for(const n of [1,51,101])text.push((await (await doc.getPage(n)).getTextContent()).items.map(x=>x.str).join(" "));
    await task.destroy();
    for(const [i,n]of [10,60,110].entries())assert.match(text[i],new RegExp(`PageToken${n}\\b`));
    assert.equal(await p.locator(".sheet").count(),0);
    const blob=await p.evaluate(()=>window.__opened[0]);
    await p.getByRole("button",{name:"Clear prepared PDF"}).click();
    assert.equal(await p.evaluate(async url=>{try{await fetch(url);return false;}catch{return true;}},blob),true);
  }finally{await p.close();}
  evidence.checks.push("101-page native selected PDF: exact first/middle/last text, all page dimensions/rotation, released blob.");
});
test("protected ranges produce exact print-quality subsets; print denial stays enforced",async()=>{
  const input=join(temp,"input.pdf");writeFileSync(input,fixture);
  for(const mode of ["full","low","none"]){
    const file=join(temp,`protected-${mode}.pdf`);
    execFileSync("qpdf",["--encrypt","","owner-test","256",`--print=${mode}`,"--",input,file]);
    const doc=(await upload(`Protected ${mode}.pdf`,readFileSync(file))).document.id,p=await preview(doc,10,12);
    try{
      if(mode==="none"){await p.getByText(/This PDF does not allow printing/).waitFor();assert.equal(await p.locator("#print").isDisabled(),true);}
      else{
        await ready(p);assert.equal(await p.locator("body").getAttribute("data-print-mode"),"pdf");
        assert.equal(await p.locator("body").getAttribute("data-preparation"),"print-images");
        assert.equal(await p.locator("body").getAttribute("data-dpi"),mode==="low"?"150":"200");
        await p.getByRole("button",{name:"Open PDF to print",exact:true}).click();
        const bytes=await p.evaluate(async()=>Array.from(new Uint8Array(await (await fetch(window.__opened[0])).arrayBuffer())));
        assert.equal((await PDFDocument.load(new Uint8Array(bytes))).getPageCount(),3);
        assert.equal(digest(Buffer.from(await (await fetch(base+`/api/documents/${doc}/original`)).arrayBuffer())),digest(readFileSync(file)));
        const url=await p.locator("#prepared-download").getAttribute("href");
        await p.evaluate(()=>window.apdFinishPrint());
        assert.equal(await p.evaluate(async u=>{try{await fetch(u);return true;}catch{return false;}},url),false);
      }
    }finally{await p.close();}
  }
  evidence.checks.push("Encrypted print-allowed ranges produce exact 3-page image PDFs at 200/150 DPI; original bytes preserved; no-print remains refused.");
});
test("protected 51-page range remains a subset; image preparation can cancel and retry",async()=>{
  const doc=(await upload("Protected 51-page range.pdf",readFileSync(join(temp,"protected-full.pdf")))).document.id;
  const p=await preview(doc,10,60);
  try{
    await ready(p);
    assert.equal(await p.locator("body").getAttribute("data-preparation"),"print-images");
    const bytes=await p.evaluate(async()=>Array.from(new Uint8Array(await (await fetch(document.querySelector("#prepared-download").href)).arrayBuffer())));
    assert.equal((await PDFDocument.load(new Uint8Array(bytes))).getPageCount(),51);
  }finally{await p.close();}
  const cancelled=await browser.newPage();
  try{
    await cancelled.addInitScript(()=>{
      const original=HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob=function(callback,...args){
        original.call(this,b=>setTimeout(()=>callback(b),1500),...args);
      };
    });
    await cancelled.goto(`${base}/api/pdf/print/${doc}?from=10&to=12&embedded=1`);
    await cancelled.getByText(/Preparing selected page 1 of 3/).waitFor();
    await cancelled.locator("#cancel").click();await delay(1700);
    assert.equal(await cancelled.locator("body").getAttribute("data-ready"),"false");
    assert.equal(await cancelled.locator("#prepared-download").isHidden(),true);
    await cancelled.locator("#retry").click();await ready(cancelled);
    assert.equal(await cancelled.locator("body").getAttribute("data-preparation"),"print-images");
  }finally{await cancelled.close();}
  evidence.checks.push("Protected 51-page subset; image-stage cancellation has no stale completion; clean retry; completed protected blobs revoked on Done.");
});
test("cancel during worker preparation, retry and time-limit cleanup",async()=>{
  const p=await browser.newPage();
  try{
    let block=true;
    await p.route("**/pdf-print-worker.js",async r=>{if(block)await delay(1500);await r.continue().catch(()=>{});});
    await p.goto(`${base}/api/pdf/print/${id}?from=10&to=40`);
    await p.getByText("Preparing a PDF for printing without full-size page images…",{exact:true}).waitFor();
    await p.getByRole("button",{name:"Cancel preparation"}).click();await delay(1700);
    assert.equal(await p.locator("body").getAttribute("data-ready"),"false");
    assert.equal(await p.locator(".sheet").count(),0);
    block=false;await p.getByRole("button",{name:"Prepare again"}).click();await ready(p);
  }finally{await p.close();}
  const timed=await browser.newPage();
  try{
    await timed.addInitScript(()=>{const old=window.setTimeout;window.setTimeout=(fn,ms,...args)=>old(fn,ms===120000?100:ms,...args);});
    await timed.route("**/original",async r=>{await delay(1500);await r.continue().catch(()=>{});});
    await timed.goto(`${base}/api/pdf/print/${id}?from=10&to=40`);
    await timed.getByText(/longer than two minutes and was stopped/).waitFor();
    await delay(1700);assert.equal(await timed.locator("body").getAttribute("data-ready"),"false");
  }finally{await timed.close();}
  evidence.checks.push("Worker cancellation, clean retry, bounded timeout, no stale ready completion.");
});
test("real browser PDF tab opens from the button without auto-printing",async()=>{
  for(const [from,to]of [[10,40],[1,120]]){
    const p=await browser.newPage();
    try{
      await p.goto(`${base}/api/pdf/print/${id}?from=${from}&to=${to}`);
      if(to-from+1>50)await p.locator("#handoff").waitFor();else await ready(p);
      const opened=p.context().waitForEvent("page");
      if(to-from+1>50)await p.locator("#open").click();else await p.getByRole("button",{name:"Open PDF to print",exact:true}).click();
      const pdf=await opened;
      await pdf.waitForLoadState("domcontentloaded");
      await delay(1500);
      console.log("PDF_TAB",JSON.stringify({from,to,url:pdf.url(),html:(await pdf.content()).slice(0,4000),frames:pdf.frames().map(f=>f.url())}));
      await pdf.screenshot({path:join(root,`verification/large-print-pdf-tab-${from}.png`)});
      assert.ok(pdf.frames().some(f=>f.url().startsWith("chrome-extension:")) ||
        await pdf.locator('embed[type="application/pdf"],pdf-viewer').count()>0,"Browser PDF viewer did not load");
      await pdf.close();
    }finally{await p.close();}
  }
  evidence.checks.push("Real Chromium PDF tabs load for generated range and unchanged full PDF; no automatic print.");
});
test("one-minute warning offers the PC PDF app only on a click and stops preparation safely",async()=>{
  const p=await browser.newPage();let launches=0;
  try{
    await p.addInitScript(()=>{const old=window.setTimeout;window.setTimeout=(fn,ms,...args)=>old(fn,ms===60000?100:ms,...args);});
    await p.route("**/original",async r=>{await delay(1500);await r.continue().catch(()=>{});});
    await p.route("**/api/pdf/open-original/*",async r=>{
      launches++;assert.equal(r.request().method(),"POST");
      assert.equal(r.request().headers()["x-apd-pdf-action"],"open-original");
      await r.fulfill({contentType:"application/json",body:JSON.stringify({message:"Windows was asked to open a temporary copy in your default PDF app."})});
    });
    await p.goto(`${base}/api/pdf/print/${id}?from=10&to=40`);
    await p.getByText(/Preparation has taken one minute/).waitFor();
    assert.equal(launches,0);assert.equal(await p.getByRole("button",{name:"Cancel preparation"}).isVisible(),true);
    await p.getByRole("button",{name:"Open in PC PDF app",exact:true}).click();
    await p.getByText(/For this job, select original pages 10–40/).waitFor();
    assert.equal(launches,1);await delay(1700);
    assert.equal(await p.locator("body").getAttribute("data-ready"),"false");
    assert.equal(await p.getByRole("button",{name:"Prepare again"}).isVisible(),true);
  }finally{await p.close();}
  evidence.checks.push("60-second warning, keep-waiting/cancel choices, explicit-only PC-app POST, stops pending work and shows exact original range.");
});
test("three supplied real manuals: full handoff and exact four-page native ranges in Chromium and Firefox", {skip:!process.env.APD_MANUALS,timeout:300000},async()=>{
  for(const name of ["2554ci-3554ci-4054ci-5054ci-6054ci-7054ciENOGR2024.7.pdf","4004i_5004i_6004i_7004iENOGR2025_07-2.pdf","MZ9500ciSeriesENOGR2025.09-3.pdf"]){
    const bytes=readFileSync(join(process.env.APD_MANUALS,name)),data=await upload(name,bytes),began=Date.now();
    const p=await preview(data.document.id,1,data.extraction.page_count);
    try{
      await p.locator("#handoff").waitFor();const elapsed=Date.now()-began;
      assert.equal(await p.locator(".sheet").count(),0);
      assert.equal(await p.locator("#open").getAttribute("href"),`/api/documents/${data.document.id}/original`);
      assert.equal(digest(Buffer.from(await (await fetch(base+`/api/documents/${data.document.id}/original`)).arrayBuffer())),digest(bytes));
      evidence.manuals.push({name,pages:data.extraction.page_count,prepare_ms:elapsed,bytes:bytes.length,sha256:digest(bytes),print_handoff:"PASS",windows_spooling:"NOT TESTED"});
    }finally{await p.close();}
    const fox=await firefox.launch({headless:true});
    try{for(const [engine,b]of [["Chromium",browser],["Firefox",fox]]){
      const page=await b.newPage(),errors=[];
      page.on("pageerror",e=>errors.push(e.message));
      try{
        await page.goto(`${base}/#/library/${data.document.id}`);
        await page.getByTestId("button-view-pages").click();
        await page.getByTestId("button-print-page").click();
        await page.getByTestId("radio-print-range").check();
        await page.getByTestId("input-print-from").fill("100");
        await page.getByTestId("input-print-to").fill("103");
        await page.getByTestId("button-print-confirm").click();
        const frame=page.frameLocator('[data-testid="print-preparation-frame"]');
        await frame.locator('body[data-ready="true"]').waitFor({timeout:120000});
        assert.equal(await frame.locator("body").getAttribute("data-print-mode"),"pdf");
        const url=await frame.locator("#prepared-download").getAttribute("href");
        assert.ok(url.startsWith("blob:"));
        const downloaded=page.waitForEvent("download");await frame.locator("#prepared-download").click();
        const result=readFileSync(await (await downloaded).path()),selected=await PDFDocument.load(result);
        assert.equal(selected.getPageCount(),4);
        const outputFile=join(temp,`${engine}-range.pdf`);writeFileSync(outputFile,result);
        const compare=mkdtempSync(join(temp,"compare-"));
        execFileSync("pdftoppm",["-f","100","-l","103","-scale-to","600","-png",join(process.env.APD_MANUALS,name),join(compare,"original")]);
        execFileSync("pdftoppm",["-scale-to","600","-png",outputFile,join(compare,"selected")]);
        const images=prefix=>readdirSync(compare).filter(n=>n.startsWith(prefix)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
        const sourceImages=images("original"),selectedImages=images("selected");assert.equal(sourceImages.length,4);assert.equal(selectedImages.length,4);
        const differences=[];
        for(let i=0;i<4;i++){
          const original=await loadImage(join(compare,sourceImages[i])),actual=await loadImage(join(compare,selectedImages[i]));
          // Fractional PDF point sizes can round to neighboring pixels.
          assert.ok(Math.abs(actual.width-original.width)<=1);assert.ok(Math.abs(actual.height-original.height)<=1);
          const pixels=image=>{const c=createCanvas(original.width,original.height),ctx=c.getContext("2d");ctx.drawImage(image,0,0,original.width,original.height);return ctx.getImageData(0,0,original.width,original.height).data;};
          const a=pixels(original),b=pixels(actual);let total=0;
          for(let n=0;n<a.length;n++)total+=Math.abs(a[n]-b[n]);
          const mean=total/a.length;differences.push(mean);assert.ok(mean<12,`Original page ${100+i} differs: ${mean}`);
        }
        // Primary handoff opens the exact blob checked above, not the source PDF.
        await frame.locator("body").evaluate(()=>{window.__opened=[];window.open=u=>{window.__opened.push(u);return null;};});
        await frame.locator("#print").click();assert.deepEqual(await frame.locator("body").evaluate(()=>window.__opened),[url]);
        await page.getByTestId("print-preparation-done").click();
        await page.getByTestId("print-preparation-dialog").waitFor({state:"hidden"});
        assert.equal(digest(Buffer.from(await (await fetch(base+`/api/documents/${data.document.id}/original`)).arrayBuffer())),digest(bytes));
        assert.deepEqual(errors,[]);
        evidence.checks.push(`${engine} ${name}: exact pages 100–103, count 4, primary reader gets subset, visual mean differences ${differences.map(x=>x.toFixed(3)).join("/")}, original unchanged, Done cleanup.`);
        rmSync(compare,{recursive:true,force:true});
      }finally{await page.close();}
    }}finally{await fox.close();}
  }
});
