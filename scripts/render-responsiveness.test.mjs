// Sandbox supplement to the required Windows acceptance checklist.
// This does NOT test Windows associations, physical printing, or Edge.
import {test} from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {chromium} from "playwright";
const root=resolve(import.meta.dirname,".."),base="http://127.0.0.1:5196";
const delay=ms=>new Promise(r=>setTimeout(r,ms));
test("viewer, search and connection responsiveness during the full 724-page fallback render",{timeout:900000},async()=>{
  assert.ok(process.env.APD_RESTRICTED_MANUAL&&process.env.APD_MANUALS);
  const temp=mkdtempSync(join(tmpdir(),"apd-render-response-"));
  const evidence={environment:"Linux sandbox Chromium; not Windows acceptance",samples:[],health:[],render:null,temp};
  let output="",browser,p;
  const server=spawn(process.execPath,["dist/index.cjs"],{cwd:root,env:{...process.env,NODE_ENV:"production",
    PORT:"5196",RAG_DB_PATH:join(temp,"advisepoint.db"),RAG_PAGES_DIR:join(temp,"pages"),
    APD_LOG_DIR:join(temp,"logs"),RAG_NO_SEED:"1",RAG_NO_IDLE_SHUTDOWN:"1",APD_LOCAL_TEST:"1"},stdio:["ignore","pipe","pipe"]});
  server.stdout.on("data",b=>output+=b);server.stderr.on("data",b=>output+=b);
  const json=async path=>(await fetch(base+path,{signal:AbortSignal.timeout(30000)})).json();
  try{
    for(let n=0;n<150;n++){try{if((await fetch(base+"/api/health")).ok)break;}catch{}await delay(100);}
    const type=(await json("/api/document-types")).types[0].key;
    async function upload(file,mode){
      const form=new FormData();form.append("file",new Blob([readFileSync(file)]),file.split("/").pop());
      form.append("metadata",JSON.stringify({document_type:type}));form.append("pdf_import_mode",mode);
      const r=await fetch(base+"/api/upload",{method:"POST",body:form}),data=await r.json();
      assert.equal(r.status,200,JSON.stringify(data));return data;
    }
    const native=await upload(join(process.env.APD_MANUALS,"4004i_5004i_6004i_7004iENOGR2025_07-2.pdf"),"native");
    browser=await chromium.launch({headless:true});p=await browser.newPage({viewport:{width:1280,height:900}});
    async function sample(phase,renderId){
      const before=renderId?await json(`/api/documents/${renderId}/pages/status`):null;
      let t=Date.now();
      const response=await fetch(base+"/api/search",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({query:"maintenance",top_k:5}),signal:AbortSignal.timeout(30000)});
      assert.equal(response.status,200);await response.json();const search_ms=Date.now()-t;
      await p.goto("about:blank");
      t=Date.now();await p.goto(base+`/#/library/${native.document.id}`);
      await p.getByTestId("button-view-pages").click();
      await p.waitForFunction(()=>[...document.querySelectorAll('[data-testid^="native-page-"]')].some(e=>e.dataset.state==="ready"),null,{timeout:60000});
      const first_page_ms=Date.now()-t;
      t=Date.now();await p.getByTestId("input-page-jump").fill("700");await p.getByTestId("input-page-jump").press("Enter");
      await p.waitForFunction(()=>document.querySelector('[data-testid="native-page-700"]')?.dataset.state==="ready",null,{timeout:60000});
      const jump_ms=Date.now()-t;
      t=Date.now();
      const original=await fetch(base+`/api/documents/${native.document.id}/original`,{signal:AbortSignal.timeout(120000)});
      assert.equal(original.status,200);await original.arrayBuffer();const original_delivery_ms=Date.now()-t;
      let after=renderId?await json(`/api/documents/${renderId}/pages/status`):null;
      // Progress is persisted every ten pages. Fast requests can complete
      // before that counter moves; observe the next batch separately without
      // inflating any operation timing.
      const progressDeadline=Date.now()+30000;
      while(phase.startsWith("active")&&after.status==="rendering"&&after.rendered<=before.rendered&&Date.now()<progressDeadline){
        await delay(200);after=await json(`/api/documents/${renderId}/pages/status`);
      }
      evidence.samples.push({phase,search_ms,first_page_ms,jump_ms,original_delivery_ms,render_before:before,render_after:after});
    }
    await sample("idle");
    const fallback=await upload(process.env.APD_RESTRICTED_MANUAL,"rendered"),fid=fallback.document.id;
    const startDeadline=Date.now()+60000;
    while((await json(`/api/documents/${fid}/pages/status`)).rendered<10){
      assert.ok(Date.now()<startDeadline,"Fallback did not begin rendering");
      await delay(200);
    }
    await sample("active-early",fid);
    const deadline=Date.now()+720000;let middle=false,status;
    do{
      const t=Date.now();const health=await fetch(base+"/api/health",{signal:AbortSignal.timeout(30000)});
      evidence.health.push({ms:Date.now()-t,status:health.status});assert.equal(health.status,200);
      status=await json(`/api/documents/${fid}/pages/status`);
      assert.notEqual(status.status,"error",JSON.stringify(status));
      if(!middle&&status.rendered>=100&&status.status!=="ready"){await sample("active-later",fid);middle=true;}
      if(status.status==="ready")break;
      assert.ok(Date.now()<deadline,"Fallback did not finish");await delay(2000);
    }while(true);
    evidence.render=status;assert.equal(status.rendered,724);assert.equal(status.total,724);
    assert.ok(middle,"A later active-render sample was not obtained");
    await sample("after-render",fid);
    for(const s of evidence.samples.filter(s=>s.phase.startsWith("active")))
      assert.ok(["pending","rendering"].includes(s.render_before.status)&&s.render_after.rendered>s.render_before.rendered,
        "Rendering must overlap the sample and advance");
    console.log("RESPONSIVENESS",JSON.stringify(evidence.samples.map(({render_before,render_after,...s})=>s)));
    assert.ok(evidence.samples.every(s=>s.first_page_ms<30000&&s.jump_ms<30000&&s.original_delivery_ms<30000),
      "A 30-second PDF delay was reproduced; see measured results before release");
  }finally{
    await browser?.close();if(server.exitCode===null){server.kill();await new Promise(r=>server.once("exit",r));}
    mkdirSync(join(root,"verification"),{recursive:true});
    writeFileSync(join(root,"verification/render-responsiveness-results.json"),JSON.stringify(evidence,null,2));
    writeFileSync(join(root,"verification/render-responsiveness-server.log"),output);
  }
});
