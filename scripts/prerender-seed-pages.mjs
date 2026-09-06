// Pre-render page images for the shipped seed documents.
//
// Called from packaging (see repackage step). Given a set of {docId, pdfPath}
// pairs, renders each PDF to sidecar JPEGs under `./seed_pages/<docId>/pNNNN.jpg`,
// and writes matching `document_pages` + `document_render_status` rows into the
// seed.db so the API knows the pages exist on first launch.
//
// Run with:  node scripts/prerender-seed-pages.mjs

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const SEED_DB = path.join(ROOT, "seed.db");
const OUT_DIR = path.join(ROOT, "seed_pages");

// Map of {docId => absolute path to the source PDF}. The docIds must already
// exist in seed.db (they were created by the initial seed ingest).
const JOBS = [
  {
    docId: "doc_577570cf-0d01-4798-9664-bcb149b3fe00",
    pdf: "/home/user/workspace/uploaded_attachments/80e8556fecd345e0916381d2cd0366ba/MZ9500ciSeriesENOGR2025.09.pdf",
    label: "Operation Guide",
  },
  {
    docId: "doc_eaf3fa65-e2ff-4c8b-b94d-4414b97d60d4",
    pdf: "/home/user/workspace/uploaded_attachments/80e8556fecd345e0916381d2cd0366ba/MZ9500ci-MZ10500iSeriesENOGR2025.12-CCRX.pdf",
    label: "Command Center RX",
  },
];

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const { createCanvas } = await import("@napi-rs/canvas");

// v0.9.21: 240 dpi WebP q88 (see comment in server/pages.ts).
const scale = 240 / 72;
const webpQuality = 88;

// Reset seed_pages directory so re-runs produce a clean tree.
fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

// Open the seed DB and make sure the two new tables exist.
const db = new Database(SEED_DB);
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS document_pages (
  document_id TEXT NOT NULL,
  page_number INTEGER NOT NULL,
  image_path TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  generated_at TEXT NOT NULL,
  PRIMARY KEY (document_id, page_number)
);
CREATE INDEX IF NOT EXISTS idx_pages_doc ON document_pages(document_id);
CREATE TABLE IF NOT EXISTS document_render_status (
  document_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  rendered INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated_at TEXT NOT NULL
);
`);

const insertPage = db.prepare(`
  INSERT OR REPLACE INTO document_pages (document_id, page_number, image_path, width, height, generated_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const upsertStatus = db.prepare(`
  INSERT OR REPLACE INTO document_render_status (document_id, status, rendered, total, error, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const clearPages = db.prepare(`DELETE FROM document_pages WHERE document_id = ?`);

for (const job of JOBS) {
  if (!fs.existsSync(job.pdf)) {
    console.error(`[seed-render] SKIP ${job.label}: PDF not found at ${job.pdf}`);
    continue;
  }
  const doc = db.prepare("SELECT id FROM documents WHERE id = ?").get(job.docId);
  if (!doc) {
    console.error(`[seed-render] SKIP ${job.label}: docId ${job.docId} not in seed.db`);
    continue;
  }
  console.log(`[seed-render] ${job.label} (${job.docId})`);
  clearPages.run(job.docId);

  const buf = fs.readFileSync(job.pdf);
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;

  const total = pdf.numPages;
  const outDocDir = path.join(OUT_DIR, job.docId);
  fs.mkdirSync(outDocDir, { recursive: true });

  const nowIso = new Date().toISOString();
  upsertStatus.run(job.docId, "rendering", 0, total, null, nowIso);

  const t0 = Date.now();
  for (let n = 1; n <= total; n++) {
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale });
    const width = Math.ceil(viewport.width);
    const height = Math.ceil(viewport.height);
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, width, height);
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    const img = canvas.toBuffer("image/webp", webpQuality);
    const fname = `p${String(n).padStart(4, "0")}.webp`;
    const outPath = path.join(outDocDir, fname);
    fs.writeFileSync(outPath, img);
    // NOTE: image_path stored in seed.db is a placeholder — the storage layer
    // recomputes correct absolute paths on first launch. We write a marker so
    // rows aren't NULL. The runtime never trusts this field for shipped pages
    // — see storage.ts seed-copy logic.
    insertPage.run(job.docId, n, `<seeded>/${job.docId}/${fname}`, width, height, nowIso);
    if (n % 20 === 0 || n === total) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  ${n}/${total} pages (${elapsed}s)`);
      upsertStatus.run(job.docId, n === total ? "ready" : "rendering", n, total, null, new Date().toISOString());
    }
    page.cleanup?.();
  }
  await pdf.cleanup?.();
  await pdf.destroy?.();
  console.log(`[seed-render] done ${job.label}: ${total} pages`);
}
db.close();
console.log(`[seed-render] All done. Output: ${OUT_DIR}`);
