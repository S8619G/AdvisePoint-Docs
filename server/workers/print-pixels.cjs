// Lossless conversion after the print worker composites the page onto white.
// Native buffers are used only after a local channel/layout compatibility probe.
const {endianness}=require("node:os");

function validBuffer(rgba,pixels){
  return Number.isSafeInteger(pixels)&&pixels>=0&&rgba instanceof Uint8Array&&
    rgba.byteLength===pixels*4&&rgba.byteOffset%4===0;
}
function packRgba(rgba){
  if(endianness()!=="LE"||!validBuffer(rgba,rgba?.byteLength/4))
    throw Error("Unsupported native pixel layout");
  const pixels=rgba.byteLength/4,rgb=Buffer.allocUnsafe(pixels*3);
  if(rgb.byteOffset%4!==0)throw Error("Unaligned RGB output");
  const input=new Uint32Array(rgba.buffer,rgba.byteOffset,pixels);
  const output=new Uint32Array(rgb.buffer,rgb.byteOffset,Math.floor(rgb.length/4));
  const groups=Math.floor(pixels/4);
  for(let g=0,s=0,d=0;g<groups;g++,s+=4,d+=3){
    const a=input[s],b=input[s+1],c=input[s+2],e=input[s+3];
    output[d]=(a&0xffffff)|((b&255)<<24);
    output[d+1]=((b>>>8)&65535)|((c&65535)<<16);
    output[d+2]=((c>>>16)&255)|((e&0xffffff)<<8);
  }
  for(let s=groups*16,d=groups*12;s<rgba.length;s+=4,d+=3){
    rgb[d]=rgba[s];rgb[d+1]=rgba[s+1];rgb[d+2]=rgba[s+2];
  }
  return rgb;
}
function referenceRgb(ctx,width,height){
  const rgba=ctx.getImageData(0,0,width,height).data;
  const rgb=Buffer.allocUnsafe(width*height*3);
  for(let r=0,q=0;r<rgba.length;r+=4){
    rgb[q++]=rgba[r];rgb[q++]=rgba[r+1];rgb[q++]=rgba[r+2];
  }
  return rgb;
}
function probe(createCanvas){
  for(const width of [1,3,4,5,7]){
    const canvas=createCanvas(width,9);
    try{
      const ctx=canvas.getContext("2d");
      ctx.fillStyle="white";ctx.fillRect(0,0,width,9);
      const colors=["red","green","blue","rgba(10,150,230,0.3)","rgba(210,15,30,0.8)","#000","#fff"];
      for(let i=0;i<colors.length;i++){
        ctx.fillStyle=colors[i];ctx.fillRect(i%width,i,Math.max(1,width-i),2);
      }
      const raw=canvas.data();
      if(!validBuffer(raw,width*9))return false;
      // White composition must yield opaque, straight RGBA in native memory.
      for(let i=3;i<raw.length;i+=4)if(raw[i]!==255)return false;
      if(!packRgba(raw).equals(referenceRgb(ctx,width,9)))return false;
    }finally{canvas.width=canvas.height=1;}
  }
  return true;
}
function createPixelConverter({createCanvas,byteOrder=endianness()}){
  let mode="unchecked";
  return {
    get mode(){return mode;},
    extract(canvas,ctx,width,height){
      if(mode==="unchecked"){
        try{mode=byteOrder==="LE"&&probe(createCanvas)?"native":"fallback";}
        catch{mode="fallback";}
      }
      if(mode==="native"){
        try{
          const rgba=canvas.data();
          if(!validBuffer(rgba,width*height))throw Error("Unexpected native pixel buffer");
          return packRgba(rgba);
        }catch{mode="fallback";}
      }
      return referenceRgb(ctx,width,height);
    }
  };
}
module.exports={createPixelConverter,packRgba,referenceRgb};
