// v1.3.5 unit tests: Library quick search matching, Auto Search preference,
// and the Recent searches "replaces" option used by Auto Search re-runs.
// Run with: node --import tsx --test scripts/features135.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeQuickSearch,
  quickSearchWords,
  quickSearchFields,
  docMatchesQuickSearch,
} from "../client/src/lib/libraryQuickSearch.ts";
import {
  readAutoSearchPref,
  writeAutoSearchPref,
  historyKeyFor,
  AUTO_SEARCH_STORAGE_KEY,
  AUTO_SEARCH_DELAY_MS,
} from "../client/src/lib/queryAutoSearch.ts";
import { pushQueryHistoryEntry, readQueryHistory, dedupeKeyFor } from "../server/query-history.ts";

const faxGuide = {
  title: "MZ9500ci / MZ10500i Series FAX Operation Guide",
  subtitle: "FAX System 12",
  file_name: "MZ9500ci-MZ10500iSeriesENOGR2025.09-FAX.pdf",
  document_type: "fax_guide",
  product_model: "MZ9500ci",
  product_family: "MZ Series",
  product_sku: "SKU-4411",
  product_version: "2025.09",
  firmware_version: "2R4_1000.002",
  release_channel: "ga",
  lifecycle_status: "published",
  confidentiality: "internal",
  tags: ["forwarding"],
  keywords: ["dialing"],
};
const serviceManual = {
  title: "MZ9500ci Service Manual",
  file_name: "MZ9500ci_SM_Rev4.pdf",
  document_type: "service_manual",
  product_model: "MZ9500ci",
  product_family: "MZ Series",
  tags: ["fuser"],
  keywords: [],
};
const labels = { typeLabel: "FAX Guide", channelLabel: "General availability" };

test("normalize folds case and separators", () => {
  assert.equal(normalizeQuickSearch("  MZ9500ci_FAX-Guide.v2  "), "mz9500ci fax guide v2");
  assert.equal(normalizeQuickSearch(null), "");
  assert.deepEqual(quickSearchWords("MZ9500ci--FAX"), ["mz9500ci", "fax"]);
  assert.deepEqual(quickSearchWords("   "), []);
});

test("spec examples match the FAX guide", () => {
  for (const q of ["MZ9500 fax", "MZ9500ci FAX", "MZ9500ci-FAX", "mz9500ci_fax", "mz9500ci.fax"]) {
    assert.equal(docMatchesQuickSearch(faxGuide, q, labels), true, q);
  }
  assert.equal(docMatchesQuickSearch(serviceManual, "MZ9500 fax", { typeLabel: "Service Manual" }), false);
  assert.equal(docMatchesQuickSearch(faxGuide, "MZ9500ci-MZ10500iSeriesENOGR2025.09-FAX", labels), true);
});

test("every word must match some field; empty query matches all", () => {
  assert.equal(docMatchesQuickSearch(faxGuide, "fax nonexistentword", labels), false);
  assert.equal(docMatchesQuickSearch(faxGuide, "", labels), true);
  assert.equal(docMatchesQuickSearch(serviceManual, "   ", {}), true);
});

test("each metadata field is searchable", () => {
  for (const q of ["SKU-4411", "2025.09", "2R4_1000", "internal", "published", "forwarding", "dialing",
    "MZ Series", "fax_guide", "FAX Guide", "General availability", "ENOGR2025"]) {
    assert.equal(docMatchesQuickSearch(faxGuide, q, labels), true, q);
  }
});

test("document text, summary and excerpts are never searched", () => {
  const doc = { ...serviceManual, summary: "toner drum", text: "paper jam", excerpt: "duplex unit", sections: ["registration"] };
  for (const q of ["toner", "jam", "duplex", "registration"]) {
    assert.equal(docMatchesQuickSearch(doc, q, {}), false, q);
  }
  assert.ok(!quickSearchFields(doc).some((f) => f.includes("toner")));
});

test("missing and malformed fields are tolerated", () => {
  assert.equal(docMatchesQuickSearch({ title: "Only a title", tags: null, keywords: undefined }, "title"), true);
  assert.equal(docMatchesQuickSearch({}, "x"), false);
});

test("Auto Search preference defaults on and round-trips", () => {
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) };
  assert.equal(readAutoSearchPref(storage), true);
  writeAutoSearchPref(false, storage);
  assert.equal(mem.get(AUTO_SEARCH_STORAGE_KEY), "0");
  assert.equal(readAutoSearchPref(storage), false);
  writeAutoSearchPref(true, storage);
  assert.equal(readAutoSearchPref(storage), true);
  assert.equal(readAutoSearchPref({ getItem: () => { throw new Error("blocked"); } }), true);
  assert.equal(readAutoSearchPref(null), true);
  assert.ok(AUTO_SEARCH_DELAY_MS >= 200 && AUTO_SEARCH_DELAY_MS <= 500);
});

function fakeDb() {
  const store = new Map();
  return {
    prepare(sql) {
      const s = sql.trim().toUpperCase();
      if (s.startsWith("SELECT")) return { get: (k) => (store.has(k) ? { value: store.get(k) } : undefined) };
      if (s.startsWith("INSERT")) return { run: (k, v) => store.set(k, v) };
      if (s.startsWith("DELETE")) return { run: (k) => store.delete(k) };
      throw new Error("unexpected sql " + sql);
    },
  };
}
const entry = (q, model = "", extra = {}) => ({
  q, matchMode: "smart", maxResults: 10, ranAt: Date.now(),
  filters: { productModel: model, productFamily: "", docType: "", firmware: "", errorCode: "", confidentialityMax: "", selectedTags: [], ...extra },
});

test("client history key matches the server dedupe key", () => {
  const cases = [
    entry("fuser"),
    entry(" fuser ", "MZ9500ci"),
    entry("fuser", "", { productFamily: "MZ", selectedFamilyOnly: true, selectedTags: ["b", "a"] }),
    entry("fuser", "", { selectedFamilyOnly: true }),
  ];
  for (const e of cases) assert.equal(historyKeyFor(e), dedupeKeyFor(e));
});

test("replaces removes only the previous auto entry", () => {
  const db = fakeDb();
  pushQueryHistoryEntry(db, entry("older"));
  pushQueryHistoryEntry(db, entry("fuser")); // manual search
  const auto1 = entry("fuser", "A");
  pushQueryHistoryEntry(db, auto1); // first auto re-run: no replaces
  const auto2 = entry("fuser", "B");
  pushQueryHistoryEntry(db, auto2, auto1);
  const auto3 = entry("fuser", "C");
  const list = pushQueryHistoryEntry(db, auto3, auto2);
  assert.deepEqual(list.map((e) => `${e.q}|${e.filters.productModel}`), ["fuser|C", "fuser|", "older|"]);
  assert.equal(readQueryHistory(db).length, 3);
});

test("malformed or missing replaces is ignored", () => {
  const db = fakeDb();
  pushQueryHistoryEntry(db, entry("a"));
  pushQueryHistoryEntry(db, entry("b"), { nonsense: true });
  pushQueryHistoryEntry(db, entry("c"), "x");
  pushQueryHistoryEntry(db, entry("d"), null);
  assert.deepEqual(readQueryHistory(db).map((e) => e.q), ["d", "c", "b", "a"]);
});

test("replacing an entry equal to the new one keeps the new one", () => {
  const db = fakeDb();
  const e1 = entry("x", "A");
  pushQueryHistoryEntry(db, e1);
  pushQueryHistoryEntry(db, entry("x", "A"), e1);
  assert.equal(readQueryHistory(db).length, 1);
});
