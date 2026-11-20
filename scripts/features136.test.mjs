// v1.3.6 unit tests: cross-site guard decisions, document tag management,
// the post-resume listener self-check, and the launcher relaunch helper.
//
// Everything runs on disposable data: a throwaway sqlite database in the OS
// temp folder, throwaway log folders, and local test servers on random ports
// (never 5000, 5100 or 5101). Windows-only process tools used by the launcher
// helper (netstat, PowerShell, taskkill) are replaced by test doubles.
//
// Run: npm run test:features136
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const require = createRequire(import.meta.url);
const PROTECTED_PORTS = new Set([5000, 5100, 5101]);

const dir = mkdtempSync(join(tmpdir(), "apd-features136-"));
process.env.RAG_DB_PATH = join(dir, "test.db");
process.env.RAG_PAGES_DIR = join(dir, "pages");

const { crossSiteRefusal } = await import("../server/request-guard.ts");
const { storage, parseTagList } = await import("../server/storage.ts");
const { SEED_WELCOME_GUIDE_DOC_ID } = await import("../server/seed-welcome-guide.ts");
const resume = await import("../server/resume-check.ts");
const relaunch = require("../packaging/launcher/relaunch.cjs");

test.after(() => rmSync(dir, { recursive: true, force: true }));

// ------------------------------------------------------------ guard
const base = { method: "POST", path: "/api/query-history", host: "127.0.0.1:5000", localPort: 5000 };

test("guard: same-origin app write is allowed", () => {
  assert.equal(crossSiteRefusal({ ...base, origin: "http://127.0.0.1:5000", secFetchSite: "same-origin" }), null);
  assert.equal(crossSiteRefusal({ ...base, host: "localhost:5000", origin: "http://localhost:5000" }), null);
});

test("guard: requests without Origin (updater, launcher, tools) are allowed", () => {
  assert.equal(crossSiteRefusal({ ...base, origin: undefined, secFetchSite: undefined }), null);
});

test("guard: reads are never refused", () => {
  for (const method of ["GET", "HEAD", "OPTIONS"])
    assert.equal(crossSiteRefusal({ ...base, method, origin: "https://evil.example", secFetchSite: "cross-site" }), null);
});

test("guard: cross-site form, multipart and text/plain posts are refused", () => {
  assert.equal(crossSiteRefusal({ ...base, origin: "https://evil.example" }), "origin-mismatch");
  assert.equal(crossSiteRefusal({ ...base, origin: "https://evil.example", secFetchSite: "cross-site" }), "sec-fetch-site");
  assert.equal(crossSiteRefusal({ ...base, origin: "http://127.0.0.1:5000", secFetchSite: "same-site" }), "sec-fetch-site");
  assert.equal(crossSiteRefusal({ ...base, origin: "null" }), "origin-null");
  assert.equal(crossSiteRefusal({ ...base, origin: "http://127.0.0.1:5100" }), "origin-mismatch");
  assert.equal(crossSiteRefusal({ ...base, origin: "https://127.0.0.1:5000" }), "origin-mismatch");
  for (const method of ["PUT", "PATCH", "DELETE"])
    assert.equal(crossSiteRefusal({ ...base, method, origin: "https://evil.example" }), "origin-mismatch");
});

test("guard: DNS-rebinding and odd Host headers are refused", () => {
  assert.equal(crossSiteRefusal({ ...base, host: "evil.example:5000", origin: "http://evil.example:5000" }), "host-not-local");
  assert.equal(crossSiteRefusal({ ...base, host: "evil.example:5000" }), "host-not-local");
  assert.equal(crossSiteRefusal({ ...base, host: "127.0.0.1:5001" }), "host-port-mismatch");
  assert.equal(crossSiteRefusal({ ...base, host: "user@127.0.0.1:5000" }), "host-invalid");
  assert.equal(crossSiteRefusal({ ...base, host: undefined }), "host-invalid");
  assert.equal(crossSiteRefusal({ ...base, host: "127.0.0.1:5000/x" }), "host-invalid");
});

test("guard: upper-case /API paths are covered (Express routes ignore case)", () => {
  assert.equal(crossSiteRefusal({ ...base, path: "/API/query-history", origin: "https://evil.example" }), "origin-mismatch");
});

test("guard: non-API paths are left to the static server", () => {
  assert.equal(crossSiteRefusal({ ...base, path: "/index.html", origin: "https://evil.example" }), null);
});

