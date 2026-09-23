// v1.0.3: Backup & Restore
//
// A single backup zip contains:
//   db/data.db          -- SQLite snapshot written via VACUUM INTO for a
//                           consistent copy taken while the app is running.
//   pages/**            -- Every rendered page image from RAG_PAGES_DIR.
//   localStorage.json   -- The client posts this in during Export so a
//                           Wipe-and-Replace restore returns the user to
//                           the exact library / viewer state they left.
//                           Absent for scheduled backups (no client to ask).
//   manifest.json       -- { app_version, schema_version, exported_at,
//                            document_count, chunk_count, pages_bytes,
//                            has_localstorage }
//
// This module intentionally has no HTTP dependencies -- routes.ts wires
// endpoints around the exported functions.
//
// The v0.9.31 in-memory ZIP encoder in ./zip.ts is retained for the
// diagnostics-export path (small, in-memory, no dependency). Backups use
// `archiver` (streaming, ZIP64) because a full library can easily be
// hundreds of MB with page renders.

import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { copyFileSync, lstatSync, openSync, readSync, closeSync, readFileSync, constants } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { pipeline } from "node:stream/promises";
import type { Writable } from "node:stream";
import Database from "better-sqlite3";
// archiver is a CommonJS module whose module.exports IS the factory
// function. `import * as archiverNs from "archiver"` asks esbuild for
// a namespace object, and esbuild's __toESM wrapper produces
// { default: factory, ...spreadOfExports } -- an object, not a callable.
// Calling that object at runtime throws "is not a function", which is
// exactly what shipped in every packaged build prior to this one.
// The `as unknown as (...)` cast in earlier versions silenced the type
// error, so the defect was invisible to the TypeScript compiler and
// only surfaced against a packaged bundle -- never under tsx.
//
// Fix: pick the callable off .default when the interop wrapper put it
// there, and fall back to the namespace itself when it is already the
// factory (e.g. a future migration to a real ESM archiver build, or a
// bundler that doesn't wrap CJS defaults).
import * as archiverNs from "archiver";
const archiver = (((archiverNs as unknown) as { default?: unknown }).default ?? archiverNs) as (
  format: "zip" | "tar",
  options?: archiverNs.ArchiverOptions,
) => archiverNs.Archiver;

import { DB_FILE_PATH, getPagesDirForBackup, getDataDirForBackup, rawDb, closeDbForRestore } from "./storage";
import { getOriginalsDir } from "./originals";
import { APP_VERSION } from "../client/src/version";

// -------- Types --------

export interface BackupManifest {
  app_version: string;
  schema_version: number;
  exported_at: string;
  document_count: number;
  chunk_count: number;
  pages_bytes: number;
  pages_file_count: number;
  has_localstorage: boolean;
  db_bytes: number;
}

export interface BackupResult {
  bytes: number;
  manifest: BackupManifest;
  path: string;
}

export type ImportMode = "wipe" | "merge";

export interface ImportStats {
  mode: ImportMode;
  documents_imported: number;
  chunks_imported: number;
  pages_files_copied: number;
  duration_ms: number;
  manifest: BackupManifest;
  // Wipe-mode only: the .bak folder we set aside. Kept for one cycle so a
  // bad import is recoverable from disk.
  bak_dir?: string;
}

// -------- Plain-language error translator --------
//
// Every path that writes a backup (manual export, scheduled run, run-now,
// scheduled-run-now) routes its caught exception through this function
// before showing anything to the user. The goal is that no packaged
// build ever surfaces raw `error.message` -- users get a plain-language
// cause and a suggested next action; support still gets the raw text in
// server.log and in the diagnostics zip.
//
// The translator is intentionally conservative: if none of the patterns
// match, it returns a generic "Something went wrong writing the backup"
// message plus a request to send diagnostics, rather than falling
// through to the raw exception.
export interface FriendlyBackupError {
  // Short, user-facing headline. Never contains a raw exception message.
  title: string;
  // One-sentence description of the likely cause.
  cause: string;
  // Concrete thing the user can do next. Empty when there is no useful
  // action (rare; only for internal-defect matches).
  next_action: string;
  // Underlying category, so the client can pick an icon / call-to-action.
  //   "drive-missing"   -- path or drive not there
  //   "permission"      -- writable check or EACCES/EPERM
  //   "disk-full"       -- ENOSPC
  //   "low-space"       -- preflight said not enough headroom
  //   "internal-defect" -- looks like an app bug; ask for diagnostics
  //   "verification-failed"  -- v1.0.12.3: refused before any data was touched
  //   "restore-rolled-back"  -- v1.0.12.3: swap failed; previous data restored
  //   "unknown"         -- fell through every pattern
  kind:
    | "drive-missing"
    | "permission"
    | "disk-full"
    | "low-space"
    | "internal-defect"
    | "verification-failed"
    | "restore-rolled-back"
    | "unknown";
  // Original message. Kept for the log / diagnostics only, never for the
  // primary UI surface. Truncated so it can't blow the settings row.
  raw: string;
}

