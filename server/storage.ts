import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { documents, chunks, DOCUMENT_TYPES } from "@shared/schema";
import type { Document, Chunk } from "@shared/schema";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Resolve database location:
//   1. RAG_DB_PATH env var wins (absolute path) -- this is what the shipped
//      launcher sets, so the fallback below is dev-only.
//   2. Windows: %APPDATA%\AdvisePoint Docs\data.db
//   3. macOS/Linux: ~/.advisepoint-docs/data.db
//   4. Fallback: ./data.db (dev only)
//
// v0.9.35: fallback names renamed from RAG-Explorer / .rag-explorer as part
// of the AdvisePoint Docs rename effort. The env-var name (RAG_DB_PATH) is
// intentionally kept to preserve backward compatibility with launchers from
// v0.9.29 through v0.9.34 that all set it -- renaming that env var would
// break in-place upgrades that use an older launcher shell around a newer
// dist bundle.
function resolveDbPath(): string {
  if (process.env.RAG_DB_PATH) return process.env.RAG_DB_PATH;
  const home = process.env.APPDATA || process.env.HOME || process.env.USERPROFILE;
  if (home) {
    return process.platform === "win32"
      ? join(home, "AdvisePoint Docs", "data.db")
      : join(home, ".advisepoint-docs", "data.db");
  }
  return "data.db";
}

const DB_PATH = resolveDbPath();
try {
  mkdirSync(dirname(DB_PATH), { recursive: true });
} catch {
  // ignore — will surface on Database() open if truly broken
}

// First-run seed: if no user DB exists yet, copy the shipped seed.db so users
// see documents / search working immediately. Skip if RAG_NO_SEED=1 (used when
// generating the seed DB itself).
function findSeedDb(): string | null {
  if (process.env.RAG_NO_SEED === "1") return null;
  // Candidates, in preference order:
  //   1. RAG_SEED_DB env var
  //   2. ./seed.db next to the running executable (dist/ or project root)
  //   3. ./resources/seed.db (for packaged installer layouts)
  const candidates: string[] = [];
  if (process.env.RAG_SEED_DB) candidates.push(process.env.RAG_SEED_DB);
  // dist/index.cjs lives one level below project root when built
  const runDir = process.cwd();
  candidates.push(join(runDir, "seed.db"));
  candidates.push(join(runDir, "resources", "seed.db"));
  candidates.push(resolve(runDir, "..", "seed.db"));
  for (const c of candidates) {
    if (existsSync(c)) {
      try {
        const st = statSync(c);
        if (st.isFile() && st.size > 0) return c;
      } catch { /* ignore */ }
    }
  }
  return null;
}

// v0.9.7 — the seed bundle can also ship a `pages/` folder next to seed.db
// with pre-rendered page JPEGs for the preloaded docs. If we seeded the DB, we
// also want the page images available immediately so field techs don't wait 40s
// on first launch for the big Operation Guide to render.
function seedPagesDir(seedPath: string): string {
  // Look for a `pages/` sibling to seed.db. Fine to be missing.
  return join(dirname(seedPath), "pages");
}

function copyDirRecursive(src: string, dst: string): void {
  const { mkdirSync, readdirSync, copyFileSync: copyOne, statSync: st } = require("node:fs");
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dst, entry);
    const info = st(s);
    if (info.isDirectory()) copyDirRecursive(s, d);
    else if (info.isFile()) copyOne(s, d);
  }
}

// Deferred so we can update image_paths after opening the DB below.
let _seededPagesFrom: string | null = null;
if (!existsSync(DB_PATH)) {
  const seed = findSeedDb();
  if (seed) {
    try {
      copyFileSync(seed, DB_PATH);
      console.log(`[storage] seeded ${DB_PATH} from ${seed}`);
      const seededPages = seedPagesDir(seed);
      if (existsSync(seededPages)) {
        const targetPagesDir = process.env.RAG_PAGES_DIR ?? join(dirname(DB_PATH), "pages");
        try {
          copyDirRecursive(seededPages, targetPagesDir);
          _seededPagesFrom = targetPagesDir;
          console.log(`[storage] seeded page images to ${targetPagesDir}`);
        } catch (err) {
          console.error("[storage] failed to copy seed pages:", err);
        }
      }
    } catch (err) {
      console.error(`[storage] failed to copy seed DB from ${seed}:`, err);
    }
  }
}