test("guard: opt-in LAN bind relaxes only the host-name rule", () => {
  const lan = { ...base, host: "192.168.1.20:5000", nonLoopbackBind: true };
  assert.equal(crossSiteRefusal({ ...lan, origin: "http://192.168.1.20:5000" }), null);
  assert.equal(crossSiteRefusal({ ...lan, origin: "https://evil.example" }), "origin-mismatch");
  assert.equal(crossSiteRefusal({ ...lan, secFetchSite: "cross-site" }), "sec-fetch-site");
});

// ------------------------------------------------------------ tags
let seq = 0;
function makeDoc(tags, overrides = {}) {
  const id = overrides.id ?? `tagdoc-${++seq}`;
  const now = new Date().toISOString();
  storage.createDocument({
    id,
    title: `Doc ${id}`,
    document_type: "user_manual",
    product_family: "Nova",
    product_model: "X100",
    file_name: `${id}.pdf`,
    ingested_at: now,
    updated_at: now,
    tags_json: JSON.stringify(tags),
    ...overrides,
  });
  return id;
}
function tagsOf(id) {
  return JSON.parse(storage.getDocument(id).tags_json);
}
function snapshotOtherFields(id) {
  const { tags_json, ...rest } = storage.getDocument(id);
  return rest;
}
function tagCount(value) {
  return storage.listTagValues().find((t) => t.value === value)?.count ?? 0;
}

test("tags: list counts documents per tag, most used first, case-sensitive", () => {
  makeDoc(["Alpha1", "Beta1"]);
  makeDoc(["Alpha1"]);
  makeDoc(["alpha1", "Alpha1", "Alpha1"]); // duplicate on one doc counts once
  const list = storage.listTagValues().filter((t) => /alpha1|beta1/i.test(t.value));
  assert.deepEqual(list, [
    { value: "Alpha1", count: 3 },
    { value: "alpha1", count: 1 },
    { value: "Beta1", count: 1 },
  ]);
});

test("tags: the seeded Welcome Guide is neither listed nor changed", () => {
  makeDoc(["GuideOnly"], { id: SEED_WELCOME_GUIDE_DOC_ID });
  assert.equal(tagCount("GuideOnly"), 0);
  assert.equal(storage.renameTag("GuideOnly", "Renamed"), 0);
  assert.equal(storage.deleteTag("GuideOnly"), 0);
  assert.deepEqual(tagsOf(SEED_WELCOME_GUIDE_DOC_ID), ["GuideOnly"]);
});

test("tags: rename changes every carrying document once and nothing else", () => {
  const a = makeDoc(["Toner2", "Drum2"]);
  const b = makeDoc(["Drum2", "Toner2"]);
  const c = makeDoc(["Other2"]);
  const beforeA = snapshotOtherFields(a);
  const beforeC = storage.getDocument(c);
  assert.equal(storage.renameTag("Toner2", "Toner cartridge"), 2);
  assert.deepEqual(tagsOf(a), ["Toner cartridge", "Drum2"]);
  assert.deepEqual(tagsOf(b), ["Drum2", "Toner cartridge"]);
  assert.deepEqual(snapshotOtherFields(a), beforeA, "no other document field changes");
  assert.deepEqual(storage.getDocument(c), beforeC, "unrelated documents are untouched");
  assert.equal(tagCount("Toner2"), 0);
  assert.equal(tagCount("Toner cartridge"), 2);
});

test("tags: merge leaves no duplicate on documents carrying both", () => {
  const both = makeDoc(["Fuser3", "fuser3", "Paper3"]);
  const onlyLower = makeDoc(["fuser3"]);
  const onlyUpper = makeDoc(["Fuser3"]);
  assert.equal(storage.renameTag("fuser3", "Fuser3"), 2);
  assert.deepEqual(tagsOf(both), ["Fuser3", "Paper3"]);
  assert.deepEqual(tagsOf(onlyLower), ["Fuser3"]);
  assert.deepEqual(tagsOf(onlyUpper), ["Fuser3"]);
  assert.equal(tagCount("fuser3"), 0);
  assert.equal(tagCount("Fuser3"), 3);
  // spelling variant
  const plural = makeDoc(["Fusers3", "Fuser3"]);
  assert.equal(storage.renameTag("Fusers3", "Fuser3"), 1);
  assert.deepEqual(tagsOf(plural), ["Fuser3"]);
});

