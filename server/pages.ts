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

import { mkdirSync, existsSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join, dirname, resolve, isAbsolute, sep } from "node:path";
import { storage, rawDb } from "./storage";
import type { DocumentPage } from "./storage";

// v1.0.4: per-page and whole-job render timeouts. All configurable via env
// vars so field techs can tune them without shipping a new build. Defaults
// come from real-world observations:
//   - 2 min/page: 240 DPI @ q88 renders of dense manual pages take 3-8 s
//     on modern hardware, up to ~30 s on older laptops. 2 min is deep in
//     the "something is genuinely wrong" tail.
//   - 30 s for doc.getPage(n): usually microseconds. Anything over 30 s
//     means pdfjs is wedged parsing a malformed xref or CFF font.
//   - 60 s for pdfjs.getDocument().promise: the whole PDF must at least
//     parse its header, xref, and encryption metadata within a minute.
//   - 30 min whole-job wall clock: a 1000-page manual @ 5 s/page is ~80
//     min, so this is a safety net for pathological docs, not a normal cap.
//     If a legitimate huge manual needs more, raise the env var.
// v1.0.5: default lowered from 120_000 -> 60_000 to shrink the abandoned-
// promise window when withTimeout fires (pdfjs has no cancellation API, so
// the losing promise keeps burning CPU until it finishes naturally). 60 s
// is still deep in the "something is wrong" tail per the 240 DPI @ q88
// notes above (3-30 s per page in the wild). Override via env var if a
// legitimate slow page trips it. Full architectural fix (worker_threads
// with actual cancellation) tracked as v1.0.7-candidate in BACKLOG.md.
const RENDER_PAGE_TIMEOUT_MS = Number(process.env.RAG_RENDER_PAGE_TIMEOUT_MS) || 60_000;
const RENDER_GETPAGE_TIMEOUT_MS = Number(process.env.RAG_RENDER_GETPAGE_TIMEOUT_MS) || 30_000;
const RENDER_LOAD_TIMEOUT_MS = Number(process.env.RAG_RENDER_LOAD_TIMEOUT_MS) || 60_000;
const RENDER_JOB_TIMEOUT_MS = Number(process.env.RAG_RENDER_JOB_TIMEOUT_MS) || 1_800_000;

class RenderTimeoutError extends Error {
  constructor(op: string, ms: number) {
    super(`${op} timed out after ${ms}ms`);
    this.name = "RenderTimeoutError";
  }
}

// v1.0.4: race any pdfjs promise against a timer. On timeout throws a
// RenderTimeoutError; the underlying pdfjs work may keep running in the
// background (pdfjs has no cancellation API) but we stop awaiting it and
// move on. The `finally` block on the loser side still gets a chance to
// clean up when it eventually settles because we hold a reference.
async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  op: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new RenderTimeoutError(op, ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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

// v1.2.1: resolve a page image by recomputing its path from the current
// pages root instead of trusting the absolute path baked into
// document_pages.image_path at render time. This makes restores work across
// machines, Windows users, and architectures -- the DB row from an x64
// install pointing at C:\Users\<other-user>\AppData\Roaming\... is
// meaningless once the pages tree lives at a different absolute path, but
// the (document_id, page_number) tuple always maps to the same relative
// filename. Prefers the modern .webp render; falls back to .jpg for pages
// rendered before v0.9.19. Returns null if neither exists on disk.
export function resolvePageImageOnDisk(
  document_id: string,
  page_number: number,
): string | null {
  const root = resolvePagesDir();
  const webp = join(root, document_id, pageFileName(page_number, "webp"));
  if (existsSync(webp)) return webp;
  const jpg = join(root, document_id, pageFileName(page_number, "jpg"));
  if (existsSync(jpg)) return jpg;
  return null;
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
// v1.0.4: track the currently-running doc id so the header indicator can
// name it. Cleared in the drain function's .finally() block.
let _currentJobId: string | null = null;

function _drainRenderQueue(): void {
  if (_renderRunning) return;
  const job = _renderQueue.shift();
  if (!job) return;
  _renderRunning = true;
  _currentJobId = job.document_id;
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
      _currentJobId = null;
      // Yield before starting the next job so the event loop gets a tick
      // to answer queued requests (health checks, chunk queries, etc.).
      setImmediate(_drainRenderQueue);
    });
}