console.log(`[storage] using database at ${DB_PATH}`);

const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
export const db = drizzle(sqlite);
export const rawDb = sqlite;

// v1.0.3: exported so the backup/restore module can locate the DB file
// (for VACUUM INTO staging) and the sibling pages/ directory. The pages
// dir mirror of pages.ts's getPagesDir() is kept simple here to avoid a
// circular import.
export const DB_FILE_PATH = DB_PATH;
export function getPagesDirForBackup(): string {
  return process.env.RAG_PAGES_DIR ?? join(dirname(DB_PATH), "pages");
}
export function getDataDirForBackup(): string {
  // The folder that contains data.db and (by default) pages/. Backup
  // and restore stage new content next to this folder.
  return dirname(DB_PATH);
}

// Bootstrap tables if they don't exist (drizzle-kit push not available at runtime).
sqlite.exec(`
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  subtitle TEXT,
  document_type TEXT NOT NULL,
  audience_json TEXT NOT NULL DEFAULT '[]',
  language TEXT NOT NULL DEFAULT 'en-US',
  summary TEXT,
  product_family TEXT,
  product_model TEXT NOT NULL,
  product_sku TEXT,
  product_version TEXT,
  firmware_version TEXT,
  platform_json TEXT NOT NULL DEFAULT '[]',
  region_json TEXT NOT NULL DEFAULT '[]',
  release_channel TEXT,
  lifecycle_status TEXT NOT NULL DEFAULT 'published',
  published_at TEXT,
  updated_at TEXT NOT NULL,
  confidentiality TEXT NOT NULL DEFAULT 'internal',
  allowed_tenants_json TEXT NOT NULL DEFAULT '[]',
  source_uri TEXT,
  source_system TEXT,
  file_name TEXT,
  file_hash_sha256 TEXT,
  ingested_at TEXT NOT NULL,
  pipeline_version TEXT NOT NULL DEFAULT 'advisepoint-docs-1.0.0',
  tags_json TEXT NOT NULL DEFAULT '[]',
  keywords_json TEXT NOT NULL DEFAULT '[]',
  title_color TEXT,
  total_chunks INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL,
  content TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'prose',
  language TEXT NOT NULL DEFAULT 'en-US',
  section_path_json TEXT NOT NULL DEFAULT '[]',
  section_id TEXT,
  section_title TEXT,
  heading_level INTEGER,
  page_start INTEGER,
  page_end INTEGER,
  chunk_index INTEGER NOT NULL,
  document_type TEXT NOT NULL,
  product_model TEXT NOT NULL,
  product_version TEXT,
  firmware_version TEXT,
  audience_json TEXT NOT NULL DEFAULT '[]',
  confidentiality TEXT NOT NULL DEFAULT 'internal',
  allowed_tenants_json TEXT NOT NULL DEFAULT '[]',
  lifecycle_status TEXT NOT NULL DEFAULT 'published',
  updated_at TEXT NOT NULL,
  error_codes_json TEXT NOT NULL DEFAULT '[]',
  cli_commands_json TEXT NOT NULL DEFAULT '[]',
  ui_paths_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  embedding_json TEXT NOT NULL DEFAULT '{}',
  token_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_chunks_parent ON chunks(parent_id);
CREATE INDEX IF NOT EXISTS idx_chunks_product ON chunks(product_model);
CREATE INDEX IF NOT EXISTS idx_chunks_doctype ON chunks(document_type);
CREATE INDEX IF NOT EXISTS idx_chunks_lifecycle ON chunks(lifecycle_status);

-- Page renders (v0.9.7). Each row is one rendered page image sitting on disk
-- under RAG_PAGES_DIR/<document_id>/pNNNN.jpg. The DB stays small; images are
-- sidecar files so backups can exclude them cheaply if needed.
CREATE TABLE IF NOT EXISTS document_pages (
  document_id TEXT NOT NULL,
  page_number INTEGER NOT NULL,
  image_path TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  generated_at TEXT NOT NULL,
  PRIMARY KEY (document_id, page_number)
);
CREATE INDEX IF NOT EXISTS idx_pages_doc ON document_pages(document_id);

-- Render-job status. One row per doc; upserted as the background renderer
-- makes progress. status ∈ {pending, rendering, ready, error, missing}.
--
-- v1.0.4 added failed_pages (JSON array of page numbers that failed) and
-- first_failed_page for the header render-status indicator's failure list.
-- Old rows without these columns are patched via ALTER TABLE below.
CREATE TABLE IF NOT EXISTS document_render_status (
  document_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  rendered INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated_at TEXT NOT NULL,
  failed_pages TEXT,
  first_failed_page INTEGER
);

-- v0.9.33: user-managed document type registry. Documents continue storing
-- the stable key directly so existing search/filter behavior remains intact.
CREATE TABLE IF NOT EXISTS document_types (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL COLLATE NOCASE UNIQUE,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

const BUILTIN_DOCUMENT_TYPE_LABELS: Record<string, string> = {
  document: "Document",
  brochures: "Brochures",
  user_manual: "User manual",
  admin_guide: "Admin guide",
  installation_guide: "Installation guide",
  quick_start: "Quick start",
  release_notes: "Release notes",
  api_reference: "API reference",
  troubleshooting_guide: "Troubleshooting guide",
  security_guide: "Security guide",
  procedures: "Procedures",
  kb_article: "KB article",
  bulletin: "Bulletin",
  pricing: "Pricing",
  misc: "Miscellaneous",
};

(function initializeDocumentTypes() {
  const insert = sqlite.prepare(`
    INSERT OR IGNORE INTO document_types (key, label, is_builtin, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  const tx = sqlite.transaction(() => {
    DOCUMENT_TYPES.forEach((key, index) => {
      insert.run(key, BUILTIN_DOCUMENT_TYPE_LABELS[key] ?? key.replace(/_/g, " "), 1, index, now);
    });
    const historical = sqlite.prepare(`
      SELECT DISTINCT document_type AS key FROM documents
      UNION SELECT DISTINCT document_type AS key FROM chunks
    `).all() as { key: string }[];
    let nextOrder = (sqlite.prepare("SELECT COALESCE(MAX(sort_order), -1) AS n FROM document_types").get() as { n: number }).n + 1;
    for (const row of historical) {
      const key = String(row.key || "").trim();
      if (!key) continue;
      insert.run(key, key.replace(/_/g, " "), 0, nextOrder++, now);
    }
    sqlite.prepare(`
      INSERT OR IGNORE INTO app_settings (key, value)
      VALUES ('document_type_sort_mode', 'importance')
    `).run();
  });
  tx();
})();

