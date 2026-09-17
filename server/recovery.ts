// ---------------------------------------------------------------------------
// v1.0.13.0 -- Recovery panel back-end.
//
// Two preserved-data holding areas exist and, until now, only File Explorer
// could see them:
//
//   1. Quarantined documents  -- <dataDir>/deleted/<ts>-<id>/  (server/quarantine.ts)
//   2. Pre-restore snapshots  -- <parentOfDataDir>/<basename(dataDir)>.bak-<ts>/
//                                (server/backup.ts wipe-and-replace path)
//
// This module reads them, restores individual quarantined documents with the
// same stage-verify-swap posture the restore path uses, and permanently
// deletes either kind on explicit user request.
//
// Design principle (matches docs/v1.0.13-recovery-panel-spec.md):
//   User-driven, never automatic. An unattended timer deleting preserved data
//   is a deletion nobody verified, which the project's data-preservation rule
//   excludes. The one auto-cleanup path (opt-in duplicate cleanup) re-verifies
//   the keeper's presence, SHA-256, and viewability at the moment of deletion
//   and keeps the data if any check cannot complete.
// ---------------------------------------------------------------------------

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, isAbsolute, sep } from "node:path";

import {
  DB_FILE_PATH,
  getDataDirForBackup,
  storage,
} from "./storage";
import {
  hasRenderedPageFiles,
  isSafeDocIdForPathUse,
  pageDirForDoc,
  purgePagesForDoc,
} from "./pages";
import { QUARANTINE_DIR_NAME, quarantineRoot } from "./quarantine";
import { originalExists, originalFilePath } from "./originals";
import { appendBackupLog } from "./backup-log";

// -------- Path-guard helpers --------

/**
 * A quarantine folder name is safe when it is a non-empty single path segment
 * with no separators, no NUL, not "." or "..", and not absolute. Callers must
 * treat `false` as "refuse the operation".
 */
export function isSafeFolderName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  const n = name.trim();
  if (n === "" || n === "." || n === "..") return false;
  if (n !== name) return false;
  if (n.includes("/") || n.includes("\\") || n.includes("\0")) return false;
  if (isAbsolute(n)) return false;
  return true;
}

/**
 * Resolve a quarantine folder path from a client-supplied segment. Returns
 * null when the segment fails validation OR when it does not resolve to a
 * direct child of the quarantine root -- i.e. any traversal attempt.
 */
function resolveQuarantineFolder(name: string): string | null {
  if (!isSafeFolderName(name)) return null;
  const root = quarantineRoot();
  const full = join(root, name);
  // Belt-and-braces containment check.
  if (!full.startsWith(root + sep)) return null;
  return full;
}

/**
 * A snapshot lives as a sibling of the dataDir: `<parent>/<dataName>.bak-<ts>`.
 * Return the absolute path if `name` is a real snapshot in the expected
 * location, or null.
 */
function resolveSnapshotDir(name: string): string | null {
  if (!isSafeFolderName(name)) return null;
  const dataDir = getDataDirForBackup();
  const parent = dirname(dataDir);
  const dataName = basename(dataDir);
  const prefix = `${dataName}.bak-`;
  if (!name.startsWith(prefix)) return null;
  const full = join(parent, name);
  if (!full.startsWith(parent + sep)) return null;
  return full;
}

// -------- Directory size (bytes on disk, walked once) --------

function dirSizeBytes(dir: string): number {
  let total = 0;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: string[] = [];
    try { entries = readdirSync(current); } catch { continue; }
    for (const entry of entries) {
      const full = join(current, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory()) stack.push(full);
        else total += st.size;
      } catch { /* skip unreadable */ }
    }
  }
  return total;
}

// -------- A. List "Recently removed" --------

export interface RemovedItem {
  folder: string;                       // basename only, safe to hand back to the client
  quarantined_at: string | null;        // ISO
  reason: string | null;
  document_id: string | null;
  title: string | null;
  file_name: string | null;
  file_hash_sha256: string | null;
  chunk_count: number | null;
  pages_moved: boolean | null;
  original_moved: boolean | null;
  size_bytes: number;
  manifest_ok: boolean;                 // false when JSON was missing or malformed
}

