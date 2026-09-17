// v1.1.0 item 5 - uploadTabStore behavior tests.
//
// We can't run the React binding here (no DOM), but the store itself is
// plain JS and testable directly. We cover:
//   * initial state matches the shape upload.tsx expects
//   * setState merges rather than replaces
//   * subscribe/unsubscribe fires listeners
//   * "survives unmount": mutations after the last listener unsubscribes
//     are still readable when a new listener subscribes (this is the
//     essence of the fix - the module-level singleton is not tied to a
//     React component's lifecycle)
//   * reset restores initial state
//   * countUploadsInProgress: 0 when idle, N pending+uploading when a
//     batch is running, 0 again once the loop clears uploadingKey
//
// Transpile-and-import shim, same shape as fix-title.test.mjs, so the
// test file stays plain .mjs (no ts-node dep) while sourcing the real
// TS module.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

// React stub is shared across every transpiled module - the store code
// never actually calls the React hooks, but tabStore.ts imports them at
// module top-level and data-URL modules can't resolve bare specifiers.
const REACT_STUB =
  "export const useCallback=()=>{};export const useRef=()=>({current:null});export const useSyncExternalStore=()=>{};";
const REACT_URL = "data:text/javascript;base64," + Buffer.from(REACT_STUB).toString("base64");

function transpileToDataUrl(src, deps = {}) {
  let js = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      jsx: ts.JsxEmit.Preserve,
    },
  }).outputText;

  // Rewrite bare local imports to data-URL modules (recursive: each dep
  // is itself transpiled with the same react stub applied).
  for (const [importPath, sourceModule] of Object.entries(deps)) {
    const depUrl = transpileToDataUrl(sourceModule);
    const escaped = importPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    js = js.replace(new RegExp(`from ["']${escaped}["']`, "g"), `from "${depUrl}"`);
  }

  // Replace every bare `react` import with the stub, in this module and
  // (via the recursion above) in every dep module too.
  js = js.replace(/from ["']react["']/g, `from "${REACT_URL}"`);

  return "data:text/javascript;base64," + Buffer.from(js).toString("base64");
}

async function importTs(relPath, deps = {}) {
  const src = readFileSync(resolve(REPO, relPath), "utf8");
  return import(transpileToDataUrl(src, deps));
}

const tabStoreSrc = readFileSync(resolve(REPO, "client/src/lib/tabStore.ts"), "utf8");

const {
  uploadTabStore,
  countUploadsInProgress,
  emptyUploadMeta,
} = await importTs("client/src/lib/uploadTabStore.ts", {
  "./tabStore": tabStoreSrc,
});

// Small helper: manufacture a plausible FileEntry without a real File
// blob (the store never dereferences .file itself; consumers do).
function fakeEntry(key, status = "pending") {
  return {
    key,
    file: { name: `${key}.pdf`, size: 100, lastModified: 0 },
    status,
    message: "",
    result: null,
    meta: emptyUploadMeta(),
    expanded: false,
  };
}

test("initial state has empty files and no batch running", () => {
  uploadTabStore.reset();
  const s = uploadTabStore.getState();
  assert.deepEqual(s.files, []);
  assert.equal(s.mode, "batch-shared");
  assert.equal(s.uploadingKey, null);
  assert.equal(s.batchDone, false);
  assert.deepEqual(s.completedUploads, []);
  // v1.1.9: New batch-shared toggle defaults off so v1.1.8 behavior
  // (server fills each Title from filename) is preserved by default.
  assert.equal(s.autoFixTitles, false);
});

test("setState merges fields instead of replacing whole state", () => {
  uploadTabStore.reset();
  uploadTabStore.setState({ pastedBody: "hello world" });
  const s = uploadTabStore.getState();
  assert.equal(s.pastedBody, "hello world");
  // other fields are untouched
  assert.deepEqual(s.files, []);
  assert.equal(s.mode, "batch-shared");
});

test("subscribe fires listeners on setState; unsubscribe stops them", () => {
  uploadTabStore.reset();
  let calls = 0;
  const unsub = uploadTabStore.subscribe(() => calls++);
  uploadTabStore.setState({ pastedBody: "a" });
  uploadTabStore.setState({ pastedBody: "b" });
  assert.equal(calls, 2);
  unsub();
  uploadTabStore.setState({ pastedBody: "c" });
  assert.equal(calls, 2, "listener kept firing after unsubscribe");
});

test("state survives an 'unmount': mutations without listeners are readable later", () => {
  // This is the essence of the fix - the store outlives any given
  // React component that reads it. We simulate mount -> unmount ->
  // mutate -> mount by attaching, detaching, writing, then reattaching.
  uploadTabStore.reset();
  const unsub = uploadTabStore.subscribe(() => {});
  uploadTabStore.setState({
    files: [fakeEntry("a"), fakeEntry("b")],
    mode: "batch-perfile",
  });
  unsub(); // "component unmounts" (user leaves Upload tab)

  // While nobody is listening, the batch loop keeps writing progress.
  uploadTabStore.setState({ uploadingKey: "a" });
  uploadTabStore.setState((prev) => ({
    files: prev.files.map((f) => (f.key === "a" ? { ...f, status: "done" } : f)),
  }));

  // "component remounts" (user returns to Upload tab) - state is intact.
  const s = uploadTabStore.getState();
  assert.equal(s.files.length, 2);
  assert.equal(s.files[0].status, "done");
  assert.equal(s.mode, "batch-perfile");
  assert.equal(s.uploadingKey, "a");
});

test("reset restores initial state and notifies listeners", () => {
  uploadTabStore.setState({ pastedBody: "dirty", files: [fakeEntry("x")] });
  let calls = 0;
  const unsub = uploadTabStore.subscribe(() => calls++);
  uploadTabStore.reset();
  assert.equal(calls, 1);
  const s = uploadTabStore.getState();
  assert.equal(s.pastedBody, "");
  assert.deepEqual(s.files, []);
  unsub();
});

test("countUploadsInProgress is 0 when idle even with pending files", () => {
  uploadTabStore.reset();
  uploadTabStore.setState({
    files: [fakeEntry("a"), fakeEntry("b")],
    uploadingKey: null, // batch loop has not started
  });
  // Pending rows exist, but nothing is running - badge should be hidden
  // because "in progress" means the batch is actively running.
  assert.equal(countUploadsInProgress(uploadTabStore.getState()), 0);
});

test("countUploadsInProgress counts pending+uploading during a running batch", () => {
  uploadTabStore.reset();
  uploadTabStore.setState({
    files: [
      fakeEntry("a", "done"),
      fakeEntry("b", "uploading"),
      fakeEntry("c", "pending"),
      fakeEntry("d", "pending"),
      fakeEntry("e", "error"),
      fakeEntry("f", "skipped"),
    ],
    uploadingKey: "b",
  });
  // b (uploading) + c + d (pending) = 3. done/error/skipped are not
  // "in progress" from the user's point of view.
  assert.equal(countUploadsInProgress(uploadTabStore.getState()), 3);
});

test("countUploadsInProgress drops back to 0 once the loop clears uploadingKey", () => {
  uploadTabStore.reset();
  uploadTabStore.setState({
    files: [fakeEntry("a", "done"), fakeEntry("b", "error")],
    uploadingKey: null,
    batchDone: true,
  });
  assert.equal(countUploadsInProgress(uploadTabStore.getState()), 0);
});
