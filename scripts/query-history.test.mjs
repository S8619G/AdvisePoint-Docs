// -----------------------------------------------------------------------------
// scripts/query-history.test.mjs -- v1.1.9 recent searches persistence
// -----------------------------------------------------------------------------
//
// Exercises server/query-history.ts against a stubbed better-sqlite3
// database so the dedupe rule, HISTORY_LIMIT truncation, and defensive
// coercion behavior are protected by regression tests. Same TS
// transpile + data-URL shim as upload-tab-store.test.mjs.
// -----------------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

// Stub the shared types import (types-only, no runtime).
const TYPES_STUB = "export {};";
const TYPES_URL = "data:text/javascript;base64," + Buffer.from(TYPES_STUB).toString("base64");

// Stub better-sqlite3's type import (type-only in the source, no runtime).
const DB_STUB = "export default {};";
const DB_URL = "data:text/javascript;base64," + Buffer.from(DB_STUB).toString("base64");

function transpileToDataUrl(src) {
  let js = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  js = js.replace(/from "@shared\/query-history-types"/g, `from "${TYPES_URL}"`);
  js = js.replace(/from "better-sqlite3"/g, `from "${DB_URL}"`);
  return "data:text/javascript;base64," + Buffer.from(js).toString("base64");
}

const src = readFileSync(resolve(REPO, "server/query-history.ts"), "utf8");
const url = transpileToDataUrl(src);
const mod = await import(url);
const { readQueryHistory, pushQueryHistoryEntry, clearQueryHistory, dedupeKeyFor } = mod;

// -----------------------------------------------------------------------------
// Fake DB. Reproduces just enough of better-sqlite3 for the module's
// three call shapes: SELECT / INSERT-OR-UPDATE / DELETE against the
// app_settings key/value table.
// -----------------------------------------------------------------------------

function makeFakeDb(initial = new Map()) {
  const store = new Map(initial);
  return {
    _store: store,
    prepare(sql) {
      const s = sql.trim().toUpperCase();
      if (s.startsWith("SELECT VALUE FROM APP_SETTINGS")) {
        return {
          get(key) {
            const v = store.get(key);
            return v === undefined ? undefined : { value: v };
          },
        };
      }
      if (s.startsWith("INSERT INTO APP_SETTINGS")) {
        return {
          run(key, value) {
            store.set(key, value);
          },
        };
      }
      if (s.startsWith("DELETE FROM APP_SETTINGS")) {
        return {
          run(key) {
            store.delete(key);
          },
        };
      }
      throw new Error("unexpected SQL: " + sql);
    },
  };
}

function baseEntry(overrides = {}) {
  return {
    q: "boot loop",
    matchMode: "smart",
    maxResults: 12,
    filters: {
      productModel: "",
      productFamily: "",
      docType: "",
      firmware: "",
      errorCode: "",
      confidentialityMax: "",
      selectedTags: [],
    },
    ranAt: 1000,
    ...overrides,
  };
}

test("empty store returns []", () => {
  const db = makeFakeDb();
  assert.deepEqual(readQueryHistory(db), []);
});

test("push then read round-trips", () => {
  const db = makeFakeDb();
  const list = pushQueryHistoryEntry(db, baseEntry({ ranAt: 1 }));
  assert.equal(list.length, 1);
  assert.equal(list[0].q, "boot loop");
  const roundtrip = readQueryHistory(db);
  assert.equal(roundtrip.length, 1);
  assert.equal(roundtrip[0].q, "boot loop");
});

test("blank q strings are dropped, not persisted", () => {
  const db = makeFakeDb();
  const list = pushQueryHistoryEntry(db, baseEntry({ q: "   " }));
  assert.equal(list.length, 0);
  assert.equal(readQueryHistory(db).length, 0);
});

test("HISTORY_LIMIT caps stored rows at 5", () => {
  const db = makeFakeDb();
  for (let i = 1; i <= 6; i++) {
    pushQueryHistoryEntry(db, baseEntry({ q: `query ${i}`, ranAt: i }));
  }
  const list = readQueryHistory(db);
  assert.equal(list.length, 5);
  // Newest first.
  assert.deepEqual(list.map((e) => e.q), ["query 6", "query 5", "query 4", "query 3", "query 2"]);
});

test("identical payload dedupes and bumps to top", () => {
  const db = makeFakeDb();
  pushQueryHistoryEntry(db, baseEntry({ q: "a", ranAt: 1 }));
  pushQueryHistoryEntry(db, baseEntry({ q: "b", ranAt: 2 }));
  pushQueryHistoryEntry(db, baseEntry({ q: "a", ranAt: 3 }));
  const list = readQueryHistory(db);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((e) => e.q), ["a", "b"]);
  assert.equal(list[0].ranAt, 3, "bumped entry carries the new ranAt");
});

test("different filters do NOT dedupe", () => {
  const db = makeFakeDb();
  pushQueryHistoryEntry(db, baseEntry({ q: "err", ranAt: 1 }));
  pushQueryHistoryEntry(
    db,
    baseEntry({ q: "err", ranAt: 2, filters: { ...baseEntry().filters, productModel: "ADV-100" } }),
  );
  const list = readQueryHistory(db);
  assert.equal(list.length, 2);
});

test("tag order does not affect dedupe (sorted-set equality)", () => {
  const db = makeFakeDb();
  pushQueryHistoryEntry(
    db,
    baseEntry({ q: "t", ranAt: 1, filters: { ...baseEntry().filters, selectedTags: ["a", "b"] } }),
  );
  pushQueryHistoryEntry(
    db,
    baseEntry({ q: "t", ranAt: 2, filters: { ...baseEntry().filters, selectedTags: ["b", "a"] } }),
  );
  const list = readQueryHistory(db);
  assert.equal(list.length, 1);
  assert.equal(list[0].ranAt, 2);
});

test("clearQueryHistory removes the row", () => {
  const db = makeFakeDb();
  pushQueryHistoryEntry(db, baseEntry({ q: "x", ranAt: 1 }));
  assert.equal(readQueryHistory(db).length, 1);
  clearQueryHistory(db);
  assert.equal(readQueryHistory(db).length, 0);
});

test("corrupt stored value returns [] instead of throwing", () => {
  const db = makeFakeDb(new Map([["query_history_v1", "{not json"]]));
  assert.deepEqual(readQueryHistory(db), []);
});

test("dedupeKeyFor is stable for identical payloads", () => {
  const a = baseEntry({ ranAt: 111 });
  const b = baseEntry({ ranAt: 222 }); // ranAt does NOT participate
  assert.equal(dedupeKeyFor(a), dedupeKeyFor(b));
});