export function translateBackupError(err: unknown): FriendlyBackupError {
  const raw = truncate(errorMessage(err), 400);
  const code = errorCode(err);

  // v1.0.12.3: a deliberate safety refusal or rollback already carries a
  // precise, user-facing explanation. Passing it through the generic
  // translator below turned "the backup failed verification" into
  // "something went wrong writing the backup", which is both wrong and
  // hides the reason. Surface the real message instead.
  const message = errorMessage(err);
  if (/^Refusing to (restore|merge):/.test(message)) {
    return {
      title: "That backup did not pass verification",
      cause: truncate(
        message
          .replace(/^Refusing to (restore|merge):\s*/, "")
          .replace(/^the backup did not pass verification\.\s*/, ""),
        400,
      ),
      next_action:
        "Your library was not modified. Try a different backup file; if every backup " +
        "reports this, the backups themselves are damaged.",
      kind: "verification-failed",
      raw,
    };
  }
  if (/^Restore failed and your previous library was put back:/.test(message)) {
    return {
      title: "Restore failed and was rolled back",
      cause: truncate(message, 400),
      next_action: "Restart AdvisePoint Docs, then send a diagnostics bundle from Settings.",
      kind: "restore-rolled-back",
      raw,
    };
  }

  // Node fs errors surface a `.code` property we can key off.
  if (code === "ENOENT") {
    return {
      title: "Backup folder isn't there right now",
      cause: "The folder you picked for backups can't be found. If it's on an external drive, the drive may not be connected.",
      next_action: "Reconnect the drive, or pick a different folder in Backup settings.",
      kind: "drive-missing",
      raw,
    };
  }
  if (code === "EACCES" || code === "EPERM") {
    return {
      title: "AdvisePoint Docs can't write to that folder",
      cause: "The chosen backup folder is read-only for this Windows account, or another program is holding the folder open.",
      next_action: "Pick a folder you have write access to, or close the program that has it open and try again.",
      kind: "permission",
      raw,
    };
  }
  if (code === "ENOSPC") {
    return {
      title: "That drive is full",
      cause: "There isn't enough free space on the target drive to finish writing the backup file.",
      next_action: "Free up space on the drive, or pick a drive with more room.",
      kind: "disk-full",
      raw,
    };
  }

  // Preflight rejections carry a synthetic tag we set in the settings
  // endpoint, so the translator recognizes them without looking at the
  // raw exception message.
  if (code === "E_LOW_SPACE") {
    return {
      title: "Not enough free space on that drive",
      cause: "The next backup is expected to be larger than the free space on the chosen drive.",
      next_action: "Free up space or pick a drive with more room.",
      kind: "low-space",
      raw,
    };
  }
  if (code === "E_NOT_WRITABLE") {
    return {
      title: "That folder isn't writable",
      cause: "AdvisePoint Docs tried to write a small test file in the folder and Windows refused.",
      next_action: "Pick a folder you have write access to.",
      kind: "permission",
      raw,
    };
  }
  if (code === "E_DRIVE_MISSING") {
    return {
      title: "Drive isn't connected",
      cause: "The drive letter for that folder isn't currently plugged in.",
      next_action: "Reconnect the drive, or pick a different folder in Backup settings.",
      kind: "drive-missing",
      raw,
    };
  }

  // The archiver interop defect shipped in every packaged release prior
  // to this one. If a future regression puts it back, catch it here so
  // the user sees an app-defect message rather than the raw TypeError.
  if (/\bis not a function\b/i.test(raw)) {
    return {
      title: "Backup couldn't start",
      cause: "This looks like a defect inside AdvisePoint Docs, not something with the drive or folder.",
      next_action: "Send a diagnostics bundle from Settings so it can be fixed.",
      kind: "internal-defect",
      raw,
    };
  }

  return {
    title: "Something went wrong writing the backup",
    cause: "AdvisePoint Docs hit an unexpected error while writing the backup file.",
    next_action: "Try again. If it keeps failing, send a diagnostics bundle from Settings.",
    kind: "unknown",
    raw,
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}
function errorCode(err: unknown): string | null {
  if (err && typeof err === "object" && "code" in err) {
    const c = (err as { code?: unknown }).code;
    if (typeof c === "string") return c;
  }
  return null;
}
function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "\u2026";
}

// Small typed error class so preflight and settings paths can attach a
// stable `code` the translator recognizes.
export class BackupPreflightError extends Error {
  code:
    | "E_DRIVE_MISSING"
    | "E_NOT_WRITABLE"
    | "E_LOW_SPACE";
  constructor(code: BackupPreflightError["code"], message: string) {
    super(message);
    this.name = "BackupPreflightError";
    this.code = code;
  }
}

// -------- Helpers --------

// Best-effort schema version indicator. This ships as a fresh integer at
// this release; older backups will report 0 and are treated as "unknown but
// try to restore." The reader logs a warning on mismatch but does NOT block
// the restore -- our schema is idempotent-forward.
const CURRENT_SCHEMA_VERSION = 1;

function isoNow(): string {
  return new Date().toISOString();
}

