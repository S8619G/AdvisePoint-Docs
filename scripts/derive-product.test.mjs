// v1.1.3 -- pins product model/family derivation against the REAL 25-filename
// corpus in scripts/fix-title-corpus.txt.
//
// Every expectation below comes from that corpus plus the four decisions
// recorded in docs/v1.1.3-plan.md. The companion assertion at the bottom is the
// important one: deriving a product must not change Fix Title output for any
// corpus line, because the tokenizer rules are LOCKED.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const { deriveProduct } = await import(join(root, "client/src/lib/derive-product.ts"));
const { fixTitle } = await import(join(root, "client/src/lib/fix-title.ts"));

/** The default document-type codes shipped in server/filename-codes.ts. */
const CODES = ["OG", "UG", "TB", "SG", "PG", "MG", "IG"];

const corpus = readFileSync(join(root, "scripts/fix-title-corpus.txt"), "utf8")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean);

// [filename, expected family, expected model]
const CASES = [
  // --- multi-model guides: every model kept, separators become spaces ---
  ["2554ci-3554ci-4054ci-5054ci-6054ci-7054ciENOGR2024.7", "", "2554ci 3554ci 4054ci 5054ci 6054ci 7054ci"],
  ["4004i_5004i_6004i_7004iENOGR2025_07", "", "4004i 5004i 6004i 7004i"],
  ["7003i_8003i_9003iENOGR2020_5", "", "7003i 8003i 9003i"],
  ["7353ci_8353ciENOGR2019_6", "", "7353ci 8353ci"],

  // --- Series handling: collapse to ONE trailing Series (decision 2) ---
  ["MA6000cifxSeries-PA6000xSeriesENOGR2024.05-CCRX", "", "MA6000cifx PA6000x Series"],
  ["PA6000xSeriesENOG", "", "PA6000x Series"],
  ["MZ9500ci-MZ10500iSeriesENOGR2025.09-FAX", "", "MZ9500ci MZ10500i Series"],
  ["MZ9500ci-MZ10500iSeriesENOGR2025.10-CCRX", "", "MZ9500ci MZ10500i Series"],
  ["MZ9500ciSeriesENOGR2025.09", "", "MZ9500ci Series"],

  // --- model followed by descriptive words ---
  ["MZ9500ciDataEncriptionOverwriteENOGR2025.08", "", "MZ9500ci"],

  // --- technical bulletins: TB codes are NEVER models (user-confirmed) ---
  ["308ci_358ciENTB1R1", "", "308ci 358ci"],
  ["GENENTB128", "", ""],
  ["HyPASENTB11bc", "", ""],
  ["HyPASENTB17", "", ""],
  ["MZ7500ci-MZ8500ci-MZ9500ciENTB1", "", "MZ7500ci MZ8500ci MZ9500ci"],
  ["MZ7500i-MZ8500i-MZ9500i-MZ10500iENTB1", "", "MZ7500i MZ8500i MZ9500i MZ10500i"],

  // --- hyphen INSIDE a model name is part of the name ---
  ["IB-37,IB-38_Product_Specification_ver.4.0_e", "", "IB-37 IB-38"],

  // --- family recognized, prefixed onto the model (decision 1) ---
  ["KDA_ECOSYS_PA5000x_specsheet", "ECOSYS", "ECOSYS PA5000x"],
  ["KDA_ECOSYS_PA5500x_specsheet", "ECOSYS", "ECOSYS PA5500x"],

  // --- no model present: blank is a legitimate answer now ---
  ["DeviceManager_UserGuide_EN", "", ""],
  ["KCCENOGR1.5.0.2025.06-UserGuide", "", ""],
  ["KyoceraNetViewerENUGR2025.08", "", ""],
  // "Nova Series" is a marketing name and 0217 is a date code, not a model.
  // A bare "Series" with no model must not produce a model.
  ["KDA_NovaSeries_Brochure_Final_Digital_0217", "", ""],
];

for (const [filename, family, model] of CASES) {
  test(`derive: ${filename}`, () => {
    const got = deriveProduct(filename, CODES);
    assert.equal(got.product_model, model, "product_model");
    assert.equal(got.product_family, family, "product_family");
  });
}

test("every corpus filename is covered by a case", () => {
  const covered = new Set(CASES.map(([f]) => f));
  const missing = corpus.filter((line) => !covered.has(line));
  assert.deepEqual(missing, [], `uncovered corpus filenames: ${missing.join(", ")}`);
});

test("revision and date tokens are never treated as models", () => {
  assert.equal(deriveProduct("ReportR2024.07", CODES).product_model, "");
  assert.equal(deriveProduct("Notes_R1", CODES).product_model, "");
  assert.equal(deriveProduct("Brochure_0217", CODES).product_model, "");
});

test("a user-added filename code is excluded too", () => {
  // "ZZ" is not a default code. Without it configured, ZZ42 looks model-shaped.
  assert.equal(deriveProduct("GENENZZ42", CODES).product_model, "ZZ42");
  // Once the user adds it as a code, it must stop being a model.
  assert.equal(deriveProduct("GENENZZ42", [...CODES, "ZZ"]).product_model, "");
});

test("deriving does not change Fix Title output for any corpus filename", () => {
  for (const line of corpus) {
    const before = fixTitle(line).title;
    deriveProduct(line, CODES);
    const after = fixTitle(line).title;
    assert.equal(after, before, `Fix Title drifted for ${line}`);
  }
});
