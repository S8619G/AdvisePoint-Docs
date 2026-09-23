import type { Express, Request } from "express";
import { pdfRoutes } from "./pdf-routes";
import { originalPdfAvailable } from "./originals";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { createHash } from "node:crypto";
import multer from "multer";
import { storage, isDbClosedForRestore, getDataDirForBackup, rawDb } from "./storage";
import { titleCaseLabel } from "@shared/doctype-case";
import {
  SEED_WELCOME_GUIDE_DOC_ID,
  SEED_WELCOME_GUIDE_MARKER_KEY,
  SEED_LOG_PREFIX,
  WELCOME_GUIDE_METADATA,
  findWelcomeGuidePdf,
  isWelcomeGuideSeeded,
  setWelcomeGuideMarker,
  readWelcomeGuideBytes,
  // v1.1.0: self-heal support for installs whose first-boot seed failed.
  getWelcomeGuideMarker,
  isFailedSeedMarker,
} from "./seed-welcome-guide";
// v1.1.0: Filename-code -> Document type mapping (item 9).
import {
  readFilenameCodeMapping,
  writeFilenameCodeMapping,
  validateFilenameCodeRow,
  seedDefaultDocTypesAndCodesIfNeeded,
  pruneDanglingFilenameCodes,
  FILENAME_CODES_LOG_PREFIX,
  type FilenameCodeRow,
} from "./filename-codes";
// v1.2.4: Filename PHRASES -> Document type mapping. Companion to filename
// codes, matched via word-boundary contains on a normalized filename after
// the code detector returns null. See server/filename-phrases.ts.
import {
  readFilenamePhraseMapping,
  writeFilenamePhraseMapping,
  validateFilenamePhraseRow,
  seedDefaultFilenamePhrasesIfNeeded,
  pruneDanglingFilenamePhrases,
  normalizePhrase,
  FILENAME_PHRASES_LOG_PREFIX,
  type FilenamePhraseRow,
} from "./filename-phrases";
// v1.1.9: Recent searches (Query tab side panel).
import {
  readQueryHistory,
  pushQueryHistoryEntry,
  clearQueryHistory,
  type QueryHistoryEntry,
} from "./query-history";
import { extractTextFromFile } from "./extract";
import {prepareCompatiblePdf} from "./pdf-compat";
import { deriveLocation } from "./locate";
import { scheduleRender, purgePagesForDoc, pageFilePath, getRenderQueueSnapshot, isSafeDocIdForPathUse, hasRenderedPageFiles, resolvePageImageOnDisk } from "./pages";
import { quarantineDocument } from "./quarantine";
import {
  listQuarantined,
  restoreQuarantined,
  permanentlyDeleteQuarantined,
  listSnapshots,
  permanentlyDeleteSnapshot,
  getAutoCleanupEnabled,
  setAutoCleanupEnabled,
  getAutoCleanupLastRunAt,
  runAutoCleanupOnce,
} from "./recovery";
import {
  saveOriginalIfRetainable,
  removeOriginal,
  originalExists,
  originalFilePath,
  originalSize,
  retainableExt,
  isRetainableExtension,
} from "./originals";
import {
  backupBeforeReplace,
  undoReplace,
  listTrashForDocument,
  sweepTrash,
  TRASH_TTL_SECONDS,
} from "./trash";
import { buildDocxSignature, compareSignatures, summarizeResult } from "./similarity";
import {
  startEditSession,
  pollEditStatus,
  endEditSession,
} from "./editInbox";
import { existsSync, createReadStream, statSync, readFileSync } from "node:fs";
import { spawn, execSync } from "node:child_process";
import { join, resolve, sep } from "node:path";
import { platform, release as osRelease, hostname, arch, freemem, totalmem } from "node:os";
import { buildZip } from "./zip";
import { bootState, readRecentLogLines } from "./boot";
import { detectInstallLocation } from "./install-location";
import { shutdownWatchdog } from "./shutdown-watchdog-holder";
import { APP_VERSION } from "../client/src/version";
import {
  writeBackupTo,
  writeBackupToFile,
  scheduledBackupFilename,
  stageImport,
  cleanupStaged,
  importWipeReplace,
  importMerge,
  currentBackupRawSize,
  translateBackupError,
  type BackupManifest,
} from "./backup";
import {
  readSettings as readBackupSettings,
  writeSettings as writeBackupSettings,
  startBackupScheduler,
  isBackupInFlight,
  withBackupLock,
} from "./backup-scheduler";
import {
  readQuickBackupLastOp,
  writeQuickBackupLastOp,
  readRestoreLastOp,
  writeRestoreLastOp,
} from "./backup-lastop";
import {
  writeRestoreSidefile,
  readAndClearRestoreSidefile,
  clearRestoreSidefile,
} from "./restore-sidefile";
import { appendBackupLog, appendBackupLogSessionStart, backupLogPath, BACKUP_LOG_NAME, BACKUP_LOG_ROTATED_NAME } from "./backup-log";
import {startUploadLog, trackUpload, uploadStage, UPLOAD_LOG_NAMES} from "./upload-log";
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
  startUploadLog(APP_VERSION);
  // -------- v0.9.26: Health check --------
  // Lightweight endpoint the client polls to detect a dead backend so it can
  // show a "please restart the app" overlay instead of a generic error.
  // Also touches storage.stats() so a broken database bubbles up as 500.
  app.get("/api/health", (req, res) => {
    // v1.0.12.3: after a replace-restore the database is deliberately closed
    // and the app must be restarted. Report that plainly instead of throwing
    // a 500 from a query against a closed handle.
    if (isDbClosedForRestore()) {
      return res.json({
        ok: true,
        app: "advisepoint-docs",
        version: APP_VERSION,
        documents: 0,
        chunks: 0,
        boot_phase: "restart_required",
        restart_required: true,
        message: "A restore completed. Restart AdvisePoint Docs to load the restored library.",
      });
    }
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
        // v1.0.5: cloud-sync / UNC install-location detection. The client's
        // InstallLocationBanner reads this to warn users that OneDrive et
        // al. can silently break uploads via DLP rules, file locks, and
        // online-only placeholders. Cached after the first call so this
        // adds no meaningful cost to the /api/health poll.
        install_location: detectInstallLocation(),
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

  // v1.1.7: minimal loopback-only busy probe. Used by the in-app upgrade
  // action before it launches the updater so the user can be warned that
  // renders would be abandoned by a restart. Deliberately narrower than
  // /api/render/status: no DB reads, no per-doc enrichment, no failures
  // list. Loopback restriction matches the rest of the updater surface --
  // this probe is not intended for browser use outside the app tab itself,
  // though the Origin check is relaxed because the request originates from
  // the app's own served HTML.
  app.get("/api/render/busy", (req, res) => {
    const remote = req.socket.remoteAddress ?? "";
    const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    if (!loopback) {
      return res.status(403).json({ message: "Loopback only." });
    }
    try {
      const snap = getRenderQueueSnapshot();
      const busy = snap.running || snap.queue_depth > 0;
      const in_flight = (snap.running ? 1 : 0) + snap.queue_depth;
      res.json({ busy, in_flight, queue_depth: snap.queue_depth, running: snap.running });
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
      // sockets immediately (Node >= 18.2), then close.
      //
      // v1.1.7: instrumentation + worker-thread hard-exit. The previous
      // unref'd setTimeout(process.exit, 2000) rode the main event loop and
      // could miss its tick if any synchronous cleanup blocked the loop,
      // extending real exit past the updater grace window (field-observed
      // 18.6 s exit riding a 20 s window). shutdownWatchdog is authoritative
      // -- it kills this process at t0 + 5 s from its own worker thread's
      // event loop regardless of what the main loop is doing. Timing logs
      // measure the shutdown path; we do NOT assert a specific culprit here
      // because the field evidence does not identify one uniquely.
      const t0 = Date.now();
      console.log(`[shutdown] t0=${t0} closeAllConnections beginning`);
      // Arm hard-exit BEFORE any potentially blocking cleanup. 5 s is well
      // inside the widened 45 s updater grace, so the updater is guaranteed
      // to see the port release inside its window.
      try {
        shutdownWatchdog.arm(5000, "api/updater/shutdown");
      } catch (err) {
        console.error("[shutdown] watchdog arm failed:", err);
      }
      try {
        (httpServer as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      } catch {
        // closeAllConnections is best-effort; ignore if unavailable.
      }
      const t1 = Date.now();
      console.log(`[shutdown] t1=${t1} sockets_dropped_ms=${t1 - t0}`);
      httpServer.close(() => {
        const t2 = Date.now();
        console.log(
          `[shutdown] t2=${t2} http_closed_ms=${t2 - t0} calling process.exit(0)`,
        );
        process.exit(0);
      });
      // If the main loop is blocked and neither t2 nor any subsequent line
      // is emitted before the 5 s ceiling, shutdown-watchdog prints its own
      // [shutdown-watchdog] line via fs.writeSync from the worker thread
      // right before it forces exit. That marker is the visible signal that
      // the safety net fired.
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
      clearUpdaterStatus();
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

  // v1.0.9: `.updating` sentinel diagnostic. The v1.0.8.3 hotfix taught the
  // launcher and updater to share a `.updating` file in %LOCALAPPDATA%\
  // AdvisePoint Docs\ so the launcher can recognize a coordinated shutdown
  // and suppress the crash popup. `updater.cjs` writes the sentinel before
  // requesting shutdown and clears it after relaunch on both success and
  // error paths. If updater.cjs is killed mid-flight (user closes the terminal,
  // laptop sleeps, antivirus quarantines the zip), the sentinel is stranded
  // on disk. The launcher self-heals after 24h via `forfiles /d -1`, but the
  // user has no visibility that an update attempt was abandoned.
  //
  // This endpoint surfaces that state to the Settings > Update panel. Returns
  // `stale=true` when a sentinel is present AND older than 5 minutes AND
  // newer than 24 hours (matches the launcher's self-heal window). The 5-minute
  // floor prevents flashing during a normal update where the browser reloads
  // faster than the updater relaunches the app. DELETE clears the sentinel
  // when the user dismisses the notice.
  //
  // Loopback-only; matches the posture of the other updater endpoints.
  const updateSentinelPath = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "AdvisePoint Docs", ".updating")
    : null;
  const SENTINEL_FLOOR_MS = 5 * 60 * 1000; // 5 min
  const SENTINEL_CEILING_MS = 24 * 60 * 60 * 1000; // 24 h

  const updaterStatusPath = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "AdvisePoint Docs", "update-status.json")
    : null;
  function clearUpdaterStatus() {
    if (updaterStatusPath && existsSync(updaterStatusPath)) unlinkSync(updaterStatusPath);
  }
  app.get("/api/updater/status", (req, res) => {
    const remote = req.socket.remoteAddress ?? "";
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) return res.sendStatus(403);
    res.setHeader("Cache-Control", "no-store");
    try {
      if (!updaterStatusPath || !existsSync(updaterStatusPath)) return res.json({ phase: "idle" });
      const data = JSON.parse(readFileSync(updaterStatusPath, "utf8"));
      return res.json({
        phase: ["preparing", "installing", "complete", "failed"].includes(data.phase) ? data.phase : "idle",
        message: typeof data.message === "string" ? data.message.slice(0, 1500) : "",
        startedAt: Number(data.startedAt) || 0,
        updatedAt: Number(data.updatedAt) || 0,
      });
    } catch {
      return res.json({ phase: "idle" });
    }
  });

  function readSentinelStatus(): {
    present: boolean;
    stale: boolean;
    age_ms: number | null;
    path: string | null;
    log_path: string | null;
  } {
    if (!updateSentinelPath || process.platform !== "win32") {
      return { present: false, stale: false, age_ms: null, path: null, log_path: null };
    }
    if (!existsSync(updateSentinelPath)) {
      return { present: false, stale: false, age_ms: null, path: updateSentinelPath, log_path: null };
    }
    let ageMs: number | null = null;
    try {
      const st = statSync(updateSentinelPath);
      ageMs = Date.now() - st.mtimeMs;
    } catch {
      // Sentinel disappeared between existsSync and statSync (raced with
      // updater.cjs's clearUpdateSentinel). Report absent.
      return { present: false, stale: false, age_ms: null, path: updateSentinelPath, log_path: null };
    }
    const stale = ageMs > SENTINEL_FLOOR_MS && ageMs < SENTINEL_CEILING_MS;
    const logPath = process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "AdvisePoint Docs", "update.log")
      : null;
    return { present: true, stale, age_ms: ageMs, path: updateSentinelPath, log_path: logPath };
  }

  app.get("/api/updater/last-attempt", (req, res) => {
    const remote = req.socket.remoteAddress ?? "";
    const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    if (!loopback) return res.status(403).json({ message: "Loopback only." });
    return res.json(readSentinelStatus());
  });

  app.delete("/api/updater/last-attempt", (req, res) => {
    const remote = req.socket.remoteAddress ?? "";
    const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    if (!loopback) return res.status(403).json({ message: "Loopback only." });
    if (!updateSentinelPath || process.platform !== "win32") {
      return res.json({ ok: true, cleared: false, reason: "not-windows" });
    }
    if (!existsSync(updateSentinelPath)) {
      return res.json({ ok: true, cleared: false, reason: "absent" });
    }
    try {
      unlinkSync(updateSentinelPath);
      return res.json({ ok: true, cleared: true });
    } catch (err) {
      return res.status(500).json({ ok: false, cleared: false, error: String(err) });
    }
  });

  // v1.0.9: drop-a-zip target. Accepts a manually-downloaded release zip via
  // multipart upload and validates it, then hands the on-disk path back to
  // the client. On confirm, the client POSTs to /api/updater/launch-local
  // which spawns the existing updater .bat with an APD_LOCAL_ZIP env var.
  //
  // Validation:
  //   1. Multer cap = 150 MB, .zip extension only.
  //   2. Magic-bytes check: buffer must start with PK\x03\x04.
  //   3. Zip must contain an "AdvisePoint Docs/" top-level folder.
  //   4. "AdvisePoint Docs/VERSION" must parse as a valid version.
  //   5. "AdvisePoint Docs/dist/index.cjs" must exist (proves this really
  //      is an AdvisePoint Docs release, not an arbitrary zip).
  //   6. Version must NOT be older than installed (client shows a
  //      confirm-to-force UI on an older zip — we return details so it can).
  const uploadZip = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 150 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) => {
      const nameLower = (file.originalname || "").toLowerCase();
      if (!nameLower.endsWith(".zip")) return cb(null, false);
      cb(null, true);
    },
  });

  // Lightweight zip inspector: walks a buffer's End-of-Central-Directory
  // to enumerate entry names without extracting. This is enough to validate
  // the release layout (VERSION + dist/index.cjs) before we hand the file
  // off to updater.cjs, which does its own full extract.
  function inspectZipEntries(buffer: Buffer): string[] | null {
    // Minimum EOCD size = 22 bytes
    if (buffer.length < 22) return null;
    // Scan back from end for EOCD signature 0x06054b50
    let eocdOffset = -1;
    for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65558); i--) {
      if (buffer.readUInt32LE(i) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset < 0) return null;
    const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
    const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
    if (cdOffset >= buffer.length) return null;
    const names: string[] = [];
    let p = cdOffset;
    for (let i = 0; i < totalEntries; i++) {
      if (p + 46 > buffer.length) return null;
      if (buffer.readUInt32LE(p) !== 0x02014b50) return null;
      const nameLen = buffer.readUInt16LE(p + 28);
      const extraLen = buffer.readUInt16LE(p + 30);
      const commentLen = buffer.readUInt16LE(p + 32);
      const name = buffer.subarray(p + 46, p + 46 + nameLen).toString("utf8");
      names.push(name);
      p += 46 + nameLen + extraLen + commentLen;
    }
    return names;
  }

  // Read a specific entry's uncompressed bytes from the zip. Used to inspect
  // the VERSION file. Handles STORE (method 0) only; VERSION is 5-6 bytes so
  // we don't need DEFLATE support for it. Returns null if the entry isn't
  // stored, is too big to be a version string, or can't be located.
  function readStoredEntry(buffer: Buffer, entryName: string, maxBytes = 64): Buffer | null {
    const eocdIdxStart = Math.max(0, buffer.length - 65558);
    let eocdOffset = -1;
    for (let i = buffer.length - 22; i >= eocdIdxStart; i--) {
      if (buffer.readUInt32LE(i) === 0x06054b50) { eocdOffset = i; break; }
    }
    if (eocdOffset < 0) return null;
    const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
    let p = buffer.readUInt32LE(eocdOffset + 16);
    for (let i = 0; i < totalEntries; i++) {
      if (p + 46 > buffer.length) return null;
      const nameLen = buffer.readUInt16LE(p + 28);
      const extraLen = buffer.readUInt16LE(p + 30);
      const commentLen = buffer.readUInt16LE(p + 32);
      const method = buffer.readUInt16LE(p + 10);
      const compressedSize = buffer.readUInt32LE(p + 20);
      const uncompressedSize = buffer.readUInt32LE(p + 24);
      const localHeaderOffset = buffer.readUInt32LE(p + 42);
      const name = buffer.subarray(p + 46, p + 46 + nameLen).toString("utf8");
      if (name === entryName) {
        if (method !== 0) return null; // not stored
        if (uncompressedSize > maxBytes) return null;
        if (localHeaderOffset + 30 > buffer.length) return null;
        const lhNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
        const lhExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
        const dataStart = localHeaderOffset + 30 + lhNameLen + lhExtraLen;
        if (dataStart + compressedSize > buffer.length) return null;
        return buffer.subarray(dataStart, dataStart + compressedSize);
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return null;
  }

  function parseVersionString(s: string): [number, number, number, number] | null {
    // Accepts "1.0.9" or "1.0.9.3" style. Returns 4-tuple; missing parts default to 0.
    const parts = s.trim().split(".").map((x) => Number(x));
    if (parts.length < 3 || parts.length > 4) return null;
    if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
    return [parts[0], parts[1], parts[2], parts[3] ?? 0];
  }

  function cmpVersion4(a: [number, number, number, number], b: [number, number, number, number]): number {
    for (let i = 0; i < 4; i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return 0;
  }

  app.post("/api/update/upload-zip", (req, res, next) => {
    const remote = req.socket.remoteAddress ?? "";
    const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    if (!loopback) return res.status(403).json({ message: "Loopback only." });
    // Origin check: only allow same-origin browser requests.
    const origin = req.get("origin");
    if (origin) {
      try {
        const originHost = new URL(origin).host;
        if (originHost !== req.get("host")) {
          return res.status(403).json({ message: "Cross-origin upload is not permitted." });
        }
      } catch {
        return res.status(400).json({ message: "Malformed Origin header." });
      }
    }
    uploadZip.single("file")(req, res, (err) => {
      if (err) {
        return res.status(400).json({ message: "Upload failed.", error: String(err) });
      }
      const file = (req as unknown as { file?: Express.Multer.File }).file;
      if (!file) {
        return res.status(400).json({ message: "No file received. Attach the zip as `file`." });
      }
      const buf = file.buffer;
      // Magic-bytes: PK\x03\x04
      if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04) {
        return res.status(400).json({
          message: "That doesn't look like a zip archive. The file must be an unmodified AdvisePoint Docs release zip.",
          reason: "bad_magic",
        });
      }
      const entries = inspectZipEntries(buf);
      if (!entries) {
        return res.status(400).json({
          message: "Could not read the zip's central directory. The file may be truncated or corrupt.",
          reason: "bad_central_directory",
        });
      }
      // Layout checks
      const hasAppFolder = entries.some((n) => n.startsWith("AdvisePoint Docs/"));
      const hasVersion = entries.includes("AdvisePoint Docs/VERSION");
      const hasDistCjs = entries.includes("AdvisePoint Docs/dist/index.cjs");
      if (!hasAppFolder || !hasVersion || !hasDistCjs) {
        return res.status(400).json({
          message: "This zip is missing AdvisePoint Docs's expected layout. Confirm you downloaded AdvisePoint-Docs-vX.Y.Z.zip and not a source zip.",
          reason: "bad_layout",
          missing: {
            app_folder: !hasAppFolder,
            version_file: !hasVersion,
            dist_index_cjs: !hasDistCjs,
          },
        });
      }
      const versionBuf = readStoredEntry(buf, "AdvisePoint Docs/VERSION");
      if (!versionBuf) {
        return res.status(400).json({
          message: "Could not read the VERSION file inside the zip.",
          reason: "unreadable_version",
        });
      }
      const incomingVersionStr = versionBuf.toString("utf8").trim();
      const incomingParsed = parseVersionString(incomingVersionStr);
      if (!incomingParsed) {
        return res.status(400).json({
          message: `The zip's VERSION file has an unexpected value: "${incomingVersionStr}".`,
          reason: "bad_version",
        });
      }
      const installedParsed = parseVersionString(APP_VERSION);
      const cmp = installedParsed ? cmpVersion4(incomingParsed, installedParsed) : 1;
      const isDowngrade = cmp < 0;
      const isSameVersion = cmp === 0;
      // Write the buffer to a temp file we hand to updater.cjs later.
      try {
        const fs = require("node:fs") as typeof import("node:fs");
        const os = require("node:os") as typeof import("node:os");
        const path = require("node:path") as typeof import("node:path");
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "apd-local-zip-"));
        const tempPath = path.join(tmpDir, `AdvisePoint-Docs-v${incomingVersionStr}.zip`);
        fs.writeFileSync(tempPath, buf);
        return res.json({
          ok: true,
          temp_path: tempPath,
          version: incomingVersionStr,
          installed_version: APP_VERSION,
          is_downgrade: isDowngrade,
          is_same_version: isSameVersion,
          size: buf.length,
        });
      } catch (writeErr) {
        return res.status(500).json({
          message: "Could not stage the zip for the updater.",
          reason: "stage_failed",
          error: String(writeErr),
        });
      }
    });
  });

  // v1.0.9: launch the external updater against a locally-staged zip that was
  // just accepted by /api/update/upload-zip. Same posture as /api/updater/launch:
  // loopback + same-origin + Windows-only. The only differences are:
  //   - We refuse the launch if `temp_path` didn't come from our own staging
  //     directory (defense against a malicious page tricking us into pointing
  //     the updater at an arbitrary file on disk).
  //   - We pass APD_LOCAL_ZIP=<temp_path> in the child env; the .bat forwards
  //     it as --local-zip to updater.cjs.
  app.post("/api/updater/launch-local", (req, res) => {
    const remote = req.socket.remoteAddress ?? "";
    const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    if (!loopback) return res.status(403).json({ message: "Loopback only." });
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
      return res.status(501).json({ message: "The in-app updater is Windows-only." });
    }
    const body = (req.body ?? {}) as { temp_path?: unknown };
    const tempPath = typeof body.temp_path === "string" ? body.temp_path : "";
    if (!tempPath) {
      return res.status(400).json({ message: "Missing `temp_path`. Upload a zip first via /api/update/upload-zip." });
    }
    // Restrict to our staging prefix. tmpdir + apd-local-zip- prefix mirrors
    // fs.mkdtempSync(join(os.tmpdir(), 'apd-local-zip-')).
    const os = require("node:os") as typeof import("node:os");
    const path = require("node:path") as typeof import("node:path");
    const stagingPrefix = path.join(os.tmpdir(), "apd-local-zip-");
    if (!tempPath.startsWith(stagingPrefix)) {
      return res.status(400).json({ message: "That path is not in the update-staging directory." });
    }
    if (!existsSync(tempPath)) {
      return res.status(404).json({ message: "The staged zip is no longer on disk. Upload it again." });
    }
    const launcherPath = resolve(process.cwd(), "Update AdvisePoint Docs.bat");
    if (!existsSync(launcherPath)) {
      return res.status(404).json({
        message: "The updater launcher was not found. This build may have been extracted incorrectly.",
        looked_at: launcherPath,
      });
    }
    try {
      clearUpdaterStatus();
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
          APD_LOCAL_ZIP: tempPath,
        },
      });
      child.unref();
      return res.json({ ok: true, launched_at: new Date().toISOString(), launcher: launcherPath });
    } catch (err) {
      return res.status(500).json({ message: "Could not launch the updater.", error: String(err) });
    }
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
    // v1.1.4: normalize casing so a hand-typed "technical bulletin" is stored
    // as "Technical Bulletin". Acronyms and deliberate mixed case survive --
    // see shared/doctype-case.ts.
    const label = titleCaseLabel(typeof req.body?.label === "string" ? req.body.label : "");
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

  // -------- v1.1.3: product model / family values + bulk rename/merge --------
  //
  // These are NOT a registry. product_model and product_family are free-text
  // columns on documents, so this endpoint reports the DISTINCT values with
  // usage counts, and a rename is a bulk UPDATE rather than a row edit.
  //
  // Renaming onto an existing value is a MERGE and is allowed on purpose --
  // it is how near-duplicates ("PA6000x" vs "PA6000x Series") get cleaned up.
  app.get("/api/product-values", (_req, res) => {
    try {
      return res.json(storage.listProductValues());
    } catch (error) {
      return res.status(500).json({ message: (error as Error).message });
    }
  });

  app.post("/api/product-values/rename", (req, res) => {
    const field = req.body?.field;
    if (field !== "product_model" && field !== "product_family") {
      return res.status(400).json({ message: "field must be product_model or product_family." });
    }
    const from = typeof req.body?.from === "string" ? req.body.from.trim() : "";
    // An empty `to` is legitimate: product_model is optional as of v1.1.3, so
    // clearing a value is a supported outcome. Only `from` must be present.
    const to = typeof req.body?.to === "string" ? req.body.to.trim() : "";
    if (!from) {
      return res.status(400).json({ message: "Select a value to rename." });
    }
    if (to.length > 200) {
      return res.status(400).json({ message: "Enter a value of 200 characters or fewer." });
    }
    if (from === to) {
      return res.status(400).json({ message: "The new value is the same as the current one." });
    }
    try {
      const affected =
        field === "product_model"
          ? storage.renameProductModel(from, to)
          : storage.renameProductFamily(from, to);
      return res.json({ field, from, to, affected, values: storage.listProductValues() });
    } catch (error) {
      return res.status(400).json({ message: (error as Error).message });
    }
  });

  app.patch("/api/document-types/:key", (req, res) => {
    const label = titleCaseLabel(typeof req.body?.label === "string" ? req.body.label : "");
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

  // v1.1.4: merge one document type into another.
  //
  // Distinct from DELETE, which reassigns to the 'document' fallback and so
  // loses the tag. This re-points the documents at a type the caller picks.
  // Body: { into: "<target key>" }
  app.post("/api/document-types/:key/merge", (req, res) => {
    const into = typeof req.body?.into === "string" ? req.body.into.trim() : "";
    if (!into) {
      return res.status(400).json({ message: "Choose a document type to merge into." });
    }
    try {
      const affected = storage.mergeDocumentType(req.params.key, into);
      return res.json({ ...storage.listDocumentTypes(), affected });
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

  // -------- v1.1.0: Filename-code -> Document type mapping (item 9) --------
  //
  // The map is a single JSON row in app_settings, swapped atomically on PUT.
  // Reads return the current mapping AND the list of known Document type
  // keys, so the editor can flag orphans (a mapping row whose doc_type_key
  // no longer resolves) without a second round-trip.
  app.get("/api/settings/filename-codes", (_req, res) => {
    const mappings = readFilenameCodeMapping(rawDb);
    const knownKeys = storage.listDocumentTypes().types.map((t) => t.key);
    res.json({ mappings, known_doc_type_keys: knownKeys });
  });

  app.put("/api/settings/filename-codes", (req, res) => {
    const body = req.body;
    if (!body || !Array.isArray(body.mappings)) {
      return res.status(400).json({ message: "Body must be { mappings: [...] }." });
    }
    const cleaned: FilenameCodeRow[] = [];
    const seenCodes = new Set<string>();
    for (let i = 0; i < body.mappings.length; i++) {
      const row = validateFilenameCodeRow(body.mappings[i]);
      if (typeof row === "string") {
        return res.status(400).json({ message: `Row ${i + 1}: ${row}` });
      }
      if (seenCodes.has(row.code)) {
        return res.status(400).json({ message: `Duplicate code: ${row.code}` });
      }
      seenCodes.add(row.code);
      cleaned.push(row);
    }
    try {
      writeFilenameCodeMapping(rawDb, cleaned);
      const knownKeys = storage.listDocumentTypes().types.map((t) => t.key);
      return res.json({ mappings: readFilenameCodeMapping(rawDb), known_doc_type_keys: knownKeys });
    } catch (err) {
      return res.status(500).json({ message: (err as Error).message || "Failed to save mapping." });
    }
  });

  // -------- v1.2.4: Filename-PHRASE -> Document type mapping --------
  //
  // Same storage pattern as filename codes: JSON blob in app_settings,
  // atomic swap on PUT. Reads return the current mapping AND the list of
  // known Document type keys so the editor can flag orphans without a
  // second round-trip.
  app.get("/api/settings/filename-phrases", (_req, res) => {
    const mappings = readFilenamePhraseMapping(rawDb);
    const knownKeys = storage.listDocumentTypes().types.map((t) => t.key);
    res.json({ mappings, known_doc_type_keys: knownKeys });
  });

  app.put("/api/settings/filename-phrases", (req, res) => {
    const body = req.body;
    if (!body || !Array.isArray(body.mappings)) {
      return res.status(400).json({ message: "Body must be { mappings: [...] }." });
    }
    const cleaned: FilenamePhraseRow[] = [];
    // Duplicate check runs on the NORMALIZED form so "User Guide" and
    // "user guide" collide, matching how the detector treats them at match
    // time. This mirrors the codes editor's uppercase-normalized dupe check.
    const seenNormalized = new Set<string>();
    for (let i = 0; i < body.mappings.length; i++) {
      const row = validateFilenamePhraseRow(body.mappings[i]);
      if (typeof row === "string") {
        return res.status(400).json({ message: `Row ${i + 1}: ${row}` });
      }
      const key = normalizePhrase(row.phrase);
      if (seenNormalized.has(key)) {
        return res.status(400).json({ message: `Duplicate phrase: ${row.phrase}` });
      }
      seenNormalized.add(key);
      cleaned.push(row);
    }
    try {
      writeFilenamePhraseMapping(rawDb, cleaned);
      const knownKeys = storage.listDocumentTypes().types.map((t) => t.key);
      return res.json({
        mappings: readFilenamePhraseMapping(rawDb),
        known_doc_type_keys: knownKeys,
      });
    } catch (err) {
      return res.status(500).json({
        message: (err as Error).message || "Failed to save phrase mapping.",
      });
    }
  });

  // -------- v1.1.9: Query tab recent searches --------
  //
  // GET   -> newest-first list of up to 5 entries.
  // POST  -> body is one entry; dedupe (bump ranAt) if it matches the
  //          latest same-payload row, otherwise prepend and truncate.
  // DELETE-> wipe the history entirely (Clear button).
  //
  // Payload shape is validated defensively -- unknown filters and
  // matchModes are coerced by the server, blank q strings are
  // silently ignored so we never persist an empty row.
  app.get("/api/query-history", (_req, res) => {
    try {
      return res.json({ history: readQueryHistory(rawDb) });
    } catch (err) {
      return res.status(500).json({ message: (err as Error).message || "Failed to read query history." });
    }
  });

  app.post("/api/query-history", (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object") {
      return res.status(400).json({ message: "Body must be a query history entry." });
    }
    // Ignore any client-supplied ranAt -- the server timestamps every
    // push itself so a mis-clocked client can't reorder history.
    const entry = { ...(body as QueryHistoryEntry), ranAt: Date.now() };
    try {
      const history = pushQueryHistoryEntry(rawDb, entry);
      return res.json({ history });
    } catch (err) {
      return res.status(500).json({ message: (err as Error).message || "Failed to save query history." });
    }
  });

  app.delete("/api/query-history", (_req, res) => {
    try {
      clearQueryHistory(rawDb);
      return res.json({ history: [] });
    } catch (err) {
      return res.status(500).json({ message: (err as Error).message || "Failed to clear query history." });
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

  // -------- v1.0.11.4: Duplicate documents scan + purge --------
  //
  // Two documents are considered duplicates when they share the same
  // file_name (case-insensitive stem+ext) AND the same byte size
  // (read from the retained original on disk). This catches the
  // artefact of the broken merge in v1.0.11.3-and-earlier, which
  // duplicated every row when a backup was merged onto its own live
  // database. It does NOT do content-hash dedupe; two files that
  // legitimately share a filename but differ in bytes remain
  // distinct.
  //
  // The GET returns groups so the client can preview; the POST
  // performs the delete, keeping the OLDEST row (by ingested_at,
  // tie-broken by id ascending) in each group and purging the rest.
  //
  // Registered BEFORE /api/documents/:id so Express doesn't route
  // "duplicates" as an id.
  interface DupMember {
    id: string;
    title: string;
    ingested_at: string;
    has_pages: boolean;
    has_original: boolean;
    chunks: number;
    viewable: boolean;
  }
  interface DupGroup {
    group_key: string;
    file_name: string;
    size_bytes: number;
    size_source: "bytes";
    keep: string;
    delete: string[];
    safe_to_delete: boolean;
    blocked_reason: string | null;
    docs: DupMember[];
  }

  // v1.0.12.3 -- duplicate detection rewritten for safety.
  //
  // The previous rule grouped by filename plus a "content fingerprint" of
  // total_chunks x total_tokens whenever no retained original existed on
  // disk (i.e. for every PDF). That is a heuristic, not proof: two genuinely
  // different documents that happen to share a filename and produce the same
  // chunk and token counts would be grouped, and the newer one deleted. It
  // then kept the OLDEST row regardless of which copy actually had rendered
  // page images -- so deleting the "duplicate" could destroy the only
  // viewable copy and leave behind a row that can never be displayed, since
  // PDF source bytes are not retained.
  //
  // Identity is now proven or the documents are left alone:
  //   * Grouping requires an identical file_hash_sha256 (64 hex chars),
  //     recorded at ingest from the uploaded bytes.
  //   * Where a retained original exists on disk its hash is RECOMPUTED and
  //     must match the stored hash, so a stale row cannot vouch for itself.
  //   * Documents with no hash are reported as unverifiable and are never
  //     grouped or deleted.
  //
  // The kept copy is the most complete one, not the oldest: rendered pages
  // first, then a retained original, then chunk count, then ingest date. A
  // group whose keeper is not viewable is reported with safe_to_delete=false
  // and the delete endpoint refuses it.
  function scanDuplicateGroups(): {
    groups: DupGroup[];
    total_duplicates: number;
    unverifiable: number;
  } {
    const docs = storage.listDocuments() as any[];
    const buckets = new Map<string, Array<{ doc: any; size: number }>>();
    let unverifiable = 0;

    for (const d of docs) {
      const id = typeof d.id === "string" ? d.id : "";
      if (!isSafeDocIdForPathUse(id)) { unverifiable += 1; continue; }

      const storedHash = typeof d.file_hash_sha256 === "string" ? d.file_hash_sha256.trim().toLowerCase() : "";
      if (!/^[a-f0-9]{64}$/.test(storedHash)) { unverifiable += 1; continue; }

      // Size is display-only; it never contributes to identity.
      let size = 0;
      const ext = typeof d.original_ext === "string" ? d.original_ext.toLowerCase().replace(/^\./, "") : "";
      if (ext) {
        try {
          const p = originalFilePath(id, ext);
          size = statSync(p).size;
          // The bytes are here, so verify the row's hash still describes them.
          const diskHash = createHash("sha256").update(readFileSync(p)).digest("hex");
          if (diskHash !== storedHash) {
            // Row and file disagree. Refuse to use this row for identity.
            unverifiable += 1;
            continue;
          }
        } catch { /* not retained or unreadable; stored hash stands */ }
      }

      const key = `sha256:${storedHash}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push({ doc: d, size });
    }

    const groups: DupGroup[] = [];
    let total = 0;

    for (const [groupKey, members] of buckets) {
      if (members.length < 2) continue;

      const scored: DupMember[] = members.map((m) => {
        const id = String(m.doc.id);
        // Real files on disk, not page rows: rows outlive missing images.
        let hasPages = false;
        try { hasPages = hasRenderedPageFiles(id); } catch { hasPages = false; }
        let hasOriginal = false;
        const ext = typeof m.doc.original_ext === "string" ? m.doc.original_ext : "";
        if (ext) { try { hasOriginal = originalExists(id, ext); } catch { hasOriginal = false; } }
        return {
          id,
          title: String(m.doc.title ?? ""),
          ingested_at: String(m.doc.ingested_at ?? ""),
          has_pages: hasPages,
          has_original: hasOriginal,
          chunks: Number(m.doc.total_chunks ?? 0),
          // Viewable means the content can still be displayed after the
          // others are gone: rendered pages, or an original we can re-render.
          viewable: hasPages || hasOriginal,
        };
      });

      // Best copy first: viewable, then pages, then original, then chunks,
      // then oldest, then id for a stable order.
      const ranked = [...scored].sort((a, b) => {
        if (a.viewable !== b.viewable) return a.viewable ? -1 : 1;
        if (a.has_pages !== b.has_pages) return a.has_pages ? -1 : 1;
        if (a.has_original !== b.has_original) return a.has_original ? -1 : 1;
        if (a.chunks !== b.chunks) return b.chunks - a.chunks;
        if (a.ingested_at !== b.ingested_at) return a.ingested_at < b.ingested_at ? -1 : 1;
        return a.id < b.id ? -1 : 1;
      });

      const keeper = ranked[0];
      const del = ranked.slice(1).map((m) => m.id);
      const safe = keeper.viewable;
      if (safe) total += del.length;

      groups.push({
        // Stable identifier for the group (the shared content hash). Lets the
        // client name a specific group when a person has reviewed it by hand.
        group_key: groupKey,
        file_name: String(members[0].doc.file_name ?? ""),
        size_bytes: members[0].size,
        size_source: "bytes",
        keep: keeper.id,
        delete: del,
        safe_to_delete: safe,
        blocked_reason: safe
          ? null
          : "No copy in this group has rendered pages or a retained original, so removing any of them could leave nothing viewable.",
        docs: scored,
      });
    }

    groups.sort((a, b) => b.docs.length - a.docs.length);
    return { groups, total_duplicates: total, unverifiable };
  }

  app.get("/api/documents/duplicates", (_req, res) => {
    try {
      const scan = scanDuplicateGroups();
      res.json({ ok: true, ...scan });
    } catch (err) {
      console.error("[dupes] scan failed:", err);
      res.status(500).json({ ok: false, error: "Duplicate scan failed" });
    }
  });

  // v1.0.12.3 -- duplicate removal is now non-destructive and server-decided.
  //
  // Previously this endpoint deleted whatever ids the client posted, checking
  // only that each was a string. An empty string passed that check and then
  // resolved to the pages ROOT, whose recursive delete would destroy every
  // page image in the library. The request body is no longer trusted for
  // anything but narrowing: the server rescans, and an id that is not listed
  // for deletion in a group it considers safe is refused.
  //
  // Removal moves the document into quarantine instead of deleting it, and
  // each group's keeper is re-verified as viewable immediately before its
  // duplicates are touched.
  app.post("/api/documents/duplicates/delete", (req, res) => {
    try {
      const scan = scanDuplicateGroups();
      const safeGroups = scan.groups.filter((g) => g.safe_to_delete);

      // Map every deletable id to its group's keeper.
      const allowed = new Map<string, string>();
      for (const g of safeGroups) for (const id of g.delete) allowed.set(id, g.keep);

      const bodyIds = Array.isArray((req.body as any)?.ids) ? (req.body as any).ids : null;
      let requested: string[];
      if (bodyIds) {
        requested = bodyIds.filter((v: unknown): v is string => typeof v === "string" && v.trim() !== "");
      } else {
        requested = [...allowed.keys()];
      }

      const refused: Array<{ id: string; reason: string }> = [];
      const targets: string[] = [];
      for (const id of requested) {
        if (!isSafeDocIdForPathUse(id)) {
          refused.push({ id, reason: "unsafe id" });
        } else if (!allowed.has(id)) {
          refused.push({ id, reason: "not a verified duplicate" });
        } else {
          targets.push(id);
        }
      }

      // v1.0.12.3 -- human-verified override.
      //
      // Some groups cannot be proven safe automatically: no copy has rendered
      // pages or a retained original, so the app cannot tell which one is
      // intact. Rather than deleting on a guess, those groups are refused
      // above and can only be acted on when a person has inspected them and
      // names the copy to keep. Even then the removal is a quarantine move,
      // so an incorrect human decision is still reversible.
      const manualRaw = Array.isArray((req.body as any)?.manual_review)
        ? (req.body as any).manual_review
        : [];
      const manualTargets = new Map<string, string>(); // id -> keeper
      const manualRefused: Array<{ id: string; reason: string }> = [];
      for (const entry of manualRaw) {
        const groupKey = typeof entry?.group_key === "string" ? entry.group_key : "";
        const keep = typeof entry?.keep === "string" ? entry.keep : "";
        const remove = Array.isArray(entry?.remove) ? entry.remove : [];
        const confirmed = entry?.confirmed === true;
        const group = scan.groups.find((g) => g.group_key === groupKey);
        if (!group) {
          manualRefused.push({ id: groupKey || "(no group)", reason: "group no longer exists; rescan" });
          continue;
        }
        if (!confirmed) {
          manualRefused.push({ id: groupKey, reason: "not confirmed by a person" });
          continue;
        }
        const members = new Set(group.docs.map((d) => d.id));
        if (!isSafeDocIdForPathUse(keep) || !members.has(keep) || !storage.getDocument(keep)) {
          manualRefused.push({ id: keep || "(no keeper)", reason: "chosen kept copy is not in this group" });
          continue;
        }
        for (const raw of remove) {
          const id = typeof raw === "string" ? raw : "";
          if (!isSafeDocIdForPathUse(id)) {
            manualRefused.push({ id: String(raw), reason: "unsafe id" });
          } else if (!members.has(id)) {
            manualRefused.push({ id, reason: "not in the reviewed group" });
          } else if (id === keep) {
            manualRefused.push({ id, reason: "cannot remove the copy chosen to keep" });
          } else if (allowed.has(id) || manualTargets.has(id)) {
            manualRefused.push({ id, reason: "already queued for removal" });
          } else {
            manualTargets.set(id, keep);
          }
        }
      }
      refused.push(...manualRefused);

      const blocked = scan.groups.filter(
        (g) => !g.safe_to_delete && !manualRaw.some((m: any) => m?.group_key === g.group_key),
      ).length;
      let deleted = 0;
      const failed: string[] = [];
      const quarantined: string[] = [];

      const work: Array<{ id: string; keeperId: string; humanReviewed: boolean }> = [
        ...targets.map((id) => ({ id, keeperId: allowed.get(id)!, humanReviewed: false })),
        ...[...manualTargets.entries()].map(([id, keeperId]) => ({ id, keeperId, humanReviewed: true })),
      ];

      for (const { id, keeperId, humanReviewed } of work) {
        try {
          // Re-verify the keeper right now. An earlier removal in this same
          // loop, or anything else touching the library, could have changed
          // its state since the scan.
          const keeper = storage.getDocument(keeperId) as any;
          if (!keeper) {
            refused.push({ id, reason: "kept copy no longer exists" });
            continue;
          }
          let keeperOk = false;
          try { keeperOk = hasRenderedPageFiles(keeperId); } catch { keeperOk = false; }
          if (!keeperOk) {
            const kext = typeof keeper.original_ext === "string" ? keeper.original_ext : "";
            if (kext) { try { keeperOk = originalExists(keeperId, kext); } catch { keeperOk = false; } }
          }
          // The automatic path demands a viewable keeper. The reviewed path
          // cannot -- an unviewable keeper is exactly why it was blocked --
          // so it relies on the person's inspection plus quarantine.
          if (!keeperOk && !humanReviewed) {
            refused.push({ id, reason: "kept copy is not viewable" });
            continue;
          }

          const result = quarantineDocument(
            id,
            humanReviewed
              ? `duplicate of ${keeperId} (kept copy chosen by the user after manual review)`
              : `duplicate of ${keeperId}`,
          );
          quarantined.push(result.dir);
          appendBackupLog(
            `[DUPES] quarantined ${id} (duplicate of ${keeperId}${humanReviewed ? ", user-reviewed" : ""}); ` +
            `pages_moved=${result.moved_pages} original_moved=${result.moved_original} ` +
            `chunks=${result.chunk_count} -> ${result.dir}`,
          );
          deleted += 1;
        } catch (err) {
          console.error(`[dupes] quarantine failed for ${id}:`, err);
          appendBackupLog(`[DUPES] FAILED to quarantine ${id}: ${(err as Error).message || String(err)}`);
          failed.push(id);
        }
      }

      if (deleted > 0 || refused.length > 0) {
        appendBackupLog(
          `[DUPES] removal finished: removed=${deleted} refused=${refused.length} ` +
          `failed=${failed.length} blocked_groups=${blocked}`,
        );
      }

      res.json({
        ok: true,
        deleted,
        failed,
        refused,
        blocked_groups: blocked,
        quarantine_dirs: quarantined,
        reversible: true,
      });
    } catch (err) {
      console.error("[dupes] delete flow failed:", err);
      res.status(500).json({ ok: false, error: "Duplicate removal failed" });
    }
  });

  // -------- v1.0.13.0 recovery panel: quarantined documents --------
  //
  // These endpoints MUST be registered before /api/documents/:id, otherwise
  // Express will route `removed` as an :id and return 404.

  // List quarantined documents (Recently removed).
  app.get("/api/documents/removed", (_req, res) => {
    try {
      const listing = listQuarantined();
      res.json({ ok: true, ...listing });
    } catch (err) {
      console.error("[recovery] list failed:", err);
      res.status(500).json({ ok: false, error: "Could not list recently removed documents" });
    }
  });

  // Restore one quarantined document. Async because it decodes page image
  // dimensions when rebuilding the pages sidecar rows.
  app.post("/api/documents/removed/:folder/restore", async (req, res) => {
    try {
      const result = await restoreQuarantined(req.params.folder);
      if (result.ok) return res.json(result);
      const status =
        result.code === "unsafe_folder" || result.code === "unsafe_document_id" ? 400 :
        result.code === "not_found" || result.code === "manifest_missing" ? 404 :
        result.code === "id_collision" ? 409 :
        500;
      res.status(status).json(result);
    } catch (err) {
      console.error("[recovery] restore failed:", err);
      res.status(500).json({ ok: false, code: "internal_error", message: "Restore failed" });
    }
  });

  // Permanent delete of a single quarantined folder. This is the ONE
  // irreversible operation surfaced by the recovery panel; the client is
  // responsible for naming the document + size in the confirmation prompt.
  app.delete("/api/documents/removed/:folder", (req, res) => {
    try {
      const result = permanentlyDeleteQuarantined(req.params.folder);
      if (result.ok) return res.json(result);
      const status =
        result.code === "unsafe_folder" ? 400 :
        result.code === "not_found" ? 404 : 500;
      res.status(status).json(result);
    } catch (err) {
      console.error("[recovery] permanent delete failed:", err);
      res.status(500).json({ ok: false, code: "internal_error", message: "Delete failed" });
    }
  });

  // Trigger the opt-in auto-cleanup sweep on demand (Settings > Recovery).
  // Only performs deletion when the corresponding setting is enabled.
  app.post("/api/documents/removed/auto-cleanup/run", (_req, res) => {
    try {
      if (!getAutoCleanupEnabled()) {
        return res.status(400).json({
          ok: false,
          code: "disabled",
          message: "Automatic duplicate cleanup is turned off. Enable it in Settings first.",
        });
      }
      const result = runAutoCleanupOnce();
      res.json({ ok: true, ...result, last_run_at: getAutoCleanupLastRunAt() });
    } catch (err) {
      console.error("[recovery] auto-cleanup failed:", err);
      res.status(500).json({ ok: false, error: "Auto-cleanup failed" });
    }
  });

  // -------- v1.0.13.0 recovery panel: pre-restore snapshots --------

  app.get("/api/backups/snapshots", (_req, res) => {
    try {
      const listing = listSnapshots();
      res.json({ ok: true, ...listing });
    } catch (err) {
      console.error("[recovery] list snapshots failed:", err);
      res.status(500).json({ ok: false, error: "Could not list pre-restore snapshots" });
    }
  });

  app.delete("/api/backups/snapshots/:name", (req, res) => {
    try {
      const result = permanentlyDeleteSnapshot(req.params.name);
      if (result.ok) return res.json(result);
      const status =
        result.code === "unsafe_folder" ? 400 :
        result.code === "not_found" ? 404 : 500;
      res.status(status).json(result);
    } catch (err) {
      console.error("[recovery] snapshot delete failed:", err);
      res.status(500).json({ ok: false, code: "internal_error", message: "Delete failed" });
    }
  });

  // -------- v1.0.13.0 recovery-panel settings --------
  //
  // Opt-in automatic cleanup of quarantined DUPLICATES only. Never applies
  // to single-document deletes. Default off. The runner re-verifies the
  // keeper's presence, SHA-256, and viewability at the moment of deletion.

  app.get("/api/recovery/settings", (_req, res) => {
    try {
      res.json({
        ok: true,
        auto_cleanup_quarantined_dupes: getAutoCleanupEnabled(),
        last_run_at: getAutoCleanupLastRunAt(),
      });
    } catch (err) {
      console.error("[recovery] read settings failed:", err);
      res.status(500).json({ ok: false, error: "Could not read recovery settings" });
    }
  });

  app.post("/api/recovery/settings", (req, res) => {
    try {
      const body = (req.body ?? {}) as any;
      if (typeof body.auto_cleanup_quarantined_dupes === "boolean") {
        setAutoCleanupEnabled(body.auto_cleanup_quarantined_dupes);
      }
      res.json({
        ok: true,
        auto_cleanup_quarantined_dupes: getAutoCleanupEnabled(),
        last_run_at: getAutoCleanupLastRunAt(),
      });
    } catch (err) {
      console.error("[recovery] write settings failed:", err);
      res.status(500).json({ ok: false, error: "Could not update recovery settings" });
    }
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
    // v1.0.12.3: removing a document is no longer destructive. Its row,
    // chunks, page images and retained original are moved into the
    // quarantine folder first, and only then unlinked from the library, so a
    // deletion -- accidental, mistaken, or scripted -- is always reversible.
    // Nothing on disk is erased here.
    const id = req.params.id;
    if (!isSafeDocIdForPathUse(id)) {
      return res.status(400).json({ ok: false, message: "That document id is not valid." });
    }
    const doc = storage.getDocument(id);
    if (!doc) return res.status(404).json({ message: "not found" });
    try {
      const result = quarantineDocument(id, "removed from the library by request");
      appendBackupLog(
        `[DELETE] quarantined ${id} (removed from the library by request); ` +
          `pages_moved=${result.moved_pages} original_moved=${result.moved_original} ` +
          `chunks=${result.chunk_count} -> ${result.dir}`,
      );
      res.json({ ok: true, reversible: true, quarantine_dir: result.dir });
    } catch (err) {
      // The document is left fully intact when quarantine fails. Refusing is
      // always preferable to a partial delete.
      console.error("[delete] quarantine failed, document left in place:", err);
      appendBackupLog(`[DELETE] refused ${id}: could not preserve a copy: ${(err as Error).message}`);
      res.status(500).json({
        ok: false,
        message:
          "This document was not removed because a recoverable copy could not be saved first. " +
          "Nothing was deleted. Check free disk space and try again.",
      });
    }
  });

  // -------- v0.9.23: Library maintenance scan --------
  // Sweeps the library for common integrity issues so techs can spot problems
  // before shipping a doc to a customer. Metadata-only — never re-renders or
  // re-hashes. Returns three issue buckets:
  //   * duplicate_filenames: two or more docs share the same file_name stem
  //     (case-insensitive). Groups the doc IDs so the UI can show "3 copies of
  //     admin-guide.pdf".
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

    // ---- Missing page files (spot-check first/mid/last) ----
    const missing_pages: { id: string; title: string; total_pages: number; missing: number[] }[] = [];
    for (const d of docs) {
      const totalPages = (d as any).total_pages as number | null | undefined;
      if ((d as any).original_ext === "pdf" && !d.pdf_rendered && originalExists(d.id, "pdf")) continue;
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
      missing_pages,
      // Product model is optional, so a blank model is neither reported nor
      // counted here. The former missing_product_model list was removed with
      // its UI section.
      issue_count: duplicate_filenames.length + missing_pages.length,
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
    res.json({ document_id: req.params.id, pages,pdf_prepared:!!doc.pdf_compatibility,
      viewer: (doc as any).original_ext === "pdf" && !doc.pdf_rendered ? "pdf-native" : "page-images" });
  });

  // Stream one page image. Path is validated against the DB row so we never
  // serve arbitrary files: attackers can't traverse via ../../../etc/passwd.
  app.get("/api/documents/:id/pages/:n.jpg", (req, res) => {
    const n = parseInt(req.params.n, 10);
    if (!Number.isFinite(n) || n < 1) return res.status(400).json({ message: "invalid page number" });
    const row = storage.getPage(req.params.id, n);
    if (!row) return res.status(404).json({ message: "page not rendered yet" });
    // v1.2.1: resolve the image location from the current pages root instead
    // of the absolute path stored in the DB. Fixes viewers after a restore
    // that landed the pages tree at a different absolute path than the one
    // baked in at render time (different machine, different Windows user,
    // different architecture). Falls back to the stored path only if the
    // resolver can't find the file -- protects any deployment we haven't
    // anticipated where users deliberately point RAG_PAGES_DIR elsewhere
    // after render.
    let imagePath = resolvePageImageOnDisk(req.params.id, n);
    if (!imagePath) {
      if (existsSync(row.image_path)) {
        imagePath = row.image_path;
      } else {
        return res.status(404).json({ message: "image missing on disk" });
      }
    }
    try {
      const stat = statSync(imagePath);
      // v0.9.19: renders are WebP; older renders are JPEG. The URL still ends
      // in .jpg for cache-key stability, but the actual bytes come from disk
      // and we advertise the right content-type so the browser decodes them.
      const ext = /\.webp$/i.test(imagePath) ? "webp" : "jpeg";
      res.setHeader("Content-Type", `image/${ext}`);
      res.setHeader("Content-Length", String(stat.size));
      // These images are immutable once written — cache aggressively so the
      // viewer's prev/next flicker stays cheap.
      res.setHeader("Cache-Control", "private, max-age=3600, immutable");
      createReadStream(imagePath).pipe(res);
    } catch (err: any) {
      console.error(`[pages] stream failed for ${req.params.id}/${n}:`, err);
      if (!res.headersSent) res.status(500).json({ message: "read failed" });
    }
  });

  // v1.0.5: DOCX / TXT / MD viewer content endpoint. Returns the full
  // extracted text of a non-PDF document, reassembled from the chunks
  // table (chunks WHERE parent_id = :id ORDER BY chunk_index). This
  // avoids adding a new column or sidecar file: extracted text is
  // already durable in chunks.content after ingest, and joining it
  // works retroactively for every previously-uploaded DOCX/TXT/MD.
  //
  // Returns 404 for PDFs -- they have per-page image endpoints already.
  // Returns 404 for docs with no chunks (e.g. still being ingested).
  //
  // Format detection is best-effort from file_name; "markdown" is the
  // renderer default because mammoth's DOCX -> markdown output is
  // markdown-safe and TXT / MD fall through cleanly.
  app.get("/api/documents/:id/content", (req, res) => {
    try {
      const doc = storage.getDocument(req.params.id);
      if (!doc) return res.status(404).json({ message: "document not found" });

      const fileName = (doc.file_name ?? "").toLowerCase();
      const isPdf = fileName.endsWith(".pdf");
      if (isPdf) {
        return res.status(404).json({
          message: "pdf viewer uses the page-image endpoints; use /pages/:n.jpg",
        });
      }

      // v1.0.7.4: added "rtf" as a first-class format value. The RTF viewer
      // reuses the plain-text canvas (like TXT) but gets the DOCX toolbar
      // (Print, Open in Word, edit-in-place pill, drag-to-update).
      let format: "docx" | "text" | "markdown" | "rtf" = "markdown";
      if (fileName.endsWith(".docx")) format = "docx";
      else if (fileName.endsWith(".rtf")) format = "rtf";
      else if (fileName.endsWith(".txt")) format = "text";
      else if (fileName.endsWith(".md") || fileName.endsWith(".markdown")) format = "markdown";

      const rows = storage.getChunksForDoc(req.params.id);
      if (rows.length === 0) {
        return res.status(404).json({ message: "no chunks stored for this document" });
      }
      // Sort defensively -- getChunksForDoc has no ORDER BY guarantee.
      const ordered = [...rows].sort((a, b) => a.chunk_index - b.chunk_index);
      // Join with blank lines so heading breaks and paragraph boundaries
      // survive the reassembly. The chunker already trims chunk edges.
      const markdown = ordered.map((c) => c.content).join("\n\n");

      // v1.0.5: TXT is plain text -- flag it so the client wraps in <pre>
      // instead of running it through a markdown renderer that would
      // collapse whitespace.
      // v1.0.6: has_original tells the client whether
      // /api/documents/:id/original will return the source bytes for a
      // rich viewer (docx-preview). False for pre-v1.0.6 uploads and for
      // TXT/MD, which drives the "legacy upload -- re-upload for viewing"
      // banner.
      const originalExt = ((doc as any).original_ext ?? null) as string | null;
      const hasOriginal = originalExists(doc.id, originalExt);
      res.json({
        format,
        markdown,
        chunk_count: ordered.length,
        char_count: markdown.length,
        has_original: hasOriginal,
        original_ext: originalExt,
        original_bytes: hasOriginal ? originalSize(doc.id, originalExt) : null,
      });
    } catch (err) {
      res.status(500).json({ message: err instanceof Error ? err.message : String(err) });
    }
  });

  // v1.0.6: stream the retained original source file for a document.
  //
  // Returns 404 in three distinct "we don't have it" cases so the client
  // can distinguish them:
  //   * document not found: id doesn't exist at all.
  //   * document has no retained original: pre-v1.0.6 upload OR an
  //     extension we don't retain (TXT / MD / PDF). Client shows the
  //     "legacy upload -- re-upload for viewing" banner.
  //   * retained original file went missing on disk (e.g. antivirus
  //     quarantined it or a partial restore). Same 404, different
  //     `reason` so future support diagnostics can distinguish.
  //
  // Content-Type is derived from the retained extension. Currently only
  // DOCX; the map is extended as more source types get retained.
  app.get("/api/documents/:id/original", (req, res) => {
    const doc = storage.getDocument(req.params.id);
    if (!doc) {
      return res.status(404).json({ message: "document not found", reason: "no_document" });
    }
    const ext = ((doc as any).original_ext ?? null) as string | null;
    if (!ext) {
      return res.status(404).json({
        message: "no retained original for this document",
        reason: "no_original",
      });
    }
    let filePath: string;
    try {
      filePath = originalFilePath(doc.id, ext);
    } catch (err) {
      return res.status(500).json({ message: String(err) });
    }
    if (!existsSync(filePath)) {
      return res.status(404).json({
        message: "retained original missing on disk",
        reason: "original_missing",
      });
    }
    const MIME_BY_EXT: Record<string, string> = {
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      pdf: "application/pdf",
      // v1.0.7.4: RTF retained for edit-in-place + "Open in Word" workflow.
      rtf: "application/rtf",
    };
    try {
      const stat = statSync(filePath);
      res.setHeader("Content-Type", MIME_BY_EXT[ext] ?? "application/octet-stream");
      res.setHeader("Content-Length", String(stat.size));
      // Immutable once written: doc id + ext + on-disk bytes never change
      // in place, so aggressive caching keeps the viewer's re-open cheap.
      res.setHeader("Cache-Control", "private, max-age=3600, immutable");
      // Prefer download-name that matches the original file so "Save As"
      // in the browser doesn't produce "<uuid>.docx".
      const safeName = (doc.file_name ?? `document.${ext}`).replace(/["\\]/g, "_");
      if (req.query.download !== "1") res.setHeader("Content-Disposition", `inline; filename="${safeName}"`);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (req.query.download === "1") {
        if (ext === "pdf" && !originalPdfAvailable(doc.id, ext))
          return res.status(404).json({message:"retained original unavailable",reason:"original_missing"});
        const downloadName = (doc.file_name || `document.${ext}`).replace(/[/\\\x00-\x1f\x7f]/g, "_");
        return res.download(filePath, downloadName);
      }
      res.sendFile(filePath);
    } catch (err) {
      console.error(`[originals] stream failed for ${req.params.id}:`, err);
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
  // v1.0.7.4: added .rtf (application/rtf, text/rtf). Extract worker
  // routes RTF through the homegrown stripper (server/workers/rtf-stripper.cjs).
  const ALLOWED_EXT = new Set([".pdf", ".docx", ".txt", ".md", ".markdown", ".rtf"]);
  const ALLOWED_MIME = new Set([
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    // v1.0.7.4: RTF ships with a surprising number of MIME variants in the
    // wild. Word/Windows Explorer typically sends application/rtf; Firefox
    // has historically sent text/richtext (Netscape-era name); some Windows
    // registry setups send application/x-rtf; some send nothing at all,
    // which hits application/octet-stream below. Accept every RTF variant
    // we've seen; the extension check + magic-byte check in the ingest
    // worker are the real guardrails.
    "application/rtf",
    "text/rtf",
    "text/richtext",
    "application/x-rtf",
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
      // v1.0.7.4.3 / v1.0.8: accept when EITHER the extension OR the MIME
      // is on the allow-list. This logic applies uniformly to every
      // supported extension (.pdf, .docx, .rtf, .txt, .md) -- browsers
      // routinely disagree with each other on MIME strings for the same
      // file (Firefox on Windows sends text/richtext for RTF; Word
      // versions register application/x-rtf; some Chromium builds send
      // application/octet-stream for DOCX opened from Explorer), and
      // there is no authoritative list. The extract worker enforces the
      // actual content type by magic bytes downstream (rtf-stripper.cjs
      // requires "{\\rtf" as the first 5 bytes; docx unzips as a ZIP;
      // pdfjs requires %PDF), so a mismatched declared MIME can't smuggle
      // in a truly unsupported file.
      if (extOk || mimeOk) return cb(null, true);
      // Log the rejection so we can see what the browser actually sent --
      // makes future MIME-variant additions a 30-second fix instead of a
      // guess-and-check exercise.
      console.warn(
        `[upload] rejected file: name="${file.originalname}" ` +
          `ext="${ext}" mime="${file.mimetype}" ` +
          `(extOk=${extOk} mimeOk=${mimeOk})`,
      );
      // Reject without throwing — multer will pass a null file downstream and
      // the route hands back a 415 with a friendly explanation.
      return cb(null, false);
    },
  });

  app.post("/api/upload", trackUpload, (req, res, next) => {
    upload.single("file")(req,res,(err: any)=>{
      if (!err) return next();
      uploadStage(res,"receive_failed",{code:err.code === "LIMIT_FILE_SIZE" ? "FILE_TOO_LARGE" : "MULTIPART_FAILED"});
      return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
        message:err.code === "LIMIT_FILE_SIZE" ? "This file exceeds the 150 MB upload limit." : "The upload could not be received. Please select the file again.",
        upload_id:res.locals.upload.upload_id,
      });
    });
  }, async (req: Request, res) => {
    try {
      if (!req.file) {
        uploadStage(res,"rejected",{code:"UNSUPPORTED_OR_MISSING_FILE"});
        // Two reasons this fires: no `file` field, or multer's fileFilter
        // rejected the type. The client sends a file field ~always, so a
        // missing file at this point almost certainly means bad MIME/extension.
        return res.status(415).json({
          // v1.0.7.4.2: message updated to include RTF. Prior wording
          // predated RTF support and misled users when an RTF drop failed
          // MIME validation (some Windows/Firefox setups send RTF as
          // text/richtext or application/x-rtf, which weren't in the
          // allow-list until now).
          message: "unsupported file type \u2014 only PDF, DOCX, RTF, TXT, or Markdown files are accepted",
        });
      }

      const mode = req.body?.pdf_import_mode ?? "native";
      uploadStage(res,"received",{filename:req.file.originalname,bytes:req.file.size,mode});
      if (!["native","rendered"].includes(mode) || (mode === "rendered" && !req.file.originalname.toLowerCase().endsWith(".pdf"))) {
        uploadStage(res,"rejected",{code:"INVALID_IMPORT_MODE"});
        return res.status(400).json({message:"Invalid PDF import mode."});
      }
      // Parse the metadata JSON blob that the client posts alongside the file
      const metaRaw = typeof req.body?.metadata === "string" ? req.body.metadata : "{}";
      let metaObj: Record<string, unknown>;
      try {
        metaObj = JSON.parse(metaRaw);
      } catch {
        uploadStage(res,"rejected",{code:"INVALID_METADATA_JSON"});
        return res.status(400).json({ message: "metadata field is not valid JSON" });
      }

      // Extract text
      uploadStage(res,"extracting");
      let retainedBytes = req.file.buffer;
      let compatibility: string | null = null;
      let extracted;
      const controller = new AbortController();
      const disconnected = () => { if (!res.writableFinished) controller.abort(); };
      res.once("close", disconnected);
      try {
        try {
          extracted = await extractTextFromFile(req.file.originalname, retainedBytes, mode === "rendered");
        } catch (err: any) {
          if (mode !== "native" || err?.code !== "PDF_COPY_RESTRICTED") throw err;
          try {
            retainedBytes = await prepareCompatiblePdf(retainedBytes, controller.signal,
              stage => uploadStage(res, stage));
            extracted = await extractTextFromFile(req.file.originalname, retainedBytes);
            compatibility = JSON.stringify({engine:"QPDF 12.4.1",
              source_sha256:createHash("sha256").update(req.file.buffer).digest("hex"),
              source_bytes:req.file.buffer.length,retained_bytes:retainedBytes.length,
              prepared_at:new Date().toISOString()});
          } catch (cause: any) {
            console.error("[pdf-compat] preparation refused:", cause?.message);
            throw Object.assign(new Error("A compatible PDF could not be prepared safely. Retry, choose rendered-page import if authorized, or use an authorized unrestricted copy. No document was imported."),
              {code:"PDF_COPY_RESTRICTED"});
          }
        }
        if(controller.signal.aborted)throw Error("Import cancelled before library commit.");
      } finally {
        res.removeListener("close", disconnected);
      }
      uploadStage(res,"extracted",{pages:extracted.page_count ?? 0});
      if (!extracted.text || extracted.text.trim().length < 20) {
        uploadStage(res,"rejected",{code:"INSUFFICIENT_TEXT"});
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
        uploadStage(res,"rejected",{code:"INVALID_METADATA"});
        return res.status(400).json({
          message: "invalid metadata",
          issues: parsed.error.flatten(),
        });
      }
      if (!storage.documentTypeExists(parsed.data.document_type)) {
        uploadStage(res,"rejected",{code:"UNKNOWN_DOCUMENT_TYPE"});
        return res.status(400).json({ message: "That document type no longer exists." });
      }

      uploadStage(res,"indexing");
      const result = await ingestParsed(parsed.data);
      uploadStage(res,"indexed",{document_id:result.document.id});

      // v0.9.7 — fire off page rendering for PDFs. Runs in the background so
      // the client sees the doc immediately; viewer polls /pages/status while
      // it works. Non-PDFs skip this entirely.
      if (extracted.format === "pdf" && result?.document?.id) {
        try {
          const id = result.document.id;
          if (mode === "rendered") {
            if (saveOriginalIfRetainable(id, req.file.originalname, req.file.buffer) !== "pdf")
              throw Error("PDF original could not be retained.");
            storage.updateDocumentMeta(id, {original_ext:"pdf",pdf_rendered:1,
              file_hash_sha256:createHash("sha256").update(req.file.buffer).digest("hex")});
            scheduleRender(id,req.file.buffer);
            uploadStage(res,"render_queued");
            return res.json({...result,document:hydrateDocument(storage.getDocument(id)!),
              extraction:{format:"pdf",page_count:extracted.page_count,char_count:extracted.text.length},
              viewer:"page-images",rendering:true,upload_id:res.locals.upload.upload_id});
          }
          if (!extracted.pages?.length) throw new Error("PDF has no page geometry.");
          const saved = saveOriginalIfRetainable(id, req.file.originalname, retainedBytes);
          if (saved !== "pdf") throw new Error("PDF original could not be retained.");
          rawDb.transaction(() => {
            storage.updateDocumentMeta(id, {original_ext:"pdf",pdf_compatibility:compatibility,
              file_hash_sha256:createHash("sha256").update(retainedBytes).digest("hex")});
            for (const p of extracted.pages!) storage.upsertPage({
              document_id:id, ...p, image_path:"", generated_at:new Date().toISOString(),
            });
            storage.upsertRenderStatus({
              document_id:id, status:"ready", rendered:extracted.pages!.length,
              total:extracted.pages!.length, error:null, updated_at:new Date().toISOString(),
            });
          })();
          uploadStage(res,"complete");
          return res.json({...result, document:hydrateDocument(storage.getDocument(id)!),upload_id:res.locals.upload.upload_id,
            extraction:{format:"pdf",page_count:extracted.pages.length,char_count:extracted.text.length},
            viewer:"pdf-native",pdf_prepared:!!compatibility});
        } catch (err) {
          // ingestParsed always allocates a new id, never an existing library row.
          removeOriginal(result.document.id, "pdf");
          purgePagesForDoc(result.document.id);
          storage.deleteDocument(result.document.id);
          throw err;
        }
      }

      // v1.0.6: retain original source bytes for DOCX so the client viewer
      // can render them with docx-preview (real fonts / tables / page
      // breaks). No-op for extensions outside the retained set -- PDFs
      // already have per-page WebP renders and TXT/MD round-trip through
      // the chunk store. Stamped onto documents.original_ext after the
      // file is safely on disk so a partial write never leaves the DB
      // pointing at a missing file.
      if (result?.document?.id) {
        try {
          const savedExt = saveOriginalIfRetainable(
            result.document.id,
            req.file.originalname,
            req.file.buffer,
          );
          if (savedExt) {
            storage.updateDocumentMeta(result.document.id, { original_ext: savedExt });
          }
        } catch (err) {
          // Persistence failure here means the viewer will show the "legacy
          // upload -- re-upload for viewing" state, not a broken ingest.
          // Log loudly, keep the row.
          console.error("[upload] saveOriginalIfRetainable failed:", err);
        }
      }

      uploadStage(res,"complete");
      return res.json({
        ...result,
        upload_id:res.locals.upload.upload_id,
        extraction: {
          format: extracted.format,
          page_count: extracted.page_count,
          char_count: extracted.text.length,
        },
      });
    } catch (err: any) {
      const known = ["PDF_PASSWORD_REQUIRED","PDF_COPY_RESTRICTED","PDF_RENDER_RESTRICTED"].includes(err?.code);
      uploadStage(res,"failed",{code:known ? err.code : "IMPORT_FAILED"});
      if (known) {
        return res.status(422).json({code:err.code,message:err.message,
          fallback_available:err.code === "PDF_COPY_RESTRICTED",upload_id:res.locals.upload.upload_id});
      }
      console.error("[upload] failed:", err);
      return res.status(500).json({ message:"The import failed. Export diagnostics for details and check the library before retrying.",upload_id:res.locals.upload.upload_id });
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
  // v1.0.15: `overrideId` lets the Welcome Guide seeder use a fixed doc id
  // ("seed-readme-v1") so the search endpoint can filter it by parent_id
  // without a schema change. Callers that pass an override are responsible
  // for deleting any prior row with the same id first.
  async function ingestParsed(
    r: import("@shared/schema").IngestRequest,
    opts?: { overrideId?: string },
  ) {
    const now = new Date().toISOString();
    const docId = opts?.overrideId ?? newDocId();

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
      original_ext: null,
      pdf_rendered: 0,
      pdf_compatibility: null,
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

  // ---------------------------------------------------------------------
  // v1.0.7: replace the chunks + stats + hash for an EXISTING document.
  //
  // Shared by the WebDAV PUT save-back path and the drag-to-update path.
  // The document row keeps its id, all metadata (title, product model,
  // audience, tags, etc.), and its position in the library ordering.
  // Only content-derived fields change: file_hash_sha256, total_chunks,
  // total_tokens, updated_at, and the chunks table for this parent_id.
  //
  // Callers are responsible for putting the new original bytes on disk
  // BEFORE calling this (WebDAV PUT does it inline, drag-to-update does
  // it in the /api/documents/:id/update handler). We only handle the
  // DB-side rebuild here.
  // ---------------------------------------------------------------------
  async function reingestDocxIntoExisting(
    documentId: string,
    bytes: Buffer,
    fileName: string,
  ): Promise<void> {
    const existing = storage.getDocument(documentId);
    if (!existing) {
      throw new Error(`reingest: document ${documentId} not found`);
    }

    // Extract text using the same pipeline as fresh upload.
    const extracted = await extractTextFromFile(fileName, bytes);
    const body = extracted.text ?? "";
    if (!body || body.trim().length < 20) {
      throw new Error(
        `reingest: extracted <20 chars from ${fileName} -- refusing to wipe existing chunks`,
      );
    }

    // Delete existing chunks in one shot.
    storage.deleteChunksForDoc(documentId);

    // Recompute chunks + tf-idf against the current corpus (minus our own,
    // which we just deleted).
    const drafts = chunkDocument(body, {
      chunk_size_tokens: 300,
      chunk_overlap_tokens: 40,
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

    const now = new Date().toISOString();
    // Reuse the existing doc's classifier fields when building chunks; we
    // preserve those exactly so search filters keep working.
    const audienceJson = (existing as any).audience_json ?? "[]";
    const allowedTenantsJson = (existing as any).allowed_tenants_json ?? "[]";

    let carriedPage: number | null = null;
    let carriedSection: string | null = null;
    const chunkRows: Chunk[] = drafts.map((d) => {
      const vec = buildTfIdfVector(d.content, df, totalDocs);
      const loc = deriveLocation(d.content, carriedPage);
      carriedPage = loc.page_end ?? carriedPage;
      const isDefaultSection = !d.section_title || d.section_title === "Body";
      const finalSection = isDefaultSection
        ? loc.section_title ?? carriedSection
        : d.section_title;
      if (finalSection) carriedSection = finalSection;
      return {
        id: newChunkId(),
        parent_id: documentId,
        content: d.content,
        content_type: d.content_type,
        language: existing.language,
        section_path_json: JSON.stringify(d.section_path),
        section_id: d.section_id,
        section_title: finalSection ?? d.section_title,
        heading_level: d.heading_level,
        page_start: d.page_start ?? loc.page_start,
        page_end: d.page_end ?? loc.page_end,
        chunk_index: d.chunk_index,
        document_type: existing.document_type,
        product_model: existing.product_model,
        product_version: existing.product_version ?? null,
        firmware_version: existing.firmware_version ?? null,
        audience_json: audienceJson,
        confidentiality: existing.confidentiality,
        allowed_tenants_json: allowedTenantsJson,
        lifecycle_status: existing.lifecycle_status,
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

    // Update the parent row: hash, stats, updated_at, file_name if changed.
    const total_tokens = chunkRows.reduce((a, b) => a + b.token_count, 0);
    storage.updateDocumentStats(documentId, chunkRows.length, total_tokens);
    const newHash = createHash("sha256").update(body).digest("hex");
    storage.updateDocumentMeta(documentId, {
      file_hash_sha256: newHash,
      updated_at: now,
      file_name: fileName,
    });
  }

  // ---------------------------------------------------------------------
  // v1.0.7.3: Edit-in-place via local-file + folder watcher.
  //
  // Replaces the v1.0.7 WebDAV approach, which Word 2016+ rejects on
  // loopback URLs regardless of protocol correctness. Server copies
  // the retained original to <dataDir>/edit-inbox/, launches the OS
  // default handler (Word), watches for saves, re-ingests through the
  // same reingestDocxIntoExisting path that drag-to-update uses. See
  // server/editInbox.ts for the session lifecycle.
  //
  //   POST /api/documents/:id/edit-open
  //     Starts a session, copies the file, launches Word, returns
  //     { session_id, file_path }.
  //
  //   GET  /api/documents/:id/edit-status?session=<id>
  //     Polling endpoint returning current session state so the client
  //     can show "watching / saving / saved / error" toasts.
  //
  //   POST /api/documents/:id/edit-close  { session_id }
  //     Explicit close (called on tab-unmount, doc-switch, etc.). The
  //     server also idle-closes sessions after 30 min of inactivity.
  // ---------------------------------------------------------------------
  app.post("/api/documents/:id/edit-open", (req, res) => {
    const documentId = req.params.id;
    const doc = storage.getDocument(documentId);
    if (!doc) return res.status(404).json({ error: "document not found" });
    const ext = (doc as any).original_ext as string | null;
    if (!ext || !["docx","rtf"].includes(ext.toLowerCase())) {
      return res.status(400).json({
        error:
          "Only retained DOCX and RTF documents can be edited in place. PDFs open as temporary copies.",
      });
    }
    try {
      const result = startEditSession(
        documentId,
        ext,
        (bytes, fileName) => reingestDocxIntoExisting(documentId, bytes, fileName),
        true,
      );
      return res.json({
        session_id: result.sessionId,
        file_path: result.filePath,
        reused: result.reused,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[edit-inbox] start failed for ${documentId}:`, err);
      return res.status(500).json({ error: message });
    }
  });

  app.get("/api/documents/:id/edit-status", (req, res) => {
    const sessionId = String(req.query.session || "");
    if (!sessionId) return res.status(400).json({ error: "session query param required" });
    const status = pollEditStatus(sessionId);
    if (!status) return res.status(404).json({ error: "session not found or ended" });
    if (status.document_id !== req.params.id) {
      return res.status(400).json({ error: "session does not belong to this document" });
    }
    return res.json(status);
  });

  app.post("/api/documents/:id/edit-close", (req, res) => {
    const sessionId = String((req.body && req.body.session_id) || req.query.session || "");
    if (!sessionId) return res.status(400).json({ error: "session_id required" });
    const ended = endEditSession(sessionId);
    return res.json({ ended });
  });

  // ---------------------------------------------------------------------
  // v1.0.7: drag-to-update endpoints.
  //
  //   POST /api/documents/:id/similarity-check
  //     Multipart upload of a candidate replacement .docx. Returns a
  //     tier verdict + summary metrics so the client can choose the
  //     right confirmation UI (silent / modal / warning modal).
  //
  //   POST /api/documents/:id/update
  //     Multipart upload of the confirmed replacement. Backs up the
  //     current original, atomically replaces it, and re-ingests
  //     synchronously so the response body carries the fresh doc + chunks.
  //
  //   GET  /api/documents/:id/trash
  //     List trashed originals for this doc so the UI can show an
  //     "Undo replace" affordance.
  //
  //   POST /api/documents/:id/undo-replace  { token }
  //     Restore a trashed original + re-ingest.
  // ---------------------------------------------------------------------
  // v1.0.7.4: accept .docx OR .rtf here. Both are "drop an updated original
  // to replace the retained bytes and re-ingest" -- the pipeline downstream
  // is extension-agnostic (extract worker routes by extension, reingest
  // just calls extractTextFromFile). The endpoints below still enforce
  // that the ext of the incoming file matches the doc's retained ext, so
  // you can't drop a .docx onto an RTF doc or vice versa.
  const singleEditableUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 150 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const ext = (file.originalname.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? "").toLowerCase();
      if (ext === "docx" || ext === "rtf") return cb(null, true);
      cb(null, false);
    },
  });

  app.post(
    "/api/documents/:id/similarity-check",
    singleEditableUpload.single("file"),
    async (req: Request, res) => {
      try {
        const docId = String(req.params.id);
        const doc = storage.getDocument(docId);
        if (!doc) return res.status(404).json({ message: "document not found" });
        const currentExt = ((doc as any).original_ext ?? null) as string | null;
        if (!currentExt || !["docx","rtf"].includes(currentExt.toLowerCase())) {
          return res.status(400).json({
            message: "this document does not have a retained original -- upload a new file instead",
          });
        }
        if (!req.file) {
          return res.status(415).json({ message: "only .docx and .rtf files are supported for update" });
        }
        // v1.0.7.4: enforce that the incoming ext matches the doc's retained
        // ext. Prevents "drag .docx onto an RTF doc" from silently working.
        const incomingExt = (req.file.originalname.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? "").toLowerCase();
        if (incomingExt !== currentExt.toLowerCase().replace(/^\./, "")) {
          return res.status(415).json({
            message: `document is .${currentExt} -- cannot replace with .${incomingExt}`,
          });
        }
        const livePath = originalFilePath(docId, currentExt);
        if (!existsSync(livePath)) {
          return res.status(404).json({ message: "retained original is missing on disk" });
        }
        const [existingSig, incomingSig] = await Promise.all([
          buildDocxSignature(
            ((doc as any).file_name as string | null) ?? `${doc.title}.${currentExt}`,
            readFileSync(livePath),
          ),
          buildDocxSignature(req.file.originalname, req.file.buffer),
        ]);
        const result = compareSignatures(existingSig, incomingSig);
        return res.json({
          document_id: docId,
          document_title: doc.title,
          existing_file_name: (doc as any).file_name ?? null,
          incoming_file_name: req.file.originalname,
          incoming_size: req.file.size,
          ...summarizeResult(result),
        });
      } catch (err: any) {
        console.error("[similarity-check] failed:", err);
        return res.status(500).json({ message: err?.message ?? "similarity check failed" });
      }
    },
  );

  app.post(
    "/api/documents/:id/update",
    singleEditableUpload.single("file"),
    async (req: Request, res) => {
      try {
        const docId = String(req.params.id);
        const doc = storage.getDocument(docId);
        if (!doc) return res.status(404).json({ message: "document not found" });
        const currentExt = ((doc as any).original_ext ?? null) as string | null;
        if (!currentExt || !["docx","rtf"].includes(currentExt.toLowerCase())) {
          return res.status(400).json({
            message: "this document does not have a retained original -- upload a new file instead",
          });
        }
        if (!req.file) {
          return res.status(415).json({ message: "only .docx and .rtf files are supported for update" });
        }
        // v1.0.7.4: enforce that the incoming ext matches the doc's retained ext.
        const incomingExt = (req.file.originalname.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? "").toLowerCase();
        if (incomingExt !== currentExt.toLowerCase().replace(/^\./, "")) {
          return res.status(415).json({
            message: `document is .${currentExt} -- cannot replace with .${incomingExt}`,
          });
        }
        const bytes = req.file.buffer;

        // Validate the bytes look like a real .docx or .rtf before we touch
        // anything. Cheap peek at the first few bytes:
        //   docx -> zip signature 'PK' (0x50 0x4B)
        //   rtf  -> ASCII '{\\rtf' magic
        if (incomingExt === "docx") {
          if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
            return res.status(415).json({ message: "file is not a valid .docx (missing zip signature)" });
          }
        } else if (incomingExt === "rtf") {
          // "{\\rtf" -- the RTF spec requires this as the first 5 chars.
          if (bytes.length < 5 || bytes.toString("ascii", 0, 5) !== "{\\rtf") {
            return res.status(415).json({ message: "file is not a valid .rtf (missing {\\rtf magic)" });
          }
        }

        const livePath = originalFilePath(docId, currentExt);

        // Snapshot the current live file into .trash/ so we can undo.
        const backup = existsSync(livePath) ? backupBeforeReplace(docId, currentExt) : null;

        // Persist new bytes. saveOriginalIfRetainable overwrites at
        // originalFilePath(id, ext).
        try {
          saveOriginalIfRetainable(docId, req.file.originalname, bytes);
        } catch (err) {
          console.error("[update] save failed:", err);
          // If we backed up but the write failed, restore.
          if (backup) {
            try {
              undoReplace(backup.token, currentExt);
            } catch (restoreErr) {
              console.error("[update] rollback failed:", restoreErr);
            }
          }
          return res.status(500).json({ message: "failed to save replacement bytes" });
        }

        // Re-ingest synchronously so the client gets fresh doc/chunks in
        // the response.
        try {
          await reingestDocxIntoExisting(docId, bytes, req.file.originalname);
        } catch (err: any) {
          console.error("[update] reingest failed:", err);
          // Roll back: restore the previous original. The DB chunks are
          // gone; we return an error and the user will need to reopen.
          if (backup) {
            try {
              undoReplace(backup.token, currentExt);
            } catch (restoreErr) {
              console.error("[update] rollback failed:", restoreErr);
            }
          }
          return res.status(500).json({
            message: `re-ingest failed: ${err?.message ?? "unknown error"}`,
          });
        }

        const finalDoc = storage.getDocument(docId)!;
        return res.json({
          document: hydrateDocument(finalDoc),
          undo_token: backup?.token ?? null,
          undo_expires_seconds: backup ? TRASH_TTL_SECONDS : 0,
        });
      } catch (err: any) {
        console.error("[update] failed:", err);
        return res.status(500).json({ message: err?.message ?? "update failed" });
      }
    },
  );

  app.get("/api/documents/:id/trash", (req, res) => {
    const docId = String(req.params.id);
    const doc = storage.getDocument(docId);
    if (!doc) return res.status(404).json({ message: "document not found" });
    const entries = listTrashForDocument(docId).map((e) => ({
      token: e.token,
      ext: e.ext,
      size: e.size,
      timestamp_ms: e.timestampMs,
      // Time until this entry is swept, in seconds. Client uses this to
      // hide the Undo affordance once the safety window has closed.
      expires_in_seconds: Math.max(
        0,
        Math.floor((e.timestampMs + TRASH_TTL_SECONDS * 1000 - Date.now()) / 1000),
      ),
    }));
    res.json({ document_id: req.params.id, entries });
  });

  app.post("/api/documents/:id/undo-replace", async (req, res) => {
    try {
      const docId = String(req.params.id);
      const doc = storage.getDocument(docId);
      if (!doc) return res.status(404).json({ message: "document not found" });
      const currentExt = ((doc as any).original_ext ?? null) as string | null;
      if (!currentExt || !["docx","rtf"].includes(currentExt.toLowerCase())) {
        return res.status(400).json({ message: "nothing to undo -- no retained original" });
      }
      const token = String(req.body?.token || "");
      if (!token) return res.status(400).json({ message: "missing token" });

      const restored = undoReplace(token, currentExt);
      if (!restored) {
        return res.status(410).json({ message: "undo window has expired or token is unknown" });
      }

      // Re-ingest from the restored bytes so search picks up the reverted
      // content.
      const livePath = originalFilePath(docId, currentExt);
      const bytes = readFileSync(livePath);
      const fileName =
        ((doc as any).file_name as string | null) ?? `${doc.title}.${currentExt}`;
      try {
        await reingestDocxIntoExisting(docId, bytes, fileName);
      } catch (err: any) {
        console.error("[undo-replace] reingest failed:", err);
        return res.status(500).json({
          message: `restored the file but re-ingest failed: ${err?.message ?? "unknown"}`,
        });
      }
      const finalDoc = storage.getDocument(docId)!;
      return res.json({ document: hydrateDocument(finalDoc) });
    } catch (err: any) {
      console.error("[undo-replace] failed:", err);
      return res.status(500).json({ message: err?.message ?? "undo failed" });
    }
  });

  // Sweep .trash/ at startup and hourly thereafter.
  try {
    const swept = sweepTrash();
    if (swept > 0) console.log(`[trash] swept ${swept} expired entries at startup`);
  } catch (err) {
    console.error("[trash] startup sweep failed:", err);
  }
  setInterval(() => {
    try {
      const swept = sweepTrash();
      if (swept > 0) console.log(`[trash] swept ${swept} expired entries`);
    } catch (err) {
      console.error("[trash] periodic sweep failed:", err);
    }
  }, 60 * 60 * 1000).unref();

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
    // v1.0.14: precompute the parent-doc set for the product_family filter.
    // Chunks don't denormalize product_family (only product_model), so we
    // filter by parent-id membership -- same pattern as tags above.
    //
    // Per product decision: when a specific family is selected, documents
    // with NO recorded family are INCLUDED (forgiving match for older
    // uploads that pre-date the field). An empty/undefined filter value
    // does no filtering at all.
    let _familyParentHits: Set<string> | null = null;
    const familyFilter = (filters.product_family ?? "").trim();
    if (familyFilter) {
      const wanted = familyFilter.toLowerCase();
      _familyParentHits = new Set(
        storage.listDocuments()
          .filter((d) => {
            const fam = (d.product_family ?? "").trim();
            if (fam === "") return true; // untagged docs pass
            return fam.toLowerCase() === wanted;
          })
          .map((d) => d.id),
      );
    }
    const filtered = all.filter((c) => {
      // v1.0.15: exclude the seeded Welcome Guide from all query results so
      // it doesn't crowd real technical hits. The doc is still visible in
      // Library and searchable inside the viewer (that path scopes by
      // filters.document_id and is unaffected by this rule).
      if (c.parent_id === SEED_WELCOME_GUIDE_DOC_ID && filters.document_id !== SEED_WELCOME_GUIDE_DOC_ID) return false;
      if (filters.product_model?.length && !filters.product_model.includes(c.product_model)) return false;
      if (_familyParentHits && !_familyParentHits.has(c.parent_id)) return false;
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
    // v1.0.15: exclude the seeded Welcome Guide from facet aggregation so
    // the Query page filter lists (product_family, product_model, tags,
    // etc.) don't get polluted with "AdvisePoint" / "AdvisePoint Docs"
    // from the built-in guide. The doc is still in the library; it just
    // doesn't contribute to filter dropdowns.
    const docs = storage.listDocuments().filter((d) => d.id !== SEED_WELCOME_GUIDE_DOC_ID);
    const models = unique(docs.map((d) => d.product_model));
    // v1.0.14: expose product_family values so the Query page can offer a
    // Product family filter. Blanks are filtered out -- "Any" is provided by
    // the client.
    const families = unique(
      docs.map((d) => (d.product_family ?? "").trim()).filter(Boolean),
    );
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
    res.json({ product_models: models, product_families: families, product_versions: versions, firmware_versions: firmwares, document_types: doc_types, tenants, tags });
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
      //
      // v1.0.9.21: also include update.log (updater.cjs's own log) and the
      // .updating sentinel file when present. These are essential for
      // diagnosing anything that happens during the swap-and-relaunch
      // window, which server.log cannot capture because node is either
      // shut down or has just booted.
      // v1.0.12.2: backups.log / backups.log.1 are the dedicated backup
      // history. Unlike server.log, they are NOT rotated by the launcher on
      // every app start, so they answer "did the nightly backup run all
      // week?" -- which server.log could never do, because it is truncated
      // to server.log.1 on each launch and interleaved with health-poll
      // request lines.
      for (const name of [
        "server.log",
        "server.log.1",
        ...UPLOAD_LOG_NAMES,
        BACKUP_LOG_NAME,
        BACKUP_LOG_ROTATED_NAME,
        "update.log",
        "update.log.1",
        ".updating",
      ]) {
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

      // v1.0.9.21: launcher-artifact fingerprints. The updater intentionally
      // does NOT touch Start AdvisePoint Docs.bat or launcher/*.vbs -- but if
      // they differ between installs we need to know. Also confirms which
      // versions of Update AdvisePoint Docs.bat and updater.cjs the swap
      // landed on disk.
      const fingerprintTargets: { label: string; path: string }[] = [
        { label: "Start AdvisePoint Docs.bat", path: join(process.cwd(), "Start AdvisePoint Docs.bat") },
        { label: "Update AdvisePoint Docs.bat", path: join(process.cwd(), "Update AdvisePoint Docs.bat") },
        { label: "launcher/run-hidden.vbs", path: join(process.cwd(), "launcher", "run-hidden.vbs") },
        { label: "launcher/create-shortcut.ps1", path: join(process.cwd(), "launcher", "create-shortcut.ps1") },
        { label: "packaging/updater/updater.cjs", path: join(process.cwd(), "packaging", "updater", "updater.cjs") },
        { label: "VERSION", path: join(process.cwd(), "VERSION") },
        { label: ".unblocked", path: join(process.cwd(), ".unblocked") },
      ];
      const fingerprintLines: string[] = [];
      for (const t of fingerprintTargets) {
        if (!existsSync(t.path)) {
          fingerprintLines.push(`${t.label}: MISSING (${t.path})`);
          continue;
        }
        try {
          const st = statSync(t.path);
          const h = createHash("sha256").update(readFileSync(t.path)).digest("hex");
          fingerprintLines.push(
            `${t.label}: sha256=${h} size=${st.size} mtime=${st.mtime.toISOString()}`,
          );
        } catch (err) {
          fingerprintLines.push(`${t.label}: read-error ${String(err)}`);
        }
      }

      // v1.0.9.21: live process snapshot (Windows only). This is the
      // decisive evidence for the "persistent PowerShell on taskbar after
      // update" bug: it tells us which powershell.exe / cmd.exe / wscript.exe
      // / node.exe processes are alive at the moment the user grabs the
      // bundle, including their parent PIDs and command lines. Users are
      // asked to click the diagnostics button while the stray taskbar entry
      // is still visible, so this snapshot names the culprit directly.
      //
      // Uses Get-CimInstance rather than tasklist because we need the parent
      // PID and full command line, which tasklist does not surface.
      // Timeout 8s so a slow WMI query cannot hang the diagnostics download.
      let processSnapshot = "skipped (not win32)";
      if (platform() === "win32") {
        try {
          const ps = execSync(
            'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -match \'powershell|pwsh|cmd|wscript|cscript|conhost|node\' } | Select-Object ProcessId,ParentProcessId,Name,CreationDate,CommandLine | Format-List | Out-String -Width 4096"',
            { timeout: 8000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
          );
          processSnapshot = ps.toString("utf8");
        } catch (err) {
          processSnapshot = `error: ${String(err)}`;
        }
      }
      entries.push({ name: "processes.txt", data: processSnapshot });

      // v1.0.9.21: recent Windows Application event-log rows tagged with
      // powershell/wscript/node/cmd sources. If a hidden process crashed or
      // reattached its console in a way Windows logged, we see it here.
      // Last 30 minutes is enough to catch anything from the current update
      // attempt without blowing up the bundle size.
      let eventLog = "skipped (not win32)";
      if (platform() === "win32") {
        try {
          const evt = execSync(
            'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-WinEvent -LogName Application -MaxEvents 200 -ErrorAction SilentlyContinue | Where-Object { $_.TimeCreated -gt (Get-Date).AddMinutes(-30) -and ($_.ProviderName -match \'PowerShell|WScript|node|cmd\' -or $_.Message -match \'AdvisePoint|powershell.exe|updater\') } | Select-Object TimeCreated,ProviderName,Id,LevelDisplayName,Message | Format-List | Out-String -Width 4096"',
            { timeout: 8000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
          );
          eventLog = evt.toString("utf8");
        } catch (err) {
          eventLog = `error: ${String(err)}`;
        }
      }
      entries.push({ name: "windows-event-log.txt", data: eventLog });

      entries.push({ name: "launcher-fingerprints.txt", data: fingerprintLines.join("\n") + "\n" });

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
        `upload_logging: ${existsSync(join(logDir,"uploads.log")) ? "journal present" : "UNAVAILABLE - inspect disk space and log permissions"}`,
        `upload_log_privacy: includes filenames and document IDs; no document text or metadata`,
        `log_dir: ${logDir}`,
        `backup_log: ${backupLogPath() ?? "(unresolved)"}${
          backupLogPath() && existsSync(backupLogPath() as string) ? "" : " (not yet created)"
        }`,
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
      // Raw exception message goes to server.log for support. The
      // response body carries the plain-language translation so a
      // pre-header failure surfaces as a friendly toast; a mid-stream
      // failure leaves the truncated ZIP for the browser to discard.
      const raw = (err as Error).message || String(err);
      const friendly = translateBackupError(err);
      console.error(`[BACKUP] export failed (${friendly.kind}):`, raw);
      appendBackupLog(`[BACKUP] download-to-browser export failed (${friendly.kind}): ${raw}`);
      if (!res.headersSent) {
        res.status(500).json({
          ok: false,
          error: friendly.title,
          detail: {
            title: friendly.title,
            cause: friendly.cause,
            next_action: friendly.next_action,
            kind: friendly.kind,
          },
        });
      } else {
        res.end();
      }
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
      const sourceLabel = req.file?.originalname || "uploaded backup";
      if (mode === "wipe") {
        if (stagedNonNull.manifest && stagedNonNull.manifest.schema_version && stagedNonNull.manifest.schema_version !== 1) {
          console.warn(`[BACKUP] schema version mismatch (backup=${stagedNonNull.manifest.schema_version} current=1); proceeding.`);
          appendBackupLog(`[BACKUP] restore schema version mismatch (backup=${stagedNonNull.manifest.schema_version} current=1); proceeding`);
        }
        const { bak_dir, verified } = importWipeReplace(stagedNonNull);
        appendBackupLog(
          `[BACKUP] restore (replace) succeeded from ${sourceLabel}; ` +
          `verified documents=${verified.documents} chunks=${verified.chunks} page_files=${verified.page_files}; ` +
          `previous data preserved in ${bak_dir}`,
        );
        writeRestoreLastOp({
          at: new Date().toISOString(),
          status: "success",
          source: `${sourceLabel} (replace)`,
          error: null,
        });
        // v1.2.3: write the side-file OUTSIDE dataDir so a wipe-restore's
        // .bak swap does not carry it away. The client reads this on the
        // first launch after restore to surface a banner even if the
        // Backup panel isn't open when the app comes back.
        writeRestoreSidefile({
          at: new Date().toISOString(),
          mode: "wipe",
          source: sourceLabel,
          documents: verified.documents,
          chunks: verified.chunks,
          bak_dir,
        });
        return res.json({
          ok: true,
          mode,
          bak_dir,
          verified,
          manifest: stagedNonNull.manifest,
          restart_required: true,
          duration_ms: Date.now() - started,
        });
      } else {
        const stats = importMerge(stagedNonNull);
        appendBackupLog(`[BACKUP] restore (merge) succeeded from ${sourceLabel}; ${JSON.stringify(stats)}`);
        writeRestoreLastOp({
          at: new Date().toISOString(),
          status: "success",
          source: `${sourceLabel} (merge)`,
          error: null,
        });
        // v1.2.3: merge restores don't swap the data dir, so the
        // app_settings-backed last-op record survives on its own. The
        // side-file is written anyway so the client uses one consistent
        // signal path for both modes, and so a merge restore followed
        // by an app crash still shows the first-launch banner.
        writeRestoreSidefile({
          at: new Date().toISOString(),
          mode: "merge",
          source: sourceLabel,
          documents: null,
          chunks: null,
          bak_dir: stats.snapshot,
        });
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
      const raw = (err as Error).message || String(err);
      const friendly = translateBackupError(err);
      console.error(`[BACKUP] import failed (${friendly.kind}):`, raw);
      appendBackupLog(`[BACKUP] restore failed (${friendly.kind}) from ${req.file?.originalname || "uploaded backup"}: ${raw}`);
      writeRestoreLastOp({
        at: new Date().toISOString(),
        status: "failed",
        source: req.file?.originalname || "uploaded backup",
        error: friendly.title,
      });
      return res.status(500).json({
        ok: false,
        error: friendly.title,
        detail: {
          title: friendly.title,
          cause: friendly.cause,
          next_action: friendly.next_action,
          kind: friendly.kind,
        },
      });
    } finally {
      if (staged) cleanupStaged(staged);
      try { if (req.file) unlinkSync(req.file.path); } catch { /* ignore */ }
    }
  });

  // GET/POST /api/backup/settings  -- read or update scheduled-backup config.
  //
  // v1.0.11: the size fields are now filled by `/api/backup/size` so the
  // settings response returns immediately instead of walking the pages
  // directory on every render. Older clients that still expect the size
  // fields inline receive them as `null`, which they render as "unknown";
  // v1.0.11 clients call `/api/backup/size` in parallel and fill the
  // muted line in when it arrives.
  app.get("/api/backup/settings", (_req, res) => {
    const s = readBackupSettings();
    res.json({
      ok: true,
      settings: {
        ...s,
        current_backup_size_bytes: null,
        current_backup_size_estimate_bytes: null,
      },
    });
  });

  // GET /api/backup/size -- raw + estimated backup size, computed on
  // demand. Split out from /settings so opening the Backup panel isn't
  // blocked by a directory walk on machines with thousands of pages.
  app.get("/api/backup/size", (_req, res) => {
    try {
      const raw = currentBackupRawSize();
      const total = raw.db_bytes + raw.pages_bytes + raw.original_bytes + raw.wal_bytes + raw.shm_bytes;
      res.json({
        ok: true,
        current_backup_size_bytes: total,
        // Conservative upper bound so users can pre-flight free space
        // against the number we show them here.
        current_backup_size_estimate_bytes: Math.ceil(total * 1.02),
        db_bytes: raw.db_bytes,
        pages_bytes: raw.pages_bytes,
        original_bytes: raw.original_bytes,
        wal_bytes: raw.wal_bytes,
        shm_bytes: raw.shm_bytes,
      });
    } catch (err) {
      const raw = (err as Error).message || String(err);
      res.status(500).json({ ok: false, error: raw });
    }
  });

  // GET /api/backup/drives -- lightweight Windows drive listing so the
  // BackupPanel's in-app path builder can show the user which drive
  // letters are currently mounted. Non-Windows platforms return an empty
  // list; the UI falls back to a plain text input in that case.
  //
  // v1.0.11.1: the previous synchronous A..Z probe used statSync, which
  // blocks Node's single event-loop thread for the sum of all 26
  // probes. On Windows, disconnected mapped network drives, absent
  // optical/floppy letters, and spun-down USB disks each add seconds,
  // which stalled /api/health long enough to trip BackendDownOverlay's
  // reconnecting banner every time the Backup panel mounted. The probe
  // is now fully async with a bounded per-letter timeout, so a slow
  // letter no longer holds the loop. A: and B: are skipped -- they are
  // legacy floppy letters that only add latency when unassigned. To opt
  // back in, pass ?probe_ab=1.
  app.get("/api/backup/drives", async (req, res) => {
    try {
      const drives: Array<{
        letter: string;         // "C" | "D" | ...
        root: string;           // "C:\\"
        label: string | null;   // best-effort human label, may be null
      }> = [];
      if (platform() === "win32") {
        const probeAB = req.query.probe_ab === "1" || req.query.probe_ab === "true";
        const startCode = probeAB ? 65 : 67; // A vs C
        const nodeFs = await import("node:fs/promises");
        const PER_LETTER_TIMEOUT_MS = 400;

        // Timeout wrapper: a stat that hasn't come back within the
        // budget is treated as "not mounted". We prefer a false
        // negative for a genuinely slow drive over freezing the loop
        // waiting on the OS.
        const probeLetter = async (letter: string): Promise<{ letter: string; root: string; label: null } | null> => {
          const root = `${letter}:\\`;
          let timer: NodeJS.Timeout | null = null;
          try {
            await Promise.race([
              nodeFs.stat(root),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("E_PROBE_TIMEOUT")), PER_LETTER_TIMEOUT_MS);
              }),
            ]);
            return { letter, root, label: null };
          } catch {
            return null;
          } finally {
            if (timer) clearTimeout(timer);
          }
        };

        const letters: string[] = [];
        for (let code = startCode; code <= 90; code++) letters.push(String.fromCharCode(code));

        // Promise.allSettled so a single slow letter can't stall the
        // whole scan and every probe runs concurrently. Ordered result
        // preserves alphabetical drive-letter order in the UI.
        const results = await Promise.allSettled(letters.map(probeLetter));
        for (const r of results) {
          if (r.status === "fulfilled" && r.value) drives.push(r.value);
        }
      }
      res.json({ ok: true, drives, platform: platform() });
    } catch (err) {
      const raw = (err as Error).message || String(err);
      res.status(500).json({ ok: false, error: raw });
    }
  });

  // -------- v1.0.14: Native folder picker for backup destinations --------
  //
  // Users asked for the same "Choose folder" experience the OS uses in
  // File Explorer (Restore already gets it, because Choose File goes
  // through the browser file input). Browsers can't hand back a folder
  // path, so we shell out on the server and open a real Windows
  // FolderBrowserDialog via PowerShell + Windows Forms.
  //
  // Contract: POST /api/backup/browse-folder { start_at?: string }
  //   200 { ok: true, path: string }        -- user picked a folder
  //   200 { ok: true, cancelled: true }     -- user hit Cancel / closed
  //   200 { ok: false, unsupported: true }  -- non-Windows (e.g. Linux
  //                                            dev/test box); the client
  //                                            falls back to the in-app
  //                                            drive-list picker.
  //   500 { ok: false, error: string }      -- PowerShell threw / not on PATH
  //
  // start_at: preferred initial folder. The client passes the current
  // text-box value; if blank, the last folder that was picked for this
  // field; if still blank, Documents (per user's requested fallback
  // order). We validate the path exists before handing it to the dialog
  // -- SelectedPath refuses to open on a bad root.
  //
  // The dialog runs modal to a hidden owner window so it always comes
  // to the front instead of hiding behind the AdvisePoint Docs window.
  // Output is a single JSON line so we don't have to parse localised
  // PowerShell messages.
  app.post("/api/backup/browse-folder", async (req, res) => {
    try {
      if (platform() !== "win32") {
        return res.json({ ok: false, unsupported: true, platform: platform() });
      }
      const startAt = typeof req.body?.start_at === "string" ? req.body.start_at.trim() : "";
      // Sanity-check the seed path. If it doesn't exist, fall through to
      // an empty string -- FolderBrowserDialog then opens at This PC.
      let seed = "";
      if (startAt) {
        try {
          const nodeFs = await import("node:fs/promises");
          const st = await nodeFs.stat(startAt);
          if (st.isDirectory()) seed = startAt;
        } catch {
          seed = "";
        }
      }

      // Build a PowerShell script that opens the dialog and prints one
      // JSON line. All quoting is done host-side (JSON-encoding the seed
      // string) so we never have to worry about PowerShell escapes on a
      // path containing quotes or brackets.
      const ps = [
        "Add-Type -AssemblyName System.Windows.Forms;",
        "Add-Type -AssemblyName System.Drawing;",
        // Hidden owner form -- forces the dialog to the foreground so it
        // doesn't hide behind the app window.
        "$owner = New-Object System.Windows.Forms.Form;",
        "$owner.TopMost = $true;",
        "$owner.StartPosition = 'Manual';",
        "$owner.Location = New-Object System.Drawing.Point(-32000, -32000);",
        "$owner.Size = New-Object System.Drawing.Size(1,1);",
        "$owner.ShowInTaskbar = $false;",
        "$owner.Show();",
        "$dlg = New-Object System.Windows.Forms.FolderBrowserDialog;",
        "$dlg.Description = 'Choose a folder for AdvisePoint Docs backups';",
        "$dlg.ShowNewFolderButton = $true;",
        `$seed = ${JSON.stringify(seed)};`,
        "if ($seed -and (Test-Path -LiteralPath $seed -PathType Container)) { $dlg.SelectedPath = $seed; }",
        "$r = $dlg.ShowDialog($owner);",
        "$owner.Close();",
        "$owner.Dispose();",
        "if ($r -eq [System.Windows.Forms.DialogResult]::OK) {",
        "  $obj = @{ ok = $true; path = $dlg.SelectedPath };",
        "} else {",
        "  $obj = @{ ok = $true; cancelled = $true };",
        "}",
        "$obj | ConvertTo-Json -Compress",
      ].join(" ");

      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-STA", "-Command", ps],
        { windowsHide: true },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (b) => { stdout += b.toString(); });
      child.stderr.on("data", (b) => { stderr += b.toString(); });

      // Wait up to 5 minutes for the user to make a choice. A typical
      // dialog closes in a few seconds; the ceiling just keeps a stuck
      // dialog from wedging the request forever.
      const exitCode: number = await new Promise((resolveExit) => {
        const timer = setTimeout(() => {
          try { child.kill(); } catch { /* ignore */ }
          resolveExit(-1);
        }, 5 * 60 * 1000);
        child.on("exit", (code) => {
          clearTimeout(timer);
          resolveExit(typeof code === "number" ? code : -1);
        });
      });

      if (exitCode !== 0) {
        return res.status(500).json({
          ok: false,
          error: stderr.trim() || `PowerShell exited with code ${exitCode}`,
        });
      }
      const line = stdout.trim().split(/\r?\n/).pop() || "";
      try {
        const parsed = JSON.parse(line);
        return res.json(parsed);
      } catch {
        return res.status(500).json({
          ok: false,
          error: `Unexpected picker output: ${line.slice(0, 200)}`,
        });
      }
    } catch (err) {
      const raw = (err as Error).message || String(err);
      res.status(500).json({ ok: false, error: raw });
    }
  });

  // Shared preflight implementation used by both `/api/backup/preflight`
  // (informational, called from the UI when a folder is picked) and
  // `/api/backup/export-to-folder` (blocking, refuses the write on a
  // failed check). See the endpoint comments below for shape details.
  async function runFolderPreflight(
    folder: string,
    neededBytesArg: number | null | undefined,
  ): Promise<{
    ready: boolean;
    present: boolean;
    writable: boolean;
    low_space: boolean;
    free_bytes: number | null;
    needed_bytes: number | null;
    cloud_provider: null | "onedrive" | "dropbox" | "google-drive" | "icloud" | "box";
    // v1.0.12.4: set when the chosen folder is inside the directory that
    // holds the live database and page images. Informational, not blocking --
    // the write still proceeds, but a backup stored beside the data it
    // protects survives very few of the situations a backup is for.
    inside_data_dir: boolean;
    detail: { title: string; cause: string; next_action: string; kind: string } | null;
  }> {
    let neededBytes: number | null = null;
    if (typeof neededBytesArg === "number" && neededBytesArg >= 0) {
      neededBytes = neededBytesArg;
    } else {
      try {
        const raw = currentBackupRawSize();
        neededBytes = Math.ceil((raw.db_bytes + raw.pages_bytes + raw.original_bytes + raw.wal_bytes + raw.shm_bytes) * 1.02);
      } catch { neededBytes = null; }
    }

    const lower = folder.toLowerCase();
    let cloudProvider: null | "onedrive" | "dropbox" | "google-drive" | "icloud" | "box" = null;
    if (lower.includes("onedrive")) cloudProvider = "onedrive";
    else if (lower.includes("dropbox")) cloudProvider = "dropbox";
    else if (/google\s*drive|googledrive|drivefs/.test(lower)) cloudProvider = "google-drive";
    else if (/icloud/.test(lower)) cloudProvider = "icloud";
    else if (/\bbox\b/.test(lower)) cloudProvider = "box";

    let present = false;
    let writable = false;
    let freeBytes: number | null = null;
    let failure: { code: string; msg: string } | null = null;

    const nodeFs = await import("node:fs/promises");
    const nodePath = await import("node:path");
    try {
      const st = await nodeFs.stat(folder);
      if (!st.isDirectory()) {
        failure = { code: "E_NOT_WRITABLE", msg: "Path exists but is not a directory" };
      } else {
        present = true;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code || "UNKNOWN";
      if (code === "ENOENT") failure = { code: "E_DRIVE_MISSING", msg: "Folder or drive not found" };
      else failure = { code: "E_NOT_WRITABLE", msg: (err as Error).message };
    }

    if (present) {
      const sentinel = nodePath.join(folder, `.apd-writable-${process.pid}-${Date.now()}`);
      try {
        await nodeFs.writeFile(sentinel, "apd");
        writable = true;
        try { await nodeFs.unlink(sentinel); } catch { /* ignore cleanup */ }
      } catch (err) {
        failure = failure ?? { code: "E_NOT_WRITABLE", msg: (err as Error).message };
      }

      const fsWithStatfs = nodeFs as unknown as {
        statfs?: (p: string) => Promise<{ bavail: bigint; bsize: bigint }>;
      };
      if (typeof fsWithStatfs.statfs === "function") {
        try {
          const s = await fsWithStatfs.statfs(folder);
          freeBytes = Number(s.bavail * s.bsize);
        } catch { /* leave as null */ }
      }
    }

    let lowSpace = false;
    if (present && writable && freeBytes != null && neededBytes != null && freeBytes < neededBytes) {
      lowSpace = true;
    }

    const ready = present && writable && !lowSpace;

    let detail: { title: string; cause: string; next_action: string; kind: string } | null = null;
    if (!ready) {
      const err = lowSpace
        ? Object.assign(new Error("low space"), { code: "E_LOW_SPACE" })
        : Object.assign(new Error(failure?.msg || "not ready"), { code: failure?.code || "E_NOT_WRITABLE" });
      const f = translateBackupError(err);
      detail = { title: f.title, cause: f.cause, next_action: f.next_action, kind: f.kind };
    }

    // Is the destination inside the app's own data directory?
    let insideDataDir = false;
    try {
      const dataDir = resolve(getDataDirForBackup());
      const target = resolve(folder);
      insideDataDir = target === dataDir || target.startsWith(dataDir + sep);
    } catch { insideDataDir = false; }

    return {
      ready, present, writable,
      low_space: lowSpace,
      free_bytes: freeBytes,
      needed_bytes: neededBytes,
      cloud_provider: cloudProvider,
      inside_data_dir: insideDataDir,
      detail,
    };
  }

  // POST /api/backup/preflight -- inspect a folder before we try to
  // write a backup there. Returns `ready` (green light for the button)
  // plus per-check booleans so the UI can explain WHY it's not ready.
  //
  // Body: { folder: string, needed_bytes?: number }
  // Response: { ok, ready, present, writable, free_bytes, needed_bytes,
  //             cloud_provider, detail }  where `detail` is the
  //             plain-language translator output when a check fails.
  app.post("/api/backup/preflight", async (req, res) => {
    const folder = typeof req.body?.folder === "string" ? req.body.folder.trim() : "";
    if (!folder) {
      return res.status(400).json({ ok: false, error: "folder is required" });
    }
    const neededArg = typeof req.body?.needed_bytes === "number" ? req.body.needed_bytes : undefined;
    const pre = await runFolderPreflight(folder, neededArg);
    res.json({ ok: true, ...pre });
  });

  // POST /api/backup/export-to-folder -- writes an immediate backup to
  // the caller-supplied folder using the same on-disk writer the
  // scheduler uses. Preflight is run against the folder first and the
  // write is refused on a failed check. Returns the full path written
  // so the UI can name it in the success toast.
  //
  // Body: { folder: string, localStorage?: string }
  // Response on success: { ok:true, path, filename, bytes, manifest }
  // Response on refusal: { ok:false, error, detail, preflight }
  //   (401 not used; refusals return HTTP 400 with a friendly detail.)
  app.post("/api/backup/export-to-folder", async (req, res) => {
    if (isBackupInFlight()) {
      return res.status(409).json({ ok: false, error: "A backup is already in progress" });
    }
    const folder = typeof req.body?.folder === "string" ? req.body.folder.trim() : "";
    if (!folder) {
      return res.status(400).json({ ok: false, error: "folder is required" });
    }
    const ls = typeof req.body?.localStorage === "string" ? req.body.localStorage : null;

    // Preflight blocks the write on any failed check.
    const pre = await runFolderPreflight(folder, undefined);
    if (!pre.ready) {
      // v1.0.12.2: a refused manual backup is still a backup that did not
      // happen, so it belongs in the log. Without this, an unreachable or
      // full target folder produced a silent gap and the log implied the
      // user simply never asked for a backup.
      appendBackupLog(
        `[BACKUP] manual run refused by preflight -> ${folder}: ` +
        `${pre.detail?.title || "folder not ready"} ` +
        `(present=${pre.present} writable=${pre.writable} free_bytes=${pre.free_bytes})`,
      );
      return res.status(400).json({
        ok: false,
        error: pre.detail?.title || "That folder isn't ready for a backup",
        detail: pre.detail,
        preflight: pre,
      });
    }

    const filename = scheduledBackupFilename();
    const { join: joinPath } = await import("node:path");
    const outPath = joinPath(folder, filename);
    try {
      const result = await withBackupLock(() => writeBackupToFile(outPath, { localStorageJson: ls }));
      console.log(`[BACKUP] manual export wrote ${result.bytes} bytes to ${result.path}`);
      appendBackupLog(`[BACKUP] manual run wrote ${outPath} (${result.bytes} bytes)`);
      // v1.0.11.2: record last-op so the panel's status strip is
      // populated even after an app restart.
      writeQuickBackupLastOp({
        at: new Date().toISOString(),
        status: "success",
        path: result.path,
        bytes: result.bytes,
        error: null,
      });
      return res.json({
        ok: true,
        path: result.path,
        filename,
        bytes: result.bytes,
        manifest: result.manifest,
      });
    } catch (err) {
      const raw = (err as Error).message || String(err);
      const friendly = translateBackupError(err);
      console.error(`[BACKUP] manual export-to-folder failed (${friendly.kind}):`, raw);
      appendBackupLog(`[BACKUP] manual run failed (${friendly.kind}) -> ${outPath}: ${raw}`);
      writeQuickBackupLastOp({
        at: new Date().toISOString(),
        status: "failed",
        path: outPath,
        bytes: null,
        error: friendly.title,
      });
      return res.status(500).json({
        ok: false,
        error: friendly.title,
        detail: {
          title: friendly.title,
          cause: friendly.cause,
          next_action: friendly.next_action,
          kind: friendly.kind,
        },
      });
    }
  });

  // v1.0.11.2: GET last-op status for Quick backup and Restore panels.
  // Cheap KV read; safe to call on every panel mount.
  app.get("/api/backup/lastop", (_req, res) => {
    res.json({
      ok: true,
      quick_backup: readQuickBackupLastOp(),
      restore: readRestoreLastOp(),
    });
  });

  // v1.2.3: GET the first-launch restore banner record. Reading this
  // endpoint clears the side file, so the banner shows at most once
  // per restore. Returns { ok: true, record: null } when there is no
  // pending record -- the common case on every launch that is not the
  // first one after a restore.
  app.get("/api/backup/restore-banner", (_req, res) => {
    const record = readAndClearRestoreSidefile();
    res.json({ ok: true, record });
  });

  // v1.2.3: POST /api/backup/restore-banner/dismiss removes the side
  // file without returning its contents. Used by the inline post-
  // restore modal so the same restore does not trigger a duplicate
  // banner if the user leaves the app running and it later reloads
  // the panel.
  app.post("/api/backup/restore-banner/dismiss", (_req, res) => {
    clearRestoreSidefile();
    res.json({ ok: true });
  });
  app.post("/api/backup/settings", (req, res) => {
    try {
      const s = writeBackupSettings(req.body || {});
      res.json({ ok: true, settings: s });
    } catch (err) {
      res.status(400).json({ ok: false, error: String((err as Error).message || err) });
    }
  });

  // ---------------------------------------------------------------
  // v1.0.15: Welcome Guide seed + reinstall
  // ---------------------------------------------------------------

  // Ingest (or re-ingest) the bundled Welcome Guide PDF as a document with
  // the fixed id `seed-readme-v1`. Any existing document with that id is
  // hard-deleted first (chunks, page renders) so a reinstall replaces the
  // slot cleanly. Returns the ingest result on success, or an error string.
  async function ingestWelcomeGuideFromBundle(): Promise<
    { ok: true; docId: string; source: string; chunks: number }
    | { ok: false; error: string }
  > {
    const found = readWelcomeGuideBytes();
    if (!found) {
      return { ok: false, error: "bundled Welcome Guide PDF not found" };
    }
    try {
      const extracted = await extractTextFromFile(
        WELCOME_GUIDE_METADATA.file_name,
        found.bytes,
      );
      if (!extracted.text || extracted.text.trim().length < 20) {
        return { ok: false, error: `extracted <20 chars from ${found.path}` };
      }

      // Wipe any prior slot first (chunks + page renders + row).
      const existing = storage.getDocument(SEED_WELCOME_GUIDE_DOC_ID);
      if (existing) {
        try { storage.deleteChunksForDoc(SEED_WELCOME_GUIDE_DOC_ID); } catch { /* ignore */ }
        try { purgePagesForDoc(SEED_WELCOME_GUIDE_DOC_ID); } catch { /* ignore */ }
        try { storage.deleteDocument(SEED_WELCOME_GUIDE_DOC_ID); } catch { /* ignore */ }
      }

      const merged = {
        title: WELCOME_GUIDE_METADATA.title,
        document_type: WELCOME_GUIDE_METADATA.document_type,
        product_family: WELCOME_GUIDE_METADATA.product_family,
        product_model: WELCOME_GUIDE_METADATA.product_model,
        tags: WELCOME_GUIDE_METADATA.tags,
        file_name: WELCOME_GUIDE_METADATA.file_name,
        body: extracted.text,
      } as Record<string, unknown>;

      const parsed = ingestRequestSchema.safeParse(merged);
      if (!parsed.success) {
        return {
          ok: false,
          error: `metadata validation failed: ${JSON.stringify(parsed.error.flatten())}`,
        };
      }
      if (!storage.documentTypeExists(parsed.data.document_type)) {
        return { ok: false, error: `document_type ${parsed.data.document_type} missing from registry` };
      }

      const result = await ingestParsed(parsed.data, { overrideId: SEED_WELCOME_GUIDE_DOC_ID });

      // The bundled guide is a new PDF import too. Existing successfully seeded
      // guides are not touched; newly seeded/reinstalled guides retain bytes.
      if (extracted.format === "pdf" && result?.document?.id) {
        const id=result.document.id;
        if (!extracted.pages?.length) throw Error("Welcome Guide page geometry missing.");
        if (saveOriginalIfRetainable(id,WELCOME_GUIDE_METADATA.file_name,found.bytes)!=="pdf")
          throw Error("Welcome Guide original could not be saved.");
        rawDb.transaction(()=>{
          storage.updateDocumentMeta(id,{original_ext:"pdf",
            file_hash_sha256:createHash("sha256").update(found.bytes).digest("hex")});
          for (const p of extracted.pages!) storage.upsertPage({
            document_id:id,...p,image_path:"",generated_at:new Date().toISOString(),
          });
          storage.upsertRenderStatus({document_id:id,status:"ready",rendered:extracted.pages!.length,
            total:extracted.pages!.length,error:null,updated_at:new Date().toISOString()});
        })();
      }

      return {
        ok: true,
        docId: result.document.id,
        source: found.path,
        chunks: result.chunks.length,
      };
    } catch (err) {
      return { ok: false, error: String((err as Error).message || err) };
    }
  }

  // First-boot seeder. Guarded by `seeded_welcome_guide_v1` in app_settings.
  //
  // v1.1.0 adds a self-heal path. An install that was upgraded from v1.0.14 to
  // v1.0.15 never received welcome-guide/ (the updater dropped new folders), so
  // its first boot recorded a `missing:` marker and gave up permanently -- the
  // guide never appeared and Reinstall failed too. Now that the v1.1.0 updater
  // delivers the folder, the first boot after this build repairs those installs
  // automatically.
  //
  // Self-heal is deliberately narrow: it only runs when the marker records a
  // FAILED seed (`missing:` / `failed:`). A successful-seed marker with the doc
  // gone means the user deleted the guide on purpose, and that must stay deleted
  // -- see isFailedSeedMarker() in server/seed-welcome-guide.ts for the full
  // reasoning.
  async function seedWelcomeGuideIfNeeded(): Promise<void> {
    try {
      if (isWelcomeGuideSeeded(rawDb)) {
        const marker = getWelcomeGuideMarker(rawDb);
        const docMissing = !storage.getDocument(SEED_WELCOME_GUIDE_DOC_ID);
        const bundledNow = findWelcomeGuidePdf();

        if (docMissing && isFailedSeedMarker(marker) && bundledNow) {
          console.log(
            `${SEED_LOG_PREFIX} marker set but doc missing -- self-healing ` +
            `(marker="${marker}", bundled=${bundledNow})`,
          );
          const healed = await ingestWelcomeGuideFromBundle();
          if (healed.ok) {
            console.log(
              `${SEED_LOG_PREFIX} self-heal seeded id=${healed.docId} ` +
              `chunks=${healed.chunks} source=${healed.source}`,
            );
            // Promote the marker to a success value so this install is treated
            // as normally-seeded from now on. Without this, a later user delete
            // would be re-healed on the next boot, which would violate the
            // "deleting the guide must not resurrect it" contract.
            setWelcomeGuideMarker(rawDb, new Date().toISOString());
          } else {
            // Leave the failure marker in place; a future boot can retry once
            // the underlying problem (bad PDF, registry gap) is fixed.
            console.warn(`${SEED_LOG_PREFIX} self-heal failed: ${healed.error}`);
          }
          return;
        }

        if (docMissing && !bundledNow) {
          console.log(
            `${SEED_LOG_PREFIX} marker present, doc missing, bundled PDF not found; ` +
            `nothing to do (use Reinstall once the bundle is repaired)`,
          );
          return;
        }
        console.log(`${SEED_LOG_PREFIX} marker present; skipping (already seeded once)`);
        return;
      }
      console.log(`${SEED_LOG_PREFIX} first-boot seed starting`);
      const bundled = findWelcomeGuidePdf();
      if (!bundled) {
        console.warn(`${SEED_LOG_PREFIX} bundled PDF not found; setting marker to avoid boot-loop`);
        setWelcomeGuideMarker(rawDb, `missing:${new Date().toISOString()}`);
        return;
      }
      console.log(`${SEED_LOG_PREFIX} found bundled PDF at ${bundled}`);
      const result = await ingestWelcomeGuideFromBundle();
      if (result.ok) {
        console.log(
          `${SEED_LOG_PREFIX} seeded id=${result.docId} chunks=${result.chunks} source=${result.source}`,
        );
        setWelcomeGuideMarker(rawDb, new Date().toISOString());
      } else {
        console.warn(`${SEED_LOG_PREFIX} seed failed: ${result.error}; setting marker to avoid boot-loop`);
        setWelcomeGuideMarker(rawDb, `failed:${new Date().toISOString()}:${result.error}`);
      }
    } catch (err) {
      console.error(`${SEED_LOG_PREFIX} unexpected error:`, err);
      // Don't rethrow -- seeding must never prevent server startup.
    }
  }

  // Reinstall endpoint. Called from Settings > About. Idempotent: wipes the
  // seed doc's chunks + pages + row, then re-ingests the bundled PDF into
  // the same slot. Does NOT touch the seeded_welcome_guide_v1 marker -- the
  // marker records that first-boot seeding ran, and reinstall is a manual
  // action independent of that.
  app.post("/api/system/reinstall-welcome-guide", async (_req, res) => {
    console.log(`${SEED_LOG_PREFIX} manual reinstall requested`);
    const result = await ingestWelcomeGuideFromBundle();
    if (result.ok) {
      console.log(
        `${SEED_LOG_PREFIX} manual reinstall complete id=${result.docId} chunks=${result.chunks}`,
      );
      return res.json({
        ok: true,
        document_id: result.docId,
        chunks: result.chunks,
        source: result.source,
      });
    }
    console.warn(`${SEED_LOG_PREFIX} manual reinstall failed: ${result.error}`);
    return res.status(500).json({ ok: false, error: result.error });
  });

  // v1.1.0: seed the seven default Document types (case-insensitively, so
  // an existing user type with a matching label is reused) and the seven
  // default Filename-code mappings. Guarded by seeded_default_doc_types_v1
  // in app_settings -- runs exactly once per install.
  seedDefaultDocTypesAndCodesIfNeeded(rawDb);
  // v1.1.4: repair mappings orphaned by a rename or delete made before those
  // paths learned to re-point. Without this, a stale code silently tags
  // uploads with a document_type that has no row.
  const droppedCodes = pruneDanglingFilenameCodes(rawDb);
  if (droppedCodes.length > 0) {
    console.log(`${FILENAME_CODES_LOG_PREFIX} dropped dangling code mapping(s): ${droppedCodes.join(", ")}`);
  }
  // v1.2.4: seed the seven default Filename phrases after codes seed so
  // the phrase seeder can resolve labels against the just-created doc-type
  // rows. Guarded by seeded_default_filename_phrases_v1 -- runs exactly
  // once per install. Also prune any phrase rows orphaned by a rename or
  // delete made before repointFilenamePhrasesInTx existed.
  seedDefaultFilenamePhrasesIfNeeded(rawDb);
  const droppedPhrases = pruneDanglingFilenamePhrases(rawDb);
  if (droppedPhrases.length > 0) {
    console.log(`${FILENAME_PHRASES_LOG_PREFIX} dropped dangling phrase mapping(s): ${droppedPhrases.join(", ")}`);
  }

  // Fire-and-forget: don't await, so the server binds its port without
  // waiting for PDF extraction. Errors are self-logged.
  pdfRoutes(app);
    if (process.env.RAG_NO_SEED !== "1") seedWelcomeGuideIfNeeded();

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
    has_original_pdf: originalPdfAvailable(d.id, d.original_ext),
    pdf_prepared: !!d.pdf_compatibility,
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
