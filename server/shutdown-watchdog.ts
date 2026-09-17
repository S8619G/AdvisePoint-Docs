// ---------------------------------------------------------------------------
// v1.1.7 -- event-loop-independent hard-exit watchdog.
//
// Why this exists.
//
// /api/updater/shutdown (server/routes.ts) is supposed to bound the shutdown
// path at a few seconds: drop live sockets, close the http server, and hard-
// exit as a last resort. The previous safety net was
//
//     const forcedExit = setTimeout(() => process.exit(0), 2000);
//     forcedExit.unref();
//
// which is bound to the main event loop. If anything on the shutdown path is
// synchronously blocking the loop -- and there are several plausible culprits
// (better-sqlite3 WAL checkpoint / db.close(), a large fs.writeSync, a
// module-level cleanup that never yields) -- that timer never gets its tick
// and never fires. A field upgrade from v1.1.4 to v1.1.6 saw the server take
// 18.6 s to exit, well past the 2 s deadline, riding the boundary of the
// updater's 20 s grace window. Backlog note: the prime suspect is the
// synchronous better-sqlite3 close, but it is UNCONFIRMED. This module
// removes the dependency on the main loop so the deadline holds regardless.
//
// How it works.
//
// A worker thread runs its own event loop. On boot we start one and hold a
// handle. When /api/updater/shutdown is invoked, we tell the worker "you
// have <deadlineMs> before I hard-exit." The worker then queues a
// setTimeout in its own loop that calls process.exit(1) on the PARENT via
// its `process.pid` -- more precisely, since a worker cannot terminate the
// parent, the worker's timer fires and the worker sends a `terminate` port
// message back and, as a belt and braces guarantee, also asks the OS to
// kill the parent using process.kill(parentPid, "SIGKILL") on POSIX, or on
// Windows shells out to taskkill /PID <parentPid> /F.
//
// If the parent is running its event loop normally and shutdown completes on
// its own, we cancel the worker's timer before the deadline elapses and no
// force-exit happens.
//
// Design notes.
//
// * We spawn the worker at server boot rather than at /api/updater/shutdown
//   time. Starting a worker involves module resolution and a small event
//   loop of its own, and doing that from a shutdown handler that we suspect
//   is already blocked is exactly the wrong time. The idle worker sits at
//   near-zero cost until it is armed.
//
// * The worker thread source is inlined as a string and passed via
//   `Worker(..., { eval: true })` so this module compiles to a single
//   TypeScript output file. No second file to keep in sync, no build-order
//   dependency for the worker script.
//
// * The parent PID is captured at boot and passed on arm. Windows and POSIX
//   have different kill paths; both are attempted so a partially-blocked
//   host still exits.
//
// * The worker is unref()ed on the parent side. It must not keep the parent
//   alive on its own, or a stalled server with no shutdown request would
//   never exit for the idle watchdog.
// ---------------------------------------------------------------------------

import { Worker } from "node:worker_threads";

const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const { spawnSync } = require("node:child_process");

/** @type {NodeJS.Timeout | null} */
let armedTimer = null;
let armedDeadline = 0;
let armedParentPid = 0;

function killParent(pid, reason) {
  const line = JSON.stringify({
    kind: "hard-exit",
    reason,
    at: new Date().toISOString(),
    parent_pid: pid,
  });
  // Best effort: tell the parent first so it can flush a log line if it can.
  try { parentPort && parentPort.postMessage({ type: "will-hard-exit", reason }); } catch (_e) {}
  // POSIX: SIGKILL is unblockable. Windows: process.kill maps to
  // TerminateProcess for signal 9-ish; also fall back to taskkill /F.
  try {
    process.kill(pid, "SIGKILL");
  } catch (_e) {
    // Some Node builds refuse SIGKILL on Windows. Fall through to taskkill.
  }
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill.exe", ["/PID", String(pid), "/F"], {
        windowsHide: true,
        timeout: 5000,
      });
    } catch (_e) {}
  }
  // As an absolute last resort, exit the worker itself so the parent, if
  // still alive, sees the worker die and can react.
  try { parentPort && parentPort.postMessage({ type: "did-hard-exit", reason, line }); } catch (_e) {}
  process.exit(0);
}

