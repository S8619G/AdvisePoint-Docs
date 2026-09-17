// v1.0.11.2: Persistent "last operation" status for the Quick backup and
// Restore panels. The scheduled-backup card already had a persistent
// last-run strip driven by the scheduler; this file gives the two
// manual cards the same treatment, stored in the same app_settings
// key/value table so it survives an app restart.

import { rawDb } from "./storage";

const KEYS = {
  quickBackup: {
    at: "manual_backup_last_at",
    status: "manual_backup_last_status",
    path: "manual_backup_last_path",
    bytes: "manual_backup_last_bytes",
    error: "manual_backup_last_error",
  },
  restore: {
    at: "manual_restore_last_at",
    status: "manual_restore_last_status",
    source: "manual_restore_last_source",
    error: "manual_restore_last_error",
  },
} as const;

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

function set(key: string, value: string | null): void {
  try {
    if (value === null || value === "") {
      rawDb.prepare("DELETE FROM app_settings WHERE key = ?").run(key);
      return;
    }
    rawDb.prepare(
      "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, value);
  } catch {
    // Non-fatal: the strip just won't update. The operation itself
    // has already completed.
  }
}

export interface QuickBackupLastOp {
  at: string | null;               // ISO timestamp
  status: "success" | "failed" | null;
  path: string | null;             // full path written on success
  bytes: number | null;            // ZIP size on success
  error: string | null;            // friendly text on failure
}

export interface RestoreLastOp {
  at: string | null;
  status: "success" | "failed" | null;
  source: string | null;           // filename or upload label
  error: string | null;
}

export function readQuickBackupLastOp(): QuickBackupLastOp {
  const bytesRaw = get(KEYS.quickBackup.bytes);
  const bytes = bytesRaw ? Number.parseInt(bytesRaw, 10) : null;
  return {
    at: get(KEYS.quickBackup.at),
    status: (get(KEYS.quickBackup.status) as "success" | "failed" | null) || null,
    path: get(KEYS.quickBackup.path),
    bytes: Number.isFinite(bytes) ? bytes : null,
    error: get(KEYS.quickBackup.error),
  };
}

export function writeQuickBackupLastOp(op: QuickBackupLastOp): void {
  set(KEYS.quickBackup.at, op.at);
  set(KEYS.quickBackup.status, op.status);
  set(KEYS.quickBackup.path, op.path);
  set(KEYS.quickBackup.bytes, op.bytes != null ? String(op.bytes) : null);
  set(KEYS.quickBackup.error, op.error);
}

export function readRestoreLastOp(): RestoreLastOp {
  return {
    at: get(KEYS.restore.at),
    status: (get(KEYS.restore.status) as "success" | "failed" | null) || null,
    source: get(KEYS.restore.source),
    error: get(KEYS.restore.error),
  };
}

export function writeRestoreLastOp(op: RestoreLastOp): void {
  set(KEYS.restore.at, op.at);
  set(KEYS.restore.status, op.status);
  set(KEYS.restore.source, op.source);
  set(KEYS.restore.error, op.error);
}
