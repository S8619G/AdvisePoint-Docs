import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { transform } from "esbuild";

// Exercise the actual implementation without exporting UI-internal helpers
// or booting React. TypeScript types are removed, not logic reconstructed.
const source = fs.readFileSync(new URL("../client/src/pages/upload.tsx", import.meta.url), "utf8");
const start = source.indexOf("const ACCEPT_EXT =");
const end = source.indexOf("// Per-file record used by the batch UI");
assert.ok(start >= 0 && end > start);
const { code } = await transform(
  source.slice(start, end) + "\nexport { collectFolderDrop, collectFolderSelection };",
  { loader: "ts", format: "esm" },
);
const { collectFolderDrop, collectFolderSelection } =
  await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
const file = (path, size = 8) => ({
  name: path.split("/").at(-1), size, webkitRelativePath: path,
});
const entry = (f) => ({
  name: f.name, isFile: true, isDirectory: false,
  file: (resolve) => resolve(f),
});
const dir = (name, children, fullPath = `/${name}`) => ({
  name, fullPath, isFile: false, isDirectory: true,
  createReader() {
    let offset = 0;
    return { readEntries(resolve) {
      const batch = children.slice(offset, offset + 100);
      offset += 100;
      resolve(batch);
    } };
  },
});
const items = (...entries) => entries.map((e) => ({
  kind: "file", webkitGetAsEntry: () => e,
}));

test("folder picker accepts all six extensions case-insensitively and includes the size boundary", () => {
  const selected = [".pdf", ".DOCX", ".rtf", ".TXT", ".md", ".MARKDOWN"]
    .map((ext) => file(`Root/file${ext}`, 150 * 1024 * 1024));
  const result = collectFolderSelection(selected);
  assert.deepEqual(result.files, selected);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.folderName, "Root");
  assert.equal(result.subfolderCount, 0);
});

test("folder picker reports oversize and unsupported files while ignoring bookkeeping and hidden paths", () => {
  const result = collectFolderSelection([
    file("Root/large.pdf", 150 * 1024 * 1024 + 1),
    file("Root/installer.exe"),
    ...[".DS_Store", "Thumbs.db", "desktop.ini", ".hidden.pdf",
      "__MACOSX/test.pdf", ".hidden/test.pdf"].map((p) => file(`Root/${p}`)),
    file("Root/a/b/good.txt"),
  ]);
  assert.deepEqual(result.files.map((f) => f.name), ["good.txt"]);
  assert.deepEqual(result.skipped, [
    { path: "Root/large.pdf", reason: "too-large" },
    { path: "Root/installer.exe", reason: "unsupported", ext: ".exe" },
  ]);
  assert.equal(result.subfolderCount, 2);
});

test("drop and picker produce identical results for a nested folder fixture", async () => {
  const files = [
    file("Root/guide.PDF"), file("Root/sub/notes.md"),
    file("Root/sub/large.docx", 150 * 1024 * 1024 + 1),
    file("Root/sub/unsupported.png"), file("Root/.hidden.pdf"),
    file("Root/__MACOSX/ignored.txt"),
  ];
  const root = dir("Root", [
    entry(files[0]),
    dir("sub", files.slice(1, 4).map(entry), "/Root/sub"),
    entry(files[4]),
    dir("__MACOSX", [entry(files[5])], "/Root/__MACOSX"),
  ]);
  assert.deepEqual(await collectFolderDrop(items(root)), collectFolderSelection(files));
});

test("drop drains directory batches beyond 100 entries", async () => {
  const files = Array.from({ length: 205 }, (_, i) => file(`Root/file-${i}.txt`));
  const result = await collectFolderDrop(items(dir("Root", files.map(entry))));
  assert.equal(result.files.length, 205);
  assert.equal(result.subfolderCount, 0);
});

test("drop terminates when a directory entry repeats its canonical path", async () => {
  const root = dir("Root", []);
  root.createReader = () => {
    let done = false;
    return { readEntries(resolve) {
      resolve(done ? [] : [root, entry(file("Root/good.txt"))]);
      done = true;
    } };
  };
  assert.equal((await collectFolderDrop(items(root))).files.length, 1);
});

test("empty selection and unreadable drop file do not stage anything", async () => {
  assert.equal(collectFolderSelection([]).files.length, 0);
  const bad = { ...entry(file("bad.pdf")), file: (_, reject) => reject(new Error("unreadable")) };
  assert.equal((await collectFolderDrop(items(bad))).files.length, 0);
});