// -------- v0.9.30: incremental column migrations --------
// SQLite lets us add columns to existing tables without a full rebuild.
// We check PRAGMA table_info to see if a column already exists before running
// the ALTER, so this is safe to run on both fresh databases (column was in the
// CREATE TABLE above) and upgraded ones (column added here).
(function migrateAddColumns() {
  const cols = sqlite.prepare("PRAGMA table_info(documents)").all() as { name: string }[];
  const have = new Set(cols.map((c) => c.name));
  const wanted: { col: string; ddl: string }[] = [
    { col: "title_color", ddl: "ALTER TABLE documents ADD COLUMN title_color TEXT" },
  ];
  for (const w of wanted) {
    if (!have.has(w.col)) {
      try {
        sqlite.exec(w.ddl);
        console.log(`[storage] added column documents.${w.col}`);
      } catch (err) {
        console.error(`[storage] failed to add documents.${w.col}:`, err);
      }
    }
  }
  // v0.9.36: per-document-type accent color. NULL means "no color assigned",
  // which is the safe default for existing databases where users haven't
  // customized any type colors yet.
  const dtCols = sqlite.prepare("PRAGMA table_info(document_types)").all() as { name: string }[];
  const dtHave = new Set(dtCols.map((c) => c.name));
  if (!dtHave.has("color")) {
    try {
      sqlite.exec("ALTER TABLE document_types ADD COLUMN color TEXT");
      console.log("[storage] added column document_types.color");
    } catch (err) {
      console.error("[storage] failed to add document_types.color:", err);
    }
  }

  // v1.0.4: structured failure detail on document_render_status so the header
  // indicator can list failed docs by name with a specific reason. Two new
  // columns; safe to run against v0.9.x databases where render_status only
  // has the original six columns.
  const rsCols = sqlite.prepare("PRAGMA table_info(document_render_status)").all() as { name: string }[];
  const rsHave = new Set(rsCols.map((c) => c.name));
  if (!rsHave.has("failed_pages")) {
    try {
      sqlite.exec("ALTER TABLE document_render_status ADD COLUMN failed_pages TEXT");
      console.log("[storage] added column document_render_status.failed_pages");
    } catch (err) {
      console.error("[storage] failed to add document_render_status.failed_pages:", err);
    }
  }
  if (!rsHave.has("first_failed_page")) {
    try {
      sqlite.exec("ALTER TABLE document_render_status ADD COLUMN first_failed_page INTEGER");
      console.log("[storage] added column document_render_status.first_failed_page");
    } catch (err) {
      console.error("[storage] failed to add document_render_status.first_failed_page:", err);
    }
  }
})();

