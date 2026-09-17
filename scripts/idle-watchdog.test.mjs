// Tests for server/idle-watchdog.ts -- sleep-aware idle shutdown.
// Run with: npm run test:idle-watchdog
//
// Time is injected, so a multi-hour sleep is simulated exactly and instantly.
import test from "node:test";
import assert from "node:assert/strict";

import { IdleWatchdog } from "../server/idle-watchdog.ts";

const CHECK = 10_000; // 10s, matches IDLE_CHECK_MS
const IDLE = 600_000; // 10min, matches the shipped default

function make(overrides = {}) {
  return new IdleWatchdog({ idleShutdownMs: IDLE, checkMs: CHECK, ...overrides });
}

/** Run normal ticks with heartbeats, as a live browser would. */
function runHealthy(w, from, count) {
  let t = from;
  for (let i = 0; i < count; i++) {
    t += CHECK;
    w.heartbeat(t);
    assert.deepEqual(w.tick(t), { action: "wait" }, `tick ${i} should wait`);
  }
  return t;
}

test("never shuts down before the browser has connected", () => {
  const w = make();
  let t = 0;
  // Hours of ticks with no heartbeat at all: the launcher may have opened
  // before the browser was ready, and killing it then would be absurd.
  for (let i = 0; i < 500; i++) {
    t += CHECK;
    assert.deepEqual(w.tick(t), { action: "wait" });
  }
  assert.equal(w.connected, false);
});

test("stays up while heartbeats keep arriving", () => {
  const w = make();
  w.heartbeat(1_000);
  runHealthy(w, 1_000, 200);
  assert.equal(w.connected, true);
});

test("shuts down after a genuine idle window with the process still running", () => {
  const w = make();
  w.heartbeat(0);
  let t = 0;
  let shutdownAt = null;
  // Ticks keep arriving on schedule -- the machine is awake, the tab is gone.
  for (let i = 0; i < 200 && shutdownAt === null; i++) {
    t += CHECK;
    const r = w.tick(t);
    if (r.action === "shutdown") shutdownAt = t;
  }
  assert.ok(shutdownAt !== null, "must eventually shut down");
  assert.ok(shutdownAt > IDLE, "must not shut down early");
  assert.ok(shutdownAt <= IDLE + CHECK, "must shut down promptly once idle");
});

test("the regression: a long sleep must not shut the server down", () => {
  const w = make();
  w.heartbeat(0);
  let t = runHealthy(w, 0, 5);

  // Machine sleeps four hours. No ticks fire because the process is frozen.
  const FOUR_HOURS = 4 * 60 * 60 * 1000;
  t += FOUR_HOURS;

  const r = w.tick(t);
  assert.equal(r.action, "resumed", "a four-hour gap is a suspend, not idleness");
  assert.equal(r.suspendedMs, FOUR_HOURS);
});

test("the browser gets a full window to reconnect after a resume", () => {
  const w = make();
  w.heartbeat(0);
  w.start(0);
  let t = 0 + 8 * 60 * 60 * 1000;
  assert.equal(w.tick(t).action, "resumed");

  // The tab wakes up a few seconds later and pings. Nothing should exit in
  // the meantime -- this is the race the old code lost.
  for (let i = 0; i < 3; i++) {
    t += CHECK;
    assert.deepEqual(w.tick(t), { action: "wait" });
  }
  w.heartbeat(t);
  runHealthy(w, t, 50);
});

test("a resume with no browser still shuts down, one window later", () => {
  const w = make();
  w.heartbeat(0);
  w.start(0);
  const resumeAt = 5 * 60 * 60 * 1000;
  assert.equal(w.tick(resumeAt).action, "resumed");

  let t = resumeAt;
  let shutdownAt = null;
  for (let i = 0; i < 200 && shutdownAt === null; i++) {
    t += CHECK;
    const r = w.tick(t);
    if (r.action === "shutdown") shutdownAt = t;
  }
  assert.ok(shutdownAt !== null, "a closed tab must still wind the server down");
  // The idle clock restarted at the resume, so the window is measured from
  // there -- not from the last pre-sleep heartbeat.
  assert.ok(shutdownAt - resumeAt > IDLE);
  assert.ok(shutdownAt - resumeAt <= IDLE + CHECK);
});

