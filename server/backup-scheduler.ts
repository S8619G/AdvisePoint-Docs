// v1.0.3: Scheduled backup runner (Option 2 -- in-server, single-process).
//
// Persists cadence, time-of-day, target folder, and retention count in
// the `app_settings` key/value table. On startup, computes the next fire
// time from the persisted last-run timestamp and the configured cadence;
// then runs on a coarse `setInterval` tick (every minute is plenty --
// backups take longer than that anyway).
//
// If a scheduled slot was missed while the app was closed, we fire ONCE
// on startup with a small grace window so we don't slam the disk during
// a rapid restart cycle.

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { rawDb } from "./storage";
import { scheduledBackupFilename, isBackupFilename, writeBackupToFile } from "./backup";
import { getDataDirForBackup } from "./storage";

// -------- Settings persistence (app_settings key/value) --------

const KEYS = {
  cadence: "backup_cadence",         // "off" | "daily" | "weekly"
  time: "backup_time",               // "HH:MM" 24h local
  folder: "backup_folder",           // absolute path
  retention: "backup_retention",     // integer, kept as string
  lastRunAt: "backup_last_run_at",   // ISO timestamp
  lastStatus: "backup_last_status",  // "success" | "failed" | ""
  lastError: "backup_last_error",    // string
  lastBytes: "backup_last_bytes",    // integer as string
} as const;

const DEFAULTS = {
  cadence: "off" as "off" | "daily" | "weekly",
  time: "02:00",
  retention: 7,
};

export interface BackupSettings {
  cadence: "off" | "daily" | "weekly";
  time: string;                 // "HH:MM"
  folder: string;
  retention: number;
  lastRunAt: string | null;
  lastStatus: "success" | "failed" | null;
  lastError: string | null;
  lastBytes: number | null;
}

