import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,statSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {uploadLog,startUploadLog} from "../server/upload-log.ts";
test("upload journal strips text, secrets, paths; survives restarts and rotates with bounds",()=>{
  const dir=mkdtempSync(join(tmpdir(),"apd-log-test-"));process.env.APD_LOG_DIR=dir;
  try{
    startUploadLog("1.3.0");
    uploadLog("request_started",{upload_id:"unfinished",filename:"C:\\private\\manual\n.pdf",body:"SECRET TEXT",password:"SECRET PASS",metadata:"SECRET META"});
    uploadLog("rendered_print_started",{job_id:"interrupted-print",pid:1234});
    uploadLog("rendered_print_started",{job_id:"completed-print",pid:1235});
    uploadLog("rendered_print_finished",{job_id:"completed-print",status:"ready"});
    startUploadLog("1.3.0");
    const text=readFileSync(join(dir,"uploads.log"),"utf8");
    assert.match(text,/previous_request_unfinished/);assert.match(text,/manual .pdf/);
    assert.doesNotMatch(text,/SECRET|private/);
    const recovered=text.trim().split("\n").map(JSON.parse).filter(r=>r.event==="previous_print_unfinished");
    assert.deepEqual(recovered.map(r=>r.job_id),["interrupted-print"]);
    for(let n=0;n<4;n++){writeFileSync(join(dir,"uploads.log"),"x".repeat(2*1024*1024));assert.equal(uploadLog("rotation",{bytes:n}),true);}
    assert.deepEqual(readdirSync(dir).sort(),["uploads.log","uploads.log.1","uploads.log.2"]);
    for(const name of readdirSync(dir))assert.ok(statSync(join(dir,name)).size<=2*1024*1024);
    const blocked=join(dir,"blocked");writeFileSync(blocked,"not a directory");
    process.env.APD_LOG_DIR=blocked;assert.equal(uploadLog("failure"),false);
  }finally{delete process.env.APD_LOG_DIR;rmSync(dir,{recursive:true,force:true});}
});
