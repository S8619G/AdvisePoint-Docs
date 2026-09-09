// v1.0.6: original source-file retention.
//
// When a user uploads a DOCX (or any format we later want to view with the
// original bytes intact), we now persist the raw file to
//
//   <dataDir>/originals/<document_id>.<ext>
//
// so the client-side DOCX viewer can fetch it and render it with
// docx-preview -- real fonts, tables, headers, page breaks, printable.
//
// Design notes (deliberate):
//
//   * Blobs live on the filesystem, not inside SQLite. A batch of manuals
//     can easily be 500 MB; keeping them out of the DB keeps VACUUM fast,
//     keeps backup zips streamable, and keeps the DB file small enough to
//     open in DB Browser without heartburn.
//   * File name is exactly the document id + the lowercase extension, so
//     there is no path-traversal surface: the id is a UUID we generated
//     ourselves, and the extension is validated below.
//   * We do not fingerprint or dedupe originals; two users uploading the
//     same PDF twice get two rows and two files, which matches the rest
//     of the ingest pipeline.
//   * We do not stream on read; DOCXs are typically <20 MB and Express
//     sendFile handles them fine. If PDF originals get retained later,
//     switch to createReadStream + explicit Content-Length.
//
// Deleting a document should remove its original if present. Backup and
// restore should include originals/ next to pages/. Both hooks live in
// their respective modules and reference the helpers below.

import { existsSync, mkdirSync, statSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { DB_FILE_PATH } from "./storage";

// Extensions we currently retain. Kept narrow on purpose -- for PDFs the
// per-page WebP renders under pages/ already give the viewer everything it
// needs, and for TXT/MD the chunk reassembly is a lossless round-trip.
//
// v1.0.7.4: added rtf. Retained so users get "Open in Word" and
// edit-in-place (server/editInbox.ts) for RTF documents. The stripper
// throws away formatting on ingest for chunking, so we need the original
// bytes to hand back to Word.
const RETAINED_EXTENSIONS = new Set(["docx", "rtf"]);

export function isRetainableExtension(ext: string): boolean {
  return RETAINED_EXTENSIONS.has(ext.toLowerCase().replace(/^\./, ""));
}

/**
 * Extract the lowercase extension from an uploaded file name, without the
 * leading dot. Returns "" if the name has no extension or the extension
 * is not in the retained set. Callers can compare the return value to the
 * empty string to decide whether to retain.
 */
export function retainableExt(fileName: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(fileName);
  if (!m) return "";
  const ext = m[1].toLowerCase();
  return RETAINED_EXTENSIONS.has(ext) ? ext : "";
}

/** Absolute path to the originals directory. Lazily created on first write. */
export function getOriginalsDir(): string {
  // Sibling of the database file, matches the pages/ convention.
  return join(dirname(DB_FILE_PATH), "originals");
}

/** Absolute path to the retained original for a given document. */
export function originalFilePath(documentId: string, ext: string): string {
  // Defensive: an id containing a path separator would be a bug elsewhere,
  // but reject rather than silently allow a directory escape.
  if (/[\\/]/.test(documentId)) {
    throw new Error(`invalid document id for originals path: ${documentId}`);
  }
  const cleanExt = ext.toLowerCase().replace(/^\./, "");
  if (!RETAINED_EXTENSIONS.has(cleanExt)) {
    throw new Error(`extension ${ext} is not in the retained set`);
  }
  return join(getOriginalsDir(), `${documentId}.${cleanExt}`);
}

/**
 * Write an uploaded file's bytes to the originals directory. Returns the
 * lowercase extension stored (safe to write to documents.original_ext), or
 * "" if the extension isn't retained.
 *
 * Never throws on unretained extensions -- callers pass every upload and
 * we just no-op for the ones we don't keep.
 */
export function saveOriginalIfRetainable(
  documentId: string,
  fileName: string,
  bytes: Buffer,
): string {
  const ext = retainableExt(fileName);
  if (!ext) return "";
  const dir = getOriginalsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const outPath = originalFilePath(documentId, ext);
  writeFileSync(outPath, bytes);
  return ext;
}

/**
 * Remove a retained original for a document. No-ops if the file doesn't
 * exist. Called from the delete-document flow.
 */
export function removeOriginal(documentId: string, ext: string | null | undefined): void {
  if (!ext) return;
  const cleanExt = ext.toLowerCase().replace(/^\./, "");
  if (!RETAINED_EXTENSIONS.has(cleanExt)) return;
  const p = originalFilePath(documentId, cleanExt);
  if (existsSync(p)) {
    try {
      rmSync(p);
    } catch (err) {
      console.error(`[originals] failed to remove ${p}:`, err);
    }
  }
}

/**
 * True if the retained original for this document currently exists on
 * disk. Used by the read endpoint and by the /content payload's
 * has_original flag so the client can distinguish "legacy upload" from
 * "current upload but file went missing".
 */
export function originalExists(documentId: string, ext: string | null | undefined): boolean {
  if (!ext) return false;
  const cleanExt = ext.toLowerCase().replace(/^\./, "");
  if (!RETAINED_EXTENSIONS.has(cleanExt)) return false;
  const p = originalFilePath(documentId, cleanExt);
  return existsSync(p);
}

/**
 * Size in bytes of the retained original, or null if not present. Cheap
 * enough to include on every /content response and keeps the client from
 * having to HEAD the file separately.
 */
export function originalSize(documentId: string, ext: string | null | undefined): number | null {
  if (!originalExists(documentId, ext)) return null;
  try {
    return statSync(originalFilePath(documentId, ext!.toLowerCase().replace(/^\./, ""))).size;
  } catch {
    return null;
  }
}

/**
 * Reconcile: list retained originals whose corresponding document id no
 * longer exists in the given set of live ids. Returned as absolute
 * paths. Callers (a future orphan-sweeper) can rmSync them.
 *
 * Not wired up in v1.0.6 -- ships as a utility so the v1.0.7 backup /
 * restore work can call it after a Wipe-and-Replace import.
 */
export function listOrphanOriginals(liveIds: Set<string>): string[] {
  const dir = getOriginalsDir();
  if (!existsSync(dir)) return [];
  const orphans: string[] = [];
  for (const entry of readdirSync(dir)) {
    const m = /^([^.]+)\.([A-Za-z0-9]+)$/.exec(entry);
    if (!m) continue;
    if (!liveIds.has(m[1])) orphans.push(join(dir, entry));
  }
  return orphans;
}
