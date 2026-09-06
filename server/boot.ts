// -------------------------------------------------------------------
// boot.ts (v0.9.34)
// -------------------------------------------------------------------
// Server-side boot instrumentation and defensive error handling.
//
// Introduced in v0.9.34 to close a diagnosability gap identified during
// the v0.9.30.x crash investigations: when node died before writing any
// log line (bad DB path, missing native binding, module resolution
// failure), the hidden-window launcher captured nothing usable. Users
// then had to run through several support round trips before we could
// even tell whether node had started at all.
//
// What this module provides:
//   * installCrashTrap() -- process.on('uncaughtException'/'unhandledRejection')
//     that flushes a marked crash line to stdout synchronously so it
//     survives the process exit and lands in server.log via the launcher
//     stdout capture.
//   * envSnapshot() -- one-line dump of node/os/build/paths/free_gb.
//   * withPhase(name, fn) -- wraps a boot phase with start/done log
//     lines and an elapsed timing. Any phase > 5 s emits WARN.
//   * bootState -- tracks current phase + ready timestamp so /api/health
//     can report boot state without touching module state directly.
//   * logRotate -- periodic size-based rotation of server.log.
//   * readRecentLogLines() -- pulls the tail of server.log for
//     /api/health inclusion. Best-effort, size-capped, safe under
//     concurrent writers.
// -------------------------------------------------------------------

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { APP_VERSION } from "../client/src/version";

// -------------------------------------------------------------------
// Boot state
// -------------------------------------------------------------------

interface BootStateShape {
  processStart: number;
  currentPhase: string;
  readyAt: number | null;
  lastError: { message: string; ts: number } | null;
}

const state: BootStateShape = {
  processStart: Date.now(),
  currentPhase: "starting",
  readyAt: null,
  lastError: null,
};

export const bootState = {
  markReady(): void {
    state.readyAt = Date.now();
    state.currentPhase = "ready";
  },
  markError(err: unknown): void {
    state.lastError = {
      message: err instanceof Error ? err.message : String(err),
      ts: Date.now(),
    };
  },
  snapshot() {
    return {
      boot_phase: state.currentPhase,
      boot_completed_at: state.readyAt ? new Date(state.readyAt).toISOString() : null,
      uptime_ms: Date.now() - state.processStart,
      last_error: state.lastError,
      version: APP_VERSION,
    };
  },
};

// -------------------------------------------------------------------
// Crash trap
// -------------------------------------------------------------------

function crashLine(kind: string, err: unknown): string {
  const msg = err instanceof Error ? (err.stack || err.message) : String(err);
  const ts = new Date().toISOString();
  return `[crash] ${ts} ${kind}: ${msg}`;
}

export function installCrashTrap(): void {
  const flushSync = (line: string) => {
    // Sync write to stdout survives even when the event loop is shutting down.
    // process.stdout.write is buffered on Windows pipes; use fs.writeSync
    // against the underlying fd for a hard flush.
    try {
      fs.writeSync(1, line.endsWith("\n") ? line : line + "\n");
    } catch {
      // Last resort: fall back to console.error, which is unbuffered on
      // stderr. Better a truncated line than nothing.
      // eslint-disable-next-line no-console
      console.error(line);
    }
  };

  process.on("uncaughtException", (err) => {
    bootState.markError(err);
    flushSync(crashLine("uncaughtException", err));
    // Exit non-zero so the launcher's crash-surface console opens.
    setTimeout(() => process.exit(1), 100).unref();
  });

  process.on("unhandledRejection", (reason) => {
    bootState.markError(reason);
    flushSync(crashLine("unhandledRejection", reason));
    // Do NOT exit -- unhandled rejections in Node 18+ default to non-fatal
    // and there may be one from a background timer that shouldn't take the
    // whole server down. Just leave a trail.
  });
}

// -------------------------------------------------------------------
// Environment snapshot
// -------------------------------------------------------------------

function safeFreeGb(): string {
  try {
    // Node has no cross-platform "free disk space" API. free memory is a
    // reasonable proxy for "is the machine wedged" and is trivially cheap.
    const freeGb = os.freemem() / 1024 / 1024 / 1024;
    return freeGb.toFixed(1);
  } catch {
    return "?";
  }
}

export function envSnapshot(): string {
  const parts = [
    `node=${process.versions.node}`,
    `os=${os.platform()}`,
    `arch=${os.arch()}`,
    `release=${os.release()}`,
    `cwd=${process.cwd()}`,
    `db=${process.env.RAG_DB_PATH ?? "(default)"}`,
    `pages=${process.env.RAG_PAGES_DIR ?? "(default)"}`,
    `port=${process.env.PORT ?? "5000"}`,
    `bind=${process.env.RAG_BIND ?? "127.0.0.1"}`,
    `log_dir=${process.env.APD_LOG_DIR ?? "(none)"}`,
    `free_mem_gb=${safeFreeGb()}`,
    `app_version=${APP_VERSION}`,
  ];
  return `env ${parts.join(" ")}`;
}