// v1.0.4: read-only snapshot of the render queue for the header indicator.
// Cheap - just returns primitives from module state, no DB access. Callers
// combine this with storage.getRenderStatus() to build the full picture.
export function getRenderQueueSnapshot(): {
  running: boolean;
  current_document_id: string | null;
  queue_depth: number;
  queued_document_ids: string[];
} {
  return {
    running: _renderRunning,
    current_document_id: _renderRunning && _renderQueue.length >= 0
      // The currently-rendering doc has already been shifted OUT of the
      // queue by _drainRenderQueue(). We stash it in _currentJobId below.
      ? _currentJobId
      : null,
    queue_depth: _renderQueue.length,
    queued_document_ids: _renderQueue.map((j) => j.document_id),
  };
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
  // v1.0.4: enforce a whole-job wall clock so a single pathological document
  // can never permanently starve the queue. Tracked with a Date-based check
  // per page rather than a Promise.race on the outer function, so the
  // *rest* of the doc can also short-circuit cleanly.
  const jobStartedAt = Date.now();
  const jobExpiresAt = jobStartedAt + RENDER_JOB_TIMEOUT_MS;

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
  // v1.0.4: bound the initial PDF load. A malformed xref or encrypted-
  // with-unsupported-cipher doc used to sit here forever. Widen back to
  // `any` because pdfjs's legacy build lacks proper types and the rest
  // of this file already treats doc/page as any.
  const doc: any = await withTimeout(
    loadingTask.promise,
    RENDER_LOAD_TIMEOUT_MS,
    `pdfjs.getDocument() for ${document_id}`,
  );
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

  // v1.0.4: track failures per page so we can (a) skip forward instead of
  // aborting the whole doc, and (b) mark the doc's final status based on
  // how much actually rendered. `firstFailure` gives the header render-
  // status indicator a short human-readable reason for the failure list.
  const failedPages: number[] = [];
  let firstFailure: { page: number; error: string } | null = null;

  let rendered = 0;
  for (let n = 1; n <= total; n++) {
    // v1.0.4: whole-job wall clock. If we've been at this for more than
    // RENDER_JOB_TIMEOUT_MS, abandon the doc entirely so the queue can
    // move to the next one. All remaining pages are marked failed for
    // reporting.
    if (Date.now() >= jobExpiresAt) {
      for (let m = n; m <= total; m++) failedPages.push(m);
      if (!firstFailure) {
        firstFailure = {
          page: n,
          error: `whole-document render exceeded ${RENDER_JOB_TIMEOUT_MS}ms`,
        };
      }
      break;
    }

    let page: any | null = null;
    try {
      // v1.0.4: pdfjs getPage() usually returns instantly but can wedge on
      // malformed page objects. Bound it explicitly.
      page = await withTimeout(
        doc.getPage(n),
        RENDER_GETPAGE_TIMEOUT_MS,
        `doc.getPage(${n}) for ${document_id}`,
      );
      const viewport = page.getViewport({ scale });
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext("2d");
      // WebP supports alpha but PDF pages often have transparent regions we
      // want to see as white on screen, so paint a white background first.
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, width, height);

      // v1.0.4: bound the actual render step. This is where hangs
      // realistically happen — an infinite loop inside an XObject or a
      // stuck OpenJPEG decode.
      await withTimeout(
        page.render({ canvasContext: ctx, viewport, canvas }).promise,
        RENDER_PAGE_TIMEOUT_MS,
        `page.render(${n}) for ${document_id}`,
      );

      // v1.0.5: bracket the synchronous WebP encoder with setImmediate
      // yields. @napi-rs/canvas encodes in-thread; for a 2400x3200 px
      // page that is 100-400 ms of pure event-loop block on top of
      // whatever pdfjs just did. The yields give the health-check poll
      // and any pending heartbeat a chance to land before/after the
      // encode so the client-side reconnect threshold does not trip.
      await new Promise<void>((r) => setImmediate(r));
      const buf = canvas.toBuffer("image/webp", webpQuality);
      await new Promise<void>((r) => setImmediate(r));
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
      // amplification for very long manuals. v1.0.4: the final "ready"
      // decision moved out of the loop so partial-failure math has all the
      // data it needs.
      if (n % 10 === 0 || n === total) {
        storage.upsertRenderStatus({
          document_id,
          status: "rendering",
          rendered,
          total,
          error: failedPages.length > 0
            ? `${failedPages.length} of ${total} pages failed so far`
            : null,
          updated_at: new Date().toISOString(),
          failed_pages: failedPages.length > 0 ? JSON.stringify(failedPages) : null,
          first_failed_page: firstFailure?.page ?? null,
        });
      }
    } catch (err) {
      // v1.0.4: log and skip forward instead of aborting the whole doc.
      // The catch is intentionally broad because we can't recover any
      // pdfjs error state anyway; the failure is per-page.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[pages] page ${n} of ${document_id} failed:`, message);
      failedPages.push(n);
      if (!firstFailure) {
        firstFailure = { page: n, error: message };
      }
    } finally {
      // pdfjs pages hold onto worker memory until cleaned up. Idempotent
      // and safe on a partially-rendered page.
      try { page?.cleanup?.(); } catch { /* ignore */ }
    }

    // v0.9.30: yield the event loop between pages so the HTTP server stays
    // responsive (health checks, page image requests, chunk queries, etc.).
    // Without this the per-page pdfjs+canvas work blocks the loop long
    // enough to time out client-side polls on slower machines.
    await new Promise<void>((r) => setImmediate(r));
  }

  // v1.0.4: final status decision. > 25% pages failed → status=error, so
  // the header indicator flags this doc. Otherwise mark ready with a
  // partial-failure note if some pages did fail.
  const failureRate = total > 0 ? failedPages.length / total : 0;
  const finalStatus: "ready" | "error" = failureRate > 0.25 ? "error" : "ready";
  const finalError = failedPages.length === 0
    ? null
    : finalStatus === "error"
      ? `${failedPages.length} of ${total} pages failed to render. First failure on page ${firstFailure?.page}: ${firstFailure?.error}`
      : `${failedPages.length} of ${total} pages failed to render (partial). First failure on page ${firstFailure?.page}: ${firstFailure?.error}`;
  storage.upsertRenderStatus({
    document_id,
    status: finalStatus,
    rendered,
    total,
    error: finalError,
    updated_at: new Date().toISOString(),
    failed_pages: failedPages.length > 0 ? JSON.stringify(failedPages) : null,
    first_failed_page: firstFailure?.page ?? null,
  });

  // Best-effort clean shutdown. Won't run if doc.getDocument() timed out
  // above (we never got `doc` to close), but the outer .catch() in the
  // drain function handles reporting for that case.
  try { await doc.cleanup?.(); } catch { /* ignore */ }
  try { await doc.destroy?.(); } catch { /* ignore */ }
}