test("tags: delete removes the tag everywhere; documents may end with no tags", () => {
  const a = makeDoc(["Obsolete4"]);
  const b = makeDoc(["Keep4", "Obsolete4"]);
  const beforeB = snapshotOtherFields(b);
  assert.equal(storage.deleteTag("Obsolete4"), 2);
  assert.deepEqual(tagsOf(a), []);
  assert.deepEqual(tagsOf(b), ["Keep4"]);
  assert.deepEqual(snapshotOtherFields(b), beforeB);
  assert.ok(storage.getDocument(a), "the document itself is kept");
});

test("tags: automatic excerpt words (chunks.tags_json) are not touched", () => {
  const id = makeDoc(["Heading5"]);
  storage.insertChunks([{
    id: `chunk-${id}`, parent_id: id, content: "body", content_type: "text", language: "en-US",
    section_path_json: "[]", section_id: null, section_title: null, heading_level: null,
    page_start: null, page_end: null, chunk_index: 0, document_type: "user_manual",
    product_model: "X100", product_version: null, firmware_version: null, audience_json: "[]",
    confidentiality: "public", allowed_tenants_json: "[]", lifecycle_status: "published",
    updated_at: new Date().toISOString(), error_codes_json: "[]", cli_commands_json: "[]",
    ui_paths_json: "[]", tags_json: JSON.stringify(["Heading5"]), embedding_json: "[]", token_count: 1,
  }]);
  storage.renameTag("Heading5", "Renamed5");
  assert.deepEqual(JSON.parse(storage.getChunksForDoc(id)[0].tags_json), ["Heading5"]);
  storage.deleteTag("Renamed5");
  assert.deepEqual(JSON.parse(storage.getChunksForDoc(id)[0].tags_json), ["Heading5"]);
});

test("tags: input validation and no-op cases", () => {
  assert.throws(() => storage.renameTag("", "x"), /Select a tag/);
  assert.throws(() => storage.renameTag("x", "  "), /Delete/);
  assert.throws(() => storage.deleteTag(" "), /Select a tag/);
  assert.equal(storage.renameTag("same6", "same6"), 0);
  assert.equal(storage.renameTag("NoSuchTag6", "Anything"), 0);
  assert.equal(storage.deleteTag("NoSuchTag6"), 0);
});

test("tags: malformed tags_json reads as no tags and is left alone", () => {
  const id = makeDoc([], { tags_json: "{not json" });
  assert.deepEqual(parseTagList("{not json"), []);
  assert.deepEqual(parseTagList('[" a ", 3, "", "b"]'), ["a", "b"]);
  storage.renameTag("a", "b");
  assert.equal(storage.getDocument(id).tags_json, "{not json");
});

test("tags: Product model/family management is unchanged", () => {
  const id = makeDoc(["Keep7"], { product_model: "X100-7", product_family: "Nova7" });
  assert.equal(storage.renameProductModel("X100-7", "X100-7b"), 1);
  assert.equal(storage.renameProductFamily("Nova7", "Nova7b"), 1);
  assert.deepEqual(tagsOf(id), ["Keep7"]);
});

// ------------------------------------------------------------ resume check
function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      assert.ok(!PROTECTED_PORTS.has(port));
      resolve({ server, port });
    });
  });
}
function freePort() {
  return listen(() => {}).then(({ server, port }) => new Promise((r) => server.close(() => r(port))));
}

