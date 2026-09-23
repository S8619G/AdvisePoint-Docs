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

// Simulates an installed build. Mirrors a v1.0.14-shaped install: it has
// dist/, the launcher, and the updater, but deliberately NO welcome-guide/
// folder and NO README.txt -- those are the "new in the incoming version"
// cases the v1.1.0 app-root sync has to handle.
function createInstall(name, version = "0.9.32") {
  const root = path.join(scratch, name);
  write(path.join(root, "VERSION"), `${version}\n`);
  write(path.join(root, "NODE_VERSION"), "20.18.1\n");
  write(path.join(root, "node", "node.exe"), "old-node-runtime");
  write(path.join(root, "node_modules", "test-module", "index.js"), "old-module");
  write(path.join(root, "dist", "index.cjs"), `old-${name}`);
  write(path.join(root, "Start AdvisePoint Docs.bat"), "baseline-launcher");
  write(path.join(root, "packaging", "updater", "updater.cjs"), fs.readFileSync(sourceUpdater));
  // Local-only runtime state that a release never ships and an upgrade must
  // never disturb.
  write(path.join(root, ".unblocked"), "v0.9.29 unblock complete\n");
  write(path.join(root, "server.log"), "prior session log\n");
  // Legacy/portable layout: user database sitting in the install root. The
  // sync's preserve set must refuse to overwrite this even though the crafted
  // release below deliberately ships a file of the same name.
  write(path.join(root, "advisepoint.db"), "USER-DATABASE-DO-NOT-CLOBBER");
  write(path.join(root, "pages", "doc-1", "page-1.webp"), "USER-PAGE-IMAGE");
  const localAppData = path.join(scratch, `${name}-localappdata`);
  write(path.join(localAppData, "AdvisePoint Docs", "user-data-sentinel.txt"), "preserve-me");
  return { root, localAppData };
}

// Builds an incoming release. Beyond dist/, it ships content that does NOT
// exist in createInstall(): README.txt (new file at the app root),
// welcome-guide/ and launcher/ (new folders, the latter nested), and a
// deliberately hostile advisepoint.db + pages/ to prove the preserve set holds.
function createReleaseZip(name, version = "0.9.33", options = {}) {
  const work = path.join(scratch, `${name}-release`);
  const app = path.join(work, "AdvisePoint Docs");
  write(path.join(app, "VERSION"), `${version}\n`);
  write(path.join(app, "NODE_VERSION"), options.nodeVersion || "20.18.1\n");
  write(path.join(app, "node", "node.exe"), "new-node-runtime");
  write(path.join(app, "node_modules", "test-module", "index.js"), "new-module");
  // v1.2.0: shipped zips always carry an ARCH sentinel so the updater can
  // refuse a cross-architecture upgrade. Tests build x64 releases; the
  // installed side has no ARCH, which the updater treats as "x64" for
  // backward compatibility with pre-v1.2.0 installs.
  write(path.join(app, "ARCH"), "x64\n");
  write(path.join(app, "dist", "index.cjs"), `new-${name}`);
  write(path.join(app, "Update AdvisePoint Docs.bat"), "new-updater-launcher");
  write(path.join(app, "packaging", "updater", "updater.cjs"), fs.readFileSync(sourceUpdater));
  // --- new-in-incoming-version content (the v1.0.15 regression) ---
  write(path.join(app, "README.txt"), `readme-${name}`);
  write(path.join(app, "pdf-engine", "qpdf.exe"), `engine-${name}`);
  write(path.join(app, "pdf-engine", "licenses", "LICENSE.txt"), "engine-license");
  write(
    path.join(app, "welcome-guide", "AdvisePoint-Docs-Welcome-Guide.pdf"),
    `%PDF-1.4 welcome-guide-${name}`,
  );
  write(path.join(app, "launcher", "run-hidden.vbs"), `vbs-${name}`);
  write(path.join(app, "launcher", "nested", "deep.txt"), `deep-${name}`);
  write(path.join(app, "Start AdvisePoint Docs.bat"), `shipped-launcher-${name}`);
  // --- preserve-set probes: a release should never contain these ---
  write(path.join(app, "advisepoint.db"), "SHIPPED-DB-MUST-NOT-WIN");
  write(path.join(app, "pages", "doc-1", "page-1.webp"), "SHIPPED-PAGE-MUST-NOT-WIN");
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
    assets: options.assets,
    digest: options.digest,
    assetName: options.assetName,
    checksum: options.checksum,
  };
}

