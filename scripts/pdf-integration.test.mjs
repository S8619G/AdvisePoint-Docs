// Production integration gate: uses built bundle and disposable libraries only.
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {spawn,execFileSync} from "node:child_process";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {createHash} from "node:crypto";
import {PDFDocument,StandardFonts,rgb} from "pdf-lib";
import JSZip from "jszip";
import Database from "better-sqlite3";
import {createCanvas} from "@napi-rs/canvas";
import {chromium} from "playwright";
const root=resolve(import.meta.dirname,".."),base="http://127.0.0.1:5193";
let temp,server,browser,docId,fixture,types,backupBytes,legacyId,legacyBytes,wordId,wordBytes;
let output="";
const evidence={checks:[],manuals:[],browserErrors:[],externalRequests:[],canvasSamples:[]};
const digest=b=>createHash("sha256").update(b).digest("hex");
const record=s=>evidence.checks.push(s);
const json=async path=>(await fetch(base+path)).json();
const env=()=>({...process.env,NODE_ENV:"production",PORT:"5193",LOCALAPPDATA:temp,
  RAG_DB_PATH:join(temp,"advisepoint.db"),RAG_PAGES_DIR:join(temp,"pages"),
  APD_LOG_DIR:join(temp,"logs"),RAG_NO_SEED:"1",RAG_NO_IDLE_SHUTDOWN:"1",APD_OPEN_BROWSER:"0",APD_LOCAL_TEST:"1"});