function tsForFilename(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/**
 * The canonical scheduled-backup filename. Used verbatim so the retention
 * sweep can find backups it created. Matches manual Export naming so users
 * can share filenames without a mode field.
 */
export function scheduledBackupFilename(): string {
  return `advisepoint-docs-backup-${tsForFilename()}.zip`;
}

// True iff `filename` matches our canonical backup naming, so retention
// only touches files we produced.
export function isBackupFilename(name: string): boolean {
  return /^advisepoint-docs-backup-\d{8}-\d{6}\.zip$/i.test(name);
}

function stagingRoot(): string {
  return join(tmpdir(), "advisepoint-docs-backup-staging");
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

// v1.0.4: exported so the settings endpoint can size the current backup
// contents without duplicating the walk logic.
export function directorySize(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  if (!existsSync(dir)) return { bytes, files };
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        try {
          bytes += statSync(full).size;
          files += 1;
        } catch { /* ignore */ }
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

// v1.0.4: return the on-disk size of the raw content a backup would
// include (DB file + rendered pages tree). The final ZIP is smaller than
// this after compression; the caller layers on a small estimate factor.
// Kept intentionally simple - it does NOT VACUUM the DB or copy files;
// it just stats what's already on disk, so it's cheap to call from a
// settings page render.
export function currentBackupRawSize(): {
  db_bytes: number;
  pages_bytes: number;
  pages_file_count: number;
  original_bytes: number;
  wal_bytes: number;
  shm_bytes: number;
} {
  let db_bytes = 0;
  try {
    if (existsSync(DB_FILE_PATH)) {
      db_bytes = statSync(DB_FILE_PATH).size;
    }
  } catch { /* ignore */ }
  const pagesInfo = directorySize(getPagesDirForBackup());
  const size = (p:string) => {try {return statSync(p).size;} catch {return 0;}};
  return {
    db_bytes,
    pages_bytes: pagesInfo.bytes,
    pages_file_count: pagesInfo.files,
    original_bytes: directorySize(getOriginalsDir()).bytes,
    wal_bytes: size(`${DB_FILE_PATH}-wal`),
    shm_bytes: size(`${DB_FILE_PATH}-shm`),
  };
}

// -------- EXPORT --------

/**
 * Take a consistent snapshot of the current DB using VACUUM INTO. The
 * caller is responsible for deleting the staged file when the backup
 * archive has been fully written.
 */
function vacuumSnapshot(): string {
  const stagingDir = stagingRoot();
  ensureDir(stagingDir);
  const outPath = join(stagingDir, `snapshot-${Date.now()}.db`);
  // VACUUM INTO fails if the target exists.
  if (existsSync(outPath)) rmSync(outPath);
  // better-sqlite3's `exec` runs statements terminated by `;`. VACUUM INTO
  // takes a single quoted path -- escape single quotes for safety even
  // though our path is generated locally.
  const escaped = outPath.replace(/'/g, "''");
  rawDb.exec(`VACUUM INTO '${escaped}'`);
  return outPath;
}

/**
 * Read a few stats off the live DB for the manifest. Cheap.
 */
function readStats(): { document_count: number; chunk_count: number } {
  try {
    const d = rawDb.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number };
    const c = rawDb.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number };
    return { document_count: d?.n ?? 0, chunk_count: c?.n ?? 0 };
  } catch {
    return { document_count: 0, chunk_count: 0 };
  }
}

/**
 * Write a backup archive to the given writable stream. Used by the
 * download endpoint (res is the writable) and by the scheduler
 * (writable is a file stream).
 *
 * Returns the manifest that was embedded in the archive.
 */
export async function writeBackupTo(
  out: Writable,
  opts: { localStorageJson?: string | null } = {},
): Promise<BackupManifest> {
  const snapshot = vacuumSnapshot();
  const pagesDir = getPagesDirForBackup();
  const pagesInfo = directorySize(pagesDir);
  const dbSize = statSync(snapshot).size;
  const stats = readStats();
  const hasLs = typeof opts.localStorageJson === "string" && opts.localStorageJson.length > 0;

  const manifest: BackupManifest = {
    app_version: APP_VERSION,
    schema_version: CURRENT_SCHEMA_VERSION,
    exported_at: isoNow(),
    document_count: stats.document_count,
    chunk_count: stats.chunk_count,
    pages_bytes: pagesInfo.bytes,
    pages_file_count: pagesInfo.files,
    has_localstorage: hasLs,
    db_bytes: dbSize,
  };

  const archive = archiver("zip", { zlib: { level: 6 }, forceZip64: true });

  // Attach a rejection handler so pipe errors surface as promise rejections.
  const done = new Promise<void>((resolveDone, rejectDone) => {
    archive.on("error", (err: Error) => rejectDone(err));
    out.on("error", (err: unknown) => rejectDone(err as Error));
    out.on("close", () => resolveDone());
    out.on("finish", () => resolveDone());
  });

  archive.pipe(out);
  archive.file(snapshot, { name: "db/data.db" });
  if (existsSync(pagesDir)) {
    archive.directory(pagesDir, "pages");
  }
  // v1.0.6: include retained DOCX (and future) originals so a restore
  // brings back not just the extracted text but also the source files
  // that power the client-side docx-preview viewer.
  const originalsDir = getOriginalsDir();
  if (existsSync(originalsDir)) {
    archive.directory(originalsDir, "originals");
  }
  archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });
  if (hasLs) {
    archive.append(opts.localStorageJson as string, { name: "localStorage.json" });
  }
  await archive.finalize();
  await done;

  // Clean up snapshot
  try { rmSync(snapshot); } catch { /* ignore */ }

  return manifest;
}

/**
 * Write a backup to a target file on disk. Used by both the scheduled
 * backup runner and the manual "Back up now to folder" endpoint. The
 * optional `opts.localStorageJson` is included in the archive the same
 * way `writeBackupTo` includes it for the streaming HTTP export.
 * Returns the resulting size and manifest.
 */
export async function writeBackupToFile(
  outPath: string,
  opts: { localStorageJson?: string | null } = {},
): Promise<BackupResult> {
  ensureDir(dirname(outPath));
  const ws = createWriteStream(outPath);
  const manifest = await writeBackupTo(ws, { localStorageJson: opts.localStorageJson ?? null });
  const bytes = statSync(outPath).size;
  return { bytes, manifest, path: outPath };
}

// -------- IMPORT --------

interface StagedImport {
  dir: string;
  dbPath: string;
  pagesDir: string;
  // v1.0.6: retained originals staged directory. Empty string when the
  // backup was taken by a pre-v1.0.6 build.
  originalsDir: string;
  manifest: BackupManifest | null;
  localStoragePath: string | null;
}

/**
 * Extract an uploaded backup zip into a staging directory and return
 * paths to its contents. Caller must call `cleanupStaged(staged)` when done.
 */
export async function stageImport(zipPath: string): Promise<StagedImport> {
  const stagingBase = stagingRoot();
  ensureDir(stagingBase);
  const dir = join(stagingBase, `import-${Date.now()}`);
  ensureDir(dir);

  // Use `yauzl` via a lightweight wrapper if available; but we already ship
  // `archiver` for writing. For reading we use the `unzipper` package if
  // present, or fall back to a minimal Node solution. To avoid adding a
  // second dependency, use `adm-zip` if it's on disk, otherwise use a
  // stream-based `yauzl` -- but archiver does NOT provide a reader.
  //
  // Approach: use `node:zlib` + minimal ZIP parser. This is a headache to
  // do from scratch. Given the constraint, we use the `unzipper` npm
  // package that ships transitively via multer's parent tree -- but that's
  // not guaranteed. Simplest reliable option: shell out to PowerShell's
  // Expand-Archive on Windows (guaranteed present on Win10+), which our
  // production target is. Fall back to `unzip` on POSIX for dev.
  //
  // We use a small, dependency-free pure-JS extractor implemented below
  // that handles ZIP64 central-directory format.
  await extractZipTo(zipPath, dir);

  const dbPath = join(dir, "db", "data.db");
  const pagesDir = join(dir, "pages");
  // v1.0.6: retained-originals directory; absent in pre-v1.0.6 backups.
  const originalsDir = join(dir, "originals");
  const manifestPath = join(dir, "manifest.json");
  const lsPath = join(dir, "localStorage.json");

  let manifest: BackupManifest | null = null;
  if (existsSync(manifestPath)) {
    try {
      const raw = readFileText(manifestPath);
      manifest = JSON.parse(raw) as BackupManifest;
    } catch { /* leave as null; downstream treats null as unknown */ }
  }

  return {
    dir,
    dbPath: existsSync(dbPath) ? dbPath : "",
    pagesDir: existsSync(pagesDir) ? pagesDir : "",
    originalsDir: existsSync(originalsDir) ? originalsDir : "",
    manifest,
    localStoragePath: existsSync(lsPath) ? lsPath : null,
  };
}

