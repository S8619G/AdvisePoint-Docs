// v1.3.6 server tests against the BUILT app (dist/index.cjs) with disposable
// data only: temporary data folders and test ports 5196/5197 (never 5000,
// 5100 or 5101). Covers the cross-site guard on real routes, tag management
// over HTTP (including Query tag filtering and facets), backup -> restore
// survival on a second disposable library, archiver 8 backup output, and the
// launcher helper against the real Stop / updater shutdown routes.
//
// Build first: npm run build:nobump
// Run: npm run test:features136:server
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import http from "node:http";
import { createRequire } from "node:module";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const relaunch = require("../packaging/launcher/relaunch.cjs");
const PORT_A = 5196;
const PORT_B = 5197;
for (const p of [PORT_A, PORT_B]) assert.ok(![5000, 5100, 5101].includes(p));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const temps = [];
function tempDir(label) {
  const d = mkdtempSync(join(tmpdir(), `apd-136-${label}-`));
  temps.push(d);
  return d;
}

function startServer(port, temp, { localTest = true } = {}) {
  const logs = [];
  const child = spawn(process.execPath, ["dist/index.cjs"], {
    cwd: root,
    env: {
      ...process.env, NODE_ENV: "production", PORT: String(port),
      RAG_DB_PATH: join(temp, "test.db"), RAG_PAGES_DIR: join(temp, "pages"),
      APD_LOG_DIR: join(temp, "logs"), LOCALAPPDATA: temp, APPDATA: temp,
      RAG_NO_SEED: "1", APD_OPEN_BROWSER: "0", APD_LOCAL_TEST: localTest ? "1" : "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (c) => logs.push(String(c)));
  child.stderr.on("data", (c) => logs.push(String(c)));
  const exited = new Promise((r) => child.once("exit", (code) => r(code)));
  return { child, logs, exited, port, temp };
}
async function waitHealthy(port, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return await r.json();
    } catch { /* booting */ }
    await delay(200);
  }
  throw new Error(`server on ${port} did not become healthy`);
}

/** Raw request so Host / Origin / Sec-Fetch-Site can be set freely. */
function raw(port, { method = "POST", path, headers = {}, body = "" }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, agent: false,
      headers: { "Content-Length": Buffer.byteLength(body), ...headers } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

let A;
let types;
const same = (port) => ({ "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` });
async function api(port, path, body, method = body === undefined ? "GET" : "POST") {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: body === undefined ? {} : same(port), body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}

before(async () => {
  A = startServer(PORT_A, tempDir("a"));
  await waitHealthy(PORT_A);
  types = (await api(PORT_A, "/api/document-types")).json;
  types = Array.isArray(types) ? types : types.types;
});
after(async () => {
  for (const s of [A]) if (s && s.child.exitCode === null) { s.child.kill(); await s.exited; }
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

async function ingest(port, title, tags) {
  const r = await api(port, "/api/ingest", {
    title, document_type: types[0].key, product_model: "X100", product_family: "Nova",
    tags, body: `${title} body text about the fuser and toner.`,
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.document?.id ?? r.json.id ?? r.json.document_id;
}

// ---------------------------------------------------------------- guard
test("guard: cross-site writes are refused with 403 and nothing is stored", async () => {
  const before = (await api(PORT_A, "/api/query-history")).json.history.length;
  const docsBefore = (await api(PORT_A, "/api/documents")).json.length;
  const evil = { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" };
  const attempts = [
    { path: "/api/query-history", headers: { ...evil, "Content-Type": "text/plain" }, body: '{"q":"evil"}' },
    { path: "/api/query-history", headers: { ...evil, "Content-Type": "application/x-www-form-urlencoded" }, body: "q=evil" },
    { path: "/api/upload", headers: { ...evil, "Content-Type": "multipart/form-data; boundary=x" },
      body: '--x\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\nevil\r\n--x--\r\n' },
    { path: "/api/query-history", headers: { Origin: "null", "Content-Type": "text/plain" }, body: '{"q":"evil"}' },
    { path: "/API/query-history", headers: { Origin: "https://evil.example", "Content-Type": "text/plain" }, body: '{"q":"evil"}' },
    { path: "/api/tag-values/delete", headers: { ...evil, "Content-Type": "text/plain" }, body: '{"tag":"x","confirm":true}' },
  ];
  for (const a of attempts) {
    const r = await raw(PORT_A, a);
    assert.equal(r.status, 403, `${a.path} ${a.headers.Origin}`);
    assert.match(r.body, /Cross-site request refused/);
    assert.equal(r.headers.connection, "close");
  }
  assert.equal((await api(PORT_A, "/api/query-history")).json.history.length, before, "no history stored");
  assert.equal((await api(PORT_A, "/api/documents")).json.length, docsBefore, "no document stored");
  const logText = A.logs.join("");
  assert.match(logText, /\[guard\] refused POST \/api\/query-history reason=sec-fetch-site/);
});

test("guard: a DNS-rebinding Host is refused; reads and no-Origin tools still work", async () => {
  const r = await raw(PORT_A, { path: "/api/query-history", headers: { Host: `evil.example:${PORT_A}`, "Content-Type": "application/json" }, body: '{"query":"x"}' });
  assert.equal(r.status, 403);
  const read = await raw(PORT_A, { method: "GET", path: "/api/health", headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" } });
  assert.equal(read.status, 200, "reads are not blocked");
  // The updater and launcher send no Origin: still allowed past the guard.
  const noOrigin = await raw(PORT_A, { path: "/api/system/stop", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(noOrigin.status, 403);
  assert.match(noOrigin.body, /Confirmed same-origin local request required/, "route's own check answered, not the guard");
});

test("guard: same-origin app writes keep working", async () => {
  const r = await api(PORT_A, "/api/query-history", { q: "guard same origin", filters: {}, maxResults: 8 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.json.history.some((h) => h.q === "guard same origin"));
});

// ---------------------------------------------------------------- tags
test("tags over HTTP: list, rename, merge, delete; facets, documents and Query follow", async () => {
  await delay(10500); // respect the real 30 writes / 10 s limit; never disabled
  const d1 = await ingest(PORT_A, "Tag doc one", ["Fuser", "Toner"]);
  const d2 = await ingest(PORT_A, "Tag doc two", ["fuser", "Fuser", "Paper"]);
  const d3 = await ingest(PORT_A, "Tag doc three", ["fusers"]);
  let list = (await api(PORT_A, "/api/tag-values")).json.tags;
  assert.deepEqual(list.find((t) => t.value === "Fuser"), { value: "Fuser", count: 2 });
  assert.deepEqual(list.find((t) => t.value === "fuser"), { value: "fuser", count: 1 });
  assert.equal(list[0].value, "Fuser", "most used first");

  // validation
  assert.equal((await api(PORT_A, "/api/tag-values/rename", { from: "Fuser", to: "" })).status, 400);
  assert.equal((await api(PORT_A, "/api/tag-values/rename", { from: "", to: "x" })).status, 400);
  assert.equal((await api(PORT_A, "/api/tag-values/delete", { tag: "Toner" })).status, 400, "delete needs confirm");
  assert.ok((await api(PORT_A, "/api/tag-values")).json.tags.some((t) => t.value === "Toner"), "unconfirmed delete changed nothing");

  // merge case variant and spelling variant
  let r = await api(PORT_A, "/api/tag-values/rename", { from: "fuser", to: "Fuser" });
  assert.equal(r.status, 200); assert.equal(r.json.affected, 1);
  r = await api(PORT_A, "/api/tag-values/rename", { from: "fusers", to: "Fuser" });
  assert.equal(r.json.affected, 1);
  const docs = Object.fromEntries((await api(PORT_A, "/api/documents")).json.map((d) => [d.id, d]));
  assert.deepEqual(docs[d1].tags, ["Fuser", "Toner"]);
  assert.deepEqual(docs[d2].tags, ["Fuser", "Paper"], "no duplicate on the document that had both");
  assert.deepEqual(docs[d3].tags, ["Fuser"]);
  list = (await api(PORT_A, "/api/tag-values")).json.tags;
  assert.deepEqual(list.find((t) => t.value === "Fuser"), { value: "Fuser", count: 3 });
  assert.equal(list.some((t) => t.value === "fuser" || t.value === "fusers"), false);

  // rename + delete
  r = await api(PORT_A, "/api/tag-values/rename", { from: "Toner", to: "Toner cartridge" });
  assert.equal(r.json.affected, 1);
  r = await api(PORT_A, "/api/tag-values/delete", { tag: "Paper", confirm: true });
  assert.equal(r.json.affected, 1);
  const facets = (await api(PORT_A, "/api/facets")).json.tags;
  assert.ok(facets.includes("Toner cartridge") && !facets.includes("Toner") && !facets.includes("Paper"));

  // Query tag filter (case-insensitive, whole tag) reflects the change.
  const search = async (tags) => (await api(PORT_A, "/api/search", { query: "fuser toner body", top_k: 20, filters: { tags } })).json;
  const hits = (res) => new Set((res.results ?? res.hits ?? []).map((h) => h.parent?.id));
  const merged = hits(await search(["fuser"]));
  assert.ok(merged.has(d1) && merged.has(d2) && merged.has(d3), "all three match the merged tag");
  assert.equal(hits(await search(["Paper"])).has(d2), false, "deleted tag matches nothing");
});

// ------------------------------------------------- backup -> restore survival
test("tags survive backup and restore; archiver 8 ZIP is readable by the app", async () => {
  await delay(10500);
  const exp = await fetch(`http://127.0.0.1:${PORT_A}/api/backup/export`);
  assert.equal(exp.status, 200);
  const zip = Buffer.from(await exp.arrayBuffer());
  assert.equal(zip.readUInt32LE(0), 0x04034b50, "ZIP local header");
  // Library B runs without the local-test update block because the restore
  // restart uses the updater shutdown route (no update is ever downloaded).
  const B = startServer(PORT_B, tempDir("b"), { localTest: false });
  try {
    await waitHealthy(PORT_B);
    const form = new FormData();
    form.append("file", new Blob([zip]), "tags-backup.zip");
    form.append("mode", "wipe");
    const imp = await fetch(`http://127.0.0.1:${PORT_B}/api/backup/import`, {
      method: "POST", headers: { Origin: `http://127.0.0.1:${PORT_B}` }, body: form,
    });
    const impBody = await imp.json();
    assert.equal(imp.status, 200, JSON.stringify(impBody));
    const health = await waitHealthy(PORT_B);
    assert.equal(health.restart_required, true);

    // Launcher helper against the REAL server: a restored library needs a
    // restart; Stop reports busy (database closed), so the helper uses the
    // updater shutdown route. Nothing is force-closed.
    const logDir = tempDir("launcher");
    const ctx = { ...relaunch.defaultContext(), port: PORT_B, logDir, serverLog: join(logDir, "server.log"),
      version: health.version, sleep: (ms) => delay(Math.min(ms, 250)) };
    const forced = [];
    const tools = { listeners: () => [B.child.pid], imagePath: () => ctx.nodeExe, forceClose: (p) => forced.push(p), alive: () => B.child.exitCode === null };
    assert.equal(await relaunch.prepare(ctx, tools), relaunch.EXIT_START);
    assert.deepEqual(forced, []);
    const code = await B.exited;
    assert.equal(code, 0, "restore restart exits cleanly");
    const launcherLog = readFileSync(join(logDir, "launcher.log"), "utf8");
    assert.match(launcherLog, /replacing server: a restore finished/);
    assert.match(launcherLog, /restore restart shutdown request: HTTP 200/);

    // Restart on the restored data and check tags.
    const B2 = startServer(PORT_B, B.temp);
    try {
      await waitHealthy(PORT_B);
      const tags = (await api(PORT_B, "/api/tag-values")).json.tags;
      assert.deepEqual(tags.find((t) => t.value === "Fuser"), { value: "Fuser", count: 3 });
      assert.ok(tags.some((t) => t.value === "Toner cartridge"));
      assert.equal(tags.some((t) => t.value === "Paper" || t.value === "fuser"), false);
    } finally { B2.child.kill(); await B2.exited; }
  } finally { if (B.child.exitCode === null) { B.child.kill(); await B.exited; } }
});

// ------------------------------------------------------- launcher (real app)
test("launcher helper reuses a healthy real server and stops another version with Stop", async () => {
  const health = await waitHealthy(PORT_A);
  const logDir = tempDir("launcher-a");
  const base = { ...relaunch.defaultContext(), port: PORT_A, logDir, serverLog: join(logDir, "server.log"), sleep: (ms) => delay(Math.min(ms, 250)) };
  const forced = [];
  const tools = { listeners: () => [A.child.pid], imagePath: () => base.nodeExe, forceClose: (p) => forced.push(p), alive: () => A.child.exitCode === null };
  assert.equal(await relaunch.prepare({ ...base, version: health.version }, tools), relaunch.EXIT_REUSE);
  assert.equal(A.child.exitCode, null, "healthy server left running");
  // Pretend this launcher is a different version: the real confirmed Stop
  // route must accept the helper's request and the server must exit 0.
  assert.equal(await relaunch.prepare({ ...base, version: "0.0.0-test" }, tools), relaunch.EXIT_START);
  assert.equal(await A.exited, 0);
  assert.deepEqual(forced, []);
  assert.match(A.logs.join(""), /explicit Stop application accepted/);
  assert.ok(existsSync(join(logDir, relaunch.REPLACED_NAME)));
});
