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
import {runRenderWorker} from "./render-worker-client";
import {uploadLog} from "./upload-log";

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
// v1.3.0 candidate 4: serialization remains, but yields alone did not prevent
// large-file delivery starvation. PDF drawing and encoding now run in a
// dedicated worker. The parent commits one page at a time and ACKs it.
type RenderJob = { document_id: string; buffer: Buffer };
const _renderQueue: RenderJob[] = [];
let _renderRunning = false;
let _activeRender: {done: Promise<void>; cancel: () => void} | null = null;
const _cancelledRenders = new Set<string>();
// v1.0.4: track the currently-running doc id so the header indicator can
// name it. Cleared in the drain function's .finally() block.
let _currentJobId: string | null = null;

function _drainRenderQueue(): void {
  if (_renderRunning) return;
  const job = _renderQueue.shift();
  if (!job) return;
  _renderRunning = true;
  _currentJobId = job.document_id;
  const renderStarted = Date.now();
  uploadLog("render_started",{document_id:job.document_id});
  renderInBackground(job.document_id, job.buffer)
    .catch((err) => {
      if (_cancelledRenders.has(job.document_id) || !storage.getDocument(job.document_id)) return;
      console.error(`[pages] render failed for ${job.document_id}:`, err);
      try {
        storage.upsertRenderStatus({
          document_id: job.document_id,
          status: "error",
          rendered: storage.listPages(job.document_id).length,
          total: storage.getRenderStatus(job.document_id)?.total ?? 0,
          error: String(err?.message ?? err),
          updated_at: new Date().toISOString(),
        });
      } catch { /* ignore */ }
    })
    .finally(() => {
      try {
        const status = storage.getRenderStatus(job.document_id);
        uploadLog("render_finished",{document_id:job.document_id,status:status?.status,
          rendered:status?.rendered,pages:status?.total,elapsed_ms:Date.now()-renderStarted,
          code:status?.status === "ready" && !status.error ? "READY" : "RENDER_INCOMPLETE"});
      } catch { /* logging must not block the queue */ }
      _cancelledRenders.delete(job.document_id);
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

// Public API: returns immediately; CPU-heavy work runs in the renderer worker.
// Idempotent: repeated calls for the same doc while a render is running are safe
// (the second one sees status=rendering and returns early).
export function scheduleRender(document_id: string, buffer: Buffer): void {
  if (!isSafeDocIdForPathUse(document_id)) throw Error("Unsafe render document id");
  if (_currentJobId === document_id) return;
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
  const outDir = pageDirForDoc(document_id);
  if (!outDir) throw Error("Unsafe render document id");
  const active = runRenderWorker(document_id, buffer, {
    page: (page, bytes) => {
      if (!storage.getDocument(document_id)) throw Error("Render document no longer exists");
      mkdirSync(outDir, {recursive: true});
      const outPath = join(outDir, pageFileName(page.page_number));
      writeFileSync(outPath, bytes);
      storage.upsertPage({...page, image_path: outPath});
    },
    status: status => {
      if (!storage.getDocument(document_id)) throw Error("Render document no longer exists");
      storage.upsertRenderStatus(status);
    },
  });
  _activeRender = active;
  try {await active.done;} finally {if (_activeRender === active) _activeRender = null;}
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
    if (r.image_path === "") continue; // Retained-PDF geometry is not a missing image.
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
  for (let i = _renderQueue.length - 1; i >= 0; i--) {
    if (_renderQueue[i].document_id === document_id) _renderQueue.splice(i, 1);
  }
  if (_currentJobId === document_id) {
    _cancelledRenders.add(document_id);
    _activeRender?.cancel();
  }
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.error(`[pages] purge failed for ${document_id}:`, err);
  }
  storage.deletePagesForDoc(document_id);
}
