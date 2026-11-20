"use strict";
// AdvisePoint Docs launcher helper (v1.3.6).
//
// Run by "Start AdvisePoint Docs.bat" with the bundled node.exe, before it
// starts the server. Replaces the old "force-close anything listening on
// :5000" step, which closed a healthy server, produced two "exited with
// error code 1" windows (field report 2026-11-18) and could also match
// unrelated ports such as 50000-50009.
//
//   node relaunch.cjs --prepare
//     Exit 0   a healthy AdvisePoint Docs of this version already answers on
//              the port: the launcher opens the browser and exits.
//     Exit 10  the port is free (or was freed): the launcher starts the server.
//     Exit 20  the server cannot be started; the reason is written to
//              launch-failure.txt for the launcher's single failure window.
//
//   node relaunch.cjs --consume-replaced <launcher-start-ms>
//     Exit 0   this launcher's server was replaced by a newer launch after
//              <launcher-start-ms>: stay quiet (no crash window).
//     Exit 1   no such replacement: show the normal crash window.
//
// Order of escalation for a server that is running but must be replaced:
// confirmed Stop route -> wait for exit -> (restore pending only) updater
// shutdown route -> force-close ONLY a node.exe whose path is this install's
// node\node.exe and that listens on exactly the app port. Every stop is
// logged with PID and reason in launcher.log.

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const { execFileSync } = require("node:child_process");

const EXIT_REUSE = 0;
const EXIT_START = 10;
const EXIT_FAIL = 20;
const REPLACED_NAME = ".replaced";
const FAILURE_NAME = "launch-failure.txt";
const LOG_NAME = "launcher.log";
const LOG_MAX_BYTES = 512 * 1024;
const REPLACED_MAX_AGE_MS = 10 * 60 * 1000;

function defaultContext() {
  const appRoot = path.resolve(__dirname, "..");
  const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA || appRoot;
  const logDir = process.env.APD_LOG_DIR || path.join(localAppData, "AdvisePoint Docs");
  let version = "";
  try { version = fs.readFileSync(path.join(appRoot, "VERSION"), "utf8").trim(); } catch { /* dev layout */ }
  return {
    appRoot,
    logDir,
    port: parseInt(process.env.PORT || "5000", 10),
    version,
    nodeExe: path.join(appRoot, "node", "node.exe"),
    serverLog: path.join(logDir, "server.log"),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    platform: process.platform,
  };
}

