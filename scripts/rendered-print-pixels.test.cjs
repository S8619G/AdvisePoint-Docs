const {test}=require("node:test"),assert=require("node:assert/strict");
const {createCanvas}=require("@napi-rs/canvas");
const {createPixelConverter,packRgba,referenceRgb}=require("../server/workers/print-pixels.cjs");
function page(width=17,height=9){
  const canvas=createCanvas(width,height),ctx=canvas.getContext("2d");
  ctx.fillStyle="white";ctx.fillRect(0,0,width,height);
  for(const [i,color]of ["red","blue","rgba(40,220,60,0.4)","black"].entries()){
    ctx.fillStyle=color;ctx.fillRect(i,i,Math.max(1,width-i),2);
  }
  return{canvas,ctx,width,height};
}
function extract(converter,p,canvas=p.canvas){return converter.extract(canvas,p.ctx,p.width,p.height);}
test("native converter preserves colored/translucent white-composited pages and odd dimensions",()=>{
 const c=createPixelConverter({createCanvas});
 for(const width of [1,2,3,4,5,7,17,100]){
  const p=page(width);assert.deepEqual(extract(c,p),referenceRgb(p.ctx,width,p.height));
  assert.equal(c.mode,"native");p.canvas.width=p.canvas.height=1;
 }
});
test("grouped packing preserves all channel values and every remainder size",()=>{
 for(let count=1;count<133;count++){
  const rgba=Buffer.alloc(count*4),expected=Buffer.alloc(count*3);
  for(let i=0;i<rgba.length;i++)rgba[i]=(i*131+count*17)&255;
  for(let p=0;p<count;p++)rgba.copy(expected,p*3,p*4,p*4+3);
  assert.deepEqual(packRgba(rgba),expected);
 }
});
test("unsupported byte order uses original converter without native access",()=>{
 const c=createPixelConverter({createCanvas:()=>{throw Error("must not probe");},byteOrder:"BE"}),p=page();
 assert.deepEqual(extract(c,p,{data(){throw Error("must not read");}}),referenceRgb(p.ctx,p.width,p.height));
 assert.equal(c.mode,"fallback");
});
test("missing native accessor falls back safely",()=>{
 const c=createPixelConverter({createCanvas:(w,h)=>{const c=createCanvas(w,h);c.data=undefined;return c;}}),p=page();
 assert.deepEqual(extract(c,p),referenceRgb(p.ctx,p.width,p.height));assert.equal(c.mode,"fallback");
});
test("channel-order mismatch in compatibility probe uses original converter",()=>{
 const c=createPixelConverter({createCanvas:(w,h)=>{
  const c=createCanvas(w,h),data=c.data.bind(c);c.data=()=>{const b=data();for(let i=0;i<b.length;i+=4){const r=b[i];b[i]=b[i+2];b[i+2]=r;}return b;};return c;
 }}),p=page();
 assert.deepEqual(extract(c,p),referenceRgb(p.ctx,p.width,p.height));assert.equal(c.mode,"fallback");
});
test("nonopaque native probe data uses original converter",()=>{
 const c=createPixelConverter({createCanvas:(w,h)=>{
  const c=createCanvas(w,h),data=c.data.bind(c);c.data=()=>{const b=data();b[3]=0;return b;};return c;
 }}),p=page();
 assert.deepEqual(extract(c,p),referenceRgb(p.ctx,p.width,p.height));assert.equal(c.mode,"fallback");
});
test("actual-page native exception permanently falls back without losing the page",()=>{
 const c=createPixelConverter({createCanvas}),p=page();
 extract(c,p);assert.equal(c.mode,"native");
 assert.deepEqual(extract(c,p,{data(){throw Error("native access failed");}}),referenceRgb(p.ctx,p.width,p.height));
 assert.equal(c.mode,"fallback");assert.deepEqual(extract(c,p),referenceRgb(p.ctx,p.width,p.height));
});
test("actual-page short and unaligned buffers trigger fallback",()=>{
 for(const bad of [Buffer.alloc(4),Buffer.alloc(17*9*4+1).subarray(1)]){
  const c=createPixelConverter({createCanvas}),p=page();
  assert.deepEqual(extract(c,p,{data:()=>bad}),referenceRgb(p.ctx,p.width,p.height));
  assert.equal(c.mode,"fallback");
 }
});
test("probe happens once and no per-page reference readback occurs on native path",()=>{
 let probes=0;const c=createPixelConverter({createCanvas:(w,h)=>{probes++;return createCanvas(w,h);}}),p=page();
 extract(c,p);const count=probes;
 assert.ok(count>0);
 assert.deepEqual(c.extract(p.canvas,{getImageData(){throw Error("reference path used");}},p.width,p.height),referenceRgb(p.ctx,p.width,p.height));
 assert.equal(probes,count);assert.equal(c.mode,"native");
});
