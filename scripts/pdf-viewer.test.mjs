// v1.2.7 regression gate. Tests the production bundle, not a copied component.
// Run npm run build:nobump and install Playwright Chromium first.
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {chromium} from "playwright";

const root=resolve(import.meta.dirname,"..");
const base="http://127.0.0.1:5187";
let server,browser,temp,detail;
before(async()=>{
  temp=mkdtempSync(join(tmpdir(),"apd-pdf-test-"));
  server=spawn(process.execPath,["dist/index.cjs"],{cwd:root,env:{
    ...process.env,NODE_ENV:"production",PORT:"5187",RAG_DB_PATH:join(temp,"test.db"),
    RAG_PAGES_DIR:join(temp,"pages"),APD_LOG_DIR:join(temp,"logs"),
    APD_OPEN_BROWSER:"0",RAG_NO_IDLE_SHUTDOWN:"1",
  },stdio:"ignore"});
  let ready=false;
  for(let i=0;i<240;i++){
    try{if((await fetch(base)).ok){ready=true;break;}}catch{}
    await new Promise(r=>setTimeout(r,250));
  }
  assert.ok(ready,"isolated production server must boot");
  // First-boot ingestion runs asynchronously after the HTTP listener starts.
  let seeded=false;
  for(let i=0;i<240;i++){
    const r=await fetch(base+"/api/documents/seed-readme-v1");
    if(r.ok){seeded=true;break;}
    await new Promise(r=>setTimeout(r,250));
  }
  assert.ok(seeded,"bundled guide must finish first-boot ingestion");
  browser=await chromium.launch({headless:true,ignoreDefaultArgs:["--hide-scrollbars"]});
  const p=await browser.newPage();
  await p.goto(base+"/#/library");
  await p.getByText("AdvisePoint Docs — Welcome Guide",{exact:true}).click();
  detail=p.url();
  await p.close();
});
after(async()=>{
  await browser?.close();
  if(server&&!server.killed){
    server.kill();
    await new Promise(r=>{server.once("exit",r);setTimeout(r,3000);});
  }
  if(temp)rmSync(temp,{recursive:true,force:true});
});

async function open(fixture=false,options={}){
  const p=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];
  p.on("pageerror",e=>errors.push(e.message));
  if(fixture){
    const count=791;
    const pages=Array.from({length:count},(_,i)=>({
      page_number:i+1,width:i%3===1?1200:800,height:i%3===1?600:1100,
    }));
    await p.route("**/api/documents/*/pages",r=>r.fulfill({json:{
      pages:options.missing?pages.filter(x=>x.page_number!==400):pages,
    }}));
    await p.route("**/api/documents/*/pages/status",r=>r.fulfill({json:{
      status:options.missing?"rendering":"ready",rendered:count-(options.missing?1:0),total:count,error:null,
    }}));
    await p.route(/\/api\/documents\/[^/]+\/pages\/\d+\.jpg(?:\?.*)?$/,async r=>{
      const n=Number(r.request().url().match(/\/(\d+)\.jpg/)[1]);
      if(options.fail===n&&!r.request().url().includes("retry="))
        return r.fulfill({status:503,body:"test failure"});
      if(options.delay)await new Promise(done=>setTimeout(done,options.delay));
      await r.fulfill({contentType:"image/svg+xml",body:
        `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1100"><rect width="100%" height="100%" fill="white"/><text x="100" y="150" font-size="60">PAGE ${n}</text></svg>`});
    });
  }
  await p.goto(detail);
  await p.getByTestId("button-view-pages").click();
  await p.getByTestId("stack-page-1").waitFor();
  return {p,stack:p.getByTestId("viewer-continuous-stack"),errors};
}
async function jump(p,n){
  await p.getByTestId("input-page-jump").fill(String(n));
  await p.getByTestId("input-page-jump").press("Enter");
  await p.waitForFunction(n=>document.querySelector('[data-testid="input-page-jump"]').value===String(n),n);
}
async function visible(p){
  await p.waitForFunction(()=>{
    const el=document.querySelector('[data-testid="viewer-continuous-stack"]');
    if(!el)return false;
    const v=el.getBoundingClientRect();
    const images=[...el.querySelectorAll("img")].filter(i=>{
      const r=i.getBoundingClientRect();return r.bottom>v.top+10&&r.top<v.bottom-10;
    });
    return images.length>0&&images.every(i=>i.complete&&i.naturalWidth>0&&getComputedStyle(i).visibility==="visible");
  },null,{timeout:15000});
}
async function wheel(p,stack,delta){
  const b=await stack.boundingBox();
  await p.mouse.move(b.x+b.width/2,b.y+b.height/2);
  await p.mouse.wheel(0,delta);
  await p.waitForTimeout(80);
}

test("real rendered Welcome Guide survives a large native wheel jump",async()=>{
  const {p,stack,errors}=await open();
  try{
    await visible(p);
    await wheel(p,stack,14500);await visible(p);
    assert.ok(await stack.evaluate(e=>e.scrollTop)>14000);
    assert.ok(Number(await p.getByTestId("input-page-jump").inputValue())>10);
    assert.deepEqual(errors,[]);
  }finally{await p.close();}
});

