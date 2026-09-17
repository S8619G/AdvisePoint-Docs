// v1.2.1 tests for the page-image-path heal introduced to fix
// cross-machine backup restores. Verifies:
//
//   1. resolvePageImageOnDisk() finds a .webp render at the current pages
//      root regardless of what any DB row says.
//   2. resolvePageImageOnDisk() falls back to a legacy .jpg render.
//   3. resolvePageImageOnDisk() returns null when no image exists.
//   4. reconcilePersistedPageImagePaths() rewrites rows whose image_path
//      points at a nonexistent x64-shaped absolute path when the current
//      pages root has the matching file.
//   5. Rows that already resolve are left alone (idempotent).
//   6. Rows whose image is genuinely missing on disk are left alone so the
//      interrupted-render logic still sees them.
//
// Run: npm run test:image-path-heal

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "adp-imgheal-"));
const dataDir = join(tmpRoot, "data");
const dbPath = join(dataDir, "data.db");
const pagesDir = join(dataDir, "pages");
mkdirSync(pagesDir, { recursive: true });

// Point storage.ts at our temp DB before anything imports it.
process.env.RAG_DB_PATH = dbPath;
process.env.RAG_PAGES_DIR = pagesDir;

const { resolvePageImageOnDisk, reconcilePersistedPageImagePaths } = await import(
  "../server/pages.ts"
);
const { rawDb } = await import("../server/storage.ts");

// Seed a documents row so foreign keys line up if any get added later.
function seedDoc(id, title = "T") {
  rawDb
    .prepare(
      `INSERT OR IGNORE INTO documents
         (id, title, subtitle, document_type, audience_json, language,
          summary, product_family, product_model, ingested_at, total_chunks)
         VALUES (?, ?, NULL, 'manual', '[]', 'en', NULL, NULL, '', datetime('now'), 0)`,
    )
    .run(id, title);
}

function seedPageRow(docId, pageNumber, imagePath) {
  rawDb
    .prepare(
      `INSERT OR REPLACE INTO document_pages
         (document_id, page_number, image_path, width, height, generated_at)
         VALUES (?, ?, ?, 100, 200, datetime('now'))`,
    )
    .run(docId, pageNumber, imagePath);
}

function writeImage(docId, pageNumber, ext = "webp") {
  const dir = join(pagesDir, docId);
  mkdirSync(dir, { recursive: true });
  const name = `p${String(pageNumber).padStart(4, "0")}.${ext}`;
  const p = join(dir, name);
  writeFileSync(p, Buffer.from([0])); // stub content
  return p;
}

test("resolvePageImageOnDisk finds a modern .webp render", () => {
  const docId = "doc-webp";
  const p = writeImage(docId, 1, "webp");
  assert.equal(resolvePageImageOnDisk(docId, 1), p);
});

test("resolvePageImageOnDisk falls back to a legacy .jpg render", () => {
  const docId = "doc-jpg";
  const p = writeImage(docId, 1, "jpg");
  assert.equal(resolvePageImageOnDisk(docId, 1), p);
});

test("resolvePageImageOnDisk returns null when no image is on disk", () => {
  assert.equal(resolvePageImageOnDisk("doc-missing", 1), null);
});

test("reconcile rewrites x64-shaped stale paths for restored docs", () => {
  const docId = "doc-crossmachine";
  seedDoc(docId);
  const realPath = writeImage(docId, 1, "webp");
  const stalePath = String.raw`C:\Users\otheruser\AppData\Roaming\AdvisePoint Docs\pages\${docId}\p0001.webp`;
  seedPageRow(docId, 1, stalePath);

  const result = reconcilePersistedPageImagePaths();
  assert.ok(result.rewritten >= 1, `expected >=1 rewritten, got ${result.rewritten}`);

  const row = rawDb
    .prepare("SELECT image_path FROM document_pages WHERE document_id = ? AND page_number = ?")
    .get(docId, 1);
  assert.equal(row.image_path, realPath);
});

test("reconcile is idempotent -- rows that already resolve stay put", () => {
  const docId = "doc-alreadyfixed";
  seedDoc(docId);
  const realPath = writeImage(docId, 1, "webp");
  seedPageRow(docId, 1, realPath);

  const before = rawDb
    .prepare("SELECT image_path FROM document_pages WHERE document_id = ?")
    .get(docId);
  const result = reconcilePersistedPageImagePaths();
  const after = rawDb
    .prepare("SELECT image_path FROM document_pages WHERE document_id = ?")
    .get(docId);

  assert.equal(after.image_path, before.image_path);
  // rewritten count from THIS run alone can't be checked cleanly because
  // reconcile scans every row across every test, so we just assert the row
  // was not disturbed above.
  assert.ok(result.scanned >= 1);
});

test("reconcile leaves genuinely-missing images alone (interrupted renders)", () => {
  const docId = "doc-lostimage";
  seedDoc(docId);
  // No writeImage(): both .webp and .jpg absent. Row still references a
  // stale path from a previous machine.
  const stalePath = String.raw`C:\Users\otheruser\AppData\Roaming\AdvisePoint Docs\pages\${docId}\p0001.webp`;
  seedPageRow(docId, 1, stalePath);

  reconcilePersistedPageImagePaths();

  const row = rawDb
    .prepare("SELECT image_path FROM document_pages WHERE document_id = ?")
    .get(docId);
  assert.equal(row.image_path, stalePath); // untouched
});

test.after(() => {
  try { rawDb.close(); } catch { /* ignore */ }
  rmSync(tmpRoot, { recursive: true, force: true });
});
