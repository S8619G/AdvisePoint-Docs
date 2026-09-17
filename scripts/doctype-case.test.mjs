// v1.1.4: pins the document type label casing rule.
import test from "node:test";
import assert from "node:assert/strict";
import { titleCaseLabel, labelFromKey } from "../shared/doctype-case.ts";

const cases = [
  // the reported defect
  ["technical bulletin", "Technical Bulletin"],
  // plain lowercase input
  ["user guide", "User Guide"],
  ["operator guide", "Operator Guide"],
  ["parts guide", "Parts Guide"],
  // already correct, unchanged
  ["Technical Bulletin", "Technical Bulletin"],
  ["Installation Guide", "Installation Guide"],
  // ALL CAPS input gets normalized down
  ["SERVICE GUIDE", "Service Guide"],
  // acronyms keep their canonical form regardless of input case
  ["api reference", "API Reference"],
  ["API reference", "API Reference"],
  ["kb article", "KB Article"],
  ["mfp quick reference", "MFP Quick Reference"],
  ["pdf notes", "PDF Notes"],
  // mixed-case brand names survive
  ["hypas guide", "HyPAS Guide"],
  ["HyPAS guide", "HyPAS Guide"],
  // deliberate internal casing / digits are never mangled
  ["MZ9500ci notes", "MZ9500ci Notes"],
  ["iOS companion", "iOS Companion"],
  ["TASKalfa bulletin", "TASKalfa Bulletin"],
  // whitespace hygiene
  ["  spaced   out  ", "Spaced Out"],
  // punctuation is preserved around the word
  ["parts (legacy)", "Parts (Legacy)"],
  ["service/parts guide", "Service/parts Guide"],
  // degenerate input
  ["", ""],
];

for (const [input, expected] of cases) {
  test(`titleCaseLabel(${JSON.stringify(input)}) -> ${JSON.stringify(expected)}`, () => {
    assert.equal(titleCaseLabel(input), expected);
  });
}

test("titleCaseLabel is idempotent across every case", () => {
  for (const [, expected] of cases) {
    assert.equal(titleCaseLabel(expected), expected, `not idempotent: ${expected}`);
  }
});

test("labelFromKey converts the backfill's key form", () => {
  assert.equal(labelFromKey("technical_bulletin"), "Technical Bulletin");
  assert.equal(labelFromKey("user_guide"), "User Guide");
  assert.equal(labelFromKey("api_reference"), "API Reference");
  assert.equal(labelFromKey("misc"), "Misc");
});

test("null and undefined do not throw", () => {
  assert.equal(titleCaseLabel(undefined), "");
  assert.equal(labelFromKey(undefined), "");
});
