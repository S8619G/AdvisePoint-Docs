import fs from "node:fs";
import path from "node:path";
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const { createCanvas } = await import("@napi-rs/canvas");

const PDF = "/home/user/workspace/uploaded_attachments/80e8556fecd345e0916381d2cd0366ba/MZ9500ciSeriesENOGR2025.09.pdf";
const buf = fs.readFileSync(PDF);
const pdf = await pdfjs.getDocument({
  data: new Uint8Array(buf), disableWorker: true, isEvalSupported: false, useSystemFonts: true,
}).promise;

// Try pages 1 (title), 50 (dense text), 200 (mid-doc), 400 (table-heavy)
const testPages = [1, 50, 200, 400];
const configs = [
  { label: "current (110dpi jpeg q80)", scale: 110/72, mime: "image/jpeg", q: 80 },
  { label: "160dpi webp q78",           scale: 160/72, mime: "image/webp", q: 78 },
  { label: "180dpi webp q78",           scale: 180/72, mime: "image/webp", q: 78 },
  { label: "200dpi webp q78",           scale: 200/72, mime: "image/webp", q: 78 },
  { label: "220dpi webp q78",           scale: 220/72, mime: "image/webp", q: 78 },
  { label: "200dpi webp q82",           scale: 200/72, mime: "image/webp", q: 82 },
];

for (const cfg of configs) {
  let total = 0, tSum = 0;
  for (const n of testPages) {
    const page = await pdf.getPage(n);
    const vp = page.getViewport({ scale: cfg.scale });
    const w = Math.ceil(vp.width), h = Math.ceil(vp.height);
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white"; ctx.fillRect(0, 0, w, h);
    const t0 = Date.now();
    await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
    const out = canvas.toBuffer(cfg.mime, cfg.q);
    tSum += Date.now() - t0;
    total += out.length;
    fs.writeFileSync(`/tmp/bench-${cfg.label.replace(/\s+/g,"_")}-p${n}.${cfg.mime.split("/")[1]}`, out);
    page.cleanup?.();
  }
  console.log(`${cfg.label.padEnd(30)} avg=${(total/testPages.length/1024).toFixed(0)}KB   t=${(tSum/testPages.length).toFixed(0)}ms/pg   canvas ${Math.ceil(pdf.getPage(1).then(p=>p.getViewport({scale:cfg.scale}).width))}x???`);
}
await pdf.destroy?.();
