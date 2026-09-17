// v1.1.0 -- Server-side storage for the Filename codes -> Document type map,
// and the first-boot seed that populates it against the user's existing
// Document types registry.
//
// The mapping is stored as a single JSON blob in app_settings under the key
// `filename_code_mappings_v1`. This keeps the change surface small (no schema
// migration; the row is created on first read) and lets the whole map be
// swapped atomically on PUT.
//
// Companion first-boot logic:
//   * Marker key `seeded_default_doc_types_v1` in app_settings. Presence
//     means the seed has already run once -- do NOT run again, even if the
//     user has since deleted a seeded Document type. Deletion must stay
//     sticky, matching the Welcome Guide's contract.
//   * Case-insensitive existence check against document_types.label (that
//     column is UNIQUE COLLATE NOCASE, so an exact-match SELECT already
//     collates NOCASE). If a matching type exists we REUSE its key rather
//     than duplicating it -- a user who renamed "User manual" to "User
//     Guide" before upgrading should end up with the UG code pointing at
//     THEIR existing type, not a new duplicate.
//
// Kept intentionally free of Express types so unit tests can drive the
// storage and seed helpers directly.

import type Database from "better-sqlite3";

export const FILENAME_CODE_MAP_KEY = "filename_code_mappings_v1";
export const DEFAULT_DOC_TYPES_SEED_MARKER_KEY = "seeded_default_doc_types_v1";
export const FILENAME_CODES_LOG_PREFIX = "[filename-codes]";

/** One row in the persisted mapping. `doc_type_key` may be "" for a row
 *  whose underlying Document type was deleted -- the client surfaces those
 *  as "Type deleted" and offers reassignment. */
export interface FilenameCodeRow {
  code: string;
  doc_type_key: string;
}

/** The seven defaults shipped in v1.1.0, in the order the editor renders them. */
export const DEFAULT_FILENAME_CODE_LABELS: ReadonlyArray<{ code: string; label: string }> = [
  { code: "OG", label: "Operator Guide" },
  { code: "UG", label: "User Guide" },
  { code: "TB", label: "Technical Bulletin" },
  { code: "SG", label: "Service Guide" },
  { code: "PG", label: "Parts Guide" },
  { code: "MG", label: "Maintenance Guide" },
  { code: "IG", label: "Installation Guide" },
];

/** Slugify a label into a document_types.key. Kept locally so this module
 *  does not depend on routes.ts; the algorithm mirrors documentTypeKey()
 *  there character-for-character. If the two ever drift, seed keys would
 *  stop matching what the manual "Add type" flow produces. */
