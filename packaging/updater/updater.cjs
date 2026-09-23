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
const { spawn, execFileSync } = require("node:child_process");

const OWNER = "S8619G";
// v1.0.1.1: Repo name must match GitHub's canonical mixed-case spelling.
// GitHub's REST API is case-insensitive for the owner/repo path, so the
// DEFAULT_API_URL below works either way. But asset download URLs come back
// from the API in the repo's *canonical* case ("AdvisePoint-Docs"), and the
// isTrustedAssetUrl() prefix check is case-sensitive by default — so if REPO
// is lowercase here, every asset URL is silently rejected and the updater
// throws "Release asset ... was not found" even though the asset is right
// there. That was the v1.0.0 -> v1.0.1 in-app updater failure.
const REPO = "AdvisePoint-Docs";
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

// v1.0.8.3: Coordinate with Start AdvisePoint Docs.bat so a mid-update
// shutdown of the running server does not trigger the launcher's crash
// surface. We drop this sentinel BEFORE requesting /shutdown and remove it
// AFTER we've relaunched (or after any error path). While the sentinel is
// present the launcher suppresses its non-zero-exit crash window.
const updateSentinelPath = path.join(logDir, ".updating");
let ownsSentinel = false;

fs.mkdirSync(logDir, { recursive: true });

function writeUpdateSentinel() {
  try {
    fs.writeFileSync(updateSentinelPath, `${new Date().toISOString()} pid=${process.pid}\n`, "utf8");
    ownsSentinel = true;
    log(`Update sentinel written: ${updateSentinelPath}`);
  } catch (err) {
    log(`WARN could not write update sentinel: ${err && err.message}`);
  }
}

function clearUpdateSentinel() {
  if (!ownsSentinel) return;
  try {
    if (fs.existsSync(updateSentinelPath)) {
      fs.unlinkSync(updateSentinelPath);
      log("Update sentinel cleared.");
    }
  } catch (err) {
    log(`WARN could not clear update sentinel: ${err && err.message}`);
  }
}

function timestamp() {
  return new Date().toISOString();
}

function log(message) {
  if (/failed|mismatch|not found|refusing|cancelled/i.test(message)) lastFailure = message;
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
    // v1.0.1.1: case-insensitive path comparison. GitHub can return either
    // the canonical repo casing or lower-cased path segments depending on
    // how the release was created and which redirect chain the client hits.
    // Lower-case both sides so the check tolerates any variant.
    const expectedPrefix = `/${OWNER}/${REPO}/releases/download/`.toLowerCase();
    return parsed.protocol === "https:" &&
      parsed.hostname === "github.com" &&
      parsed.pathname.toLowerCase().startsWith(expectedPrefix);
  } catch {
    return false;
  }
}

function readInstalledArch(root = installRoot) {
  const marker = path.join(root, "ARCH");
  const arch = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim().toLowerCase() : "x64";
  if (!["x64", "arm64"].includes(arch)) throw new Error(`Unsupported installed architecture: ${arch}`);
  return arch;
}

function selectReleaseAsset(release, arch) {
  if (!["x64", "arm64"].includes(arch)) throw new Error(`Unsupported installed architecture: ${arch}`);
  const candidates = [];
  for (const asset of Array.isArray(release.assets) ? release.assets : []) {
    // Only binary product names, never source/debug archives or a lone arbitrary ZIP.
    const match = String(asset?.name || "").match(
      /^advisepoint[._-]?docs(?:[._-]v?(\d+(?:\.\d+)*))?(?:[._-](x64|arm64))?\.zip$/i,
    );
    if (!match || !isTrustedAssetUrl(asset.browser_download_url) ||
        !Number.isSafeInteger(asset.size) || asset.size <= 0) continue;
    if (match[1] && compareVersions(match[1], release.tag_name) !== 0) continue;
    const assetArch = match[2]?.toLowerCase();
    if (assetArch ? assetArch !== arch : arch !== "x64") continue;
    candidates.push({ asset, rank: (assetArch ? 2 : 0) + (match[1] ? 1 : 0) });
  }
  candidates.sort((a, b) => b.rank - a.rank || a.asset.name.localeCompare(b.asset.name));
  if (!candidates.length) {
    throw new Error(`No compatible ${arch} binary package was found. Open the release page and choose the ${arch} ZIP; source archives cannot be installed.`);
  }
  if (candidates[1]?.rank === candidates[0].rank) {
    throw new Error(`Multiple equally matching ${arch} packages were found; refusing an ambiguous release.`);
  }
  return candidates[0].asset;
}

