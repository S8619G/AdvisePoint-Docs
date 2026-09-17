#!/usr/bin/env node
/**
 * v1.1.4: bring an EXISTING database in line with the cleaned-up shipping
 * defaults. The v1.1.4 changes to the seeded type list only affect a fresh
 * install, so an install created before it keeps its old rows. This reconciles
 * one.
 *
 * It does four things, in this order:
 *   1. Title Cases every document_types label       (technical bulletin -> Technical Bulletin)
 *   2. Merges the duplicate pairs                   (User Manual -> User Guide, Bulletin -> Technical Bulletin)
 *   3. Merges the dropped generic types             (API Reference, KB Article -> a target you choose)
 *   4. Prunes filename-code mappings that dangle
 *
 * DRY RUN BY DEFAULT. Nothing is written unless --apply is passed. The dry run
 * prints the exact per-type document and chunk counts so the effect is visible
 * before committing.
 *
 * Usage:
 *   node scripts/align-doc-types.mjs --db "<path to advisepoint.db>"
 *   node scripts/align-doc-types.mjs --db "<path to advisepoint.db>" --apply
 *
 * Options:
 *   --db <path>       path to the database file (defaults to the
 *                     LOCALAPPDATA copy the launcher creates)
 *   --apply           perform the changes (otherwise dry run)
 *   --drop-into <key> where documents on a dropped generic type land
 *                     (default: misc)
 *   --no-backup       skip the automatic pre-apply backup copy
 *
 * A timestamped copy of the database is written next to it before any change,
 * unless --no-backup is given. The original file is never removed.
 */
import Database from "better-sqlite3";
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { titleCaseLabel } from "../shared/doctype-case.ts";

// ------------------------------------------------------------------ args
const argv = process.argv.slice(2);
function flag(name) {
  return argv.includes(name);
}
function opt(name, fallback = null) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

// Fall back to the same location "Start AdvisePoint Docs.bat" uses, so the
// tool works when run directly with no arguments. The shipped database is
// named advisepoint.db; rag.db is the older development name.
function defaultDbPath() {
  if (process.env.RAG_DB_PATH) return process.env.RAG_DB_PATH;
  const base = process.env.LOCALAPPDATA || process.env.APPDATA;
  if (!base) return null;
  const dir = join(base, "AdvisePoint Docs");
  for (const name of ["advisepoint.db", "rag.db"]) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return join(dir, "advisepoint.db");
}

const dbPath = opt("--db") || defaultDbPath();
const APPLY = flag("--apply");
const DROP_INTO = opt("--drop-into", "misc");
const NO_BACKUP = flag("--no-backup");

if (!dbPath) {
  console.error(
    'Could not locate the database. Pass --db "<path to advisepoint.db>". ' +
      "Nothing was changed.",
  );
  process.exit(2);
}
if (!existsSync(dbPath)) {
  console.error(
    `Database not found: ${dbPath}\n` +
      "Start AdvisePoint Docs once so the library is created, or pass " +
      '--db "<path to advisepoint.db>". Nothing was changed.',
  );
  process.exit(2);
}

/** Duplicate pairs, expressed as labels so they match regardless of casing.
 *  Direction was chosen to keep the names that match the filename codes. */
const MERGE_PAIRS = [
  { fromLabel: "User Manual", intoLabel: "User Guide" },
  { fromLabel: "Bulletin", intoLabel: "Technical Bulletin" },
];

/** Types removed from the shipping defaults. */
const DROP_LABELS = ["API Reference", "KB Article"];

const db = new Database(dbPath);
db.pragma("foreign_keys = ON");

const plan = [];
function note(action, detail) {
  plan.push({ action, ...detail });
}

// --------------------------------------------------------------- inspect
const types = db.prepare("SELECT key, label FROM document_types ORDER BY sort_order").all();
const byLabel = new Map(types.map((t) => [t.label.toLowerCase(), t]));

function countsFor(key) {
  const d = db.prepare("SELECT COUNT(*) AS n FROM documents WHERE document_type = ?").get(key).n;
  const c = db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE document_type = ?").get(key).n;
  return { documents: d, chunks: c };
}

// 1. casing
for (const t of types) {
  const fixed = titleCaseLabel(t.label);
  if (fixed !== t.label) {
    note("recase", { key: t.key, from: t.label, to: fixed });
  }
}

// 2 + 3. merges. Resolved by label so they work whatever the current casing is.
const merges = [];
for (const { fromLabel, intoLabel } of MERGE_PAIRS) {
  const from = byLabel.get(fromLabel.toLowerCase());
  const into = byLabel.get(intoLabel.toLowerCase());
  if (!from) continue;
  if (!into) {
    note("skip", { key: from.key, why: `target "${intoLabel}" does not exist in this database` });
    continue;
  }
  if (from.key === into.key) continue;
  merges.push({ from, into, ...countsFor(from.key) });
}
for (const label of DROP_LABELS) {
  const from = byLabel.get(label.toLowerCase());
  if (!from) continue;
  const into = types.find((t) => t.key === DROP_INTO);
  if (!into) {
    note("skip", { key: from.key, why: `--drop-into target "${DROP_INTO}" does not exist` });
    continue;
  }
  if (from.key === into.key) continue;
  merges.push({ from, into, dropped: true, ...countsFor(from.key) });
}

