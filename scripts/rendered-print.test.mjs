// Uses only a copy of a disposable rendering fixture. Never opens a user library.
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {spawn,fork,execFileSync} from "node:child_process";
import {mkdtempSync,mkdirSync,readdirSync,linkSync,renameSync,writeFileSync,readFileSync,createWriteStream,createReadStream,statSync,rmSync} from "node:fs";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {randomUUID,createHash} from "node:crypto";
import {pipeline} from "node:stream/promises";
import {Readable} from "node:stream";
import {inflateSync} from "node:zlib";
import Database from "better-sqlite3";
import {PDFDocument,PDFName} from "pdf-lib";
import {createCanvas,loadImage} from "@napi-rs/canvas";
import {chromium} from "playwright";
const fixture=process.env.APD_RENDER_FIXTURE,root=resolve(import.meta.dirname,".."),base="http://127.0.0.1:5197";
let manual,native;
const headers={"Content-Type":"application/json",Origin:base,"X-APD-PDF-Action":"rendered-print"};
const delay=ms=>new Promise(r=>setTimeout(r,ms)),hash=b=>createHash("sha256").update(b).digest("hex");
let temp,server,browser,output="",fullId;
const evidence={checks:[],latencies_ms:[],manual:null};
const api=async(p,body,h=headers)=>fetch(base+p,body?{method:"POST",headers:h,body:JSON.stringify(body)}:undefined);
async function start(from,to,doc=manual){
  const id=randomUUID(),r=await api("/api/rendered-print-jobs",{id,documentId:doc,from,to});
  assert.equal(r.status,200,await r.text());return id;
}
async function finish(id){
  for(let n=0;n<1200;n++){
    const j=await (await api(`/api/rendered-print-jobs/${id}`)).json();
    if(j.state!=="preparing")return j;await delay(500);
  }throw Error("Test preparation timeout");
}
async function clear(id){assert.equal((await api(`/api/rendered-print-jobs/${id}/cancel`,{})).status,200);}
before(async()=>{
  if(!fixture)return;
  temp=mkdtempSync(join(tmpdir(),"apd-rendered-print-qa-"));
  const old=new Database(join(fixture,"advisepoint.db"),{readonly:true});
  manual=old.prepare("SELECT d.id FROM documents d JOIN document_render_status r ON r.document_id=d.id WHERE d.original_ext IS NULL AND r.total=724 AND d.title LIKE '%7353%'").get()?.id;
  native=old.prepare("SELECT id FROM documents WHERE original_ext='pdf' LIMIT 1").get()?.id;
  assert.ok(manual&&native,"Fixture must contain the completed 7353 manual and a retained PDF.");
  mkdirSync(join(temp,"pages",manual),{recursive:true});
  await old.backup(join(temp,"advisepoint.db"));old.close();
  for(const name of readdirSync(join(fixture,"pages",manual)))linkSync(join(fixture,"pages",manual,name),join(temp,"pages",manual,name));
  server=spawn(process.execPath,["dist/index.cjs"],{cwd:root,env:{...process.env,NODE_ENV:"production",PORT:"5197",
    RAG_DB_PATH:join(temp,"advisepoint.db"),RAG_PAGES_DIR:join(temp,"pages"),APD_LOG_DIR:join(temp,"logs"),
    RAG_NO_SEED:"1",RAG_NO_IDLE_SHUTDOWN:"1",APD_LOCAL_TEST:"1"},stdio:["ignore","pipe","pipe"]});
  server.stdout.on("data",b=>output+=b);server.stderr.on("data",b=>output+=b);
  for(let n=0;n<150;n++){try{if((await api("/api/health")).ok)break;}catch{}await delay(100);}
  browser=await chromium.launch({headless:true,channel:"chromium"});
});
after(async()=>{
  await browser?.close();if(server?.exitCode===null){server.kill();await new Promise(r=>server.once("exit",r));}
  mkdirSync(join(root,"verification"),{recursive:true});
  writeFileSync(join(root,"verification/rendered-print-results.json"),JSON.stringify({...evidence,temp},null,2));
  writeFileSync(join(root,"verification/rendered-print-server.log"),output);
});
test("rendered print: rejects bad ranges, origins, retained PDFs and incomplete jobs",{skip:!fixture},async()=>{
  for(const body of [{from:0,to:3},{from:1,to:725},{from:5,to:2},{from:1.1,to:3}]){
    assert.equal((await api("/api/rendered-print-jobs",{id:randomUUID(),documentId:manual,...body})).status,400);
  }
  assert.equal((await api("/api/rendered-print-jobs",{id:randomUUID(),documentId:manual,from:1,to:1},{...headers,Origin:"https://evil.test"})).status,403);
  assert.equal((await api("/api/rendered-print-jobs",{id:randomUUID(),documentId:native,from:1,to:1})).status,400);
  assert.equal((await api(`/api/rendered-print-jobs/${randomUUID()}/pdf`)).status,409);
  evidence.checks.push("Invalid ranges, hostile origin, retained PDF route misuse and unknown/partial output refused.");
});
test("rendered print: missing and corrupt pages never expose partial output",{skip:!fixture},async()=>{
  const page=join(temp,"pages",manual,"p0001.webp"),saved=page+".saved";
  renameSync(page,saved);
  try{
    assert.equal((await api("/api/rendered-print-jobs",{id:randomUUID(),documentId:manual,from:1,to:2})).status,400);
    writeFileSync(page,"not an image");
    const id=await start(1,2),j=await finish(id);assert.equal(j.state,"error");
    assert.equal((await api(`/api/rendered-print-jobs/${id}/pdf`)).status,409);await clear(id);
  }finally{rmSync(page,{force:true});renameSync(saved,page);}
  evidence.checks.push("Missing and corrupt page failures expose no incomplete PDF.");
});
test("rendered print: cancel settles before immediate retry; duplicate token is idempotent",{skip:!fixture},async()=>{
  const id=await start(1,724);
  assert.equal((await api(`/api/rendered-print-jobs/${id}/pdf`)).status,409);
  assert.equal((await api("/api/rendered-print-jobs",{id,documentId:manual,from:1,to:724})).status,200);
  assert.equal((await api("/api/rendered-print-jobs",{id:randomUUID(),documentId:manual,from:1,to:2})).status,400);
  await clear(id);assert.equal((await api(`/api/rendered-print-jobs/${id}/pdf`)).status,409);
  const next=await start(1,1);assert.equal((await finish(next)).state,"ready");await clear(next);
  evidence.checks.push("One-worker admission, duplicate idempotency, cancellation, immediate retry.");
});
function journal(){
  return readFileSync(join(temp,"logs","uploads.log"),"utf8").trim().split("\n").map(s=>JSON.parse(s));
}
test("rendered print: killing preparation process preserves server and allows immediate retry",{skip:!fixture},async()=>{
  const id=await start(1,724);
  const row=journal().find(r=>r.event==="rendered_print_started"&&r.job_id===id);
  assert.ok(row.pid&&row.pid!==server.pid);
  process.kill(row.pid,"SIGKILL");
  const j=await finish(id);assert.equal(j.state,"error");assert.match(j.message,/library is still available/i);
  assert.equal((await api("/api/health")).status,200);
  assert.equal((await api(`/api/rendered-print-jobs/${id}/pdf`)).status,409);
  assert.ok(journal().some(r=>r.job_id===id&&r.event==="rendered_print_worker_exit"&&r.signal==="SIGKILL"));
  await clear(id);
  const retry=await start(1,2);assert.equal((await finish(retry)).state,"ready");await clear(retry);
  evidence.checks.push("Forced preparation-process death is contained; server survives, partial PDF blocked, immediate retry succeeds.");
});
// Disposable test build only: swap the child implementation to exercise faults
// at the IPC/finalization boundary. No test switches exist in the application.
async function withFaultWorker(body,fn){
  const file=join(root,"dist/workers/rendered-print-worker.cjs"),saved=readFileSync(file);
  writeFileSync(file,body);
  try{await fn();}finally{writeFileSync(file,saved);}
}
const fakeCompleted=`const fs=require("node:fs");
process.once("message",m=>{
  const b=Buffer.from("%PDF-1.4\\n"+"x".repeat(80)+"\\n%%EOF\\n");fs.writeFileSync(m.output,b);
  process.send({type:"progress",completed:1,bytes:b.length});
  process.send({type:"done",completed:1,bytes:b.length},()=>{ ACTION });
});`;
test("rendered print: native stderr and nonzero exit after done cannot expose a ready PDF",{skip:!fixture},async()=>{
  await withFaultWorker(fakeCompleted.replace("ACTION",'process.stderr.write("simulated native teardown failure\\n");process.exit(86);'),async()=>{
    const id=await start(1,1),j=await finish(id);
    assert.equal(j.state,"error");assert.equal((await api(`/api/rendered-print-jobs/${id}/pdf`)).status,409);
    const rows=journal().filter(r=>r.job_id===id);
    assert.ok(rows.some(r=>r.event==="rendered_print_worker_stderr"&&r.diagnostic.includes("simulated native")));
    assert.ok(rows.some(r=>r.event==="rendered_print_worker_exit"&&r.exit_code===86));
    assert.equal((await api("/api/health")).status,200);await clear(id);
  });
});
test("rendered print: hung successful teardown times out and frees slot only after exit",{skip:!fixture},async()=>{
  await withFaultWorker(fakeCompleted.replace("ACTION","setInterval(()=>{},1000);"),async()=>{
    const id=await start(1,1),j=await finish(id);
    assert.equal(j.state,"error");assert.match(j.message,/closing safely/);
    assert.equal((await api(`/api/rendered-print-jobs/${id}/pdf`)).status,409);
    assert.ok(journal().some(r=>r.job_id===id&&r.event==="rendered_print_worker_exit"));
    await clear(id);
  });
  const retry=await start(1,1);assert.equal((await finish(retry)).state,"ready");await clear(retry);
});
test("rendered print: cancellation at finalization cleans output and preserves server",{skip:!fixture},async()=>{
  await withFaultWorker(fakeCompleted.replace("ACTION","setInterval(()=>{},1000);"),async()=>{
    const id=await start(1,1);
    for(let n=0;n<100;n++){
      if(journal().some(r=>r.job_id===id&&r.stage==="validated_waiting_for_exit"))break;
      await delay(20);
    }
    assert.ok(journal().some(r=>r.job_id===id&&r.stage==="validated_waiting_for_exit"));
    const r=await api(`/api/rendered-print-jobs/${id}/cancel`,{}),result=await r.json();
    assert.equal(result.pending,false);assert.equal((await api(`/api/rendered-print-jobs/${id}`)).status,404);
    assert.equal((await api("/api/health")).status,200);
  });
});
test("rendered print: browser preparation, exact subset, clear/retry, PDF handoff and mobile",{skip:!fixture},async()=>{
  const p=await browser.newPage({viewport:{width:1100,height:850}});
  try{
    await p.goto(`${base}/api/rendered-print/${manual}?from=300&to=302`);
    await p.locator("#ready").waitFor({state:"visible",timeout:30000});
    assert.equal(await p.locator("img,canvas").count(),0);
    const url=await p.locator("#open").getAttribute("href"),r=await fetch(base+url),bytes=new Uint8Array(await r.arrayBuffer());
    const pdf=await PDFDocument.load(bytes);assert.equal(pdf.getPageCount(),3);
    assert.equal((await api(url.replace("/pdf","/open"),{})).status,501);
    await p.screenshot({path:join(root,"verification/rendered-print-desktop.png")});
    await p.setViewportSize({width:375,height:812});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await p.screenshot({path:join(root,"verification/rendered-print-mobile.png")});
    await p.locator("#cancel").click();await p.locator("#retry").click();await p.locator("#ready").waitFor({state:"visible",timeout:30000});
    const url2=await p.locator("#open").getAttribute("href");assert.notEqual(url,url2);
    assert.equal((await fetch(base+url)).status,409);
    await p.locator("#cancel").click();
    evidence.checks.push("Real Chromium UI: three-page subset, no image/canvas DOM, desktop/mobile, clear/retry, guarded Windows-only opening.");
  }finally{await p.close();}
});
test("rendered print: 724 complete pages, lossless image samples and responsive API",{skip:!fixture,timeout:650000},async()=>{
  const started=Date.now();fullId=await start(1,724);
  for(let i=0;i<8;i++){
    await delay(600);const t=performance.now();assert.equal((await api("/api/health")).status,200);evidence.latencies_ms.push(performance.now()-t);
    assert.equal((await fetch(base+`/api/documents/${manual}/pages/1.jpg`)).status,200);
  }
  const j=await finish(fullId);assert.equal(j.state,"ready",JSON.stringify(j));assert.equal(j.completed,724);
  const file=join(temp,"724-prepared.pdf"),r=await api(`/api/rendered-print-jobs/${fullId}/pdf`);
  assert.equal(r.status,200);await pipeline(Readable.fromWeb(r.body),createWriteStream(file));
  const digest=createHash("sha256");for await(const b of createReadStream(file))digest.update(b);
  const sha256=digest.digest("hex");
  if(process.env.APD_EXPECTED_PRINT_SHA256)assert.equal(sha256,process.env.APD_EXPECTED_PRINT_SHA256,"Complete PDF must match the verified previous candidate");
  execFileSync("qpdf",["--check",file],{stdio:"pipe"});
  const pdf=await PDFDocument.load(readFileSync(file));assert.equal(pdf.getPageCount(),724);
  for(const n of [1,299,452,724]){
    const page=pdf.getPage(n-1),resources=page.node.Resources(),xobjects=resources.lookup(PDFName.of("XObject"));
    const stream=xobjects.lookup(PDFName.of("Im0")),rgb=inflateSync(stream.contents);
    const img=await loadImage(join(temp,"pages",manual,`p${String(n).padStart(4,"0")}.webp`));
    const canvas=createCanvas(img.width,img.height),ctx=canvas.getContext("2d");ctx.fillStyle="white";ctx.fillRect(0,0,img.width,img.height);ctx.drawImage(img,0,0);
    const rgba=ctx.getImageData(0,0,img.width,img.height).data,expected=Buffer.alloc(img.width*img.height*3);
    for(let a=0,b=0;a<rgba.length;a+=4){expected[b++]=rgba[a];expected[b++]=rgba[a+1];expected[b++]=rgba[a+2];}
    assert.equal(hash(rgb),hash(expected));assert.equal(page.getWidth(),img.width*72/240);
  }
  const range=await fetch(base+`/api/rendered-print-jobs/${fullId}/pdf`,{headers:{Range:"bytes=0-1023"}});
  assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,1024);
  assert.ok(Math.max(...evidence.latencies_ms)<2000);
  evidence.manual={pages:724,preparation_ms:j.elapsed_ms,verification_total_ms:Date.now()-started,bytes:statSync(file).size,sha256,
    lossless_pages:[1,299,452,724],qpdf:"PASS",range_requests:"PASS",physical_print:"NOT TESTED",windows_hardware:"PENDING"};
  await clear(fullId);fullId=undefined;
  rmSync(file);
});
test("rendered print: second complete 724-page job has identical output and clean process exit",{skip:!fixture,timeout:650000},async()=>{
  const id=await start(1,724),j=await finish(id);assert.equal(j.state,"ready");assert.equal(j.completed,724);
  const digest=createHash("sha256"),r=await api(`/api/rendered-print-jobs/${id}/pdf`);
  assert.equal(r.status,200);for await(const b of Readable.fromWeb(r.body))digest.update(b);
  const sha256=digest.digest("hex");assert.equal(sha256,evidence.manual.sha256);
  const rows=journal().filter(r=>r.job_id===id);
  assert.ok(rows.some(r=>r.stage==="validated_waiting_for_exit"));
  assert.ok(rows.some(r=>r.event==="rendered_print_worker_exit"&&r.exit_code===0&&r.signal==="none"));
  assert.ok(rows.some(r=>r.event==="rendered_print_progress"&&r.rss_bytes>0));
  evidence.repeat={pages:724,preparation_ms:j.elapsed_ms,sha256,exit_code:0};
  await clear(id);assert.equal((await api("/api/health")).status,200);
});
test("rendered print worker: output cap is an error, never a completed PDF",{skip:!fixture},async()=>{
  const worker=fork(join(root,"server/workers/rendered-print-worker.cjs"),[],{execArgv:[],stdio:["ignore","ignore","pipe","ipc"]});
  const closed=new Promise(r=>worker.once("close",code=>r(code)));
  try{
    const message=await new Promise((yes,no)=>{
      worker.on("error",no);worker.on("message",m=>{if(m.type==="done"||m.type==="error")yes(m);});
      worker.send({pages:[{number:1,path:join(temp,"pages",manual,"p0001.webp"),width:1984,height:2807}],
        output:join(temp,"cap.part"),maxBytes:200});
    });
    assert.equal(message.type,"error");assert.match(message.message,/size limit/);
    assert.equal(await closed,0);
    evidence.checks.push("Worker output-budget failure does not report completion.");
  }finally{if(worker.exitCode===null&&worker.signalCode===null)worker.kill("SIGKILL");await closed;}
});
test("rendered print worker: loss of parent IPC stops orphan preparation",{skip:!fixture,timeout:15000},async()=>{
  const worker=fork(join(root,"server/workers/rendered-print-worker.cjs"),[],{execArgv:[],stdio:["ignore","ignore","pipe","ipc"]});
  const exited=new Promise(r=>worker.once("exit",code=>r(code)));
  try{
    const started=new Promise(r=>worker.once("message",r));
    worker.send({pages:Array.from({length:724},(_,i)=>({number:i+1,path:join(temp,"pages",manual,"p0001.webp"),width:1984,height:2807})),
      output:join(temp,"orphan.part"),maxBytes:1024*1024*1024});
    await started;worker.disconnect();assert.equal(await exited,1);
  }finally{if(worker.exitCode===null&&worker.signalCode===null)worker.kill("SIGKILL");}
});