// If we just seeded page images, rewrite `image_path` in document_pages so
// each row points at the actual file we copied to disk. The seed.db ships
// with placeholder paths of the form `<seeded>/<docId>/<fname>` — we know
// the on-disk root now, so patch them. Runs AFTER the CREATE TABLE bootstrap
// so we know the schema exists.
if (_seededPagesFrom) {
  try {
    // Also read `image_path` so we can preserve the original file extension
    // written by the seed prerender step (v0.9.19 ships .webp, older builds
    // shipped .jpg). Fall back to .webp if the placeholder was ever malformed.
    const rows = sqlite.prepare(
      `SELECT rowid, document_id, page_number, image_path FROM document_pages
       WHERE image_path LIKE '<seeded>%'`
    ).all() as { rowid: number; document_id: string; page_number: number; image_path: string }[];
    const upd = sqlite.prepare("UPDATE document_pages SET image_path = ? WHERE rowid = ?");
    const tx = sqlite.transaction((batch: typeof rows) => {
      for (const r of batch) {
        const m = /\.([a-z0-9]+)$/i.exec(r.image_path);
        const ext = m ? m[1].toLowerCase() : "webp";
        const fname = `p${String(r.page_number).padStart(4, "0")}.${ext}`;
        const real = join(_seededPagesFrom!, r.document_id, fname);
        upd.run(real, r.rowid);
      }
    });
    tx(rows);
    if (rows.length) console.log(`[storage] rewrote ${rows.length} seeded image paths`);
  } catch (err) {
    console.error("[storage] failed to rewrite seeded image paths:", err);
  }
}

export interface DocumentPage {
  document_id: string;
  page_number: number;
  image_path: string;
  width: number;
  height: number;
  generated_at: string;
}

export interface RenderStatus {
  document_id: string;
  status: "pending" | "rendering" | "ready" | "error" | "missing";
  rendered: number;
  total: number;
  error: string | null;
  updated_at: string;
  // v1.0.4: structured failure detail so the header indicator can list
  // failed docs by name with a specific reason. `failed_pages` is a
  // JSON-encoded number[] (or null). Reads that pre-date v1.0.4 return
  // null for both fields.
  failed_pages?: string | null;
  first_failed_page?: number | null;
}

export type DocumentTypeSortMode = "importance" | "alphabetical";
export interface DocumentTypeRecord {
  key: string;
  label: string;
  is_builtin: boolean;
  sort_order: number;
  document_count: number;
  // v0.9.36: optional accent color ("#rrggbb" lowercase) or null for no color.
  color: string | null;
}

