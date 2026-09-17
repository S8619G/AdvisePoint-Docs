// Pinned regression test for the Fix Title parser (v1.1.0).
//
// EXPECTED VALUES ARE GROUND TRUTH captured from the locked "Fix Title --
// Preview Tool" reference asset over the real 25-filename Doc-titles.txt
// corpus. If a change here fails, the parser has drifted from the locked rules
// -- fix the parser, do NOT edit these expectations.
//
// Run: node --test scripts/fix-title.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));

// Compile the TS source and import it, so the test exercises the SHIPPED module
// rather than a hand-copied duplicate of it.
const tsPath = join(here, "..", "client", "src", "lib", "fix-title.ts");
const js = ts.transpileModule(readFileSync(tsPath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = await import(
  "data:text/javascript;base64," + Buffer.from(js).toString("base64")
);
const { fixTitle, basicFilenameCleanup } = mod;

/** [rawFilename, expectedTitle] over the real corpus. */
const CORPUS = [
  ["2554ci-3554ci-4054ci-5054ci-6054ci-7054ciENOGR2024.7", "2554ci 3554ci 4054ci 5054ci 6054ci 7054ci EN OG R2024.07"],
  ["4004i_5004i_6004i_7004iENOGR2025_07", "4004i 5004i 6004i 7004i EN OG R2025.07"],
  ["7003i_8003i_9003iENOGR2020_5", "7003i 8003i 9003i EN OG R2020.05"],
  ["7353ci_8353ciENOGR2019_6", "7353ci 8353ci EN OG R2019.06"],
  ["MA6000cifxSeries-PA6000xSeriesENOGR2024.05-CCRX", "MA6000cifx Series PA6000x Series EN OG R2024.05 CCRX"],
  ["PA6000xSeriesENOG", "PA6000x Series EN OG"],
  ["MZ9500ciDataEncriptionOverwriteENOGR2025.08", "MZ9500ci Data Encription Overwrite EN OG R2025.08"],
  ["MZ9500ci-MZ10500iSeriesENOGR2025.09-FAX", "MZ9500ci MZ10500i Series EN OG R2025.09 FAX"],
  ["MZ9500ci-MZ10500iSeriesENOGR2025.10-CCRX", "MZ9500ci MZ10500i Series EN OG R2025.10 CCRX"],
  ["MZ9500ciSeriesENOGR2025.09", "MZ9500ci Series EN OG R2025.09"],
  ["DeviceManager_UserGuide_EN", "Device Manager User Guide EN"],
  ["KCCENOGR1.5.0.2025.06-UserGuide", "KCC EN OG R1.5.0 2025/06 User Guide"],
  ["KyoceraNetViewerENUGR2025.08", "KYOCERA Net Viewer EN UG R2025.08"],
  ["308ci_358ciENTB1R1", "308ci 358ci EN TB1 R1"],
  ["GENENTB128", "GEN EN TB128"],
  ["HyPASENTB11bc", "HyPAS EN TB11bc"],
  ["HyPASENTB17", "HyPAS EN TB17"],
  ["MZ7500ci-MZ8500ci-MZ9500ciENTB1", "MZ7500ci MZ8500ci MZ9500ci EN TB1"],
  ["MZ7500i-MZ8500i-MZ9500i-MZ10500iENTB1", "MZ7500i MZ8500i MZ9500i MZ10500i EN TB1"],
  ["MZ7500i-MZ8500i-MZ9500i-MZ10500iENTB1", "MZ7500i MZ8500i MZ9500i MZ10500i EN TB1"],
  ["IB-37,IB-38_Product_Specification_ver.4.0_e", "IB-37 IB-38 Product Specification ver 4 0 e"],
  ["KDA_NovaSeries_Brochure_Final_Digital_0217", "Kyocera Nova Series Brochure Final Digital 0217"],
  ["MA6000cifxSeries-PA6000xSeriesENOGR2024.05-CCRX", "MA6000cifx Series PA6000x Series EN OG R2024.05 CCRX"],
  ["KDA_ECOSYS_PA5000x_specsheet", "Kyocera ECOSYS PA5000x Spec Sheet"],
  ["KDA_ECOSYS_PA5500x_specsheet", "Kyocera ECOSYS PA5500x Spec Sheet"],
];

test("parses the full 25-filename corpus character-for-character", () => {
  for (const [filename, expected] of CORPUS) {
    const actual = fixTitle(filename).title;
    assert.equal(actual, expected, `\n  filename: ${filename}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
});

test("corpus fixture matches the shipped Doc-titles.txt corpus file", () => {
  const lines = readFileSync(join(here, "fix-title-corpus.txt"), "utf8")
    .split("\n").map((l) => l.trim()).filter(Boolean);
  assert.deepEqual(lines, CORPUS.map(([f]) => f));
});

test("is deterministic and side-effect free", () => {
  for (const [filename] of CORPUS) {
    assert.equal(fixTitle(filename).title, fixTitle(filename).title);
  }
});

test("returns tokens and an opt-in trace", () => {
  const off = fixTitle("KDA_ECOSYS_PA5000x_specsheet");
  assert.equal(off.trace, null);
  assert.ok(Array.isArray(off.tokens) && off.tokens.length > 0);
  assert.equal(off.tokens.join(" "), off.title);

  const on = fixTitle("KDA_ECOSYS_PA5000x_specsheet", { trace: true });
  assert.ok(Array.isArray(on.trace) && on.trace.length > 0);
  assert.equal(on.title, off.title);
});

test("x is never dropped as a model suffix letter", () => {
  assert.equal(fixTitle("PA6000xSeriesENOG").title, "PA6000x Series EN OG");
});

test("hyphenated accessory models keep their hyphen", () => {
  assert.ok(fixTitle("IB-37,IB-38_Product_Specification_ver.4.0_e").title.startsWith("IB-37 IB-38 "));
});

test("empty and degenerate input does not throw", () => {
  for (const s of ["", ".pdf", "document.pdf", "_", "---"]) {
    assert.equal(typeof fixTitle(s).title, "string");
  }
});

test("basicFilenameCleanup strips extension and separators only", () => {
  assert.equal(basicFilenameCleanup("KDA_ECOSYS_PA5000x_specsheet.pdf"), "KDA ECOSYS PA5000x specsheet");
});

test("v1.2.6 separates joined and on either side or both sides", () => {
  for (const [raw, expected] of [
    ["CloudPrintandScan.pdf", "Cloud Print and Scan"],
    ["CloudPrintand_Scan.pdf", "Cloud Print and Scan"],
    ["CloudPrint_andScan.pdf", "Cloud Print and Scan"],
    ["Print_andscan.pdf", "Print and scan"],
    ["Printandscan.pdf", "Print and scan"],
    ["BackupandRestore.pdf", "Backup and Restore"],
    ["ImportandExport.pdf", "Import and Export"],
  ]) {
    assert.equal(fixTitle(raw).title, expected, raw);
    assert.equal(fixTitle(raw).title, fixTitle(raw).title, "repeat original-filename parsing");
    assert.equal(fixTitle(expected).title, expected, "connector-only titles remain stable");
  }
});

test("v1.2.6 connector splitting preserves ordinary words, names and model codes", () => {
  for (const word of ["Standard", "Android", "Command", "Brand", "Hand", "Land",
    "Sand", "Island", "Finland", "England", "Anderson", "Sander", "Printanderson",
    "PA6000x", "TB11bc", "Cloud Print and Scan"]) {
    assert.equal(fixTitle(`${word}.pdf`).title, word, word);
  }
  const result = fixTitle("CloudPrintandScan.pdf", { trace: true });
  assert.equal(result.tokens.join(" "), "Cloud Print and Scan");
  assert.ok(result.trace.some((line) => line.includes("connector-split")));
});