test("repeated sleep/wake cycles never shut down while the tab is alive", () => {
  const w = make();
  w.heartbeat(0);
  let t = 0;
  for (let day = 0; day < 7; day++) {
    t = runHealthy(w, t, 10);
    t += 9 * 60 * 60 * 1000; // overnight
    const r = w.tick(t);
    assert.equal(r.action, "resumed", `night ${day} should be seen as a resume`);
    w.heartbeat(t + 2_000);
  }
});

test("ordinary tick jitter is not mistaken for a suspend", () => {
  const w = make();
  w.heartbeat(0);
  let t = 0;
  // A loaded machine delivering ticks up to 20s late on a 10s interval.
  for (let i = 0; i < 100; i++) {
    t += CHECK + (i % 3) * 5_000;
    w.heartbeat(t);
    assert.deepEqual(w.tick(t), { action: "wait" }, `jittery tick ${i}`);
  }
});

test("a gap just under the threshold is treated as real idleness", () => {
  const w = make({ suspendGapMs: 60_000 });
  w.heartbeat(0);
  let t = 0;
  // 59s late every time: under the suspend threshold, so these count as
  // idle time and the server should eventually wind down.
  let shutdownAt = null;
  for (let i = 0; i < 100 && shutdownAt === null; i++) {
    t += 59_000;
    const r = w.tick(t);
    assert.notEqual(r.action, "resumed", "must not be read as a suspend");
    if (r.action === "shutdown") shutdownAt = t;
  }
  assert.ok(shutdownAt !== null);
});

test("a gap at the threshold counts as a suspend", () => {
  const w = make({ suspendGapMs: 60_000 });
  w.heartbeat(0);
  w.tick(CHECK);
  const r = w.tick(CHECK + 60_000);
  assert.equal(r.action, "resumed");
  assert.equal(r.suspendedMs, 60_000);
});

test("the suspend threshold sits between jitter and the idle window", () => {
  // The whole design depends on this ordering. If the threshold ever crept
  // above the idle window, the shutdown check would fire first and the
  // sleep fix would silently stop working.
  const w = make();
  const gap = w.suspendThresholdMs;
  assert.ok(gap > CHECK, "must be above the tick interval");
  assert.ok(gap < IDLE, "must be below the idle window");
});

test("the default threshold has a one-minute floor for fast intervals", () => {
  const w = make({ checkMs: 1_000 });
  w.heartbeat(0);
  w.tick(1_000);
  // 4 * 1s would be a 4s threshold, which ordinary jitter would trip.
  assert.deepEqual(w.tick(11_000), { action: "wait" });
  assert.equal(w.tick(11_000 + 60_000).action, "resumed");
});

test("a backwards clock never triggers a shutdown", () => {
  const w = make();
  w.heartbeat(0);
  let t = runHealthy(w, 0, 3);
  // Clock jumps back an hour mid-run (NTP correction).
  const r = w.tick(t - 60 * 60 * 1000);
  assert.equal(r.action, "resumed");
  assert.equal(r.suspendedMs, 0);
});

test("a heartbeat during the idle window resets the clock", () => {
  const w = make();
  w.heartbeat(0);
  let t = 0;
  for (let i = 0; i < 50; i++) t += CHECK;
  assert.deepEqual(w.tick(t), { action: "wait" }, "500s is inside the window");
  w.heartbeat(t);
  for (let i = 0; i < 50; i++) {
    t += CHECK;
    assert.deepEqual(w.tick(t), { action: "wait" });
  }
});

test("the first tick after connecting has a baseline and does not false-resume", () => {
  const w = make();
  // Ticks run for an hour before the browser ever connects.
  let t = 0;
  for (let i = 0; i < 360; i++) { t += CHECK; w.tick(t); }
  w.heartbeat(t);
  t += CHECK;
  assert.deepEqual(w.tick(t), { action: "wait" });
});

test("the very first tick never shuts down, even after a long gap", () => {
  // Suspended within one tick interval of startup: no baseline exists yet,
  // so the watchdog must not act on the elapsed time.
  const w = make();
  w.heartbeat(0);
  assert.deepEqual(w.tick(6 * 60 * 60 * 1000), { action: "wait" });
});

test("start() gives the first tick a baseline so a suspend is caught", () => {
  const w = make();
  w.heartbeat(0);
  w.start(0);
  assert.equal(w.tick(6 * 60 * 60 * 1000).action, "resumed");
});

test("a suspend spanning the connect moment does not shut down", () => {
  const w = make();
  w.tick(CHECK);
  w.heartbeat(2 * CHECK);
  const r = w.tick(2 * CHECK + 3 * 60 * 60 * 1000);
  assert.equal(r.action, "resumed");
});