// 4. dangling codes
let mapping = [];
try {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get("filename_code_mappings_v1");
  mapping = row?.value ? JSON.parse(row.value) : [];
  if (!Array.isArray(mapping)) mapping = [];
} catch {
  mapping = [];
}
const liveKeys = new Set(types.map((t) => t.key));
// A code pointing at something we are about to merge away is re-pointed, not dropped.
const mergeRedirect = new Map(merges.map((m) => [m.from.key, m.into.key]));
const danglingCodes = mapping.filter(
  (r) => !liveKeys.has(r.doc_type_key) && !mergeRedirect.has(r.doc_type_key),
);
const redirectedCodes = mapping.filter((r) => mergeRedirect.has(r.doc_type_key));

// ------------------------------------------------------------------ report
const W = 78;
console.log("=".repeat(W));
console.log(APPLY ? "ALIGN DOCUMENT TYPES  --  APPLYING" : "ALIGN DOCUMENT TYPES  --  DRY RUN (nothing will be written)");
console.log(`database: ${dbPath}`);
console.log("=".repeat(W));

const recases = plan.filter((p) => p.action === "recase");
console.log(`\n1. LABEL CASING  (${recases.length} to fix)`);
if (recases.length === 0) console.log("   nothing to do");
for (const r of recases) console.log(`   ${r.from}  ->  ${r.to}`);

console.log(`\n2. MERGES  (${merges.length})`);
if (merges.length === 0) console.log("   nothing to do");
for (const m of merges) {
  const tag = m.dropped ? " [removed from defaults]" : "";
  // Show the target under its POST-recase label; step 1 runs first, so
  // printing the stored label here would show the old casing.
  console.log(`   "${m.from.label}" -> "${titleCaseLabel(m.into.label)}"${tag}`);
  console.log(`       ${m.documents} document(s), ${m.chunks} chunk(s) re-tagged`);
}

console.log(`\n3. FILENAME CODES`);
if (redirectedCodes.length === 0 && danglingCodes.length === 0) console.log("   nothing to do");
for (const r of redirectedCodes) {
  console.log(`   ${r.code}: ${r.doc_type_key} -> ${mergeRedirect.get(r.doc_type_key)} (follows merge)`);
}
for (const r of danglingCodes) {
  console.log(`   ${r.code}: ${r.doc_type_key} is missing -> mapping dropped`);
}

const totalDocs = merges.reduce((n, m) => n + m.documents, 0);
const totalChunks = merges.reduce((n, m) => n + m.chunks, 0);
console.log(`\nTOTAL: ${recases.length} label(s) recased, ${merges.length} merge(s) affecting ` +
  `${totalDocs} document(s) and ${totalChunks} chunk(s), ` +
  `${redirectedCodes.length} code(s) re-pointed, ${danglingCodes.length} dropped.`);

if (!APPLY) {
  console.log("\nDry run only. Re-run with --apply to make these changes.");
  db.close();
  process.exit(0);
}

if (recases.length === 0 && merges.length === 0 && redirectedCodes.length === 0 && danglingCodes.length === 0) {
  console.log("\nAlready aligned. Nothing written.");
  db.close();
  process.exit(0);
}

// ------------------------------------------------------------------ apply
if (!NO_BACKUP) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${dbPath}.pre-align-${stamp}.bak`;
  copyFileSync(dbPath, backup);
  console.log(`\nBackup written: ${backup}`);
}

const tx = db.transaction(() => {
  for (const r of recases) {
    db.prepare("UPDATE document_types SET label = ? WHERE key = ?").run(r.to, r.key);
  }
  for (const m of merges) {
    db.prepare("UPDATE documents SET document_type = ? WHERE document_type = ?").run(m.into.key, m.from.key);
    db.prepare("UPDATE chunks SET document_type = ? WHERE document_type = ?").run(m.into.key, m.from.key);
    db.prepare("DELETE FROM document_types WHERE key = ?").run(m.from.key);
  }
  const nextMapping = mapping
    .filter((r) => !danglingCodes.some((d) => d.code === r.code))
    .map((r) => (mergeRedirect.has(r.doc_type_key)
      ? { ...r, doc_type_key: mergeRedirect.get(r.doc_type_key) }
      : r));
  db.prepare(
    "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run("filename_code_mappings_v1", JSON.stringify(nextMapping));
});
tx();

// ----------------------------------------------------------------- verify
const after = db.prepare("SELECT key, label FROM document_types ORDER BY label").all();
const stillWrong = after.filter((t) => titleCaseLabel(t.label) !== t.label);
const orphanDocs = db.prepare(
  "SELECT COUNT(*) AS n FROM documents WHERE document_type NOT IN (SELECT key FROM document_types)",
).get().n;
const orphanChunks = db.prepare(
  "SELECT COUNT(*) AS n FROM chunks WHERE document_type NOT IN (SELECT key FROM document_types)",
).get().n;

console.log("\nVERIFICATION");
console.log(`   ${after.length} document type(s) remain`);
console.log(`   ${stillWrong.length} label(s) still mis-cased`);
console.log(`   ${orphanDocs} document(s) and ${orphanChunks} chunk(s) reference a missing type`);

if (stillWrong.length > 0 || orphanDocs > 0 || orphanChunks > 0) {
  console.error("\nVerification FAILED. The backup copy is unchanged; restore it if needed.");
  db.close();
  process.exit(1);
}

console.log("\nFinal document types:");
for (const t of after) console.log(`   ${t.label}`);
console.log("\nDone.");
db.close();