test("resume check: a live listener logs ok and keeps running", async () => {
  const { server, port } = await listen((_q, s) => s.end("{}"));
  const lines = [];
  let exited = false;
  const r = await resume.runResumeCheck({
    port: () => port, listening: () => true, isBusy: () => false,
    log: (m) => lines.push(m), exit: () => { exited = true; }, retryDelayMs: 1, wait: testWait,
  });
  server.close();
  assert.equal(r, "ok");
  assert.equal(exited, false);
  assert.match(lines[0], /listener self-check ok \(HTTP 200/);
});

// The app's retry timer is unref()'d so it never holds shutdown; tests use a
// normal timer so the runner keeps the event loop alive while waiting.
const testWait = (ms) => new Promise((r) => setTimeout(r, ms));

test("resume check: a dead listener exits cleanly after a retry", async () => {
  const port = await freePort();
  const lines = [];
  let exited = false;
  const r = await resume.runResumeCheck({
    port: () => port, listening: () => true, isBusy: () => false,
    log: (m) => lines.push(m), exit: () => { exited = true; }, retryDelayMs: 1, wait: testWait,
  });
  assert.equal(r, "exited");
  assert.equal(exited, true);
  assert.equal(lines.filter((l) => /ECONNREFUSED/.test(l)).length, 2);
  assert.match(lines.at(-1), /exiting cleanly/);
});

test("resume check: never exits while work is active", async () => {
  const port = await freePort();
  let exited = false;
  const r = await resume.runResumeCheck({
    port: () => port, listening: () => true, isBusy: () => true,
    log: () => {}, exit: () => { exited = true; }, retryDelayMs: 1, wait: testWait,
  });
  assert.equal(r, "kept");
  assert.equal(exited, false);
});

test("resume check: a slow answer (timeout) is not treated as dead", async () => {
  assert.equal(resume.isListenerDead({ ok: false, code: "ETIMEDOUT", ms: 5000 }), false);
  assert.equal(resume.isListenerDead({ ok: false, status: 500, ms: 3 }), false);
  assert.equal(resume.isListenerDead({ ok: false, code: "ECONNREFUSED", ms: 1 }), true);
  let calls = 0;
  const r = await resume.runResumeCheck({
    port: () => 1, listening: () => true, isBusy: () => false, log: () => {},
    exit: () => assert.fail("must not exit"),
    check: async () => { calls++; return { ok: false, code: "ETIMEDOUT", ms: 5000 }; },
  });
  assert.equal(r, "kept");
  assert.equal(calls, 1);
});

// ------------------------------------------------------------ launcher helper
test("launcher: netstat parsing matches exactly the app port", () => {
  const out = [
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    127.0.0.1:5000         0.0.0.0:0              LISTENING       4100",
    "  TCP    0.0.0.0:50001          0.0.0.0:0              LISTENING       4200",
    "  TCP    127.0.0.1:50000        0.0.0.0:0              LISTENING       4300",
    "  TCP    127.0.0.1:5000         127.0.0.1:61000        ESTABLISHED     4100",
    "  TCP    127.0.0.1:61000        127.0.0.1:5000         ESTABLISHED     9999",
    "  TCP    [::1]:5000             [::]:0                 ABHÖREN         4400",
    "  TCP    127.0.0.1:15000        0.0.0.0:0              LISTENING       4500",
  ].join("\r\n");
  assert.deepEqual(relaunch.parseNetstatListeners(out, 5000).sort(), [4100, 4400]);
  assert.deepEqual(relaunch.parseNetstatListeners(out, 50000), [4300]);
});

function launcherContext(port, overrides = {}) {
  const logDir = mkdtempSync(join(tmpdir(), "apd-launcher-"));
  const appRoot = join(logDir, "app");
  return {
    appRoot, logDir, port, version: "1.3.6",
    nodeExe: join(appRoot, "node", "node.exe"),
    serverLog: join(logDir, "server.log"),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))),
    ...overrides,
  };
}
function fakeTools({ pids = [], image = () => "", onForce = () => {} } = {}) {
  const forced = [];
  return {
    forced,
    listeners: () => pids,
    imagePath: (pid) => image(pid),
    forceClose: (pid) => { forced.push(pid); onForce(pid); },
    alive: () => false,
  };
}
function readLog(ctx) {
  const p = join(ctx.logDir, relaunch.LOG_NAME);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}
function readFailure(ctx) {
  const p = join(ctx.logDir, relaunch.FAILURE_NAME);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}
/** A fake AdvisePoint server: health + stop + updater shutdown. */
async function fakeApp({ version = "1.3.6", stopStatus = 200, restartRequired = false, hang = false, body } = {}) {
  const seen = [];
  let closeServer;
  const { server, port } = await listen((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: raw });
      if (hang) return; // accept but never answer
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/health") {
        return res.end(JSON.stringify(body ?? { ok: true, app: "advisepoint-docs", version, restart_required: restartRequired || undefined }));
      }
      if (req.url === "/api/system/stop") {
        res.statusCode = stopStatus;
        res.end(JSON.stringify({ ok: stopStatus === 200 }));
        if (stopStatus === 200) closeServer();
        return;
      }
      if (req.url === "/api/updater/shutdown") {
        res.end(JSON.stringify({ ok: true, app: "advisepoint-docs" }));
        closeServer();
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  closeServer = () => setImmediate(() => { server.closeAllConnections(); server.close(); });
  return { server, port, seen, close: closeServer };
}

