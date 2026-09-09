// v1.0.7.3: Edit-in-place via local-file + folder watcher.
//
// Design rationale (why we don't use WebDAV):
// -------------------------------------------
// v1.0.7 / v1.0.7.1 / v1.0.7.2 tried to hand Word a WebDAV URL
// (ms-word:ofe|u|http://127.0.0.1:5000/webdav/documents/<id>.docx) so
// that Word's Save button would round-trip back through our server.
// This ran into two documented Microsoft-side gates that we can't
// meaningfully work around from the server:
//
//   1. Office 2016+ aggressively caches WebDAV server capabilities in
//      the Windows registry (HKCU\Software\Microsoft\Office\<ver>\
//      Common\Internet\Server Cache). Fixing server headers after Word
//      has cached a "this server isn't editable" answer requires the
//      user to delete registry keys manually.
//   2. Office actively discriminates against loopback URLs
//      (127.0.0.1 / localhost). Even with fully correct DAV / MS-
//      Author-Via / X-MSDAVEXT headers on OPTIONS, PROPFIND, GET, and
//      HEAD responses, Word downloads the file and aborts with "We
//      can't connect to <url>" without ever sending LOCK or PROPFIND.
//
// Community reports and Microsoft's own docs converge on: **use
// hostname aliases or don't use loopback for WebDAV**. Neither is
// acceptable for a portable single-user app.
//
// The replacement approach here does not depend on any Office
// protocol negotiation at all. We:
//
//   1. Copy the document's retained original to a well-known local
//      folder: <dataDir>/edit-inbox/<document_id>.docx
//   2. Spawn `cmd /c start "" "<path>"` from the server, which uses
//      the Windows file association (.docx -> Word) to open the file
//      as a fully editable, LOCAL file. Word treats it exactly like
//      opening a file from Explorer -- no WebDAV, no loopback, no
//      cache, no auth challenge.
//   3. Watch the file with fs.watch. When the user saves in Word,
//      the mtime changes; we debounce (Word writes via temp-file +
//      rename, so we wait for the file to settle), then read the
//      new bytes and hand them to the caller-supplied reingest
//      function. That reuses the exact same DB rebuild path as
//      drag-to-update, so metadata / chunk_id / doc_id are preserved.
//
// Session lifecycle:
//
//   * A session is created by startEditSession(documentId, reingest).
//     Returns the local file path and a session id.
//   * Sessions expire automatically after EDIT_SESSION_IDLE_MS with
//     no activity, at which point the watcher is closed. The inbox
//     file is left on disk so a stray unsaved change in Word can
//     still be recovered manually.
//   * Explicit endEditSession(sessionId) closes the watcher early
//     without deleting the file.
//   * pollEditStatus(sessionId) gives the client a simple status
//     object it can render as "watching / saving / saved" toasts.

import {
  existsSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  openSync,
  closeSync,
  constants as fsConstants,
  watch as fsWatch,
  type FSWatcher,
} from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { DB_FILE_PATH } from "./storage";
import {
  originalExists,
  originalFilePath,
  saveOriginalIfRetainable,
} from "./originals";

// ---- Tunables ------------------------------------------------------

/** How long the file must be idle before we consider a save "settled". */
const SETTLE_MS = 750;

/**
 * If a re-ingest fails (usually because Word still holds an exclusive
 * lock on the file), wait this long and try again. Word's write cycle
 * is temp-file -> rename -> release-lock; the release step can lag the
 * rename by a few hundred ms.
 */
const REINGEST_RETRY_MS = 500;

/** Number of retries before we give up and log an error. */
const REINGEST_RETRY_MAX = 6;

/** Auto-close a session that has been idle this long. */
const EDIT_SESSION_IDLE_MS = 30 * 60 * 1000; // 30 minutes

/**
 * After a successful save, we poll every LOCK_CHECK_INTERVAL_MS for
 * Word releasing its exclusive lock on the file. When we can open the
 * file for read+write, Word has closed it -- safe to delete.
 */
