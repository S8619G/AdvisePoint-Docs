#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// scripts/align-doc-types.mjs
var import_better_sqlite3 = __toESM(require("better-sqlite3"), 1);
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");

// shared/doctype-case.ts
var LABEL_ACRONYMS = {
  API: "API",
  KB: "KB",
  MFP: "MFP",
  PDF: "PDF",
  OCR: "OCR",
  USB: "USB",
  RFID: "RFID",
  OEM: "OEM",
  FAQ: "FAQ",
  SDK: "SDK",
  UI: "UI",
  OS: "OS",
  IP: "IP",
  ID: "ID",
  HYPAS: "HyPAS",
  KCC: "KCC"
};
function hasDeliberateShape(word) {
  if (/\d/.test(word)) return true;
  const hasLower = /[a-z]/.test(word);
  const hasUpperAfterFirst = /[A-Z]/.test(word.slice(1));
  return hasLower && hasUpperAfterFirst;
}
function caseWord(word) {
  const m = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u.exec(word);
  if (!m) return word;
  const [, lead, core, trail] = m;
  if (!core) return word;
  const acronym = LABEL_ACRONYMS[core.toUpperCase()];
  if (acronym) return lead + acronym + trail;
  if (hasDeliberateShape(core)) return lead + core + trail;
  return lead + core.charAt(0).toUpperCase() + core.slice(1).toLowerCase() + trail;
}
function titleCaseLabel(input) {
  return String(input ?? "").trim().split(/\s+/).filter((w) => w.length > 0).map(caseWord).join(" ");
}

