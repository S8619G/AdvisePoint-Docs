import type { Express } from "express";
import { storage, getDataDirForBackup } from "./storage";
import { originalFilePath, originalExists, saveVerifiedPdfOriginal } from "./originals";
import { pdfHandoffHtml, ORIGINAL_HANDOFF_THRESHOLD } from "./pdf-handoff";
import multer from "multer";
import {createHash} from "node:crypto";
import { pdfPrintHtml } from "./pdf-print";
import { openExternalPdf, finishExternalPrint, touchExternalPrint, cleanOldExternalCopies } from "./pdf-open";
import { renderedPrintRoutes } from "./rendered-print";

export function pdfRoutes(app:Express) {
  renderedPrintRoutes(app);
  const sweepCopies=()=>void cleanOldExternalCopies(getDataDirForBackup());
  sweepCopies();
  const orphanSweep=setInterval(sweepCopies,60*60*1000);orphanSweep.unref();
  let opening = false, lastOpened = 0;
  app.get("/api/pdf/print/:id", (req,res) => {
    const doc = storage.getDocument(req.params.id);
    if (!doc || doc.original_ext !== "pdf") return res.status(404).json({message:"Retained PDF not found."});
    const total = storage.getRenderStatus(doc.id)?.total || 0;
    const from = Number(req.query.from), to = Number(req.query.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from<1 || to<from || to>total)
      return res.status(400).json({message:"Invalid print page range."});
    res.setHeader("Cache-Control","no-store");
    // Only this standalone print page permits its locally generated PDF blobs.
    // No remote resources or executable blob scripts are allowed.
    res.setHeader("Content-Security-Policy","default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'unsafe-inline'; img-src 'self' blob: data:; object-src blob:; connect-src 'self' blob:; base-uri 'none'; frame-ancestors 'self'");
    // Native subsets must contain the requested pages, even above 50 pages.
    // Their preparation worker copies PDF pages without rendering images.
    // Only whole-native-document jobs can hand off the unchanged original.
    const wholeDocument=from===1&&to===total;
    let html=to-from+1>ORIGINAL_HANDOFF_THRESHOLD&&(!!doc.pdf_rendered||wholeDocument)
      ?pdfHandoffHtml(doc.id,from,to,total,originalExists(doc.id,"pdf"),!!doc.pdf_rendered,
        !!doc.pdf_rendered&&/^[a-f0-9]{64}$/i.test(doc.file_hash_sha256||""))
      :pdfPrintHtml(doc.id,from,to);
    if(doc.pdf_compatibility)html=html.replace(/original PDF/g,"compatible PDF")
      .replace(/unchanged original/g,"saved compatible PDF").replace(/FULL original/g,"FULL compatible PDF")
      .replace(/Open original/g,"Open compatible PDF").replace(/the original in/g,"the compatible PDF in")
      .replace(/AdvisePoint-original.pdf/g,"AdvisePoint-compatible.pdf");
    res.type("html").send(html);
  });
  // Existing image-only entries can gain an exact, fingerprint-verified
  // original without reimporting, replacing pages or changing their viewer.
  const attachment=multer({storage:multer.memoryStorage(),limits:{fileSize:150*1024*1024,files:1,fields:0}});
  app.post("/api/pdf/attach-original/:id",(req,res,next)=>{
    const host=req.headers.host,port=req.socket.localPort;
    if((host!==`127.0.0.1:${port}`&&host!==`localhost:${port}`)||
      req.get("origin")!==`http://${host}`||req.get("X-APD-PDF-Action")!=="attach-original")
      return res.status(403).json({message:"Attach the original from this local application's print dialog."});
    attachment.single("file")(req,res,error=>{
      if(error)return res.status(400).json({message:"Choose one PDF file, no larger than 150 MiB."});
      next();
    });
  },(req,res)=>{
    const doc=storage.getDocument(req.params.id);
    if(!doc||(doc.original_ext==="pdf"&&!doc.pdf_rendered)||
      !doc.file_name?.toLowerCase().endsWith(".pdf"))
      return res.status(404).json({message:"Rendered PDF entry not found."});
    const hash=doc.file_hash_sha256;
    if(!hash||!/^[a-f0-9]{64}$/i.test(hash))return res.status(409).json({message:"This older entry has no verifiable file fingerprint. Use prepared pages instead."});
    if(!req.file||!req.file.originalname.toLowerCase().endsWith(".pdf")||
      !req.file.buffer.subarray(0,1024).includes(Buffer.from("%PDF-")))
      return res.status(400).json({message:"Choose the original PDF file."});
    if(createHash("sha256").update(req.file.buffer).digest("hex")!==hash.toLowerCase())
      return res.status(409).json({message:"This is not the exact PDF used for this library entry. Nothing was changed."});
    try{
      // File publication is atomic and never overwrites an existing original.
      // A crash before the metadata update leaves reusable identical bytes.
      saveVerifiedPdfOriginal(doc.id,req.file.buffer,hash.toLowerCase());
      storage.updateDocumentMeta(doc.id,{original_ext:"pdf",pdf_rendered:1});
      res.json({ok:true,message:"Original verified and attached. Rendered pages and metadata are unchanged."});
    }catch{
      res.status(500).json({message:"Could not attach the original safely. No existing file was overwritten. Use prepared pages or retry."});
    }
  });
  app.post("/api/pdf/open-original/:id", async(req,res) => {
    const host=req.headers.host, port=req.socket.localPort;
    if ((host!==`127.0.0.1:${port}` && host!==`localhost:${port}`) ||
        req.get("origin")!==`http://${host}` || req.get("X-APD-PDF-Action")!=="open-original")
      return res.status(403).json({message:"Open original PDF requires a button click in this local application."});
    const doc=storage.getDocument(req.params.id);
    if (!doc || doc.original_ext!=="pdf") return res.status(404).json({message:"Retained PDF not found."});
    if (opening || Date.now()-lastOpened<3000) return res.status(429).json({message:"Please wait a few seconds before opening another PDF."});
    opening=true;
    try {
      const job=typeof req.query.job==="string"?req.query.job:undefined;
      if(job&&!/^[a-f0-9-]{36}$/.test(job))return res.status(400).json({message:"Invalid print job."});
      await openExternalPdf(getDataDirForBackup(),originalFilePath(doc.id,"pdf"),job);
      lastOpened=Date.now();
      res.json({message:"Windows was asked to open a temporary copy in your default PDF app. Changes to the copy do not update the library."});
    } catch(e:any) {
      console.error("[pdf] Open original failed:",e?.code||e?.message);
      res.status(e?.status||500).json({message:e?.status===501?e.message:"Could not open the default PDF app. Check the Windows PDF association or use Download original PDF."});
    } finally {opening=false;}
  });
  app.post("/api/pdf/print-jobs/:id/:action",async(req,res)=>{
    const host=req.headers.host,port=req.socket.localPort;
    if((host!==`127.0.0.1:${port}`&&host!==`localhost:${port}`)||req.get("origin")!==`http://${host}`||
      req.get("X-APD-PDF-Action")!=="open-original")return res.sendStatus(403);
    if(!/^[a-f0-9-]{36}$/.test(req.params.id)||!["done","touch"].includes(req.params.action))return res.sendStatus(400);
    try{
      if(req.params.action==="touch"){touchExternalPrint(req.params.id);return res.json({ok:true});}
      res.json(await finishExternalPrint(req.params.id));
    }catch{res.status(503).json({message:"Cleanup is pending. Automatic cleanup will retry."});}
  });
}