const LOCK_CHECK_INTERVAL_MS = 3 * 1000;

/**
 * How long we're willing to wait for Word to release the file lock
 * after the last successful save before giving up on auto-cleanup.
 * (User can still delete it manually; the idle-sweeper also cleans
 * up eventually.)
 */
const LOCK_CHECK_MAX_MS = 60 * 60 * 1000; // 1 hour

/**
 * On startup, and periodically, remove any leftover .docx files in
 * the edit-inbox directory whose mtime is older than this. Guards
 * against orphaned files if the app was killed mid-edit.
 */
const ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Absolute path to the edit-inbox directory. Lazily created. */
export function getEditInboxDir(): string {
  return join(dirname(DB_FILE_PATH), "edit-inbox");
}

function ensureEditInboxDir(): string {
  const dir = getEditInboxDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// ---- Session state -------------------------------------------------

export type EditSessionStatus =
  | "starting"
  | "watching"
  | "saving"
  | "saved"
  | "error"
  | "ended";

interface EditSession {
  sessionId: string;
  documentId: string;
  // v1.0.7.4: lowercase extension of the retained original ("docx", "rtf").
  // Used to name the edit-inbox file and to reconstruct the fileName passed
  // to reingest so the extract worker routes to the right parser.
  ext: string;
  filePath: string;
  watcher: FSWatcher | null;
  status: EditSessionStatus;
  lastError: string | null;
  saveCount: number;
  lastSavedAt: string | null;
  createdAt: number;
  lastActivityAt: number;
  settleTimer: NodeJS.Timeout | null;
  lockCheckTimer: NodeJS.Timeout | null;
  lockCheckStartedAt: number | null;
  reingestInFlight: boolean;
  lastKnownMtimeMs: number;
  reingest: (bytes: Buffer, fileName: string) => Promise<void>;
}

const sessions = new Map<string, EditSession>();

/**
 * Look up an existing session for this document (in any state). Used
 * by startEditSession to avoid spawning a second Word window on top of
 * an already-open one.
 */
function findSessionForDocument(documentId: string): EditSession | null {
  for (const s of sessions.values()) {
    if (s.documentId === documentId && s.status !== "ended") return s;
  }
  return null;
}

// ---- Watcher plumbing ----------------------------------------------

function markActivity(session: EditSession): void {
  session.lastActivityAt = Date.now();
}

function scheduleSettleCheck(session: EditSession): void {
  if (session.settleTimer) clearTimeout(session.settleTimer);
  session.settleTimer = setTimeout(() => {
    session.settleTimer = null;
    void tryReingest(session, 0);
  }, SETTLE_MS);
}

async function tryReingest(session: EditSession, attempt: number): Promise<void> {
  if (session.status === "ended") return;
  if (session.reingestInFlight) return;

  // Confirm the file exists (Word may have moved it briefly during
  // atomic-save; if so, wait a tick).
  if (!existsSync(session.filePath)) {
    if (attempt < REINGEST_RETRY_MAX) {
      setTimeout(() => void tryReingest(session, attempt + 1), REINGEST_RETRY_MS);
    }
    return;
  }

  const st = statSync(session.filePath);
  if (st.mtimeMs === session.lastKnownMtimeMs) {
    // Nothing actually changed -- fs.watch on Windows fires multiple
    // events for a single save; skip silently.
    return;
  }

  session.reingestInFlight = true;
  session.status = "saving";
  session.lastError = null;
  markActivity(session);

  try {
    // Read the bytes. If Word still has an exclusive lock the read
    // throws EBUSY; retry a few times before giving up.
    let bytes: Buffer | null = null;
    let readError: unknown = null;
    for (let i = 0; i < REINGEST_RETRY_MAX; i += 1) {
      try {
        bytes = readFileSync(session.filePath);
        readError = null;
        break;
      } catch (err) {
        readError = err;
        await new Promise((r) => setTimeout(r, REINGEST_RETRY_MS));
      }
    }
    if (!bytes) {
      throw readError instanceof Error
        ? readError
        : new Error("edit-inbox: unable to read file after retries");
    }

    if (bytes.length < 100) {
      throw new Error(
        `edit-inbox: refusing to re-ingest a suspiciously small file (${bytes.length} bytes)`,
      );
    }

    // v1.0.7.4: use the session's actual extension (docx or rtf) so the
    // extract worker routes to the right parser.
    const fileName = `${session.documentId}.${session.ext}`;
    await session.reingest(bytes, fileName);

    // Also replace the retained original so the viewer shows the
    // updated content on next open.
    saveOriginalIfRetainable(session.documentId, fileName, bytes);

    session.saveCount += 1;
    session.lastSavedAt = new Date().toISOString();
    session.lastKnownMtimeMs = st.mtimeMs;
    session.status = "saved";
    console.log(
      `[edit-inbox] re-ingested ${session.documentId} (${bytes.length} bytes, save #${session.saveCount})`,
    );

    // Kick off (or reset) the lock-release watcher. Once Word closes
    // the document its exclusive lock drops and we can safely delete
    // the inbox copy. Each successful save resets this timer so we
    // never race a mid-edit deletion.
    scheduleLockReleaseCleanup(session);
  } catch (err) {
    session.status = "error";
    session.lastError = err instanceof Error ? err.message : String(err);
    console.error(`[edit-inbox] re-ingest failed for ${session.documentId}:`, err);
  } finally {
    session.reingestInFlight = false;
  }
}

function attachWatcher(session: EditSession): void {
  try {
    // Watch the specific file (not the directory) to keep events tight.
    const w = fsWatch(session.filePath, { persistent: false }, () => {
      if (session.status === "ended") return;
      markActivity(session);
      scheduleSettleCheck(session);
    });
    w.on("error", (err) => {
      // Windows sometimes emits ENOENT during Word's rename-based save;
      // silently reattach after a moment.
      console.warn(`[edit-inbox] watcher error for ${session.documentId}:`, err);
      try {
        w.close();
      } catch {
        /* noop */
      }
      setTimeout(() => {
        if (session.status !== "ended" && existsSync(session.filePath)) {
          attachWatcher(session);
        }
      }, 250);
    });
    session.watcher = w;
    session.status = "watching";
  } catch (err) {
    session.status = "error";
    session.lastError = err instanceof Error ? err.message : String(err);
    console.error(`[edit-inbox] failed to attach watcher for ${session.documentId}:`, err);
  }
}

// ---- Public API ----------------------------------------------------

export interface StartEditResult {
  sessionId: string;
  filePath: string;
  reused: boolean;
}

export function startEditSession(
  documentId: string,
  ext: string,
  reingest: (bytes: Buffer, fileName: string) => Promise<void>,
  openInDefault: boolean,
): StartEditResult {
  // If a session is already open for this document, reuse it and just
  // open Word again (it will focus the existing window if the file is
  // already loaded).
  const existing = findSessionForDocument(documentId);
  if (existing) {
    markActivity(existing);
    if (openInDefault) launchDefaultOpener(existing.filePath);
    return { sessionId: existing.sessionId, filePath: existing.filePath, reused: true };
  }

  if (!originalExists(documentId, ext)) {
    throw new Error(`edit-inbox: no retained original for document ${documentId}`);
  }

  const dir = ensureEditInboxDir();
  // v1.0.7.4: name the inbox file with the doc's actual extension so
  // the Windows file association opens the right app (Word for both
  // .docx and .rtf; LibreOffice honors both too).
  const cleanExt = ext.toLowerCase().replace(/^\./, "");
  const filePath = join(dir, `${documentId}.${cleanExt}`);
  const src = originalFilePath(documentId, ext);
  copyFileSync(src, filePath);
  const st = statSync(filePath);

  const session: EditSession = {
    sessionId: randomUUID(),
    documentId,
    ext: cleanExt,
    filePath,
    watcher: null,
    status: "starting",
    lastError: null,
    saveCount: 0,
    lastSavedAt: null,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    settleTimer: null,
    lockCheckTimer: null,
    lockCheckStartedAt: null,
    reingestInFlight: false,
    lastKnownMtimeMs: st.mtimeMs,
    reingest,
  };
  sessions.set(session.sessionId, session);
  attachWatcher(session);

  if (openInDefault) launchDefaultOpener(filePath);

  console.log(
    `[edit-inbox] started session ${session.sessionId} for ${documentId} at ${filePath}`,
  );

  return { sessionId: session.sessionId, filePath, reused: false };
}

export interface EditStatusPayload {
  session_id: string;
  document_id: string;
  status: EditSessionStatus;
  save_count: number;
  last_saved_at: string | null;
  last_error: string | null;
  file_path: string;
}

export function pollEditStatus(sessionId: string): EditStatusPayload | null {
  const s = sessions.get(sessionId);
  if (!s) return null;
  markActivity(s);
  return {
    session_id: s.sessionId,
    document_id: s.documentId,
    status: s.status,
    save_count: s.saveCount,
    last_saved_at: s.lastSavedAt,
    last_error: s.lastError,
    file_path: s.filePath,
  };
}

export function endEditSession(sessionId: string, options?: { deleteFile?: boolean }): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  s.status = "ended";
  if (s.settleTimer) {
    clearTimeout(s.settleTimer);
    s.settleTimer = null;
  }
  if (s.lockCheckTimer) {
    clearTimeout(s.lockCheckTimer);
    s.lockCheckTimer = null;
  }
  if (s.watcher) {
    try {
      s.watcher.close();
    } catch {
      /* noop */
    }
    s.watcher = null;
  }
  // Delete the inbox file when explicitly requested (default true).
  // Skip if Word still holds it -- the lock-check sweeper will get
  // it later. Never throws; missing file is a no-op.
  const shouldDelete = options?.deleteFile !== false;
  if (shouldDelete) {
    safeDeleteInboxFile(s.filePath, s.documentId);
  }
  sessions.delete(sessionId);
  console.log(`[edit-inbox] ended session ${sessionId}`);
  return true;
}