export function cleanupStaged(staged: StagedImport): void {
  try { rmSync(staged.dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** Retained PDFs are required library data, not a disposable render cache.
 * Check them before restoring or allowing backup retention to prune archives.
 * Older image-only databases need no originals and remain compatible.
 */
export function verifyRetainedPdfs(dbPath: string, originalsDir: string): Map<string,string> {
  const db = new Database(dbPath, {readonly:true, fileMustExist:true});
  const hashes = new Map<string,string>();
  try {
    const columns = db.prepare("PRAGMA table_info(documents)").all() as {name:string}[];
    if (!columns.some(c=>c.name==="original_ext")) return hashes;
    const docs = db.prepare("SELECT id FROM documents WHERE original_ext='pdf'").all() as {id:string}[];
    for (const {id} of docs) {
      if (!/^[A-Za-z0-9_-]+$/.test(id) || !originalsDir) throw Error("Backup is missing a required retained PDF.");
      const file = join(originalsDir, `${id}.pdf`);
      const st = lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink()) throw Error("Invalid retained PDF in backup.");
      const fd = openSync(file,"r");
      const hash = createHash("sha256");
      try {
        const buffer = Buffer.alloc(1024*1024);
        let bytes = readSync(fd,buffer,0,buffer.length,null);
        if (!bytes || !buffer.subarray(0,Math.min(bytes,1024)).includes(Buffer.from("%PDF-"))) throw Error("Invalid retained PDF header.");
        do { hash.update(buffer.subarray(0,bytes)); bytes=readSync(fd,buffer,0,buffer.length,null); } while(bytes);
      } finally { closeSync(fd); }
      hashes.set(id,hash.digest("hex"));
    }
    return hashes;
  } finally {db.close();}
}

/**
 * Wipe-and-Replace: current DB and pages/ are renamed to .bak-<ts>, then
 * the staged copies are moved into place. Callers should have already
 * closed the DB connection before invoking this so Windows can rename
 * the .db file.
 */
export interface VerifyResult {
  ok: boolean;
  problems: string[];
  documents: number;
  chunks: number;
  page_files: number;
}

/** Recursive file count, used to prove a page tree copied completely. */
function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(join(dir, entry.name));
    else n += 1;
  }
  return n;
}

/**
 * v1.0.12.3 — prove a database file is intact and plausible BEFORE it is
 * allowed to replace live data.
 *
 * Opens the file read-only in its own connection and runs a full
 * integrity_check, then confirms the expected tables exist and reads the row
 * counts. When a manifest is available the counts must match it, which catches
 * a truncated or partially written archive that still happens to open.
 */
