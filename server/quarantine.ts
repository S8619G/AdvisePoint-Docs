// ---------------------------------------------------------------------------
// v1.0.12.3 — reversible document deletion (quarantine).
//
// Duplicate removal used to be destructive: page images were recursively
// deleted, the retained original was unlinked, and the DB rows were dropped.
// If the grouping was wrong -- or the copy being kept turned out to be the
// unviewable one -- the data was simply gone.
//
// Nothing is deleted now. A removed document is MOVED into a quarantine
// folder next to the database:
//
//   <dataDir>/deleted/<timestamp>-<id>/
//     document.json   -- the documents row
//     chunks.json     -- every chunk row for that document
//     pages/          -- the rendered page images, moved not copied
//     original.<ext>  -- the retained original, if there was one
//     manifest.json   -- what was moved, when, and why
//
// The folder is self-describing so a document can be reconstructed by hand
// even without the application. Quarantine is never pruned automatically:
// disk is cheap and a silent retention sweep would defeat the purpose.
// ---------------------------------------------------------------------------

import {
  existsSync,
  mkdirSync,
  renameSync,
  writeFileSync,
  copyFileSync,
  rmSync,
  statSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { DB_FILE_PATH, storage } from "./storage";
import { pageDirForDoc, isSafeDocIdForPathUse } from "./pages";
import { originalFilePath } from "./originals";

export const QUARANTINE_DIR_NAME = "deleted";

export function quarantineRoot(): string {
  return join(dirname(DB_FILE_PATH), QUARANTINE_DIR_NAME);
}

function tsForFolder(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Move a file or directory, falling back to copy+remove across volumes. */
function moveInto(src: string, dest: string): boolean {
  if (!existsSync(src)) return false;
  try {
    renameSync(src, dest);
    return true;
  } catch {
    // Cross-device or locked: copy then remove. A failure to remove the
    // source is not fatal -- the copy in quarantine is what matters.
    try {
      const st = statSync(src);
      if (st.isDirectory()) {
        mkdirSync(dest, { recursive: true });
        for (const entry of readdirSync(src)) {
          moveInto(join(src, entry), join(dest, entry));
        }
      } else {
        copyFileSync(src, dest);
      }
      try { rmSync(src, { recursive: true, force: true }); } catch { /* ignore */ }
      return true;
    } catch (err) {
      console.error(`[quarantine] failed to move ${src}:`, err);
      return false;
    }
  }
}

export interface QuarantineResult {
  dir: string;
  moved_pages: boolean;
  moved_original: boolean;
  chunk_count: number;
}

/**
 * Move a document out of the live library into quarantine, then drop its
 * rows. Throws before touching anything if the id is unsafe or unknown, so a
 * caller cannot delete rows for a document whose files it could not preserve.
 */
export function quarantineDocument(id: string, reason: string): QuarantineResult {
  if (!isSafeDocIdForPathUse(id)) {
    throw new Error("Refusing to quarantine an unsafe document id");
  }
  const doc = storage.getDocument(id) as any;
  if (!doc) throw new Error(`Document ${id} not found`);

  const dir = join(quarantineRoot(), `${tsForFolder()}-${id}`);
  mkdirSync(dir, { recursive: true });

  // Row data first: if this fails we abort before moving any file, leaving
  // the library exactly as it was.
  const chunks = storage.getChunksForDoc(id) as any[];
  writeFileSync(join(dir, "document.json"), JSON.stringify(doc, null, 2), "utf8");
  writeFileSync(join(dir, "chunks.json"), JSON.stringify(chunks, null, 2), "utf8");

  const pageDir = pageDirForDoc(id);
  const movedPages = pageDir ? moveInto(pageDir, join(dir, "pages")) : false;

  let movedOriginal = false;
  const ext = typeof doc.original_ext === "string" ? doc.original_ext.toLowerCase().replace(/^\./, "") : "";
  if (ext) {
    try {
      const src = originalFilePath(id, ext);
      movedOriginal = moveInto(src, join(dir, `original.${ext}`));
    } catch { /* not retained; nothing to move */ }
  }

  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify(
      {
        quarantined_at: new Date().toISOString(),
        reason,
        document_id: id,
        title: doc.title ?? null,
        file_name: doc.file_name ?? null,
        file_hash_sha256: doc.file_hash_sha256 ?? null,
        chunk_count: chunks.length,
        pages_moved: movedPages,
        original_moved: movedOriginal,
        note:
          "Restore by hand: reinsert document.json/chunks.json and move pages/ back " +
          "into the pages directory under a folder named for document_id.",
      },
      null,
      2,
    ),
    "utf8",
  );

  // Rows last. Page rows go with the document.
  storage.deletePagesForDoc(id);
  storage.deleteDocument(id);

  return { dir, moved_pages: movedPages, moved_original: movedOriginal, chunk_count: chunks.length };
}
