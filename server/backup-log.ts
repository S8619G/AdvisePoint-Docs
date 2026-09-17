// v1.0.12.2: Dedicated, durable backup log.
//
// Why this file exists
// --------------------
// Backup activity used to be written only through console.log with a
// "[BACKUP]" prefix, which meant it landed in server.log. That has two
// problems for support:
//
//   1. The launcher moves server.log to server.log.1 on EVERY app launch,
//      so backup history survived exactly two starts before it was gone.
//      Questions like "did the nightly backup actually run all week?"
//      were unanswerable.
//   2. Backup lines were interleaved with high-volume HTTP request lines
//      (notably the /api/health poller), so reconstructing a week of
//      backup behaviour meant grepping a noisy, already-truncated file.
//
// This log is a separate file that the launcher does not rotate, so it
// accumulates across launches. It is size-capped with a single rollover
// so it cannot grow without bound on a long-lived install.
//
// Every write is best-effort. A backup must never fail, and a backup's
// outcome must never be misreported, because its log line could not be
// written -- so all failures here are swallowed. Callers continue to
// console.log as well, so an unwritable log degrades to exactly the
// pre-v1.0.12.2 behaviour rather than losing the record entirely.

import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const BACKUP_LOG_NAME = "backups.log";
export const BACKUP_LOG_ROTATED_NAME = "backups.log.1";

// 2 MiB holds well over a year of daily backup runs (a run writes about
// three short lines), while staying small enough to attach to a support
// ticket inside the diagnostics zip.
const ROTATE_SIZE_BYTES = 2 * 1024 * 1024;

// Resolved the same way the diagnostics export resolves it, so the log is
// written where the bundle later looks for it.
export function resolveLogDir(): string | null {
  if (process.env.APD_LOG_DIR) return process.env.APD_LOG_DIR;
  if (process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, "AdvisePoint Docs");
  return null;
}

export function backupLogPath(): string | null {
  const dir = resolveLogDir();
  return dir ? join(dir, BACKUP_LOG_NAME) : null;
}

function rotateIfLarge(p: string): void {
  try {
    const st = statSync(p);
    if (st.size < ROTATE_SIZE_BYTES) return;
    const rotated = `${p}.1`;
    // Windows rename will not overwrite, so clear the previous rollover
    // first. Both files are collected by the diagnostics bundle.
    try { rmSync(rotated, { force: true }); } catch { /* ignore */ }
    renameSync(p, rotated);
  } catch {
    // Missing file (nothing to rotate) or a locked handle. Either way the
    // append below still attempts to write.
  }
}

/**
 * Append one line to the dedicated backup log.
 *
 * `line` is expected to already carry its "[BACKUP]" prefix so the text is
 * identical to what goes to server.log; this function only adds an ISO
 * timestamp, which server.log gets from the launcher's own prefixing.
 */
export function appendBackupLog(line: string): void {
  const p = backupLogPath();
  if (!p) return;
  try {
    const dir = resolveLogDir();
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    rotateIfLarge(p);
    appendFileSync(p, `${new Date().toISOString()} ${line}\n`, { encoding: "utf8" });
  } catch {
    // Best-effort by design; see header note.
  }
}

/**
 * Record a session marker so gaps in the log can be attributed to the app
 * being closed rather than to a backup silently failing to run. Without
 * this, a missing nightly run and an app that was never open look the same.
 */
export function appendBackupLogSessionStart(version: string): void {
  appendBackupLog(`[BACKUP] --- app start (v${version}) ---`);
}
