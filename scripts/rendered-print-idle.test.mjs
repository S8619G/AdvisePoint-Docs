// Disposable fixture only. Test the actual server's idle guard during a job.
import {test} from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtempSync,mkdirSync,readdirSync,linkSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {randomUUID} from "node:crypto";
import Database from "better-sqlite3";
const fixture=process.env.APD_RENDER_FIXTURE,root=resolve(import.meta.dirname,"..");
const delay=ms=>new Promise(r=>setTimeout(r,ms));
test("active print preparation holds off actual server idle shutdown",{skip:!fixture,timeout:35000},async()=>{
  const temp=mkdtempSync(join(tmpdir(),"apd-print-idle-")),base="http://127.0.0.1:5198";
  const workerFile=join(root,"dist/workers/rendered-print-worker.cjs"),saved=readFileSync(workerFile);
  const db=new Database(join(fixture,"advisepoint.db"),{readonly:true});
  let server,output="";
  try{
    const doc=db.prepare("SELECT d.id FROM documents d JOIN document_render_status r ON r.document_id=d.id WHERE d.original_ext IS NULL AND r.total=724 AND d.title LIKE '%7353%'").get();
    assert.ok(doc);await db.backup(join(temp,"advisepoint.db"));
    mkdirSync(join(temp,"pages",doc.id),{recursive:true});
    for(const n of readdirSync(join(fixture,"pages",doc.id)))linkSync(join(fixture,"pages",doc.id,n),join(temp,"pages",doc.id,n));
    // Hold a disposable job long enough to cross an idle-watchdog tick.
    writeFileSync(workerFile,'process.once("message",()=>{setInterval(()=>{},1000);});');
    server=spawn(process.execPath,["dist/index.cjs"],{cwd:root,env:{...process.env,NODE_ENV:"production",PORT:"5198",
      RAG_DB_PATH:join(temp,"advisepoint.db"),RAG_PAGES_DIR:join(temp,"pages"),APD_LOG_DIR:join(temp,"logs"),
      RAG_NO_SEED:"1",RAG_NO_IDLE_SHUTDOWN:"0",RAG_IDLE_SHUTDOWN_MS:"1000",APD_LOCAL_TEST:"1"},stdio:["ignore","pipe","pipe"]});
    server.stdout.on("data",b=>output+=b);server.stderr.on("data",b=>output+=b);
    for(let n=0;n<100;n++){try{if((await fetch(base+"/api/health")).ok)break;}catch{}await delay(100);}
    const id=randomUUID(),headers={"Content-Type":"application/json",Origin:base,"X-APD-PDF-Action":"rendered-print"};
    const r=await fetch(base+"/api/rendered-print-jobs",{method:"POST",headers,body:JSON.stringify({id,documentId:doc.id,from:1,to:1})});
    assert.equal(r.status,200,await r.text());
    await fetch(base+"/api/heartbeat");
    await delay(11500);
    assert.equal((await fetch(base+"/api/health")).status,200);
    assert.match(output,/keeping local service running/);
    assert.equal((await fetch(base+`/api/rendered-print-jobs/${id}/cancel`,{method:"POST",headers,body:"{}"})).status,200);
    // v1.3.2: finishing the job must not revive heartbeat-based shutdown.
    await delay(11500);
    assert.equal(server.exitCode,null);
    assert.equal((await fetch(base+"/api/health")).status,200);
    assert.doesNotMatch(output,/no browser heartbeat.*shutting down/);
  }finally{
    db.close();writeFileSync(workerFile,saved);
    if(server&&server.exitCode===null){server.kill();await new Promise(r=>server.once("exit",r));}
    mkdirSync(join(root,"verification"),{recursive:true});
    writeFileSync(join(root,"verification/candidate9-idle-server.log"),output);
    rmSync(temp,{recursive:true,force:true});
  }
});