// ---------------------------------------------------------------- logging
function makeLogger(ctx) {
  const file = path.join(ctx.logDir, LOG_NAME);
  return (message) => {
    const line = `${new Date(ctx.now()).toISOString()} [launcher pid=${process.pid}] ${message}\r\n`;
    try {
      fs.mkdirSync(ctx.logDir, { recursive: true });
      try {
        if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`);
      } catch { /* no log yet */ }
      fs.appendFileSync(file, line);
    } catch { /* logging is best-effort */ }
  };
}

// ---------------------------------------------------------------- network
function request(ctx, method, pathname, { headers = {}, body, timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: "127.0.0.1",
      port: ctx.port,
      path: pathname,
      method,
      agent: false,
      headers: {
        Accept: "application/json",
        "User-Agent": "AdvisePoint-Docs-Launcher",
        ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > 64 * 1024) { req.destroy(); return; }
        chunks.push(c);
      });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not JSON */ }
        resolve({ status: res.statusCode || 0, body: json });
      });
      res.on("error", () => resolve({ status: 0, error: "ERESPONSE" }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", (err) => resolve({ status: 0, error: err.code || "EUNKNOWN" }));
    if (payload) req.write(payload);
    req.end();
  });
}

function portInUse(ctx, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: ctx.port });
    let done = false;
    const finish = (v) => { if (!done) { done = true; socket.destroy(); resolve(v); } };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    // A timeout means something holds the port but is not accepting:
    // treat it as in use so we never start a second server on top of it.
    socket.once("timeout", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** Probe /api/health. Returns { kind: "healthy"|"other-version"|"restart-required"|"foreign"|"unresponsive", body } */
async function probe(ctx, attempts = 2) {
  let last = { kind: "unresponsive", body: null, detail: "" };
  for (let i = 0; i < attempts; i++) {
    const r = await request(ctx, "GET", "/api/health", { timeoutMs: 3000 });
    if (r.status === 200 && r.body && r.body.app === "advisepoint-docs") {
      if (r.body.restart_required) return { kind: "restart-required", body: r.body };
      if (ctx.version && r.body.version && r.body.version !== ctx.version) return { kind: "other-version", body: r.body };
      return { kind: "healthy", body: r.body };
    }
    if (r.status > 0) last = { kind: "foreign", body: r.body, detail: `HTTP ${r.status}` };
    else last = { kind: "unresponsive", body: null, detail: r.error };
    if (i + 1 < attempts) await ctx.sleep(1000);
  }
  return last;
}

async function waitFor(ctx, predicate, timeoutMs, stepMs = 250) {
  const deadline = ctx.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (ctx.now() >= deadline) return false;
    await ctx.sleep(stepMs);
  }
}

// ------------------------------------------------------- Windows processes
/** Parse `netstat -ano -p tcp` output: PIDs listening on EXACTLY :port.
 *  Language-neutral: a listening row has a zero foreign address, so the
 *  localized state word ("LISTENING") is not needed. */
function parseNetstatListeners(output, port) {
  const pids = new Set();
  for (const raw of String(output).split(/\r?\n/)) {
    const cols = raw.trim().split(/\s+/);
    if (cols.length < 4 || !/^TCP/i.test(cols[0])) continue;
    const local = cols[1];
    const foreign = cols[2];
    const pid = Number(cols[cols.length - 1]);
    const localPort = local.slice(local.lastIndexOf(":") + 1);
    const foreignPort = foreign.slice(foreign.lastIndexOf(":") + 1);
    if (localPort !== String(port)) continue;
    if (foreignPort !== "0") continue;
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

function windowsTools(ctx) {
  return {
    listeners() {
      const out = execFileSync("netstat.exe", ["-ano", "-p", "tcp"], { encoding: "utf8", timeout: 15000, windowsHide: true });
      const out6 = (() => {
        try { return execFileSync("netstat.exe", ["-ano", "-p", "tcpv6"], { encoding: "utf8", timeout: 15000, windowsHide: true }); }
        catch { return ""; }
      })();
      return [...new Set([...parseNetstatListeners(out, ctx.port), ...parseNetstatListeners(out6, ctx.port)])];
    },
    imagePath(pid) {
      const script = `(Get-CimInstance Win32_Process -Filter \"ProcessId=${Number(pid)}\").ExecutablePath`;
      return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", timeout: 15000, windowsHide: true }).trim();
    },
    forceClose(pid) {
      // No /T: only the server process, never its launcher or siblings.
      execFileSync("taskkill.exe", ["/PID", String(Number(pid)), "/F"], { encoding: "utf8", timeout: 15000, windowsHide: true });
    },
    alive(pid) {
      try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
    },
  };
}

function samePath(a, b) {
  return path.resolve(String(a || "")).toLowerCase() === path.resolve(String(b || "")).toLowerCase();
}

// ---------------------------------------------------------------- files
function writeReplaced(ctx, info) {
  try {
    fs.mkdirSync(ctx.logDir, { recursive: true });
    fs.writeFileSync(path.join(ctx.logDir, REPLACED_NAME), JSON.stringify({ ...info, at: ctx.now() }));
  } catch { /* best-effort */ }
}
function removeFile(ctx, name) {
  try { fs.rmSync(path.join(ctx.logDir, name), { force: true }); } catch { /* ignore */ }
}
function writeFailure(ctx, lines) {
  try {
    fs.mkdirSync(ctx.logDir, { recursive: true });
    fs.writeFileSync(path.join(ctx.logDir, FAILURE_NAME), lines.join("\r\n") + "\r\n");
  } catch { /* ignore */ }
}
function logReleased(ctx) {
  if (!fs.existsSync(ctx.serverLog)) return true;
  try {
    const fd = fs.openSync(ctx.serverLog, "a");
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- prepare
async function prepare(ctx = defaultContext(), tools = null) {
  const log = makeLogger(ctx);
  tools = tools || windowsTools(ctx);
  removeFile(ctx, FAILURE_NAME);

  if (!(await portInUse(ctx))) {
    // Nothing to replace. A leftover sentinel from an earlier replacement
    // must not silence a future real crash.
    removeFile(ctx, REPLACED_NAME);
    log(`port ${ctx.port} free; starting server`);
    return EXIT_START;
  }

  const state = await probe(ctx);
  if (state.kind === "healthy") {
    log(`existing server healthy (version ${state.body.version}); reusing it`);
    return EXIT_REUSE;
  }

  let oldPids = [];
  try { oldPids = tools.listeners(); } catch (e) { log(`listener lookup failed: ${e.message}`); }
  const reason = {
    "other-version": `a different version (${state.body && state.body.version}) is running`,
    "restart-required": "a restore finished and the server must restart",
    foreign: `port ${ctx.port} answers but is not a healthy AdvisePoint Docs (${state.detail})`,
    unresponsive: `server on port ${ctx.port} is not responding (${state.detail})`,
  }[state.kind];
  log(`replacing server: ${reason}; listener pid(s)=${oldPids.join(",") || "unknown"}`);

  // Only AdvisePoint processes are ever asked or forced to stop.
  const ours = [];
  const others = [];
  for (const pid of oldPids) {
    let image = "";
    try { image = tools.imagePath(pid); } catch (e) { log(`path lookup failed for pid=${pid}: ${e.message}`); }
    (samePath(image, ctx.nodeExe) ? ours : others).push({ pid, image: image || "(unknown)" });
  }
  const isAdvisePoint = state.kind !== "foreign" && state.kind !== "unresponsive";
  if (!isAdvisePoint && ours.length === 0) {
    const who = others.map((o) => `${o.image} (PID ${o.pid})`).join(", ") || "an unidentified program";
    log(`not stopping: port ${ctx.port} is held by ${who}`);
    writeFailure(ctx, [
      "AdvisePoint Docs could not start.",
      "",
      `Port ${ctx.port} is already in use by another program: ${who}.`,
      "AdvisePoint Docs did not close it. Close that program, then start AdvisePoint Docs again.",
    ]);
    return EXIT_FAIL;
  }

  writeReplaced(ctx, { pids: oldPids, reason });

  // 1. Confirmed Stop route (the same request the in-app Stop button sends).
  const stop = await request(ctx, "POST", "/api/system/stop", {
    headers: { Origin: `http://127.0.0.1:${ctx.port}`, "x-apd-stop": "1" },
    body: { confirm: true },
    timeoutMs: 4000,
  });
  log(`stop request: ${stop.status ? `HTTP ${stop.status}` : stop.error}`);

  if (stop.status === 409 && state.kind === "restart-required") {
    // The database is deliberately closed after a restore, which the Stop
    // route reports as busy. The updater shutdown route is the established
    // clean exit for this state (it is what the in-app updater uses).
    const s2 = await request(ctx, "POST", "/api/updater/shutdown", { headers: { "X-APD-Updater": "1" }, timeoutMs: 4000 });
    log(`restore restart shutdown request: ${s2.status ? `HTTP ${s2.status}` : s2.error}`);
  } else if (stop.status === 409) {
    removeFile(ctx, REPLACED_NAME);
    log("not stopping: the running server reports active work");
    writeFailure(ctx, [
      "AdvisePoint Docs could not start.",
      "",
      `Another copy of AdvisePoint Docs (version ${(state.body && state.body.version) || "unknown"}) is running and still has work in progress`,
      "(for example an upload, backup, print or update). It was not stopped, so nothing is lost.",
      `Open http://127.0.0.1:${ctx.port}/ to finish or stop that work, then start AdvisePoint Docs again.`,
    ]);
    return EXIT_FAIL;
  }

  // 2. Wait for a clean exit.
  let released = await waitFor(ctx, async () => !(await portInUse(ctx)), 20000);
  if (released) log(`port ${ctx.port} released after clean stop`);

  // 3. Last resort: force-close only this install's node.exe on exact :port.
  if (!released) {
    if (ours.length === 0) {
      const who = others.map((o) => `${o.image} (PID ${o.pid})`).join(", ") || "an unidentified program";
      log(`not force-closing: no listener matches ${ctx.nodeExe}; held by ${who}`);
      removeFile(ctx, REPLACED_NAME);
      writeFailure(ctx, [
        "AdvisePoint Docs could not start.",
        "",
        `Port ${ctx.port} is still in use by ${who}, which is not this copy of AdvisePoint Docs.`,
        "It was not closed. Close it (or restart Windows), then start AdvisePoint Docs again.",
      ]);
      return EXIT_FAIL;
    }
    for (const { pid } of ours) {
      log(`force-closing pid=${pid} image=${ctx.nodeExe}; reason: did not exit after stop request (${reason})`);
      try { tools.forceClose(pid); } catch (e) { log(`force-close failed for pid=${pid}: ${e.message}`); }
    }
    released = await waitFor(ctx, async () => !(await portInUse(ctx)), 15000);
    if (!released) {
      writeFailure(ctx, [
        "AdvisePoint Docs could not start.",
        "",
        `The previous AdvisePoint Docs server (PID ${ours.map((o) => o.pid).join(", ")}) did not release port ${ctx.port}.`,
        "Restart Windows, then start AdvisePoint Docs again.",
      ]);
      return EXIT_FAIL;
    }
    log(`port ${ctx.port} released after force-close`);
  }

  // 4. The old process and its log handle must be gone before the launcher
  //    rotates server.log and redirects the new server into it.
  await waitFor(ctx, () => oldPids.every((pid) => !tools.alive(pid)), 10000);
  const logFree = await waitFor(ctx, () => logReleased(ctx), 10000);
  if (!logFree) {
    log("server.log still in use after the previous server stopped");
    writeFailure(ctx, [
      "AdvisePoint Docs could not start.",
      "",
      `The log file is still in use by another process: ${ctx.serverLog}`,
      "Wait a few seconds, then start AdvisePoint Docs again. If it keeps happening, restart Windows.",
    ]);
    return EXIT_FAIL;
  }
  log("previous server replaced; starting server");
  return EXIT_START;
}

// ------------------------------------------------------- consume-replaced
function consumeReplaced(ctx = defaultContext(), sinceMs = 0) {
  const file = path.join(ctx.logDir, REPLACED_NAME);
  let info = null;
  try { info = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return 1; }
  const at = Number(info && info.at) || 0;
  const fresh = ctx.now() - at <= REPLACED_MAX_AGE_MS;
  // Only a replacement that happened while THIS launcher's server was
  // running counts; anything older is stale and must not hide a crash.
  if (fresh && at >= Number(sinceMs || 0)) {
    removeFile(ctx, REPLACED_NAME);
    makeLogger(ctx)(`previous launcher: server was replaced by a newer launch (${info.reason || "no reason recorded"}); no crash window`);
    return 0;
  }
  if (!fresh) removeFile(ctx, REPLACED_NAME);
  return 1;
}

module.exports = {
  prepare, consumeReplaced, parseNetstatListeners, probe, defaultContext,
  EXIT_REUSE, EXIT_START, EXIT_FAIL, REPLACED_NAME, FAILURE_NAME, LOG_NAME,
};

if (require.main === module) {
  const [mode, arg] = process.argv.slice(2);
  if (mode === "--prepare") {
    prepare().then((code) => process.exit(code), (err) => {
      makeLogger(defaultContext())(`helper error: ${err && err.stack ? err.stack : err}`);
      // Never block a launch on a helper defect: fall back to starting.
      process.exit(EXIT_START);
    });
  } else if (mode === "--consume-replaced") {
    process.exit(consumeReplaced(defaultContext(), Number(arg) || 0));
  } else if (mode === "--now") {
    process.stdout.write(String(Date.now()));
  } else {
    process.stderr.write("usage: relaunch.cjs --prepare | --consume-replaced <ms> | --now\n");
    process.exit(2);
  }
}
