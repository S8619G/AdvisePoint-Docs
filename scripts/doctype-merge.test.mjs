// v1.1.4: document type merge + filename-code repointing.
//
// Runs against a REAL throwaway sqlite database created by storage.ts itself,
// so the actual statements and transactions are exercised. RAG_DB_PATH is set
// before the dynamic import because storage.ts resolves the database location
// at module load.
//
// Run: npm run test:doctype-merge
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "apd-doctype-merge-"));
process.env.RAG_DB_PATH = join(dir, "test.db");
process.env.RAG_PAGES_DIR = join(dir, "pages");

const { storage, rawDb } = await import("../server/storage.ts");
const {
  readFilenameCodeMapping,
  writeFilenameCodeMapping,
  pruneDanglingFilenameCodes,
  seedDefaultDocTypesAndCodesIfNeeded,
} = await import("../server/filename-codes.ts");

// The code seeder normally runs from registerRoutes(), not on storage import,
// so the suite has to invoke it to get the same shape as a real fresh install.
seedDefaultDocTypesAndCodesIfNeeded(rawDb);

let seq = 0;
function makeDoc(document_type, overrides = {}) {
  const id = overrides.id ?? `doc-${++seq}`;
  const now = new Date().toISOString();
  storage.createDocument({
    id,
    title: `Doc ${id}`,
    document_type,
    product_family: "TASKalfa",
    product_model: "MZ9500ci",
    file_name: `${id}.pdf`,
    ingested_at: now,
    updated_at: now,
    ...overrides,
  });
  return id;
}

function makeChunk(parent_id, document_type) {
  // insertChunks uses named bind parameters, so EVERY column must be present.
  storage.insertChunks([
    {
      id: `chunk-${parent_id}-${++seq}`,
      parent_id,
      content: "body",
      content_type: "text",
      language: "en-US",
      section_path_json: "[]",
      section_id: null,
      section_title: null,
      heading_level: null,
      page_start: null,
      page_end: null,
      chunk_index: 0,
      document_type,
      product_model: "MZ9500ci",
      product_version: null,
      firmware_version: null,
      audience_json: "[]",
      confidentiality: "public",
      allowed_tenants_json: "[]",
      lifecycle_status: "published",
      updated_at: new Date().toISOString(),
      error_codes_json: "[]",
      cli_commands_json: "[]",
      ui_paths_json: "[]",
      tags_json: "[]",
      embedding_json: "[]",
      token_count: 1,
    },
  ]);
}

function typeKeys() {
  return (rawDb.prepare("SELECT key FROM document_types").all()).map((r) => r.key);
}
function labelFor(key) {
  const r = rawDb.prepare("SELECT label FROM document_types WHERE key = ?").get(key);
  return r ? r.label : null;
}
function docType(id) {
  return rawDb.prepare("SELECT document_type FROM documents WHERE id = ?").get(id).document_type;
}
function chunkType(parent_id) {
  return rawDb.prepare("SELECT document_type FROM chunks WHERE parent_id = ?").get(parent_id).document_type;
}

// ---------------------------------------------------------------- defaults

test("cleaned defaults: the duplicate and generic types are no longer seeded", () => {
  const keys = typeKeys();
  for (const gone of ["user_manual", "bulletin", "api_reference", "kb_article"]) {
    assert.ok(!keys.includes(gone), `${gone} should not be seeded`);
  }
});

test("code-seeded types are present and correctly cased", () => {
  for (const [key, label] of [
    ["user_guide", "User Guide"],
    ["technical_bulletin", "Technical Bulletin"],
    ["operator_guide", "Operator Guide"],
    ["service_guide", "Service Guide"],
    ["parts_guide", "Parts Guide"],
    ["maintenance_guide", "Maintenance Guide"],
  ]) {
    assert.equal(labelFor(key), label, `${key} label`);
  }
});

test("IG reuses the built-in Installation Guide rather than duplicating it", () => {
  const rows = rawDb
    .prepare("SELECT key FROM document_types WHERE label = 'Installation Guide' COLLATE NOCASE")
    .all();
  assert.equal(rows.length, 1);
});

// ------------------------------------------------------------------ merge

test("merge re-tags documents and chunks, and removes the source type", () => {
  storage.createDocumentType("legacy_manual", "Legacy Manual");
  const a = makeDoc("legacy_manual");
  const b = makeDoc("legacy_manual");
  makeChunk(a, "legacy_manual");
  makeChunk(b, "legacy_manual");

  const affected = storage.mergeDocumentType("legacy_manual", "user_guide");

  assert.equal(affected, 2, "reported affected count");
  assert.equal(docType(a), "user_guide");
  assert.equal(docType(b), "user_guide");
  assert.equal(chunkType(a), "user_guide", "chunks must follow or the type resurrects on boot");
  assert.equal(chunkType(b), "user_guide");
  assert.ok(!typeKeys().includes("legacy_manual"), "source row removed");
});

