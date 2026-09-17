// v1.2.3: restore side-file. A tiny JSON file written next to the data
// directory (NOT inside it), so it survives a wipe-and-replace restore
// that swaps the entire data folder -- including the SQLite database
// that holds `app_settings`, which is where readRestoreLastOp() records
// live.
//
// WHY THIS IS SEPARATE FROM server/backup-lastop.ts
// backup-lastop.ts persists last-op status inside app_settings so the
// Backup & Restore panel can render its "last op" strip across normal
// restarts. Wipe-restore replaces the whole app_settings table with the
// contents of the restored backup, so that record disappears exactly
// when the user most needs to see it -- the moment after the restore
// finishes and the app relaunches into a database whose contents are
// older than the operation that just happened.
//
// WHY THE SIDE FILE LIVES BESIDE THE DATA DIR
// The wipe path moves the entire data dir aside to `${dataDir}.bak-<ts>`
// (see server/backup.ts:713) and installs a verified fresh copy in its
// place. Anything INSIDE dataDir goes with the swap. The parent of
// dataDir is untouched, so `${dataDir}.last-op.json` -- sibling of the
// swapped folder, same naming pattern as the `.bak-<ts>` folders -- is
// preserved verbatim across the swap.
//
// SEMANTICS
// The banner logic on the client owns "seen / dismissed". This module
// only produces and consumes the fact of a completed restore. It writes
// one file per restore success; readAndClear() returns whatever's there
// exactly once, then deletes it. Anything writable that can't be written
// or read is treated as "no record" -- the app's restore itself already
// succeeded and the last-op strip in app_settings still exists for
// merge-mode restores.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { getDataDirForBackup } from "./storage";

const SIDEFILE_SUFFIX = ".last-op.json";
const LOG_PREFIX = "[restore-sidefile]";

export type RestoreMode = "wipe" | "merge";

export interface RestoreSideRecord {
  /** ISO timestamp when the restore completed on the server. */
  at: string;
  /** Which import mode was used. Determines the banner copy. */
  mode: RestoreMode;
  /** Original upload filename or path, for display only. Never used to open anything. */
  source: string | null;
  /** Documents present in the restored library, if the server can report it. */
  documents: number | null;
  /** Chunks present in the restored library, if the server can report it. */
  chunks: number | null;
  /**
   * Path to the pre-restore `.bak-<ts>` snapshot (wipe-restore only).
   * The banner surfaces this so the user can find it without opening
   * Recovery.
   */
  bak_dir: string | null;
  /**
   * v1.2.3 file format tag. Kept so future readers can refuse a record
   * whose shape they don't recognize instead of guessing.
   */
  v: 1;
}

function sidefilePath(): string {
  // NOT `join(dataDir, "last-op.json")` -- that would live inside the
  // folder wipe-restore swaps out. Use the same sibling pattern the
  // .bak folders use: append the suffix to the data dir path itself.
  return `${getDataDirForBackup()}${SIDEFILE_SUFFIX}`;
}

/**
 * Write the side file. Non-fatal on any failure: the restore itself has
 * already completed, and the app_settings-backed last-op record still
 * exists for the merge path.
 */
export function writeRestoreSidefile(record: Omit<RestoreSideRecord, "v">): void {
  const full: RestoreSideRecord = { ...record, v: 1 };
  try {
    writeFileSync(sidefilePath(), JSON.stringify(full, null, 2), "utf8");
  } catch (err) {
    console.error(`${LOG_PREFIX} failed to write ${sidefilePath()}:`, err);
  }
}

/**
 * Read the side file if present and return the record. Does not delete
 * the file -- callers that want the "show exactly once" semantic should
 * use `readAndClearRestoreSidefile()` below.
 */
export function readRestoreSidefile(): RestoreSideRecord | null {
  const p = sidefilePath();
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as Partial<RestoreSideRecord>;
    if (!parsed || parsed.v !== 1 || typeof parsed.at !== "string" || (parsed.mode !== "wipe" && parsed.mode !== "merge")) {
      // Unknown/corrupted record: drop it so we don't loop on a bad file.
      console.warn(`${LOG_PREFIX} discarding unrecognized record at ${p}`);
      try { rmSync(p, { force: true }); } catch { /* best effort */ }
      return null;
    }
    return {
      at: parsed.at,
      mode: parsed.mode,
      source: parsed.source ?? null,
      documents: typeof parsed.documents === "number" ? parsed.documents : null,
      chunks: typeof parsed.chunks === "number" ? parsed.chunks : null,
      bak_dir: parsed.bak_dir ?? null,
      v: 1,
    };
  } catch (err) {
    console.error(`${LOG_PREFIX} failed to read ${p}:`, err);
    return null;
  }
}

/**
 * Read the side file and remove it in the same call. The client uses
 * this for the first-launch banner: showing the banner consumes the
 * record so the banner does not reappear on every launch after that.
 */
export function readAndClearRestoreSidefile(): RestoreSideRecord | null {
  const rec = readRestoreSidefile();
  if (!rec) return null;
  try {
    rmSync(sidefilePath(), { force: true });
  } catch (err) {
    // Not fatal for correctness -- the read succeeded, and a stuck
    // banner is preferable to failing to surface the info. Log so this
    // shows up in diagnostics if the FS is read-only.
    console.error(`${LOG_PREFIX} failed to clear ${sidefilePath()}:`, err);
  }
  return rec;
}

/**
 * Clear the side file without reading. Used by the "dismiss" endpoint
 * so the user can suppress the banner from the UI even if the app
 * happens to reload the panel afterwards.
 */
export function clearRestoreSidefile(): void {
  try {
    rmSync(sidefilePath(), { force: true });
  } catch (err) {
    console.error(`${LOG_PREFIX} failed to clear ${sidefilePath()}:`, err);
  }
}
