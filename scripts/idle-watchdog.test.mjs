import test from "node:test";
import assert from "node:assert/strict";
import { IdleWatchdog } from "../server/idle-watchdog.ts";
const CHECK = 10000, IDLE = 600000;
const make = () => new IdleWatchdog({ idleShutdownMs: IDLE, checkMs: CHECK });
test("awake server survives eight hours without browser heartbeats; reports once", () => {
  const w = make(); w.start(0); w.heartbeat(0);
  let missing = 0;
  for (let now = CHECK; now <= 8 * 3600000; now += CHECK) {
    const result = w.tick(now);
    assert.notEqual(result.action, "shutdown");
    if (result.action === "missing") missing++;
  }
  assert.equal(missing, 1);
  assert.equal(w.heartbeat(8 * 3600000 + 1), true);
  assert.equal(w.heartbeat(8 * 3600000 + 2), false);
});
test("healthy heartbeats, multiple tabs and close/reopen never require shutdown", () => {
  const w = make(); w.start(0);
  for (let t = CHECK; t < 100 * CHECK; t += CHECK) {
    w.heartbeat(t); w.heartbeat(t + 1);
    assert.equal(w.tick(t + 1).action, "wait");
  }
});
test("server stays available even if a browser never connects", () => {
  const w = make(); w.start(0);
  for (let t = CHECK; t < 8 * 3600000; t += CHECK) assert.equal(w.tick(t).action, "wait");
});
test("timer gap is diagnostic and cannot identify OS sleep", () => {
  const w = make(); w.start(0); w.heartbeat(0);
  assert.deepEqual(w.tick(4 * 3600000), { action: "resumed", suspendedMs: 4 * 3600000 });
  assert.equal(w.tick(4 * 3600000 + CHECK).action, "wait");
});
test("backward clock resets observation safely", () => {
  const w = make(); w.start(100000); w.heartbeat(100000);
  assert.deepEqual(w.tick(1000), { action: "resumed", suspendedMs: 0 });
});
test("a new absence can be reported after recovery without log spam", () => {
  const w = make(); w.start(0); w.heartbeat(0);
  for (let t = CHECK; t <= IDLE; t += CHECK) w.tick(t);
  assert.equal(w.tick(IDLE + CHECK).action, "missing");
  assert.equal(w.tick(IDLE + 2 * CHECK).action, "wait");
  assert.equal(w.heartbeat(IDLE + 2 * CHECK), true);
  let count = 0;
  for (let t = IDLE + 3 * CHECK; t < 3 * IDLE; t += CHECK)
    if (w.tick(t).action === "missing") count++;
  assert.equal(count, 1);
});