export interface IStorage {
  createDocument(row: Document): Document;
  updateDocumentStats(id: string, total_chunks: number, total_tokens: number): void;
  updateDocumentTitle(id: string, title: string): void;
  updateDocumentMeta(id: string, patch: Record<string, any>): void;
  listDocuments(): Document[];
  getDocument(id: string): Document | undefined;
  deleteDocument(id: string): void;
  insertChunks(rows: Chunk[]): void;
  getChunksForDoc(parent_id: string): Chunk[];
  allChunks(): Chunk[];
  stats(): { documents: number; chunks: number };
  // v0.9.7 — page-image sidecar
  upsertPage(row: DocumentPage): void;
  getPage(document_id: string, page_number: number): DocumentPage | undefined;
  listPages(document_id: string): DocumentPage[];
  deletePagesForDoc(document_id: string): void;
  upsertRenderStatus(row: RenderStatus): void;
  getRenderStatus(document_id: string): RenderStatus | undefined;
  listDocumentTypes(): { sort_mode: DocumentTypeSortMode; types: DocumentTypeRecord[] };
  documentTypeExists(key: string): boolean;
  createDocumentType(key: string, label: string): void;
  renameDocumentType(key: string, nextKey: string, label: string): void;
  deleteDocumentType(key: string): number;
  setDocumentTypeOrder(mode: DocumentTypeSortMode, keys: string[]): void;
  // v0.9.36: per-doc-type accent color. Pass null to clear.
  setDocumentTypeColor(key: string, color: string | null): void;
}