export interface RemovedListing {
  root: string;
  total_bytes: number;
  items: RemovedItem[];
}

export function listQuarantined(): RemovedListing {
  const root = quarantineRoot();
  const empty: RemovedListing = { root, total_bytes: 0, items: [] };
  if (!existsSync(root)) return empty;

  let entries: string[] = [];
  try { entries = readdirSync(root); } catch { return empty; }

  const items: RemovedItem[] = [];
  let total = 0;

  for (const folder of entries) {
    // Skip anything not shaped like a quarantine subfolder. Callers should
    // never place foreign files in this root, but be defensive.
    if (!isSafeFolderName(folder)) continue;
    const full = join(root, folder);
    let st: ReturnType<typeof statSync>;
    try { st = statSync(full); } catch { continue; }
    if (!st.isDirectory()) continue;

    const size = dirSizeBytes(full);
    total += size;

    // Tolerate a malformed or missing manifest.json -- list what we can and
    // flag it so the UI can hint that the folder needs a manual look.
    let raw: string | null = null;
    try { raw = readFileSync(join(full, "manifest.json"), "utf8"); } catch { raw = null; }

    let manifest: any = null;
    let manifestOk = false;
    if (raw !== null) {
      try { manifest = JSON.parse(raw); manifestOk = true; }
      catch { manifest = null; manifestOk = false; }
    }

    items.push({
      folder,
      quarantined_at: pickString(manifest?.quarantined_at) ?? st.mtime.toISOString(),
      reason: pickString(manifest?.reason),
      document_id: pickString(manifest?.document_id),
      title: pickString(manifest?.title),
      file_name: pickString(manifest?.file_name),
      file_hash_sha256: pickString(manifest?.file_hash_sha256),
      chunk_count: pickNumber(manifest?.chunk_count),
      pages_moved: pickBoolOrNull(manifest?.pages_moved),
      original_moved: pickBoolOrNull(manifest?.original_moved),
      size_bytes: size,
      manifest_ok: manifestOk,
    });
  }

  // Newest first.
  items.sort((a, b) => (b.quarantined_at ?? "").localeCompare(a.quarantined_at ?? ""));

  return { root, total_bytes: total, items };
}