// Remove all rendered pages for a doc, called from the DELETE handler.
/**
 * v1.0.12.3 — SAFETY GUARD.
 *
 * True only for an id that is safe to append to the pages root as a single
 * directory component. This exists because `join(pagesRoot, "")` returns the
 * pages root ITSELF, and the caller below then recursively deletes it --
 * destroying every rendered page image for every document in the library.
 * An id of "." or ".." or one containing a separator is equally dangerous.
 *
 * Callers must treat `false` as "refuse the operation", never as "skip the
 * file part and delete the row anyway".
 */
export function isSafeDocIdForPathUse(document_id: unknown): document_id is string {
  if (typeof document_id !== "string") return false;
  const id = document_id.trim();
  if (id === "" || id === "." || id === "..") return false;
  if (id !== document_id) return false;
  if (id.includes("/") || id.includes("\\") || id.includes("\0")) return false;
  if (isAbsolute(id)) return false;
  return true;
}

/**
 * Absolute path to a document's page directory, or null when the id is not
 * safe to use as a path component. Never returns the pages root.
 */
export function pageDirForDoc(document_id: string): string | null {
  if (!isSafeDocIdForPathUse(document_id)) return null;
  const root = resolve(resolvePagesDir());
  const dir = resolve(join(root, document_id));
  // Belt and braces: the result must be a strict child of the pages root.
  if (dir === root || !dir.startsWith(root + sep)) return null;
  return dir;
}

/**
 * v1.0.12.3 — is this document actually displayable RIGHT NOW?
 *
 * Page ROWS in the database are not proof: the rows survive while the image
 * files can be missing (moved, deleted, or lost in a failed restore), which
 * is precisely the state that makes a document open to a blank viewer. The
 * duplicate logic must never treat such a document as the viewable copy, so
 * this counts real files on disk.
 */
export function renderedPageFileCount(document_id: string): number {
  const dir = pageDirForDoc(document_id);
  if (dir === null || !existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter((name) => /\.(png|jpg|jpeg|webp)$/i.test(name)).length;
  } catch {
    return 0;
  }
}

export function hasRenderedPageFiles(document_id: string): boolean {
  return renderedPageFileCount(document_id) > 0;
}

// ---------------------------------------------------------------------------
// v1.1.7 -- boot reconciliation of stale render_status rows.
//
// The render queue lives in RAM (see _renderQueue above). When the process
// dies mid-render -- upgrade, tab-close idle shutdown, power cut -- the row
// in document_render_status is left at `pending` or `rendering` with a
// frozen updated_at, and nothing reconciles it. The PageViewer's terminal-
// state test (client/src/components/PageViewer.tsx) only stops polling on
// {ready, error, missing}, so those docs spin forever and never populate the
// existing /api/render/status.recent_failures list.
//
// This runs once at boot, walks every non-terminal row, and settles it:
//   * If the on-disk page-image count meets the recorded total AND total>0,
//     the process died between the last page write and the final upsert; the
//     document is actually ready. Mark it ready.
//   * Otherwise the render was interrupted before it finished. There is no
//     way to resume without the source bytes (PDF originals are not
//     retained), so mark the row `error` with a distinct prefix so the UI
//     can render "interrupted" instead of "failed to render". The remedy is
//     the same -- re-upload -- but the wording matters for reports.
//
// The `interrupted:` prefix is the only contract the client depends on;
// server code should not branch on it.
// ---------------------------------------------------------------------------
export const INTERRUPTED_RENDER_MESSAGE_PREFIX = "interrupted:";
export const INTERRUPTED_RENDER_MESSAGE =
  "interrupted: rendering was cut short by a shutdown or crash before it finished. Re-upload this file to view its pages.";