// -------------------------------------------------------------------
// Phase timing
// -------------------------------------------------------------------

const SLOW_PHASE_MS = 5000;

export async function withPhase<T>(
  name: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const start = Date.now();
  state.currentPhase = name;
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(`${ts} [boot] phase=${name} start`);
  try {
    const result = await fn();
    const elapsed = Date.now() - start;
    const doneTs = new Date().toISOString();
    const warn = elapsed > SLOW_PHASE_MS ? " (WARN slow)" : "";
    // eslint-disable-next-line no-console
    console.log(`${doneTs} [boot] phase=${name} done elapsed_ms=${elapsed}${warn}`);
    return result;
  } catch (err) {
    const elapsed = Date.now() - start;
    const failTs = new Date().toISOString();
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.log(`${failTs} [boot] phase=${name} FAIL elapsed_ms=${elapsed} error="${msg}"`);
    bootState.markError(err);
    throw err;
  }
}

// -------------------------------------------------------------------
// Log rotation (size-based, best-effort)
// -------------------------------------------------------------------

const ROTATE_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const ROTATE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

function tryRotateOnce(): void {
  const dir = process.env.APD_LOG_DIR;
  if (!dir) return;
  const logPath = path.join(dir, "server.log");
  const rotatedPath = path.join(dir, "server.log.1");
  let st: fs.Stats;
  try {
    st = fs.statSync(logPath);
  } catch {
    // Log file not yet present (fresh install, first launch of the session
    // before any write flushed). Nothing to rotate.
    return;
  }
  if (st.size < ROTATE_SIZE_BYTES) return;
  try {
    // Best-effort: remove the previous .1 file (Windows rename won't
    // overwrite atomically), then rename. If PowerShell's Tee-Object still
    // holds the old handle it will keep writing to the (now renamed)
    // server.log.1 file until the next line flush, then re-resolve. That's
    // acceptable -- the diagnostics bundle picks up both files anyway.
    try { fs.rmSync(rotatedPath, { force: true }); } catch { /* ignore */ }
    fs.renameSync(logPath, rotatedPath);
    // eslint-disable-next-line no-console
    console.log(`[boot] log rotated at ${st.size} bytes -> server.log.1`);
  } catch (err) {
    // Rename may fail if Tee-Object has the file exclusively locked.
    // Don't crash the interval; try again next tick.
    // eslint-disable-next-line no-console
    console.log(`[boot] log rotate skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

let rotateHandle: NodeJS.Timeout | null = null;

export const logRotate = {
  start(): void {
    if (rotateHandle) return;
    // Delay the first check so we don't compete with launcher-side setup.
    setTimeout(() => {
      tryRotateOnce();
      rotateHandle = setInterval(tryRotateOnce, ROTATE_INTERVAL_MS);
      rotateHandle.unref();
    }, 30_000).unref();
  },
  stop(): void {
    if (rotateHandle) {
      clearInterval(rotateHandle);
      rotateHandle = null;
    }
  },
  // Exposed for tests
  _rotateNow: tryRotateOnce,
};

// -------------------------------------------------------------------
// Log tail for /api/health
// -------------------------------------------------------------------

const TAIL_MAX_LINES = 200;
const TAIL_MAX_BYTES = 64 * 1024; // 64 KB safety cap

export function readRecentLogLines(): { lines: string[]; source: string; truncated: boolean } {
  const dir = process.env.APD_LOG_DIR;
  const empty = { lines: [] as string[], source: "unavailable", truncated: false };
  if (!dir) return empty;
  const logPath = path.join(dir, "server.log");
  let fd: number | null = null;
  try {
    const st = fs.statSync(logPath);
    const readBytes = Math.min(st.size, TAIL_MAX_BYTES);
    if (readBytes === 0) return { lines: [], source: "server.log", truncated: false };
    fd = fs.openSync(logPath, "r");
    const buf = Buffer.alloc(readBytes);
    fs.readSync(fd, buf, 0, readBytes, st.size - readBytes);
    const text = buf.toString("utf8");
    // If we started mid-line, drop the first partial line for cleanliness.
    let startIdx = 0;
    if (readBytes < st.size) {
      const nl = text.indexOf("\n");
      if (nl !== -1) startIdx = nl + 1;
    }
    const rawLines = text.slice(startIdx).split(/\r?\n/).filter((l) => l.length > 0);
    const trimmed = rawLines.slice(-TAIL_MAX_LINES);
    return {
      lines: trimmed,
      source: "server.log",
      truncated: readBytes < st.size || rawLines.length > TAIL_MAX_LINES,
    };
  } catch {
    return empty;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}