test("launcher: port free -> start, and a stale replacement note is cleared", async () => {
  const port = await freePort();
  const ctx = launcherContext(port);
  writeFileSync(join(ctx.logDir, relaunch.REPLACED_NAME), JSON.stringify({ at: Date.now() }));
  const tools = fakeTools();
  assert.equal(await relaunch.prepare(ctx, tools), relaunch.EXIT_START);
  assert.equal(existsSync(join(ctx.logDir, relaunch.REPLACED_NAME)), false);
  assert.deepEqual(tools.forced, []);
});

test("launcher: healthy server of this version is reused, nothing stopped", async () => {
  const app = await fakeApp();
  const ctx = launcherContext(app.port);
  const tools = fakeTools({ pids: [111] });
  assert.equal(await relaunch.prepare(ctx, tools), relaunch.EXIT_REUSE);
  assert.ok(!app.seen.some((r) => r.method === "POST"), "no stop request");
  assert.deepEqual(tools.forced, []);
  assert.match(readLog(ctx), /healthy .*reusing/);
  app.close();
});

test("launcher: another version is stopped with the confirmed Stop request", async () => {
  const app = await fakeApp({ version: "1.3.5" });
  const ctx = launcherContext(app.port);
  const tools = fakeTools({ pids: [222], image: () => ctx.nodeExe });
  assert.equal(await relaunch.prepare(ctx, tools), relaunch.EXIT_START);
  const stop = app.seen.find((r) => r.url === "/api/system/stop");
  assert.ok(stop, "stop route used");
  assert.equal(stop.headers.origin, `http://127.0.0.1:${app.port}`);
  assert.equal(stop.headers["x-apd-stop"], "1");
  assert.deepEqual(JSON.parse(stop.body), { confirm: true });
  assert.deepEqual(tools.forced, [], "no force-close after a clean stop");
  const note = JSON.parse(readFileSync(join(ctx.logDir, relaunch.REPLACED_NAME), "utf8"));
  assert.deepEqual(note.pids, [222]);
  assert.match(readLog(ctx), /replacing server: a different version \(1\.3\.5\).*pid\(s\)=222/);
});

test("launcher: a hung server of this install is force-closed only after the stop attempt", async () => {
  const app = await fakeApp({ hang: true });
  const ctx = launcherContext(app.port);
  const tools = fakeTools({ pids: [333], image: () => ctx.nodeExe.toUpperCase(), onForce: () => app.close() });
  assert.equal(await relaunch.prepare(ctx, tools), relaunch.EXIT_START);
  assert.deepEqual(tools.forced, [333]);
  assert.ok(app.seen.some((r) => r.url === "/api/system/stop"), "stop was tried first");
  assert.match(readLog(ctx), /force-closing pid=333 .*reason: did not exit after stop request/);
});

test("launcher: an unrelated program on the port is never closed", async () => {
  const other = await fakeApp({ body: { hello: "not us" } });
  const ctx = launcherContext(other.port);
  const tools = fakeTools({ pids: [444], image: () => "C:\\Program Files\\Other\\other.exe" });
  assert.equal(await relaunch.prepare(ctx, tools), relaunch.EXIT_FAIL);
  assert.deepEqual(tools.forced, []);
  assert.ok(!other.seen.some((r) => r.method === "POST"), "no stop request to a foreign program");
  assert.match(readFailure(ctx), /already in use by another program: C:\\Program Files\\Other\\other\.exe \(PID 444\)/);
  other.close();
});

test("launcher: a hung listener that is not this install's node.exe is not closed", async () => {
  const app = await fakeApp({ hang: true });
  const ctx = launcherContext(app.port);
  const tools = fakeTools({ pids: [555], image: () => "D:\\Other copy\\node\\node.exe" });
  assert.equal(await relaunch.prepare(ctx, tools), relaunch.EXIT_FAIL);
  assert.deepEqual(tools.forced, []);
  assert.match(readFailure(ctx), /D:\\Other copy\\node\\node\.exe \(PID 555\)/);
  app.close();
});

