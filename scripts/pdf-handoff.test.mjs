// Candidate 10: exact threshold, untouched originals, legacy attachment,
// fallback, viewer identity, browser controls, backups and reversible deletion.
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {spawn,execFileSync} from "node:child_process";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,unlinkSync,existsSync,rmSync,readdirSync,linkSync,renameSync} from "node:fs";
import {join,resolve,basename} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import Database from "better-sqlite3";
import {PDFDocument,StandardFonts} from "pdf-lib";
import {chromium,firefox} from "playwright";
import JSZip from "jszip";
const root=resolve(import.meta.dirname,".."),base="http://127.0.0.1:5200";
const delay=ms=>new Promise(r=>setTimeout(r,ms)),digest=b=>createHash("sha256").update(b).digest("hex");
let temp,server,output="",types,native,rendered,legacy,restricted,plain,manual;
const evidence={checks:[],browsers:[],windows:"NOT TESTED",physical_print:"NOT TESTED"};
const json=async p=>(await fetch(base+p)).json();
async function start(){
  server=spawn(process.execPath,["dist/index.cjs"],{cwd:root,env:{...process.env,NODE_ENV:"production",PORT:"5200",
    RAG_DB_PATH:join(temp,"advisepoint.db"),RAG_PAGES_DIR:join(temp,"pages"),APD_LOG_DIR:join(temp,"logs"),
    RAG_NO_SEED:"1",RAG_NO_IDLE_SHUTDOWN:"1",APD_LOCAL_TEST:"1"},stdio:["ignore","pipe","pipe"]});
  server.stdout.on("data",b=>output+=b);server.stderr.on("data",b=>output+=b);
  for(let n=0;n<200;n++){if(server.exitCode!==null)throw Error(output);try{if((await fetch(base+"/api/health")).ok)return;}catch{}await delay(100);}throw Error(output);
}
async function stop(){if(server?.exitCode===null){server.kill();await new Promise(r=>server.once("exit",r));}}
async function upload(name,bytes,mode){
  const body=new FormData();body.append("file",new Blob([bytes]),name);
  body.append("metadata",JSON.stringify({title:name,document_type:types[0].key}));
  if(mode)body.append("pdf_import_mode",mode);
  const r=await fetch(base+"/api/upload",{method:"POST",body}),j=await r.json();assert.equal(r.status,200,JSON.stringify(j));return j.document.id;
}
async function ready(id){
  for(let n=0;n<600;n++){const s=await json(`/api/documents/${id}/pages/status`);
    if(s.status==="ready")return;assert.notEqual(s.status,"error",s.error);await delay(100);}throw Error("Render deadline");
}
const attach=async(id,bytes,origin=base,name="original.pdf")=>{
  const body=new FormData();body.append("file",new Blob([bytes]),name);
  return fetch(base+`/api/pdf/attach-original/${id}`,{method:"POST",headers:{Origin:origin,"X-APD-PDF-Action":"attach-original"},body});
};
before(async()=>{
  temp=mkdtempSync(join(tmpdir(),"apd-handoff-"));await start();types=(await json("/api/document-types")).types;
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
  for(let n=1;n<=54;n++)pdf.addPage([180,180]).drawText(`Page ${n} printer manual searchable text`,{x:5,y:100,size:6,font});
  plain=Buffer.from(await pdf.save());writeFileSync(join(temp,"plain.pdf"),plain);
  execFileSync("qpdf",["--encrypt","","owner","256","--extract=n","--",join(temp,"plain.pdf"),join(temp,"restricted.pdf")]);
  restricted=readFileSync(join(temp,"restricted.pdf"));
  native=await upload("native.pdf",plain);rendered=await upload("rendered.pdf",restricted,"rendered");
  legacy=await upload("legacy.pdf",restricted,"rendered");await ready(rendered);await ready(legacy);
  await stop();
  const db=new Database(join(temp,"advisepoint.db"));
  db.prepare("UPDATE documents SET original_ext=NULL,pdf_rendered=0 WHERE id=?").run(legacy);
  unlinkSync(join(temp,"originals",legacy+".pdf"));
  if(process.env.APD_RENDER_FIXTURE){
    const old=new Database(join(process.env.APD_RENDER_FIXTURE,"advisepoint.db"),{readonly:true});
    manual=old.prepare("SELECT d.id FROM documents d JOIN document_render_status r ON r.document_id=d.id WHERE d.original_ext IS NULL AND r.total=724").get().id;
    for(const [table,filter]of [["documents","id"],["document_pages","document_id"],["document_render_status","document_id"]]){
      const cols=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(x=>x.name));
      for(const row of old.prepare(`SELECT * FROM ${table} WHERE ${filter}=?`).all(manual)){
        const keys=Object.keys(row).filter(k=>cols.has(k));
        db.prepare(`INSERT INTO ${table} (${keys.map(k=>`"${k}"`).join(",")}) VALUES (${keys.map(()=>"?").join(",")})`).run(...keys.map(k=>row[k]));
      }
    }
    old.close();mkdirSync(join(temp,"pages",manual),{recursive:true});
    for(const name of readdirSync(join(process.env.APD_RENDER_FIXTURE,"pages",manual)))
      linkSync(join(process.env.APD_RENDER_FIXTURE,"pages",manual,name),join(temp,"pages",manual,name));
  }
  db.close();await start();
});
after(async()=>{
  await stop();writeFileSync(join(root,"verification/candidate13-handoff-results.json"),JSON.stringify({...evidence,temp},null,2));
  writeFileSync(join(root,"verification/candidate13-handoff-server.log"),output);
  rmSync(temp,{recursive:true,force:true});
});
test("fallback original is retained byte-identically without changing viewer or rendered images",async()=>{
  assert.equal((await json(`/api/documents/${rendered}/pages`)).viewer,"page-images");
  assert.equal((await json(`/api/documents/${native}/pages`)).viewer,"pdf-native");
  assert.equal((await json(`/api/documents/${legacy}/pages`)).viewer,"page-images");
  assert.deepEqual(Buffer.from(await (await fetch(base+`/api/documents/${rendered}/original`)).arrayBuffer()),restricted);
  assert.equal((await fetch(base+`/api/documents/${rendered}/pages/54.jpg`)).status,200);
});
test("native subsets stay prepared above 50; full manuals and rendered 51-page selections use handoff",async()=>{
  for(const [route,id]of [["pdf/print",native],["rendered-print",rendered],["rendered-print",legacy]]){
    for(const [from,to,expected]of [[1,1,false],[1,49,false],[5,54,false],[4,54,true],[1,54,true]]){
      const r=await fetch(base+`/api/${route}/${id}?from=${from}&to=${to}&embedded=1`);
      const handoff=expected&&(route!=="pdf/print"||(from===1&&to===54));
      assert.equal(r.status,200);assert.equal((await r.text()).includes("/pdf-handoff.js"),handoff);
    }
    for(const range of ["from=0&to=54","from=1&to=55","from=3&to=2","from=1.5&to=2"]){
      assert.equal((await fetch(base+`/api/${route}/${id}?${range}`)).status,400);
    }
  }
  evidence.checks.push("Native subsets stay prepared at 51 pages; whole native manual and rendered 51-page selections keep original handoff; invalid ranges rejected.");
});
for(const [name,engine]of [["Chromium",chromium],["Firefox",firefox]]){
  test(`${name}: native 1/50/51-page ranges deliver only the selected pages to the reader`,{timeout:90000},async()=>{
    const browser=await engine.launch({headless:true}),context=await browser.newContext(),p=await context.newPage();
    try{
      await p.goto(base+`/#/library/${native}`);await p.getByTestId("button-view-pages").click();
      for(const [from,to]of [[54,54],[5,54],[4,54]]){
        await p.getByTestId("button-print-page").click();await p.getByTestId("radio-print-range").check();
        await p.getByTestId("input-print-from").fill(String(from));await p.getByTestId("input-print-to").fill(String(to));
        await p.getByTestId("button-print-confirm").click();
        const f=p.frameLocator('[data-testid="print-preparation-frame"]');
        await f.locator('body[data-ready="true"]').waitFor({timeout:30000});
        assert.equal(await f.locator("body").getAttribute("data-print-mode"),"pdf");
        assert.equal(await f.locator("canvas,.sheet").count(),0);
        const url=await f.locator("#prepared-download").getAttribute("href");
        assert.ok(url.startsWith("blob:"),"Range is a prepared subset, not the original URL");
        const downloadPromise=p.waitForEvent("download");await f.locator("#prepared-download").click();
        const download=await downloadPromise,bytes=new Uint8Array(readFileSync(await download.path()));
        const pdf=await PDFDocument.load(bytes);assert.equal(pdf.getPageCount(),to-from+1);
        const {getDocument}=await import("pdfjs-dist/legacy/build/pdf.mjs");
        const task=getDocument({data:bytes.slice()}),doc=await task.promise;
        try{for(let n=1;n<=doc.numPages;n++){
          const text=(await (await doc.getPage(n)).getTextContent()).items.map(x=>x.str).join(" ");
          assert.match(text,new RegExp(`^Page ${from+n-1} printer manual`));
        }}finally{await task.destroy();}
        // The primary reader button must receive the same exact subset blob.
        await f.locator("body").evaluate(()=>{
          window.__opened=[];window.open=url=>{window.__opened.push(url);return null;};
        });
        await f.locator("#print").click();
        assert.deepEqual(await f.locator("body").evaluate(()=>window.__opened),[url]);
        await p.getByTestId("print-preparation-done").click();
        await p.getByTestId("print-preparation-dialog").waitFor({state:"hidden"});
      }
      assert.equal(digest(Buffer.from(await (await fetch(base+`/api/documents/${native}/original`)).arrayBuffer())),digest(plain));
      evidence.checks.push(`${name}: native 1/50/51-page subsets, every output page's text/order, download and primary reader URL, no image raster, original unchanged.`);
    }finally{await context.close();await browser.close();}
  });
  test(`${name}: handoff skips all preparation, downloads original, keeps dialog and reader open`,{timeout:90000},async()=>{
    const browser=await engine.launch({headless:true,...(name==="Firefox"?{firefoxUserPrefs:{"pdfjs.disabled":false}}:{})}),context=await browser.newContext(),p=await context.newPage();
    context.setDefaultTimeout(15000);
    evidence.browsers.push({name,version:browser.version()});let requests=[];
    try{for(const id of [native,rendered]){
      await p.goto(base+`/#/library/${id}`);await p.getByTestId("button-view-pages").click();
      await p.getByTestId("button-print-page").waitFor();await p.getByTestId("button-print-page").click();
      await p.getByTestId("radio-print-range").check();await p.getByTestId("input-print-from").fill(id===native?"1":"4");
      await p.getByTestId("input-print-to").fill("54");requests=[];
      const listener=r=>requests.push(r.url());p.on("request",listener);
      await p.getByTestId("button-print-confirm").click();
      const f=p.frameLocator('[data-testid="print-preparation-frame"]');await f.locator("#handoff").waitFor();
      assert.match(await f.locator("#range").innerText(),id===native?/Whole manual: 54 pages/:/FULL original.*4–54.*Do not leave All/s);
      assert.equal(context.pages().length,1);
      assert.equal(requests.some(u=>/rendered-print-jobs|pdf-print-worker|pdf\.worker/.test(u)),false);
      assert.equal(await f.locator("canvas,progress").count(),0);
      const downloadPromise=p.waitForEvent("download");await f.locator("#download").click();
      const d=await downloadPromise,bytes=readFileSync(await d.path());
      assert.equal(digest(bytes),digest(id===native?plain:restricted));
      const popupPromise=context.waitForEvent("page");await f.locator("#open").click();
      const popup=await popupPromise;
      // Firefox's built-in reader must settle before we close it later;
      // Chromium's PDF plugin does not emit a normal DOMContentLoaded event.
      if(name==="Firefox")await popup.waitForLoadState("domcontentloaded",{timeout:15000});
      assert.equal(await p.getByTestId("print-preparation-dialog").isVisible(),true);
      assert.equal(await f.locator("#pc").count(),0);
      assert.equal(await f.getByRole("button",{name:"Open in PC PDF app"}).count(),0);
      if(id===rendered){
        await p.screenshot({path:join(root,`verification/candidate10-${name}-handoff.png`)});
        await p.setViewportSize({width:375,height:812});
        assert.equal(await f.locator("body").evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        await p.screenshot({path:join(root,`verification/candidate10-${name}-mobile.png`)});
      }
      await p.getByTestId("print-preparation-done").click();await p.getByTestId("print-preparation-dialog").waitFor({state:"hidden"});
      assert.equal(popup.isClosed(),false);await popup.close();
      assert.deepEqual(Buffer.from(await (await fetch(base+`/api/documents/${id}/original`)).arrayBuffer()),id===native?plain:restricted);
      p.off("request",listener);await p.reload();
    }}finally{await context.close();await browser.close();}
  });
}
test("legacy attachment rejects wrong origins, mismatched PDFs and unverified entries without writes",async()=>{
  assert.equal((await attach(legacy,restricted,"https://evil.test")).status,403);
  assert.equal((await attach(legacy,plain)).status,409);
  assert.equal((await attach(legacy,restricted,base,"wrong.txt")).status,400);
  assert.equal((await attach(native,plain)).status,404);
  assert.equal(existsSync(join(temp,"originals",legacy+".pdf")),false);
  assert.equal((await fetch(base+`/api/documents/${legacy}/pages/54.jpg`)).status,200);
  const path=join(temp,"originals",legacy+".pdf");
  writeFileSync(path,plain);
  try {
    assert.equal((await attach(legacy,restricted)).status,500);
    assert.deepEqual(readFileSync(path),plain);
  } finally {unlinkSync(path);}
  const db=new Database(join(temp,"advisepoint.db"));
  const old=db.prepare("SELECT file_hash_sha256 FROM documents WHERE id=?").get(legacy).file_hash_sha256;
  db.prepare("UPDATE documents SET file_hash_sha256=NULL WHERE id=?").run(legacy);
  try {
    assert.equal((await attach(legacy,restricted)).status,409);
    const html=await (await fetch(base+`/api/rendered-print/${legacy}?from=1&to=54`)).text();
    assert.match(html,/original cannot be verified/);assert.match(html,/Prepare from saved pages instead/);
  } finally {db.prepare("UPDATE documents SET file_hash_sha256=? WHERE id=?").run(old,legacy);db.close();}
});
for (const [name,engine] of [["Chromium",chromium],["Firefox",firefox]]) {
  test(`${name}: text-viewer download icon, tooltip, keyboard and unchanged original bytes`,async()=>{
    const b=await engine.launch({headless:true}),p=await b.newPage({viewport:{width:1280,height:900}});
    try {
      for (const [id,bytes,filename] of [[native,plain,"native.pdf"],[rendered,restricted,"rendered.pdf"]]) {
        await p.goto(base+`/#/library/${id}`);await p.getByTestId("text-section-body").waitFor();
        const icon=p.getByTestId("button-download-original-pdf");
        await icon.waitFor();await icon.hover();
        await p.getByRole("tooltip",{name:"Download original PDF"}).waitFor();
        for (const control of ["button-copy-section","button-print-section","button-view-section-pages"])
          assert.equal(await p.getByTestId(control).isVisible(),true);
        const url=p.url(),download=p.waitForEvent("download");
        await icon.focus();await p.keyboard.press("Enter");
        const d=await download;assert.equal(d.suggestedFilename(),filename);
        assert.equal(digest(readFileSync(await d.path())),digest(bytes));assert.equal(p.url(),url);
        assert.equal(p.context().pages().length,1);
        await icon.locator("..").screenshot({path:join(root,`verification/candidate10-${name}-download-toolbar.png`)});
        await p.setViewportSize({width:375,height:812});await icon.scrollIntoViewIfNeeded();
        const box=await icon.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=375);
        await p.screenshot({path:join(root,`verification/candidate10-${name}-download-mobile.png`)});
        await p.setViewportSize({width:1280,height:900});
      }
      await p.goto(base+`/#/library/${legacy}`);await p.getByTestId("text-section-body").waitFor();
      assert.equal(await p.getByTestId("button-download-original-pdf").count(),0);
      assert.equal((await json(`/api/documents/${legacy}`)).document.has_original_pdf,false);
    } finally {await b.close();}
  });
}
test("download availability excludes missing originals and non-PDF entries; download supports Unicode filenames",async()=>{
  const path=join(temp,"originals",rendered+".pdf");renameSync(path,path+".test-held");
  const b=await chromium.launch({headless:true}),p=await b.newPage();
  try {
    assert.equal((await json(`/api/documents/${rendered}`)).document.has_original_pdf,false);
    await p.goto(base+`/#/library/${rendered}`);await p.getByTestId("text-section-body").waitFor();
    assert.equal(await p.getByTestId("button-download-original-pdf").count(),0);
    assert.equal((await fetch(base+`/api/documents/${rendered}/original?download=1`)).status,404);
  } finally {renameSync(path+".test-held",path);await b.close();}
  const txt=await upload("Notes.txt",Buffer.from("Printer maintenance reference instructions."));
  assert.equal((await json(`/api/documents/${txt}`)).document.has_original_pdf,false);
  const filename='Guide café 日本語.pdf',unicode=await upload(filename,plain);
  const r=await fetch(base+`/api/documents/${unicode}/original?download=1`);
  assert.equal(r.status,200);assert.match(r.headers.get("content-disposition"),/^attachment;/);
  assert.match(r.headers.get("content-disposition"),/filename\*=UTF-8''/);
  assert.equal(digest(Buffer.from(await r.arrayBuffer())),digest(plain));
  evidence.checks.push("Text toolbar icon only for physically available retained PDFs; tooltip, keyboard, desktop/mobile, original filename and SHA-256 checked in Chromium/Firefox.");
});
test("legacy browser attachment preserves metadata/index/pages, enables handoff, and is idempotent",async()=>{
  const db=new Database(join(temp,"advisepoint.db"),{readonly:true});
  const before=db.prepare("SELECT * FROM documents WHERE id=?").get(legacy);
  const chunks=db.prepare("SELECT * FROM chunks WHERE parent_id=?").all(legacy);db.close();
  const image=digest(Buffer.from(await (await fetch(base+`/api/documents/${legacy}/pages/54.jpg`)).arrayBuffer()));
  const b=await chromium.launch({headless:true}),p=await b.newPage();
  try{
    await p.goto(base+`/api/rendered-print/${legacy}?from=1&to=54&embedded=1`);
    await p.locator("#attach-section").waitFor();assert.equal(await p.locator("progress").count(),0);
    await p.locator("#original-file").setInputFiles(join(temp,"restricted.pdf"));
    await p.locator("#attach").click();await p.locator("#handoff").waitFor();
    assert.match(await p.locator("#status").innerText(),/verified and attached/);
    assert.equal((await attach(legacy,restricted)).status,200);
  }finally{await b.close();}
  const check=new Database(join(temp,"advisepoint.db"),{readonly:true});
  assert.deepEqual(check.prepare("SELECT * FROM documents WHERE id=?").get(legacy),{...before,original_ext:"pdf",pdf_rendered:1});
  assert.deepEqual(check.prepare("SELECT * FROM chunks WHERE parent_id=?").all(legacy),chunks);check.close();
  assert.equal((await json(`/api/documents/${legacy}/pages`)).viewer,"page-images");
  assert.equal(digest(Buffer.from(await (await fetch(base+`/api/documents/${legacy}/pages/54.jpg`)).arrayBuffer())),image);
  evidence.checks.push("Exact attachment changes only original_ext/pdf_rendered; SHA mismatch, wrong origin and unsupported entries rejected.");
});
test("saved-page alternative still prepares and Done cleans switched-frame job",async()=>{
  const b=await chromium.launch({headless:true}),p=await b.newPage();
  try{
    await p.goto(base+`/#/library/${rendered}`);await p.getByTestId("button-view-pages").click();
    await p.getByTestId("button-print-page").click();await p.getByTestId("radio-print-all").check();
    await p.getByTestId("button-print-confirm").click();
    const f=p.frameLocator('[data-testid="print-preparation-frame"]');await f.locator("#fallback").click();
    await f.locator("#ready").waitFor({timeout:60000});
    const url=await f.locator("#open").getAttribute("href"),r=await fetch(base+url);
    const pdf=await PDFDocument.load(await r.arrayBuffer());assert.equal(pdf.getPageCount(),54);
    await p.getByTestId("print-preparation-done").click();await p.getByTestId("print-preparation-dialog").waitFor({state:"hidden"});
    assert.equal((await fetch(base+url)).status,409);
  }finally{await b.close();}
});
test("actual 724-page legacy manual attaches and hands off exact original without a print worker",{skip:process.env.APD_SYNTHETIC_ONLY==="1"},async()=>{
  assert.ok(manual&&process.env.APD_RESTRICTED_MANUAL,"Supply disposable 724-page fixture and original manual.");
  const bytes=readFileSync(process.env.APD_RESTRICTED_MANUAL);
  const r=await attach(manual,bytes);assert.equal(r.status,200,await r.text());
  const html=await (await fetch(base+`/api/rendered-print/${manual}?from=1&to=724`)).text();
  assert.match(html,/Whole manual: 724 pages/);assert.match(html,/data-available="true"/);
  const delivered=Buffer.from(await (await fetch(base+`/api/documents/${manual}/original`)).arrayBuffer());
  assert.equal(digest(delivered),digest(bytes));
  assert.equal((await fetch(base+`/api/documents/${manual}/pages/724.jpg`)).status,200);
  assert.equal((await json(`/api/documents/${manual}/pages`)).viewer,"page-images");
  evidence.actual_manual={pages:724,original_bytes:bytes.length,sha256:digest(bytes)};
});
test("reversible deletion restores retained fallback original and rendered viewer identity",async()=>{
  const before=(await json(`/api/documents/${rendered}`)).document;
  const removed=await fetch(base+`/api/documents/${rendered}`,{method:"DELETE"});
  assert.equal(removed.status,200);const result=await removed.json();
  assert.equal((await fetch(base+`/api/documents/${rendered}/original?download=1`)).status,404);
  const restored=await fetch(base+`/api/documents/removed/${encodeURIComponent(basename(result.quarantine_dir))}/restore`,{method:"POST"});
  assert.equal(restored.status,200,await restored.text());
  const after=(await json(`/api/documents/${rendered}`)).document;
  assert.equal(after.has_original_pdf,true);assert.equal(after.pdf_rendered,before.pdf_rendered);
  assert.equal((await json(`/api/documents/${rendered}/pages`)).viewer,"page-images");
  assert.equal(digest(Buffer.from(await (await fetch(base+`/api/documents/${rendered}/original?download=1`)).arrayBuffer())),digest(restricted));
});
test("restart and verified backup preserve originals plus rendered viewer marker",async()=>{
  await stop();await start();
  assert.equal((await json(`/api/documents/${legacy}/pages`)).viewer,"page-images");
  const r=await fetch(base+"/api/backup/export");assert.equal(r.status,200);
  const good=await r.arrayBuffer(),archive=await JSZip.loadAsync(good);
  const entry=Object.keys(archive.files).find(n=>n.endsWith(`originals/${legacy}.pdf`));assert.ok(entry);
  assert.deepEqual(await archive.file(entry).async("nodebuffer"),restricted);
  // Damaged-original backups must fail before live rows change.
  archive.remove(entry);const body=new FormData();
  body.append("file",new Blob([await archive.generateAsync({type:"nodebuffer"})]),"missing-original.zip");body.append("mode","merge");
  const failed=await fetch(base+"/api/backup/import",{method:"POST",body});assert.ok(failed.status>=400);
  assert.deepEqual(Buffer.from(await (await fetch(base+`/api/documents/${legacy}/original`)).arrayBuffer()),restricted);
  const old=temp;await stop();temp=mkdtempSync(join(tmpdir(),"apd-handoff-restored-"));await start();
  const restore=new FormData();restore.append("file",new Blob([good]),"verified.zip");restore.append("mode","merge");
  const merged=await fetch(base+"/api/backup/import",{method:"POST",body:restore});
  assert.equal(merged.status,200,await merged.text());
  assert.equal((await json(`/api/documents/${legacy}`)).document.has_original_pdf,true);
  assert.equal((await json(`/api/documents/${legacy}/pages`)).viewer,"page-images");
  assert.deepEqual(Buffer.from(await (await fetch(base+`/api/documents/${legacy}/original?download=1`)).arrayBuffer()),restricted);
  if(process.env.APD_SYNTHETIC_ONLY!=="1")
    assert.equal((await fetch(base+`/api/documents/${manual}/pages/724.jpg`)).status,200);
  rmSync(old,{recursive:true,force:true});
  evidence.checks.push("Restart retains rendered identity; export includes original; missing-original restore rejected without changing live file.");
  evidence.checks.push("Verified backup merges into an empty disposable library with retained originals, download availability and rendered viewer identity preserved.");
  if(process.env.APD_SYNTHETIC_ONLY==="1")
    evidence.checks.push("Explicit synthetic-only run: real 724-page fixture and its restored page check were NOT run.");
});