export function verifyDatabaseFile(dbPath: string, manifest: BackupManifest | null): VerifyResult {
  const problems: string[] = [];
  let documents = -1;
  let chunks = -1;

  if (!existsSync(dbPath)) {
    return { ok: false, problems: ["database file is missing"], documents, chunks, page_files: 0 };
  }
  try {
    const size = statSync(dbPath).size;
    if (size === 0) problems.push("database file is empty");
  } catch {
    problems.push("database file could not be read");
  }

  let probe: import("better-sqlite3").Database | null = null;
  try {
    probe = new Database(dbPath, { readonly: true, fileMustExist: true });
    const integrity = probe.pragma("integrity_check") as Array<{ integrity_check: string }>;
    const verdict = integrity?.[0]?.integrity_check ?? "unknown";
    if (verdict !== "ok") problems.push(`database failed integrity check: ${verdict}`);

    const tables = new Set(
      (probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
        .map((r) => r.name),
    );
    for (const required of ["documents", "chunks"]) {
      if (!tables.has(required)) problems.push(`database is missing the ${required} table`);
    }
    if (tables.has("documents")) {
      documents = (probe.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n;
    }
    if (tables.has("chunks")) {
      chunks = (probe.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
    }
  } catch (err) {
    problems.push(`database could not be opened: ${(err as Error).message || String(err)}`);
  } finally {
    try { probe?.close(); } catch { /* ignore */ }
  }

  if (manifest) {
    if (typeof manifest.document_count === "number" && documents >= 0 && manifest.document_count !== documents) {
      problems.push(`document count mismatch: backup says ${manifest.document_count}, file contains ${documents}`);
    }
    if (typeof manifest.chunk_count === "number" && chunks >= 0 && manifest.chunk_count !== chunks) {
      problems.push(`chunk count mismatch: backup says ${manifest.chunk_count}, file contains ${chunks}`);
    }
  }

  return { ok: problems.length === 0, problems, documents, chunks, page_files: 0 };
}

/**
 * v1.0.12.3 — wipe-and-replace restore, rebuilt so live data is never
 * overwritten by anything unverified.
 *
 * The previous version moved the live database aside and copied the staged
 * file over the top with no verification of either side, and without closing
 * the database first -- so on Windows the very first rename failed and the
 * restore could not succeed at all.
 *
 * Order of operations now:
 *   1. Verify the staged database (integrity_check + counts vs manifest).
 *      Refuse before touching anything if it fails.
 *   2. Assemble the complete new data set in a temp folder beside the live
 *      data, then verify the ASSEMBLED copy -- this catches a copy that was
 *      truncated on the way in, and the page file count must match.
 *   3. Close the database so the file can be moved on Windows.
 *   4. Move the current data into a timestamped .bak folder, which is never
 *      deleted or reused.
 *   5. Move the verified temp folder into place.
 *   6. Verify the now-live database again. If anything failed after step 4,
 *      roll the .bak contents back and report failure.
 */
/**
 * v1.0.12.3 — is this backup archive provably restorable?
 *
 * Retention used to delete older backups purely by count and date. If the
 * newest archives were damaged, that quietly destroyed the last good copy the
 * user had. Nothing is pruned now unless a newer archive passes the same
 * verification a restore would demand, so an unverifiable backup can only
 * ever accumulate, never displace a known-good one.
 */
export async function verifyBackupArchiveFile(zipPath: string): Promise<VerifyResult> {
  let staged: StagedImport | null = null;
  try {
    staged = await stageImport(zipPath);
    verifyRetainedPdfs(staged.dbPath, staged.originalsDir);
    return verifyDatabaseFile(staged.dbPath, staged.manifest);
  } catch (err) {
    return {
      ok: false,
      problems: [`archive could not be read: ${(err as Error).message}`],
      documents: -1,
      chunks: -1,
      page_files: 0,
    };
  } finally {
    if (staged) {
      try { cleanupStaged(staged); } catch { /* best effort */ }
    }
  }
}

export function importWipeReplace(staged: StagedImport): { bak_dir: string; verified: VerifyResult } {
  if (!staged.dbPath) throw new Error("Backup is missing db/data.db");
  const incomingPdfs = verifyRetainedPdfs(staged.dbPath, staged.originalsDir);

  const dataDir = getDataDirForBackup();
  const currentDb = DB_FILE_PATH;
  const currentPages = getPagesDirForBackup();
  const currentOriginals = getOriginalsDir();

  // ---- 1. Verify what arrived, before anything is at risk. --------------
  const incoming = verifyDatabaseFile(staged.dbPath, staged.manifest ?? null);
  if (!incoming.ok) {
    throw new Error(
      `Refusing to restore: the backup did not pass verification. ${incoming.problems.join("; ")}. ` +
      `Your current library has not been modified.`,
    );
  }

  const ts = tsForFilename();
  const bakDir = `${dataDir}${`.bak-${ts}`}`;
  const newDir = join(dataDir, `.restore-verify-${ts}`);
  const stagedPageCount = staged.pagesDir ? countFiles(staged.pagesDir) : 0;

  // ---- 2. Assemble and verify the new data set off to one side. ---------
  try {
    if (existsSync(newDir)) rmSync(newDir, { recursive: true, force: true });
    ensureDir(newDir);
    const newDb = join(newDir, basename(currentDb));
    copyFileSync(staged.dbPath, newDb);
    if (staged.pagesDir) copyDirRecursive(staged.pagesDir, join(newDir, "pages"));
    if (staged.originalsDir) copyDirRecursive(staged.originalsDir, join(newDir, "originals"));

    const assembled = verifyDatabaseFile(newDb, staged.manifest ?? null);
    const assembledPdfs = verifyRetainedPdfs(newDb, join(newDir,"originals"));
    for (const [id,hash] of incomingPdfs) {
      if (assembledPdfs.get(id)!==hash) throw Error("Retained PDF did not copy intact.");
    }
    const assembledPages = countFiles(join(newDir, "pages"));
    if (!assembled.ok) {
      throw new Error(
        `the staged copy did not verify (${assembled.problems.join("; ")})`,
      );
    }
    if (assembledPages !== stagedPageCount) {
      throw new Error(
        `page images did not copy completely (expected ${stagedPageCount}, got ${assembledPages})`,
      );
    }
    if (
      staged.manifest &&
      typeof staged.manifest.pages_file_count === "number" &&
      staged.manifest.pages_file_count !== assembledPages
    ) {
      throw new Error(
        `page image count mismatch: backup says ${staged.manifest.pages_file_count}, found ${assembledPages}`,
      );
    }
    incoming.page_files = assembledPages;
  } catch (err) {
    try { rmSync(newDir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw new Error(
      `Refusing to restore: ${(err as Error).message || String(err)}. ` +
      `Your current library has not been modified.`,
    );
  }

  // ---- 3. Close the database so the live file can be moved. -------------
  // Past this point the process must not query the DB; the caller reports
  // restart_required.
  closeDbForRestore();

  // ---- 4. Set the current data aside. ----------------------------------
  ensureDir(bakDir);
  const movedBack: Array<[string, string]> = [];
  const moveAside = (src: string, destName: string) => {
    if (!existsSync(src)) return;
    const dest = join(bakDir, destName);
    renameSync(src, dest);
    movedBack.push([dest, src]);
  };

  const rollback = (why: string): never => {
    // Put the original data back exactly where it came from. The .bak folder
    // is left in place either way; it is never deleted.
    for (const [from, to] of movedBack) {
      try {
        if (existsSync(to)) rmSync(to, { recursive: true, force: true });
        renameSync(from, to);
      } catch (err) {
        console.error(`[BACKUP] rollback could not restore ${to}:`, err);
      }
    }
    throw new Error(
      `Restore failed and your previous library was put back: ${why}. ` +
      `A copy of everything involved is in ${bakDir}. Restart the application.`,
    );
  };

  try {
    moveAside(currentDb, basename(currentDb));
    for (const sfx of ["-wal", "-shm"]) {
      moveAside(`${currentDb}${sfx}`, `${basename(currentDb)}${sfx}`);
    }
    moveAside(currentPages, "pages");
    moveAside(currentOriginals, "originals");
  } catch (err) {
    rollback(`the current library could not be set aside (${(err as Error).message || String(err)})`);
  }

  // ---- 5. Move the verified data into place. ----------------------------
  try {
    renameSync(join(newDir, basename(currentDb)), currentDb);
    if (existsSync(join(newDir, "pages"))) renameSync(join(newDir, "pages"), currentPages);
    if (existsSync(join(newDir, "originals"))) renameSync(join(newDir, "originals"), currentOriginals);
  } catch (err) {
    rollback(`the verified data could not be moved into place (${(err as Error).message || String(err)})`);
  }

  // ---- 6. Verify what is now live. --------------------------------------
  const live = verifyDatabaseFile(currentDb, staged.manifest ?? null);
  const livePages = countFiles(currentPages);
  if (!live.ok) {
    rollback(`the restored database did not verify in place (${live.problems.join("; ")})`);
  }
  if (livePages !== incoming.page_files) {
    rollback(`page images are incomplete after the swap (expected ${incoming.page_files}, found ${livePages})`);
  }
  live.page_files = livePages;

  try { rmSync(newDir, { recursive: true, force: true }); } catch { /* ignore */ }

  return { bak_dir: bakDir, verified: live };
}

/**
 * Merge: additive with skip-on-collision. Attach the staged DB as a
 * second connection and INSERT ... SELECT any documents whose id is
 * NOT already present in the live database. Chunks, page rows, and
 * page/original files follow the same rule: if their parent document
 * id already exists in live, they are skipped entirely because the
 * live copy is authoritative.
 *
 * v1.0.11.4: prior releases did the opposite -- they detected an id
 * collision and remapped the incoming row to a fresh UUID, which
 * meant restoring a backup on top of its own live database produced
 * a duplicate of every single document. That is not what "merge"
 * means; it should skip anything that already exists.
 *
 * Content-hash-based dedupe for documents that legitimately have
 * different ids but identical content is intentionally NOT performed
 * here; that would need a separate content hash and is deferred to a
 * future release.
 */
export function importMerge(staged: StagedImport): { documents_imported: number; chunks_imported: number; pages_files_copied: number; snapshot: string | null } {
  if (!staged.dbPath) throw new Error("Backup is missing db/data.db");
  verifyRetainedPdfs(staged.dbPath, staged.originalsDir);

  // v1.0.12.3 - verify before attaching. A corrupt backup attached to the
  // live connection can fail mid-transaction, and a merge writes directly
  // into the live database, so the check has to happen first.
  const incoming = verifyDatabaseFile(staged.dbPath, staged.manifest ?? null);
  if (!incoming.ok) {
    throw new Error(
      `Refusing to merge: the backup did not pass verification. ${incoming.problems.join("; ")}. ` +
      `Your current library has not been modified.`,
    );
  }

  // v1.0.12.3 - snapshot the live database first so a merge is reversible.
  // VACUUM INTO writes a consistent copy without closing the connection.
  let snapshot: string | null = null;
  try {
    const snapDir = join(getDataDirForBackup(), `.pre-merge-${tsForFilename()}`);
    ensureDir(snapDir);
    const snapPath = join(snapDir, basename(DB_FILE_PATH));
    rawDb.exec(`VACUUM INTO '${snapPath.replace(/'/g, "''")}'`);
    snapshot = snapPath;
  } catch (err) {
    // A merge only ever adds rows, but without a snapshot there is no undo,
    // so refuse rather than proceed unprotected.
    throw new Error(
      `Refusing to merge: could not snapshot the current library first ` +
      `(${(err as Error).message || String(err)}). Nothing has been modified.`,
    );
  }

  // Attach the staged DB to the live connection as `bkp`.
  const staged_escaped = staged.dbPath.replace(/'/g, "''");
  rawDb.exec(`ATTACH DATABASE '${staged_escaped}' AS bkp`);

  let documents_imported = 0;
  let chunks_imported = 0;
  // Set of backup document ids we actually imported this run. Chunks,
  // page rows, and file copies below are only applied for docs in
  // this set -- if a doc was skipped because it already exists live,
  // its associated rows and files must be skipped too so we do not
  // touch or overwrite anything on the live side.
  const importedDocIds = new Set<string>();

  try {
    const tx = rawDb.transaction(() => {
      // 1. Decide which backup docs to import: only those whose id is
      //    NOT already present in the live database.
      const bkpDocIds = rawDb.prepare("SELECT id FROM bkp.documents").all() as { id: string }[];
      const liveHasDoc = rawDb.prepare("SELECT 1 FROM documents WHERE id = ?");
      for (const d of bkpDocIds) {
        const collides = liveHasDoc.get(d.id) as unknown;
        if (!collides) importedDocIds.add(String(d.id));
      }

      // 2. Insert only new documents. Column list must match the live
      //    schema; SELECT * would fail on any schema drift so we
      //    enumerate columns explicitly from the live table.
      const docCols = tableColumns("documents");
      const bkpDocCols = tableColumns("bkp.documents");
      const sharedDocCols = docCols.filter((c) => bkpDocCols.includes(c));
      const bkpDocRows = rawDb.prepare(
        `SELECT ${sharedDocCols.map((c) => `"${c}"`).join(", ")} FROM bkp.documents`,
      ).all() as Record<string, unknown>[];
      const insDoc = rawDb.prepare(
        `INSERT OR IGNORE INTO documents (${sharedDocCols.map((c) => `"${c}"`).join(", ")}) ` +
        `VALUES (${sharedDocCols.map(() => "?").join(", ")})`,
      );
      for (const row of bkpDocRows) {
        if (!importedDocIds.has(String(row.id))) continue;
        const vals = sharedDocCols.map((c) => row[c] as any);
        insDoc.run(...vals);
        documents_imported += 1;
      }

      // 3. Chunks: import only rows whose document_id is in the
      //    just-imported set. Chunks whose parent doc already existed
      //    in live are skipped entirely; live's chunks are authoritative.
      const chunkCols = tableColumns("chunks");
      const bkpChunkCols = tableColumns("bkp.chunks");
      const sharedChunkCols = chunkCols.filter((c) => bkpChunkCols.includes(c));
      // Chunks link to documents via one of two column names depending
      // on how old the schema is: legacy "document_id" or current
      // "parent_id". Pick whichever this build actually uses so we
      // filter correctly. If neither is present, the schema is
      // unrecognised and we skip chunk import entirely -- inserting
      // chunks with no FK to filter on could smuggle orphans onto live.
      const chunkFk = sharedChunkCols.includes("parent_id")
        ? "parent_id"
        : (sharedChunkCols.includes("document_id") ? "document_id" : null);
      const bkpChunkRows = chunkFk
        ? rawDb.prepare(
            `SELECT ${sharedChunkCols.map((c) => `"${c}"`).join(", ")} FROM bkp.chunks`,
          ).all() as Record<string, unknown>[]
        : [];
      const insChunk = rawDb.prepare(
        `INSERT OR IGNORE INTO chunks (${sharedChunkCols.map((c) => `"${c}"`).join(", ")}) ` +
        `VALUES (${sharedChunkCols.map(() => "?").join(", ")})`,
      );
      for (const row of bkpChunkRows) {
        const parent = String(row[chunkFk!]);
        if (!importedDocIds.has(parent)) continue;
        const vals = sharedChunkCols.map((c) => row[c] as any);
        insChunk.run(...vals);
        chunks_imported += 1;
      }

      // 4. Optional companion tables. Same rule: only rows whose
      //    parent doc was actually imported this run.
      for (const table of ["document_pages", "document_render_status"]) {
        if (!tableExists(table) || !tableExists(`bkp.${table}`)) continue;
        const cols = tableColumns(table);
        const bkpCols = tableColumns(`bkp.${table}`);
        const shared = cols.filter((c) => bkpCols.includes(c));
        if (shared.length === 0) continue;
        const fk = shared.includes("document_id")
          ? "document_id"
          : (shared.includes("parent_id") ? "parent_id" : null);
        if (!fk) continue;
        const rows = rawDb.prepare(
          `SELECT ${shared.map((c) => `"${c}"`).join(", ")} FROM bkp.${table}`,
        ).all() as Record<string, unknown>[];
        const ins = rawDb.prepare(
          `INSERT OR IGNORE INTO ${table} (${shared.map((c) => `"${c}"`).join(", ")}) ` +
          `VALUES (${shared.map(() => "?").join(", ")})`,
        );
        for (const row of rows) {
          const parent = String(row[fk]);
          if (!importedDocIds.has(parent)) continue;
          const vals = shared.map((c) => row[c] as any);
          ins.run(...vals);
        }
      }
      // Retained originals must be copied before the row transaction commits.
      // Never overwrite an existing file, including an orphan from an earlier
      // failed restore. A failure rolls back the rows rather than reporting a
      // successful merge with missing PDF bytes.
      if (staged.originalsDir && existsSync(staged.originalsDir)) {
        const liveOriginals=getOriginalsDir();
        ensureDir(liveOriginals);
        for (const entry of readdirSync(staged.originalsDir,{withFileTypes:true})) {
          const m=/^([A-Za-z0-9_-]+)\.([A-Za-z0-9]+)$/.exec(entry.name);
          if (!entry.isFile() || !m || !importedDocIds.has(m[1])) continue;
          const src=join(staged.originalsDir,entry.name), dst=join(liveOriginals,entry.name);
          const sourceHash=createHash("sha256").update(readFileSync(src)).digest("hex");
          if (!existsSync(dst)) copyFileSync(src,dst,constants.COPYFILE_EXCL);
          if (lstatSync(dst).isSymbolicLink() ||
              createHash("sha256").update(readFileSync(dst)).digest("hex")!==sourceHash)
            throw Error("Retained original copy failed verification; merge rows were not committed.");
        }
      }
    });
    tx();
  } finally {
    try { rawDb.exec("DETACH DATABASE bkp"); } catch { /* ignore */ }
  }

  // 6. Copy page images ONLY for docs we just imported. Same rule.
  let pages_files_copied = 0;
  if (staged.pagesDir && existsSync(staged.pagesDir)) {
    const livePages = getPagesDirForBackup();
    ensureDir(livePages);
    for (const docDir of readdirSync(staged.pagesDir, { withFileTypes: true })) {
      if (!docDir.isDirectory()) continue;
      const srcDocId = docDir.name;
      if (!importedDocIds.has(srcDocId)) continue;
      const src = join(staged.pagesDir, srcDocId);
      const dst = join(livePages, srcDocId);
      ensureDir(dst);
      for (const entry of readdirSync(src, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const s = join(src, entry.name);
        const d = join(dst, entry.name);
        try {
          copyFileSync(s, d);
          pages_files_copied += 1;
        } catch { /* skip individual failures */ }
      }
    }
  }

  // 7. v1.2.1: normalize document_pages.image_path for the docs we just
  // imported. The backup DB carries the exporter's absolute paths (e.g.
  // C:\Users\<other-user>\AppData\Roaming\AdvisePoint Docs\pages\...);
  // rewrite them to point at this machine's pages directory so the read
  // path serves images without waiting for the next boot heal. Uses the
  // filename in the stored path so legacy .jpg renders keep their
  // extension. Docs whose parent was skipped keep their existing rows.
  if (importedDocIds.size > 0) {
    const livePages = getPagesDirForBackup();
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
      if (!importedDocIds.has(r.document_id)) continue;
      const base = basename(r.image_path);
      if (!base) continue;
      const newPath = join(livePages, r.document_id, base);
      if (newPath === r.image_path) continue;
      updates.push({ rowid: r.rowid, newPath });
    }
    if (updates.length > 0) tx(updates);
  }

  return { documents_imported, chunks_imported, pages_files_copied, snapshot };
}

// -------- Small helpers --------

function tableColumns(qualified: string): string[] {
  // v1.0.11.3: SQLite rejects `PRAGMA table_info(schema.table)` with
  // `near ".": syntax error`. The correct form for a non-main schema
  // is `PRAGMA <schema>.table_info(<table>)`. Prior releases emitted
  // the invalid syntax, which broke merge restore in every published
  // build (wipe-replace was unaffected because it never called this
  // for the attached `bkp` schema).
  let sql: string;
  if (qualified.includes(".")) {
    const [schema, name] = qualified.split(".");
    sql = `PRAGMA "${schema}".table_info("${name}")`;
  } else {
    sql = `PRAGMA table_info("${qualified}")`;
  }
  const rows = rawDb.prepare(sql).all() as { name: string }[];
  return rows.map((r) => r.name);
}

function tableExists(qualified: string): boolean {
  const [schema, name] = qualified.includes(".") ? qualified.split(".") : ["main", qualified];
  try {
    const row = rawDb.prepare(
      `SELECT name FROM ${schema}.sqlite_master WHERE type='table' AND name = ?`,
    ).get(name) as { name?: string } | undefined;
    return !!row?.name;
  } catch {
    return false;
  }
}

function cryptoRandomId(): string {
  const bytes = new Uint8Array(16);
  // node:crypto is present at runtime; import inline to avoid a top-level dep tree bump.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require("node:crypto").randomFillSync(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function readFileText(path: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("node:fs").readFileSync(path, "utf8");
}

function copyDirRecursive(src: string, dst: string): void {
  ensureDir(dst);
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dst, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else if (entry.isFile()) copyFileSync(s, d);
  }
}

// -------- Minimal ZIP reader (ZIP64-aware) --------
// We don't want a whole new dependency for reading. This handles the
// subset of ZIP produced by `archiver`: STORE and DEFLATE, standard and
// ZIP64 central-directory records.

// v1.0.11.2: extractZipTo previously ran fully synchronously --
// readSync + inflateRawSync + writeFileSync for every entry in the
// backup ZIP. On a large backup the loop was blocked for seconds at a
// time, which made /api/health miss its 3.5s poll deadline and
// tripped the reconnecting banner during Restore. The rewrite below
// keeps the same pure-JS ZIP parser (no new dependency, no worker
// thread) but yields the event loop between entries, uses async fs
// I/O, and offloads deflate to zlib's async form. This lets
// /api/health stay responsive while a restore is running.
async function extractZipTo(zipPath: string, outDir: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { openSync, readSync, closeSync, statSync: st } = require("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const zlib = require("node:zlib");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fsp = require("node:fs/promises");
  const { promisify } = require("node:util");
  const inflateRaw: (buf: Buffer) => Promise<Buffer> = promisify(zlib.inflateRaw);
  // Yield the loop between entries so health polls can slip in.
  const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

  const fd = openSync(zipPath, "r");
  try {
    const size = st(zipPath).size as number;

    // 1. Find End of Central Directory (EOCD) by scanning last 64 KiB.
    const searchLen = Math.min(size, 66_000);
    const tail = Buffer.alloc(searchLen);
    readSync(fd, tail, 0, searchLen, size - searchLen);
    let eocdOff = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocdOff = i; break; }
    }
    if (eocdOff < 0) throw new Error("EOCD signature not found; not a zip");

    let cdOffset = tail.readUInt32LE(eocdOff + 16);
    let cdSize = tail.readUInt32LE(eocdOff + 12);
    let totalEntries = tail.readUInt16LE(eocdOff + 10);

    // 2. If ZIP64 markers present, upgrade cdOffset/cdSize.
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff || totalEntries === 0xffff) {
      // Find ZIP64 EOCD locator (20 bytes) just before EOCD.
      const locatorOff = eocdOff - 20;
      if (locatorOff < 0 || tail.readUInt32LE(locatorOff) !== 0x07064b50) {
        throw new Error("ZIP64 markers set but locator not found");
      }
      const z64eocdOff = Number(tail.readBigUInt64LE(locatorOff + 8));
      const hdr = Buffer.alloc(56);
      readSync(fd, hdr, 0, 56, z64eocdOff);
      if (hdr.readUInt32LE(0) !== 0x06064b50) throw new Error("ZIP64 EOCD signature bad");
      totalEntries = Number(hdr.readBigUInt64LE(32));
      cdSize = Number(hdr.readBigUInt64LE(40));
      cdOffset = Number(hdr.readBigUInt64LE(48));
    }

    // 3. Read central directory in one shot.
    const cd = Buffer.alloc(cdSize);
    readSync(fd, cd, 0, cdSize, cdOffset);

    let p = 0;
    for (let i = 0; i < totalEntries; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error(`CD entry ${i} bad signature`);
      const gpFlag = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      let compSize = cd.readUInt32LE(p + 20);
      let uncompSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localHeaderOff = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString(gpFlag & 0x800 ? "utf8" : "utf8");

      // Read ZIP64 extra field if any of the sizes/offset are 0xffffffff.
      if (compSize === 0xffffffff || uncompSize === 0xffffffff || localHeaderOff === 0xffffffff) {
        const extraStart = p + 46 + nameLen;
        let ep = extraStart;
        const extraEnd = extraStart + extraLen;
        while (ep + 4 <= extraEnd) {
          const tag = cd.readUInt16LE(ep);
          const size = cd.readUInt16LE(ep + 2);
          if (tag === 0x0001) {
            let q = ep + 4;
            if (uncompSize === 0xffffffff) { uncompSize = Number(cd.readBigUInt64LE(q)); q += 8; }
            if (compSize === 0xffffffff) { compSize = Number(cd.readBigUInt64LE(q)); q += 8; }
            if (localHeaderOff === 0xffffffff) { localHeaderOff = Number(cd.readBigUInt64LE(q)); q += 8; }
            break;
          }
          ep += 4 + size;
        }
      }

      // Advance to next CD entry.
      p += 46 + nameLen + extraLen + commentLen;

      // Skip directories.
      if (name.endsWith("/")) continue;

      // Read local file header at localHeaderOff to know its variable-length fields.
      const lh = Buffer.alloc(30);
      readSync(fd, lh, 0, 30, localHeaderOff);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error(`LFH bad signature for ${name}`);
      const lhNameLen = lh.readUInt16LE(26);
      const lhExtraLen = lh.readUInt16LE(28);
      const dataStart = localHeaderOff + 30 + lhNameLen + lhExtraLen;

      // Read compressed data.
      const compBuf = Buffer.alloc(compSize);
      readSync(fd, compBuf, 0, compSize, dataStart);

      let raw: Buffer;
      if (method === 0) raw = compBuf;
      else if (method === 8) raw = await inflateRaw(compBuf);
      else throw new Error(`Unsupported compression method ${method} for ${name}`);

      // Path traversal guard.
      if (name.includes("..") || name.startsWith("/") || /[a-zA-Z]:/.test(name)) {
        throw new Error(`Refusing to extract suspicious path: ${name}`);
      }

      const outPath = join(outDir, name);
      ensureDir(dirname(outPath));
      // Async write + a setImmediate yield so /api/health can be
      // serviced between entries even inside a tight per-file loop.
      await fsp.writeFile(outPath, raw);
      await yieldLoop();
    }
  } finally {
    closeSync(fd);
  }
}