// ---- Cleanup helpers -----------------------------------------------

/**
 * True if the .docx at filePath is not currently locked by another
 * process (Word holds an exclusive lock while the document is open).
 * We test by opening it read+write, which fails with EBUSY / EPERM on
 * Windows while Word owns it.
 */
function isFileUnlocked(filePath: string): boolean {
  if (!existsSync(filePath)) return true;
  try {
    const fd = openSync(filePath, fsConstants.O_RDWR);
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function safeDeleteInboxFile(filePath: string, documentId: string): boolean {
  if (!existsSync(filePath)) return true;
  if (!isFileUnlocked(filePath)) {
    // Word still has it; skip and let the sweeper try later.
    return false;
  }
  try {
    rmSync(filePath, { force: true });
    console.log(`[edit-inbox] cleaned up inbox file for ${documentId}`);
    return true;
  } catch (err) {
    console.warn(`[edit-inbox] failed to delete ${filePath}:`, err);
    return false;
  }
}

/**
 * Poll for Word releasing its lock on the inbox file. When it does,
 * delete the file and end the session. Called after every successful
 * save so the file goes away shortly after the user closes Word.
 */
function scheduleLockReleaseCleanup(session: EditSession): void {
  if (session.status === "ended") return;
  if (session.lockCheckTimer) {
    clearTimeout(session.lockCheckTimer);
  }
  session.lockCheckStartedAt = Date.now();

  const tick = (): void => {
    session.lockCheckTimer = null;
    if (session.status === "ended") return;

    const unlocked = isFileUnlocked(session.filePath);
    // v1.0.8: per-tick log so a diagnostics zip can confirm whether the
    // openSync(O_RDWR) probe actually flips to unlocked for the user's
    // Word version. If the probe never says unlocked in the field, the
    // server never ends the session and the client pill never clears.
    const startedAt = session.lockCheckStartedAt ?? Date.now();
    const waited = Date.now() - startedAt;
    console.log(
      `[edit-inbox] lock-poll doc=${session.documentId} ` +
        `unlocked=${unlocked} waited_ms=${waited}`,
    );

    // Word is closed -> delete + end.
    if (unlocked) {
      const deleted = safeDeleteInboxFile(session.filePath, session.documentId);
      if (deleted) {
        endEditSession(session.sessionId, { deleteFile: false });
      }
      return;
    }

    // Word still has it. Give up after the max wait; the idle sweeper
    // and startup orphan sweep will clean up eventually.
    if (waited > LOCK_CHECK_MAX_MS) {
      console.log(
        `[edit-inbox] lock-release check timed out for ${session.documentId}; ` +
          "leaving file for later sweep",
      );
      return;
    }

    session.lockCheckTimer = setTimeout(tick, LOCK_CHECK_INTERVAL_MS);
  };

  session.lockCheckTimer = setTimeout(tick, LOCK_CHECK_INTERVAL_MS);
}

/**
 * Remove orphaned inbox files -- older than ORPHAN_MAX_AGE_MS and not
 * associated with any active session. Called on server boot and
 * periodically. Skips files that are still locked (Word may have them
 * open from a prior boot's session that we lost track of).
 */
function sweepOrphanInboxFiles(): void {
  const dir = getEditInboxDir();
  if (!existsSync(dir)) return;

  const activePaths = new Set<string>();
  for (const s of sessions.values()) activePaths.add(s.filePath);

  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    console.warn(`[edit-inbox] could not read ${dir}:`, err);
    return;
  }

  const now = Date.now();
  for (const name of entries) {
    const full = join(dir, name);
    if (activePaths.has(full)) continue;
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (now - st.mtimeMs < ORPHAN_MAX_AGE_MS) continue;
    safeDeleteInboxFile(full, name);
  }
}

// ---- Idle sweeper --------------------------------------------------

function sweepIdleSessions(): void {
  const now = Date.now();
  for (const [id, s] of sessions.entries()) {
    if (now - s.lastActivityAt > EDIT_SESSION_IDLE_MS) {
      console.log(`[edit-inbox] auto-closing idle session ${id} (${s.documentId})`);
      endEditSession(id);
    }
  }
  sweepOrphanInboxFiles();
}

setInterval(sweepIdleSessions, 5 * 60 * 1000).unref();

// Run once at module load so we don't accumulate orphans from prior
// process kills (Task Manager -> End task, power loss, updater
// restart, etc.). Fire-and-forget; failures are logged and swallowed.
try {
  sweepOrphanInboxFiles();
} catch (err) {
  console.warn("[edit-inbox] boot-time orphan sweep failed:", err);
}

// ---- OS-level open -------------------------------------------------

function launchDefaultOpener(filePath: string): void {
  if (process.platform !== "win32") {
    // Non-Windows: leave the file on disk; caller can show the path in
    // the UI so the user opens it manually. The Mac build isn't in
    // scope yet.
    console.log(
      `[edit-inbox] non-win32 platform (${process.platform}); file ready at ${filePath}`,
    );
    return;
  }
  try {
    // `cmd /c start "" "<path>"` uses the shell's file association --
    // .docx -> Word (or LibreOffice / whatever the user has set as
    // default). The empty "" is the mandatory window title arg for
    // start's quoted-path parsing.
    const child = spawn("cmd", ["/c", "start", "", filePath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    console.log(`[edit-inbox] launched OS default opener for ${filePath}`);
  } catch (err) {
    console.error(`[edit-inbox] failed to launch opener for ${filePath}:`, err);
  }
}