async function start(){
  server=spawn(process.execPath,["dist/index.cjs"],{cwd:root,env:env(),stdio:["ignore","pipe","pipe"]});
  server.stdout.on("data",b=>output+=b);server.stderr.on("data",b=>output+=b);
  for(let i=0;i<150;i++){
    if(server.exitCode!==null)throw Error(output);
    try {if((await fetch(base+"/api/health")).ok)return;}catch{}
    await new Promise(r=>setTimeout(r,100));
  }throw Error("Server did not start: "+output);
}
async function stop(){if(server?.exitCode===null){server.kill();await new Promise(r=>server.once("exit",r));}}
async function upload(name,bytes){
  const form=new FormData();form.append("file",new Blob([bytes]),name);
  form.append("metadata",JSON.stringify({title:name,document_type:types[0].key}));
  const r=await fetch(base+"/api/upload",{method:"POST",body:form}),data=await r.json();
  assert.equal(r.status,200,JSON.stringify(data));return data;
}
before(async()=>{
  temp=mkdtempSync(join(tmpdir(),"apd-v130-integration-"));mkdirSync(join(root,"verification"),{recursive:true});
  await start();types=(await json("/api/document-types")).types;
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
  for(let n=1;n<=120;n++){
    const page=pdf.addPage(n%3===0?[792,612]:[612,792]);
    page.drawRectangle({x:20,y:20,width:80,height:80,color:rgb((n%4)/4,.2,.5)});
    page.drawText(`Retained PDF manual page ${n}`,{x:30,y:page.getHeight()-55,font,size:20});
    page.drawText(`SearchToken${n} maintenance configuration and network printing.`,{x:30,y:page.getHeight()-90,font,size:12});
  }
  fixture=await pdf.save();docId=(await upload("Mixed-pages.pdf",fixture)).document.id;
  browser=await chromium.launch({headless:true,ignoreDefaultArgs:["--hide-scrollbars"]});
});
after(async()=>{
  await browser?.close();await stop();
  writeFileSync(join(root,"verification/pdf-server.log"),output);
  writeFileSync(join(root,"verification/pdf-results.json"),JSON.stringify({...evidence,temp},null,2));
});
async function visible(p){
  await p.waitForFunction(()=>{
    const stack=document.querySelector('[data-testid="viewer-continuous-stack"]');if(!stack)return false;
    const view=stack.getBoundingClientRect();
    const active=[...stack.querySelectorAll('[data-testid^="native-page-"]')].filter(e=>{
      const r=e.getBoundingClientRect();return r.bottom>view.top+8&&r.top<view.bottom-8;
    });return active.length>0&&active.every(e=>e.dataset.state==="ready");
  },null,{timeout:60000});
  const sample=await p.getByTestId("viewer-continuous-stack").evaluate(e=>{
    const cs=[...e.querySelectorAll("canvas")];return {count:cs.length,pixels:cs.reduce((s,c)=>s+c.width*c.height,0)};
  });assert.ok(sample.pixels<=32_000_000);evidence.canvasSamples.push(sample);
}
async function openDoc(id=docId,viewport={width:1440,height:1000},deviceScaleFactor=1){
  const context=await browser.newContext({viewport,deviceScaleFactor});
  await context.route("**/*",r=>{
    if(!r.request().url().startsWith(base)&&!r.request().url().startsWith("blob:")){
      evidence.externalRequests.push(r.request().url());return r.abort();
    }return r.continue();
  });
  const p=await context.newPage();p.on("pageerror",e=>evidence.browserErrors.push(e.message));
  await p.goto(base+`/#/library/${id}`);await p.getByTestId("button-view-pages").click();await visible(p);
  return {p,context,stack:p.getByTestId("viewer-continuous-stack")};
}
async function jump(p,n){
  await p.getByTestId("input-page-jump").fill(String(n));await p.getByTestId("input-page-jump").press("Enter");
  await visible(p);assert.equal(await p.getByTestId("input-page-jump").inputValue(),String(n));
}
test("retained-PDF printing goes directly to preparation without a browser confirmation",async()=>{
  const {p,context}=await openDoc();
  try{
    const dialogs=[];p.on("dialog",async d=>{dialogs.push(d.message());await d.dismiss();});
    await p.evaluate(()=>{window.__printDestinations=[];window.open=(url)=>{window.__printDestinations.push(String(url));return null;};});
    for(const [mode,from,to] of [["all",1,120],["range",5,115],["current",1,1]]){
      await p.getByTestId("button-print-page").click();await p.getByTestId(`radio-print-${mode}`).check();
      if(mode==="range"){await p.getByTestId("input-print-from").fill("5");await p.getByTestId("input-print-to").fill("115");}
      await p.getByTestId("button-print-confirm").click();
      const urls=await p.evaluate(()=>window.__printDestinations);
      assert.equal(dialogs.length,0,"No native confirmation dialog is allowed");
      assert.equal(urls.length,0,"Preparation must stay inside the app");
      const target=new URL(await p.getByTestId("print-preparation-frame").getAttribute("src"));assert.equal(target.pathname,`/api/pdf/print/${docId}`);
      assert.equal(target.searchParams.get("from"),String(from));assert.equal(target.searchParams.get("to"),String(to));
      assert.equal(await p.getByTestId("popover-print-range").count(),0);
      assert.equal((await fetch(target.href)).status,200);
      await p.getByTestId("print-preparation-done").click();
      await p.getByTestId("print-preparation-dialog").waitFor({state:"hidden"});
    }
    record("Current, all 120 pages and >100-page subset go straight to retained-PDF preparation with no confirmation.");
  }finally{await context.close();}
});

