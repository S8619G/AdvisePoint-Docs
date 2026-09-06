// v0.9.7 — render every page of a PDF to a sidecar image so field techs can
// see the original layout (callouts, tables, diagrams) that flat text extraction
// throws away. Rendering runs in the background on upload; the viewer lazy-loads
// one page at a time so large manuals never blow up memory.
//
// v0.9.19 - switched from 110 dpi JPEG q80 to 200 dpi WebP q78. Roughly 3x the
// pixel area at effectively the same disk size, so pinch-zoom / 3x lens views
// stay legible. Old .jpg files from prior versions still serve — the DB stores
// the actual path, and the /pages/:n.jpg route sniffs the extension.
//
// v0.9.21 - bumped 200 dpi -> 240 dpi and WebP q78 -> q88. Field feedback was
// that small body text still smeared at ~150% viewer zoom. 240 dpi gives 44%
// more pixels per page and q88 stops WebP from smoothing glyph edges. Total
// disk cost went from ~93 KB to ~170 KB per page (about 170 MB across the two
// preloaded manuals); render time went up ~40% but is still background.
//
// Layout on disk (new renders):
//   <RAG_PAGES_DIR>/<document_id>/p0001.webp
//   <RAG_PAGES_DIR>/<document_id>/p0002.webp
//   ...
// RAG_PAGES_DIR defaults to a `pages/` folder next to the SQLite DB.

import { mkdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { storage } from "./storage";
import type { DocumentPage } from "./storage";

// Import pdfjs (legacy Node build) lazily so a broken install doesn't kill server
// startup. Cached after first load. The cached module MUST be reused across calls
// because pdfjs stashes some state at module scope.
let _pdfjs: any | null = null;
async function loadPdfjs() {
  if (_pdfjs) return _pdfjs;
  _pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs" as any);
  return _pdfjs;
}
// @napi-rs/canvas is a prebuilt-binary canvas that avoids the Cairo/native build
// pain of the classic `canvas` package. Ships prebuilds for Windows x64, macOS
// (arm64 + x64), and Linux — matches our target platforms.
let _canvasMod: any | null = null;
function loadCanvas() {
  if (_canvasMod) return _canvasMod;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  _canvasMod = require("@napi-rs/canvas");

  // v0.9.29: pdfjs 5.x decodes embedded raster images through
  // `createImageBitmap` when it exists on the global scope. Node doesn't
  // ship one, so pdfjs silently drops JPEG/PNG XObjects — text renders
  // fine, but PowerPoint slides, screenshots, and product photos come
  // out as blank rectangles. @napi-rs/canvas's `loadImage` accepts a
  // Buffer/Uint8Array/Blob and returns something quacks-like-Image, which
  // is all pdfjs actually needs to feed into ctx.drawImage. This polyfill
  // is a no-op if the runtime already has one (browsers, future Node).
  const g: any = globalThis;
  if (typeof g.createImageBitmap !== "function") {
    g.createImageBitmap = async (source: any) => {
      // Blob (or Blob-alike) — read to Buffer first
      let bytes: Buffer;
      if (source && typeof source.arrayBuffer === "function") {
        const ab = await source.arrayBuffer();
        bytes = Buffer.from(ab);
      } else if (source instanceof Uint8Array) {
        bytes = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
      } else if (Buffer.isBuffer(source)) {
        bytes = source;
      } else if (source && source.data instanceof Uint8Array) {
        // pdfjs sometimes hands us an ImageData-shaped wrapper — pass the pixel
        // buffer through untouched. This path is rare (most bitmaps arrive as
        // Blob), but skipping it drops the same slides all over again.
        bytes = Buffer.from(source.data.buffer, source.data.byteOffset, source.data.byteLength);
      } else {
        throw new TypeError("createImageBitmap polyfill: unsupported source type");
      }
      return _canvasMod.loadImage(bytes);
    };
  }

  return _canvasMod;
}

// Where do sidecar page images live? Honor RAG_PAGES_DIR if set, otherwise put
// them next to the DB in `pages/`. Created lazily.
export function resolvePagesDir(): string {
  if (process.env.RAG_PAGES_DIR) return process.env.RAG_PAGES_DIR;
  const dbPath = process.env.RAG_DB_PATH;
  if (dbPath) return join(dirname(dbPath), "pages");
  // Match resolveDbPath fallbacks in storage.ts. v0.9.35 rename from
  // RAG-Explorer / .rag-explorer to the AdvisePoint Docs names -- see the
  // note in storage.ts for the reasoning around keeping RAG_PAGES_DIR as the
  // env-var name.
  const home = process.env.APPDATA || process.env.HOME || process.env.USERPROFILE;
  if (home) {
    return process.platform === "win32"
      ? join(home, "AdvisePoint Docs", "pages")
      : join(home, ".advisepoint-docs", "pages");
  }
  return join(process.cwd(), "pages");
}

// Zero-padded filename so a filesystem listing sorts correctly. New renders
// use .webp; the .jpg-suffixed helper is retained for legacy call sites.
export const RENDERER_VERSION = 2;
function pageFileName(page_number: number, ext: "webp" | "jpg" = "webp"): string {
  return `p${String(page_number).padStart(4, "0")}.${ext}`;
}

export function pageFilePath(document_id: string, page_number: number): string {
  return join(resolvePagesDir(), document_id, pageFileName(page_number));
}

// v0.9.30: render queue with concurrency 1. Previously every scheduleRender()
// call kicked off renderInBackground() immediately. When a user dropped 10+
// PDFs onto the Upload page all of them started rendering at the same time,
// the pdfjs `disableWorker: true` mode combined with 240 DPI @ q88 pinned
// every CPU core, the Node event loop starved, and /api/health stopped
// responding for tens of seconds. The React client's update-check ping timed
// out, showed "Server disconnected" and the whole app looked broken.
//
// Serializing renders trades wall-clock time (they now finish one after the
// other) for a responsive server. Combined with the setImmediate() yield
// inside the per-page loop below, the health endpoint stays responsive even
// mid-render.
type RenderJob = { document_id: string; buffer: Buffer };
const _renderQueue: RenderJob[] = [];
let _renderRunning = false;

function _drainRenderQueue(): void {
  if (_renderRunning) return;
  const job = _renderQueue.shift();
  if (!job) return;
  _renderRunning = true;
  renderInBackground(job.document_id, job.buffer)
    .catch((err) => {
      console.error(`[pages] render failed for ${job.document_id}:`, err);
      try {
        storage.upsertRenderStatus({
          document_id: job.document_id,
          status: "error",
          rendered: 0,
          total: 0,
          error: String(err?.message ?? err),
          updated_at: new Date().toISOString(),
        });
      } catch { /* ignore */ }
    })
    .finally(() => {
      _renderRunning = false;
      // Yield before starting the next job so the event loop gets a tick
      // to answer queued requests (health checks, chunk queries, etc.).
      setImmediate(_drainRenderQueue);
    });
}

// Public API — returns immediately, work happens on the event loop.
// Idempotent: repeated calls for the same doc while a render is running are safe
// (the second one sees status=rendering and returns early).
export function scheduleRender(document_id: string, buffer: Buffer): void {
  const existing = storage.getRenderStatus(document_id);
  if (existing && (existing.status === "rendering" || existing.status === "ready")) {
    return;
  }
  // Guard against duplicate queue entries if a caller schedules the same doc
  // twice while it's still pending.
  if (_renderQueue.some((j) => j.document_id === document_id)) return;
  const now = new Date().toISOString();
  storage.upsertRenderStatus({
    document_id,
    status: "pending",
    rendered: 0,
    total: 0,
    error: null,
    updated_at: now,
  });
  _renderQueue.push({ document_id, buffer });
  // Kick asynchronously so the HTTP handler returns first.
  setImmediate(_drainRenderQueue);
}

async function renderInBackground(document_id: string, buffer: Buffer): Promise<void> {
  const pdfjs = await loadPdfjs();
  const { createCanvas } = loadCanvas();

  // Copy the buffer into a fresh Uint8Array — pdfjs takes ownership of the
  // underlying storage and can zero it, and we don't want to disturb whatever
  // handed us the buffer.
  const bytes = new Uint8Array(buffer.length);
  bytes.set(buffer);

  // v0.9.29: PowerPoint-exported PDFs (and any PDF whose slides embed JPEG2000
  // images) rendered text-only under v0.9.28 — slides came out blank where
  // the paint cans, screenshots, and product photos should have been. Three
  // fixes are needed together:
  //   1. cMapUrl points at pdfjs's shipped CJK cmap tables so non-Latin
  //      glyphs and embedded font subsets resolve. Without this some
  //      slide-master glyphs silently drop and take the whole slide down.
  //   2. standardFontDataUrl feeds pdfjs the 14 Base-14 substitute fonts
  //      so Helvetica/Times fallbacks don't silently error out during layout.
  //   3. wasmUrl points at pdfjs's OpenJPEG (JPX) and QCMS wasm modules.
  //      Slides authored in PowerPoint routinely embed images as JP2/JPX,
  //      and without the OpenJPEG wasm every one of them fails to decode
  //      with "JpxError: OpenJPEG failed to initialize" and pdfjs paints
  //      nothing where the image belongs. This is THE fix for the blank-
  //      graphics complaint in the Color Optimizer deck.
  // useSystemFonts stays off because the Node/napi-rs font stack can't
  // resolve arbitrary system font names anyway — the pdfjs base fonts
  // handle it more predictably.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodePath = require("node:path") as typeof import("node:path");
  const pdfjsRoot = nodePath.dirname(require.resolve("pdfjs-dist/package.json"));
  const cMapUrl = `${pdfjsRoot}/cmaps/`;
  const standardFontDataUrl = `${pdfjsRoot}/standard_fonts/`;
  const wasmUrl = `${pdfjsRoot}/wasm/`;

  const loadingTask = pdfjs.getDocument({
    data: bytes,
    disableWorker: true,      // no worker thread — we render inline
    isEvalSupported: false,   // safer, we don't need eval'd font code
    useSystemFonts: false,    // v0.9.29: system-font fallback drops graphics on Windows
    cMapUrl,
    cMapPacked: true,
    standardFontDataUrl,
    wasmUrl,                  // v0.9.29: OpenJPEG/QCMS wasm for JP2/JPX images
  });
  const doc = await loadingTask.promise;
  const total = doc.numPages;

  const outDir = join(resolvePagesDir(), document_id);
  mkdirSync(outDir, { recursive: true });

  const startedAt = new Date().toISOString();
  storage.upsertRenderStatus({
    document_id,
    status: "rendering",
    rendered: 0,
    total,
    error: null,
    updated_at: startedAt,
  });

  // v0.9.21: 240 DPI @ pdfjs's default 72 DPI = 3.333x scale. Combined with
  // WebP q88 this keeps 8-9 pt body text legible up through ~250% viewer
  // zoom without visible compression smear. At q88 we're near WebP's
  // diminishing-returns knee for text-on-white pages.
  const scale = 240 / 72;
  const webpQuality = 88;

  let rendered = 0;
  for (let n = 1; n <= total; n++) {
    let page: any | null = null;
    try {
      page = await doc.getPage(n);
      const viewport = page.getViewport({ scale });
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext("2d");
      // WebP supports alpha but PDF pages often have transparent regions we
      // want to see as white on screen, so paint a white background first.
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, width, height);
      await page.render({ canvasContext: ctx, viewport, canvas }).promise;

      const buf = canvas.toBuffer("image/webp", webpQuality);
      const outPath = join(outDir, pageFileName(n, "webp"));
      writeFileSync(outPath, buf);

      const pageRow: DocumentPage = {
        document_id,
        page_number: n,
        image_path: outPath,
        width,
        height,
        generated_at: new Date().toISOString(),
      };
      storage.upsertPage(pageRow);
      rendered++;

      // Update progress every 10 pages (or on the last one) to avoid write
      // amplification for very long manuals.
      if (n % 10 === 0 || n === total) {
        storage.upsertRenderStatus({
          document_id,
          status: n === total ? "ready" : "rendering",
          rendered,
          total,
          error: null,
          updated_at: new Date().toISOString(),
        });
      }
    } finally {
      // pdfjs pages hold onto worker memory until cleaned up.
      try { page?.cleanup?.(); } catch { /* ignore */ }
    }

    // v0.9.30: yield the event loop between pages so the HTTP server stays
    // responsive (health checks, page image requests, chunk queries, etc.).
    // Without this the per-page pdfjs+canvas work blocks the loop long
    // enough to time out client-side polls on slower machines.
    await new Promise<void>((r) => setImmediate(r));
  }

  // Best-effort clean shutdown.
  try { await doc.cleanup?.(); } catch { /* ignore */ }
  try { await doc.destroy?.(); } catch { /* ignore */ }
}

// Remove all rendered pages for a doc, called from the DELETE handler.
export function purgePagesForDoc(document_id: string): void {
  const dir = join(resolvePagesDir(), document_id);
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.error(`[pages] purge failed for ${document_id}:`, err);
  }
  storage.deletePagesForDoc(document_id);
}