export class SqliteStorage implements IStorage {
  createDocument(row: Document): Document {
    return db.insert(documents).values(row).returning().get() as Document;
  }
  updateDocumentStats(id: string, total_chunks: number, total_tokens: number): void {
    db.update(documents).set({ total_chunks, total_tokens }).where(eq(documents.id, id)).run();
  }
  updateDocumentTitle(id: string, title: string): void {
    db.update(documents).set({ title }).where(eq(documents.id, id)).run();
  }
  // Partial update. Array fields (audience/tags/allowed_tenants) are JSON-serialized;
  // scalars pass through. Only keys present in `patch` are written.
  updateDocumentMeta(id: string, patch: Record<string, any>): void {
    const jsonKeys = new Set(["audience", "tags", "allowed_tenants"]);
    const set: Record<string, any> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (jsonKeys.has(k)) {
        set[`${k}_json`] = JSON.stringify(v ?? []);
      } else {
        set[k] = v;
      }
    }
    if (Object.keys(set).length === 0) return;
    const tx = sqlite.transaction(() => {
      db.update(documents).set(set).where(eq(documents.id, id)).run();
      const chunkSet: Record<string, any> = {};
      for (const key of ["document_type", "product_model", "product_version", "firmware_version", "confidentiality", "lifecycle_status", "updated_at"]) {
        if (key in set) chunkSet[key] = set[key];
      }
      if ("audience_json" in set) chunkSet.audience_json = set.audience_json;
      if ("allowed_tenants_json" in set) chunkSet.allowed_tenants_json = set.allowed_tenants_json;
      if (Object.keys(chunkSet).length) {
        db.update(chunks).set(chunkSet).where(eq(chunks.parent_id, id)).run();
      }
    });
    tx();
  }
  listDocuments(): Document[] {
    return db.select().from(documents).orderBy(desc(documents.ingested_at)).all() as Document[];
  }
  getDocument(id: string): Document | undefined {
    return db.select().from(documents).where(eq(documents.id, id)).get() as Document | undefined;
  }
  deleteDocument(id: string): void {
    db.delete(chunks).where(eq(chunks.parent_id, id)).run();
    db.delete(documents).where(eq(documents.id, id)).run();
  }
  insertChunks(rows: Chunk[]): void {
    if (rows.length === 0) return;
    const stmt = sqlite.prepare(`
      INSERT INTO chunks (
        id, parent_id, content, content_type, language,
        section_path_json, section_id, section_title, heading_level,
        page_start, page_end, chunk_index,
        document_type, product_model, product_version, firmware_version,
        audience_json, confidentiality, allowed_tenants_json, lifecycle_status, updated_at,
        error_codes_json, cli_commands_json, ui_paths_json, tags_json,
        embedding_json, token_count
      ) VALUES (
        @id, @parent_id, @content, @content_type, @language,
        @section_path_json, @section_id, @section_title, @heading_level,
        @page_start, @page_end, @chunk_index,
        @document_type, @product_model, @product_version, @firmware_version,
        @audience_json, @confidentiality, @allowed_tenants_json, @lifecycle_status, @updated_at,
        @error_codes_json, @cli_commands_json, @ui_paths_json, @tags_json,
        @embedding_json, @token_count
      )
    `);
    const tx = sqlite.transaction((batch: Chunk[]) => {
      for (const r of batch) stmt.run(r);
    });
    tx(rows);
  }
  getChunksForDoc(parent_id: string): Chunk[] {
    return db.select().from(chunks).where(eq(chunks.parent_id, parent_id)).all() as Chunk[];
  }
  allChunks(): Chunk[] {
    return db.select().from(chunks).all() as Chunk[];
  }
  stats(): { documents: number; chunks: number } {
    const d = sqlite.prepare("SELECT COUNT(*) as c FROM documents").get() as { c: number };
    const c = sqlite.prepare("SELECT COUNT(*) as c FROM chunks").get() as { c: number };
    return { documents: d.c, chunks: c.c };
  }

  // -------- v0.9.7 pages sidecar --------
  upsertPage(row: DocumentPage): void {
    sqlite.prepare(`
      INSERT INTO document_pages (document_id, page_number, image_path, width, height, generated_at)
      VALUES (@document_id, @page_number, @image_path, @width, @height, @generated_at)
      ON CONFLICT(document_id, page_number) DO UPDATE SET
        image_path=excluded.image_path,
        width=excluded.width,
        height=excluded.height,
        generated_at=excluded.generated_at
    `).run(row);
  }
  getPage(document_id: string, page_number: number): DocumentPage | undefined {
    return sqlite.prepare(
      "SELECT * FROM document_pages WHERE document_id = ? AND page_number = ?"
    ).get(document_id, page_number) as DocumentPage | undefined;
  }
  listPages(document_id: string): DocumentPage[] {
    return sqlite.prepare(
      "SELECT * FROM document_pages WHERE document_id = ? ORDER BY page_number ASC"
    ).all(document_id) as DocumentPage[];
  }
  deletePagesForDoc(document_id: string): void {
    sqlite.prepare("DELETE FROM document_pages WHERE document_id = ?").run(document_id);
    sqlite.prepare("DELETE FROM document_render_status WHERE document_id = ?").run(document_id);
  }
  upsertRenderStatus(row: RenderStatus): void {
    // v1.0.4: coerce optional structured-failure fields to null when the
    // caller didn't provide them, so the prepared statement's named-param
    // binder doesn't blow up on undefined.
    const bindable = {
      ...row,
      failed_pages: row.failed_pages ?? null,
      first_failed_page: row.first_failed_page ?? null,
    };
    sqlite.prepare(`
      INSERT INTO document_render_status
        (document_id, status, rendered, total, error, updated_at, failed_pages, first_failed_page)
      VALUES
        (@document_id, @status, @rendered, @total, @error, @updated_at, @failed_pages, @first_failed_page)
      ON CONFLICT(document_id) DO UPDATE SET
        status=excluded.status,
        rendered=excluded.rendered,
        total=excluded.total,
        error=excluded.error,
        updated_at=excluded.updated_at,
        failed_pages=excluded.failed_pages,
        first_failed_page=excluded.first_failed_page
    `).run(bindable);
  }
  getRenderStatus(document_id: string): RenderStatus | undefined {
    return sqlite.prepare(
      "SELECT * FROM document_render_status WHERE document_id = ?"
    ).get(document_id) as RenderStatus | undefined;
  }

  listDocumentTypes(): { sort_mode: DocumentTypeSortMode; types: DocumentTypeRecord[] } {
    const setting = sqlite.prepare(
      "SELECT value FROM app_settings WHERE key = 'document_type_sort_mode'"
    ).get() as { value: string } | undefined;
    const sort_mode: DocumentTypeSortMode =
      setting?.value === "alphabetical" ? "alphabetical" : "importance";
    const orderBy = sort_mode === "alphabetical"
      ? "dt.label COLLATE NOCASE ASC"
      : "dt.sort_order ASC, dt.label COLLATE NOCASE ASC";
    const rows = sqlite.prepare(`
      SELECT dt.key, dt.label, dt.is_builtin, dt.sort_order, dt.color, COUNT(d.id) AS document_count
      FROM document_types dt
      LEFT JOIN documents d ON d.document_type = dt.key
      GROUP BY dt.key, dt.label, dt.is_builtin, dt.sort_order, dt.color
      ORDER BY ${orderBy}
    `).all() as Array<Omit<DocumentTypeRecord, "is_builtin" | "color"> & { is_builtin: number; color: string | null }>;
    return {
      sort_mode,
      types: rows.map((row) => ({
        ...row,
        is_builtin: row.is_builtin === 1,
        color: row.color ?? null,
      })),
    };
  }

  // v0.9.36: set (or clear with null) the accent color for a doc type.
  // Applies to both the builtin `document` fallback and user types.
  setDocumentTypeColor(key: string, color: string | null): void {
    const exists = sqlite.prepare("SELECT 1 FROM document_types WHERE key = ?").get(key);
    if (!exists) throw new Error("Document type not found.");
    sqlite.prepare("UPDATE document_types SET color = ? WHERE key = ?").run(color, key);
  }

  documentTypeExists(key: string): boolean {
    return Boolean(sqlite.prepare("SELECT 1 FROM document_types WHERE key = ?").get(key));
  }

  createDocumentType(key: string, label: string): void {
    const max = sqlite.prepare("SELECT COALESCE(MAX(sort_order), -1) AS n FROM document_types").get() as { n: number };
    sqlite.prepare(`
      INSERT INTO document_types (key, label, is_builtin, sort_order, created_at)
      VALUES (?, ?, 0, ?, ?)
    `).run(key, label, max.n + 1, new Date().toISOString());
  }

  renameDocumentType(key: string, nextKey: string, label: string): void {
    if (key === "document") throw new Error("The Document fallback cannot be renamed.");
    const tx = sqlite.transaction(() => {
      const current = sqlite.prepare("SELECT * FROM document_types WHERE key = ?").get(key);
      if (!current) throw new Error("Document type not found.");
      if (key === nextKey) {
        sqlite.prepare("UPDATE document_types SET label = ? WHERE key = ?").run(label, key);
        return;
      }
      const row = current as { is_builtin: number; sort_order: number; created_at: string };
      sqlite.prepare(`
        INSERT INTO document_types (key, label, is_builtin, sort_order, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(nextKey, label, row.is_builtin, row.sort_order, row.created_at);
      sqlite.prepare("UPDATE documents SET document_type = ? WHERE document_type = ?").run(nextKey, key);
      sqlite.prepare("UPDATE chunks SET document_type = ? WHERE document_type = ?").run(nextKey, key);
      sqlite.prepare("DELETE FROM document_types WHERE key = ?").run(key);
    });
    tx();
  }

  deleteDocumentType(key: string): number {
    if (key === "document") throw new Error("The Document fallback cannot be deleted.");
    let affected = 0;
    const tx = sqlite.transaction(() => {
      const current = sqlite.prepare("SELECT 1 FROM document_types WHERE key = ?").get(key);
      if (!current) throw new Error("Document type not found.");
      affected = (sqlite.prepare("SELECT COUNT(*) AS n FROM documents WHERE document_type = ?").get(key) as { n: number }).n;
      sqlite.prepare("UPDATE documents SET document_type = 'document' WHERE document_type = ?").run(key);
      sqlite.prepare("UPDATE chunks SET document_type = 'document' WHERE document_type = ?").run(key);
      sqlite.prepare("DELETE FROM document_types WHERE key = ?").run(key);
    });
    tx();
    return affected;
  }

  setDocumentTypeOrder(mode: DocumentTypeSortMode, keys: string[]): void {
    const current = this.listDocumentTypes().types.map((type) => type.key);
    if (keys.length !== current.length || new Set(keys).size !== current.length || current.some((key) => !keys.includes(key))) {
      throw new Error("Document type order must include every current type exactly once.");
    }
    const tx = sqlite.transaction(() => {
      const update = sqlite.prepare("UPDATE document_types SET sort_order = ? WHERE key = ?");
      keys.forEach((key, index) => update.run(index, key));
      sqlite.prepare(`
        INSERT INTO app_settings (key, value) VALUES ('document_type_sort_mode', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(mode);
    });
    tx();
  }
}

export const storage = new SqliteStorage();