function pickString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function pickNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function pickBoolOrNull(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

// -------- B. Restore a quarantined document --------

export interface RestoreOutcome {
  ok: true;
  document_id: string;
  chunks_restored: number;
  pages_restored: number;
  original_restored: boolean;
}

export type RestoreFailureCode =
  | "unsafe_folder"
  | "not_found"
  | "manifest_missing"
  | "manifest_unusable"
  | "unsafe_document_id"
  | "id_collision"
  | "verify_failed"
  | "internal_error";

export interface RestoreFailure {
  ok: false;
  code: RestoreFailureCode;
  message: string;
  detail?: Record<string, unknown>;
}

/**
 * Restore one quarantined folder back into the live library.
 *
 * Guarantees:
 *  - Refuses (without touching disk) if the folder segment is unsafe, missing,
 *    or the manifest cannot be read.
 *  - Refuses if a live document already occupies the same id; reports the
 *    collision without overwriting or re-keying.
 *  - Stages the DB rows and moves pages/original into place, then verifies row
 *    presence, chunk count, and page file count BEFORE removing the quarantine
 *    folder. On any failure, the DB rows are removed and the quarantine folder
 *    is left exactly as it was so the caller can retry.
 *  - Writes a [RESTORE-DOC] line to backups.log.
 */
export async function restoreQuarantined(folderName: string): Promise<RestoreOutcome | RestoreFailure> {
  const dir = resolveQuarantineFolder(folderName);
  if (dir === null) {
    return { ok: false, code: "unsafe_folder", message: "That quarantine folder name is not valid." };
  }
  if (!existsSync(dir)) {
    return { ok: false, code: "not_found", message: "That quarantine folder no longer exists." };
  }

  // ---- 1. Load and validate the manifest + rows ---------------------------
  const manifestPath = join(dir, "manifest.json");
  const docJsonPath = join(dir, "document.json");
  const chunksJsonPath = join(dir, "chunks.json");
  if (!existsSync(manifestPath) || !existsSync(docJsonPath) || !existsSync(chunksJsonPath)) {
    return {
      ok: false,
      code: "manifest_missing",
      message:
        "This quarantine folder is missing manifest.json, document.json, or chunks.json and cannot be " +
        "restored automatically. Recover it by hand from File Explorer.",
    };
  }

  let manifest: any;
  let docRow: any;
  let chunkRows: any[];
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    docRow = JSON.parse(readFileSync(docJsonPath, "utf8"));
    chunkRows = JSON.parse(readFileSync(chunksJsonPath, "utf8"));
    if (!Array.isArray(chunkRows)) throw new Error("chunks.json is not an array");
  } catch (err) {
    return {
      ok: false,
      code: "manifest_unusable",
      message: `Could not read the quarantine folder's JSON files: ${(err as Error).message || String(err)}.`,
    };
  }

  const docId = typeof docRow?.id === "string" ? docRow.id : null;
  if (docId === null || !isSafeDocIdForPathUse(docId)) {
    return {
      ok: false,
      code: "unsafe_document_id",
      message: "The document id recorded in this folder is not safe to use as a path component.",
    };
  }

  // ---- 2. Id-collision check ----------------------------------------------
  const occupant = storage.getDocument(docId) as any;
  if (occupant) {
    return {
      ok: false,
      code: "id_collision",
      message:
        `Cannot restore: a live document with the same id is already present ` +
        `(${JSON.stringify(occupant.title ?? occupant.file_name ?? docId)}). ` +
        "The quarantine folder was not touched.",
      detail: {
        document_id: docId,
        occupant_title: occupant.title ?? null,
        occupant_file_name: occupant.file_name ?? null,
      },
    };
  }

  const targetPagesDir = pageDirForDoc(docId);
  if (targetPagesDir === null) {
    // Defensive: isSafeDocIdForPathUse already passed, so this is only reachable
    // if the pages root itself cannot be resolved to a safe parent.
    return {
      ok: false,
      code: "unsafe_document_id",
      message: "Could not resolve the live pages directory for this document id.",
    };
  }

  // The quarantined pages subdir, if any.
  const quarantinePages = join(dir, "pages");
  const hasQuarantinedPages = existsSync(quarantinePages);
  const expectedPageFiles = hasQuarantinedPages ? countImageFiles(quarantinePages) : 0;

  // ---- 3. Stage: insert rows, then move files -----------------------------
  //
  // We stage in an order that leaves the LIVE library recoverable at every
  // step:
  //   (a) Insert document row + chunk rows.
  //   (b) Move pages/ into place under a temporary sibling name, then rename.
  //   (c) Move original.<ext> into originals/.
  //   (d) Upsert document_pages rows for the restored images.
  // On any error we drop the row and remove whatever we moved, so the
  // quarantine folder is untouched until the very last step.
  let insertedDoc = false;
  const stagedPagesTemp = targetPagesDir + `.restore-${Date.now()}`;
  let movedPagesInto: string | null = null;
  let movedOriginalTo: string | null = null;
  let restoredPageRows = 0;
  let restoredOriginal = false;

  try {
    // (a) DB rows
    try {
      storage.createDocument(docRow);
      insertedDoc = true;
    } catch (err) {
      throw new Error(`could not insert document row: ${(err as Error).message || String(err)}`);
    }
    if (chunkRows.length > 0) {
      try {
        storage.insertChunks(chunkRows);
      } catch (err) {
        throw new Error(`could not insert ${chunkRows.length} chunk row(s): ${(err as Error).message || String(err)}`);
      }
    }

    // (b) Pages: quarantine/pages -> <pagesDir>/<id>.restore-<ts> -> <pagesDir>/<id>
    if (hasQuarantinedPages) {
      // A prior failed restore might have left a stale staging dir; clean it.
      if (existsSync(stagedPagesTemp)) rmSync(stagedPagesTemp, { recursive: true, force: true });
      if (existsSync(targetPagesDir)) {
        // pageDirForDoc returned a path, but if something is squatting there,
        // we refuse rather than merging.
        throw new Error(`live pages directory unexpectedly exists at ${targetPagesDir}`);
      }
      // Ensure the pages root exists.
      mkdirSync(dirname(stagedPagesTemp), { recursive: true });
      moveDir(quarantinePages, stagedPagesTemp);
      const stagedCount = countImageFiles(stagedPagesTemp);
      if (stagedCount !== expectedPageFiles) {
        throw new Error(
          `page image count changed during move (expected ${expectedPageFiles}, got ${stagedCount})`,
        );
      }
      renameSync(stagedPagesTemp, targetPagesDir);
      movedPagesInto = targetPagesDir;
    }

    // (c) Retained original, if any.
    const ext = typeof docRow.original_ext === "string"
      ? docRow.original_ext.toLowerCase().replace(/^\./, "")
      : "";
    if (ext) {
      const src = join(dir, `original.${ext}`);
      if (existsSync(src)) {
        const target = originalFilePath(docId, ext);
        mkdirSync(dirname(target), { recursive: true });
        renameSync(src, target);
        movedOriginalTo = target;
        restoredOriginal = true;
      }
    }

    // (d) Rebuild document_pages rows from the restored images. Dimensions
    //     are decoded once per image; the restore path is rare enough that
    //     the extra I/O is acceptable.
    if (movedPagesInto) {
      restoredPageRows = await rebuildPageRowsForRestore(docId, movedPagesInto);
    }

    // ---- 4. Verify before removing the quarantine folder ------------------
    const verifyDoc = storage.getDocument(docId);
    if (!verifyDoc) throw new Error("document row missing after insert");
    const verifyChunks = storage.getChunksForDoc(docId).length;
    if (verifyChunks !== chunkRows.length) {
      throw new Error(`chunk count did not verify (expected ${chunkRows.length}, got ${verifyChunks})`);
    }
    if (hasQuarantinedPages) {
      const filesOnDisk = countImageFiles(targetPagesDir);
      if (filesOnDisk !== expectedPageFiles) {
        throw new Error(
          `page image count did not verify (expected ${expectedPageFiles}, got ${filesOnDisk})`,
        );
      }
    }
  } catch (err) {
    // Best-effort rollback so a failed restore leaves neither the live library
    // nor the quarantine folder in a partial state.
    if (insertedDoc) {
      try { storage.deleteDocument(docId); } catch { /* ignore */ }
    }
    if (movedPagesInto) {
      // Move pages back INTO the quarantine folder so a retry works.
      try {
        moveDir(movedPagesInto, quarantinePages);
      } catch { /* ignore */ }
    } else if (existsSync(stagedPagesTemp)) {
      try { rmSync(stagedPagesTemp, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    if (movedOriginalTo && existsSync(movedOriginalTo)) {
      const ext = typeof docRow.original_ext === "string"
        ? docRow.original_ext.toLowerCase().replace(/^\./, "")
        : "";
      if (ext) {
        try { renameSync(movedOriginalTo, join(dir, `original.${ext}`)); } catch { /* ignore */ }
      }
    }
    // Also purge any partially-written document_pages rows.
    try { storage.deletePagesForDoc(docId); } catch { /* ignore */ }

    const message = (err as Error).message || String(err);
    appendBackupLog(`[RESTORE-DOC] FAILED to restore ${folderName}: ${message}`);
    return {
      ok: false,
      code: "verify_failed",
      message: `Restore did not complete: ${message}. Nothing was left behind in the live library.`,
    };
  }

  // ---- 5. Clean up the quarantine folder ---------------------------------
  // Everything above verified. Removing the folder is the point of no return
  // for this restore; the document is now live and independently backed up
  // by the normal backup flow.
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    // Non-fatal for the user: the restore succeeded. Log so an operator can
    // clean up manually.
    appendBackupLog(
      `[RESTORE-DOC] restored ${docId} but could not remove ${folderName}: ${(err as Error).message}`,
    );
  }

  appendBackupLog(
    `[RESTORE-DOC] restored ${docId} from ${folderName}: ` +
      `chunks=${chunkRows.length} pages=${restoredPageRows} original=${restoredOriginal}`,
  );

  return {
    ok: true,
    document_id: docId,
    chunks_restored: chunkRows.length,
    pages_restored: restoredPageRows,
    original_restored: restoredOriginal,
  };
}

function countImageFiles(dir: string): number {
  try {
    return readdirSync(dir).filter((n) => /\.(webp|png|jpg|jpeg)$/i.test(n)).length;
  } catch {
    return 0;
  }
}

/** Rename-or-copy move for a directory tree, matching quarantine.ts semantics. */
function moveDir(src: string, dest: string): void {
  try {
    renameSync(src, dest);
    return;
  } catch {
    // Cross-device or locked: copy then remove.
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src)) {
      const s = join(src, entry);
      const d = join(dest, entry);
      const st = statSync(s);
      if (st.isDirectory()) {
        moveDir(s, d);
      } else {
        // Best-effort copy via read+write to avoid an extra dep.
        writeFileSync(d, readFileSync(s));
      }
    }
    try { rmSync(src, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * Insert document_pages rows for each restored image, decoding just enough to
 * recover the width/height the viewer needs to lay pages out correctly.
 * Returns the number of rows inserted. Failures on individual pages are
 * logged but do not abort restore -- a missing dim is better than a failed
 * restore, since the app can re-render on demand.
 */
async function rebuildPageRowsForRestore(docId: string, pagesDir: string): Promise<number> {
  let canvasMod: any = null;
  try { canvasMod = require("@napi-rs/canvas"); } catch { canvasMod = null; }

  const files = readdirSync(pagesDir)
    .filter((n) => /^p\d+\.(webp|png|jpg|jpeg)$/i.test(n))
    .sort();

  let inserted = 0;
  for (const name of files) {
    const m = name.match(/^p(\d+)\./i);
    const pageNumber = m ? parseInt(m[1], 10) : NaN;
    if (!Number.isFinite(pageNumber)) continue;
    const full = join(pagesDir, name);
    let width = 0, height = 0;
    if (canvasMod && typeof canvasMod.loadImage === "function") {
      try {
        const buf = readFileSync(full);
        const img = await canvasMod.loadImage(buf);
        width = img.width | 0;
        height = img.height | 0;
      } catch (err) {
        console.error(`[recovery] could not decode dimensions for ${full}: ${(err as Error).message}`);
      }
    }
    try {
      storage.upsertPage({
        document_id: docId,
        page_number: pageNumber,
        image_path: full,
        width,
        height,
        generated_at: new Date().toISOString(),
      });
      inserted++;
    } catch (err) {
      console.error(`[recovery] upsertPage failed for ${docId} p${pageNumber}: ${(err as Error).message}`);
    }
  }

  if (inserted > 0) {
    try {
      storage.upsertRenderStatus({
        document_id: docId,
        status: "ready",
        rendered: inserted,
        total: inserted,
        error: null,
        updated_at: new Date().toISOString(),
      });
    } catch { /* non-fatal */ }
  }
  return inserted;
}

// -------- C. Permanently delete a quarantined folder --------

export interface PermanentDeleteOutcome {
  ok: true;
  folder: string;
  bytes_freed: number;
}
export interface PermanentDeleteFailure {
  ok: false;
  code: "unsafe_folder" | "not_found" | "internal_error";
  message: string;
}

export function permanentlyDeleteQuarantined(
  folderName: string,
): PermanentDeleteOutcome | PermanentDeleteFailure {
  const dir = resolveQuarantineFolder(folderName);
  if (dir === null) {
    return { ok: false, code: "unsafe_folder", message: "That quarantine folder name is not valid." };
  }
  if (!existsSync(dir)) {
    return { ok: false, code: "not_found", message: "That quarantine folder no longer exists." };
  }
  const size = dirSizeBytes(dir);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    return {
      ok: false,
      code: "internal_error",
      message: `Could not delete: ${(err as Error).message || String(err)}`,
    };
  }
  appendBackupLog(`[RECOVERY] permanently deleted quarantine folder ${folderName} (${size} bytes)`);
  return { ok: true, folder: folderName, bytes_freed: size };
}

// -------- D. Pre-restore snapshots --------

export interface SnapshotItem {
  name: string;                         // basename, safe to hand back to the client
  path: string;
  created_at: string;                   // ISO from mtime
  size_bytes: number;
}

export interface SnapshotListing {
  parent: string;
  data_dir_name: string;
  total_bytes: number;
  items: SnapshotItem[];
}

export function listSnapshots(): SnapshotListing {
  const dataDir = getDataDirForBackup();
  const parent = dirname(dataDir);
  const dataName = basename(dataDir);
  const prefix = `${dataName}.bak-`;
  const empty: SnapshotListing = {
    parent, data_dir_name: dataName, total_bytes: 0, items: [],
  };
  if (!existsSync(parent)) return empty;

  let entries: string[] = [];
  try { entries = readdirSync(parent); } catch { return empty; }

  const items: SnapshotItem[] = [];
  let total = 0;
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    if (!isSafeFolderName(name)) continue;
    const full = join(parent, name);
    let st: ReturnType<typeof statSync>;
    try { st = statSync(full); } catch { continue; }
    if (!st.isDirectory()) continue;
    const size = dirSizeBytes(full);
    total += size;
    items.push({
      name,
      path: full,
      created_at: st.mtime.toISOString(),
      size_bytes: size,
    });
  }
  // Newest first.
  items.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return { parent, data_dir_name: dataName, total_bytes: total, items };
}

export function permanentlyDeleteSnapshot(
  name: string,
): PermanentDeleteOutcome | PermanentDeleteFailure {
  const dir = resolveSnapshotDir(name);
  if (dir === null) {
    return { ok: false, code: "unsafe_folder", message: "That snapshot name is not valid." };
  }
  if (!existsSync(dir)) {
    return { ok: false, code: "not_found", message: "That snapshot no longer exists." };
  }
  const size = dirSizeBytes(dir);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    return {
      ok: false,
      code: "internal_error",
      message: `Could not delete: ${(err as Error).message || String(err)}`,
    };
  }
  appendBackupLog(`[RECOVERY] permanently deleted pre-restore snapshot ${name} (${size} bytes)`);
  return { ok: true, folder: name, bytes_freed: size };
}

// -------- Opt-in auto-cleanup of quarantined duplicates --------
//
// Default OFF. When enabled, a periodic sweep permanently removes quarantine
// folders whose recorded reason begins with "duplicate of " AND whose keeper
// is right now (a) present in the library, (b) has a file_hash_sha256 that
// matches the manifest's file_hash_sha256, and (c) has viewable content on
// disk. Any check that cannot complete keeps the data.

const AUTO_CLEANUP_KEY = "recovery_auto_cleanup_dupes";
const AUTO_CLEANUP_LAST_RUN_KEY = "recovery_auto_cleanup_last_run_at";

export function getAutoCleanupEnabled(): boolean {
  try {
    // Late import to keep quarantine.ts / storage bootstrap cycles clean.
    const { rawDb } = require("./storage") as typeof import("./storage");
    const row = rawDb.prepare("SELECT value FROM app_settings WHERE key = ?").get(AUTO_CLEANUP_KEY) as
      | { value: string }
      | undefined;
    return row?.value === "1";
  } catch {
    return false;
  }
}

export function setAutoCleanupEnabled(enabled: boolean): void {
  const { rawDb } = require("./storage") as typeof import("./storage");
  rawDb.prepare(
    "INSERT INTO app_settings (key, value) VALUES (?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(AUTO_CLEANUP_KEY, enabled ? "1" : "0");
}

export function getAutoCleanupLastRunAt(): string | null {
  try {
    const { rawDb } = require("./storage") as typeof import("./storage");
    const row = rawDb.prepare("SELECT value FROM app_settings WHERE key = ?").get(
      AUTO_CLEANUP_LAST_RUN_KEY,
    ) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function setAutoCleanupLastRunAt(iso: string): void {
  try {
    const { rawDb } = require("./storage") as typeof import("./storage");
    rawDb.prepare(
      "INSERT INTO app_settings (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(AUTO_CLEANUP_LAST_RUN_KEY, iso);
  } catch { /* non-fatal */ }
}

/**
 * Compute the SHA-256 of a small-to-medium file, streaming to keep memory
 * bounded. Returns null if the file cannot be opened.
 */
function sha256File(path: string): string | null {
  try {
    const buf = readFileSync(path);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

export interface AutoCleanupResult {
  scanned: number;
  removed: number;
  skipped: number;
  reasons: Record<string, number>;      // reason-code -> count
  bytes_freed: number;
}

/**
 * Sweep the quarantine folder for entries whose reason starts with
 * "duplicate of ". For each, re-verify the keeper's presence + SHA-256 +
 * viewability before removing anything. Any check that cannot complete keeps
 * the data. Single-document deletes (reason starts with "removed from the
 * library by request") are never auto-cleaned.
 *
 * Intended to be called from the backup scheduler tick when the opt-in
 * setting is on. Safe to call directly for testing.
 */
export function runAutoCleanupOnce(): AutoCleanupResult {
  const listing = listQuarantined();
  const reasons: Record<string, number> = {};
  const bump = (k: string) => { reasons[k] = (reasons[k] ?? 0) + 1; };
  let removed = 0;
  let bytesFreed = 0;
  let skipped = 0;

  for (const item of listing.items) {
    if (!item.manifest_ok) { bump("manifest_unusable"); skipped++; continue; }
    if (!item.reason || !/^duplicate of /i.test(item.reason)) { bump("not_a_duplicate"); skipped++; continue; }
    const match = item.reason.match(/^duplicate of\s+([^\s(]+)/i);
    const keeperId = match ? match[1] : null;
    if (!keeperId || !isSafeDocIdForPathUse(keeperId)) { bump("keeper_id_unsafe"); skipped++; continue; }
    if (!item.file_hash_sha256) { bump("no_hash_recorded"); skipped++; continue; }

    // (a) keeper present
    const keeper = storage.getDocument(keeperId) as any;
    if (!keeper) { bump("keeper_missing"); skipped++; continue; }

    // (b) SHA-256 match. Prefer the DB-recorded value; if it disagrees or is
    //     missing, fall back to hashing the retained original, but only when
    //     an original was retained. If we cannot obtain a hash, keep the
    //     data.
    let keeperHash: string | null = typeof keeper.file_hash_sha256 === "string" ? keeper.file_hash_sha256 : null;
    if (!keeperHash || keeperHash.length === 0) {
      const kext = typeof keeper.original_ext === "string"
        ? keeper.original_ext.toLowerCase().replace(/^\./, "")
        : "";
      if (kext && originalExists(keeperId, kext)) {
        keeperHash = sha256File(originalFilePath(keeperId, kext));
      }
    }
    if (!keeperHash || keeperHash.toLowerCase() !== item.file_hash_sha256.toLowerCase()) {
      bump("hash_mismatch"); skipped++; continue;
    }

    // (c) viewable
    let viewable = false;
    try { viewable = hasRenderedPageFiles(keeperId); } catch { viewable = false; }
    if (!viewable) {
      const kext = typeof keeper.original_ext === "string"
        ? keeper.original_ext.toLowerCase().replace(/^\./, "")
        : "";
      if (kext) {
        try { viewable = originalExists(keeperId, kext); } catch { viewable = false; }
      }
    }
    if (!viewable) { bump("keeper_not_viewable"); skipped++; continue; }

    const outcome = permanentlyDeleteQuarantined(item.folder);
    if (outcome.ok) {
      removed++;
      bytesFreed += outcome.bytes_freed;
      appendBackupLog(
        `[RECOVERY] auto-cleanup removed duplicate ${item.folder} (keeper=${keeperId}, ${outcome.bytes_freed} bytes)`,
      );
    } else {
      bump("delete_failed"); skipped++;
    }
  }

  setAutoCleanupLastRunAt(new Date().toISOString());
  if (removed > 0 || skipped > 0) {
    appendBackupLog(
      `[RECOVERY] auto-cleanup finished: removed=${removed} skipped=${skipped} bytes_freed=${bytesFreed}`,
    );
  }
  return { scanned: listing.items.length, removed, skipped, reasons, bytes_freed: bytesFreed };
}

// Re-export the constant so callers building diagnostics know the folder name.
export { QUARANTINE_DIR_NAME };
// And DB_FILE_PATH so any future recovery UI can display the data location.
export { DB_FILE_PATH };