test("791 mixed-size pages recover after rapid distant jumps and reversals with bounded DOM",async()=>{
  const {p,stack,errors}=await open(true);
  try{
    for(const delta of [160000,-90000,220000,-260000,480000,-150000]){
      await wheel(p,stack,delta);
    }
    await visible(p);
    assert.ok(await stack.locator("[data-page-number]").count()<=9);
    const top=await stack.evaluate(e=>e.scrollTop);
    await p.waitForTimeout(600);
    assert.ok(Math.abs(await stack.evaluate(e=>e.scrollTop)-top)<2,"no late bounce-back");
    assert.deepEqual(errors,[]);
  }finally{await p.close();}
});

test("native scrollbar thumb drag loads the destination instead of stranding old pages",async()=>{
  const {p,stack}=await open(true);
  try{
    // Explicit native scrollbar styling avoids hidden overlay scrollbars in CI.
    await p.addStyleTag({content:'[data-testid="viewer-continuous-stack"]::-webkit-scrollbar{width:18px}[data-testid="viewer-continuous-stack"]::-webkit-scrollbar-thumb{background:#666;min-height:24px}[data-testid="viewer-continuous-stack"]::-webkit-scrollbar-track{background:#ddd}'});
    await p.waitForTimeout(100);
    const b=await stack.boundingBox();
    await p.mouse.move(b.x+b.width-9,b.y+10);await p.mouse.down();
    await p.mouse.move(b.x+b.width-9,b.y+b.height*.8,{steps:12});
    await p.mouse.up();
    await p.waitForTimeout(150);
    assert.ok(await stack.evaluate(e=>e.scrollTop)>100000,"native thumb actually moved");
    await visible(p);
  }finally{await p.close();}
});

test("page jumps, next/previous, last landscape page, zoom and resize retain reading position",async()=>{
  const {p,stack,errors}=await open(true);
  try{
    await jump(p,400);await visible(p);
    await p.getByTestId("button-step-next").click();
    await p.waitForFunction(()=>document.querySelector('[data-testid="input-page-jump"]').value==="401");
    assert.equal(await p.getByTestId("input-page-jump").inputValue(),"401");
    await p.getByTestId("button-step-prev").click();
    await p.waitForFunction(()=>document.querySelector('[data-testid="input-page-jump"]').value==="400");
    assert.equal(await p.getByTestId("input-page-jump").inputValue(),"400");
    await p.getByTestId("button-zoom-fit").click();await visible(p);
    await p.waitForTimeout(100);
    assert.equal(await p.getByTestId("input-page-jump").inputValue(),"400");
    await p.setViewportSize({width:1024,height:768});await visible(p);
    await p.waitForTimeout(100);
    assert.equal(await p.getByTestId("input-page-jump").inputValue(),"400");
    await jump(p,791);await visible(p);
    await p.getByTestId("button-zoom-fit").click();await visible(p);
    await p.waitForTimeout(100);
    assert.equal(await p.getByTestId("input-page-jump").inputValue(),"791");
    await jump(p,1);await visible(p);
    assert.ok(await stack.evaluate(e=>e.scrollTop)<2);
    assert.deepEqual(errors,[]);
  }finally{await p.close();}
});

test("slow image requests show loading state and failed images offer a working retry",async()=>{
  const {p}=await open(true,{delay:500,fail:400});
  try{
    await jump(p,250);
    await p.getByText("Loading page 250…",{exact:true}).waitFor();
    await visible(p);
    await jump(p,400);
    await p.getByRole("button",{name:"Retry page 400",exact:true}).click();
    await visible(p);
    await p.getByTestId("page-image-frame-400").locator("img").waitFor({state:"visible"});
  }finally{await p.close();}
});

test("not-yet-rendered pages retain continuous viewport and recover through polling",async()=>{
  const {p,stack}=await open(true,{missing:true});
  try{
    await jump(p,400);
    await p.getByText("Rendering page 400…",{exact:true}).waitFor();
    assert.equal(await stack.count(),1);
    await p.unroute("**/api/documents/*/pages");
    await p.route("**/api/documents/*/pages",r=>r.fulfill({json:{
      pages:Array.from({length:791},(_,i)=>({page_number:i+1,width:i%3===1?1200:800,height:i%3===1?600:1100})),
    }}));
    await visible(p);
    await p.getByTestId("page-image-frame-400").locator("img").waitFor({state:"visible"});
    assert.equal(await p.getByTestId("input-page-jump").inputValue(),"400");
  }finally{await p.close();}
});

test("search and print controls remain available and viewer can close and reopen",async()=>{
  const {p}=await open();
  try{
    await jump(p,12);await visible(p);
    await p.route("**/api/search",r=>r.fulfill({json:{results:[{
      score:1,chunk:{content:"Regression search destination",page_start:22,section_title:"Viewer test"},
    }]}}));
    await p.getByTestId("button-toggle-doc-search").click();
    await p.getByTestId("panel-doc-search").getByTestId("input-doc-search").fill("destination");
    await p.getByTestId("doc-search-result-0").click();
    await p.waitForFunction(()=>document.querySelector('[data-testid="input-page-jump"]').value==="22");
    await visible(p);
    await p.getByTestId("button-close-doc-search").click();
    await jump(p,12);await visible(p); // revisit decoded, cacheable real JPEGs
    await p.getByTestId("button-print-page").click();
    await p.getByTestId("popover-print-range").waitFor();
    await p.keyboard.press("Escape");
    await p.keyboard.press("Escape");
    await p.getByTestId("button-view-pages").click();
    await visible(p);
  }finally{await p.close();}
});
