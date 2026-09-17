// -----------------------------------------------------------------------------
// scripts/upload-meta-select.test.mjs -- v1.1.8 regression test
// -----------------------------------------------------------------------------
//
// Guards the fix for the v1.1.1 -> v1.1.7 defect where every multi-file
// upload silently dropped its staged metadata. The pre-v1.1.8 batch loop
// wrote:
//
//     const metaForFile = isBatch ? emptyMeta() : shared;
//
// which sent an empty block for BOTH batch modes:
//
//   - "Different per file": ignored the per-file cards populated by the
//     Fix Title and Detect type buttons. Every doc arrived as
//     document_type="document" with a filename-derived title.
//   - "Same metadata for all": the shared form was hidden anyway (rendered
//     only when !isBatch), so this was consistent but useless.
//
// The v1.1.8 fix routes selection through selectMetaForFile() -- a pure
// helper that this test exercises directly. If a future edit reintroduces
// the old branch, this test fails.
//
// Uses the same TS transpile + data-URL import shim as
// upload-tab-store.test.mjs.
// -----------------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

const src = readFileSync(resolve(REPO, "client/src/lib/upload-meta-select.ts"), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
}).outputText;
const url = "data:text/javascript;base64," + Buffer.from(js).toString("base64");
const { selectMetaForFile } = await import(url);

// Sentinels the caller can identify by reference. selectMetaForFile is
// generic and structurally typed, so the identity of the object returned
// is exactly what matters -- the helper does not clone, mutate, or merge.
const SHARED = { title: "shared", document_type: "operator_guide" };
const ENTRY = { title: "entry", document_type: "release_notes" };

test("single-file (isBatch=false) always sends the shared block", () => {
  for (const mode of ["batch-shared", "batch-perfile"]) {
    const out = selectMetaForFile({ isBatch: false, mode, entryMeta: ENTRY, shared: SHARED });
    assert.strictEqual(out, SHARED, `single-file, mode=${mode} should return shared`);
  }
});

test('batch + "batch-perfile" sends this entry\'s own meta', () => {
  const out = selectMetaForFile({
    isBatch: true,
    mode: "batch-perfile",
    entryMeta: ENTRY,
    shared: SHARED,
  });
  assert.strictEqual(out, ENTRY);
});

test('batch + "batch-shared" sends the shared block', () => {
  const out = selectMetaForFile({
    isBatch: true,
    mode: "batch-shared",
    entryMeta: ENTRY,
    shared: SHARED,
  });
  assert.strictEqual(out, SHARED);
});

test("returned reference is exactly one of the two inputs (no cloning or merging)", () => {
  // The helper must not construct or mutate objects. Callers rely on this:
  // uploadOne serializes the returned Meta straight into FormData, so any
  // structural change here would be a silent behavior change.
  const out = selectMetaForFile({
    isBatch: true,
    mode: "batch-perfile",
    entryMeta: ENTRY,
    shared: SHARED,
  });
  assert.ok(out === ENTRY || out === SHARED, "must be identity-equal to an input");
});

test("regression guard: batch mode never returns a fresh empty object", () => {
  // Pre-v1.1.8 the batch branch was `emptyMeta()` -- a fresh object with
  // document_type="document". This assertion fails loudly if that branch
  // is ever reintroduced. Any Meta with truthy document_type is fine here;
  // what we're guarding against is a NEW object that is neither input.
  for (const mode of ["batch-shared", "batch-perfile"]) {
    const out = selectMetaForFile({
      isBatch: true,
      mode,
      entryMeta: ENTRY,
      shared: SHARED,
    });
    assert.ok(
      out === ENTRY || out === SHARED,
      `batch mode=${mode} must not fabricate a new meta object`,
    );
  }
});
