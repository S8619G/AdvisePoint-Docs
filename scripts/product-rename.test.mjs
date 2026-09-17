// v1.1.3: bulk rename / merge for product_model and product_family.
//
// These run against a REAL throwaway sqlite database created by storage.ts
// itself, not a hand-rolled schema copy, so the test exercises the actual
// statements and the actual transaction. RAG_DB_PATH is set before the dynamic
// import because storage.ts resolves the database location at module load.
//
// Run: npm run test:product-rename
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "apd-product-rename-"));
process.env.RAG_DB_PATH = join(dir, "test.db");
process.env.RAG_PAGES_DIR = join(dir, "pages");

const { storage } = await import("../server/storage.ts");
const { SEED_WELCOME_GUIDE_DOC_ID } = await import("../server/seed-welcome-guide.ts");

let seq = 0;
function makeDoc(overrides = {}) {
  const id = overrides.id ?? `doc-${++seq}`;
  const now = new Date().toISOString();
  const row = {
    id,
    title: `Doc ${id}`,
    document_type: "user_manual",
    product_family: "TASKalfa",
    product_model: "MZ9500ci",
    file_name: `${id}.pdf`,
    ingested_at: now,
    updated_at: now,
    ...overrides,
  };
  storage.createDocument(row);
  return id;
}

/** Insert one chunk carrying the denormalized product_model, the way ingest
 *  does. The rename MUST move these or the Query tab filters on stale values. */
function makeChunk(parent_id, product_model, document_type = "user_manual") {
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
      product_model,
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

function modelOf(id) {
  return storage.getDocument(id).product_model;
}
function familyOf(id) {
  return storage.getDocument(id).product_family;
}
function chunkModels(parent_id) {
  return storage.getChunksForDoc(parent_id).map((c) => c.product_model);
}

test("rename moves every document using the old value", () => {
  const a = makeDoc({ product_model: "PA6000x" });
  const b = makeDoc({ product_model: "PA6000x" });
  const untouched = makeDoc({ product_model: "MZ10500i" });

  const affected = storage.renameProductModel("PA6000x", "PA6000x Series");

  assert.equal(affected, 2);
  assert.equal(modelOf(a), "PA6000x Series");
  assert.equal(modelOf(b), "PA6000x Series");
  assert.equal(modelOf(untouched), "MZ10500i", "an unrelated value must not move");
});

test("rename cascades to the denormalized chunks.product_model", () => {
  const doc = makeDoc({ product_model: "7353ci" });
  makeChunk(doc, "7353ci");
  makeChunk(doc, "7353ci");

  storage.renameProductModel("7353ci", "7353ci 8353ci");

  assert.deepEqual(chunkModels(doc), ["7353ci 8353ci", "7353ci 8353ci"]);
});

test("renaming onto an existing value merges the two", () => {
  const older = makeDoc({ product_model: "MA3500cifx" });
  const newer = makeDoc({ product_model: "MA3500cifx Series" });

  const affected = storage.renameProductModel("MA3500cifx", "MA3500cifx Series");

  assert.equal(affected, 1);
  assert.equal(modelOf(older), "MA3500cifx Series");
  assert.equal(modelOf(newer), "MA3500cifx Series");

  const values = storage.listProductValues();
  const merged = values.models.filter((m) => m.value.startsWith("MA3500cifx"));
  assert.equal(merged.length, 1, "the old value must be gone, not listed alongside");
  assert.equal(merged[0].value, "MA3500cifx Series");
  assert.equal(merged[0].count, 2, "the merged count is the sum");
});

test("a value can be cleared to blank now that product model is optional", () => {
  const doc = makeDoc({ product_model: "TB128" });
  makeChunk(doc, "TB128");

  const affected = storage.renameProductModel("TB128", "");

  assert.equal(affected, 1);
  assert.equal(modelOf(doc), "");
  assert.deepEqual(chunkModels(doc), [""]);
  const values = storage.listProductValues();
  assert.ok(
    !values.models.some((m) => m.value === "TB128"),
    "a cleared value disappears from the list",
  );
  assert.ok(
    !values.models.some((m) => m.value === ""),
    "blank is never offered as a value",
  );
});

test("family rename touches documents only -- chunks do not denormalize family", () => {
  const doc = makeDoc({ product_family: "ECOSYs", product_model: "PA5000x" });
  makeChunk(doc, "PA5000x");

  const affected = storage.renameProductFamily("ECOSYs", "ECOSYS");

  assert.equal(affected, 1);
  assert.equal(familyOf(doc), "ECOSYS");
  assert.deepEqual(chunkModels(doc), ["PA5000x"], "model must be unaffected");
});

test("the seeded Welcome Guide is never rewritten", () => {
  makeDoc({ id: SEED_WELCOME_GUIDE_DOC_ID, product_model: "AdvisePoint Docs" });
  const other = makeDoc({ product_model: "AdvisePoint Docs" });

  const affected = storage.renameProductModel("AdvisePoint Docs", "Renamed");

  assert.equal(affected, 1, "only the user's document counts");
  assert.equal(modelOf(SEED_WELCOME_GUIDE_DOC_ID), "AdvisePoint Docs");
  assert.equal(modelOf(other), "Renamed");
});

test("the seeded guide is excluded from the value list", () => {
  const values = storage.listProductValues();
  assert.ok(
    !values.models.some((m) => m.value === "AdvisePoint Docs"),
    "the built-in guide must not pollute the list",
  );
});

test("renaming an empty value is refused", () => {
  assert.throws(() => storage.renameProductModel("", "Something"), /cannot be empty/);
  assert.throws(() => storage.renameProductFamily("   ", "Something"), /cannot be empty/);
});

test("renaming a value to itself is a no-op", () => {
  const doc = makeDoc({ product_model: "Unchanged" });
  assert.equal(storage.renameProductModel("Unchanged", "Unchanged"), 0);
  assert.equal(modelOf(doc), "Unchanged");
});

test("renaming a value nothing uses affects nothing", () => {
  assert.equal(storage.renameProductModel("NoSuchModel", "Whatever"), 0);
});

test("counts reflect usage and the list is sorted case-insensitively", () => {
  const values = storage.listProductValues();
  const sorted = [...values.models].sort((a, b) =>
    a.value.toLowerCase().localeCompare(b.value.toLowerCase()),
  );
  assert.deepEqual(
    values.models.map((m) => m.value),
    sorted.map((m) => m.value),
  );
  for (const entry of values.models) {
    assert.ok(entry.count >= 1, `${entry.value} should have a positive count`);
  }
});

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