// scripts/align-doc-types.mjs
var argv = process.argv.slice(2);
function flag(name) {
  return argv.includes(name);
}
function opt(name, fallback = null) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
function defaultDbPath() {
  if (process.env.RAG_DB_PATH) return process.env.RAG_DB_PATH;
  const base = process.env.LOCALAPPDATA || process.env.APPDATA;
  if (!base) return null;
  const dir = (0, import_node_path.join)(base, "AdvisePoint Docs");
  for (const name of ["advisepoint.db", "rag.db"]) {
    const candidate = (0, import_node_path.join)(dir, name);
    if ((0, import_node_fs.existsSync)(candidate)) return candidate;
  }
  return (0, import_node_path.join)(dir, "advisepoint.db");
}
var dbPath = opt("--db") || defaultDbPath();
var APPLY = flag("--apply");
var DROP_INTO = opt("--drop-into", "misc");
var NO_BACKUP = flag("--no-backup");
if (!dbPath) {
  console.error(
    'Could not locate the database. Pass --db "<path to advisepoint.db>". Nothing was changed.'
  );
  process.exit(2);
}
if (!(0, import_node_fs.existsSync)(dbPath)) {
  console.error(
    `Database not found: ${dbPath}
Start AdvisePoint Docs once so the library is created, or pass --db "<path to advisepoint.db>". Nothing was changed.`
  );
  process.exit(2);
}
var MERGE_PAIRS = [
  { fromLabel: "User Manual", intoLabel: "User Guide" },
  { fromLabel: "Bulletin", intoLabel: "Technical Bulletin" }
];
var DROP_LABELS = ["API Reference", "KB Article"];
var db = new import_better_sqlite3.default(dbPath);
db.pragma("foreign_keys = ON");
var plan = [];
function note(action, detail) {
  plan.push({ action, ...detail });
}
var types = db.prepare("SELECT key, label FROM document_types ORDER BY sort_order").all();
var byLabel = new Map(types.map((t) => [t.label.toLowerCase(), t]));
function countsFor(key) {
  const d = db.prepare("SELECT COUNT(*) AS n FROM documents WHERE document_type = ?").get(key).n;
  const c = db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE document_type = ?").get(key).n;
  return { documents: d, chunks: c };
}
for (const t of types) {
  const fixed = titleCaseLabel(t.label);
  if (fixed !== t.label) {
    note("recase", { key: t.key, from: t.label, to: fixed });
  }
}
var merges = [];
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
var mapping = [];
try {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get("filename_code_mappings_v1");
  mapping = row?.value ? JSON.parse(row.value) : [];
  if (!Array.isArray(mapping)) mapping = [];
} catch {
  mapping = [];
}
var liveKeys = new Set(types.map((t) => t.key));
var mergeRedirect = new Map(merges.map((m) => [m.from.key, m.into.key]));
var danglingCodes = mapping.filter(
  (r) => !liveKeys.has(r.doc_type_key) && !mergeRedirect.has(r.doc_type_key)
);
var redirectedCodes = mapping.filter((r) => mergeRedirect.has(r.doc_type_key));
var W = 78;
console.log("=".repeat(W));
console.log(APPLY ? "ALIGN DOCUMENT TYPES  --  APPLYING" : "ALIGN DOCUMENT TYPES  --  DRY RUN (nothing will be written)");
console.log(`database: ${dbPath}`);
console.log("=".repeat(W));
var recases = plan.filter((p) => p.action === "recase");
console.log(`
1. LABEL CASING  (${recases.length} to fix)`);
if (recases.length === 0) console.log("   nothing to do");
for (const r of recases) console.log(`   ${r.from}  ->  ${r.to}`);
console.log(`
2. MERGES  (${merges.length})`);
if (merges.length === 0) console.log("   nothing to do");
for (const m of merges) {
  const tag = m.dropped ? " [removed from defaults]" : "";
  console.log(`   "${m.from.label}" -> "${titleCaseLabel(m.into.label)}"${tag}`);
  console.log(`       ${m.documents} document(s), ${m.chunks} chunk(s) re-tagged`);
}
console.log(`
3. FILENAME CODES`);
if (redirectedCodes.length === 0 && danglingCodes.length === 0) console.log("   nothing to do");
for (const r of redirectedCodes) {
  console.log(`   ${r.code}: ${r.doc_type_key} -> ${mergeRedirect.get(r.doc_type_key)} (follows merge)`);
}
for (const r of danglingCodes) {
  console.log(`   ${r.code}: ${r.doc_type_key} is missing -> mapping dropped`);
}
var totalDocs = merges.reduce((n, m) => n + m.documents, 0);
var totalChunks = merges.reduce((n, m) => n + m.chunks, 0);
console.log(`
TOTAL: ${recases.length} label(s) recased, ${merges.length} merge(s) affecting ${totalDocs} document(s) and ${totalChunks} chunk(s), ${redirectedCodes.length} code(s) re-pointed, ${danglingCodes.length} dropped.`);
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
if (!NO_BACKUP) {
  const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const backup = `${dbPath}.pre-align-${stamp}.bak`;
  (0, import_node_fs.copyFileSync)(dbPath, backup);
  console.log(`
Backup written: ${backup}`);
}
var tx = db.transaction(() => {
  for (const r of recases) {
    db.prepare("UPDATE document_types SET label = ? WHERE key = ?").run(r.to, r.key);
  }
  for (const m of merges) {
    db.prepare("UPDATE documents SET document_type = ? WHERE document_type = ?").run(m.into.key, m.from.key);
    db.prepare("UPDATE chunks SET document_type = ? WHERE document_type = ?").run(m.into.key, m.from.key);
    db.prepare("DELETE FROM document_types WHERE key = ?").run(m.from.key);
  }
  const nextMapping = mapping.filter((r) => !danglingCodes.some((d) => d.code === r.code)).map((r) => mergeRedirect.has(r.doc_type_key) ? { ...r, doc_type_key: mergeRedirect.get(r.doc_type_key) } : r);
  db.prepare(
    "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run("filename_code_mappings_v1", JSON.stringify(nextMapping));
});
tx();
var after = db.prepare("SELECT key, label FROM document_types ORDER BY label").all();
var stillWrong = after.filter((t) => titleCaseLabel(t.label) !== t.label);
var orphanDocs = db.prepare(
  "SELECT COUNT(*) AS n FROM documents WHERE document_type NOT IN (SELECT key FROM document_types)"
).get().n;
var orphanChunks = db.prepare(
  "SELECT COUNT(*) AS n FROM chunks WHERE document_type NOT IN (SELECT key FROM document_types)"
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
