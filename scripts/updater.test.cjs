"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { after, before, test } = require("node:test");

const sourceUpdater = path.resolve(__dirname, "..", "packaging", "updater", "updater.cjs");
const updaterLib = require(sourceUpdater);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "apd-updater-tests-"));
let release;
let server;
let baseUrl;

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function createInstall(name, version = "0.9.32") {
  const root = path.join(scratch, name);
  write(path.join(root, "VERSION"), `${version}\n`);
  write(path.join(root, "NODE_VERSION"), "20.18.1\n");
  write(path.join(root, "dist", "index.cjs"), `old-${name}`);
  write(path.join(root, "Start AdvisePoint Docs.bat"), "baseline-launcher");
  write(path.join(root, "packaging", "updater", "updater.cjs"), fs.readFileSync(sourceUpdater));
  const localAppData = path.join(scratch, `${name}-localappdata`);
  write(path.join(localAppData, "AdvisePoint Docs", "user-data-sentinel.txt"), "preserve-me");
  return { root, localAppData };
}

function createReleaseZip(name, version = "0.9.33") {
  const work = path.join(scratch, `${name}-release`);
  const app = path.join(work, "AdvisePoint Docs");
  write(path.join(app, "VERSION"), `${version}\n`);
  write(path.join(app, "NODE_VERSION"), "20.18.1\n");
  write(path.join(app, "dist", "index.cjs"), `new-${name}`);
  write(path.join(app, "Update AdvisePoint Docs.bat"), "new-updater-launcher");
  write(path.join(app, "packaging", "updater", "updater.cjs"), fs.readFileSync(sourceUpdater));
  const zipPath = path.join(scratch, `${name}.zip`);
  const result = spawnSync("zip", ["-qr", zipPath, "AdvisePoint Docs"], {
    cwd: work,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return fs.readFileSync(zipPath);
}

function setRelease(version, archive, options = {}) {
  const hash = crypto.createHash("sha256").update(archive).digest("hex");
  release = {
    version,
    archive,
    size: options.size ?? archive.length,
    body: options.body === undefined ? `sha256: ${hash}` : options.body,
  };
}

function runUpdater(install, extraEnv = {}) {
  const script = path.join(install.root, "packaging", "updater", "updater.cjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: install.root,
      env: {
        ...process.env,
        LOCALAPPDATA: install.localAppData,
        TEMP: path.join(scratch, "temp"),
        APD_UPDATE_API_URL: `${baseUrl}/api/releases/latest`,
        APD_UPDATE_NO_PROMPT: "1",
        APD_UPDATE_NO_LAUNCH: "1",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/api/releases/latest") {
      const payload = JSON.stringify({
        tag_name: `v${release.version}`,
        body: release.body,
        assets: [{
          name: `AdvisePoint-Docs-v${release.version}.zip`,
          size: release.size,
          browser_download_url: `${baseUrl}/asset.zip`,
        }],
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(payload);
      return;
    }
    if (req.url === "/asset.zip") {
      res.writeHead(200, { "Content-Type": "application/zip" });
      res.end(release.archive);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(scratch, { recursive: true, force: true });
});

test("version comparison supports four-part hotfix versions", () => {
  assert.equal(updaterLib.compareVersions("0.9.32", "0.9.31.2"), 1);
  assert.equal(updaterLib.compareVersions("0.9.31.2", "0.9.32"), -1);
  assert.equal(updaterLib.compareVersions("0.9.32.1", "0.9.32"), 1);
});

test("ZIP paths cannot escape the staging directory", () => {
  assert.throws(() => updaterLib.safeEntryPath(scratch, "../outside.txt"));
  assert.throws(() => updaterLib.safeEntryPath(scratch, "C:\\outside.txt"));
  assert.throws(() => updaterLib.safeEntryPath(scratch, "/outside.txt"));
});

test("current release exits cleanly without changing the install", async () => {
  const install = createInstall("current");
  const archive = createReleaseZip("current", "0.9.32");
  setRelease("0.9.32", archive);
  const result = await runUpdater(install);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /matches the latest version available on GitHub/i);
  assert.equal(fs.readFileSync(path.join(install.root, "dist", "index.cjs"), "utf8"), "old-current");
});

test("unrelated server on port 5000 is never stopped", async () => {
  const portServer = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, app: "some-other-local-service" }));
  });
  await new Promise((resolve, reject) => {
    portServer.once("error", reject);
    portServer.listen(5000, "127.0.0.1", resolve);
  });
  try {
    const install = createInstall("running");
    const archive = createReleaseZip("running");
    setRelease("0.9.33", archive);
    const result = await runUpdater(install);
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stdout, /will not stop an unrelated server/i);
    assert.equal(fs.readFileSync(path.join(install.root, "dist", "index.cjs"), "utf8"), "old-running");
    assert.equal(portServer.listening, true);
  } finally {
    await new Promise((resolve) => portServer.close(resolve));
  }
});

