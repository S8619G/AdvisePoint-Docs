// Isolated filesystem fault tests. No production database or backup is opened.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { runBackupPair, readBackupPairSummary, PAIR_FOLDER } from "../server/backup-pair.ts";
const record = f => JSON.parse(readFileSync(join(f, PAIR_FOLDER, "pair-state.json"), "utf8"));
function fixture() {
  const folder = mkdtempSync(join(tmpdir(), "apd-pair-test-"));
  let n = 0;
  const options = {
    write: async p => { writeFileSync(p, `valid-${++n}`); return { bytes: 7 }; },
    verify: async p => ({ ok: readFileSync(p, "utf8").startsWith("valid-"), problems: ["injected invalid content"] }),
  };
  return { folder, options, close: () => rmSync(folder, { recursive: true, force: true }) };
}
test("first/second/repeated rotations retain exactly two distinct recovery points", async () => {
  const f = fixture();
  try {
    await runBackupPair(f.folder, f.options);
    assert.equal(record(f.folder).previous, null);
    const first = record(f.folder).latest;
    await runBackupPair(f.folder, f.options);
    assert.deepEqual(record(f.folder).previous, first);
    const second = record(f.folder).latest;
    await runBackupPair(f.folder, f.options);
    const s = record(f.folder);
    assert.deepEqual(s.previous, second);
    assert.equal(readFileSync(join(f.folder, PAIR_FOLDER, s.latest.file), "utf8"), "valid-3");
    assert.equal(readFileSync(join(f.folder, PAIR_FOLDER, s.previous.file), "utf8"), "valid-2");
    assert.equal(readdirSync(join(f.folder, PAIR_FOLDER)).filter(x => x.endsWith(".zip")).length, 2);
    assert.equal(readBackupPairSummary(f.folder).recovery_pending, false);
  } finally { f.close(); }
});
for (const stage of ["intent", "written", "verified", "archive-promoted", "committed"]) {
  test(`failure at ${stage} preserves recovery points and next run reconciles`, async () => {
    const f = fixture();
    try {
      await runBackupPair(f.folder, f.options); await runBackupPair(f.folder, f.options);
      const before = record(f.folder);
      await assert.rejects(runBackupPair(f.folder, { ...f.options,
        checkpoint: s => { if (s === stage) throw Error("simulated interruption"); },
      }), /interruption/);
      for (const c of [before.latest, before.previous])
        assert.ok(readFileSync(join(f.folder, PAIR_FOLDER, c.file)).length);
      await runBackupPair(f.folder, f.options);
      assert.equal(readBackupPairSummary(f.folder).recovery_pending, false);
      assert.equal(readdirSync(join(f.folder, PAIR_FOLDER)).filter(x => x.endsWith(".zip")).length, 2);
    } finally { f.close(); }
  });
  test(`process exit at ${stage} recovers from persisted intent/commit`, async () => {
    const f = fixture();
    try {
      await runBackupPair(f.folder, f.options); await runBackupPair(f.folder, f.options);
      const code = `
        import {runBackupPair} from './server/backup-pair.ts';
        import {writeFileSync,readFileSync} from 'node:fs';
        await runBackupPair(${JSON.stringify(f.folder)}, {
          write: async p => {writeFileSync(p,'valid-child'); return {bytes:11}},
          verify: async p => ({ok:readFileSync(p,'utf8').startsWith('valid-'),problems:[]}),
          checkpoint: s => {if(s === ${JSON.stringify(stage)})process.exit(29)}
        });`;
      const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
        cwd: resolve(import.meta.dirname, ".."), encoding: "utf8",
      });
      assert.equal(child.status, 29, child.stderr);
      await runBackupPair(f.folder, f.options);
      const s = record(f.folder);
      assert.ok(s.latest && s.previous); assert.equal(s.pending, null);
      assert.equal(s.retired.length, 0);
      assert.equal(readdirSync(join(f.folder, PAIR_FOLDER)).filter(x => x.endsWith(".zip")).length, 2);
    } finally { f.close(); }
  });
}
test("invalid candidate and disk-full write keep both old copies", async () => {
  const f = fixture();
  try {
    await runBackupPair(f.folder, f.options); await runBackupPair(f.folder, f.options);
    const old = record(f.folder);
    await assert.rejects(runBackupPair(f.folder, { ...f.options,
      write: async p => { writeFileSync(p, "bad"); return {bytes:3}; },
    }), /verification/);
    await assert.rejects(runBackupPair(f.folder, { ...f.options,
      write: async p => { writeFileSync(p, "partial"); throw Error("ENOSPC disk full"); },
    }), /ENOSPC/);
    for (const role of ["latest", "previous"]) assert.deepEqual(record(f.folder)[role], old[role]);
  } finally { f.close(); }
});
test("damaged latest cannot replace valid previous; two damaged copies stop rotation", async () => {
  const f = fixture();
  try {
    await runBackupPair(f.folder, f.options); await runBackupPair(f.folder, f.options);
    const old = record(f.folder);
    writeFileSync(join(f.folder, PAIR_FOLDER, old.latest.file), "damaged");
    await runBackupPair(f.folder, f.options);
    assert.deepEqual(record(f.folder).previous, old.previous);
    for (const c of [record(f.folder).latest, record(f.folder).previous])
      writeFileSync(join(f.folder, PAIR_FOLDER, c.file), "damaged");
    const before = readFileSync(join(f.folder, PAIR_FOLDER, "pair-state.json"));
    await assert.rejects(runBackupPair(f.folder, f.options), /Neither/);
    assert.deepEqual(readFileSync(join(f.folder, PAIR_FOLDER, "pair-state.json")), before);
  } finally { f.close(); }
});
test("manual/historical and unowned files are never pruned", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.folder, "advisepoint-docs-backup-20200101-000000.zip"), "manual");
    await runBackupPair(f.folder, f.options);
    writeFileSync(join(f.folder, PAIR_FOLDER, "personal-master.zip"), "master");
    for (let i=0;i<4;i++) await runBackupPair(f.folder, f.options);
    assert.equal(readFileSync(join(f.folder, "advisepoint-docs-backup-20200101-000000.zip"), "utf8"), "manual");
    assert.equal(readFileSync(join(f.folder, PAIR_FOLDER, "personal-master.zip"), "utf8"), "master");
  } finally { f.close(); }
});
test("concurrent runs refuse before creating a competing candidate", async () => {
  const f = fixture(); let release;
  try {
    const pause = new Promise(r => release=r);
    const first = runBackupPair(f.folder, { ...f.options, write: async p => { await pause; return f.options.write(p); } });
    await assert.rejects(runBackupPair(f.folder, f.options), /already in progress/);
    release(); await first;
    assert.equal(record(f.folder).previous, null);
  } finally { release?.(); f.close(); }
});
test("unowned directory, corrupt record and unsafe directory are rejected without deletion", async () => {
  for (const kind of ["unowned", "corrupt", "symlink"]) {
    const f = fixture();
    try {
      const dir = join(f.folder, PAIR_FOLDER);
      if (kind === "symlink") { mkdirSync(join(f.folder,"other")); symlinkSync(join(f.folder,"other"), dir); }
      else { mkdirSync(dir); writeFileSync(join(dir, kind === "corrupt" ? "pair-state.json" : "mine.txt"), "do not delete"); }
      await assert.rejects(runBackupPair(f.folder, f.options));
      assert.equal(readBackupPairSummary(f.folder).recovery_pending, true);
    } finally { f.close(); }
  }
});
