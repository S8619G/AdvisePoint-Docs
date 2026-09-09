// v1.0.7: pre-update backup safeguard.
//
// Both the WebDAV Save-back path and the drag-to-update flow can replace a
// retained original in place. Before we overwrite, we move the current
// bytes to a .trash/ folder alongside originals/ so the user has a
// window to undo an accidental replace (wrong file dropped in, save from
// Word overwriting content they didn't mean to touch, etc.).
//
// Layout:
//
//   <dataDir>/.trash/<document_id>-<timestamp>.<ext>
//
// The timestamp is millis-since-epoch, zero-padded to a fixed width so
// lexicographic sort matches chronological order. That lets a listing
// call cheaply return "most recent version replaced" without stat-ing
// every file.
//
// Cleanup:
//   * A cron in server/index.ts calls `sweepTrash()` at startup and then
//     hourly. Files older than 24h are unlinked.
//   * `undoReplace()` moves a trash file back to originals/, replacing
//     whatever is currently there (so the moved-to-trash + placed-back
//     sequence is fully reversible).
//
// Not-goals:
//   * We do NOT keep every historic version. Only the immediately-
//     previous copy is guaranteed recoverable; older ones survive up to
//     24h from their own replace-time, not forever.
//   * We do NOT store any metadata about who/how/when beyond the
//     filename timestamp. If we later add versioning proper, that
//     replaces this module entirely.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { DB_FILE_PATH } from "./storage";
import { originalFilePath, isRetainableExtension } from "./originals";

const TRASH_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Zero-pad millis to 14 digits so lexicographic sort == chronological
// sort well past year 2100. `Date.now()` today is 13 digits.
function stampMillis(ts: number): string {
  return String(ts).padStart(14, "0");
}

function unstampMillis(stamp: string): number {
  return Number.parseInt(stamp, 10);
}

/** Absolute path to the .trash directory. Lazily created on first write. */
export function getTrashDir(): string {
  return join(dirname(DB_FILE_PATH), ".trash");
}

/**
 * Parse a trash filename back into its parts. Returns null when the name
 * doesn't match our format, so orphan/foreign files under .trash/ are
 * silently ignored by every list/sweep call.
 */
export function parseTrashName(
  name: string,
): { documentId: string; timestampMs: number; ext: string } | null {
  const m = /^([^-]+(?:-[^-]+)*)-(\d{14})\.([A-Za-z0-9]+)$/.exec(name);
  if (!m) return null;
  const ext = m[3].toLowerCase();
  if (!isRetainableExtension(ext)) return null;
  return { documentId: m[1], timestampMs: unstampMillis(m[2]), ext };
}

/** Absolute path for a trash entry given the tuple. */
function trashFilePath(documentId: string, timestampMs: number, ext: string): string {
  if (/[\\/]/.test(documentId)) {
    throw new Error(`invalid document id for trash path: ${documentId}`);
  }
  const cleanExt = ext.toLowerCase().replace(/^\./, "");
  if (!isRetainableExtension(cleanExt)) {
    throw new Error(`extension ${ext} is not in the retained set`);
  }
  return join(getTrashDir(), `${documentId}-${stampMillis(timestampMs)}.${cleanExt}`);
}

/**
 * Move the currently-retained original for `documentId` into .trash/ and
 * return the trash path plus a token the caller can hand to
 * undoReplace() to restore it. No-op (returns null) when nothing is
 * currently retained for the doc.
 *
 * Idempotency: safe to call twice; the second call finds nothing to move
 * and returns null.
 */
export function backupBeforeReplace(
  documentId: string,
  ext: string,
): { trashPath: string; token: string; timestampMs: number } | null {
  if (!isRetainableExtension(ext)) return null;
  const cur = originalFilePath(documentId, ext);
  if (!existsSync(cur)) return null;

  const dir = getTrashDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const now = Date.now();
  const dest = trashFilePath(documentId, now, ext);
  renameSync(cur, dest);

  // Token = <docId>:<timestampMs>. Opaque from the client's perspective,
  // but easy for the server to parse back into a path.
  const token = `${documentId}:${now}`;
  return { trashPath: dest, token, timestampMs: now };
}

/**
 * Restore a previously-trashed original back to its live location.
 * Overwrites whatever is currently at the live path so this operation is
 * itself reversible (the caller can backupBeforeReplace() first).
 *
 * Returns true if restored, false if the trash entry no longer exists
 * (e.g. already swept, TTL expired, or fabricated token).
 */
export function undoReplace(token: string, ext: string): boolean {
  const m = /^([^:]+):(\d+)$/.exec(token);
  if (!m) return false;
  const documentId = m[1];
  const timestampMs = Number.parseInt(m[2], 10);
  if (!Number.isFinite(timestampMs)) return false;
  if (!isRetainableExtension(ext)) return false;

  const src = trashFilePath(documentId, timestampMs, ext);
  if (!existsSync(src)) return false;

  // Move current live file (if any) aside first, so undo is itself
  // reversible by another backupBeforeReplace. We don't return this
  // secondary token; only the immediate "undo the undo" is not exposed
  // (matches the 24h horizon expectation).
  const live = originalFilePath(documentId, ext);
  if (existsSync(live)) {
    const now = Date.now();
    renameSync(live, trashFilePath(documentId, now, ext));
  }
  renameSync(src, live);
  return true;
}

/**
 * Delete trash entries older than TTL. Called at server startup and
 * hourly thereafter. Returns the number of files removed for observability.
 */
export function sweepTrash(now: number = Date.now()): number {
  const dir = getTrashDir();
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const entry of readdirSync(dir)) {
    const parsed = parseTrashName(entry);
    if (!parsed) continue;
    if (now - parsed.timestampMs < TRASH_TTL_MS) continue;
    try {
      rmSync(join(dir, entry));
      removed++;
    } catch (err) {
      console.error(`[trash] failed to remove ${entry}:`, err);
    }
  }
  return removed;
}

/**
 * List trash entries for a given document, most recent first. Callers use
 * this to check whether a doc has an undoable replace in flight (e.g.
 * for the toolbar "Undo replace" toast that appears for ~30s).
 */
export function listTrashForDocument(
  documentId: string,
): Array<{ timestampMs: number; ext: string; size: number; token: string }> {
  const dir = getTrashDir();
  if (!existsSync(dir)) return [];
  const out: Array<{ timestampMs: number; ext: string; size: number; token: string }> = [];
  for (const entry of readdirSync(dir)) {
    const parsed = parseTrashName(entry);
    if (!parsed) continue;
    if (parsed.documentId !== documentId) continue;
    try {
      const size = statSync(join(dir, entry)).size;
      out.push({
        timestampMs: parsed.timestampMs,
        ext: parsed.ext,
        size,
        token: `${documentId}:${parsed.timestampMs}`,
      });
    } catch {
      // Concurrent sweep race -- skip.
    }
  }
  out.sort((a, b) => b.timestampMs - a.timestampMs);
  return out;
}

/**
 * TTL in seconds -- exposed so the client can compute "expires in Xh Ym"
 * without having to hardcode the same constant.
 */
export const TRASH_TTL_SECONDS = TRASH_TTL_MS / 1000;