test("verified app server is shut down before update", async () => {
  const appServer = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, app: "advisepoint-docs", version: "0.9.32" }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/updater/shutdown" && req.headers["x-apd-updater"] === "1") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, app: "advisepoint-docs", version: "0.9.32" }));
      res.once("finish", () => appServer.close());
      return;
    }
    res.writeHead(403);
    res.end();
  });
  await new Promise((resolve, reject) => {
    appServer.once("error", reject);
    appServer.listen(5000, "127.0.0.1", resolve);
  });
  try {
    const install = createInstall("auto-shutdown");
    const archive = createReleaseZip("auto-shutdown");
    setRelease("0.9.33", archive);
    const result = await runUpdater(install, { APD_UPDATE_ASSUME_YES: "1" });
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /background server stopped/i);
    assert.equal(fs.readFileSync(path.join(install.root, "dist", "index.cjs"), "utf8"), "new-auto-shutdown");
    assert.equal(appServer.listening, false);
  } finally {
    if (appServer.listening) await new Promise((resolve) => appServer.close(resolve));
  }
});

test("newer running build is described separately from GitHub release", async () => {
  const install = createInstall("newer-running", "0.9.33");
  const archive = createReleaseZip("newer-running", "0.9.32");
  setRelease("0.9.32", archive);
  const result = await runUpdater(install);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Running version: v0\.9\.33/i);
  assert.match(result.stdout, /Latest version available on GitHub: v0\.9\.32/i);
  assert.match(result.stdout, /newer than the published release/i);
});

test("successful update swaps dist, retains one backup, and preserves user data", async () => {
  const install = createInstall("success");
  const archive = createReleaseZip("success");
  setRelease("0.9.33", archive);
  const result = await runUpdater(install);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.readFileSync(path.join(install.root, "VERSION"), "utf8").trim(), "0.9.33");
  assert.equal(fs.readFileSync(path.join(install.root, "dist", "index.cjs"), "utf8"), "new-success");
  assert.equal(fs.readFileSync(path.join(install.root, "dist.bak", "index.cjs"), "utf8"), "old-success");
  assert.equal(
    fs.readFileSync(path.join(install.localAppData, "AdvisePoint Docs", "user-data-sentinel.txt"), "utf8"),
    "preserve-me",
  );
});

test("byte-size mismatch refuses the update without touching dist", async () => {
  const install = createInstall("size-mismatch");
  const archive = createReleaseZip("size-mismatch");
  setRelease("0.9.33", archive, { size: archive.length + 1 });
  const result = await runUpdater(install);
  assert.equal(result.code, 4, result.stderr);
  assert.match(result.stdout, /existing installation was preserved/i);
  assert.equal(fs.readFileSync(path.join(install.root, "dist", "index.cjs"), "utf8"), "old-size-mismatch");
  assert.equal(fs.existsSync(path.join(install.root, "dist.bak")), false);
});

test("corrupt ZIP is rejected before the install is changed", async () => {
  const install = createInstall("corrupt");
  const archive = Buffer.from("this is not a zip archive");
  setRelease("0.9.33", archive);
  const result = await runUpdater(install);
  assert.equal(result.code, 4, result.stderr);
  assert.equal(fs.readFileSync(path.join(install.root, "dist", "index.cjs"), "utf8"), "old-corrupt");
  assert.equal(fs.existsSync(path.join(install.root, "dist.bak")), false);
});

test("failure after backup automatically restores the original dist", async () => {
  const install = createInstall("rollback");
  const archive = createReleaseZip("rollback");
  setRelease("0.9.33", archive);
  const result = await runUpdater(install, { APD_UPDATE_TEST_FAIL_AFTER_BACKUP: "1" });
  assert.equal(result.code, 4, result.stderr);
  assert.equal(fs.readFileSync(path.join(install.root, "VERSION"), "utf8").trim(), "0.9.32");
  assert.equal(fs.readFileSync(path.join(install.root, "dist", "index.cjs"), "utf8"), "old-rollback");
  assert.equal(fs.existsSync(path.join(install.root, "dist.bak")), false);
});