test("retained bytes, range/HEAD, geometry, text search, storage and disabled updater",async()=>{
  const original=await fetch(`${base}/api/documents/${docId}/original`);
  assert.equal(digest(Buffer.from(await original.arrayBuffer())),digest(fixture));
  const ranged=await fetch(`${base}/api/documents/${docId}/original`,{headers:{Range:"bytes=0-63"}});
  assert.equal(ranged.status,206);assert.equal((await ranged.arrayBuffer()).byteLength,64);
  const head=await fetch(`${base}/api/documents/${docId}/original`,{method:"HEAD"});
  assert.equal(Number(head.headers.get("content-length")),fixture.length);
  const pages=await json(`/api/documents/${docId}/pages`);
  assert.equal(pages.viewer,"pdf-native");assert.equal(pages.pages.length,120);
  assert.ok(pages.pages[2].width>pages.pages[2].height);
  const s=await json("/api/backup/size");
  assert.equal(s.pages_bytes,0);assert.equal(s.original_bytes,fixture.length);
  assert.equal(s.current_backup_size_bytes,s.original_bytes+s.db_bytes+s.wal_bytes+s.shm_bytes+s.pages_bytes);
  const search=await fetch(base+"/api/search",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({query:"SearchToken77",top_k:5})});
  assert.ok((await search.json()).results.length>0);
  for(const path of ["/api/updater/shutdown","/api/updater/launch","/api/updater/launch-local","/api/update/upload-zip"]){
    assert.equal((await fetch(base+path,{method:"POST",headers:{"x-apd-updater":"1"}})).status,403);
  }
  assert.equal((await fetch(base+"/api/documents/missing/original")).status,404);
  record("Original hash/range/HEAD, all geometry, search, disk arithmetic, updater HTTP refusal");
});
test("rapid scrollbar drag/reversals, page jumps, zoom, resize and high-DPI bounded canvases",async()=>{
  const {p,context,stack}=await openDoc();
  try{
    await p.addStyleTag({content:'[data-testid="viewer-continuous-stack"]::-webkit-scrollbar{width:18px}[data-testid="viewer-continuous-stack"]::-webkit-scrollbar-button{display:none}[data-testid="viewer-continuous-stack"]::-webkit-scrollbar-thumb{background:#666;min-height:24px}'});
    await p.waitForTimeout(250);const b=await stack.boundingBox();
    await p.mouse.move(b.x+b.width-9,b.y+12);await p.mouse.down();
    await p.mouse.move(b.x+b.width-9,b.y+b.height*.8,{steps:12});await p.mouse.up();
    await p.waitForFunction(()=>document.querySelector('[data-testid="viewer-continuous-stack"]').scrollTop>10000);
    await visible(p);
    for(const f of [.95,.01,.8,.2,.99,.4]){await stack.evaluate((e,f)=>e.scrollTop=(e.scrollHeight-e.clientHeight)*f,f);await p.waitForTimeout(30);}
    await visible(p);await jump(p,77);await p.getByTestId("button-step-next").click();await visible(p);
    await p.getByTestId("button-zoom-fit").click();await visible(p);
    await p.setViewportSize({width:1024,height:768});await visible(p);await jump(p,120);await jump(p,1);
    await p.screenshot({path:join(root,"verification/viewer-desktop.png")});
  }finally{await context.close();}
  const hi=await openDoc(docId,{width:1920,height:1080},2);
  try{for(const n of [119,2,60,118,1])await jump(hi.p,n);}finally{await hi.context.close();}
  record("Native scrollbar drag, reversals, distant jumps, fit/resize and high-DPI memory bounds");
});
test("retained canvases do not rerender merely because overscan count changes; retry works",async()=>{
  const {p,context,stack}=await openDoc();
  try{
    await p.waitForFunction(()=>document.querySelector('[data-testid="native-page-2"]')?.dataset.state==="ready");
    await p.evaluate(()=>{
      window.__canvas=document.querySelector('[data-testid="canvas-page-2"]');window.__reloads=0;
      window.__observer=new MutationObserver(rs=>{for(const r of rs)if(r.target.dataset.state!=="ready")window.__reloads++;});
      window.__observer.observe(document.querySelector('[data-testid="native-page-2"]'),{attributes:true,attributeFilter:["data-state"]});
    });
    const counts=new Set();
    for(const top of [0,350,700,1050,1400,1050,700,350,0]){
      await stack.evaluate((e,t)=>e.scrollTop=t,top);await visible(p);counts.add(await stack.locator("canvas").count());
      assert.ok(await p.evaluate(()=>window.__canvas===document.querySelector('[data-testid="canvas-page-2"]')));
    }
    assert.ok(counts.size>1);assert.equal(await p.evaluate(()=>window.__reloads),0);
  }finally{await context.close();}
  const p2=await browser.newPage();let fail=true;
  await p2.route("**/original",r=>fail?r.fulfill({status:503,body:"fixture failure"}):r.continue());
  await p2.goto(`${base}/api/pdf/print/${docId}?from=2&to=3`);await p2.locator("#error").waitFor();
  fail=false;await p2.getByRole("button",{name:"Prepare again"}).click();
  await p2.waitForFunction(()=>document.body.dataset.ready==="true");await p2.close();
  record("Stable overscan canvases and explicit print failure/retry");
});
test("three supplied manuals retain exact bytes, render distant pages, print encrypted originals offline",{skip:process.env.APD_SYNTHETIC_ONLY==="1"},async()=>{
  const attachments=process.env.APD_MANUALS;if(!attachments)throw Error("Set APD_MANUALS to the three supplied manuals.");
  for(const name of ["2554ci-3554ci-4054ci-5054ci-6054ci-7054ciENOGR2024.7.pdf","4004i_5004i_6004i_7004iENOGR2025_07-2.pdf","MZ9500ciSeriesENOGR2025.09-3.pdf"]){
    const bytes=readFileSync(join(attachments,name)),started=Date.now(),data=await upload(name,bytes),total=data.extraction.page_count,id=data.document.id;
    assert.equal(digest(Buffer.from(await (await fetch(`${base}/api/documents/${id}/original`)).arrayBuffer())),digest(bytes));
    const {p,context,stack}=await openDoc(id);
    try{
      for(const n of [Math.floor(total/2),total,2,Math.floor(total*.9)])await jump(p,n);
      for(const f of [.1,.99,.3,.8,.02]){await stack.evaluate((e,f)=>e.scrollTop=e.scrollHeight*f,f);await p.waitForTimeout(25);}
      await visible(p);
      for(const [first,last]of [[1,1],[Math.floor(total/2),Math.floor(total/2)+1],[total,total]]){
        const print=await context.newPage();await print.goto(`${base}/api/pdf/print/${id}?from=${first}&to=${last}`);
        await print.waitForFunction(()=>document.body.dataset.ready==="true",null,{timeout:60000});
        assert.equal(await print.locator(".sheet").count(),last-first+1);
        if(first===1)await print.screenshot({path:join(root,`verification/manual-${evidence.manuals.length+1}-print.png`)});
        await print.close();
      }
    }finally{await context.close();}
    evidence.manuals.push({name,pages:total,bytes:bytes.length,elapsed_ms:Date.now()-started,sha256:digest(bytes)});
  }
  assert.equal((await json("/api/backup/size")).pages_bytes,0);
  record("All supplied manual pages, byte hashes, distant rendering and first/middle/last print previews");
});
test("selection copy/print and storage UI; print preview bounds, permissions and cancel",async()=>{
  const context=await browser.newContext({permissions:["clipboard-read","clipboard-write"]}),p=await context.newPage();
  try{
    await p.goto(base+`/#/library/${docId}`);await p.getByTestId("text-section-body").waitFor();
    const selected=await p.getByTestId("text-section-body").evaluate(el=>{
      const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let text;
      while((text=walker.nextNode())&&!text.textContent.trim()){}
      const r=document.createRange();r.setStart(text,0);r.setEnd(text,Math.min(40,text.length));
      const s=window.getSelection();s.removeAllRanges();s.addRange(r);return s.toString();
    });
    const toolbar=p.getByTestId("selected-text-actions");await toolbar.waitFor();
    await toolbar.getByRole("button",{name:"Copy selection",exact:true}).click();
    assert.equal(await p.evaluate(()=>navigator.clipboard.readText()),selected);
    const opened=context.waitForEvent("page");await toolbar.getByRole("button",{name:"Print selection",exact:true}).click();
    const selectedPrint=await opened;await selectedPrint.waitForLoadState();assert.equal(await selectedPrint.locator("pre").textContent(),selected);await selectedPrint.close();
    await p.goto(base+"/#/schema");await p.getByTestId("tab-system").click();
    await p.getByTestId("storage-breakdown").waitFor();await p.screenshot({path:join(root,"verification/storage.png")});
    await p.goto(`${base}/api/pdf/print/${docId}?from=1&to=120`);
    await p.locator("#handoff").waitFor();
    assert.equal(await p.locator("#open").getAttribute("href"),`/api/documents/${docId}/original`);
    assert.equal(await p.locator(".sheet").count(),0);
    await p.goto(`${base}/api/pdf/print/${docId}?from=1&to=20`);
    await p.waitForFunction(()=>document.body.dataset.ready==="true");
    assert.equal(await p.locator("body").getAttribute("data-print-mode"),"pdf");
    await p.goto(`${base}/api/pdf/print/${docId}?from=1&to=2`);
    await p.waitForFunction(()=>document.body.dataset.ready==="true");await p.evaluate(()=>window.dispatchEvent(new Event("afterprint")));
    assert.equal(await p.locator(".sheet").count(),0);
  }finally{await context.close();}
  for(const headers of [{},{Origin:"http://evil.invalid","X-APD-PDF-Action":"open-original"},{Origin:base}]){
    assert.equal((await fetch(`${base}/api/pdf/open-original/${docId}`,{method:"POST",headers})).status,403);
  }
  record("Selected-only copy/print, storage display, large PDF handoff, bounded small previews, after-print cleanup and open-original CSRF refusal");
});
test("password/copy restrictions reject before import; print restrictions are separate",async()=>{
  const path=join(temp,"fixture.pdf");writeFileSync(path,fixture);
  const before=(await json("/api/stats")).documents,bytes=(await json("/api/backup/size")).original_bytes;
  for(const [name,user,args,code]of [["Password.pdf","secret",[],"PDF_PASSWORD_REQUIRED"],["NoCopy.pdf","",["--extract=n"],"PDF_COPY_RESTRICTED"]]){
    const out=join(temp,name);execFileSync("qpdf",["--encrypt",user,"owner-secret","256",...args,"--",path,out]);
    const form=new FormData();form.append("file",new Blob([readFileSync(out)]),name);
    form.append("metadata",JSON.stringify({document_type:types[0].key}));
    const response=await fetch(base+"/api/upload",{method:"POST",body:form});
    assert.equal(response.status,422);assert.equal((await response.json()).code,code);
    assert.equal((await json("/api/stats")).documents,before);assert.equal((await json("/api/backup/size")).original_bytes,bytes);
  }
  for(const mode of ["none","low"]){
    const out=join(temp,`${mode}.pdf`);execFileSync("qpdf",["--encrypt","","owner-secret","256",`--print=${mode}`,"--",path,out]);
    const id=(await upload(`${mode}.pdf`,readFileSync(out))).document.id,p=await browser.newPage();
    await p.goto(`${base}/api/pdf/print/${id}?from=1&to=1`);
    if(mode==="none"){await p.getByText(/This PDF does not allow printing/).waitFor();assert.equal(await p.locator(".sheet").count(),0);}
    else{await p.waitForFunction(()=>document.body.dataset.ready==="true");assert.equal(await p.locator("body").getAttribute("data-dpi"),"150");}
    await p.close();
  }
  record("Opening-password/copy restrictions rejected without residue; none/low print permissions respected");
});
test("backup contains retained originals; damaged-original backup rejected without modifying live library",async()=>{
  assert.equal((await fetch(`${base}/api/documents/${docId}/edit-open`,{method:"POST"})).status,400);
  const duplicate=await upload("Exact-copy.pdf",fixture);
  const groups=(await json("/api/documents/duplicates")).groups;
  assert.ok(groups.some(g=>g.docs.some(d=>d.id===docId)&&g.docs.some(d=>d.id===duplicate.document.id)));
  // A genuine stored image and retained Word file exercise the mixed library,
  // not just mocked viewer metadata.
  const old=await fetch(base+"/api/ingest",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({title:"Legacy image PDF",file_name:"Legacy.pdf",document_type:types[0].key,
      body:"Legacy image-only PDF content must survive this integration without conversion."})});
  const oldData=await old.json();legacyId=oldData.document.id;
  const canvas=createCanvas(600,800),ctx=canvas.getContext("2d");
  ctx.fillStyle="white";ctx.fillRect(0,0,600,800);ctx.fillStyle="black";ctx.fillText("Legacy stored page",50,100);
  legacyBytes=canvas.toBuffer("image/jpeg");
  const legacyPath=join(temp,"pages",legacyId,"p0001.jpg");mkdirSync(join(temp,"pages",legacyId),{recursive:true});
  writeFileSync(legacyPath,legacyBytes);
  const db=new Database(join(temp,"advisepoint.db"));
  db.prepare("INSERT INTO document_pages(document_id,page_number,image_path,width,height,generated_at) VALUES(?,1,?,600,800,?)").run(legacyId,legacyPath,new Date().toISOString());
  db.prepare("INSERT INTO document_render_status(document_id,status,rendered,total,updated_at) VALUES(?,'ready',1,1,?)").run(legacyId,new Date().toISOString());db.close();
  const word=new JSZip();
  word.file("[Content_Types].xml",'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  word.file("_rels/.rels",'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  word.file("word/document.xml",'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Retained Word formatting remains available alongside PDF documents.</w:t></w:r></w:p></w:body></w:document>');
  wordBytes=await word.generateAsync({type:"nodebuffer"});wordId=(await upload("Word.docx",wordBytes)).document.id;
  const res=await fetch(base+"/api/backup/export");assert.equal(res.status,200);
  backupBytes=Buffer.from(await res.arrayBuffer());const zip=await JSZip.loadAsync(backupBytes);
  assert.equal(digest(await zip.file(`originals/${docId}.pdf`).async("nodebuffer")),digest(fixture));
  zip.remove(`originals/${docId}.pdf`);const broken=await zip.generateAsync({type:"nodebuffer"});
  const before=(await json("/api/stats")).documents;
  const form=new FormData();form.append("file",new Blob([broken]),"broken.zip");form.append("mode","merge");
  const failed=await fetch(base+"/api/backup/import",{method:"POST",body:form});
  assert.ok(!failed.ok);assert.equal((await json("/api/stats")).documents,before);
  assert.equal(digest(readFileSync(join(temp,"originals",`${docId}.pdf`))),digest(fixture));
  record("Export preserves retained bytes; missing-original restore rejected before live writes");
});
test("restart preserves PDFs, geometry and metadata; good backup merges into separate empty library",async()=>{
  await stop();await start();
  assert.equal((await json(`/api/documents/${docId}/pages`)).pages.length,120);
  const originalTemp=temp;await stop();temp=mkdtempSync(join(tmpdir(),"apd-v130-restored-"));await start();
  const form=new FormData();form.append("file",new Blob([backupBytes]),"good.zip");form.append("mode","merge");
  const response=await fetch(base+"/api/backup/import",{method:"POST",body:form}),data=await response.json();
  assert.equal(response.status,200,JSON.stringify(data));
  assert.equal(digest(readFileSync(join(temp,"originals",`${docId}.pdf`))),digest(fixture));
  assert.equal(digest(readFileSync(join(originalTemp,"originals",`${docId}.pdf`))),digest(fixture));
  const {context}=await openDoc();await context.close();
  assert.equal((await json("/api/backup/size")).pages_bytes,legacyBytes.length);
  assert.equal((await json(`/api/documents/${legacyId}/pages`)).viewer,"page-images");
  assert.equal(digest(Buffer.from(await (await fetch(`${base}/api/documents/${legacyId}/pages/1.jpg`)).arrayBuffer())),digest(legacyBytes));
  assert.equal(digest(Buffer.from(await (await fetch(`${base}/api/documents/${wordId}/original`)).arrayBuffer())),digest(wordBytes));
  const legacyPage=await browser.newPage();await legacyPage.goto(base+`/#/library/${legacyId}`);
  await legacyPage.getByTestId("button-view-pages").click();
  await legacyPage.waitForFunction(()=>[...document.querySelectorAll('[data-testid="viewer-continuous-stack"] img')].some(i=>i.complete&&i.naturalWidth===600));
  assert.equal(await legacyPage.locator('[data-testid^="native-page-"]').count(),0);await legacyPage.close();
  assert.deepEqual(evidence.browserErrors,[]);
  record("Restart and merged backup retain working native PDF library, leaving prior test library untouched");
});
test("wipe-and-replace verifies retained originals and preserves the previous mixed library",async()=>{
  const before=await json("/api/stats");
  const form=new FormData();form.append("file",new Blob([backupBytes]),"good.zip");form.append("mode","wipe");
  const response=await fetch(base+"/api/backup/import",{method:"POST",body:form}),data=await response.json();
  assert.equal(response.status,200,JSON.stringify(data));assert.equal(data.restart_required,true);
  assert.ok(existsSync(join(data.bak_dir,"originals",`${docId}.pdf`)));
  assert.equal(digest(readFileSync(join(data.bak_dir,"originals",`${docId}.pdf`))),digest(fixture));
  await stop();await start();
  assert.equal((await json("/api/stats")).documents,before.documents);
  const {context}=await openDoc();await context.close();
  assert.equal((await json(`/api/documents/${legacyId}/pages`)).viewer,"page-images");
  record("Verified wipe-restore/restart preserves native PDFs, legacy metadata and old library backup");
});
