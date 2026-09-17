// v1.2.4 -- Server-side storage for the Filename PHRASES -> Document type map,
// and the first-boot seed that populates it against the user's existing
// Document types registry.
//
// Companion to server/filename-codes.ts. Same JSON-blob-in-app_settings
// pattern -- no schema migration, atomic swap on PUT. Kept as a SEPARATE
// module (and a separate app_settings key) so the two mental models stay
// clean: short embedded codes vs. plain-English phrases. The two editors
// and the two underlying maps are deliberately not folded together.
//
// The seven default phrases match the seven default codes, so on a fresh
// install both editors seed side by side. On upgrade, the phrases seed
// only inserts phrases whose doc_type_key does NOT already have a phrase
// row -- idempotent per doc-type key, so a user who deleted a code before
// upgrading still gets the matching phrase seeded once.

import type Database from "better-sqlite3";

import {
  DEFAULT_FILENAME_CODE_LABELS,
  findDocTypeKeyByLabelCaseInsensitive,
} from "./filename-codes";

export const FILENAME_PHRASE_MAP_KEY = "filename_phrase_mappings_v1";
export const DEFAULT_PHRASES_SEED_MARKER_KEY = "seeded_default_filename_phrases_v1";
export const FILENAME_PHRASES_LOG_PREFIX = "[filename-phrases]";

/** One row in the persisted phrase mapping. `doc_type_key` may be "" for a
 *  row whose underlying Document type was deleted -- the client surfaces
 *  those as "Type deleted" and offers reassignment. */
export interface FilenamePhraseRow {
  /** Phrase as the user typed it. Case is preserved for display; matching
   *  normalizes both sides at read time (see normalizePhrase()). */
  phrase: string;
  doc_type_key: string;
}

/** The seven defaults shipped in v1.2.4, in the order the editor renders them.
 *  Phrases map 1:1 to the seven default codes so both editors ship in sync. */
export const DEFAULT_FILENAME_PHRASE_LABELS: ReadonlyArray<{ phrase: string; label: string }> = [
  { phrase: "User Guide", label: "User Guide" },
  { phrase: "Operator Guide", label: "Operator Guide" },
  { phrase: "Technical Bulletin", label: "Technical Bulletin" },
  { phrase: "Service Guide", label: "Service Guide" },
  { phrase: "Parts Guide", label: "Parts Guide" },
  { phrase: "Maintenance Guide", label: "Maintenance Guide" },
  { phrase: "Installation Guide", label: "Installation Guide" },
];

// Sanity-check: the phrase seed must cover exactly the same doc-type LABELS
// as the code seed, so on a fresh install both editors seed against the
// same set of types. If someone edits one list without the other this
// throws at boot -- loud is better than silently drifting seeds.
{
  const codeLabels = new Set(DEFAULT_FILENAME_CODE_LABELS.map((r) => r.label));
  const phraseLabels = new Set(DEFAULT_FILENAME_PHRASE_LABELS.map((r) => r.label));
  if (codeLabels.size !== phraseLabels.size) {
    throw new Error(
      `${FILENAME_PHRASES_LOG_PREFIX} default phrase labels drifted from default code labels: ` +
      `codes=${[...codeLabels].join("|")} phrases=${[...phraseLabels].join("|")}`,
    );
  }
  for (const l of codeLabels) {
    if (!phraseLabels.has(l)) {
      throw new Error(
        `${FILENAME_PHRASES_LOG_PREFIX} default phrase seed missing label: ${l}`,
      );
    }
  }
}

/** Normalize a phrase for storage-duplicate checks AND for match-time
 *  comparison. Lower-cases, converts `_`, `-`, `.` to spaces, collapses
 *  whitespace runs, and trims. Kept as a single function so the storage
 *  editor and the detector always agree on what "the same phrase" means. */
