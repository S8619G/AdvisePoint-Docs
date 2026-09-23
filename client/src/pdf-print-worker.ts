// Large selected ranges stay vector PDFs rather than hundreds of decoded
// images. A dedicated worker makes cancellation terminate parsing/copying too.
// Encrypted originals are NEVER loaded with ignoreEncryption.
import {PDFDocument} from "pdf-lib";
const MAX_BYTES=128*1024*1024;
self.onmessage=async(event:MessageEvent<{url:string;from:number;to:number}>)=>{
  try{
    const {url,from,to}=event.data;
    const source=new URL(url,self.location.origin);
    if(source.origin!==self.location.origin||!/^\/api\/documents\/[a-zA-Z0-9_-]+\/original$/.test(source.pathname))
      throw Error("Invalid retained PDF address.");
    const response=await fetch(source.href);
    if(!response.ok||!response.body)throw Error("Could not read the retained PDF.");
    if(Number(response.headers.get("content-length"))>MAX_BYTES)
      throw Error("This PDF exceeds the temporary-copy budget. Use Open original PDF and choose the range there.");
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
    for(;;){
      const {value,done}=await reader.read();if(done)break;
      size+=value.byteLength;
      if(size>MAX_BYTES){await reader.cancel();throw Error("The temporary-copy budget was reached. Use Open original PDF and choose the range there.");}
      chunks.push(value);
    }
    const bytes=new Uint8Array(size);let offset=0;
    for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}chunks.length=0;
    let original:PDFDocument;
    try{original=await PDFDocument.load(bytes,{updateMetadata:false});}
    catch(e:any){
      // Full original stays unchanged, including its security permissions.
      if(/^Input document to `PDFDocument\.load` is encrypted\./.test(e?.message||"")){
        self.postMessage({originalOnly:true});return;
      }
      throw e;
    }
    if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<1||to<from||to>original.getPageCount())
      throw Error("Invalid print page range.");
    const output=await PDFDocument.create();
    const selected=await output.copyPages(original,Array.from({length:to-from+1},(_,i)=>from-1+i));
    for(const page of selected)output.addPage(page);
    const result=await output.save();
    if(result.byteLength>MAX_BYTES)throw Error("The selected PDF exceeds the temporary-copy budget. Choose a smaller range or Open original PDF.");
    self.postMessage({bytes:result.buffer}, {transfer:[result.buffer]});
  }catch(e:any){self.postMessage({error:e?.message||"Could not prepare the selected PDF. Use Open original PDF."});}
};