async function fetchLatestRelease(arch = readInstalledArch()) {
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
  /* Legacy broad selection is intentionally replaced: it could choose source
     or x64 on ARM64. Retained historical explanation below.
  // v1.0.3: accept both the new canonical version-free filename and the
  // legacy versioned filename. New builds ship AdvisePoint-Docs.zip; the
  // versioned pattern remains supported for older releases and any future
  // release that reverts to the versioned name for a specific reason.
  const canonicalName = "advisepoint-docs.zip";
  const versionedName = `advisepoint-docs-v${String(release.tag_name).replace(/^v/i, "")}.zip`;
  // v1.0.11.3: some GitHub uploads (especially manual ones through the
  // Releases UI) end up with the asset filename that the browser sent,
  // which can be dotted or mixed-case -- e.g. `AdvisePoint.Docs.v1.0.11.1.zip`.
  // Prior versions only accepted the exact lowercase-hyphen forms and
  // rejected the asset with `Release asset ... was not found`, which
  // silently broke every GitHub-hosted in-place upgrade whose asset
  // filename didn't match. Normalize by stripping case, dots, hyphens,
  // and underscores before comparing so all reasonable naming styles
  // match the same target.
  const normalize = (s) => String(s || "").toLowerCase().replace(/[.\-_]/g, "");
  const canonicalKey = normalize(canonicalName);
  const versionedKey = normalize(versionedName);
  // v1.0.12.1: the exact-key comparison above still rejected every asset
  // whose embedded version had more parts than the tag. A three-part tag
  // like `v1.0.12` produced the key `advisepointdocsv1012zip`, while the
  // four-part build uploaded as `AdvisePoint.Docs.v1.0.12.0.zip`
  // normalized to `advisepointdocsv10120zip` -- no match, so the update
  // aborted before downloading. Every GitHub-hosted upgrade from v1.0.11
  // onward failed this way. Tag and package version numbers are allowed
  // to differ in precision (compareVersions() below zero-pads them), so
  // the asset filename must not be required to echo the tag exactly.
  //
  // Accept, in descending order of confidence:
  //   1. the canonical version-free name,
  //   2. the exact tag-versioned name,
  //   3. any product-prefixed .zip (covers any version spelling), and
  //   4. a lone .zip asset on the release.
  // The trust check on browser_download_url is unchanged and still gates
  // every candidate, so widening the name match cannot introduce a
  // download from outside the release.
  const productKey = "advisepointdocs";
  const isUsableAsset = (item) => {
    if (typeof item?.name !== "string") return false;
    if (!isTrustedAssetUrl(item.browser_download_url)) return false;
    if (!Number.isSafeInteger(item.size) || item.size <= 0) return false;
    return normalize(item.name).endsWith("zip");
  };
  const assetList = Array.isArray(release.assets) ? release.assets : [];
  const usable = assetList.filter(isUsableAsset);
  const asset =
    usable.find((item) => normalize(item.name) === canonicalKey) ||
    usable.find((item) => normalize(item.name) === versionedKey) ||
    usable.find((item) => normalize(item.name).startsWith(productKey)) ||
    (usable.length === 1 ? usable[0] : null) ||
    null;
  if (asset && normalize(asset.name) !== canonicalKey) {
    log(`Release asset matched by relaxed name rule: ${asset.name}`);
  }
  const expectedName = `${canonicalName}, ${versionedName}, or any AdvisePoint-Docs*.zip`;
  if (!asset) {
    // v1.0.1.1: enumerate what the API actually returned so this class of
    // bug is diagnosable from update.log without needing the source tree.
    // The prior message just showed the expected name and gave no hint
    // whether the asset was missing, mis-named, or filtered by the trust
    // check.
    const rawList = Array.isArray(release.assets)
      ? release.assets
          .map((a) => {
            const name = typeof a?.name === "string" ? a.name : "(no name)";
            const url = typeof a?.browser_download_url === "string" ? a.browser_download_url : "(no url)";
            const size = Number.isSafeInteger(a?.size) ? a.size : "?";
            const trusted = isTrustedAssetUrl(url) ? "trusted" : "UNTRUSTED_URL";
            return `${name} [${size} bytes, ${trusted}, ${url}]`;
          })
          .join("; ")
      : "(release.assets is not an array)";
    throw new Error(
      `Release asset ${expectedName} was not found. ` +
      `API returned ${Array.isArray(release.assets) ? release.assets.length : 0} asset(s): ${rawList || "(none)"}`,
    );
  }
  */
  const asset = selectReleaseAsset(release, arch);
  log(`Selected ${arch} release asset: ${asset.name}`);
  // Bind integrity to this asset, never a release-wide hash for another ZIP.
  let sha256 = null;
  if (asset.digest != null) {
    const match = String(asset.digest).match(/^sha256:([a-f0-9]{64})$/i);
    if (!match) throw new Error(`Invalid SHA-256 digest for ${asset.name}`);
    sha256 = match[1].toLowerCase();
  }
  const companion = (release.assets || []).find((item) => item.name === `${asset.name}.sha256`);
  if (companion) {
    if (!isTrustedAssetUrl(companion.browser_download_url)) throw new Error("Untrusted checksum URL");
    const text = (await requestBuffer(companion.browser_download_url, { maxBytes: 4096 })).toString("utf8").trim();
    const match = text.match(/^([a-f0-9]{64})[ \t]+\*?([^\r\n]+)$/i);
    if (!match || match[2] !== asset.name) throw new Error(`Invalid checksum companion for ${asset.name}`);
    if (sha256 && sha256 !== match[1].toLowerCase()) throw new Error("Asset digest and checksum companion disagree");
    sha256 = match[1].toLowerCase();
  }
  // Legacy releases used one unmarked binary and one release-body hash.
  // Never apply that ambiguous hash to an architecture-specific asset.
  if (!sha256 && !/[-_.](?:x64|arm64)\.zip$/i.test(asset.name)) {
    const match = String(release.body || "").match(/^\s*sha256:\s*([a-f0-9]{64})\s*$/im);
    sha256 = match?.[1].toLowerCase() || null;
  }
  if (!sha256) throw new Error(`No asset-specific SHA-256 checksum was found for ${asset.name}`);
  return {
    version: String(release.tag_name).replace(/^v/i, ""),
    assetName: asset.name,
    assetUrl: asset.browser_download_url,
    assetSize: asset.size,
    sha256,
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

// v1.0.12.1: confirm the relaunched server actually came back up. The
// updater previously spawned the launcher and exited immediately, so a
// launcher that failed to start node produced no evidence at all -- the log
// ended at "Update complete" and the user was left staring at a dead tab
// with no idea whether the update or the relaunch had failed.
async function waitForPortInUse(timeoutMs = 45_000) {
  if (process.env.APD_UPDATE_NO_LAUNCH === "1") return false;
  const start = Date.now();
  const deadline = start + timeoutMs;
  while (Date.now() < deadline) {
    if (await identifyRunningApp()) {
      log(`AdvisePoint Docs health check passed after ${Date.now() - start} ms.`);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
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

// ---------------------------------------------------------------------------
// v1.0.12: stale-instance detection.
//
// Every prior release gated the dist/node swap solely on port 5000 being
// free (waitForPortRelease). That is not sufficient: the launcher does
// `cd /d "%~dp0"` and runs `<installRoot>\node\node.exe`, so a surviving
// server process holds BOTH an executable-image handle inside the install
// folder AND the install folder as its working directory. Such a process
// keeps the folder locked (Windows refuses to rename it) and can make the
// atomic rename fail mid-flight, yet it is completely invisible to a
// LISTENING-on-5000 check once it has lost or never claimed the port.
//
// Field report (v1.0.11.4 -> v1.0.11.5): the install folder could not even
// be renamed by hand afterwards because one of these orphans was still
// alive while the app was being served from a different folder.
//
// Detection is Windows-only and best-effort by design. If the query cannot
// run we return null, meaning "unknown", and the caller treats unknown as
// safe-to-proceed so we never block a legitimate upgrade on a broken
// PowerShell. A positive result, by contrast, aborts BEFORE anything in
// dist/ is touched.
function findStaleInstallProcesses() {
  if (process.platform !== "win32") return [];
  // v1.0.12: the trailing separator is load-bearing. Without it, a bare
  // startsWith() on "c:\...\advisepoint docs" also matches sibling folders
  // like "c:\...\advisepoint docs-old\node\node.exe", and we would happily
  // kill a DIFFERENT installation the user is deliberately running.
  const rootLower = installRoot.toLowerCase().replace(/[\\/]+$/, "") + path.sep;
  // Win32_Process exposes ExecutablePath and CommandLine but not the working
  // directory, so we match on the image path (covers launcher-started node)
  // and on the command line (covers a node started with an explicit path to
  // dist\index.cjs under this root).
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
    "Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress -Depth 2";
  let raw;
  try {
    raw = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", timeout: 15_000, windowsHide: true },
    );
  } catch (error) {
    log(`Stale-instance check could not run: ${error.message}`);
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.trim() || "[]");
  } catch {
    log("Stale-instance check returned unparseable output.");
    return null;
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];

  // v1.0.12: the updater is itself `<installRoot>\node\node.exe`, launched by
  // "Update AdvisePoint Docs.bat", which the running server spawns. So this
  // process matches its own filter (excluded by PID below) and an old server
  // may still be our ANCESTOR. Killing an ancestor tree would terminate the
  // updater mid-run, so ancestors are reported but never killed.
  const parentOf = new Map();
  for (const row of rows) {
    if (row && typeof row.ProcessId === "number") {
      parentOf.set(row.ProcessId, typeof row.ParentProcessId === "number" ? row.ParentProcessId : 0);
    }
  }
  const ancestors = new Set();
  let cursor = parentOf.get(process.pid) ?? 0;
  for (let hops = 0; cursor && hops < 32 && !ancestors.has(cursor); hops += 1) {
    ancestors.add(cursor);
    cursor = parentOf.get(cursor) ?? 0;
  }

  const matches = [];
  for (const row of rows) {
    if (!row || typeof row.ProcessId !== "number") continue;
    if (row.ProcessId === process.pid) continue;
    const image = String(row.ExecutablePath || "").toLowerCase();
    const cmdline = String(row.CommandLine || "").toLowerCase();
    if (image.startsWith(rootLower) || cmdline.includes(rootLower)) {
      matches.push({
        pid: row.ProcessId,
        image: row.ExecutablePath || "(unknown)",
        isAncestor: ancestors.has(row.ProcessId),
      });
    }
  }
  return matches;
}

// Terminate a stale instance and confirm it is actually gone. Returns true
// when the install folder is clear (or when detection is unavailable), false
// only when we positively know a process is still holding it.
async function ensureNoStaleInstance() {
  let found = findStaleInstallProcesses();
  if (found === null) return true; // unknown -> do not block the upgrade
  if (found.length === 0) {
    log("No stale AdvisePoint Docs processes are holding the install folder.");
    return true;
  }

  // v1.0.12.1: give the old server a chance to finish exiting on its own
  // before reaching for taskkill. The v1.0.12.0 field diagnostics showed
  // the previous node.exe releasing port 5000 in 3 ms but not actually
  // exiting for another 44 seconds -- it was still flushing its shutdown
  // path. Terminating it the instant the port frees is both unnecessary
  // and riskier than waiting a few seconds for a clean exit, so poll
  // first and only force what is genuinely stuck.
  //
  // v1.1.7: widened from 20 s to 45 s. A v1.1.4 -> v1.1.6 upgrade in the
  // field observed the old server taking 18.6 s to exit on its own, well
  // inside the previous window but close enough to the boundary that a
  // slightly slower shutdown (a larger library, an antivirus scan mid-
  // close) would tip into a forced kill. The server itself now bounds its
  // own shutdown at 5 s via a worker-thread watchdog (server/shutdown-
  // watchdog.ts), so 45 s here is a generous margin, not an SLA.
  const graceDeadline = Date.now() + 45_000;
  log(`Waiting for ${found.length} exiting process(es) to finish before touching files.`);
  while (Date.now() < graceDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const still = findStaleInstallProcesses();
    if (still === null) return true;
    if (still.length === 0) {
      log("Previous instance exited on its own; install folder is clear.");
      return true;
    }
    found = still;
  }
  log(`Still held after grace period; forcing termination of ${found.length} process(es).`);

  for (const proc of found) {
    log(`Stale process holding the install folder: pid=${proc.pid} image=${proc.image}`);
    if (proc.isAncestor) {
      // Killing our own ancestor would take this updater down with it.
      log(`pid=${proc.pid} is an ancestor of this updater; not terminating it.`);
      continue;
    }
    try {
      // No /T. The process tree below an old server can contain THIS updater
      // (server -> cmd -> node updater), and /T would kill us mid-run.
      execFileSync("taskkill.exe", ["/PID", String(proc.pid), "/F"], {
        encoding: "utf8",
        timeout: 15_000,
        windowsHide: true,
      });
      log(`Terminated stale process pid=${proc.pid}.`);
    } catch (error) {
      log(`Could not terminate pid=${proc.pid}: ${error.message}`);
    }
  }

  // Windows takes a moment to release handles after the process object dies.
  // v1.1.7: widened from 10 s to 20 s. On the field-observed slow shutdown
  // the file handles were the actual blocker for the subsequent dist swap
  // ('EPERM: operation not permitted, unlink ...'). A longer wait here
  // makes the retry loop in replaceInstall() less likely to escalate to
  // its recovery path.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    found = findStaleInstallProcesses();
    if (found === null) return true;
    if (found.length === 0) {
      log("Install folder is clear after terminating stale processes.");
      return true;
    }
  }
  // v1.0.12.1: never abort over a process we deliberately refused to kill.
  // Anything flagged isAncestor belongs to this updater's own launch chain,
  // so treating it as a foreign holder would make every in-place update
  // fail with "a previous process is still holding the folder" -- exactly
  // the outcome this gate exists to prevent. Proceed and let
  // replaceInstall()'s retry handle a genuine sharing violation.
  if (found.every((p) => p.isAncestor)) {
    log(
      `Remaining process(es) are part of this updater's own launch chain (${found
        .map((p) => p.pid)
        .join(", ")}); proceeding.`,
    );
    return true;
  }
  log(`Install folder is still held by: ${found.map((p) => p.pid).join(", ")}`);
  return false;
}

// v1.0.12.1: Windows can keep a directory handle open for a short window
// after the owning process dies, which surfaces as EBUSY/EPERM/EACCES on
// rename. Retrying briefly turns a hard update failure into a slightly
// slower success.
function renameWithRetry(from, to, attempts = 12) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      if (attempt > 1) log(`Rename succeeded on attempt ${attempt}: ${path.basename(to)}`);
      return;
    } catch (error) {
      const retryable =
        error && (error.code === "EBUSY" || error.code === "EPERM" || error.code === "EACCES");
      if (!retryable || attempt >= attempts) throw error;
      log(`Rename blocked (${error.code}) on ${path.basename(to)}; retrying (${attempt}/${attempts}).`);
      // Synchronous sleep: replaceInstall() is deliberately non-async so the
      // swap window cannot interleave with anything else. Atomics.wait on a
      // private buffer blocks this thread without spawning a helper process
      // (process.execPath lives inside the folder being replaced).
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
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

// v1.2.2: local-zip preflight. Verify a local update zip's integrity BEFORE
// touching the install directory, so a corrupt file (bad USB transfer,
// interrupted download) is refused with a clear "redownload" message
// instead of a mid-extraction "integrity check failed" that reads like a
// generic "retry" prompt. Two tiers:
//   Tier 1: if `<zipPath>.sha256` or `SHA256SUMS.txt` sits beside the zip
//           and names this file, hash the zip and refuse on mismatch.
//   Tier 2: no companion file -> walk the central directory once and
//           verify every entry's compressed CRC without writing anything.
// Only after preflight passes does extractZip run for real.
function readCompanionSha256(zipPath) {
  const dir = path.dirname(zipPath);
  const base = path.basename(zipPath);
  const perFile = path.join(dir, base + ".sha256");
  if (fs.existsSync(perFile)) {
    try {
      const raw = fs.readFileSync(perFile, "utf8").trim();
      // sha256sum format: "<64 hex>  <basename>"; be lenient about the filename column.
      const m = raw.match(/^([a-f0-9]{64})\b/i);
      if (m) return { hash: m[1].toLowerCase(), source: perFile };
    } catch (error) {
      log(`Preflight: could not read companion hash file ${perFile}: ${error.message}`);
    }
  }
  const sumsFile = path.join(dir, "SHA256SUMS.txt");
  if (fs.existsSync(sumsFile)) {
    try {
      const lines = fs.readFileSync(sumsFile, "utf8").split(/\r?\n/);
      for (const line of lines) {
        const m = line.match(/^([a-f0-9]{64})\s+\*?(\S.*)$/i);
        if (m && path.basename(m[2].trim()) === base) {
          return { hash: m[1].toLowerCase(), source: sumsFile };
        }
      }
    } catch (error) {
      log(`Preflight: could not read SHA256SUMS.txt at ${sumsFile}: ${error.message}`);
    }
  }
  return null;
}

function formatPreflightErrorLines(expected, actual, failingEntry, failingCount) {
  const lines = [];
  lines.push("");
  lines.push("The update file on your disk is damaged.");
  lines.push("");
  lines.push("The file that was shipped is not the same as the file that's on");
  lines.push("your disk now. Something between the download and this laptop");
  lines.push("corrupted it -- most commonly a USB thumbdrive, a network share,");
  lines.push("or an interrupted download.");
  lines.push("");
  if (expected && actual) {
    lines.push(`Expected SHA-256: ${expected}`);
    lines.push(`Actual SHA-256:   ${actual}`);
    lines.push("");
  } else if (failingEntry) {
    lines.push(`Failing entry: ${failingEntry}`);
    if (failingCount && failingCount > 1) {
      lines.push(`Total corrupted entries in the zip: ${failingCount}`);
    }
    lines.push("");
  }
  lines.push("Do NOT retry the update against this file. Instead:");
  lines.push("  1. Redownload the update file, ideally directly to this laptop.");
  lines.push("  2. If you must transfer via USB, hash the file on both ends");
  lines.push("     with Get-FileHash before running the updater.");
  lines.push("  3. If the file continues to arrive corrupt, your USB drive");
  lines.push("     or your network path may be the cause -- try a different route.");
  lines.push("");
  lines.push("Your existing installation was not touched.");
  return lines;
}

function preflightLocalZip(zip, zipPath) {
  // Tier 1: companion hash file, if present.
  const companion = readCompanionSha256(zipPath);
  if (companion) {
    const actual = crypto.createHash("sha256").update(zip).digest("hex").toLowerCase();
    log(`Preflight: companion hash source=${companion.source}`);
    log(`Preflight: expected=${companion.hash} actual=${actual}`);
    if (actual !== companion.hash) {
      const lines = formatPreflightErrorLines(companion.hash, actual, null, 0);
      const err = new Error("Local zip failed SHA-256 preflight");
      err.userLines = lines;
      err.expectedHash = companion.hash;
      err.actualHash = actual;
      throw err;
    }
    log("Preflight: companion SHA-256 verified.");
    return;
  }

  // Tier 2: no companion file. Walk the central directory and verify every
  // entry's CRC without writing anything. This is intentionally the SAME
  // decode path extractZip uses, so a mid-stream DEFLATE corruption on a
  // large binary entry is caught here rather than after we've started
  // writing files to the install root.
  log("Preflight: no companion hash file; verifying entries by CRC.");
  const eocd = findEndOfCentralDirectory(zip);
  const entryCount = zip.readUInt16LE(eocd + 10);
  const centralOffset = zip.readUInt32LE(eocd + 16);
  if (entryCount > MAX_ENTRIES) throw new Error("ZIP contains too many entries");
  let cursor = centralOffset;
  let firstFailingEntry = null;
  let failingCount = 0;
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
    if (!name.endsWith("/")) {
      if (zip.readUInt32LE(localOffset) !== 0x04034b50) {
        throw new Error(`Invalid local ZIP header for ${name}`);
      }
      const localNameLength = zip.readUInt16LE(localOffset + 26);
      const localExtraLength = zip.readUInt16LE(localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = zip.subarray(dataOffset, dataOffset + compressedSize);
      let content;
      try {
        content = method === 0 ? compressed : zlib.inflateRawSync(compressed);
      } catch (error) {
        if (!firstFailingEntry) firstFailingEntry = name;
        failingCount += 1;
        cursor += 46 + nameLength + extraLength + commentLength;
        continue;
      }
      if (content.length !== uncompressedSize || crc32(content) !== expectedCrc) {
        if (!firstFailingEntry) firstFailingEntry = name;
        failingCount += 1;
      }
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (failingCount > 0) {
    log(`Preflight: ${failingCount} corrupt entr${failingCount === 1 ? "y" : "ies"} in local zip; first failure: ${firstFailingEntry}`);
    const lines = formatPreflightErrorLines(null, null, firstFailingEntry, failingCount);
    const err = new Error(`Local zip failed integrity preflight (${failingCount} corrupt entr${failingCount === 1 ? "y" : "ies"}, first: ${firstFailingEntry})`);
    err.userLines = lines;
    err.failingEntry = firstFailingEntry;
    err.failingCount = failingCount;
    throw err;
  }
  log("Preflight: all entries verified.");
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

// ---------------------------------------------------------------------------
// v1.1.0: app-root sync (fixes the v1.0.14 -> v1.0.15 "welcome guide vanished"
// upgrade bug).
//
// Through v1.0.15 replaceInstall() swapped dist/ and then hand-copied exactly
// two files ("Update AdvisePoint Docs.bat" and packaging/updater/updater.cjs)
// plus the node/ runtime. Everything else in the incoming release's app root
// was silently discarded. That meant any file or folder introduced by a NEW
// version never landed on disk during an upgrade -- which is how v1.0.15's
// welcome-guide/AdvisePoint-Docs-Welcome-Guide.pdf went missing for anyone who
// upgraded from v1.0.14 instead of extracting a fresh copy. README.txt,
// launcher/, and "Setup Icon (run once).bat" were equally stale for the same
// reason; nobody noticed because those files rarely changed.
//
// The sync below walks the incoming app root and writes EVERY file it finds,
// creating directories as needed.
//
// Two safety properties, both deliberate:
//
//   1. ADDITIVE ONLY. We copy and overwrite; we never delete anything already
//      in the install root. An upgrade therefore cannot remove user content
//      that happens to live beside the app, and a stale file left behind by an
//      older build is strictly less harmful than the data loss that pruning
//      could cause. VERSION is the one authoritative marker of "what is
//      installed", and replaceInstall() still writes it last.
//   2. EXPLICIT PRESERVE SET. Shipped releases must not contain user data, so
//      in practice the names below never appear in an incoming zip. The guard
//      exists anyway: if a future packaging mistake ever ships a file named
//      advisepoint.db (or pages/, originals/, ...), the updater refuses to
//      overwrite the user's copy rather than destroying a library. This is the
//      same preserve-first posture the backup/restore path uses.
//
// Note that user data does not normally live in the install root at all --
// "Start AdvisePoint Docs.bat" points RAG_DB_PATH and RAG_PAGES_DIR at
// %LOCALAPPDATA%\AdvisePoint Docs\. The preserve set covers older installs and
// portable/dev layouts that kept the DB next to the app.

// Top-level names replaceInstall() manages through their own dedicated,
// rollback-aware code paths. Syncing them again here would either duplicate
// work or fight the atomic rename/marker logic.
const SYNC_SKIP_TOP_LEVEL = new Set([
  "dist",          // swapped atomically via dist.new -> dist with dist.bak rollback
  "node",          // replaced only when NODE_VERSION changes
  "NODE_VERSION",  // written alongside the node/ swap
  "VERSION",       // written last, after every other step succeeds
  // v1.2.0: ARCH is checked up-front by the incoming-vs-installed match
  // gate below; a mismatched upgrade is refused before replaceInstall()
  // runs. Skipping the sync here keeps the ARCH sentinel arch-locked to
  // the installed layout even in the (impossible-under-the-gate) case
  // where an incoming zip somehow carried a different value.
  "ARCH",
]);

// Never created, overwritten, or removed by the sync. Lowercase for
// case-insensitive comparison (Windows filesystems are case-insensitive, and
// an upgrade must behave identically on a case-sensitive volume).
const SYNC_PRESERVE_NAMES = new Set([
  // user database, current and historical names
  "advisepoint.db",
  "advisepoint.db-wal",
  "advisepoint.db-shm",
  "data.db",
  "data.db-wal",
  "data.db-shm",
  // user content and derived caches
  "pages",
  "originals",
  "snapshots",
  "backups",
  "quarantine",
  "trash",
  "logs",
  // local runtime state, not shipped
  ".unblocked",
  ".updating",
  ".update-lock",
  // transient artifacts owned by this updater's rollback logic
  "dist.bak",
  "node.old",
]);

function isPreservedName(name) {
  const lower = String(name).toLowerCase();
  if (SYNC_PRESERVE_NAMES.has(lower)) return true;
  // server.log, server.log.1, update.log, ...
  if (/\.log(\.\d+)?$/.test(lower)) return true;
  // dist.new-1234 / node.new-1234 from an interrupted prior run
  if (/^(dist|node)\.new-\d+$/.test(lower)) return true;
  if (lower.startsWith(".update-recovery-")) return true;
  return false;
}

// Recursively copy `sourceDir` over `targetDir`. Returns a summary so the
// update log records exactly what the upgrade added or refreshed -- the
// v1.0.15 bug was invisible partly because the log said nothing about the
// files it skipped.
function syncDirectory(sourceDir, targetDir, summary, isTopLevel) {
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const name = entry.name;
    if (isTopLevel && SYNC_SKIP_TOP_LEVEL.has(name)) continue;
    if (isPreservedName(name)) {
      summary.preserved.push(name);
      continue;
    }

    const source = path.join(sourceDir, name);
    const target = path.join(targetDir, name);

    if (entry.isDirectory()) {
      const isNew = !fs.existsSync(target);
      fs.mkdirSync(target, { recursive: true });
      if (isNew) summary.newFolders.push(path.relative(installRoot, target));
      syncDirectory(source, target, summary, false);
      continue;
    }

    // Symlinks in a release zip are not expected; extractZip() writes regular
    // files only. Skip anything that is neither a file nor a directory rather
    // than following it somewhere unexpected.
    if (!entry.isFile()) continue;

    const isNew = !fs.existsSync(target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    if (isNew) summary.newFiles.push(path.relative(installRoot, target));
    else summary.updatedFiles.push(path.relative(installRoot, target));
  }
}

function syncAppRoot(incomingRoot) {
  const summary = { newFiles: [], newFolders: [], updatedFiles: [], preserved: [] };
  syncDirectory(incomingRoot, installRoot, summary, true);

  log(
    `App root sync: ${summary.newFiles.length} new file(s), ` +
    `${summary.newFolders.length} new folder(s), ` +
    `${summary.updatedFiles.length} refreshed file(s).`,
  );
  if (summary.newFolders.length) {
    log(`New folders: ${summary.newFolders.join(", ")}`);
  }
  if (summary.newFiles.length) {
    // Cap the listing so a first-time node_modules sync cannot flood the log.
    const shown = summary.newFiles.slice(0, 25);
    const suffix = summary.newFiles.length > shown.length
      ? `, ... (+${summary.newFiles.length - shown.length} more)`
      : "";
    log(`New files: ${shown.join(", ")}${suffix}`);
  }
  if (summary.preserved.length) {
    log(`Preserved existing (not overwritten): ${[...new Set(summary.preserved)].join(", ")}`);
  }
  return summary;
}

// Snapshot precisely the files this update may overwrite. User-data preserve
// rules apply recursively, and unknown existing files are never pruned.
// This covers launcher/updater/native modules and version markers, not only
// dist/. A failed rollback retains the verified recovery copy for manual repair.
function createRecoverySnapshot(incomingRoot) {
  const backup = fs.mkdtempSync(path.join(installRoot, ".update-recovery-"));
  const entries = [];
  const folders = [];
  const digest = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  function copyVerified(source, target) {
    const st = fs.lstatSync(source);
    if (st.isSymbolicLink()) throw new Error(`Refusing symbolic link in managed application files: ${source}`);
    if (st.isDirectory()) {
      fs.mkdirSync(target, { recursive: true });
      for (const name of fs.readdirSync(source)) copyVerified(path.join(source, name), path.join(target, name));
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      if (digest(source) !== digest(target)) throw new Error(`Recovery copy verification failed: ${source}`);
    }
  }
  function record(relative) {
    const target = path.join(installRoot, relative);
    const exists = fs.existsSync(target);
    if (exists) copyVerified(target, path.join(backup, relative));
    entries.push({ relative, exists });
  }
  function walk(dir, relative = "") {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if ((!relative && SYNC_SKIP_TOP_LEVEL.has(entry.name)) || isPreservedName(entry.name)) continue;
      const rel = path.join(relative, entry.name);
      const target = path.join(installRoot, rel);
      if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error(`Refusing managed symlink: ${rel}`);
      if (entry.isDirectory()) {
        if (fs.existsSync(target) && !fs.statSync(target).isDirectory()) throw new Error(`Application path type conflict: ${rel}`);
        if (!fs.existsSync(target)) folders.push(rel);
        walk(path.join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        if (fs.existsSync(target) && !fs.statSync(target).isFile()) throw new Error(`Application path type conflict: ${rel}`);
        record(rel);
      }
    }
  }
  try {
    record("dist");
    record("VERSION");
    record("NODE_VERSION");
    const incomingMarker = path.join(incomingRoot, "NODE_VERSION");
    const currentMarker = path.join(installRoot, "NODE_VERSION");
    if (fs.existsSync(incomingMarker) && (!fs.existsSync(currentMarker) ||
        fs.readFileSync(incomingMarker, "utf8").trim() !== fs.readFileSync(currentMarker, "utf8").trim())) {
      record("node");
    }
    walk(incomingRoot);
    fs.writeFileSync(path.join(backup, "recovery-manifest.json"), JSON.stringify({ entries, folders }, null, 2));
    log(`Verified recovery snapshot ready: ${backup}`);
  } catch (error) {
    removePath(backup); // No install writes have occurred.
    throw error;
  }
  return {
    backup,
    restore() {
      if (process.env.APD_UPDATE_TEST_FAIL_RECOVERY === "1") throw new Error("Simulated recovery failure");
      for (const { relative, exists } of entries.slice().reverse()) {
        const target = path.join(installRoot, relative);
        if (exists) {
          // Preserve the verified backup even if restoring is interrupted.
          if (fs.existsSync(target) && fs.statSync(target).isDirectory()) removePath(target);
          copyVerified(path.join(backup, relative), target);
        } else {
          removePath(target);
        }
      }
      for (const relative of folders.reverse()) {
        const target = path.join(installRoot, relative);
        if (fs.existsSync(target) && fs.readdirSync(target).length === 0) fs.rmdirSync(target);
      }
      log("Full application recovery verified; previous files and version restored.");
    },
  };
}

function replaceInstall(incomingRoot, latestVersion) {
  if (!fs.existsSync(path.join(installRoot, "dist")) && fs.existsSync(path.join(installRoot, "dist.bak"))) {
    renameWithRetry(path.join(installRoot, "dist.bak"), path.join(installRoot, "dist"));
  }
  const snapshot = createRecoverySnapshot(incomingRoot);
  try {
    replaceInstallFiles(incomingRoot, latestVersion);
  } catch (error) {
    try {
      snapshot.restore();
    } catch (recoveryError) {
      error.recoveryUnsafe = true;
      log(`Automatic file recovery failed: ${recoveryError.message}. Recovery files retained at ${snapshot.backup}`);
    }
    if (!error.recoveryUnsafe) removePath(snapshot.backup);
    throw error;
  }
  try { removePath(snapshot.backup); }
  catch (error) { log(`WARN completed update left recovery files at ${snapshot.backup}: ${error.message}`); }
}

function replaceInstallFiles(incomingRoot, latestVersion) {
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
    renameWithRetry(currentDist, backupDist);
    backupCreated = true;
    if (process.env.APD_UPDATE_TEST_FAIL_AFTER_BACKUP === "1") {
      throw new Error("Simulated failure after backup");
    }
    renameWithRetry(newDist, currentDist);

    // v1.1.0: sync the whole incoming app root instead of hand-copying two
    // known files. This is what makes new shipped content (welcome-guide/,
    // README.txt, launcher/, ...) actually land during an upgrade. The two
    // files copied explicitly before v1.1.0 -- "Update AdvisePoint Docs.bat"
    // and packaging/updater/updater.cjs -- are covered by the walk, so the
    // self-update of the updater still happens exactly as it did.
    //
    // Placement matters: this runs INSIDE the try, after the dist swap, so any
    // failure here still hits the catch below and rolls dist back to dist.bak.
    syncAppRoot(incomingRoot);
    if (process.env.APD_UPDATE_TEST_FAIL_AFTER_SYNC === "1") throw new Error("Simulated failure after root sync");

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
      if (process.env.APD_UPDATE_TEST_FAIL_AFTER_NODE === "1") throw new Error("Simulated failure after runtime replacement");
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

async function launchApp() {
  if (process.platform !== "win32" || process.env.APD_UPDATE_NO_LAUNCH === "1") return;
  const launcher = path.join(installRoot, "Start AdvisePoint Docs.bat");
  const vbs = path.join(installRoot, "launcher", "run-hidden.vbs");

  // v1.0.9.22: strip APD_HIDDEN and APD_MIN from the spawn env. The prior
  // node process inherits these from the VBS/minimized wrapper that
  // launched IT, and passing them through to the .bat makes the .bat
  // skip its own VBS-bounce guard on line 29 -- which means the whole
  // relaunched process tree runs under a bare cmd->powershell chain
  // created by Node's spawn+windowsHide. That chain leaves a
  // taskbar-visible powershell.exe (proven in the v1.0.9.21 diagnostics
  // bundle: PID 35204 was the Tee-Object PowerShell). Clearing the
  // vars forces a fresh launch through the correct hidden path.
  const cleanEnv = { ...process.env };
  delete cleanEnv.APD_HIDDEN;
  delete cleanEnv.APD_MIN;

  // v1.0.12.1: tell the relaunched server directly that it is the
  // post-update boot, instead of relying solely on the `.updating`
  // sentinel file. server/index.ts honors APD_JUST_UPDATED=1 and appends a
  // cache-busting `?updated=<ts>` to the URL it opens, which is what forces
  // the browser into a fresh navigation rather than re-focusing the stale
  // tab left over from before the update. The sentinel remains as the
  // fallback for launches that don't come from here (e.g. the user starting
  // the app manually after an update), but a missing or already-consumed
  // sentinel can no longer cost us the cache-bust.
  cleanEnv.APD_JUST_UPDATED = "1";

  // Do not leak updater-only variables into the long-lived server process.
  // APD_LOCAL_ZIP in particular points at a temp file this updater is about
  // to delete, and APD_UPDATE_ASSUME_YES would suppress prompts in any
  // updater the new server later spawns from its own environment.
  delete cleanEnv.APD_LOCAL_ZIP;
  delete cleanEnv.APD_UPDATE_ASSUME_YES;
  delete cleanEnv.APD_UPDATE_NO_PROMPT;

  // v1.0.9.22: prefer launching through wscript+run-hidden.vbs when it
  // exists. VBS's WScript.Shell.Run(..., 0, false) creates the console
  // with SW_HIDE at kernel level, before any window is mapped -- Windows
  // never allocates a taskbar tile for the child. This is the same path
  // taken by the desktop shortcut on double-click, so the post-update
  // process tree matches the fresh-launch process tree exactly.
  //
  // Fall back to spawning the .bat under a hidden cmd if VBS is missing
  // (e.g. hand-copied install). That path is imperfect (see the reason
  // for the APD_HIDDEN strip above) but keeps the app launching.
  if (fs.existsSync(vbs)) {
    const child = spawn("wscript.exe", [vbs], {
      cwd: installRoot,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: cleanEnv,
    });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    return;
  }
  const child = spawn("cmd.exe", ["/c", launcher], {
    cwd: installRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: cleanEnv,
  });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
}

// v1.0.9: --local-zip <path>. Parse once here so downstream code doesn't need
// to re-scan argv. When set, the updater bypasses the GitHub API entirely and
// reads the zip from the given path. Everything else (shutdown handshake,
// atomic swap, sentinel handling) is unchanged.
//
// v1.2.3: --allow-same-version. The version guard below normally refuses any
// install where the incoming VERSION is <= the currently installed VERSION
// (downgrade OR same-version reinstall). This flag relaxes that check to
// only refuse a strict downgrade -- an equal-version reinstall is allowed.
// Downgrade remains forbidden even with this flag. Intended for developer
// reinstalls of a corrupted install and for QA reproducing a build without
// having to bump the version number.
function parseArgv(argv) {
  const out = { localZip: null, allowSameVersion: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--local-zip" && argv[i + 1]) {
      out.localZip = argv[i + 1];
      i++;
    } else if (argv[i] === "--allow-same-version") {
      out.allowSameVersion = true;
    }
  }
  return out;
}

async function performUpdate() {
  const args = parseArgv(process.argv);
  // v1.0.12.1: tracks whether we actually relaunched the app, so the
  // top-level handler knows who owns clearing the update sentinel.
  let launched = false;
  let shutdownRequested = false;
  let installationComplete = false;
  log("=== Update check started ===");
  log(`Install root: ${installRoot}`);
  if (args.localZip) log(`Local-zip mode: ${args.localZip}`);
  if (args.allowSameVersion) log("Same-version reinstall allowed (--allow-same-version)");
  if (await checkPort(5000)) {
    if (!(await identifyRunningApp())) {
      log("Port 5000 is in use by a process that is not AdvisePoint Docs.");
      console.log("The updater will not stop an unrelated server. Free port 5000, then run this updater again.");
      return 2;
    }
  }

  const currentVersion = readCurrentVersion();
  const installedArch = readInstalledArch();
  log(`Running version: v${currentVersion}`);
  log(`Installed architecture: ${installedArch}. Validating update before shutdown.`);

  // v1.0.9: local-zip path. Skip fetchLatestRelease entirely; read the zip
  // bytes from disk and jump into the same extract+swap flow. The server
  // endpoint that hands us the path has already validated the zip is an
  // AdvisePoint Docs release, so we still re-validate here (VERSION file,
  // no-downgrade, dist/index.cjs present via findPackageRoot) as defense in
  // depth.
  let archive;
  let sourceLabel;
  let expectedVersion = null;
  if (args.localZip) {
    if (!fs.existsSync(args.localZip)) {
      log(`Local zip not found: ${args.localZip}`);
      console.log(`The specified update zip could not be found: ${args.localZip}`);
      return 3;
    }
    try {
      archive = fs.readFileSync(args.localZip);
    } catch (error) {
      log(`Could not read local zip: ${error.message}`);
      console.log(`Could not read the specified update zip: ${error.message}`);
      return 3;
    }
    sourceLabel = args.localZip;
    log(`[updater] using local zip ${args.localZip} (skipping GitHub fetch)`);
    // v1.2.2: verify integrity BEFORE any staging or install writes. On
    // failure, print user-facing lines that explicitly steer the user to
    // redownload rather than retry against the same corrupt file.
    try {
      preflightLocalZip(archive, args.localZip);
    } catch (error) {
      log(`Update failed at preflight: ${error.message}`);
      if (error.userLines && Array.isArray(error.userLines)) {
        for (const line of error.userLines) console.log(line);
      } else {
        console.log("Update failed. Your existing installation was preserved.");
      }
      return 4;
    }
  } else {
    let latest;
    try {
      latest = await fetchLatestRelease(installedArch);
    } catch (error) {
      log(`Network/release check failed: ${error.message}`);
      console.log(error.message);
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
    try {
      log(`Downloading ${latest.assetUrl}`);
      archive = await requestBuffer(latest.assetUrl);
    } catch (error) {
      log(`Download failed: ${error.message}`);
      console.log("Update failed. Your existing installation was preserved.");
      return 4;
    }
    sourceLabel = latest.assetUrl;
    const actualHash = crypto.createHash("sha256").update(archive).digest("hex");
    log(`Downloaded bytes=${archive.length} sha256=${actualHash}`);
    if (archive.length !== latest.assetSize) {
      log(`Update failed: Download size mismatch: expected ${latest.assetSize}, received ${archive.length}`);
      console.log("Update failed. Your existing installation was preserved.");
      return 4;
    }
    if (latest.sha256 && actualHash !== latest.sha256) {
      log(`Update failed: SHA-256 mismatch: expected ${latest.sha256}, received ${actualHash}`);
      console.log("Update failed. Your existing installation was preserved.");
      return 4;
    }
    expectedVersion = latest.version;
  }

  const tempBase = process.env.TEMP || os.tmpdir();
  fs.mkdirSync(tempBase, { recursive: true });
  const stagingRoot = fs.mkdtempSync(path.join(tempBase, "apd-update-"));
  const zipPath = `${stagingRoot}.zip`;

  try {
    if (!args.localZip) {
      // Only write the temp zip for the online path; the local-zip path
      // already has the file on disk at args.localZip.
      fs.writeFileSync(zipPath, archive);
    }
    log(`Extracting to ${stagingRoot} (source: ${sourceLabel})`);
    extractZip(archive, stagingRoot);
    const incomingRoot = findPackageRoot(stagingRoot);
    const incomingVersionPath = path.join(incomingRoot, "VERSION");
    if (!fs.existsSync(incomingVersionPath)) throw new Error("Incoming VERSION marker is missing");
    const incomingVersion = fs.readFileSync(incomingVersionPath, "utf8").trim();
    // v1.2.3: default is refuse-if-<=, so an equal-version reinstall is
    // blocked alongside a downgrade. --allow-same-version relaxes this to
    // refuse-if-< only, so "reinstall the exact same version" (developer
    // repair, QA reproduction) is permitted while downgrade stays blocked.
    const versionCmp = compareVersions(incomingVersion, currentVersion);
    if (versionCmp < 0) {
      throw new Error(`Refusing downgrade: v${incomingVersion} is older than installed v${currentVersion}`);
    }
    if (versionCmp === 0 && !args.allowSameVersion) {
      throw new Error(
        `Refusing same-version install: v${incomingVersion} is already installed. ` +
          `Pass --allow-same-version if this is intentional (developer repair or QA reproduction).`,
      );
    }
    if (versionCmp === 0) {
      log(`Same-version reinstall of v${incomingVersion} proceeding (--allow-same-version).`);
    }
    if (expectedVersion && compareVersions(incomingVersion, expectedVersion) !== 0) {
      throw new Error(`Release tag v${expectedVersion} does not match package v${incomingVersion}`);
    }

    // v1.2.0: ARCH match gate. AdvisePoint Docs ships a single-arch zip per
    // build (x64 or arm64). Overlaying an x64 zip onto an arm64 install --
    // or vice versa -- would leave a mixed-arch install (arm64 node.exe
    // trying to load an x64 better_sqlite3.node, or worse) with no clean
    // recovery. Fail fast, before dist/ is touched. Missing ARCH on the
    // installed side is treated as "x64" for backward compatibility with
    // pre-v1.2.0 installs, which were always x64. Missing ARCH on the
    // incoming zip is a hard refusal: v1.2.0 and up always write it.
    const incomingArchPath = path.join(incomingRoot, "ARCH");
    if (!fs.existsSync(incomingArchPath)) {
      throw new Error(
        "Incoming build is missing the ARCH sentinel. Refusing an upgrade whose " +
          "architecture cannot be verified. Reinstall AdvisePoint Docs by extracting " +
          "the zip that matches your machine directly, rather than upgrading.",
      );
    }
    const incomingArch = fs.readFileSync(incomingArchPath, "utf8").trim().toLowerCase();
    if (incomingArch !== installedArch) {
      throw new Error(
        `Refusing cross-architecture upgrade: installed is ${installedArch}, ` +
          `incoming is ${incomingArch}. Download the ${installedArch} zip, ` +
          `or back up your data and reinstall by extracting the ${incomingArch} ` +
          `zip into a fresh folder.`,
      );
    }

    // All download, integrity, version and architecture gates have passed.
    // Re-check identity now: the process on this port may have changed while
    // downloading. Never stop a service merely because it uses port 5000.
    log("Package validation complete; existing application has not been stopped.");
    if (await checkPort(5000)) {
      if (!(await identifyRunningApp())) throw new Error("Port 5000 belongs to an unrelated server; no files changed.");
      if (!(await ask("Package verified. Shut down AdvisePoint Docs and install now? (Y/N) "))) {
        log("Update cancelled; the running background server was left unchanged.");
        return 2;
      }
      writeUpdateSentinel();
      shutdownRequested = true;
      writeStatus("installing", "Package verified. Restarting the application to install.");
      log("Requesting a clean shutdown from AdvisePoint Docs.");
      await requestServerShutdown();
      if (!(await waitForPortRelease())) throw new Error("The background server did not stop in time. No application files were replaced.");
      log("Background server stopped.");
    }

    // v1.0.12: last gate before we touch dist/. Port 5000 being free does
    // not prove the old server is gone, and a survivor pins the install
    // folder. Abort here, with dist/ untouched, rather than half-applying.
    if (!(await ensureNoStaleInstance())) {
      throw new Error(
        "A previous AdvisePoint Docs process is still holding the installation folder. " +
          "No files were changed. Close AdvisePoint Docs (or restart Windows) and run this updater again.",
      );
    }

    log("Replacing application files.");
    replaceInstall(incomingRoot, incomingVersion);
    installationComplete = true;
    log(`Update complete: v${currentVersion} -> v${incomingVersion}`);

    // v1.0.12.1: relaunch BEFORE the staging cleanup in the finally block.
    // That cleanup deletes a ~57 MB extracted tree plus the uploaded zip,
    // which on a real disk delays the relaunch by many seconds. In the
    // v1.0.12.0 field test the app did not come back until 48 seconds after
    // the swap finished -- long enough that the drag-and-drop update looked
    // like it had simply stopped, and the user started the app by hand. The
    // temp files are the updater's own and are equally safe to remove after
    // the new server is up.
    if (await ask("Update complete. Launch AdvisePoint Docs now? (Y/N) ")) {
      if (process.platform !== "win32" || process.env.APD_UPDATE_NO_LAUNCH === "1") {
        log("Relaunch skipped on this test/non-Windows host.");
        return { code: 0, launched: false };
      }
      log("Relaunching AdvisePoint Docs.");
      await launchApp();
      launched = true;
      if (await waitForPortInUse()) {
        log("Relaunched server is listening on port 5000.");
      } else {
        // Not fatal: the update itself succeeded and the launcher may still
        // be starting. Logging it makes a silent failure to come back
        // diagnosable instead of invisible.
        log("WARN relaunched server was not listening within 45 s; start the app manually if it did not appear.");
        lastFailure = "Update installed, but application health could not be verified after restart. Start AdvisePoint Docs manually and check update.log.";
        return { code: 4, launched };
      }
    } else {
      log("Relaunch declined; leaving AdvisePoint Docs closed.");
    }
  } catch (error) {
    log(`Update failed: ${error.stack || error.message}`);
    console.log(installationComplete ? "The update was installed, but relaunch failed. Start AdvisePoint Docs manually." : error.recoveryUnsafe
      ? "Update failed and automatic recovery was incomplete. Do not delete the recovery folder; see update.log."
      : "Update failed. Your existing installation was preserved.");
    // v1.0.12: surface the reason on screen. The stale-instance abort is
    // user-actionable ("close the app / restart Windows") and was previously
    // only visible by opening update.log.
    if (error && error.message) console.log(error.message);
    if (shutdownRequested && !error.recoveryUnsafe && !installationComplete) {
      try {
        launched = await recoverStoppedApp();
      } catch (recoveryError) {
        log(`Recovery launch failed: ${recoveryError.message}. Start AdvisePoint Docs manually.`);
      }
    }
    lastFailure = installationComplete
      ? "Update installed, but automatic restart failed. Start AdvisePoint Docs manually."
      : error.recoveryUnsafe
        ? "Update failed and recovery was incomplete. Do not delete recovery files. See update.log for the recovery folder."
        : `${error.message} ${shutdownRequested ? (launched ? "The previous application was restarted." : "Start AdvisePoint Docs manually if it is not running.") : "No application files were replaced."}`;
    return { code: 4, launched };
  } finally {
    try { removePath(zipPath); removePath(stagingRoot); }
    catch (error) { log(`WARN staging cleanup deferred: ${error.message}`); }
    // v1.0.9: local-zip mode cleans up the user-supplied temp file too. The
    // server dropped it in tempBase; it's safe to remove after either
    // success or failure.
    // Delete only app-owned upload staging, never a ZIP supplied by the user.
    if (args.localZip && path.basename(path.dirname(path.resolve(args.localZip))).startsWith("apd-local-zip-") &&
        path.dirname(path.dirname(path.resolve(args.localZip))) === path.resolve(os.tmpdir())) {
      try { removePath(path.dirname(path.resolve(args.localZip))); }
      catch (error) { log(`WARN upload cleanup deferred: ${error.message}`); }
    }
  }

  // v1.0.11.4: report launched=true so the top-level handler knows to
  // LEAVE the sentinel in place. The freshly-spawned server reads it at
  // boot to decide whether to open the browser with a cache-busting URL
  // (avoiding Chrome's "focus existing tab" behavior), and clears it
  // itself once consumed. If we cleared it here, the new server would
  // usually miss it because spawn+unref returns in ms while the .bat
  // needs seconds to reach listen().
  //
  // v1.0.12.1: `launched` is now the real outcome rather than a hardcoded
  // true. When the relaunch was declined or skipped, nothing will ever
  // consume the sentinel, so the top-level handler must clear it -- a
  // leftover sentinel makes the NEXT ordinary launch think it is a
  // post-update boot.
  return { code: 0, launched };
}

async function recoverStoppedApp(deps = {}) {
  const portBusy = deps.portBusy || (() => checkPort(5000));
  const identify = deps.identify || identifyRunningApp;
  const launch = deps.launch || launchApp;
  const waitHealthy = deps.waitHealthy || waitForPortInUse;
  if (await portBusy()) {
    log(await identify() ? "Application is still running; no duplicate recovery launch." :
      "Recovery not launched: port 5000 is occupied by another service.");
    return false;
  }
  log("Restarting the preserved application after the failed update.");
  await launch();
  if (await waitHealthy()) {
    log("Preserved application is healthy again.");
    return true;
  }
  log("Recovery launch could not be verified. Start AdvisePoint Docs manually; see update.log.");
  return false;
}

let statusStartedAt;
let lastFailure = "";
function writeStatus(phase, message) {
  const file = path.join(logDir, "update-status.json");
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify({ phase, message, startedAt: statusStartedAt, updatedAt: Date.now() }));
    fs.renameSync(temp, file);
  } catch (error) {
    console.error(`Could not record updater status: ${error.message}`);
  }
}

async function main() {
  // One updater per install. A stale lock can be replaced only when its PID
  // is demonstrably gone; an unknown/permission-denied owner is never killed.
  const lock = path.join(installRoot, ".update-lock");
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid update lock; inspect .update-lock before retrying.");
    try {
      process.kill(pid, 0);
      throw new Error("Another update is already running.");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    fs.unlinkSync(lock);
  }
  fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
  statusStartedAt = Date.now();
  writeStatus("preparing", "Downloading and validating the package. The application stays available until checks pass.");
  try {
    const result = await performUpdate();
    const code = typeof result === "number" ? result : result.code;
    writeStatus(code === 0 ? "complete" : "failed", code === 0
      ? "Update check completed." : (lastFailure || "Update did not complete. The updater log contains the details."));
    return result;
  } catch (error) {
    writeStatus("failed", error.message);
    throw error;
  } finally {
    try { fs.unlinkSync(lock); }
    catch (error) { log(`WARN update lock cleanup failed: ${error.message}`); }
  }
}

if (require.main === module) {
  main().then(
    (result) => {
      // Back-compat: result may be a bare number (failure paths) or the
      // new { code, launched } shape. When launched===true, the new
      // server takes ownership of clearing the sentinel.
      const code = typeof result === "number" ? result : result?.code ?? 0;
      const launched = typeof result === "number" ? false : !!result?.launched;
      if (!launched) clearUpdateSentinel();
      process.exitCode = code;
    },
    (error) => {
      clearUpdateSentinel();
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
  findStaleInstallProcesses,
  ensureNoStaleInstance,
  // v1.0.12.1: exported so the asset-name matching that broke every
  // GitHub-hosted upgrade from v1.0.11 onward can be regression-tested
  // without performing a real update.
  fetchLatestRelease,
  selectReleaseAsset,
  readInstalledArch,
  recoverStoppedApp,
  renameWithRetry,
  // v1.1.0: exported so the app-root sync that fixes the dropped
  // welcome-guide/ folder can be unit-tested (new-file and new-folder cases)
  // without performing a real update.
  syncAppRoot,
  isPreservedName,
  // v1.2.2: exported so the local-zip preflight can be regression-tested
  // (healthy zip with/without companion, corrupt zip with wrong hash,
  // corrupt zip caught by walk-and-verify) without performing a real update.
  preflightLocalZip,
  readCompanionSha256,
};