test("launcher: another copy with work in progress is left running", async () => {
  const app = await fakeApp({ version: "1.3.5", stopStatus: 409 });
  const ctx = launcherContext(app.port);
  const tools = fakeTools({ pids: [666], image: () => ctx.nodeExe });
  assert.equal(await relaunch.prepare(ctx, tools), relaunch.EXIT_FAIL);
  assert.deepEqual(tools.forced, []);
  assert.equal(existsSync(join(ctx.logDir, relaunch.REPLACED_NAME)), false);
  assert.match(readFailure(ctx), /still has work in progress/);
  app.close();
});

test("launcher: after a restore, the restart uses the updater shutdown route", async () => {
  const app = await fakeApp({ restartRequired: true, stopStatus: 409 });
  const ctx = launcherContext(app.port);
  const tools = fakeTools({ pids: [777], image: () => ctx.nodeExe });
  assert.equal(await relaunch.prepare(ctx, tools), relaunch.EXIT_START);
  assert.ok(app.seen.some((r) => r.url === "/api/updater/shutdown" && r.headers["x-apd-updater"] === "1"));
  assert.deepEqual(tools.forced, []);
});

test("launcher: a held server.log produces one clear failure", async () => {
  const app = await fakeApp({ version: "1.3.5" });
  const ctx = launcherContext(app.port);
  // Opening a folder for append fails, the same outcome as a server.log
  // still held by another process on Windows.
  ctx.serverLog = ctx.logDir;
  const tools = fakeTools({ pids: [888], image: () => ctx.nodeExe });
  assert.equal(await relaunch.prepare(ctx, tools), relaunch.EXIT_FAIL);
  assert.match(readFailure(ctx), /log file is still in use/);
});

test("launcher: replacement note silences only a launcher replaced after it started", () => {
  const ctx = launcherContext(1);
  const note = join(ctx.logDir, relaunch.REPLACED_NAME);
  const startedAt = Date.now() - 5000;
  writeFileSync(note, JSON.stringify({ at: Date.now(), reason: "test" }));
  assert.equal(relaunch.consumeReplaced(ctx, startedAt), 0, "replaced after start: quiet");
  assert.equal(existsSync(note), false, "note consumed once");
  assert.equal(relaunch.consumeReplaced(ctx, startedAt), 1, "no note: normal crash window");
  writeFileSync(note, JSON.stringify({ at: startedAt - 1000 }));
  assert.equal(relaunch.consumeReplaced(ctx, startedAt), 1, "note older than this launch: crash shown");
  writeFileSync(note, JSON.stringify({ at: Date.now() - 11 * 60 * 1000 }));
  assert.equal(relaunch.consumeReplaced(ctx, 0), 1, "stale note: crash shown");
  assert.equal(existsSync(note), false, "stale note removed");
});

// ------------------------------------------------------------ launcher file
test("launcher .bat: no blanket force-close, helper wired in, CRLF kept", () => {
  const bat = readFileSync(join(root, "packaging", "Start AdvisePoint Docs.bat"), "utf8");
  assert.ok(!/findstr\s+":5000"/i.test(bat), "inexact :5000 match removed");
  assert.ok(!/^\s*taskkill/im.test(bat), "launcher itself never runs taskkill");
  assert.match(bat, /relaunch\.cjs" --prepare/);
  assert.match(bat, /relaunch\.cjs" --consume-replaced %APD_STARTED_MS%/);
  assert.match(bat, /^:launch_failed\r$/m);
  assert.match(bat, /start "" "http:\/\/127\.0\.0\.1:5000\/"/);
  assert.match(bat, /APD_UPDATE_SENTINEL=%LOCALAPPDATA%\\AdvisePoint Docs\\\.updating/, "update sentinel unchanged");
  assert.ok(!/\r?\n/.test(bat.replace(/\r\n/g, "")), "every line ends with CRLF");
  for (const p of ["5100", "5101"]) assert.ok(!bat.includes(p), `launcher does not touch port ${p}`);
  // The start time must be taken AFTER the check so a launch's own note
  // never silences its own later crash.
  assert.ok(bat.indexOf("--prepare") < bat.indexOf("--now"));
});

test("launcher helper: packaged next to run-hidden.vbs", () => {
  assert.ok(existsSync(join(root, "packaging", "launcher", "relaunch.cjs")));
  assert.ok(existsSync(join(root, "packaging", "launcher", "run-hidden.vbs")));
});