parentPort.on("message", (msg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "arm") {
    if (armedTimer) { clearTimeout(armedTimer); armedTimer = null; }
    armedParentPid = Number(msg.parentPid) || 0;
    armedDeadline = Number(msg.deadlineMs) || 5000;
    if (!armedParentPid) return;
    armedTimer = setTimeout(() => {
      armedTimer = null;
      killParent(armedParentPid, msg.reason || "shutdown-deadline");
    }, armedDeadline);
    try { parentPort.postMessage({ type: "armed", deadlineMs: armedDeadline }); } catch (_e) {}
  } else if (msg.type === "disarm") {
    if (armedTimer) { clearTimeout(armedTimer); armedTimer = null; }
    try { parentPort.postMessage({ type: "disarmed" }); } catch (_e) {}
  } else if (msg.type === "ping") {
    try { parentPort.postMessage({ type: "pong" }); } catch (_e) {}
  }
});
`;

export interface ShutdownWatchdog {
  /** Arm the hard-exit for `deadlineMs` from now. Idempotent (re-arm resets). */
  arm(deadlineMs: number, reason?: string): void;
  /** Cancel a pending arm; safe to call when not armed. */
  disarm(): void;
  /** Terminate the worker; the parent process is untouched. */
  stop(): void;
  /** True when a live worker is available. */
  readonly ready: boolean;
}

// Log helper -- kept local so this module has no dependency on server/index.ts.
function log(line: string) {
  // eslint-disable-next-line no-console
  console.log(`[shutdown-watchdog] ${line}`);
}

export function createShutdownWatchdog(): ShutdownWatchdog {
  let worker: Worker | null = null;
  let ready = false;

  try {
    worker = new Worker(WORKER_SOURCE, { eval: true });
    ready = true;
    // The worker must NEVER keep the parent alive. If the parent's normal
    // event loop drains (idle shutdown, tests exiting cleanly), the worker
    // silently goes with it.
    worker.unref();

    worker.on("error", (err) => {
      log(`worker error: ${err instanceof Error ? err.message : String(err)}`);
      ready = false;
    });
    worker.on("exit", (code) => {
      log(`worker exited code=${code}`);
      ready = false;
      worker = null;
    });
    worker.on("message", (msg: unknown) => {
      if (msg && typeof msg === "object") {
        const m = msg as { type?: string; reason?: string };
        if (m.type === "will-hard-exit") {
          // The parent's log stream may still be attached. Fire a synchronous
          // line so the sequence "shutdown started ... hard-exit" survives
          // in server.log even on a wedged event loop.
          try {
            const line = `[shutdown-watchdog] deadline reached (${m.reason ?? "shutdown-deadline"}); forcing exit\n`;
            // fs.writeSync bypasses the buffered stream. Use fd=1 (stdout).
            // Non-fatal on any error.
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const fs = require("node:fs");
            fs.writeSync(1, line);
          } catch {
            /* non-fatal */
          }
        }
      }
    });
  } catch (err) {
    log(`worker not started: ${err instanceof Error ? err.message : String(err)}`);
    ready = false;
  }

  return {
    get ready() {
      return ready;
    },
    arm(deadlineMs: number, reason = "shutdown-deadline"): void {
      if (!worker || !ready) return;
      try {
        worker.postMessage({
          type: "arm",
          parentPid: process.pid,
          deadlineMs,
          reason,
        });
      } catch (err) {
        log(`arm failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    disarm(): void {
      if (!worker || !ready) return;
      try {
        worker.postMessage({ type: "disarm" });
      } catch {
        /* non-fatal */
      }
    },
    stop(): void {
      if (!worker) return;
      try {
        void worker.terminate();
      } catch {
        /* non-fatal */
      }
      worker = null;
      ready = false;
    },
  };
}
