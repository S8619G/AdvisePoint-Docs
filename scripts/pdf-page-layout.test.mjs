import {test} from "node:test";
import assert from "node:assert/strict";
import {buildPdfPageLayout,pdfPageAtOffset,pdfVisibleWindow}
  from "../client/src/lib/pdf-page-layout.ts";

const pages=Array.from({length:791},(_,i)=>({page_number:i+1,
  width:i%4===0?1800:1200,height:i%4===0?1000:1600}));
test("large jumps and reversals always mount the actual visible range",()=>{
  const slots=buildPdfPageLayout(pages,791,1000,768,false);
  for(const index of [0,450,790,7,600,1,300,789,0]){
    const top=slots[index].top+10;
    const win=pdfVisibleWindow(slots,top,768);
    assert.ok(win.start<=index&&win.end>=index);
    assert.ok(win.end-win.start<12);
    assert.equal(pdfPageAtOffset(slots,top),index);
  }
});
test("geometry is contiguous and deterministic across loading state",()=>{
  const slots=buildPdfPageLayout(pages,791,1000,768,false);
  assert.deepEqual(slots,buildPdfPageLayout(pages,791,1000,768,false));
  for(let i=1;i<slots.length;i++)assert.equal(slots[i].top,slots[i-1].top+slots[i-1].height);
  assert.equal(slots[0].separator,0);
  assert.equal(slots[1].separator,32);
});
test("mixed page sizes preserve aspect ratio and respect viewport caps",()=>{
  for(const zoomed of [false,true]){
    const slots=buildPdfPageLayout(pages,791,450,600,zoomed);
    slots.forEach((s,i)=>{
      assert.ok(s.imageWidth<=418.001);
      assert.ok(s.imageHeight<=(600-32)*(zoomed?2.2:1)+.001);
      assert.ok(Math.abs(s.imageWidth/s.imageHeight-pages[i].width/pages[i].height)<1e-9);
    });
  }
});
test("missing and unrendered pages retain slots through the final page",()=>{
  const slots=buildPdfPageLayout([pages[0]],100,1000,768,false);
  assert.equal(slots.length,100);
  assert.equal(pdfPageAtOffset(slots,1e12),99);
  assert.equal(pdfPageAtOffset(slots,-100),0);
  assert.equal(slots[99].page,100);
});
test("empty viewport and document are safe",()=>{
  assert.deepEqual(buildPdfPageLayout([],0,1000,768,false),[]);
  assert.deepEqual(buildPdfPageLayout(pages,791,0,768,false),[]);
  assert.deepEqual(pdfVisibleWindow([],100,768),{start:0,end:-1});
});