function get(key: string): string | null {
  try {
    const row = rawDb.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function set(key: string, value: string): void {
  rawDb.prepare(
    "INSERT INTO app_settings (key, value) VALUES (?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

function defaultBackupFolder(): string {
  return join(getDataDirForBackup(), "backups");
}

export interface BackupSettingsWire extends BackupSettings {
  // UI-friendly aliases so the client can use consistent snake_case field
  // names without leaking internal camelCase.
  time_hhmm: string;
  retention_count: number;
  weekday: number;
  last_run_finished_at: string | null;
  last_run_started_at: string | null;
  last_run_status: "success" | "failed" | null;
  last_run_error: string | null;
  last_backup_filename: string | null;
  next_run_at: string | null;
}

export function readSettings(): BackupSettingsWire {
  const cadence = (get(KEYS.cadence) ?? DEFAULTS.cadence) as BackupSettings["cadence"];
  const time = get(KEYS.time) ?? DEFAULTS.time;
  const folderRaw = get(KEYS.folder);
  const folder = folderRaw && folderRaw.length > 0 ? folderRaw : defaultBackupFolder();
  const retention = parseInt(get(KEYS.retention) ?? String(DEFAULTS.retention), 10) || DEFAULTS.retention;
  const lastRunAt = get(KEYS.lastRunAt);
  const lastStatusRaw = get(KEYS.lastStatus);
  const lastStatus = lastStatusRaw === "success" || lastStatusRaw === "failed" ? lastStatusRaw : null;
  const lastError = get(KEYS.lastError);
  const lastBytesRaw = get(KEYS.lastBytes);
  const lastBytes = lastBytesRaw ? parseInt(lastBytesRaw, 10) : null;
  const lastFilename = get("backup_last_filename");
  const nextRunMs = computeNextRun(cadence, time, lastRunAt, new Date());
  const nextRunIso = nextRunMs ? new Date(nextRunMs).toISOString() : null;

  // Weekday: derived from last-run timestamp if available; else Sunday.
  let weekday = 0;
  if (lastRunAt) {
    const d = new Date(lastRunAt);
    if (!isNaN(d.getTime())) weekday = d.getDay();
  }

  return {
    cadence,
    time,
    folder,
    retention,
    lastRunAt,
    lastStatus,
    lastError,
    lastBytes,
    // UI-friendly aliases:
    time_hhmm: time,
    retention_count: retention,
    weekday,
    last_run_finished_at: lastRunAt,
    last_run_started_at: lastRunAt,
    last_run_status: lastStatus,
    last_run_error: lastError,
    last_backup_filename: lastFilename,
    next_run_at: nextRunIso,
  };
}

export interface WritableSettings {
  cadence?: "off" | "daily" | "weekly";
  // Accept both internal name (`time`) and UI-friendly alias (`time_hhmm`).
  time?: string;
  time_hhmm?: string;
  folder?: string;
  // Accept `retention` OR `retention_count`.
  retention?: number;
  retention_count?: number;
  // Trigger an immediate scheduled-style backup (fire-and-forget).
  run_now?: boolean;
  // `weekday` is accepted for forward compat but currently ignored --
  // the scheduler derives weekly alignment from the last-run timestamp.
  weekday?: number;
}

export function writeSettings(patch: WritableSettings): BackupSettingsWire {
  if (patch.cadence && ["off", "daily", "weekly"].includes(patch.cadence)) {
    set(KEYS.cadence, patch.cadence);
  }
  const timeVal = patch.time ?? patch.time_hhmm;
  if (timeVal && /^\d{2}:\d{2}$/.test(timeVal)) {
    set(KEYS.time, timeVal);
  }
  if (typeof patch.folder === "string") {
    // Blank folder resets to default at read time.
    const trimmed = patch.folder.trim();
    if (trimmed.length > 0) set(KEYS.folder, trimmed);
    else set(KEYS.folder, "");
  }
  const retVal = patch.retention_count ?? patch.retention;
  if (typeof retVal === "number" && retVal >= 1 && retVal <= 365) {
    set(KEYS.retention, String(Math.floor(retVal)));
  }
  // Reset next-run cache so a new cadence takes effect immediately.
  computedNextRun = null;

  // If the caller asked us to run right now, schedule an immediate tick
  // that will fire a real backup. We deliberately fire-and-forget: the
  // client watches the last-run timestamp to see completion.
  if (patch.run_now) {
    setImmediate(() => { void runBackupNow("scheduled"); });
  }

  return readSettings();
}

// -------- Concurrency guard (shared with manual export) --------

let backupInFlight = false;

export function isBackupInFlight(): boolean { return backupInFlight; }

export async function withBackupLock<T>(fn: () => Promise<T>): Promise<T> {
  if (backupInFlight) throw new Error("A backup is already in progress");
  backupInFlight = true;
  try {
    return await fn();
  } finally {
    backupInFlight = false;
  }
}

// -------- Scheduling --------

let intervalHandle: NodeJS.Timeout | null = null;
let computedNextRun: number | null = null;   // epoch ms
let startupTime = Date.now();

function parseHhmm(hhmm: string): { h: number; m: number } {
  const [hStr, mStr] = hhmm.split(":");
  const h = Math.max(0, Math.min(23, parseInt(hStr ?? "0", 10) || 0));
  const m = Math.max(0, Math.min(59, parseInt(mStr ?? "0", 10) || 0));
  return { h, m };
}

/**
 * Compute the next scheduled run time (epoch ms) given cadence + time.
 * `now` is a testable parameter.
 */
export function computeNextRun(
  cadence: BackupSettings["cadence"],
  time: string,
  lastRunAt: string | null,
  now: Date = new Date(),
): number | null {
  if (cadence === "off") return null;
  const { h, m } = parseHhmm(time);
  const candidate = new Date(now);
  candidate.setHours(h, m, 0, 0);
  if (candidate.getTime() <= now.getTime()) {
    // Move forward to the next slot.
    candidate.setDate(candidate.getDate() + (cadence === "weekly" ? 7 : 1));
  }
  // For weekly cadence, align on the same weekday the LAST run happened on
  // if available; otherwise use today's weekday (fires within the week).
  if (cadence === "weekly" && lastRunAt) {
    const last = new Date(lastRunAt);
    if (!isNaN(last.getTime())) {
      const targetDow = last.getDay();
      while (candidate.getDay() !== targetDow) {
        candidate.setDate(candidate.getDate() + 1);
      }
    }
  }
  return candidate.getTime();
}

/**
 * Should we fire immediately on startup because we missed a slot while
 * the app was closed? Only if the last run is older than one full cadence
 * period, AND the app has been up for more than a grace window (so we
 * don't fire during a rapid restart loop).
 */
function shouldRunMissedOnStartup(settings: BackupSettings, now: Date): boolean {
  if (settings.cadence === "off") return false;
  const graceMs = 30_000;                        // 30 s of uptime before firing catch-up
  if (Date.now() - startupTime < graceMs) return false;
  if (!settings.lastRunAt) return true;          // never run -> fire now
  const last = new Date(settings.lastRunAt).getTime();
  if (isNaN(last)) return true;
  const period = settings.cadence === "weekly" ? 7 * 86_400_000 : 86_400_000;
  return now.getTime() - last > period;
}

async function runBackupNow(reason: "scheduled" | "catchup"): Promise<void> {
  const settings = readSettings();
  try {
    mkdirSync(settings.folder, { recursive: true });
  } catch (err) {
    logBackup(`[BACKUP] failed to create folder ${settings.folder}: ${(err as Error).message}`);
    set(KEYS.lastStatus, "failed");
    set(KEYS.lastError, `folder create failed: ${(err as Error).message}`);
    return;
  }

  const filename = scheduledBackupFilename();
  const outPath = join(settings.folder, filename);
  logBackup(`[BACKUP] ${reason} run starting -> ${outPath}`);
  try {
    const result = await withBackupLock(() => writeBackupToFile(outPath));
    logBackup(`[BACKUP] wrote ${outPath} (${result.bytes} bytes)`);
    set(KEYS.lastRunAt, new Date().toISOString());
    set(KEYS.lastStatus, "success");
    set(KEYS.lastError, "");
    set(KEYS.lastBytes, String(result.bytes));
    set("backup_last_filename", filename);
    pruneOldBackups(settings.folder, settings.retention);
  } catch (err) {
    const msg = (err as Error).message || String(err);
    logBackup(`[BACKUP] failed: ${msg}`);
    set(KEYS.lastRunAt, new Date().toISOString());
    set(KEYS.lastStatus, "failed");
    set(KEYS.lastError, msg);
    // Best-effort delete partial file.
    try { if (existsSync(outPath)) rmSync(outPath); } catch { /* ignore */ }
  }
}

function pruneOldBackups(folder: string, retention: number): void {
  try {
    const entries = readdirSync(folder, { withFileTypes: true })
      .filter((e) => e.isFile() && isBackupFilename(e.name))
      .map((e) => {
        const full = join(folder, e.name);
        return { full, name: e.name, mtime: statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime); // newest first
    if (entries.length <= retention) return;
    const toDelete = entries.slice(retention);
    for (const f of toDelete) {
      try {
        rmSync(f.full);
        logBackup(`[BACKUP] retention: deleted ${f.name}`);
      } catch { /* ignore */ }
    }
  } catch (err) {
    logBackup(`[BACKUP] retention sweep failed: ${(err as Error).message}`);
  }
}

function logBackup(line: string): void {
  // server.log capture is already wired through console; keep the
  // [BACKUP] prefix so it's greppable.
  try { console.log(line); } catch { /* ignore */ }
}

async function tick(): Promise<void> {
  const settings = readSettings();
  if (settings.cadence === "off") return;

  const now = new Date();
  if (computedNextRun == null) {
    computedNextRun = computeNextRun(settings.cadence, settings.time, settings.lastRunAt, now);
    if (shouldRunMissedOnStartup(settings, now)) {
      await runBackupNow("catchup");
      computedNextRun = computeNextRun(settings.cadence, settings.time, new Date().toISOString(), new Date());
    }
    return;
  }
  if (now.getTime() >= computedNextRun) {
    await runBackupNow("scheduled");
    computedNextRun = computeNextRun(settings.cadence, settings.time, new Date().toISOString(), new Date());
  }
}

/**
 * Start the scheduler. Idempotent -- safe to call multiple times.
 */
export function startBackupScheduler(): void {
  if (intervalHandle) return;
  startupTime = Date.now();
  computedNextRun = null;
  // First tick after 15 seconds so the app finishes booting before we
  // consider firing a catch-up backup.
  setTimeout(() => {
    void tick();
    intervalHandle = setInterval(() => { void tick(); }, 60_000);
  }, 15_000);
  logBackup("[BACKUP] scheduler armed");
}