test("merge re-points a filename code aimed at the merged-away type", () => {
  storage.createDocumentType("old_bulletin", "Old Bulletin");
  const mapping = readFilenameCodeMapping(rawDb);
  writeFilenameCodeMapping(rawDb, [...mapping, { code: "XB", doc_type_key: "old_bulletin" }]);

  storage.mergeDocumentType("old_bulletin", "technical_bulletin");

  const after = readFilenameCodeMapping(rawDb);
  const xb = after.find((r) => r.code === "XB");
  assert.ok(xb, "XB mapping still present");
  assert.equal(xb.doc_type_key, "technical_bulletin", "code follows the merge");
});

test("merge rejects self-merge, the fallback, and unknown types", () => {
  assert.throws(() => storage.mergeDocumentType("user_guide", "user_guide"), /into itself/);
  assert.throws(() => storage.mergeDocumentType("document", "user_guide"), /fallback/);
  assert.throws(() => storage.mergeDocumentType("nope_missing", "user_guide"), /not found/);
  assert.throws(() => storage.mergeDocumentType("user_guide", "nope_missing"), /Target/);
});

test("a failed merge leaves everything untouched", () => {
  storage.createDocumentType("keep_me", "Keep Me");
  const id = makeDoc("keep_me");
  assert.throws(() => storage.mergeDocumentType("keep_me", "nope_missing"));
  assert.equal(docType(id), "keep_me", "document not re-tagged by a failed merge");
  assert.ok(typeKeys().includes("keep_me"), "type row survives a failed merge");
});

// ------------------------------------------------- rename / delete repoint

test("rename that changes the key re-points its filename code", () => {
  storage.createDocumentType("temp_guide", "Temp Guide");
  const mapping = readFilenameCodeMapping(rawDb);
  writeFilenameCodeMapping(rawDb, [...mapping, { code: "XT", doc_type_key: "temp_guide" }]);

  storage.renameDocumentType("temp_guide", "renamed_guide", "Renamed Guide");

  const xt = readFilenameCodeMapping(rawDb).find((r) => r.code === "XT");
  assert.equal(xt.doc_type_key, "renamed_guide");
});

test("case-only rename keeps the key and the code mapping", () => {
  storage.createDocumentType("case_guide", "Case Guide");
  const mapping = readFilenameCodeMapping(rawDb);
  writeFilenameCodeMapping(rawDb, [...mapping, { code: "XC", doc_type_key: "case_guide" }]);

  storage.renameDocumentType("case_guide", "case_guide", "CASE GUIDE");

  assert.equal(labelFor("case_guide"), "CASE GUIDE");
  const xc = readFilenameCodeMapping(rawDb).find((r) => r.code === "XC");
  assert.equal(xc.doc_type_key, "case_guide");
});

test("delete drops its filename code rather than aiming it at the fallback", () => {
  storage.createDocumentType("doomed_guide", "Doomed Guide");
  const mapping = readFilenameCodeMapping(rawDb);
  writeFilenameCodeMapping(rawDb, [...mapping, { code: "XD", doc_type_key: "doomed_guide" }]);

  storage.deleteDocumentType("doomed_guide");

  const after = readFilenameCodeMapping(rawDb);
  assert.ok(!after.some((r) => r.code === "XD"), "dangling code removed");
  assert.ok(!after.some((r) => r.doc_type_key === "document" && r.code === "XD"));
});

test("pruneDanglingFilenameCodes repairs an already-corrupted mapping", () => {
  const mapping = readFilenameCodeMapping(rawDb);
  writeFilenameCodeMapping(rawDb, [...mapping, { code: "XZ", doc_type_key: "never_existed" }]);

  const dropped = pruneDanglingFilenameCodes(rawDb);

  assert.deepEqual(dropped, ["XZ"]);
  assert.ok(!readFilenameCodeMapping(rawDb).some((r) => r.code === "XZ"));
  assert.deepEqual(pruneDanglingFilenameCodes(rawDb), [], "second run is a no-op");
});

test("every surviving code mapping resolves to a real type", () => {
  const keys = new Set(typeKeys());
  for (const row of readFilenameCodeMapping(rawDb)) {
    assert.ok(keys.has(row.doc_type_key), `${row.code} -> ${row.doc_type_key} is dangling`);
  }
});
