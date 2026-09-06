"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const readline = require("node:readline");
const { spawn } = require("node:child_process");

const OWNER = "S8619G";
const REPO = "advisepoint-docs";
const DEFAULT_API_URL =
  `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
const MAX_REDIRECTS = 8;
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 25_000;
const CRC32_TABLE = new Uint32Array(256);
for (let value = 0; value < 256; value += 1) {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  CRC32_TABLE[value] = crc >>> 0;
}

const installRoot = path.resolve(__dirname, "..", "..");
const localAppData =
  process.env.LOCALAPPDATA || process.env.APPDATA || path.join(os.homedir(), ".advisepoint-docs");
const logDir = path.join(localAppData, "AdvisePoint Docs");
const logPath = path.join(logDir, "update.log");
const apiUrl = process.env.APD_UPDATE_API_URL || DEFAULT_API_URL;

fs.mkdirSync(logDir, { recursive: true });

function timestamp() {
  return new Date().toISOString();
}

function log(message) {
  const line = `[${timestamp()}] ${message}`;
  console.log(message);
  fs.appendFileSync(logPath, `${line}\n`, "utf8");
}

function fail(message, cause) {
  const detail = cause instanceof Error ? `: ${cause.stack || cause.message}` : "";
  fs.appendFileSync(logPath, `[${timestamp()}] ERROR ${message}${detail}\n`, "utf8");
  const error = new Error(message);
  error.cause = cause;
  throw error;
}

function normalizeVersion(value) {
  const match = String(value || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+(?:\.\d+)*)$/i);
  if (!match) throw new Error(`Invalid version: ${value}`);
  return [Number(match[1]), Number(match[2]), ...match[3].split(".").map(Number)];
}

function compareVersions(a, b) {
  const left = normalizeVersion(a);
  const right = normalizeVersion(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const x = left[i] || 0;
    const y = right[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

function readCurrentVersion() {
  const marker = path.join(installRoot, "VERSION");
  if (!fs.existsSync(marker)) {
    throw new Error("VERSION marker is missing. Re-extract this release before updating.");
  }
  return fs.readFileSync(marker, "utf8").trim();
}

function requestBuffer(url, options = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > MAX_REDIRECTS) {
      reject(new Error("Too many redirects"));
      return;
    }
    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? https : http;
    if (parsed.protocol !== "https:" && !(process.env.APD_UPDATE_API_URL && parsed.protocol === "http:")) {
      reject(new Error(`Refusing non-HTTPS URL: ${parsed.protocol}`));
      return;
    }
    const req = transport.get(parsed, {
      headers: {
        "User-Agent": "AdvisePoint-Docs-Updater",
        Accept: "application/vnd.github+json",
        ...options.headers,
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const nextUrl = new URL(res.headers.location, parsed).toString();
        requestBuffer(nextUrl, options, redirects + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      let received = 0;
      res.on("data", (chunk) => {
        received += chunk.length;
        if (received > (options.maxBytes || MAX_ARCHIVE_BYTES)) {
          req.destroy(new Error("Response exceeds the allowed size"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.setTimeout(30_000, () => req.destroy(new Error("Network request timed out")));
    req.on("error", reject);
  });
}

function isTrustedAssetUrl(value) {
  try {
    const parsed = new URL(value);
    if (process.env.APD_UPDATE_API_URL) {
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    }
    return parsed.protocol === "https:" &&
      parsed.hostname === "github.com" &&
      parsed.pathname.startsWith(`/${OWNER}/${REPO}/releases/download/`);
  } catch {
    return false;
  }
}

async function fetchLatestRelease() {
  const data = await requestBuffer(apiUrl, { maxBytes: 2 * 1024 * 1024 });
  let release;
  try {
    release = JSON.parse(data.toString("utf8"));
  } catch (error) {
    throw new Error("GitHub returned invalid release information", { cause: error });
  }
  if (!release || !/^v?\d+\.\d+\.\d+(?:\.\d+)*$/.test(String(release.tag_name || ""))) {
    throw new Error("Latest release has an invalid version tag");
  }
  const expectedName = `AdvisePoint-Docs-v${String(release.tag_name).replace(/^v/i, "")}.zip`.toLowerCase();
  const asset = Array.isArray(release.assets)
    ? release.assets.find((item) =>
      typeof item?.name === "string" &&
      item.name.toLowerCase() === expectedName &&
      isTrustedAssetUrl(item.browser_download_url) &&
      Number.isSafeInteger(item.size) &&
      item.size > 0)
    : null;
  if (!asset) {
    throw new Error(`Release asset ${expectedName} was not found`);
  }
  const hashMatch = String(release.body || "").match(/^\s*sha256:\s*([a-f0-9]{64})\s*$/im);
  return {
    version: String(release.tag_name).replace(/^v/i, ""),
    assetName: asset.name,
    assetUrl: asset.browser_download_url,
    assetSize: asset.size,
    sha256: hashMatch ? hashMatch[1].toLowerCase() : null,
  };
}

function checkPort(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    let settled = false;
    const finish = (inUse) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(1200);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function localAppRequest(method, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: 5000,
      path: pathname,
      method,
      headers: {
        Accept: "application/json",
        "User-Agent": "AdvisePoint-Docs-Updater",
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      let received = 0;
      res.on("data", (chunk) => {
        received += chunk.length;
        if (received > 64 * 1024) {
          req.destroy(new Error("Local app response was too large"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        let body = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          // Identity check below treats non-JSON as an unrelated process.
        }
        resolve({ status: res.statusCode || 0, body });
      });
    });
    req.setTimeout(2000, () => req.destroy(new Error("Local app request timed out")));
    req.on("error", reject);
    req.end();
  });
}

async function identifyRunningApp() {
  try {
    const response = await localAppRequest("GET", "/api/health");
    return response.status === 200 && response.body?.app === "advisepoint-docs";
  } catch {
    return false;
  }
}

async function requestServerShutdown() {
  const response = await localAppRequest("POST", "/api/updater/shutdown", {
    "X-APD-Updater": "1",
  });
  if (response.status !== 200 || response.body?.app !== "advisepoint-docs") {
    throw new Error(`Background server refused shutdown (HTTP ${response.status})`);
  }
}

async function waitForPortRelease(timeoutMs = 30_000) {
  // v0.9.34: Raised from 15 s -> 30 s. Even with the server's new
  // closeAllConnections() drop, Windows process-chain teardown behind the
  // launcher's PowerShell Tee-Object wrapper can leave port 5000 in TIME_WAIT
  // for a few extra seconds. 30 s comfortably covers that without meaningfully
  // extending the perceived wait when shutdown is clean (returns as soon as
  // the port is free).
  const start = Date.now();
  const deadline = start + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await checkPort(5000))) {
      const elapsedMs = Date.now() - start;
      log(`Port 5000 released after ${elapsedMs} ms.`);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const elapsedMs = Date.now() - start;
  log(`Port 5000 did not release within ${elapsedMs} ms.`);
  return false;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function safeEntryPath(root, name) {
  const normalized = name.replace(/\\/g, "/");
  if (
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    /^[a-z]:/i.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(`Unsafe ZIP entry: ${name}`);
  }
  const destination = path.resolve(root, ...normalized.split("/").filter(Boolean));
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (destination !== path.resolve(root) && !destination.startsWith(prefix)) {
    throw new Error(`ZIP entry escapes staging folder: ${name}`);
  }
  return { destination, normalized };
}

function findEndOfCentralDirectory(zip) {
  const minimum = Math.max(0, zip.length - 65_557);
  for (let offset = zip.length - 22; offset >= minimum; offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("ZIP end-of-central-directory record is missing");
}

function extractZip(zip, outputRoot) {
  const eocd = findEndOfCentralDirectory(zip);
  const entryCount = zip.readUInt16LE(eocd + 10);
  const centralOffset = zip.readUInt32LE(eocd + 16);
  if (entryCount > MAX_ENTRIES) throw new Error("ZIP contains too many entries");
  let cursor = centralOffset;
  let expanded = 0;
  fs.mkdirSync(outputRoot, { recursive: true });

  for (let index = 0; index < entryCount; index += 1) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`Invalid ZIP central-directory entry ${index}`);
    }
    const flags = zip.readUInt16LE(cursor + 8);
    const method = zip.readUInt16LE(cursor + 10);
    const expectedCrc = zip.readUInt32LE(cursor + 16);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const uncompressedSize = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    if (flags & 0x1) throw new Error("Encrypted ZIP entries are not supported");
    if (method !== 0 && method !== 8) throw new Error(`Unsupported ZIP compression method ${method}`);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const { destination, normalized } = safeEntryPath(outputRoot, name);
    expanded += uncompressedSize;
    if (expanded > MAX_EXPANDED_BYTES) throw new Error("ZIP expands beyond the allowed size");

    if (normalized.endsWith("/")) {
      fs.mkdirSync(destination, { recursive: true });
    } else {
      if (zip.readUInt32LE(localOffset) !== 0x04034b50) {
        throw new Error(`Invalid local ZIP header for ${name}`);
      }
      const localNameLength = zip.readUInt16LE(localOffset + 26);
      const localExtraLength = zip.readUInt16LE(localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = zip.subarray(dataOffset, dataOffset + compressedSize);
      const content = method === 0 ? compressed : zlib.inflateRawSync(compressed);
      if (content.length !== uncompressedSize || crc32(content) !== expectedCrc) {
        throw new Error(`ZIP integrity check failed for ${name}`);
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content);
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
}

function findPackageRoot(stagingRoot) {
  if (fs.existsSync(path.join(stagingRoot, "dist", "index.cjs"))) return stagingRoot;
  const candidates = fs.readdirSync(stagingRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(stagingRoot, entry.name))
    .filter((entry) => fs.existsSync(path.join(entry, "dist", "index.cjs")));
  if (candidates.length !== 1) {
    throw new Error("Release ZIP does not contain one recognizable application folder");
  }
  return candidates[0];
}

function removePath(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function copyIfPresent(source, destination) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function replaceInstall(incomingRoot, latestVersion) {
  const currentDist = path.join(installRoot, "dist");
  const backupDist = path.join(installRoot, "dist.bak");
  const newDist = path.join(installRoot, `dist.new-${process.pid}`);
  const incomingDist = path.join(incomingRoot, "dist");
  let backupCreated = false;

  if (!fs.existsSync(currentDist) && fs.existsSync(backupDist)) {
    log("Incomplete prior update detected; restoring dist.bak.");
    fs.renameSync(backupDist, currentDist);
  }
  if (!fs.existsSync(currentDist)) throw new Error("Current dist folder is missing");
  if (!fs.existsSync(incomingDist)) throw new Error("Incoming dist folder is missing");

  removePath(newDist);
  fs.cpSync(incomingDist, newDist, { recursive: true, errorOnExist: true });

  try {
    removePath(backupDist);
    fs.renameSync(currentDist, backupDist);
    backupCreated = true;
    if (process.env.APD_UPDATE_TEST_FAIL_AFTER_BACKUP === "1") {
      throw new Error("Simulated failure after backup");
    }
    fs.renameSync(newDist, currentDist);

    copyIfPresent(
      path.join(incomingRoot, "Update AdvisePoint Docs.bat"),
      path.join(installRoot, "Update AdvisePoint Docs.bat"),
    );
    copyIfPresent(
      path.join(incomingRoot, "packaging", "updater", "updater.cjs"),
      path.join(installRoot, "packaging", "updater", "updater.cjs"),
    );

    const currentNodeMarker = path.join(installRoot, "NODE_VERSION");
    const incomingNodeMarker = path.join(incomingRoot, "NODE_VERSION");
    if (
      fs.existsSync(incomingNodeMarker) &&
      fs.readFileSync(incomingNodeMarker, "utf8").trim() !==
        (fs.existsSync(currentNodeMarker) ? fs.readFileSync(currentNodeMarker, "utf8").trim() : "")
    ) {
      const incomingNode = path.join(incomingRoot, "node");
      if (!fs.existsSync(incomingNode)) throw new Error("Updated Node marker has no matching node folder");
      const newNode = path.join(installRoot, `node.new-${process.pid}`);
      const oldNode = path.join(installRoot, "node.old");
      removePath(newNode);
      fs.cpSync(incomingNode, newNode, { recursive: true, errorOnExist: true });
      removePath(oldNode);
      if (fs.existsSync(path.join(installRoot, "node"))) {
        fs.renameSync(path.join(installRoot, "node"), oldNode);
      }
      fs.renameSync(newNode, path.join(installRoot, "node"));
      removePath(oldNode);
      copyIfPresent(incomingNodeMarker, currentNodeMarker);
    }

    fs.writeFileSync(path.join(installRoot, "VERSION"), `${latestVersion}\n`, "utf8");
  } catch (error) {
    removePath(newDist);
    if (backupCreated) {
      removePath(currentDist);
      fs.renameSync(backupDist, currentDist);
    }
    throw error;
  }
}

function ask(question) {
  if (process.env.APD_UPDATE_ASSUME_YES === "1") return Promise.resolve(true);
  if (process.env.APD_UPDATE_NO_PROMPT === "1") return Promise.resolve(false);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(?:es)?$/i.test(answer.trim()));
    });
  });
}

function waitForEnter(message) {
  if (process.env.APD_UPDATE_NO_PROMPT === "1") return Promise.resolve();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

function launchApp() {
  if (process.platform !== "win32" || process.env.APD_UPDATE_NO_LAUNCH === "1") return;
  const launcher = path.join(installRoot, "Start AdvisePoint Docs.bat");
  spawn("cmd.exe", ["/c", launcher], {
    cwd: installRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
}

async function main() {
  log("=== Update check started ===");
  log(`Install root: ${installRoot}`);
  if (await checkPort(5000)) {
    if (!(await identifyRunningApp())) {
      log("Port 5000 is in use by a process that is not AdvisePoint Docs.");
      console.log("The updater will not stop an unrelated server. Free port 5000, then run this updater again.");
      return 2;
    }
    if (!(await ask("AdvisePoint Docs's background server is still running. Shut it down and continue? (Y/N) "))) {
      log("Update cancelled; the running background server was left unchanged.");
      return 2;
    }
    try {
      log("Requesting a clean shutdown from AdvisePoint Docs.");
      console.log("Requesting a clean shutdown from AdvisePoint Docs (waiting up to 30 seconds)...");
      await requestServerShutdown();
      if (!(await waitForPortRelease())) {
        console.log("The background server did not release port 5000 within 30 seconds.");
        console.log("You can try running this updater again in a minute, or open the update log at:");
        console.log("  %LOCALAPPDATA%\\AdvisePoint Docs\\update.log");
        console.log("and share the last section if the problem keeps happening.");
        return 2;
      }
      log("Background server stopped.");
    } catch (error) {
      log(`Automatic shutdown failed: ${error.message}`);
      console.log(`The background server could not be stopped: ${error.message}`);
      console.log("You can try running this updater again in a minute, or open the update log at:");
      console.log("  %LOCALAPPDATA%\\AdvisePoint Docs\\update.log");
      console.log("and share the last section if the problem keeps happening.");
      return 2;
    }
  }

  const currentVersion = readCurrentVersion();
  log(`Running version: v${currentVersion}`);

  let latest;
  try {
    latest = await fetchLatestRelease();
  } catch (error) {
    log(`Network/release check failed: ${error.message}`);
    console.log("Could not reach GitHub. Check your internet connection and try again.");
    return 3;
  }
  log(`Latest version available on GitHub: v${latest.version}`);
  const comparison = compareVersions(currentVersion, latest.version);
  if (comparison === 0) {
    log(`You are running v${currentVersion}, which matches the latest version available on GitHub.`);
    await waitForEnter("Press Enter to close.");
    return 0;
  }
  if (comparison > 0) {
    log(`You are running v${currentVersion}. GitHub's latest published release is v${latest.version}, so this installation is newer than the published release.`);
    await waitForEnter("Press Enter to close.");
    return 0;
  }
  log(`GitHub has a newer version: v${latest.version}.`);

  const tempBase = process.env.TEMP || os.tmpdir();
  fs.mkdirSync(tempBase, { recursive: true });
  const zipPath = path.join(tempBase, `apd-update-${latest.version}.zip`);
  const stagingRoot = path.join(tempBase, `apd-update-${latest.version}`);
  removePath(zipPath);
  removePath(stagingRoot);

  try {
    log(`Downloading ${latest.assetUrl}`);
    const archive = await requestBuffer(latest.assetUrl);
    fs.writeFileSync(zipPath, archive);
    const actualHash = crypto.createHash("sha256").update(archive).digest("hex");
    log(`Downloaded bytes=${archive.length} sha256=${actualHash}`);
    if (archive.length !== latest.assetSize) {
      throw new Error(`Download size mismatch: expected ${latest.assetSize}, received ${archive.length}`);
    }
    if (latest.sha256 && actualHash !== latest.sha256) {
      throw new Error(`SHA-256 mismatch: expected ${latest.sha256}, received ${actualHash}`);
    }
    if (!latest.sha256) log("Release notes contain no sha256 line; size and ZIP CRC checks will be used.");

    log(`Extracting to ${stagingRoot}`);
    extractZip(archive, stagingRoot);
    const incomingRoot = findPackageRoot(stagingRoot);
    const incomingVersionPath = path.join(incomingRoot, "VERSION");
    if (!fs.existsSync(incomingVersionPath)) throw new Error("Incoming VERSION marker is missing");
    const incomingVersion = fs.readFileSync(incomingVersionPath, "utf8").trim();
    if (compareVersions(incomingVersion, currentVersion) <= 0) {
      throw new Error(`Refusing downgrade or same-version install: v${incomingVersion}`);
    }
    if (compareVersions(incomingVersion, latest.version) !== 0) {
      throw new Error(`Release tag v${latest.version} does not match package v${incomingVersion}`);
    }

    log("Replacing application files.");
    replaceInstall(incomingRoot, latest.version);
    log(`Update complete: v${currentVersion} -> v${latest.version}`);
  } catch (error) {
    log(`Update failed: ${error.stack || error.message}`);
    console.log("Update failed. Your existing installation was preserved.");
    return 4;
  } finally {
    removePath(zipPath);
    removePath(stagingRoot);
  }

  if (await ask("Update complete. Launch AdvisePoint Docs now? (Y/N) ")) {
    launchApp();
  }
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => { process.exitCode = code; },
    (error) => {
      try {
        fail("Unexpected updater failure", error);
      } catch {
        console.error("Unexpected updater failure. See update.log for details.");
      }
      process.exitCode = 5;
    },
  );
}

module.exports = {
  compareVersions,
  crc32,
  extractZip,
  findPackageRoot,
  safeEntryPath,
  identifyRunningApp,
  localAppRequest,
  waitForPortRelease,
};
