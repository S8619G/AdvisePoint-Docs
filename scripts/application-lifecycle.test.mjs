import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { registerApplicationLifecycle } from "../server/application-lifecycle.ts";

async function fixture() {
  const app = express(); app.use(express.json());
  const server = createServer(app);
  const state = { busy: false, stopped: false };
  registerApplicationLifecycle(app, server, () => state.busy, () => { state.stopped = true; });
  let complete;
  app.post("/api/slow", (_req, res) => { complete = () => res.json({ ok: true }); });
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const stop = (headers = {}, body = { confirm: true }) => fetch(base + "/api/system/stop", {
    method: "POST", headers: { Origin: base, "X-APD-Stop": "1", "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { base, server, state, stop, finish: () => complete?.() };
}

test("explicit stop rejects cross-origin, missing confirmation and rebinding hosts", async () => {
  const f = await fixture();
  try {
    for (const headers of [{ Origin: "https://example.com" }, { Origin: "null" },
      { Origin: "" }, { "X-APD-Stop": "" }, { Host: "example.com", Origin: "http://example.com" }])
      assert.equal((await f.stop(headers)).status, 403);
    assert.equal((await f.stop({}, {})).status, 403);
    assert.equal((await fetch(f.base + "/api/health")).status, 200);
    assert.equal(f.state.stopped, false);
  } finally { f.server.close(); f.server.closeAllConnections(); }
});
test("active background work blocks stop without changing server health", async () => {
  const f = await fixture();
  try {
    f.state.busy = true;
    assert.equal((await f.stop()).status, 409);
    assert.equal((await fetch(f.base + "/api/health")).status, 200);
    assert.equal(f.state.stopped, false);
  } finally { f.server.close(); f.server.closeAllConnections(); }
});
test("pending write blocks stop, then a confirmed idle stop closes the listener", async () => {
  const f = await fixture();
  try {
    const writing = fetch(f.base + "/api/slow", { method: "POST" });
    await new Promise(r => setTimeout(r, 50));
    assert.equal((await f.stop()).status, 409);
    f.finish(); assert.equal((await writing).status, 200);
    const response = await f.stop();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    await new Promise(r => setTimeout(r, 50));
    assert.equal(f.state.stopped, true);
    await assert.rejects(fetch(f.base + "/api/health"));
  } finally { f.server.close(); f.server.closeAllConnections(); }
});
