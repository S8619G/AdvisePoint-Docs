import {test,after} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {runRenderWorker} from "../server/render-worker-client.ts";
const dir=mkdtempSync(join(tmpdir(),"apd-worker-test-"));
let seq=0;
function fixture(code){
  const path=join(dir,`worker-${seq++}.cjs`);
  writeFileSync(path,`const {parentPort}=require("node:worker_threads");parentPort.once("message",()=>{${code}});`);
  return path;
}
const noop={page(){},status(){}};
after(()=>rmSync(dir,{recursive:true,force:true}));
test("busy renderer leaves parent responsive; page acknowledgement and input ownership",{timeout:5000},async()=>{
  let ticks=0,pages=0,statuses=0;
  const input=Buffer.from("unchanged caller data");
  const timer=setInterval(()=>ticks++,10);
  try{
    await runRenderWorker("test",input,{
      status:s=>{statuses++;assert.equal(s.document_id,"test");},
      page:(p,b)=>{pages++;assert.equal(p.document_id,"test");assert.equal(b[0],42);},
    },{path:fixture(`
      parentPort.postMessage({type:"stage",ms:3000,op:"busy"});
      const start=Date.now();while(Date.now()-start<250){}
      parentPort.postMessage({type:"status",status:{status:"rendering"}});
      parentPort.once("message",m=>{if(m.type!=="ack")throw Error("bad ack");parentPort.postMessage({type:"done"});});
      parentPort.postMessage({type:"page",page:{page_number:1},bytes:new Uint8Array([42])});
    `)}).done;
  }finally{clearInterval(timer);}
  assert.ok(ticks>=10);assert.equal(pages,1);assert.equal(statuses,1);
  assert.equal(input.toString(),"unchanged caller data");
});
test("parent stage deadline terminates a CPU-stuck worker",{timeout:5000},async()=>{
  await assert.rejects(runRenderWorker("test",Buffer.alloc(0),noop,{path:fixture(`
    parentPort.postMessage({type:"stage",op:"stuck page",ms:100});while(true){}
  `)}).done,/stuck page timed out/);
});
test("whole-job deadline also covers startup with no progress",{timeout:5000},async()=>{
  await assert.rejects(runRenderWorker("test",Buffer.alloc(0),noop,{
    path:fixture("while(true){}"),jobTimeout:200,
  }).done,/Whole-document render exceeded/);
});
test("unexpected worker exit rejects instead of hanging",{timeout:5000},async()=>{
  await assert.rejects(runRenderWorker("test",Buffer.alloc(0),noop,{
    path:fixture("process.exit(7)"),
  }).done,/exited before completion/);
});
test("worker exception is reported and another job can run",{timeout:5000},async()=>{
  await assert.rejects(runRenderWorker("test",Buffer.alloc(0),noop,{
    path:fixture('throw Error("broken decoder")'),
  }).done,/broken decoder/);
  await runRenderWorker("next",Buffer.alloc(0),noop,{
    path:fixture('parentPort.postMessage({type:"done"})'),
  }).done;
});
test("page commit failure terminates worker without another page",{timeout:5000},async()=>{
  let pages=0;
  await assert.rejects(runRenderWorker("test",Buffer.alloc(0),{
    status(){},page(){pages++;throw Error("simulated disk-full");},
  },{path:fixture(`
    parentPort.postMessage({type:"page",page:{},bytes:new Uint8Array([1])});
    parentPort.once("message",()=>parentPort.postMessage({type:"page",page:{},bytes:new Uint8Array([2])}));
  `)}).done,/simulated disk-full/);
  assert.equal(pages,1);
});
test("explicit cancellation suppresses late page and status callbacks",{timeout:5000},async()=>{
  let messages=0;
  const active=runRenderWorker("test",Buffer.alloc(0),{
    page(){messages++;},status(){messages++;},
  },{path:fixture(`
    setTimeout(()=>{parentPort.postMessage({type:"status",status:{}});parentPort.postMessage({type:"page",page:{},bytes:new Uint8Array([1])});},200);
  `)});
  const outcome=assert.rejects(active.done,/cancelled/);
  active.cancel();active.cancel();await outcome;
  await new Promise(r=>setTimeout(r,250));assert.equal(messages,0);
});
test("missing worker produces an actionable failure",{timeout:5000},async()=>{
  await assert.rejects(runRenderWorker("test",Buffer.alloc(0),noop,{path:join(dir,"missing.cjs")}).done,/Cannot find module/);
});