function runUpdater(install, extraEnv = {}, args = []) {
  const script = path.join(install.root, "packaging", "updater", "updater.cjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
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
        assets: release.assets || [{
          name: release.assetName || `AdvisePoint-Docs-v${release.version}.zip`,
          size: release.size,
          browser_download_url: `${baseUrl}/asset.zip`,
          digest: release.digest,
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
    if (req.url === "/checksum") {
      res.end(release.checksum || "");
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

// ---------------------------------------------------------------------------
// v1.1.0 app-root sync regression tests.
//
// The v1.0.14 -> v1.0.15 upgrade shipped welcome-guide/ for the first time and
// the updater silently dropped it, because replaceInstall() only swapped dist/
// and hand-copied two known filenames. These tests pin the two cases that were
// unrepresented: a file that is new in the incoming version, and a folder that
// is new in the incoming version.
// ---------------------------------------------------------------------------

test("upgrade creates files that are new in the incoming version", async () => {
  const install = createInstall("new-file");
  // Precondition: the install genuinely does not have README.txt yet.
  assert.equal(fs.existsSync(path.join(install.root, "README.txt")), false);
  const archive = createReleaseZip("new-file");
  setRelease("0.9.33", archive);
  const result = await runUpdater(install);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(
    fs.readFileSync(path.join(install.root, "README.txt"), "utf8"),
    "readme-new-file",
    "README.txt is new in the incoming version and must be created on upgrade",
  );
});

test("upgrade creates folders that are new in the incoming version", async () => {
  const install = createInstall("new-folder");
  // This is the exact v1.0.15 field bug: welcome-guide/ did not exist in the
  // installed version at all.
  assert.equal(fs.existsSync(path.join(install.root, "welcome-guide")), false);
  assert.equal(fs.existsSync(path.join(install.root, "launcher")), false);
  const archive = createReleaseZip("new-folder");
  setRelease("0.9.33", archive);
  const result = await runUpdater(install);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

  const guide = path.join(
    install.root, "welcome-guide", "AdvisePoint-Docs-Welcome-Guide.pdf",
  );
  assert.equal(
    fs.existsSync(guide),
    true,
    "welcome-guide/ is new in the incoming version and must be created on upgrade",
  );
  assert.equal(fs.readFileSync(guide, "utf8"), "%PDF-1.4 welcome-guide-new-folder");
  assert.equal(fs.readFileSync(path.join(install.root,"pdf-engine","qpdf.exe"),"utf8"),"engine-new-folder");
  assert.equal(fs.readFileSync(path.join(install.root,"pdf-engine","licenses","LICENSE.txt"),"utf8"),"engine-license");

  // Nested new folders must be created too, not just the first level.
  assert.equal(
    fs.readFileSync(path.join(install.root, "launcher", "run-hidden.vbs"), "utf8"),
    "vbs-new-folder",
  );
  assert.equal(
    fs.readFileSync(path.join(install.root, "launcher", "nested", "deep.txt"), "utf8"),
    "deep-new-folder",
  );
});

test("upgrade refreshes shipped files that already exist", async () => {
  const install = createInstall("refresh");
  const archive = createReleaseZip("refresh");
  setRelease("0.9.33", archive);
  const result = await runUpdater(install);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  // The launcher and the updater's own bat were stale-by-design before v1.1.0.
  assert.equal(
    fs.readFileSync(path.join(install.root, "Start AdvisePoint Docs.bat"), "utf8"),
    "shipped-launcher-refresh",
  );
  assert.equal(
    fs.readFileSync(path.join(install.root, "Update AdvisePoint Docs.bat"), "utf8"),
    "new-updater-launcher",
  );
  // The updater still self-updates, exactly as it did before v1.1.0.
  assert.equal(
    fs.readFileSync(path.join(install.root, "packaging", "updater", "updater.cjs"), "utf8"),
    fs.readFileSync(sourceUpdater, "utf8"),
  );
});

test("app-root sync never overwrites preserved user data or local state", async () => {
  const install = createInstall("preserve");
  const archive = createReleaseZip("preserve");
  setRelease("0.9.33", archive);
  const result = await runUpdater(install);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

  // The crafted release ships advisepoint.db and pages/ on purpose. The user's
  // copies must win -- an upgrade must never be able to destroy a library.
  assert.equal(
    fs.readFileSync(path.join(install.root, "advisepoint.db"), "utf8"),
    "USER-DATABASE-DO-NOT-CLOBBER",
  );
  assert.equal(
    fs.readFileSync(path.join(install.root, "pages", "doc-1", "page-1.webp"), "utf8"),
    "USER-PAGE-IMAGE",
  );
  // Local-only runtime state survives untouched.
  assert.equal(
    fs.readFileSync(path.join(install.root, ".unblocked"), "utf8"),
    "v0.9.29 unblock complete\n",
  );
  assert.equal(
    fs.readFileSync(path.join(install.root, "server.log"), "utf8"),
    "prior session log\n",
  );
  // And the real user-data location is still intact.
  assert.equal(
    fs.readFileSync(
      path.join(install.localAppData, "AdvisePoint Docs", "user-data-sentinel.txt"), "utf8",
    ),
    "preserve-me",
  );
});

test("isPreservedName classifies user data, logs, and transient artifacts", () => {
  // User data and local state: preserved.
  for (const name of [
    "advisepoint.db", "AdvisePoint.DB", "data.db", "advisepoint.db-wal",
    "pages", "originals", "snapshots", "backups", "quarantine", "trash", "logs",
    ".unblocked", ".updating",
    "dist.bak", "node.old", "dist.new-1234", "node.new-99",
    "server.log", "server.log.1", "update.log",
  ]) {
    assert.equal(updaterLib.isPreservedName(name), true, `${name} should be preserved`);
  }
  // Shipped content: synced.
  for (const name of [
    "README.txt", "welcome-guide", "launcher", "packaging", "node_modules", "pdf-engine",
    "Start AdvisePoint Docs.bat", "Setup Icon (run once).bat", "seed.db",
  ]) {
    assert.equal(updaterLib.isPreservedName(name), false, `${name} should be synced`);
  }
});

test("a sync failure still rolls the install back to the previous dist", async () => {
  const install = createInstall("rollback-sync");
  const archive = createReleaseZip("rollback-sync");
  setRelease("0.9.33", archive);
  const result = await runUpdater(install, { APD_UPDATE_TEST_FAIL_AFTER_BACKUP: "1" });
  assert.equal(result.code, 4, result.stderr);
  // The simulated failure fires before the sync, so nothing new landed and the
  // original dist is back in place.
  assert.equal(fs.readFileSync(path.join(install.root, "VERSION"), "utf8").trim(), "0.9.32");
  assert.equal(
    fs.readFileSync(path.join(install.root, "dist", "index.cjs"), "utf8"),
    "old-rollback-sync",
  );
  assert.equal(fs.existsSync(path.join(install.root, "welcome-guide")), false);
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

// ---------------------------------------------------------------------------
// v1.2.0 ARCH match gate.
//
// v1.2.0 introduces separate x64 and arm64 zips. Overlaying one arch onto
// an install of the other would leave a mixed-arch layout (arm64 node.exe
// trying to load an x64 better_sqlite3.node, etc.). The updater must
// refuse before touching dist/.
// ---------------------------------------------------------------------------

function createReleaseZipWithArch(name, archContent, version = "0.9.33") {
  // Small variant of createReleaseZip that lets a test control the ARCH
  // sentinel: an explicit value, or `null` to omit the file entirely.
  const work = path.join(scratch, `${name}-release-arch`);
  const app = path.join(work, "AdvisePoint Docs");
  write(path.join(app, "VERSION"), `${version}\n`);
  write(path.join(app, "NODE_VERSION"), "20.18.1\n");
  if (archContent !== null) write(path.join(app, "ARCH"), archContent);
  write(path.join(app, "dist", "index.cjs"), `new-${name}`);
  write(path.join(app, "Start AdvisePoint Docs.bat"), `shipped-launcher-${name}`);
  write(path.join(app, "packaging", "updater", "updater.cjs"), fs.readFileSync(sourceUpdater));
  const zipPath = path.join(scratch, `${name}-arch.zip`);
  const result = spawnSync("zip", ["-qr", zipPath, "AdvisePoint Docs"], {
    cwd: work,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return fs.readFileSync(zipPath);
}

test("upgrade refuses when incoming ARCH does not match installed ARCH", async () => {
  const install = createInstall("arch-mismatch");
  // The installed side is explicitly arm64; the incoming release is x64.
  write(path.join(install.root, "ARCH"), "arm64\n");
  const archive = createReleaseZipWithArch("arch-mismatch", "x64\n");
  setRelease("0.9.33", archive, {
    assetName: "AdvisePoint-Docs-v0.9.33-arm64.zip",
    digest: `sha256:${crypto.createHash("sha256").update(archive).digest("hex")}`,
  });
  const result = await runUpdater(install);
  assert.equal(result.code, 4, result.stderr);
  assert.match(result.stdout, /Refusing cross-architecture upgrade/i);
  // Dist untouched: the arch gate fires before replaceInstall().
  assert.equal(fs.readFileSync(path.join(install.root, "dist", "index.cjs"), "utf8"), "old-arch-mismatch");
  assert.equal(fs.existsSync(path.join(install.root, "dist.bak")), false);
  // ARCH sentinel is not touched by the failed upgrade.
  assert.equal(fs.readFileSync(path.join(install.root, "ARCH"), "utf8").trim(), "arm64");
});

// v1.2.8: architecture, integrity, sequencing and complete failed-update recovery.
function githubAsset(name) {
  return { name, size: 100, browser_download_url: `https://github.com/S8619G/AdvisePoint-Docs/releases/download/v1.2.8/${name}` };
}
function permutations(items) {
  return items.length ? items.flatMap((x, i) => permutations(items.filter((_, j) => i !== j)).map(rest => [x, ...rest])) : [[]];
}
test("both architectures select the explicit binary in all 24 asset orderings", () => {
  const names = ["source", "x64", "arm64"].map(s => `AdvisePoint-Docs-v1.2.8-${s}.zip`).concat("AdvisePoint-Docs-v1.2.8.zip");
  for (const assets of permutations(names.map(githubAsset))) {
    for (const arch of ["x64", "arm64"]) assert.equal(
      updaterLib.selectReleaseAsset({ tag_name: "v1.2.8", assets }, arch).name,
      `AdvisePoint-Docs-v1.2.8-${arch}.zip`,
    );
  }
});
test("ARM64 refuses x64 aliases, source-only and unrelated lone ZIPs", () => {
  for (const name of ["AdvisePoint-Docs.zip", "AdvisePoint-Docs-v1.2.8.zip", "AdvisePoint-Docs-v1.2.8-source.zip", "release.zip"]) {
    assert.throws(() => updaterLib.selectReleaseAsset({ tag_name: "1.2.8", assets: [githubAsset(name)] }, "arm64"), /No compatible/);
  }
});
test("legacy x64 naming and zero-padded version precision remain supported", () => {
  for (const name of ["AdvisePoint-Docs.zip", "AdvisePoint.Docs.v1.2.8.0.zip", "AdvisePoint_Docs_v1.2.8_x64.zip"]) {
    assert.equal(updaterLib.selectReleaseAsset({ tag_name: "1.2.8", assets: [githubAsset(name)] }, "x64").name, name);
  }
});
test("wrong-version, untrusted and ambiguous matching assets fail closed", () => {
  for (const assets of [
    [githubAsset("AdvisePoint-Docs-v1.2.9-arm64.zip")],
    [{ ...githubAsset("AdvisePoint-Docs-v1.2.8-arm64.zip"), browser_download_url: "https://evil.example/file.zip" }],
    [githubAsset("AdvisePoint-Docs-v1.2.8-arm64.zip"), githubAsset("AdvisePoint_Docs_v1.2.8_arm64.zip")],
  ]) assert.throws(() => updaterLib.selectReleaseAsset({ tag_name: "1.2.8", assets }, "arm64"));
});

async function withRunningApp(action, refuseShutdown = false) {
  let shutdowns = 0;
  const app = http.createServer((req, res) => {
    if (req.url === "/api/health") return res.end(JSON.stringify({ app: "advisepoint-docs" }));
    if (req.url === "/api/updater/shutdown") {
      shutdowns++;
      res.writeHead(refuseShutdown ? 503 : 200);
      res.end(JSON.stringify({ app: "advisepoint-docs" }));
      if (!refuseShutdown) app.close();
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve, reject) => { app.once("error", reject); app.listen(5000, "127.0.0.1", resolve); });
  try { await action(app, () => shutdowns); }
  finally { if (app.listening) await new Promise(r => app.close(r)); }
}

test("missing ARM64 binary fails before stopping a live application", async () => {
  await withRunningApp(async (app, shutdowns) => {
    const install = createInstall("missing-arm");
    write(path.join(install.root, "ARCH"), "arm64");
    setRelease("0.9.33", createReleaseZip("missing-arm"));
    const result = await runUpdater(install, { APD_UPDATE_ASSUME_YES: "1" });
    assert.equal(result.code, 3);
    assert.match(result.stdout, /No compatible arm64/);
    assert.equal(shutdowns(), 0); assert.equal(app.listening, true);
  });
});
test("bad asset-specific checksum leaves the live application untouched", async () => {
  await withRunningApp(async (app, shutdowns) => {
    const install = createInstall("bad-digest");
    setRelease("0.9.33", createReleaseZip("bad-digest"), { assetName: "AdvisePoint-Docs-v0.9.33-x64.zip", digest: `sha256:${"0".repeat(64)}` });
    const result = await runUpdater(install, { APD_UPDATE_ASSUME_YES: "1" });
    assert.equal(result.code, 4); assert.match(result.stdout, /SHA-256 mismatch/);
    assert.equal(shutdowns(), 0); assert.equal(app.listening, true);
  });
});
test("selected ARM64 companion checksum overrides an unrelated release-body hash", async () => {
  const install = createInstall("arm-companion");
  write(path.join(install.root, "ARCH"), "arm64");
  const archive = createReleaseZipWithArch("arm-companion", "arm64");
  const name = "AdvisePoint-Docs-v0.9.33-arm64.zip";
  const hash = crypto.createHash("sha256").update(archive).digest("hex");
  setRelease("0.9.33", archive, {
    body: `sha256: ${"0".repeat(64)}`,
    checksum: `${hash}  ${name}\n`,
    assets: [
      { name, size: archive.length, browser_download_url: `${baseUrl}/asset.zip` },
      { name: `${name}.sha256`, size: 100, browser_download_url: `${baseUrl}/checksum` },
    ],
  });
  const result = await runUpdater(install);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(fs.readFileSync(path.join(install.root, "VERSION"), "utf8").trim(), "0.9.33");
});
test("mislabeled and corrupt local ZIPs fail before shutdown and original ZIP is retained", async () => {
  await withRunningApp(async (app, shutdowns) => {
    const install = createInstall("local-arm");
    write(path.join(install.root, "ARCH"), "arm64");
    const file = path.join(scratch, "user-download.zip");
    for (const content of [createReleaseZip("local-arm"), Buffer.from("broken ZIP")]) {
      write(file, content);
      const result = await runUpdater(install, { APD_UPDATE_ASSUME_YES: "1" }, ["--local-zip", file]);
      assert.equal(result.code, 4, result.stdout);
      assert.equal(fs.existsSync(file), true);
      assert.equal(shutdowns(), 0); assert.equal(app.listening, true);
    }
  });
});
test("up-to-date check never shuts down the live application", async () => {
  await withRunningApp(async (app, shutdowns) => {
    const install = createInstall("live-current");
    setRelease("0.9.32", createReleaseZip("live-current", "0.9.32"));
    assert.equal((await runUpdater(install, { APD_UPDATE_ASSUME_YES: "1" })).code, 0);
    assert.equal(shutdowns(), 0); assert.equal(app.listening, true);
  });
});
test("shutdown refusal leaves files unchanged and does not duplicate the live server", async () => {
  await withRunningApp(async (app, shutdowns) => {
    const install = createInstall("refused");
    setRelease("0.9.33", createReleaseZip("refused"));
    const result = await runUpdater(install, { APD_UPDATE_ASSUME_YES: "1" });
    assert.equal(result.code, 4); assert.equal(shutdowns(), 1); assert.equal(app.listening, true);
    assert.match(result.stdout, /no duplicate recovery launch/);
    assert.equal(fs.readFileSync(path.join(install.root, "VERSION"), "utf8").trim(), "0.9.32");
  }, true);
});
test("failure after app-root sync restores launchers, modules and markers, preserving data", async () => {
  const install = createInstall("full-rollback");
  write(path.join(install.root, "README.txt"), "OLD README");
  setRelease("0.9.33", createReleaseZip("full-rollback"));
  const result = await runUpdater(install, { APD_UPDATE_TEST_FAIL_AFTER_SYNC: "1" });
  assert.equal(result.code, 4, result.stdout);
  for (const [file, expected] of [
    ["dist/index.cjs", "old-full-rollback"], ["VERSION", "0.9.32\n"],
    ["README.txt", "OLD README"], ["Start AdvisePoint Docs.bat", "baseline-launcher"],
    ["node_modules/test-module/index.js", "old-module"],
    ["advisepoint.db", "USER-DATABASE-DO-NOT-CLOBBER"], ["pages/doc-1/page-1.webp", "USER-PAGE-IMAGE"],
  ]) assert.equal(fs.readFileSync(path.join(install.root, file), "utf8"), expected, file);
  assert.equal(fs.existsSync(path.join(install.root, "welcome-guide")), false);
  assert.equal(fs.existsSync(path.join(install.root, "launcher")), false);
  assert.match(result.stdout, /Full application recovery verified/);
  assert.equal(fs.existsSync(path.join(install.root,"pdf-engine")),false);
});
test("recovery launches only when the port is free and verifies application health", async () => {
  let launched = 0;
  const deps = { portBusy: async () => false, launch: async () => { launched++; }, waitHealthy: async () => true };
  assert.equal(await updaterLib.recoverStoppedApp(deps), true);
  assert.equal(launched, 1);
  for (const ours of [true, false]) {
    assert.equal(await updaterLib.recoverStoppedApp({ ...deps, portBusy: async () => true, identify: async () => ours }), false);
  }
  assert.equal(launched, 1);
  assert.equal(await updaterLib.recoverStoppedApp({ ...deps, waitHealthy: async () => false }), false);
});

test("failure after runtime replacement restores old runtime and NODE_VERSION", async () => {
  const install = createInstall("node-rollback");
  setRelease("0.9.33", createReleaseZip("node-rollback", "0.9.33", { nodeVersion: "99.0.0\n" }));
  const result = await runUpdater(install, { APD_UPDATE_TEST_FAIL_AFTER_NODE: "1" });
  assert.equal(result.code, 4, result.stdout);
  for (const [file, expected] of [["node/node.exe", "old-node-runtime"], ["NODE_VERSION", "20.18.1\n"], ["VERSION", "0.9.32\n"]]) {
    assert.equal(fs.readFileSync(path.join(install.root, file), "utf8"), expected, file);
  }
});
test("post-shutdown failure attempts recovery and persists failure status", async () => {
  await withRunningApp(async (_app, shutdowns) => {
    const install = createInstall("stopped-recovery");
    setRelease("0.9.33", createReleaseZip("stopped-recovery"));
    const result = await runUpdater(install, { APD_UPDATE_ASSUME_YES: "1", APD_UPDATE_TEST_FAIL_AFTER_SYNC: "1" });
    assert.equal(result.code, 4);
    assert.equal(shutdowns(), 1);
    assert.ok(result.stdout.indexOf("Package validation complete") < result.stdout.indexOf("Requesting a clean shutdown"));
    assert.match(result.stdout, /Restarting the preserved application/);
    const status = JSON.parse(fs.readFileSync(path.join(install.localAppData, "AdvisePoint Docs", "update-status.json")));
    assert.equal(status.phase, "failed");
    assert.match(status.message, /Simulated failure after root sync/);
    assert.equal(fs.readFileSync(path.join(install.root, "VERSION"), "utf8").trim(), "0.9.32");
  });
});
test("incomplete recovery keeps snapshot and refuses to relaunch mixed files", async () => {
  await withRunningApp(async () => {
    const install = createInstall("unsafe-recovery");
    setRelease("0.9.33", createReleaseZip("unsafe-recovery"));
    const result = await runUpdater(install, {
      APD_UPDATE_ASSUME_YES: "1", APD_UPDATE_TEST_FAIL_AFTER_SYNC: "1", APD_UPDATE_TEST_FAIL_RECOVERY: "1",
    });
    assert.equal(result.code, 4);
    assert.match(result.stdout, /automatic recovery was incomplete/);
    assert.doesNotMatch(result.stdout, /Restarting the preserved application/);
    const folder = fs.readdirSync(install.root).find(n => n.startsWith(".update-recovery-"));
    assert.ok(folder);
    assert.equal(fs.readFileSync(path.join(install.root, folder, "VERSION"), "utf8").trim(), "0.9.32");
  });
});
test("a second updater cannot overwrite an active update or clear its sentinel", async () => {
  const install = createInstall("locked");
  write(path.join(install.root, ".update-lock"), String(process.pid));
  const sentinel = path.join(install.localAppData, "AdvisePoint Docs", ".updating");
  write(sentinel, "active-owner");
  const result = await runUpdater(install);
  assert.equal(result.code, 5);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "active-owner");
  assert.equal(fs.readFileSync(path.join(install.root, ".update-lock"), "utf8"), String(process.pid));
});
test("malformed or incorrectly named checksum companion fails before shutdown", async () => {
  await withRunningApp(async (_app, shutdowns) => {
    for (const checksum of ["not-a-checksum", `${"0".repeat(64)}  another-file.zip`]) {
      const install = createInstall(`checksum-${checksum.length}`);
      const archive = createReleaseZip(`checksum-${checksum.length}`);
      const name = "AdvisePoint-Docs-v0.9.33-x64.zip";
      setRelease("0.9.33", archive, { checksum, assets: [
        { name, size: archive.length, browser_download_url: `${baseUrl}/asset.zip` },
        { name: `${name}.sha256`, browser_download_url: `${baseUrl}/checksum` },
      ] });
      assert.equal((await runUpdater(install, { APD_UPDATE_ASSUME_YES: "1" })).code, 3);
      assert.equal(shutdowns(), 0);
    }
  });
});

test("upgrade refuses when incoming zip is missing the ARCH sentinel", async () => {
  const install = createInstall("arch-missing");
  // Installed side has ARCH; incoming zip does not carry one at all.
  write(path.join(install.root, "ARCH"), "x64\n");
  const archive = createReleaseZipWithArch("arch-missing", null);
  setRelease("0.9.33", archive);
  const result = await runUpdater(install);
  assert.equal(result.code, 4, result.stderr);
  assert.match(result.stdout, /missing the ARCH sentinel/i);
  assert.equal(fs.readFileSync(path.join(install.root, "dist", "index.cjs"), "utf8"), "old-arch-missing");
});

test("upgrade allowed when installed has no ARCH (pre-v1.2.0 install) and incoming is x64", async () => {
  // Pre-v1.2.0 installs never wrote an ARCH file. Those installs were
  // always x64, so the updater treats a missing installed ARCH as x64 and
  // accepts an x64 zip; the ARCH sentinel is intentionally NOT synced
  // (SYNC_SKIP_TOP_LEVEL contains "ARCH"), so pre-v1.2.0 installs remain
  // unmarked -- which is fine because the next upgrade repeats the same
  // default-to-x64 comparison.
  const install = createInstall("arch-backcompat");
  assert.equal(fs.existsSync(path.join(install.root, "ARCH")), false);
  const archive = createReleaseZipWithArch("arch-backcompat", "x64\n");
  setRelease("0.9.33", archive);
  const result = await runUpdater(install);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.readFileSync(path.join(install.root, "VERSION"), "utf8").trim(), "0.9.33");
});
