// Sequential, lossless image-PDF writer. Only one decoded page is held.
// No PDF original is reconstructed and no library file is written.
const fs=require("node:fs"),path=require("node:path"),zlib=require("node:zlib");
const {createCanvas,loadImage}=require("@napi-rs/canvas");
const {createPixelConverter}=require("./print-pixels.cjs");
// A dedicated child process contains native canvas failures. On success, flush
// the final IPC message, disconnect, and let Node exit naturally.
let completed=false;
process.on("disconnect",()=>{if(!completed)process.exit(1);});
const send=message=>{if(process.connected)process.send(message);};
function finish(message){
  completed=true;
  if(!process.connected){process.exitCode=1;return;}
  process.send(message,error=>{
    if(error)process.exitCode=1;
    if(process.connected)process.disconnect();
  });
}
process.once("message",async({pages,output,maxBytes})=>{
  let fd,position=0;
  const pixels=createPixelConverter({createCanvas});
  const offsets=[0];
  function write(data){
    const bytes=Buffer.isBuffer(data)?data:Buffer.from(data,"binary");
    if(position+bytes.length>maxBytes)throw Error("The temporary PDF size limit was reached. Choose a smaller page range.");
    let sent=0;
    while(sent<bytes.length)sent+=fs.writeSync(fd,bytes,sent,bytes.length-sent);
    position+=bytes.length;
  }
  function object(id,text){offsets[id]=position;write(`${id} 0 obj\n${text}\nendobj\n`);}
  function stream(id,dict,bytes){
    offsets[id]=position;write(`${id} 0 obj\n<< ${dict} /Length ${bytes.length} >>\nstream\n`);
    write(bytes);write("\nendstream\nendobj\n");
  }
  try{
    if(!Array.isArray(pages)||!pages.length)throw Error("No pages selected");
    fd=fs.openSync(output,"wx",0o600);
    write("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
    object(1,"<< /Type /Catalog /Pages 2 0 R >>");
    const kids=pages.map((_,i)=>`${3+i*3} 0 R`).join(" ");
    object(2,`<< /Type /Pages /Count ${pages.length} /Kids [${kids}] >>`);
    for(let i=0;i<pages.length;i++){
      const p=pages[i];
      send({type:"stage",page:p.number});
      // Fail on a missing, changed, corrupt or linked input; never skip it.
      const info=fs.lstatSync(p.path);
      if(!info.isFile()||info.isSymbolicLink()||info.size>64*1024*1024)
        throw Error(`Stored page ${p.number} is not a supported regular image`);
      const image=await loadImage(p.path);
      if(image.width!==p.width||image.height!==p.height)
        throw Error(`Stored page ${p.number} does not match its saved dimensions`);
      const canvas=createCanvas(p.width,p.height),ctx=canvas.getContext("2d");
      ctx.fillStyle="white";ctx.fillRect(0,0,p.width,p.height);ctx.drawImage(image,0,0);
      const rgb=pixels.extract(canvas,ctx,p.width,p.height);
      const compressed=zlib.deflateSync(rgb,{level:3});
      const id=3+i*3,w=(p.width*72/240).toFixed(4),h=(p.height*72/240).toFixed(4);
      object(id,`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${id+1} 0 R >> >> /Contents ${id+2} 0 R >>`);
      stream(id+1,`/Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`,compressed);
      stream(id+2,"",Buffer.from(`q\n${w} 0 0 ${h} 0 0 cm\n/Im0 Do\nQ\n`));
      canvas.width=canvas.height=1;
      send({type:"progress",completed:i+1,bytes:position,
        memory:(i===0||(i+1)%50===0||i+1===pages.length)?process.memoryUsage():undefined});
      await new Promise(r=>setImmediate(r));
    }
    send({type:"phase",phase:"finalizing",memory:process.memoryUsage()});
    const xref=position;
    write(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
    for(let i=1;i<offsets.length;i++){
      if(!Number.isSafeInteger(offsets[i]))throw Error("Incomplete PDF object table");
      write(`${String(offsets[i]).padStart(10,"0")} 00000 n \n`);
    }
    write(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    send({type:"phase",phase:"flushing",memory:process.memoryUsage()});
    fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    send({type:"phase",phase:"closed",memory:process.memoryUsage()});
    finish({type:"done",completed:pages.length,bytes:position});
  }catch(e){
    if(fd!==undefined)try{fs.closeSync(fd);}catch{}
    finish({type:"error",message:e?.code==="ENOSPC"?"The temporary drive is full. Free space or choose fewer pages.":e?.message||String(e)});
  }
});