function slugifyDocTypeKey(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

/** Read the persisted mapping. Returns [] when nothing has been stored yet;
 *  callers decide whether that means "seed hasn't run" or "user cleared it". */
export function readFilenameCodeMapping(rawDb: Database.Database): FilenameCodeRow[] {
  try {
    const row = rawDb
      .prepare("SELECT value FROM app_settings WHERE key = ?")
      .get(FILENAME_CODE_MAP_KEY) as { value: string } | undefined;
    if (!row?.value) return [];
    const parsed = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return [];
    // Defensive: coerce each entry to the expected shape and drop garbage
    // without throwing -- a corrupt row must not wedge boot.
    return parsed
      .map((r: any) => ({
        code: typeof r?.code === "string" ? r.code.trim().toUpperCase() : "",
        doc_type_key: typeof r?.doc_type_key === "string" ? r.doc_type_key : "",
      }))
      .filter((r) => r.code.length > 0 && r.code.length <= 8);
  } catch {
    return [];
  }
}

/** Overwrite the persisted mapping atomically. */
export function writeFilenameCodeMapping(rawDb: Database.Database, mapping: FilenameCodeRow[]): void {
  // Normalize once on write so reads never see subtle whitespace variants.
  const normalized = mapping.map((r) => ({
    code: r.code.trim().toUpperCase(),
    doc_type_key: (r.doc_type_key ?? "").trim(),
  }));
  const value = JSON.stringify(normalized);
  rawDb.prepare(`
    INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(FILENAME_CODE_MAP_KEY, value);
}

/** True when the seed marker has been recorded (any value). */
export function isDefaultDocTypesSeeded(rawDb: Database.Database): boolean {
  try {
    const row = rawDb
      .prepare("SELECT value FROM app_settings WHERE key = ?")
      .get(DEFAULT_DOC_TYPES_SEED_MARKER_KEY) as { value: string } | undefined;
    return !!row;
  } catch {
    return false;
  }
}

/** Look up an existing document type by LABEL, case-insensitive. Returns the
 *  stable key if found, null otherwise. Relies on the document_types.label
 *  UNIQUE COLLATE NOCASE constraint for a fast exact match. */
export function findDocTypeKeyByLabelCaseInsensitive(
  rawDb: Database.Database,
  label: string,
): string | null {
  const row = rawDb
    .prepare("SELECT key FROM document_types WHERE label = ? COLLATE NOCASE")
    .get(label) as { key: string } | undefined;
  return row ? String(row.key) : null;
}

/** Insert a new document type using the same shape as SqliteStorage.createDocumentType.
 *  Kept here so the seed does not need to import from routes.ts (which would
 *  create a cyclic dependency during boot). Non-builtin, appended to the end
 *  of the sort_order. */
function insertNewDocType(rawDb: Database.Database, key: string, label: string): void {
  const max = rawDb.prepare("SELECT COALESCE(MAX(sort_order), -1) AS n FROM document_types").get() as { n: number };
  rawDb.prepare(`
    INSERT INTO document_types (key, label, is_builtin, sort_order, created_at)
    VALUES (?, ?, 0, ?, ?)
  `).run(key, label, max.n + 1, new Date().toISOString());
}

/**
 * First-boot seeder. Guarded by `seeded_default_doc_types_v1` in app_settings
 * so it never runs twice. For each default (code, label):
 *
 *   1. If a Document type with that label already exists (case-insensitive),
 *      reuse its key.
 *   2. Otherwise create a new Document type with a slugged key and the exact
 *      default label.
 *   3. Add a mapping row (code -> resolved key).
 *
 * Then persist the mapping in one atomic write and record the marker. Safe
 * to call synchronously during server boot; never throws (any failure is
 * caught and logged, matching the Welcome Guide seed's contract of "seeding
 * must never prevent startup").
 */
export function seedDefaultDocTypesAndCodesIfNeeded(rawDb: Database.Database): void {
  try {
    if (isDefaultDocTypesSeeded(rawDb)) {
      // Idempotent -- do NOT re-seed on every boot. Deletion is sticky.
      return;
    }

    const tx = rawDb.transaction(() => {
      const mapping: FilenameCodeRow[] = [];
      for (const { code, label } of DEFAULT_FILENAME_CODE_LABELS) {
        let key = findDocTypeKeyByLabelCaseInsensitive(rawDb, label);
        if (!key) {
          key = slugifyDocTypeKey(label);
          // Guard against a slug collision with an existing key whose LABEL
          // differs -- extremely unlikely (would require a user manually
          // creating a type whose slug matches ours but whose label doesn't),
          // but if it happens we skip inserting and just reuse the existing
          // key. The label mismatch is preferable to a 409 that would abort
          // the whole seed.
          const clash = rawDb
            .prepare("SELECT 1 FROM document_types WHERE key = ?")
            .get(key);
          if (!clash) {
            insertNewDocType(rawDb, key, label);
          }
        }
        mapping.push({ code, doc_type_key: key });
      }

      const value = JSON.stringify(mapping);
      rawDb.prepare(`
        INSERT INTO app_settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(FILENAME_CODE_MAP_KEY, value);

      rawDb.prepare(`
        INSERT INTO app_settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(DEFAULT_DOC_TYPES_SEED_MARKER_KEY, new Date().toISOString());
    });

    tx();
    console.log(
      `${FILENAME_CODES_LOG_PREFIX} first-boot seed complete ` +
      `(${DEFAULT_FILENAME_CODE_LABELS.length} default codes)`,
    );
  } catch (err) {
    // Never let a seed failure prevent startup. The user can always populate
    // the mapping manually in Settings > Document types > Filename codes.
    console.warn(
      `${FILENAME_CODES_LOG_PREFIX} seed failed (non-fatal): ${(err as Error).message || err}`,
    );
  }
}

/** Validate one row from a PUT body. Returns a normalized row or a string error. */
export function validateFilenameCodeRow(input: unknown): FilenameCodeRow | string {
  if (!input || typeof input !== "object") return "Each row must be an object.";
  const rawCode = (input as any).code;
  const rawKey = (input as any).doc_type_key;
  if (typeof rawCode !== "string") return "Row missing string 'code'.";
  const code = rawCode.trim().toUpperCase();
  if (code.length < 1 || code.length > 8) return "Code must be 1-8 characters.";
  if (!/^[A-Z0-9]+$/.test(code)) return "Code must contain only uppercase letters or digits.";
  if (typeof rawKey !== "string") return "Row missing string 'doc_type_key'.";
  // doc_type_key may be blank when the underlying type was deleted; the
  // editor treats those as orphans, and detectDocType() skips them.
  return { code, doc_type_key: rawKey.trim() };
}

/**
 * v1.1.4: keep the code mapping consistent when a document type row moves.
 *
 * The mapping is JSON in app_settings and stores doc_type_key, but nothing
 * used to update it when a type was renamed (renameDocumentType re-slugs the
 * label into a NEW key) or deleted. readFilenameCodeMapping validates the code
 * string but never checks that doc_type_key still resolves, so a stale entry
 * silently caused auto-detection to stamp documents with a nonexistent key --
 * no error and no log line.
 *
 * Pass nextKey = null to drop the entry entirely (used on delete, where
 * pointing the code at the 'document' fallback would quietly mis-tag instead).
 *
 * Must be called INSIDE an existing transaction; it does not open its own.
 */
export function repointFilenameCodesInTx(
  rawDb: Database.Database,
  fromKey: string,
  nextKey: string | null,
): void {
  const mapping = readFilenameCodeMapping(rawDb);
  if (!mapping.some((r) => r.doc_type_key === fromKey)) return;
  const updated = nextKey === null
    ? mapping.filter((r) => r.doc_type_key !== fromKey)
    : mapping.map((r) => (r.doc_type_key === fromKey ? { ...r, doc_type_key: nextKey } : r));
  writeFilenameCodeMapping(rawDb, updated);
}

/**
 * v1.1.4: drop any mapping entry whose doc_type_key no longer exists. Repairs
 * databases that were already corrupted by a rename or delete made before the
 * repointing above existed.
 *
 * Returns the codes that were dropped so the caller can log them.
 */
export function pruneDanglingFilenameCodes(rawDb: Database.Database): string[] {
  const mapping = readFilenameCodeMapping(rawDb);
  if (mapping.length === 0) return [];
  const keys = new Set(
    (rawDb.prepare("SELECT key FROM document_types").all() as { key: string }[]).map((r) => r.key),
  );
  const dropped = mapping.filter((r) => !keys.has(r.doc_type_key)).map((r) => r.code);
  if (dropped.length > 0) {
    writeFilenameCodeMapping(rawDb, mapping.filter((r) => keys.has(r.doc_type_key)));
  }
  return dropped;
}