export function normalizePhrase(phrase: string): string {
  return phrase
    .toLowerCase()
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Read the persisted phrase mapping. Returns [] when nothing has been
 *  stored yet; callers decide whether that means "seed hasn't run" or
 *  "user cleared it". */
export function readFilenamePhraseMapping(rawDb: Database.Database): FilenamePhraseRow[] {
  try {
    const row = rawDb
      .prepare("SELECT value FROM app_settings WHERE key = ?")
      .get(FILENAME_PHRASE_MAP_KEY) as { value: string } | undefined;
    if (!row?.value) return [];
    const parsed = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return [];
    // Defensive: coerce each entry to the expected shape and drop garbage
    // without throwing -- a corrupt row must not wedge boot.
    return parsed
      .map((r: any) => ({
        phrase: typeof r?.phrase === "string" ? r.phrase : "",
        doc_type_key: typeof r?.doc_type_key === "string" ? r.doc_type_key : "",
      }))
      .filter((r) => {
        const n = normalizePhrase(r.phrase);
        return n.length >= 2 && n.length <= 64 && /[a-z]/.test(n);
      });
  } catch {
    return [];
  }
}

/** Overwrite the persisted phrase mapping atomically. */
export function writeFilenamePhraseMapping(
  rawDb: Database.Database,
  mapping: FilenamePhraseRow[],
): void {
  // Preserve the phrase in the user's typed casing for display; matching
  // normalizes at read time.
  const normalized = mapping.map((r) => ({
    phrase: r.phrase.replace(/^\s+|\s+$/g, ""),
    doc_type_key: (r.doc_type_key ?? "").trim(),
  }));
  const value = JSON.stringify(normalized);
  rawDb.prepare(`
    INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(FILENAME_PHRASE_MAP_KEY, value);
}

/** True when the phrase seed marker has been recorded (any value). */
export function isDefaultPhrasesSeeded(rawDb: Database.Database): boolean {
  try {
    const row = rawDb
      .prepare("SELECT value FROM app_settings WHERE key = ?")
      .get(DEFAULT_PHRASES_SEED_MARKER_KEY) as { value: string } | undefined;
    return !!row;
  } catch {
    return false;
  }
}

/**
 * First-boot seeder for filename phrases. Idempotent: the marker key
 * `seeded_default_filename_phrases_v1` guards against re-seeding, and the
 * per-doc-type-key check inside the transaction guards against duplicating
 * a phrase for a doc type that already has one (so upgrading users get
 * only the phrases their existing types don't already cover).
 *
 * If a matching doc type doesn't exist yet, this seeder does NOT create
 * it -- the codes seed (seedDefaultDocTypesAndCodesIfNeeded) is responsible
 * for creating the seven default doc types. Call the phrases seeder AFTER
 * the codes seeder so it can find the resolved keys.
 *
 * Safe to call synchronously during server boot; never throws (any
 * failure is caught and logged, matching the Welcome Guide seed's
 * contract of "seeding must never prevent startup").
 */
export function seedDefaultFilenamePhrasesIfNeeded(rawDb: Database.Database): void {
  try {
    if (isDefaultPhrasesSeeded(rawDb)) {
      return;
    }

    const tx = rawDb.transaction(() => {
      const existing = readFilenamePhraseMapping(rawDb);
      const existingKeys = new Set(existing.map((r) => r.doc_type_key));
      const additions: FilenamePhraseRow[] = [];
      for (const { phrase, label } of DEFAULT_FILENAME_PHRASE_LABELS) {
        // Resolve the doc-type-key via label match, same rule the codes
        // seed uses. If no matching doc type exists (rare -- would mean
        // the codes seed didn't run yet OR the user deleted it), skip.
        const key = findDocTypeKeyByLabelCaseInsensitive(rawDb, label);
        if (!key) continue;
        if (existingKeys.has(key)) continue;
        additions.push({ phrase, doc_type_key: key });
        existingKeys.add(key);
      }
      const next = [...existing, ...additions];
      writeFilenamePhraseMapping(rawDb, next);
      rawDb.prepare(`
        INSERT INTO app_settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(DEFAULT_PHRASES_SEED_MARKER_KEY, new Date().toISOString());
    });

    tx();
    console.log(
      `${FILENAME_PHRASES_LOG_PREFIX} first-boot seed complete ` +
      `(${DEFAULT_FILENAME_PHRASE_LABELS.length} default phrases considered)`,
    );
  } catch (err) {
    console.warn(
      `${FILENAME_PHRASES_LOG_PREFIX} seed failed (non-fatal): ${(err as Error).message || err}`,
    );
  }
}

/** Validate one row from a PUT body. Returns a normalized row or a string error.
 *  The rules match the spec: case-insensitive phrases, spaces allowed,
 *  length 2-64 chars, at least one letter, no leading/trailing whitespace,
 *  no duplicate against another row's normalized form. Duplicate detection
 *  happens at the payload level in the route; per-row validation here just
 *  covers shape + length + letter check. */
export function validateFilenamePhraseRow(input: unknown): FilenamePhraseRow | string {
  if (!input || typeof input !== "object") return "Each row must be an object.";
  const rawPhrase = (input as any).phrase;
  const rawKey = (input as any).doc_type_key;
  if (typeof rawPhrase !== "string") return "Row missing string 'phrase'.";
  const trimmed = rawPhrase.replace(/^\s+|\s+$/g, "");
  if (trimmed !== rawPhrase) return "Phrase must not have leading or trailing whitespace.";
  const normalized = normalizePhrase(trimmed);
  if (normalized.length < 2) return "Phrase must be at least 2 characters after normalization.";
  if (normalized.length > 64) return "Phrase must be at most 64 characters.";
  if (!/[a-z]/.test(normalized)) return "Phrase must contain at least one letter.";
  if (typeof rawKey !== "string") return "Row missing string 'doc_type_key'.";
  return { phrase: trimmed, doc_type_key: rawKey.trim() };
}

/**
 * v1.2.4: keep the phrase mapping consistent when a document type moves,
 * same contract as repointFilenameCodesInTx. Pass nextKey = null to drop
 * the entry entirely (used on delete). Must be called INSIDE an existing
 * transaction; does not open its own.
 */
export function repointFilenamePhrasesInTx(
  rawDb: Database.Database,
  fromKey: string,
  nextKey: string | null,
): void {
  const mapping = readFilenamePhraseMapping(rawDb);
  if (!mapping.some((r) => r.doc_type_key === fromKey)) return;
  const updated = nextKey === null
    ? mapping.filter((r) => r.doc_type_key !== fromKey)
    : mapping.map((r) => (r.doc_type_key === fromKey ? { ...r, doc_type_key: nextKey } : r));
  writeFilenamePhraseMapping(rawDb, updated);
}

/**
 * v1.2.4: drop any phrase mapping entry whose doc_type_key no longer
 * exists. Repairs databases that were corrupted by a rename or delete
 * made before the repointing above existed. Mirror of
 * pruneDanglingFilenameCodes.
 */
export function pruneDanglingFilenamePhrases(rawDb: Database.Database): string[] {
  const mapping = readFilenamePhraseMapping(rawDb);
  if (mapping.length === 0) return [];
  const keys = new Set(
    (rawDb.prepare("SELECT key FROM document_types").all() as { key: string }[]).map((r) => r.key),
  );
  const dropped = mapping.filter((r) => !keys.has(r.doc_type_key)).map((r) => r.phrase);
  if (dropped.length > 0) {
    writeFilenamePhraseMapping(rawDb, mapping.filter((r) => keys.has(r.doc_type_key)));
  }
  return dropped;
}
