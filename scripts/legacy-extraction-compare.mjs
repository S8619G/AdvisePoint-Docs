// Optional acceptance comparison against a user-supplied, unchanged baseline worker.
import {Worker} from "node:worker_threads";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import assert from "node:assert/strict";
import {resolve} from "node:path";
const file=process.env.APD_RESTRICTED_MANUAL,baseline=process.env.APD_BASELINE_WORKER;
assert.ok(file&&baseline,"Set APD_RESTRICTED_MANUAL and APD_BASELINE_WORKER");
const bytes=readFileSync(file),digest=s=>createHash("sha256").update(s).digest("hex");
async function extract(script,renderedFallback){
  const w=new Worker(resolve(script));
  try{
    return await new Promise((resolve,reject)=>{
      w.once("error",reject);
      w.once("message",r=>r.ok?resolve(r.result):reject(Error(r.error)));
      const data=Uint8Array.from(bytes);
      w.postMessage({id:"compare",filename:"manual.pdf",buffer:data.buffer,renderedFallback},[data.buffer]);
    });
  }finally{await w.terminate();}
}
const old=await extract(baseline,false),next=await extract(new URL("../server/workers/extract-worker.cjs",import.meta.url).pathname,true);
assert.equal(old.text,next.text);assert.equal(old.page_count,next.page_count);
console.log(JSON.stringify({status:"PASS",pages:next.page_count,characters:next.text.length,text_sha256:digest(next.text),baseline_text_identical:true},null,2));
