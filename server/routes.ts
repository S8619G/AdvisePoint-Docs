import type { Express, Request } from "express";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { createHash } from "node:crypto";
import multer from "multer";
import { storage } from "./storage";
import { extractTextFromFile } from "./extract";
import { deriveLocation } from "./locate";
import { scheduleRender, purgePagesForDoc, pageFilePath, getRenderQueueSnapshot } from "./pages";
import { existsSync, createReadStream, statSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { platform, release as osRelease, hostname, arch, freemem, totalmem } from "node:os";
import { buildZip } from "./zip";
import { bootState, readRecentLogLines } from "./boot";
import { APP_VERSION } from "../client/src/version";
import {
  writeBackupTo,
  stageImport,
  cleanupStaged,
  importWipeReplace,
  importMerge,
  currentBackupRawSize,
  type BackupManifest,
} from "./backup";
import {
  readSettings as readBackupSettings,
  writeSettings as writeBackupSettings,
  startBackupScheduler,
  isBackupInFlight,
  withBackupLock,
} from "./backup-scheduler";
import { unlinkSync } from "node:fs";
import {
  ingestRequestSchema,
  searchRequestSchema,
  documentPatchSchema,
  CONFIDENTIALITY,
  type Chunk,
  type Document,
} from "@shared/schema";
import {
  chunkDocument,
  buildTfIdfVector,
  cosine,
  newChunkId,
  newDocId,
  termFrequency,
} from "./rag";

// Ordering for confidentiality ceiling filter (public <= internal <= confidential <= restricted)
const CONF_RANK: Record<string, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

function documentTypeKey(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function documentTypeError(res: any, error: unknown) {
  const message = error instanceof Error ? error.message : "Document type update failed.";
  const conflict = /unique|already exists/i.test(message);
  return res.status(conflict ? 409 : 400).json({
    message: conflict ? "A document type with that name already exists." : message,
  });
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  // -------- v0.9.26: Health check --------
  // Lightweight endpoint the client polls to detect a dead backend so it can
  // show a "please restart the app" overlay instead of a generic error.
  // Also touches storage.stats() so a broken database bubbles up as 500.
  app.get("/api/health", (req, res) => {
    try {
      const s = storage.stats();
      const boot = bootState.snapshot();
      const base = {
        ok: true,
        app: "advisepoint-docs",
        version: APP_VERSION,
        documents: s.documents,
        chunks: s.chunks,
        // v0.9.34: boot / uptime state so the frontend BackendDownOverlay and
        // support conversations can distinguish "server is still booting"
        // from "server is up but wedged".
        boot_phase: boot.boot_phase,
        boot_completed_at: boot.boot_completed_at,
        uptime_ms: boot.uptime_ms,
        last_error: boot.last_error,
      };
      // v0.9.34: optional log tail. Off by default to keep the small /api/health
      // response small (it is polled every few seconds by the BackendDownOverlay);
      // opt in with ?tail=1. Serves as a browser-copy-pasteable alternative to the
      // diagnostics export for support conversations.
      if (req.query.tail === "1" || req.query.tail === "true") {
        const tail = readRecentLogLines();
        res.json({ ...base, log_tail: tail });
      } else {
        res.json(base);
      }
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // v1.0.4: real-time render-queue status for the header render-status
  // indicator. Reads module state from pages.ts (no DB hit for the queue
  // snapshot itself) plus per-doc metadata from the documents table for
  // the currently-rendering doc and any recently-failed docs. Polled
  // every 2 s while active, every 10 s while idle.
  app.get("/api/render/status", (_req, res) => {
    try {
      const snap = getRenderQueueSnapshot();

      // Current doc detail. When a doc is actively rendering the queue
      // snapshot names it; we look up its title and progress from the DB.
      let current_document: {
        id: string;
        title: string;
        file_name: string;
        pages_done: number;
        pages_total: number;
      } | null = null;
      if (snap.running && snap.current_document_id) {
        const doc = storage.getDocument(snap.current_document_id);
        const rs = storage.getRenderStatus(snap.current_document_id);
        if (doc) {
          current_document = {
            id: doc.id,
            title: (doc.title ?? "") || (doc.file_name ?? "(untitled)"),
            file_name: doc.file_name ?? "(unknown)",
            pages_done: rs?.rendered ?? 0,
            pages_total: rs?.total ?? 0,
          };
        }
      }

      // v1.0.4: recent failures for the failure-state tooltip. Scans all
      // render_status rows for status="error" and enriches each with the
      // doc title/filename. `documents` table is bounded (a portable app,
      // not a server workload) so a full scan is fine here; the UI polls
      // this at most every 2 s.
      const recent_failures = storage.listDocuments()
        .map((d) => {
          const rs = storage.getRenderStatus(d.id);
          if (!rs || rs.status !== "error") return null;
          return {
            document_id: d.id,
            title: (d.title ?? "") || (d.file_name ?? "(untitled)"),
            file_name: d.file_name ?? "(unknown)",
            error: rs.error ?? "unknown error",
            failed_at: rs.updated_at,
            first_failed_page: rs.first_failed_page ?? null,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        // Newest failure first.
        .sort((a, b) => (a.failed_at < b.failed_at ? 1 : -1));

      res.json({
        active: snap.running,
        current_document,
        queue_depth: snap.queue_depth,
        recent_failures,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // The external updater uses this loopback-only handshake to release the
  // running bundle before swapping dist. Browsers cannot invoke it: the
  // updater-specific header is required and requests with Origin are rejected.
  app.post("/api/updater/shutdown", (req, res) => {
    const remote = req.socket.remoteAddress ?? "";
    const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    if (!loopback || req.get("origin") || req.get("x-apd-updater") !== "1") {
      return res.status(403).json({ message: "Updater authorization required." });
    }
    res.json({ ok: true, app: "advisepoint-docs", version: APP_VERSION });
    res.once("finish", () => {
      // v0.9.34: Field reports showed the graceful close could stall waiting on
      // the browser tab's still-open /api/heartbeat keep-alive connection,
      // pushing real port release past the updater's 15 s window. Drop live
      // sockets immediately (Node >= 18.2), then close, then hard-exit after
      // 2 s as a last resort. The browser sees a dropped connection and its
      // BackendDownOverlay takes over so nothing is lost UX-wise.
      const forcedExit = setTimeout(() => process.exit(0), 2000);
      forcedExit.unref();
      try {
        (httpServer as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      } catch {
        // closeAllConnections is best-effort; ignore if unavailable.
      }
      httpServer.close(() => process.exit(0));
    });
  });
  app.all("/api/updater/shutdown", (_req, res) => {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ message: "Use the authenticated updater POST request." });
  });

  // v0.9.35: Browser-invocable in-app updater launcher.
  //
  // Fires the same `Update AdvisePoint Docs.bat` the user would otherwise
  // double-click from File Explorer. The .bat runs the standalone updater.cjs,
  // which already calls /api/updater/shutdown to release the port before
  // swapping dist — so this endpoint's only job is to spawn the launcher
  // detached (so it survives our own process exit) and hand control off.
  //
  // Security model:
  //   - Loopback-only. Rejects any request whose remote address is not the
  //     loopback interface, which excludes LAN peers (matches the same posture
  //     as the rest of the app).
  //   - Same-origin only. Rejects requests carrying an `Origin` header that
  //     doesn't match the request Host — prevents a hostile page loaded on
  //     127.0.0.1 in another tab from launching the updater unprompted.
  //   - Windows only. The launcher .bat is a Windows shell script; other
  //     platforms get a 501 with a clear message pointing at the manual path.
  //   - Dev-mode guard. If the launcher .bat isn't present next to the app
  //     (e.g. running from source), return 404 instead of half-executing.
  app.post("/api/updater/launch", (req, res) => {
    const remote = req.socket.remoteAddress ?? "";
    const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    if (!loopback) {
      return res.status(403).json({ message: "Loopback only." });
    }
    const origin = req.get("origin");
    if (origin) {
      try {
        const originHost = new URL(origin).host;
        if (originHost !== req.get("host")) {
          return res.status(403).json({ message: "Cross-origin launch is not permitted." });
        }
      } catch {
        return res.status(400).json({ message: "Malformed Origin header." });
      }
    }
    if (process.platform !== "win32") {
      return res.status(501).json({
        message: "The in-app updater is Windows-only. Run the launcher script manually on this platform.",
      });
    }
    // The launcher .bat lives in the same folder as the running app. In a
    // shipped install, process.cwd() is set to that folder by the .bat itself
    // via `cd /d "%~dp0"`. We resolve to an absolute path so spawn doesn't try
    // to interpret it relative to any child working directory.
    const launcherPath = resolve(process.cwd(), "Update AdvisePoint Docs.bat");
    if (!existsSync(launcherPath)) {
      return res.status(404).json({
        message: "The updater launcher was not found. This build may have been extracted incorrectly.",
        looked_at: launcherPath,
      });
    }
    try {
      // v0.9.36.1: replaced the previous `cmd.exe /c start "<title>" "<launcher>"`
      // invocation. That form fails on Windows when EITHER argument contains
      // spaces — libuv's re-quoting of an already-quoted title arg pushes the
      // launcher path outside `start`'s parser, producing the classic
      // "Windows cannot find 'Docs'" error and no updater ever ran. Detached
      // spawn with `shell: true` lets Node's Windows shell wrapper quote the
      // .bat path once and correctly.
      //
      // v0.9.36.1: hidden window + auto-yes envs. The in-app updater path is
      // now fully non-interactive: APD_UPDATE_ASSUME_YES answers the "shut
      // down running server" and "launch after update" prompts, and
      // APD_UPDATE_NO_PROMPT skips the two "press Enter to close" waits.
      // The user just sees the app disconnect and reconnect on the new build.
      const child = spawn(`"${launcherPath}"`, [], {
        detached: true,
        stdio: "ignore",
        cwd: process.cwd(),
        shell: true,
        windowsHide: true,
        env: {
          ...process.env,
          APD_UPDATE_ASSUME_YES: "1",
          APD_UPDATE_NO_PROMPT: "1",
        },
      });
      child.unref();
      return res.json({ ok: true, launched_at: new Date().toISOString(), launcher: launcherPath });
    } catch (err) {
      return res.status(500).json({ message: "Could not launch the updater.", error: String(err) });
    }
  });
  app.all("/api/updater/launch", (_req, res) => {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ message: "Use POST to trigger the in-app updater." });
  });

  // -------- Stats --------
  app.get("/api/stats", (_req, res) => {
    res.json(storage.stats());
  });

  // -------- v0.9.33: Document type registry --------
  app.get("/api/document-types", (_req, res) => {
    res.json(storage.listDocumentTypes());
  });

  app.post("/api/document-types", (req, res) => {
    const label = typeof req.body?.label === "string" ? req.body.label.trim() : "";
    const key = documentTypeKey(label);
    if (!label || label.length > 80 || !key) {
      return res.status(400).json({ message: "Enter a document type name between 1 and 80 characters." });
    }
    try {
      storage.createDocumentType(key, label);
      return res.status(201).json(storage.listDocumentTypes());
    } catch (error) {
      return documentTypeError(res, error);
    }
  });

  app.patch("/api/document-types/:key", (req, res) => {
    const label = typeof req.body?.label === "string" ? req.body.label.trim() : "";
    const nextKey = documentTypeKey(label);
    if (!label || label.length > 80 || !nextKey) {
      return res.status(400).json({ message: "Enter a document type name between 1 and 80 characters." });
    }
    try {
      storage.renameDocumentType(req.params.key, nextKey, label);
      return res.json(storage.listDocumentTypes());
    } catch (error) {
      return documentTypeError(res, error);
    }
  });

  app.delete("/api/document-types/:key", (req, res) => {
    try {
      const reassigned = storage.deleteDocumentType(req.params.key);
      return res.json({ ...storage.listDocumentTypes(), reassigned });
    } catch (error) {
      return documentTypeError(res, error);
    }
  });

  // v0.9.36: set (or clear) the accent color for a document type.
  // Body: { color: "#rrggbb" } to set, or { color: null } to clear.
  // v0.9.36.4: accept both upper- and lower-case hex and normalize to
  // lower-case before persisting. The v0.9.36 client picker emits upper-case
  // hex from its preset table (e.g. "#C42B1C"), which the previous
  // lower-case-only regex rejected with a 400. The shared Zod schema for
  // this column has always accepted [0-9a-fA-F], so this brings the route
  // handler in line with the schema and keeps the DB canonical.
  app.patch("/api/document-types/:key/color", (req, res) => {
    const raw = req.body?.color;
    let color: string | null;
    if (raw === null || raw === undefined || raw === "") {
      color = null;
    } else if (typeof raw === "string" && /^#[0-9a-fA-F]{6}$/.test(raw)) {
      color = raw.toLowerCase();
    } else {
      return res.status(400).json({ message: "Color must be a 6-digit hex string (e.g. #ff0000) or null." });
    }
    try {
      storage.setDocumentTypeColor(req.params.key, color);
      return res.json(storage.listDocumentTypes());
    } catch (error) {
      return documentTypeError(res, error);
    }
  });

  app.put("/api/document-types/order", (req, res) => {
    const mode = req.body?.mode;
    const keys = req.body?.keys;
    if ((mode !== "importance" && mode !== "alphabetical") || !Array.isArray(keys) || !keys.every((key) => typeof key === "string")) {
      return res.status(400).json({ message: "Invalid document type ordering request." });
    }
    try {
      storage.setDocumentTypeOrder(mode, keys);
      return res.json(storage.listDocumentTypes());
    } catch (error) {
      return documentTypeError(res, error);
    }
  });

  // -------- List documents --------
  app.get("/api/documents", (_req, res) => {
    // v0.9.29: enrich each row with page_count from the render-status table
    // so the expanded Library card can show "X pages" without a second API
    // round-trip. total==0 for docs that never went through the renderer
    // (pasted-text ingests) — the client just hides the field when empty.
    const docs = storage.listDocuments().map((d) => {
      const rs = storage.getRenderStatus(d.id);
      return { ...hydrateDocument(d), page_count: rs?.total ?? null };
    });
    res.json(docs);
  });

  // -------- v0.9.23: Filename duplicate check --------
  // Given a comma-separated list of names ("?names=a.pdf,b.pdf"), return which
  // of those already exist in the library. Match is on the STEM only
  // (extension stripped) and case-insensitive so "Manual.PDF" vs "manual.pdf"
  // still collide. Used by the Upload page to warn users before they submit a
  // duplicate. Non-blocking — the user can still choose to upload it.
  app.get("/api/documents/filename-check", (req, res) => {
    const raw = typeof req.query.names === "string" ? req.query.names : "";
    if (!raw) return res.json({ duplicates: [] });
    const stemOf = (s: string) => s.replace(/\.[^./\\]+$/, "").toLowerCase();
    const requested = raw.split(",").map((s) => s.trim()).filter(Boolean);
    const existing = new Set(
      storage.listDocuments()
        .map((d: any) => d.file_name)
        .filter((n: any): n is string => typeof n === "string" && n.length > 0)
        .map(stemOf)
    );
    const duplicates = requested.filter((n) => existing.has(stemOf(n)));
    res.json({ duplicates });
  });

  // -------- Get a single document + its chunks --------
  app.get("/api/documents/:id", (req, res) => {
    const doc = storage.getDocument(req.params.id);
    if (!doc) return res.status(404).json({ message: "not found" });
    const chunkRows = storage.getChunksForDoc(doc.id).map(hydrateChunk);
    res.json({ document: hydrateDocument(doc), chunks: chunkRows });
  });

  // -------- Delete a document --------
  // Update document metadata. All fields optional — only provided ones are written.
  // Validated against the same enums the upload form uses so we never write junk.
  app.patch("/api/documents/:id", (req, res) => {
    const parsed = documentPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: "invalid request", issues: parsed.error.flatten() });
    }
    const doc = storage.getDocument(req.params.id);
    if (!doc) return res.status(404).json({ message: "not found" });
    if (parsed.data.document_type && !storage.documentTypeExists(parsed.data.document_type)) {
      return res.status(400).json({ message: "That document type no longer exists." });
    }
    storage.updateDocumentMeta(req.params.id, parsed.data);
    res.json({ ok: true, document: hydrateDocument(storage.getDocument(req.params.id)!) });
  });

  app.delete("/api/documents/:id", (req, res) => {
    // Purge sidecar page images first so we never leave orphans on disk if the DB row deletes but the fs op throws.
    try { purgePagesForDoc(req.params.id); } catch (err) { console.error("[delete] purge pages failed:", err); }
    storage.deleteDocument(req.params.id);
    res.json({ ok: true });
  });

  // -------- v0.9.23: Library maintenance scan --------
  // Sweeps the library for common integrity issues so techs can spot problems
  // before shipping a doc to a customer. Metadata-only — never re-renders or
  // re-hashes. Returns three issue buckets:
  //   * duplicate_filenames: two or more docs share the same file_name stem
  //     (case-insensitive). Groups the doc IDs so the UI can show "3 copies of
  //     admin-guide.pdf".
  //   * missing_product_model: parent rows with empty/whitespace-only product_model.
  //   * missing_pages: docs whose stored total_pages > 0 but at least one page
  //     file doesn't exist on disk. Only spot-checks pages 1, mid, and last to
  //     stay fast even on 800-page manuals — the goal is catching wholesale
  //     purges, not one-off render gaps (render status already tracks those).
  app.post("/api/library/scan", (_req, res) => {
    const docs = storage.listDocuments();
    const stemOf = (s: string) => s.replace(/\.[^./\\]+$/, "").toLowerCase();

    // ---- Duplicate filenames ----
    const stemGroups = new Map<string, { id: string; title: string; file_name: string }[]>();
    for (const d of docs) {
      const fn = (d as any).file_name as string | null | undefined;
      if (!fn) continue;
      const key = stemOf(fn);
      const arr = stemGroups.get(key) ?? [];
      arr.push({ id: d.id, title: d.title, file_name: fn });
      stemGroups.set(key, arr);
    }
    const duplicate_filenames = Array.from(stemGroups.values()).filter((g) => g.length > 1);

    // ---- Missing product_model ----
    const missing_product_model = docs
      .filter((d) => !d.product_model || d.product_model.trim() === "")
      .map((d) => ({ id: d.id, title: d.title }));

    // ---- Missing page files (spot-check first/mid/last) ----
    const missing_pages: { id: string; title: string; total_pages: number; missing: number[] }[] = [];
    for (const d of docs) {
      const totalPages = (d as any).total_pages as number | null | undefined;
      if (!totalPages || totalPages <= 0) continue;
      const status = storage.getRenderStatus(d.id);
      // Skip docs that never had a PDF or are still rendering — nothing to check.
      if (!status || status.status === "pending" || status.status === "rendering") continue;
      const spot = new Set<number>([1, Math.max(1, Math.floor(totalPages / 2)), totalPages]);
      const missing: number[] = [];
      for (const p of spot) {
        if (!existsSync(pageFilePath(d.id, p))) missing.push(p);
      }
      if (missing.length > 0) {
        missing_pages.push({ id: d.id, title: d.title, total_pages: totalPages, missing });
      }
    }

    res.json({
      scanned_at: new Date().toISOString(),
      total_documents: docs.length,
      duplicate_filenames,
      missing_product_model,
      missing_pages,
      issue_count: duplicate_filenames.length + missing_product_model.length + missing_pages.length,
    });
  });

  // -------- v0.9.7 page renders --------
  // Status of the background render job for a document. Returns 'missing' when
  // we never had a PDF for this doc (e.g. it was ingested as .docx/.md/.txt).
  app.get("/api/documents/:id/pages/status", (req, res) => {
    const doc = storage.getDocument(req.params.id);
    if (!doc) return res.status(404).json({ message: "not found" });
    const status = storage.getRenderStatus(req.params.id);
    if (!status) {
      return res.json({
        document_id: req.params.id,
        status: "missing",
        rendered: 0,
        total: 0,
        error: null,
      });
    }
    res.json(status);
  });

  // List every rendered page for a doc — the viewer uses this to build its
  // page index. Small payload: just the numbers + dimensions, no image data.
  app.get("/api/documents/:id/pages", (req, res) => {
    const doc = storage.getDocument(req.params.id);
    if (!doc) return res.status(404).json({ message: "not found" });
    const pages = storage.listPages(req.params.id).map((p) => ({
      page_number: p.page_number,
      width: p.width,
      height: p.height,
      url: `/api/documents/${req.params.id}/pages/${p.page_number}.jpg`,
    }));
    res.json({ document_id: req.params.id, pages });
  });

  // Stream one page image. Path is validated against the DB row so we never
  // serve arbitrary files: attackers can't traverse via ../../../etc/passwd.
  app.get("/api/documents/:id/pages/:n.jpg", (req, res) => {
    const n = parseInt(req.params.n, 10);
    if (!Number.isFinite(n) || n < 1) return res.status(400).json({ message: "invalid page number" });
    const row = storage.getPage(req.params.id, n);
    if (!row) return res.status(404).json({ message: "page not rendered yet" });
    if (!existsSync(row.image_path)) {
      return res.status(404).json({ message: "image missing on disk" });
    }
    try {
      const stat = statSync(row.image_path);
      // v0.9.19: renders are WebP; older renders are JPEG. The URL still ends
      // in .jpg for cache-key stability, but the actual bytes come from disk
      // and we advertise the right content-type so the browser decodes them.
      const ext = /\.webp$/i.test(row.image_path) ? "webp" : "jpeg";
      res.setHeader("Content-Type", `image/${ext}`);
      res.setHeader("Content-Length", String(stat.size));
      // These images are immutable once written — cache aggressively so the
      // viewer's prev/next flicker stays cheap.
      res.setHeader("Cache-Control", "private, max-age=3600, immutable");
      createReadStream(row.image_path).pipe(res);
    } catch (err: any) {
      console.error(`[pages] stream failed for ${req.params.id}/${n}:`, err);
      if (!res.headersSent) res.status(500).json({ message: "read failed" });
    }
  });

  // -------- File upload (PDF/DOCX/TXT/MD) --------
  // Accepts a multipart upload with `file` + form fields matching ingestRequestSchema
  // (minus `body`). Extracts text server-side and hands off to the same ingest logic.
  //
  // v0.9.16 hardening:
  //  - fileFilter rejects anything that isn't PDF/DOCX/TXT/MD by extension AND
  //    by declared MIME type. Prevents "renamed .exe as .pdf" from making it
  //    into the multer buffer at all.
  //  - fileSize cap unchanged at 150 MB per file.
  const ALLOWED_EXT = new Set([".pdf", ".docx", ".txt", ".md", ".markdown"]);
  const ALLOWED_MIME = new Set([
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain",
    "text/markdown",
    "text/x-markdown",
    // Some browsers send octet-stream for unknown-to-them MIME types. Accept it
    // only when the extension is also on the allow-list (checked below).
    "application/octet-stream",
  ]);

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 150 * 1024 * 1024 }, // 150 MB per file
    fileFilter: (_req, file, cb) => {
      const lower = file.originalname.toLowerCase();
      const dotIdx = lower.lastIndexOf(".");
      const ext = dotIdx >= 0 ? lower.slice(dotIdx) : "";
      const extOk = ALLOWED_EXT.has(ext);
      const mimeOk = ALLOWED_MIME.has(file.mimetype);
      if (extOk && mimeOk) return cb(null, true);
      // Reject without throwing — multer will pass a null file downstream and
      // the route hands back a 415 with a friendly explanation.
      return cb(null, false);
    },
  });

  app.post("/api/upload", upload.single("file"), async (req: Request, res) => {
    try {
      if (!req.file) {
        // Two reasons this fires: no `file` field, or multer's fileFilter
        // rejected the type. The client sends a file field ~always, so a
        // missing file at this point almost certainly means bad MIME/extension.
        return res.status(415).json({
          message: "unsupported file type \u2014 only PDF, DOCX, TXT, or Markdown files are accepted",
        });
      }

      // Parse the metadata JSON blob that the client posts alongside the file
      const metaRaw = typeof req.body?.metadata === "string" ? req.body.metadata : "{}";
      let metaObj: Record<string, unknown>;
      try {
        metaObj = JSON.parse(metaRaw);
      } catch {
        return res.status(400).json({ message: "metadata field is not valid JSON" });
      }

      // Extract text
      const extracted = await extractTextFromFile(req.file.originalname, req.file.buffer);
      if (!extracted.text || extracted.text.trim().length < 20) {
        return res.status(422).json({
          message: `Extracted less than 20 characters of text from ${req.file.originalname}. If this is a scanned PDF, it needs OCR first.`,
        });
      }

      // Reasonable defaults
      const defaultTitle = req.file.originalname.replace(/\.[^.]+$/, "");
      const merged = {
        title: metaObj.title || defaultTitle,
        file_name: req.file.originalname,
        body: extracted.text,
        ...metaObj,
        // Force body & file_name from server side
        ...({} as Record<string, unknown>),
      } as Record<string, unknown>;
      merged.body = extracted.text;
      merged.file_name = req.file.originalname;
      if (!merged.title) merged.title = defaultTitle;

      const parsed = ingestRequestSchema.safeParse(merged);
      if (!parsed.success) {
        return res.status(400).json({
          message: "invalid metadata",
          issues: parsed.error.flatten(),
        });
      }
      if (!storage.documentTypeExists(parsed.data.document_type)) {
        return res.status(400).json({ message: "That document type no longer exists." });
      }

      const result = await ingestParsed(parsed.data);

      // v0.9.7 — fire off page rendering for PDFs. Runs in the background so
      // the client sees the doc immediately; viewer polls /pages/status while
      // it works. Non-PDFs skip this entirely.
      if (extracted.format === "pdf" && result?.document?.id) {
        try {
          scheduleRender(result.document.id, req.file.buffer);
        } catch (err) {
          console.error("[upload] scheduleRender failed:", err);
        }
      }

      return res.json({
        ...result,
        extraction: {
          format: extracted.format,
          page_count: extracted.page_count,
          char_count: extracted.text.length,
        },
      });
    } catch (err: any) {
      console.error("[upload] failed:", err);
      return res.status(500).json({ message: err?.message ?? "upload failed" });
    }
  });

  // -------- Ingest (text body) --------
  app.post("/api/ingest", async (req, res) => {
    const parsed = ingestRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "invalid request", issues: parsed.error.flatten() });
    }
    if (!storage.documentTypeExists(parsed.data.document_type)) {
      return res.status(400).json({ message: "That document type no longer exists." });
    }
    const result = await ingestParsed(parsed.data);
    res.json(result);
  });

  // Shared ingest helper — used by /api/ingest, /api/upload, and the seeder.
  async function ingestParsed(r: import("@shared/schema").IngestRequest) {
    const now = new Date().toISOString();
    const docId = newDocId();

    const docRow: Document = {
      id: docId,
      title: r.title,
      subtitle: r.subtitle ?? null,
      document_type: r.document_type,
      audience_json: JSON.stringify(r.audience),
      language: r.language,
      summary: r.summary ?? null,
      product_family: r.product_family ?? null,
      product_model: r.product_model,
      product_sku: r.product_sku ?? null,
      product_version: r.product_version ?? null,
      firmware_version: r.firmware_version ?? null,
      platform_json: JSON.stringify(r.platform),
      region_json: JSON.stringify(r.region),
      release_channel: r.release_channel ?? null,
      lifecycle_status: r.lifecycle_status,
      published_at: null,
      updated_at: now,
      confidentiality: r.confidentiality,
      allowed_tenants_json: JSON.stringify(r.allowed_tenants),
      source_uri: r.source_uri ?? null,
      source_system: r.source_uri ? guessSourceSystem(r.source_uri) : null,
      file_name: r.file_name ?? null,
      file_hash_sha256: createHash("sha256").update(r.body).digest("hex"),
      ingested_at: now,
      pipeline_version: "advisepoint-docs-1.0.0",
      tags_json: JSON.stringify(r.tags),
      keywords_json: JSON.stringify(r.keywords),
      // v0.9.30: title accent color — not settable at ingest time; users
      // pick it later from the Library edit dialog. Default null.
      title_color: null,
      total_chunks: 0,
      total_tokens: 0,
    };
    storage.createDocument(docRow);

    const drafts = chunkDocument(r.body, {
      chunk_size_tokens: r.chunk_size_tokens,
      chunk_overlap_tokens: r.chunk_overlap_tokens,
    });

    const corpus = storage.allChunks();
    const df = new Map<string, number>();
    const totalDocs = corpus.length + drafts.length;
    for (const c of corpus) {
      const terms = Object.keys(safeJson<Record<string, number>>(c.embedding_json, {}));
      for (const t of terms) df.set(t, (df.get(t) ?? 0) + 1);
    }
    for (const d of drafts) {
      const terms = Object.keys(termFrequency(d.content));
      for (const t of terms) df.set(t, (df.get(t) ?? 0) + 1);
    }

    let carriedPage: number | null = null;
    let carriedSection: string | null = null;
    const chunkRows: Chunk[] = drafts.map((d) => {
      const vec = buildTfIdfVector(d.content, df, totalDocs);
      // Derive page/section from inline "-- N of N --" markers in the extracted PDF text.
      const loc = deriveLocation(d.content, carriedPage);
      carriedPage = loc.page_end ?? carriedPage;
      const isDefaultSection = !d.section_title || d.section_title === "Body";
      const finalSection = isDefaultSection
        ? loc.section_title ?? carriedSection
        : d.section_title;
      if (finalSection) carriedSection = finalSection;
      return {
        id: newChunkId(),
        parent_id: docId,
        content: d.content,
        content_type: d.content_type,
        language: r.language,
        section_path_json: JSON.stringify(d.section_path),
        section_id: d.section_id,
        section_title: finalSection ?? d.section_title,
        heading_level: d.heading_level,
        page_start: d.page_start ?? loc.page_start,
        page_end: d.page_end ?? loc.page_end,
        chunk_index: d.chunk_index,
        document_type: r.document_type,
        product_model: r.product_model,
        product_version: r.product_version ?? null,
        firmware_version: r.firmware_version ?? null,
        audience_json: JSON.stringify(r.audience),
        confidentiality: r.confidentiality,
        allowed_tenants_json: JSON.stringify(r.allowed_tenants),
        lifecycle_status: r.lifecycle_status,
        updated_at: now,
        error_codes_json: JSON.stringify(d.error_codes),
        cli_commands_json: JSON.stringify(d.cli_commands),
        ui_paths_json: JSON.stringify(d.ui_paths),
        tags_json: JSON.stringify(d.extracted_tags),
        embedding_json: JSON.stringify(vec),
        token_count: d.token_count,
      };
    });
    storage.insertChunks(chunkRows);

    const total_tokens = chunkRows.reduce((a, b) => a + b.token_count, 0);
    storage.updateDocumentStats(docId, chunkRows.length, total_tokens);

    const finalDoc = storage.getDocument(docId)!;
    return {
      document: hydrateDocument(finalDoc),
      chunks: chunkRows.map(hydrateChunk),
    };
  }

  // (search follows)
  // -------- Search --------
  app.post("/api/search", (req, res) => {
    const parsed = searchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "invalid request", issues: parsed.error.flatten() });
    }
    const { query, top_k, filters, hybrid } = parsed.data;

    // Extract quoted phrases (both straight and curly quotes). These become required substrings
    // that a result MUST contain — the unquoted remainder is still scored via TF-IDF.
    // Example: 'setup "custom box" printing' → phrases=["custom box"], scoringQuery='setup custom box printing'
    const requiredPhrases: string[] = [];
    const quoteRe = /["“”]([^"“”]+)["“”]/g;
    let qm: RegExpExecArray | null;
    while ((qm = quoteRe.exec(query)) !== null) {
      const phrase = qm[1].trim();
      if (phrase.length > 0) requiredPhrases.push(phrase);
    }
    // Query text used for TF-IDF: quotes stripped, so the phrase's tokens still contribute to ranking.
    const scoringQuery = query.replace(/["“”]/g, " ").replace(/\s+/g, " ").trim();

    // Build query vector against current corpus
    const all = storage.allChunks();
    if (all.length === 0) return res.json({ results: [], filter_applied: filters, required_phrases: requiredPhrases });

    const df = new Map<string, number>();
    for (const c of all) {
      const terms = Object.keys(safeJson<Record<string, number>>(c.embedding_json, {}));
      for (const t of terms) df.set(t, (df.get(t) ?? 0) + 1);
    }
    const qVec = buildTfIdfVector(scoringQuery, df, all.length);
    const qTerms = Object.keys(qVec);

    // Normalize a phrase for substring matching: lowercase and collapse whitespace so a phrase like
    // 'custom box' still matches 'Custom  Box' or 'Custom\nBox' as it might appear in extracted PDF text.
    const normalizeForPhraseMatch = (s: string) => s.toLowerCase().replace(/\s+/g, " ");
    const normalizedPhrases = requiredPhrases.map(normalizeForPhraseMatch);

    // Apply hard filters
    // v0.9.30: precompute parent-doc IDs whose user-supplied tags include any
    // of the wanted tags, so we can pass a chunk on either a parent-tag or a
    // chunk-tag match without hitting storage.getDocument() per chunk.
    let _parentTagHits: Set<string> | null = null;
    if (filters.tags?.length) {
      const wanted = (filters.tags as string[]).map((t) => t.toLowerCase());
      _parentTagHits = new Set(
        storage.listDocuments()
          .filter((d) => {
            const ptags = safeJson<string[]>(d.tags_json, []).map((t) => t.toLowerCase());
            return wanted.some((w) => ptags.includes(w));
          })
          .map((d) => d.id)
      );
    }
    const filtered = all.filter((c) => {
      if (filters.product_model?.length && !filters.product_model.includes(c.product_model)) return false;
      if (filters.product_version?.length && c.product_version && !filters.product_version.includes(c.product_version)) return false;
      if (filters.firmware_version?.length && c.firmware_version && !filters.firmware_version.includes(c.firmware_version)) return false;
      if (filters.document_type?.length && !filters.document_type.includes(c.document_type as any)) return false;
      if (filters.lifecycle_status?.length && !filters.lifecycle_status.includes(c.lifecycle_status as any)) return false;
      if (filters.audience?.length) {
        const aud = safeJson<string[]>(c.audience_json, []);
        if (!filters.audience.some((a) => aud.includes(a))) return false;
      }
      if (filters.content_type?.length && !filters.content_type.includes(c.content_type as any)) return false;
      if (filters.confidentiality_max) {
        if (CONF_RANK[c.confidentiality] > CONF_RANK[filters.confidentiality_max]) return false;
      }
      if (filters.tenant) {
        const tenants = safeJson<string[]>(c.allowed_tenants_json, []);
        if (tenants.length && !tenants.includes(filters.tenant)) return false;
      }
      if (filters.error_code) {
        const codes = safeJson<string[]>(c.error_codes_json, []);
        if (!codes.map((x) => x.toUpperCase()).includes(filters.error_code.toUpperCase())) return false;
      }
      if (filters.language && c.language !== filters.language) return false;
      if (filters.updated_after && c.updated_at < filters.updated_after) return false;
      // v0.9.30: tags multi-select. Match if ANY of the selected tags appears
      // on the parent document (user-supplied tags), OR on the chunk itself
      // (auto-extracted per-chunk tags). Both sources are compared case-
      // insensitively. Empty filter = don't filter. The parent-doc set is
      // precomputed once above the filter loop.
      if (filters.tags?.length) {
        const wanted = (filters.tags as string[]).map((t) => t.toLowerCase());
        const chunkTags = safeJson<string[]>(c.tags_json, []).map((t) => t.toLowerCase());
        const parentHit = _parentTagHits && _parentTagHits.has(c.parent_id);
        const chunkHit = wanted.some((w) => chunkTags.includes(w));
        if (!parentHit && !chunkHit) return false;
      }
      // v0.9.18: in-document quick search scopes to one parent document
      if (filters.document_id && c.parent_id !== filters.document_id) return false;
      // Required-phrase gate: every quoted phrase must appear (case-insensitive, whitespace-flexible)
      // in the chunk content. Chunks that lack any of them are dropped entirely.
      if (normalizedPhrases.length > 0) {
        const haystack = normalizeForPhraseMatch(c.content);
        for (const p of normalizedPhrases) {
          if (!haystack.includes(p)) return false;
        }
      }
      return true;
    });

    // Score
    const scored = filtered.map((c) => {
      const vec = safeJson<Record<string, number>>(c.embedding_json, {});
      let score = cosine(qVec, vec);
      if (hybrid) {
        // Keyword hit boost: fraction of query terms present in chunk
        const chunkTerms = new Set(Object.keys(vec));
        let hits = 0;
        for (const t of qTerms) if (chunkTerms.has(t)) hits++;
        const keywordScore = qTerms.length ? hits / qTerms.length : 0;
        score = 0.7 * score + 0.3 * keywordScore;
      }
      // Boost chunks that contain a required phrase multiple times (more relevant repetition).
      if (normalizedPhrases.length > 0) {
        const haystack = normalizeForPhraseMatch(c.content);
        let phraseHits = 0;
        for (const p of normalizedPhrases) {
          // Count occurrences without a regex to sidestep escaping edge cases.
          let idx = 0;
          while ((idx = haystack.indexOf(p, idx)) !== -1) { phraseHits++; idx += p.length; }
        }
        // Log(1+hits) so the boost saturates and doesn't overwhelm relevance ordering.
        score *= 1 + Math.min(0.5, Math.log(1 + phraseHits) * 0.15);
      }
      // Small boost for procedures / cli / faq when query looks how-to
      if (/\bhow\b|\bsteps?\b|\bconfigur|\bset up\b/i.test(scoringQuery)) {
        if (["procedure", "cli_command", "faq", "config_snippet"].includes(c.content_type)) {
          score *= 1.08;
        }
      }
      return { chunk: c, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, top_k).map(({ chunk, score }) => {
      const parent = storage.getDocument(chunk.parent_id);
      return {
        score: Number(score.toFixed(4)),
        chunk: hydrateChunk(chunk),
        parent: parent ? { id: parent.id, title: parent.title, title_color: parent.title_color ?? null, document_type: parent.document_type, product_model: parent.product_model, product_version: parent.product_version, firmware_version: parent.firmware_version } : null,
      };
    });

    res.json({ results: top, total_matched: filtered.length, filter_applied: filters, required_phrases: requiredPhrases });
  });

  // -------- Facets: unique values for filter dropdowns --------
  app.get("/api/facets", (_req, res) => {
    const docs = storage.listDocuments();
    const models = unique(docs.map((d) => d.product_model));
    const versions = unique(docs.map((d) => d.product_version).filter(Boolean) as string[]);
    const firmwares = unique(docs.map((d) => d.firmware_version).filter(Boolean) as string[]);
    const doc_types = unique(docs.map((d) => d.document_type));
    const tenants = unique(docs.flatMap((d) => safeJson<string[]>(d.allowed_tenants_json, [])));
    // v0.9.29: expose the union of tags across the library so the Upload +
    // Library-edit Tag combobox can offer global autocomplete. Ranked by
    // usage frequency (most-used first) so the top suggestions are the ones
    // techs actually type most often.
    const tagCounts = new Map<string, number>();
    for (const d of docs) {
      for (const t of safeJson<string[]>(d.tags_json, [])) {
        const key = t.trim();
        if (!key) continue;
        tagCounts.set(key, (tagCounts.get(key) ?? 0) + 1);
      }
    }
    const tags = Array.from(tagCounts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([t]) => t);
    res.json({ product_models: models, product_versions: versions, firmware_versions: firmwares, document_types: doc_types, tenants, tags });
  });

  // -------- v0.9.31: Diagnostics bundle export --------
  // Users click a button in Settings > About > Diagnostics and this route
  // streams a zip containing the current + previous server logs and a
  // bundle-info.txt with app + OS + DB counts. The zip is meant to be
  // attached to a support request so the maintainer can inspect the same
  // session state the user was in when the issue happened.
  //
  // Privacy note: the log content is included verbatim. The privacy audit
  // for v0.9.31 confirmed the server only logs HTTP request lines and
  // migration/boot messages - no query text, no document titles, no PDF
  // content. If that changes in a future version, this endpoint needs to
  // grow a redaction pass BEFORE the release ships.
  app.get("/api/diagnostics/export", (_req, res) => {
    try {
      const logDir = process.env.APD_LOG_DIR
        || (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "AdvisePoint Docs") : null)
        || "/tmp";

      const entries: { name: string; data: Buffer | string }[] = [];

      // Include server.log and server.log.1 if present. Missing files are
      // silently skipped rather than aborting the export - a fresh install
      // may only have the current log with no rotation history.
      for (const name of ["server.log", "server.log.1"]) {
        const p = join(logDir, name);
        if (existsSync(p)) {
          try {
            entries.push({ name, data: readFileSync(p) });
          } catch (err) {
            // Log read failures land in bundle-info.txt so a support ticket
            // still contains a breadcrumb even if the files are locked.
            entries.push({
              name: `${name}.read-error.txt`,
              data: `Failed to read ${p}: ${String(err)}`,
            });
          }
        }
      }

      // Bundle info - anything a maintainer would ask for in a support
      // thread. We deliberately do NOT include the OS user name; the
      // hostname is enough to correlate multiple bundles from the same
      // machine without pulling in user identity.
      let dbInfo = "unavailable";
      try {
        const s = storage.stats();
        dbInfo = `documents=${s.documents} chunks=${s.chunks}`;
      } catch (err) {
        dbInfo = `error: ${String(err)}`;
      }

      const info = [
        `AdvisePoint Docs diagnostics bundle`,
        `Generated: ${new Date().toISOString()}`,
        ``,
        `[app]`,
        `version: ${APP_VERSION}`,
        `cwd: ${process.cwd()}`,
        `log_dir: ${logDir}`,
        `db_path: ${process.env.RAG_DB_PATH || "(default)"}`,
        `pages_dir: ${process.env.RAG_PAGES_DIR || "(default)"}`,
        ``,
        `[runtime]`,
        `node: ${process.version}`,
        `platform: ${platform()}`,
        `arch: ${arch()}`,
        `os_release: ${osRelease()}`,
        `hostname: ${hostname()}`,
        `mem_total_mb: ${Math.round(totalmem() / 1024 / 1024)}`,
        `mem_free_mb: ${Math.round(freemem() / 1024 / 1024)}`,
        `uptime_sec: ${Math.round(process.uptime())}`,
        ``,
        `[storage]`,
        dbInfo,
        ``,
      ].join("\n");
      entries.push({ name: "bundle-info.txt", data: info });

      // Timestamped filename so a user can generate several bundles per
      // session without them overwriting each other in Downloads.
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const stamp =
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
        `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const filename = `advisepoint-docs-diagnostics-${stamp}.zip`;

      const zip = buildZip(entries);
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Length", String(zip.length));
      res.end(zip);
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // -------- v1.0.3: Backup & Restore --------

  // Multer for backup uploads: disk storage (backups can be large), 5 GB
  // ceiling (well above any realistic library size), no file filter --
  // the backup module validates by looking for manifest.json inside.
  const backupUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        const os = require("node:os");
        const path = require("node:path");
        const fs = require("node:fs");
        const dir = path.join(os.tmpdir(), "advisepoint-docs-import-uploads");
        try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
        cb(null, dir);
      },
      filename: (_req, file, cb) => {
        cb(null, `import-${Date.now()}-${file.originalname.replace(/[^A-Za-z0-9._-]/g, "_")}`);
      },
    }),
    limits: { fileSize: 5 * 1024 * 1024 * 1024 },
  });

  // POST /api/backup/export -- streams a fresh backup zip to the client.
  // Accepts an optional JSON body with `{ localStorage: string }` so the
  // browser can include its state; when the request is a plain GET the
  // backup ships without localStorage.
  const doExport = async (req: Request, res: any) => {
    if (isBackupInFlight()) {
      return res.status(409).json({ ok: false, error: "A backup is already in progress" });
    }
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const filename = `advisepoint-docs-backup-${stamp}.zip`;
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    // Streaming; do not set Content-Length.
    let ls: string | null = null;
    if (req.method === "POST" && req.body && typeof req.body.localStorage === "string") {
      ls = req.body.localStorage;
    }
    try {
      await withBackupLock(() => writeBackupTo(res, { localStorageJson: ls }));
    } catch (err) {
      // If headers were already flushed the client sees a truncated stream;
      // there's not much more we can do. Log for diagnostics.
      console.error("[BACKUP] export failed:", err);
      if (!res.headersSent) res.status(500).json({ ok: false, error: String((err as Error).message || err) });
      else res.end();
    }
  };
  app.get("/api/backup/export", doExport);
  app.post("/api/backup/export", doExport);

  // POST /api/backup/import  (multipart, `file` + `mode`)
  //   mode = "wipe" | "merge"
  app.post("/api/backup/import", backupUpload.single("file"), async (req: Request, res) => {
    if (isBackupInFlight()) {
      return res.status(409).json({ ok: false, error: "A backup is already in progress" });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "No backup file uploaded" });
    }
    const mode = String(req.body?.mode || "").toLowerCase();
    if (mode !== "wipe" && mode !== "merge") {
      try { unlinkSync(req.file.path); } catch { /* ignore */ }
      return res.status(400).json({ ok: false, error: "mode must be 'wipe' or 'merge'" });
    }

    const started = Date.now();
    type Staged = Awaited<ReturnType<typeof stageImport>>;
    let staged: Staged | null = null;
    try {
      const stagedNonNull: Staged = await withBackupLock(async () => await stageImport(req.file!.path));
      staged = stagedNonNull;
      if (!stagedNonNull.dbPath) {
        return res.status(400).json({ ok: false, error: "Backup is missing db/data.db" });
      }
      if (mode === "wipe") {
        if (stagedNonNull.manifest && stagedNonNull.manifest.schema_version && stagedNonNull.manifest.schema_version !== 1) {
          console.warn(`[BACKUP] schema version mismatch (backup=${stagedNonNull.manifest.schema_version} current=1); proceeding.`);
        }
        const { bak_dir } = importWipeReplace(stagedNonNull);
        return res.json({
          ok: true,
          mode,
          bak_dir,
          manifest: stagedNonNull.manifest,
          restart_required: true,
          duration_ms: Date.now() - started,
        });
      } else {
        const stats = importMerge(stagedNonNull);
        return res.json({
          ok: true,
          mode,
          ...stats,
          manifest: stagedNonNull.manifest,
          restart_required: false,
          duration_ms: Date.now() - started,
        });
      }
    } catch (err) {
      const msg = (err as Error).message || String(err);
      console.error("[BACKUP] import failed:", msg);
      return res.status(500).json({ ok: false, error: msg });
    } finally {
      if (staged) cleanupStaged(staged);
      try { if (req.file) unlinkSync(req.file.path); } catch { /* ignore */ }
    }
  });

  // GET/POST /api/backup/settings  -- read or update scheduled-backup config.
  //
  // v1.0.4: the settings response now includes the current on-disk size
  // that a fresh backup would archive (raw DB + rendered pages) plus an
  // estimated compressed size (raw * 1.02, so the caller shows a slight
  // upper bound rather than an under-count). The BackupPanel renders a
  // muted line under the retention row so the user can spot when their
  // library has grown into GB territory before a scheduled ZIP fires.
  app.get("/api/backup/settings", (_req, res) => {
    const s = readBackupSettings();
    let sizeExtras: {
      current_backup_size_bytes: number;
      current_backup_size_estimate_bytes: number;
    } = {
      current_backup_size_bytes: 0,
      current_backup_size_estimate_bytes: 0,
    };
    try {
      const raw = currentBackupRawSize();
      const total = raw.db_bytes + raw.pages_bytes;
      // The ZIP itself is smaller than raw, but we surface an ESTIMATED
      // final backup size that adds a tiny 2% margin so users see a
      // conservative upper bound of the disk space each ZIP will take.
      sizeExtras = {
        current_backup_size_bytes: total,
        current_backup_size_estimate_bytes: Math.ceil(total * 1.02),
      };
    } catch {
      // Never let a stat failure break the settings page; fall through
      // with zeros so the muted line just shows "unknown".
    }
    res.json({ ok: true, settings: { ...s, ...sizeExtras } });
  });
  app.post("/api/backup/settings", (req, res) => {
    try {
      const s = writeBackupSettings(req.body || {});
      res.json({ ok: true, settings: s });
    } catch (err) {
      res.status(400).json({ ok: false, error: String((err as Error).message || err) });
    }
  });

  // Kick the scheduler once routes are wired. Idempotent.
  startBackupScheduler();

  return httpServer;
}

function unique<T>(a: T[]): T[] {
  return Array.from(new Set(a));
}
function safeJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
function guessSourceSystem(uri: string): string {
  if (uri.startsWith("s3://")) return "s3";
  if (uri.includes("confluence")) return "confluence";
  if (uri.includes("sharepoint")) return "sharepoint";
  if (uri.includes("github.com")) return "github";
  if (uri.startsWith("http")) return "web";
  return "file";
}

function hydrateDocument(d: Document) {
  return {
    ...d,
    audience: safeJson<string[]>(d.audience_json, []),
    platform: safeJson<string[]>(d.platform_json, []),
    region: safeJson<string[]>(d.region_json, []),
    allowed_tenants: safeJson<string[]>(d.allowed_tenants_json, []),
    tags: safeJson<string[]>(d.tags_json, []),
    keywords: safeJson<string[]>(d.keywords_json, []),
  };
}
function hydrateChunk(c: Chunk) {
  return {
    ...c,
    section_path: safeJson<string[]>(c.section_path_json, []),
    audience: safeJson<string[]>(c.audience_json, []),
    allowed_tenants: safeJson<string[]>(c.allowed_tenants_json, []),
    error_codes: safeJson<string[]>(c.error_codes_json, []),
    cli_commands: safeJson<string[]>(c.cli_commands_json, []),
    ui_paths: safeJson<string[]>(c.ui_paths_json, []),
    tags: safeJson<string[]>(c.tags_json, []),
    // strip embedding vector from payload to save bandwidth by default
    embedding_json: undefined,
  };
}