// v1.2.1 -- boot reconciliation of stale document_pages.image_path values.
//
// Prior to v1.2.1 we stored the absolute path each rendered page was
// written to. On a same-machine, same-user restore that column still
// resolves; on a cross-machine restore (different Windows username,
// different install location, different architecture) it points at a path
// that doesn't exist on this machine and the pages endpoint returns
// "image missing on disk" even though the WebP files are sitting right
// where they should be under the current pages root.
//
// The read path in v1.2.1+ resolves via resolvePageImageOnDisk() and
// ignores the stored value at read time. The heal below does the same
// rewrite in the DB so subsequent reads by any code that still trusts
// image_path (legacy call sites, third-party tooling, ad-hoc DB queries)
// see the correct location. Idempotent: rows that already point at a
// resolvable file are skipped; rows whose image doesn't exist anywhere
// under the current pages root are left alone so the interrupted-render
// logic above can still recognize them.
export function reconcilePersistedPageImagePaths(): {
  scanned: number;
  rewritten: number;
  missing: number;
} {
  let scanned = 0;
  let rewritten = 0;
  let missing = 0;

  const rows = rawDb
    .prepare(
      `SELECT rowid, document_id, page_number, image_path
         FROM document_pages`,
    )
    .all() as {
    rowid: number;
    document_id: string;
    page_number: number;
    image_path: string;
  }[];

  const upd = rawDb.prepare(
    "UPDATE document_pages SET image_path = ? WHERE rowid = ?",
  );
  const tx = rawDb.transaction(
    (batch: { rowid: number; newPath: string }[]) => {
      for (const b of batch) upd.run(b.newPath, b.rowid);
    },
  );

  const updates: { rowid: number; newPath: string }[] = [];
  for (const r of rows) {
    scanned += 1;
    if (existsSync(r.image_path)) continue;
    const resolved = resolvePageImageOnDisk(r.document_id, r.page_number);
    if (resolved) {
      updates.push({ rowid: r.rowid, newPath: resolved });
    } else {
      missing += 1;
    }
  }

  if (updates.length > 0) {
    tx(updates);
    rewritten = updates.length;
  }

  return { scanned, rewritten, missing };
}

export function reconcilePersistedRenderStatuses(): {
  scanned: number;
  promoted_ready: number;
  marked_interrupted: number;
} {
  let scanned = 0;
  let promoted_ready = 0;
  let marked_interrupted = 0;
  const nowIso = new Date().toISOString();

  // Full list is bounded (portable app, not a server workload) and this runs
  // once per boot, so a scan is fine.
  for (const doc of storage.listDocuments()) {
    const rs = storage.getRenderStatus(doc.id);
    if (!rs) continue;
    if (rs.status !== "pending" && rs.status !== "rendering") continue;
    scanned += 1;

    const onDisk = renderedPageFileCount(doc.id);
    if (rs.total > 0 && onDisk >= rs.total) {
      // Every page image is on disk; the crash happened AFTER the last page
      // write, before the final "ready" upsert. This is genuinely done.
      storage.upsertRenderStatus({
        document_id: doc.id,
        status: "ready",
        rendered: onDisk,
        total: rs.total,
        error: null,
        updated_at: nowIso,
      });
      promoted_ready += 1;
    } else {
      // Interrupted before completion. Nothing to resume against.
      storage.upsertRenderStatus({
        document_id: doc.id,
        status: "error",
        rendered: onDisk,
        total: rs.total,
        error: INTERRUPTED_RENDER_MESSAGE,
        updated_at: nowIso,
      });
      marked_interrupted += 1;
    }
  }
  return { scanned, promoted_ready, marked_interrupted };
}

export function purgePagesForDoc(document_id: string): void {
  const dir = pageDirForDoc(document_id);
  if (dir === null) {
    // Refuse rather than deleting the pages root. Bad ids are a caller bug.
    console.error(`[pages] refusing purge for unsafe document id: ${JSON.stringify(document_id)}`);
    throw new Error("Refusing to purge pages for an unsafe document id");
  }
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.error(`[pages] purge failed for ${document_id}:`, err);
  }
  storage.deletePagesForDoc(document_id);
}
