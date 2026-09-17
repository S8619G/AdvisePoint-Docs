// Loopback-only dependency regressions. All disk writes use a disposable folder.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import express from "express";
import multer from "multer";
const require = createRequire(import.meta.url);
const qs = require("qs");
let server, base, folder;

before(async () => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "apd-dependency-security-"));
  const app = express();
  for (const kind of ["memory", "disk"]) {
    const upload = multer({
      storage: kind === "memory" ? multer.memoryStorage() : multer.diskStorage({
        destination: folder,
        filename: (_req, _file, cb) => cb(null, "fixture.bin"),
      }),
      limits: { fileSize: 8 },
    });
    app.post(`/${kind}`, upload.single("file"), (req, res) => {
      const bytes = req.file?.buffer ?? (req.file?.path ? fs.readFileSync(req.file.path) : null);
      if (req.file?.path) fs.rmSync(req.file.path);
      res.json({ filename: req.file?.originalname, size: req.file?.size,
        contents: bytes?.toString(), title: req.body.title });
    });
  }
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use((err, _req, res, _next) => res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400)
    .json({ code: err.code }));
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
});

test("security dependency versions are pinned at the patched releases", () => {
  assert.equal(require("multer/package.json").version, "2.3.0");
  assert.equal(require("qs/package.json").version, "6.16.0");
  const lock = require("../package-lock.json");
  const matches = Object.entries(lock.packages).filter(([name]) => /(?:^|\/)node_modules\/qs$/.test(name));
  assert.ok(matches.length > 0);
  for (const [, pkg] of matches) assert.equal(pkg.version, "6.16.0");
});

test("qs rejects the bracket-key comma array-limit bypass", () => {
  const options = { comma: true, arrayLimit: 3, throwOnLimitExceeded: true };
  assert.throws(() => qs.parse("a[]=1,2,3,4", options), RangeError);
  assert.throws(() => qs.parse("a=1,2,3,4", options), RangeError);
  assert.deepEqual(qs.parse("title=Cloud+Print+and+Scan&tag=one&tag=two"),
    { title: "Cloud Print and Scan", tag: ["one", "two"] });
});

test("multer rejects crafted array field names without terminating the server", async () => {
  for (const kind of ["memory", "disk"]) {
    const body = new FormData();
    body.append("a[4294967294]", "x");
    body.append("a[]", "y");
    const response = await fetch(`${base}/${kind}`, { method: "POST", body });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "INVALID_FIELD_NAME");
    assert.equal((await fetch(`${base}/health`)).status, 200);
  }
});

test("memory and disk uploads preserve metadata, escaped names and the exact size boundary", async () => {
  for (const kind of ["memory", "disk"]) {
    const body = new FormData();
    body.append("title", "Cloud Print and Scan");
    body.append("file", new Blob(["12345678"]), '50% "scan".txt');
    const response = await fetch(`${base}/${kind}`, { method: "POST", body });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      filename: '50% "scan".txt', size: 8, contents: "12345678", title: "Cloud Print and Scan",
    });
  }
});

test("oversized uploads are refused and disk partial files are removed", async () => {
  for (const kind of ["memory", "disk"]) {
    const body = new FormData();
    body.append("file", new Blob(["123456789"]), "fixture.txt");
    const response = await fetch(`${base}/${kind}`, { method: "POST", body });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).code, "LIMIT_FILE_SIZE");
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.deepEqual(fs.readdirSync(folder), []);
  }
});
