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
import { copyFileSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { pipeline } from "node:stream/promises";
import type { Writable } from "node:stream";
import Database from "better-sqlite3";
// archiver's typings expose it as a callable module. Under
// esModuleInterop, `import archiver from "archiver"` works at runtime
// but the CJS module has no default export in its .d.ts, so we import
// the namespace and re-alias to a callable. This yields the correct
// return type without needing @ts-ignore.
import * as archiverNs from "archiver";
const archiver = archiverNs as unknown as (
  format: "zip" | "tar",
  options?: archiverNs.ArchiverOptions,
) => archiverNs.Archiver;

import { DB_FILE_PATH, getPagesDirForBackup, getDataDirForBackup, rawDb } from "./storage";
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

function directorySize(dir: string): { bytes: number; files: number } {
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
 * Write a backup to a target file on disk. Used by the scheduled backup
 * runner. Returns the resulting size and manifest.
 */
export async function writeBackupToFile(outPath: string): Promise<BackupResult> {
  ensureDir(dirname(outPath));
  const ws = createWriteStream(outPath);
  const manifest = await writeBackupTo(ws);
  const bytes = statSync(outPath).size;
  return { bytes, manifest, path: outPath };
}

// -------- IMPORT --------

interface StagedImport {
  dir: string;
  dbPath: string;
  pagesDir: string;
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
    manifest,
    localStoragePath: existsSync(lsPath) ? lsPath : null,
  };
}

export function cleanupStaged(staged: StagedImport): void {
  try { rmSync(staged.dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Wipe-and-Replace: current DB and pages/ are renamed to .bak-<ts>, then
 * the staged copies are moved into place. Callers should have already
 * closed the DB connection before invoking this so Windows can rename
 * the .db file.
 */
export function importWipeReplace(staged: StagedImport): { bak_dir: string } {
  if (!staged.dbPath) throw new Error("Backup is missing db/data.db");

  const dataDir = getDataDirForBackup();
  const currentDb = DB_FILE_PATH;
  const currentPages = getPagesDirForBackup();

  const bakSuffix = `.bak-${tsForFilename()}`;
  const bakDir = `${dataDir}${bakSuffix}`;

  // Move current data folder wholesale to a sibling .bak-* directory. On
  // Windows a rename fails across filesystems, but data.db and pages/ are
  // colocated by default so a single parent-rename does it in one hop.
  //
  // NOTE: We cannot rename the *parent* data dir because the DB file was
  // just closed; the folder may still contain server logs, WAL/SHM etc.
  // So we move file-by-file, DB + pages only, into a sibling folder.
  ensureDir(bakDir);

  if (existsSync(currentDb)) {
    renameSync(currentDb, join(bakDir, basename(currentDb)));
    // Also move sidecar WAL/SHM if they were present.
    for (const sfx of ["-wal", "-shm"]) {
      const p = `${currentDb}${sfx}`;
      if (existsSync(p)) renameSync(p, join(bakDir, `${basename(currentDb)}${sfx}`));
    }
  }
  if (existsSync(currentPages)) {
    renameSync(currentPages, join(bakDir, "pages"));
  }

  // Move staged content into place.
  copyFileSync(staged.dbPath, currentDb);
  if (staged.pagesDir) {
    copyDirRecursive(staged.pagesDir, currentPages);
  }

  return { bak_dir: bakDir };
}

/**
 * Merge: additive. Attach the staged DB as a second connection, INSERT
 * ... SELECT into every table we know about, then copy any pages/**
 * files that the current install doesn't already have.
 *
 * ID collisions are resolved by remapping the imported row to a fresh
 * UUID; the corresponding page files get renamed too.
 *
 * Duplicate detection is deliberately NOT performed (per user spec).
 */
export function importMerge(staged: StagedImport): { documents_imported: number; chunks_imported: number; pages_files_copied: number } {
  if (!staged.dbPath) throw new Error("Backup is missing db/data.db");

  // Attach the staged DB to the live connection as `bkp`.
  const staged_escaped = staged.dbPath.replace(/'/g, "''");
  rawDb.exec(`ATTACH DATABASE '${staged_escaped}' AS bkp`);

  let documents_imported = 0;
  let chunks_imported = 0;
  const idRemap = new Map<string, string>();

  try {
    const tx = rawDb.transaction(() => {
      // Read every doc from bkp; if the id already exists in live, remap.
      const bkpDocs = rawDb.prepare("SELECT id FROM bkp.documents").all() as { id: string }[];
      const liveHasDoc = rawDb.prepare("SELECT 1 FROM documents WHERE id = ?");
      for (const d of bkpDocs) {
        const collides = liveHasDoc.get(d.id) as unknown;
        if (collides) idRemap.set(d.id, cryptoRandomId());
      }

      // Insert documents (remap id where needed). Column list must match
      // the live schema; SELECT * would fail on any schema drift so we
      // enumerate columns explicitly from the live table.
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
        const newId = idRemap.get(String(row.id)) ?? row.id;
        row.id = newId;
        const vals = sharedDocCols.map((c) => row[c] as any);
        insDoc.run(...vals);
        documents_imported += 1;
      }

      // Chunks reference document_id; remap alongside.
      const chunkCols = tableColumns("chunks");
      const bkpChunkCols = tableColumns("bkp.chunks");
      const sharedChunkCols = chunkCols.filter((c) => bkpChunkCols.includes(c));
      const hasDocFk = sharedChunkCols.includes("document_id");
      const bkpChunkRows = rawDb.prepare(
        `SELECT ${sharedChunkCols.map((c) => `"${c}"`).join(", ")} FROM bkp.chunks`,
      ).all() as Record<string, unknown>[];
      const insChunk = rawDb.prepare(
        `INSERT OR IGNORE INTO chunks (${sharedChunkCols.map((c) => `"${c}"`).join(", ")}) ` +
        `VALUES (${sharedChunkCols.map(() => "?").join(", ")})`,
      );
      for (const row of bkpChunkRows) {
        if (hasDocFk) {
          const oldDocId = String(row.document_id);
          const remapped = idRemap.get(oldDocId);
          if (remapped) row.document_id = remapped;
        }
        const vals = sharedChunkCols.map((c) => row[c] as any);
        insChunk.run(...vals);
        chunks_imported += 1;
      }

      // Optional: document_pages, document_render_status if they exist.
      for (const table of ["document_pages", "document_render_status"]) {
        if (!tableExists(table) || !tableExists(`bkp.${table}`)) continue;
        const cols = tableColumns(table);
        const bkpCols = tableColumns(`bkp.${table}`);
        const shared = cols.filter((c) => bkpCols.includes(c));
        if (shared.length === 0) continue;
        const hasFk = shared.includes("document_id");
        const rows = rawDb.prepare(
          `SELECT ${shared.map((c) => `"${c}"`).join(", ")} FROM bkp.${table}`,
        ).all() as Record<string, unknown>[];
        const ins = rawDb.prepare(
          `INSERT OR IGNORE INTO ${table} (${shared.map((c) => `"${c}"`).join(", ")}) ` +
          `VALUES (${shared.map(() => "?").join(", ")})`,
        );
        for (const row of rows) {
          if (hasFk) {
            const oldDocId = String(row.document_id);
            const remapped = idRemap.get(oldDocId);
            if (remapped) row.document_id = remapped;
          }
          const vals = shared.map((c) => row[c] as any);
          ins.run(...vals);
        }
      }
    });
    tx();
  } finally {
    try { rawDb.exec("DETACH DATABASE bkp"); } catch { /* ignore */ }
  }

  // Copy page files. For remapped docs, rename their parent directory.
  let pages_files_copied = 0;
  if (staged.pagesDir && existsSync(staged.pagesDir)) {
    const livePages = getPagesDirForBackup();
    ensureDir(livePages);
    for (const docDir of readdirSync(staged.pagesDir, { withFileTypes: true })) {
      if (!docDir.isDirectory()) continue;
      const srcDocId = docDir.name;
      const dstDocId = idRemap.get(srcDocId) ?? srcDocId;
      const src = join(staged.pagesDir, srcDocId);
      const dst = join(livePages, dstDocId);
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

  return { documents_imported, chunks_imported, pages_files_copied };
}

// -------- Small helpers --------

function tableColumns(qualified: string): string[] {
  const rows = rawDb.prepare(`PRAGMA table_info(${qualified})`).all() as { name: string }[];
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

async function extractZipTo(zipPath: string, outDir: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { openSync, readSync, closeSync, statSync: st } = require("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const zlib = require("node:zlib");

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
      else if (method === 8) raw = zlib.inflateRawSync(compBuf);
      else throw new Error(`Unsupported compression method ${method} for ${name}`);

      // Path traversal guard.
      if (name.includes("..") || name.startsWith("/") || /[a-zA-Z]:/.test(name)) {
        throw new Error(`Refusing to extract suspicious path: ${name}`);
      }

      const outPath = join(outDir, name);
      ensureDir(dirname(outPath));
      writeFileSync(outPath, raw);
    }
  } finally {
    closeSync(fd);
  }
}
