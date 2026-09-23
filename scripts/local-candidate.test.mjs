import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtempSync,mkdirSync,cpSync,writeFileSync,readFileSync,existsSync,symlinkSync,rmSync,readdirSync} from "node:fs";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {chromium} from "playwright";
const root=resolve(import.meta.dirname,".."),base="http://127.0.0.1:5101";
let temp,home,app,child,browser,output="";
function launch(homePath=home){
  const c=spawn(process.execPath,["dist/index.cjs"],{cwd:app,env:{...process.env,LOCALAPPDATA:homePath,
    RAG_DB_PATH:join(home,"AdvisePoint Docs","advisepoint.db"),PORT:"5000",RAG_PAGES_DIR:join(home,"AdvisePoint Docs","pages")},stdio:["ignore","pipe","pipe"]});
  c.stdout.on("data",b=>output+=b);c.stderr.on("data",b=>output+=b);return c;
}
async function ready(){
  for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error(output);
    try{if((await fetch(base+"/api/health")).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}
  throw Error("Local candidate did not start: "+output);
}
before(async()=>{
  assert.equal(JSON.parse(readFileSync(join(root,"dist/build-mode.json"))).local_test,true);
  temp=mkdtempSync(join(tmpdir(),"apd-local-launch-"));home=join(temp,"home");app=join(temp,"app");
  mkdirSync(join(home,"AdvisePoint Docs"),{recursive:true});mkdirSync(app);
  writeFileSync(join(home,"AdvisePoint Docs","advisepoint.db"),"PRODUCTION DATA SENTINEL");
  cpSync(join(root,"dist"),join(app,"dist"),{recursive:true});
  cpSync(join(root,"dist/index.cjs"),join(app,"dist/application.cjs"));
  writeFileSync(join(app,"dist/index.cjs"),'require("../local-test.cjs");\n');
  cpSync(join(root,"packaging/local-test.cjs"),join(app,"local-test.cjs"));writeFileSync(join(app,"LOCAL_TEST_ONLY"),"1.3.0");
  cpSync(join(root,"packaging/runtime-log.cjs"),join(app,"runtime-log.cjs"));
  symlinkSync(join(root,"node_modules"),join(app,"node_modules"));
  child=launch();await ready();browser=await chromium.launch({headless:true});
});
after(async()=>{
  await browser?.close();if(child?.exitCode===null){child.kill();await new Promise(r=>child.once("exit",r));}
  writeFileSync(join(root,"verification/local-launch.log"),output);
  rmSync(temp,{recursive:true,force:true});
});
test("candidate ignores inherited production paths and does not modify production sentinel",async()=>{
  assert.equal(readFileSync(join(home,"AdvisePoint Docs","advisepoint.db"),"utf8"),"PRODUCTION DATA SENTINEL");
  assert.ok(existsSync(join(home,"AdvisePoint Docs v1.3.0 Test","AdvisePoint Docs","advisepoint.db")));
  assert.match(output,/5101/);assert.ok(!existsSync(join(home,"AdvisePoint Docs","pages")));
  const logs=join(home,"AdvisePoint Docs v1.3.0 Test","AdvisePoint Docs","logs");
  assert.match(readFileSync(join(logs,"server.log"),"utf8"),/candidate 13 LOCAL TEST/);
  assert.match(readFileSync(join(logs,"uploads.log"),"utf8"),/session_started/);
});
test("occupied candidate port refuses duplicate startup without killing first instance or touching new storage",async()=>{
  const otherHome=join(temp,"other");mkdirSync(otherHome);
  const second=launch(otherHome);assert.equal(await new Promise(r=>second.on("exit",r)),1);
  assert.deepEqual(readdirSync(otherHome),[]);assert.equal((await fetch(base+"/api/health")).status,200);
});
test("candidate refuses unmarked and linked test library folders",async()=>{
  for(const mode of ["unknown","linked"]){
    const h=join(temp,mode);mkdirSync(h);
    const d=join(h,"AdvisePoint Docs v1.3.0 Test");
    if(mode==="unknown"){mkdirSync(d);writeFileSync(join(d,"sentinel"),"KEEP");}
    else symlinkSync(join(home,"AdvisePoint Docs"),d);
    const p=launch(h);assert.equal(await new Promise(r=>p.on("exit",r)),1);
  }
  assert.equal(readFileSync(join(home,"AdvisePoint Docs","advisepoint.db"),"utf8"),"PRODUCTION DATA SENTINEL");
});
test("candidate UI never checks GitHub or exposes update controls; server refuses direct updater requests",async()=>{
  const p=await browser.newPage(),requests=[];
  p.on("request",r=>{if(r.url().includes("github.com"))requests.push(r.url());});
  await p.goto(base+"/#/schema");await p.getByTestId("local-test-update-notice").waitFor();
  assert.equal(await p.getByTestId("button-update-now").count(),0);
  await p.waitForTimeout(1000);assert.deepEqual(requests,[]);
  for(const path of ["/api/updater/status","/api/updater/launch","/api/updater/launch-local","/api/updater/shutdown","/api/update/upload-zip"]){
    assert.equal((await fetch(base+path,{method:"POST"})).status,403);
  }
  await p.screenshot({path:join(root,"verification/local-test-settings.png")});await p.close();
});
