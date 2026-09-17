// Pinned regression test for the detectDocType() classifier (v1.1.0).
//
// Uses the same transpile-and-import pattern as scripts/fix-title.test.mjs so
// the test exercises the SHIPPED module. detect-doctype.ts internally calls
// fix-title.ts, so we transpile both and wire the import together via a small
// in-memory module registry (dynamic imports resolve against the transpiled
// data: URLs).
//
// Run: node --test scripts/detect-doctype.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));

function transpile(tsPath) {
  return ts.transpileModule(readFileSync(tsPath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

// Import fix-title.ts first so we get its data: URL, then rewrite the detect
// module's `./fix-title` import to point at that URL before we import it.
const fixTitleJs = transpile(join(here, "..", "client", "src", "lib", "fix-title.ts"));
const fixTitleUrl = "data:text/javascript;base64," + Buffer.from(fixTitleJs).toString("base64");

let detectJs = transpile(join(here, "..", "client", "src", "lib", "detect-doctype.ts"));
detectJs = detectJs.replace(/from ["']\.\/fix-title["']/g, `from "${fixTitleUrl}"`);
const detectUrl = "data:text/javascript;base64," + Buffer.from(detectJs).toString("base64");
const { detectDocType } = await import(detectUrl);

// Mapping shaped like what the server would seed after resolving labels
// against the document_types registry. The exact keys used here only need to
// match themselves -- the test asserts identity of the returned key.
const MAPPING = [
  { code: "OG", doc_type_key: "operator_guide" },
  { code: "UG", doc_type_key: "user_guide" },
  { code: "TB", doc_type_key: "technical_bulletin" },
  { code: "SG", doc_type_key: "service_guide" },
  { code: "PG", doc_type_key: "parts_guide" },
  { code: "MG", doc_type_key: "maintenance_guide" },
  { code: "IG", doc_type_key: "installation_guide" },
];

test("OG in a Kyocera-format filename resolves to Operator Guide", () => {
  assert.equal(detectDocType("MZ9500ci-MZ10500iSeriesENOGR2025.09-FAX.pdf", MAPPING), "operator_guide");
});

test("UG resolves to User Guide even without extension", () => {
  assert.equal(detectDocType("KyoceraNetViewerENUGR2025.08", MAPPING), "user_guide");
});

test("TB1 compound resolves to Technical Bulletin (leading TB counts, digits ignored)", () => {
  assert.equal(detectDocType("308ci_358ciENTB1R1.pdf", MAPPING), "technical_bulletin");
});

test("TB128 (larger bulletin number) still resolves to Technical Bulletin", () => {
  assert.equal(detectDocType("GENENTB128", MAPPING), "technical_bulletin");
});

test("TB11bc (letter suffix on bulletin) still resolves to Technical Bulletin", () => {
  assert.equal(detectDocType("HyPASENTB11bc", MAPPING), "technical_bulletin");
});

test("no guide code in filename returns null", () => {
  assert.equal(detectDocType("KDA_ECOSYS_PA5000x_specsheet.pdf", MAPPING), null);
});

test("empty filename returns null", () => {
  assert.equal(detectDocType("", MAPPING), null);
});

test("empty mapping returns null", () => {
  assert.equal(detectDocType("MZ9500ciSeriesENOGR2025.09", []), null);
});

test("last matching code wins when multiple codes appear", () => {
  // Contrived: both UG and TB appear -- TB is later -> Technical Bulletin.
  assert.equal(detectDocType("SomethingUGSomethingTB1.pdf", MAPPING), "technical_bulletin");
  // Same filename with the order flipped -> UG wins.
  assert.equal(detectDocType("SomethingTB1SomethingUG.pdf", MAPPING), "user_guide");
});

test("orphan mapping row (blank doc_type_key) cannot classify", () => {
  const orphan = [
    { code: "UG", doc_type_key: "" },
    { code: "OG", doc_type_key: "operator_guide" },
  ];
  // UG token would match but the row is orphaned; nothing else matches.
  assert.equal(detectDocType("KyoceraNetViewerENUGR2025.08", orphan), null);
  // OG still works.
  assert.equal(detectDocType("MZ9500ciSeriesENOGR2025.09", orphan), "operator_guide");
});

test("mixed case in stored code is normalized to uppercase", () => {
  const mixed = [{ code: "og", doc_type_key: "operator_guide" }];
  assert.equal(detectDocType("MZ9500ciSeriesENOGR2025.09", mixed), "operator_guide");
});

test("custom code beyond the defaults classifies when the parser tokenizes it standalone", () => {
  // "CG" is not a default; the parser leaves 2-letter uppercase runs as
  // standalone tokens, so a user-added mapping is honored.
  const extended = [...MAPPING, { code: "CG", doc_type_key: "customer_guide" }];
  assert.equal(detectDocType("HyPASENCG", extended), "customer_guide");
});

test("PA6000xSeriesENOG resolves to Operator Guide (real corpus row)", () => {
  assert.equal(detectDocType("PA6000xSeriesENOG.pdf", MAPPING), "operator_guide");
});

// ---------------------------------------------------------------------------
// v1.1.2 field-test regressions: hyphen/underscore between code and number.
//
// Reported from field testing: "the automatic document setting did not work
// when loading a TB1 or TB file type". Bare "TB1"/"TB" already worked at this
// layer (the primary cause was the single-file upload form never applying
// detection at all -- see scripts/upload-page.test.mjs). But probing the
// parser turned up a genuine second gap here: the Fix Title tokenizer keeps an
// internal hyphen, so "TB-1" arrives as ONE token "TB-1" and the old
// code-prefix regex rejected it outright. Every hyphen- or underscore-
// separated code silently failed to classify.
// ---------------------------------------------------------------------------

test("hyphen between code and number still classifies (TB-1 family)", () => {
  assert.equal(detectDocType("TB-1.pdf", MAPPING), "technical_bulletin");
  assert.equal(detectDocType("TB-001.pdf", MAPPING), "technical_bulletin");
  assert.equal(detectDocType("TB-1234-fuser-replacement.pdf", MAPPING), "technical_bulletin");
  assert.equal(detectDocType("TASKalfa-TB-12-fuser.pdf", MAPPING), "technical_bulletin");
});

test("underscore between code and number still classifies", () => {
  assert.equal(detectDocType("TB_1.pdf", MAPPING), "technical_bulletin");
  assert.equal(detectDocType("MZ9500ci_TB_12_fuser.pdf", MAPPING), "technical_bulletin");
});

test("bare TB and TB1 keep working (the shapes named in the field report)", () => {
  assert.equal(detectDocType("TB.pdf", MAPPING), "technical_bulletin");
  assert.equal(detectDocType("TB1.pdf", MAPPING), "technical_bulletin");
  assert.equal(detectDocType("TB1a.pdf", MAPPING), "technical_bulletin");
  assert.equal(detectDocType("TB 1.pdf", MAPPING), "technical_bulletin");
});

test("detection itself does not uppercase tokens (lowercase tb1 stays unmatched)", () => {
  // detect-doctype deliberately does NOT uppercase tokens before lookup, so a
  // lowercase run the parser left alone cannot classify.
  assert.equal(detectDocType("tb1-lowercase.pdf", MAPPING), null);
});

test("DOCUMENTED pre-existing behaviour: the parser normalizes 'pg12' to PG + 12", () => {
  // Not introduced by the v1.1.2 hyphen fix -- verified against the unmodified
  // v1.1.0 parser. fixTitle("service-pg12-note.pdf") emits
  // ["service", "PG", "12", "note"]: it treats a short letter-run followed by
  // digits as a code and uppercases it. So this classifies as Parts Guide even
  // though "pg12" more likely meant "page 12".
  //
  // Locked in as a characterization test rather than "fixed": correcting it
  // means changing the shared Fix Title tokenizer, which would alter visible
  // Fix Title output that is confirmed working in the field. Flagged for a
  // product decision instead.
  assert.equal(detectDocType("service-pg12-note.pdf", MAPPING), "parts_guide");
});

test("hyphen tolerance does not let a plain word classify", () => {
  // "note-12" -> prefix would be "note" which is not uppercase; no match.
  assert.equal(detectDocType("note-12.pdf", MAPPING), null);
  assert.equal(detectDocType("revision-2025.pdf", MAPPING), null);
});

// ---------------------------------------------------------------------------
// v1.2.4 Filename phrases: plain-English word-boundary detection that runs
// ONLY when the code detector returns null. Every existing Kyocera short-
// code test above must continue to pass unchanged when the same MAPPING is
// used with an added phrase mapping -- codes always run first.
// ---------------------------------------------------------------------------

const PHRASES = [
  { phrase: "User Guide", doc_type_key: "user_guide" },
  { phrase: "Operator Guide", doc_type_key: "operator_guide" },
  { phrase: "Technical Bulletin", doc_type_key: "technical_bulletin" },
  { phrase: "Service Guide", doc_type_key: "service_guide" },
  { phrase: "Parts Guide", doc_type_key: "parts_guide" },
  { phrase: "Maintenance Guide", doc_type_key: "maintenance_guide" },
  { phrase: "Installation Guide", doc_type_key: "installation_guide" },
];

test("phrase: plain 'User Guide.pdf' classifies via the phrase path", () => {
  assert.equal(detectDocType("User Guide.pdf", MAPPING, PHRASES), "user_guide");
});

test("phrase: underscore and hyphen separators normalize to the same phrase", () => {
  assert.equal(detectDocType("User_Guide.pdf", MAPPING, PHRASES), "user_guide");
  assert.equal(detectDocType("user-guide-v2.pdf", MAPPING, PHRASES), "user_guide");
  assert.equal(
    detectDocType("Kyocera TASKalfa 3253ci User Guide EN.pdf", MAPPING, PHRASES),
    "user_guide",
  );
  assert.equal(
    detectDocType("taskalfa-3253ci-user-guide.pdf", MAPPING, PHRASES),
    "user_guide",
  );
});

test("phrase: no word boundary means no match (superuserguidebook / userguidance)", () => {
  assert.equal(detectDocType("superuserguidebook.pdf", MAPPING, PHRASES), null);
  assert.equal(detectDocType("userguidance.pdf", MAPPING, PHRASES), null);
});

test("phrase: Kyocera short-code filename still classifies via the code, not any phrase", () => {
  // Codes run first, so a real Kyocera OG filename must still hit the code
  // path even with the full phrase list loaded.
  assert.equal(
    detectDocType("MZ9500ci-MZ10500iSeriesENOGR2025.09-FAX.pdf", MAPPING, PHRASES),
    "operator_guide",
  );
});

test("phrase: filename that matches both a code (UG) and a phrase (user guide) uses the code", () => {
  // "KyoceraNetViewer_UG_user guide.pdf" -- UG standalone plus "user guide"
  // words. Codes-first rule means user_guide comes from the code path, but
  // note that both point at the same key here, so this test guards the
  // control flow more than the outcome. Use divergent keys to prove it.
  const codeMap = [{ code: "UG", doc_type_key: "kyocera_user_guide" }];
  const phraseMap = [{ phrase: "User Guide", doc_type_key: "plain_user_guide" }];
  assert.equal(
    detectDocType("KyoceraNetViewer_UG_user guide.pdf", codeMap, phraseMap),
    "kyocera_user_guide",
  );
});

test("phrase: two matching phrases -- longer phrase wins", () => {
  const map = [
    { phrase: "Parts Guide", doc_type_key: "parts_guide" },
    { phrase: "Parts and Service Guide", doc_type_key: "parts_and_service_guide" },
  ];
  assert.equal(
    detectDocType("Acme Parts and Service Guide v3.pdf", MAPPING, map),
    "parts_and_service_guide",
  );
});

test("phrase: equal-length ties fall back to last-write-wins in mapping order", () => {
  const map = [
    { phrase: "User Guide", doc_type_key: "first" },
    { phrase: "user guide", doc_type_key: "second" }, // same normalized form
  ];
  assert.equal(detectDocType("User Guide.pdf", MAPPING, map), "second");
});

test("phrase: orphan row (blank doc_type_key) cannot classify", () => {
  const map = [{ phrase: "User Guide", doc_type_key: "" }];
  assert.equal(detectDocType("User Guide.pdf", MAPPING, map), null);
});

test("phrase: undefined phrase mapping preserves pre-v1.2.4 behavior exactly", () => {
  // Calling with 2 args must return null on a plain-English filename that
  // has no code. Calling with 2 args must still classify a Kyocera code.
  assert.equal(detectDocType("User Guide.pdf", MAPPING), null);
  assert.equal(detectDocType("MZ9500ciSeriesENOGR2025.09", MAPPING), "operator_guide");
});

test("phrase: empty phrase mapping array preserves pre-v1.2.4 behavior exactly", () => {
  assert.equal(detectDocType("User Guide.pdf", MAPPING, []), null);
});

test("phrase: filename with no extension still normalizes and matches", () => {
  assert.equal(detectDocType("User Guide", MAPPING, PHRASES), "user_guide");
  assert.equal(detectDocType("user_guide", MAPPING, PHRASES), "user_guide");
});

test("phrase: multiple dots -- only the LAST is dropped as an extension", () => {
  // "user.guide.pdf" -> drop ".pdf" -> "user.guide" -> normalized "user guide".
  assert.equal(detectDocType("user.guide.pdf", MAPPING, PHRASES), "user_guide");
});
