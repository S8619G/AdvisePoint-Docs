// v1.3.3: immutable archives + an atomically replaced role record.
// Old files are never overwritten. Only explicitly retired, owned files may
// be removed, after commit. A persisted pending record recovers interrupted runs.
import { closeSync, createReadStream, existsSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

export const PAIR_FOLDER = "AdvisePoint-Scheduled-Pair";
const RECORD = "pair-state.json";
const FILE = /^backup-[0-9T.Z-]+-[0-9a-f-]{36}\.zip(?:\.partial)?$/;
interface Copy { file: string; createdAt: string; sha256: string }
interface State {
  format: "advisepoint-backup-pair-v1";
  latest: Copy | null;
  previous: Copy | null;
  pending: string | null;
  retired: string[];
}
const emptyState = (): State => ({
  format: "advisepoint-backup-pair-v1", latest: null, previous: null, pending: null, retired: [],
});
function regular(path: string): void {
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink()) throw Error("Backup pair contains an unsafe file.");
}
function directory(folder: string): string {
  const dir = join(folder, PAIR_FOLDER);
  if (existsSync(dir)) {
    const s = lstatSync(dir);
    if (!s.isDirectory() || s.isSymbolicLink()) throw Error("Backup pair folder is not a regular directory.");
  }
  return dir;
}
function readState(dir: string): State {
  const path = join(dir, RECORD);
  if (!existsSync(path)) {
    if (existsSync(dir) && readdirSync(dir).length) {
      throw Error("Backup pair has no valid ownership record. Existing files were preserved; choose another folder or review diagnostics.");
    }
    return emptyState();
  }
  regular(path);
  const s = JSON.parse(readFileSync(path, "utf8")) as State;
  const validCopy = (c: Copy | null) => c === null || (
    c && FILE.test(c.file) && !c.file.endsWith(".partial") &&
    /^[0-9a-f]{64}$/.test(c.sha256) && Number.isFinite(Date.parse(c.createdAt))
  );
  if (s.format !== "advisepoint-backup-pair-v1" || !validCopy(s.latest) ||
      !validCopy(s.previous) || (s.pending !== null && (typeof s.pending !== "string" ||
      !FILE.test(s.pending) || s.pending.endsWith(".partial"))) ||
      !Array.isArray(s.retired) || s.retired.some(f => typeof f !== "string" || !FILE.test(f)) ||
      (s.latest && s.previous && s.latest.file === s.previous.file)) {
    throw Error("Backup pair record is invalid. Existing files were preserved.");
  }
  return s;
}
function writeState(dir: string, state: State): void {
  const temp = join(dir, `${RECORD}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx");
    writeFileSync(fd, JSON.stringify(state, null, 2));
    fsyncSync(fd); closeSync(fd); fd = undefined;
    // Same-directory rename: if replacement fails (for example a Windows
    // file lock), the old record and every referenced archive remain intact.
    renameSync(temp, join(dir, RECORD));
    // Directory fsync is supported on POSIX, not consistently on Windows.
    if (process.platform !== "win32") {
      const d = openSync(dir, "r");
      try { fsyncSync(d); } finally { closeSync(d); }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) rmSync(temp);
  }
}
async function digest(path: string): Promise<string> {
  regular(path);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
export function readBackupPairSummary(folder: string) {
  try {
    const state = readState(directory(folder));
    return {
      latest: state.latest, previous: state.previous,
      recovery_pending: !!state.pending || state.retired.length > 0,
      error: null as string | null,
    };
  } catch (e) {
    return { latest: null, previous: null, recovery_pending: true, error: (e as Error).message };
  }
}
type Options = {
  write: (path: string) => Promise<{ bytes: number }>;
  verify: (path: string) => Promise<{ ok: boolean; problems: string[] }>;
  // Fault injection for isolated tests; never controlled by environment/API.
  checkpoint?: (stage: string) => void;
};
const running = new Set<string>();
export async function runBackupPair(folder: string, options: Options) {
  const dir = resolve(directory(folder));
  if (running.has(dir)) throw Error("A backup pair rotation is already in progress.");
  running.add(dir);
  let candidate: string | null = null;
  try {
    mkdirSync(dir, { recursive: true });
    const old = readState(dir);
    const checkpoint = options.checkpoint ?? (() => {});
    // Verify a fallback before rotation. A damaged latest never replaces a
    // valid previous; failure to find a fallback stops automatic retirement.
    let fallback: Copy | null = null;
    for (const copy of [old.latest, old.previous]) {
      if (!copy) continue;
      try {
        if (await digest(join(dir, copy.file)) === copy.sha256 &&
            (await options.verify(join(dir, copy.file))).ok) { fallback = copy; break; }
      } catch { /* Try the other recorded recovery point. */ }
    }
    if ((old.latest || old.previous) && !fallback) {
      throw Error("Neither backup pair copy passed verification. Existing copies were preserved; review them before retrying.");
    }
    const createdAt = new Date().toISOString();
    candidate = `backup-${createdAt.replace(/:/g, "-")}-${randomUUID()}.zip`;
    // Record ownership BEFORE writing. A restarted run only retires this
    // abandoned generation after committing a new verified replacement.
    const abandoned = old.pending ? [old.pending, `${old.pending}.partial`] : [];
    const stagedState: State = { ...old, pending: candidate,
      retired: [...new Set([...old.retired, ...abandoned])] };
    writeState(dir, stagedState);
    checkpoint("intent");
    const partial = join(dir, `${candidate}.partial`);
    const result = await options.write(partial);
    regular(partial);
    const fd = openSync(partial, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    checkpoint("written");
    const verdict = await options.verify(partial);
    if (!verdict.ok) throw Error(`New backup did not pass verification: ${verdict.problems.join("; ")}`);
    const sha256 = await digest(partial);
    checkpoint("verified");
    renameSync(partial, join(dir, candidate));
    checkpoint("archive-promoted");
    const retired = [...new Set([
      ...stagedState.retired,
      ...[old.latest, old.previous].filter((c): c is Copy => !!c && c.file !== fallback?.file).map(c => c.file),
    ])].filter(f => f !== fallback?.file && f !== candidate);
    const committed: State = {
      format: old.format, latest: { file: candidate, createdAt, sha256 },
      previous: fallback, pending: null, retired,
    };
    writeState(dir, committed);
    checkpoint("committed");
    // Cleanup cannot turn a valid committed backup into a failed rotation.
    // Keep failed cleanup entries in the record for a later successful run.
    const remaining: string[] = [];
    for (const file of retired) {
      try {
        const path = join(dir, file);
        if (existsSync(path)) { regular(path); rmSync(path); }
      } catch { remaining.push(file); }
    }
    let cleanupPending = remaining.length > 0;
    try { writeState(dir, { ...committed, retired: remaining }); }
    catch { cleanupPending = true; }
    return { ...result, path: join(dir, candidate), filename: `${PAIR_FOLDER}/${candidate}`,
      cleanupPending };
  } catch (error) {
    // Leave the ownership intent for restart reconciliation, but reclaim this
    // run's incomplete candidate when possible. Never remove a committed file.
    if (candidate) {
      try {
        const current = readState(dir);
        if (current.latest?.file !== candidate && current.previous?.file !== candidate) {
          for (const name of [candidate, `${candidate}.partial`]) {
            const path = join(dir, name);
            try { if (existsSync(path)) { regular(path); rmSync(path); } } catch {}
          }
        }
      } catch { /* An unreadable record must not trigger deletion. */ }
    }
    throw error;
  } finally { running.delete(dir); }
}
