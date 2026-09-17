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
function createReleaseZip(name, version = "0.9.33") {
  const work = path.join(scratch, `${name}-release`);
  const app = path.join(work, "AdvisePoint Docs");
  write(path.join(app, "VERSION"), `${version}\n`);
  write(path.join(app, "NODE_VERSION"), "20.18.1\n");
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
    "README.txt", "welcome-guide", "launcher", "packaging", "node_modules",
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
  setRelease("0.9.33", archive);
  const result = await runUpdater(install);
  assert.equal(result.code, 4, result.stderr);
  assert.match(result.stdout, /Refusing cross-architecture upgrade/i);
  // Dist untouched: the arch gate fires before replaceInstall().
  assert.equal(fs.readFileSync(path.join(install.root, "dist", "index.cjs"), "utf8"), "old-arch-mismatch");
  assert.equal(fs.existsSync(path.join(install.root, "dist.bak")), false);
  // ARCH sentinel is not touched by the failed upgrade.
  assert.equal(fs.readFileSync(path.join(install.root, "ARCH"), "utf8").trim(), "arm64");
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
