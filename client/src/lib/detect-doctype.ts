// v1.1.0 -- Auto-classify Document type from filename codes.
//
// Companion to the Fix Title parser (client/src/lib/fix-title.ts). This helper
// re-uses the parser's tokenization output so classification and title
// derivation stay in perfect lockstep: any change to how the parser sees a
// filename automatically flows through to how we detect its guide code.
//
// This module is PURE: no DOM, no React, no I/O. It is safe to import from any
// context (upload page, settings editor, unit tests).
//
// Design notes locked with the user for v1.1.0:
//
//   * The default mapping is OG/UG/TB/SG/PG/MG/IG. The parser already emits
//     these as first-class standalone tokens, plus TB<digits>[<suffix>] as a
//     single compound token (see fix-title.ts splitWord()). Classification
//     reads those tokens directly instead of re-parsing the filename.
//
//   * Last matching token WINS. Kyocera-format filenames put the guide code
//     late in the name (after model + language, e.g. "...ENOGR2025.09"), so
//     the trailing code usually reflects the document's true character.
//
//   * If nothing matches, return null. Blank on the caller side. Never guess.
//
//   * NEVER overwrite an existing user selection -- that check lives at the
//     call site, not here. This function is stateless.

import { fixTitle } from "./fix-title";

/** One row in the user's Filename codes editor. */
export interface FilenameCodeMapping {
  /** Short uppercase code, 1-8 characters, e.g. "OG", "TB", "CG". */
  code: string;
  /** Stable document_types.key this code resolves to. May be "" for orphaned
   *  rows whose underlying type was deleted -- Settings UI surfaces those. */
  doc_type_key: string;
}

export type FilenameCodeMap = FilenameCodeMapping[];

/** v1.2.4: one row in the user's Filename phrases editor. Complements
 *  FilenameCodeMapping -- phrases are matched against a normalized form of
 *  the whole filename (extension dropped, separators to spaces, lowercased)
 *  with word-boundary anchors, so plain-English filenames like
 *  "User Guide.pdf" classify without the phrase leaking into arbitrary
 *  substrings like "superuserguidebook.pdf". */
export interface FilenamePhraseMapping {
  /** The user's typed phrase, stored in their original casing for display.
   *  Matching lowercases and normalizes at match time. Length 2-64 after
   *  normalization; must contain at least one letter. */
  phrase: string;
  /** Stable document_types.key this phrase resolves to. "" for orphan rows. */
  doc_type_key: string;
}

export type FilenamePhraseMap = FilenamePhraseMapping[];

/** v1.2.4: normalize a filename OR a phrase into the form used for the
 *  word-boundary match. Drops the extension when a filename is passed,
 *  replaces `_`, `-`, `.` with single spaces, collapses runs of
 *  whitespace, lowercases, and trims. Kept as a pure helper so the
 *  server-side editor validation and the client-side detector can share
 *  a single "same string" rule. */
export function normalizeForPhraseMatch(filenameOrPhrase: string, isFilename: boolean): string {
  let s = filenameOrPhrase;
  if (isFilename) {
    // Drop the last extension only -- "user.guide.pdf" becomes "user.guide"
    // (then the `.` -> space step below turns it into "user guide").
    const dot = s.lastIndexOf(".");
    if (dot > 0) s = s.slice(0, dot);
  }
  return s
    .toLowerCase()
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract the leading uppercase-letter prefix from a token if the whole token
 * is either JUST that prefix (e.g. "OG") or that prefix followed by digits
 * and an optional lowercase suffix (e.g. "TB1", "TB128", "TB11bc").
 *
 * Returns null for anything else -- model numbers like "MZ9500ci" have a
 * lowercase suffix but their prefix is longer than 8 chars and mixes letters
 * with digits inside the head, so they don't match this shape.
 *
 * The 1-8 character bound matches the editor's validation.
 *
 * v1.1.2 (field-test fix): an optional single "-" or "_" between the letters
 * and the digits is now tolerated, so "TB-1", "TB_1" and "TB-001" classify the
 * same as "TB1". The Fix Title tokenizer keeps an internal hyphen inside a
 * token ("TB-1" arrives as ONE token), so without this the whole
 * hyphen-separated family silently failed to auto-detect. Deliberately NOT
 * fixed in the tokenizer: that would change Fix Title's visible output, which
 * is working and was explicitly left alone.
 *
 * Still case-SENSITIVE on purpose. Uppercasing tokens before lookup would let
 * ordinary lowercase words collide with short codes -- "pg12" (page 12) would
 * classify as Parts Guide -- which breaks the "never guess" rule above.
 */
function extractCodePrefix(token: string): string | null {
  const m = token.match(/^([A-Z]{1,8})(?:[-_]?\d+[a-z]*)?$/);
  if (!m) return null;
  return m[1];
}

/**
 * Detect a Document type key from a filename using the parser's tokenization.
 *
 * @param filename       The raw uploaded filename (with or without extension).
 * @param mapping        The current user-editable filename-code mapping.
 * @param phraseMapping  v1.2.4 optional Filename phrases mapping. When
 *                       undefined or empty, behavior is exactly the
 *                       pre-v1.2.4 code-only behavior. When present, and
 *                       ONLY when the code detector returns null, the
 *                       phrase detector runs against a normalized form of
 *                       the filename with word-boundary anchors.
 * @returns The matched document_types.key, or null when no code and no
 *          phrase matched.
 *
 * If the mapping contains multiple entries for the same code (should not
 * happen thanks to editor validation, but be defensive), the LAST entry in
 * the mapping array wins for that code. If multiple different codes match
 * in the tokenized filename, the LAST matching token in reading order wins.
 *
 * Phrase detector rules:
 *   * Longest phrase wins on ties. If two phrases both match the same
 *     filename (e.g. "Parts Guide" and "Parts and Service Guide"), the
 *     phrase with more characters after normalization wins.
 *   * Ties beyond that fall back to last-write-wins in the mapping order,
 *     matching the codes editor's semantics.
 *   * Never guess. No fuzzy match, no substring match without a boundary,
 *     no stemming, no plural collapse.
 */
export function detectDocType(
  filename: string,
  mapping: FilenameCodeMap,
  phraseMapping?: FilenamePhraseMap,
): string | null {
  if (!filename || !mapping || mapping.length === 0) {
    // Codes-only path can't run; fall through to phrases if any (still
    // valid: user may have deleted all codes but kept phrases).
    return detectFromPhrases(filename, phraseMapping);
  }

  // Build a fast lookup: uppercased code -> resolved key. Later entries
  // overwrite earlier ones, matching "last write wins" semantics used by
  // the editor when the user reorders rows. Skip empty codes and orphan
  // rows (empty doc_type_key) so they can't accidentally classify.
  const lookup = new Map<string, string>();
  for (const row of mapping) {
    if (!row || typeof row.code !== "string" || typeof row.doc_type_key !== "string") continue;
    const code = row.code.trim().toUpperCase();
    if (!code) continue;
    if (!row.doc_type_key) continue;
    lookup.set(code, row.doc_type_key);
  }
  if (lookup.size === 0) return null;

  const { tokens } = fixTitle(filename);

  let lastMatch: string | null = null;
  for (const raw of tokens) {
    if (!raw) continue;
    // The parser preserves standalone codes in uppercase, so a direct check
    // is enough for OG/UG/SG/PG/MG/IG/etc.
    let hit = lookup.get(raw);
    if (hit) {
      lastMatch = hit;
      continue;
    }
    // TB<digits>[suffix] arrives as a single compound token, e.g. "TB1".
    // Peel the leading uppercase prefix and try that too. Only compound
    // codes reach this branch, so it never accidentally matches a plain
    // letter run that was already handled above.
    const prefix = extractCodePrefix(raw);
    if (prefix && prefix !== raw) {
      hit = lookup.get(prefix);
      if (hit) lastMatch = hit;
    }
  }

  if (lastMatch) return lastMatch;

  // v1.2.4: only when the code detector returns null does the phrase
  // detector run. This preserves every existing auto-classification and
  // guarantees phrases cannot regress a working code hit.
  return detectFromPhrases(filename, phraseMapping);
}

/** v1.2.4 internal: run the phrase detector against a filename. Word-
 *  boundary match on the normalized filename. Longest normalized phrase
 *  wins on tie; further ties fall back to last-write-wins. Returns null
 *  when no phrase matched or when no phrase mapping was supplied. */
function detectFromPhrases(
  filename: string,
  phraseMapping: FilenamePhraseMap | undefined,
): string | null {
  if (!filename || !phraseMapping || phraseMapping.length === 0) return null;
  const haystack = normalizeForPhraseMatch(filename, true);
  if (!haystack) return null;

  // Track the best hit -- longest normalized phrase wins, then last-write-
  // wins on true ties. We iterate the mapping in order and keep a
  // running best whose length strictly dominates; equal-length later
  // entries overwrite earlier ones (last-write-wins).
  let bestKey: string | null = null;
  let bestLen = -1;
  for (const row of phraseMapping) {
    if (!row || typeof row.phrase !== "string" || typeof row.doc_type_key !== "string") continue;
    if (!row.doc_type_key) continue;
    const normalized = normalizeForPhraseMatch(row.phrase, false);
    if (normalized.length < 2) continue;
    if (!wordBoundaryContains(haystack, normalized)) continue;
    if (normalized.length >= bestLen) {
      // Strict > would keep the earliest of two equal-length hits; the
      // spec calls for last-write-wins on tie, so use >= to let a later
      // equal-length entry overwrite.
      bestKey = row.doc_type_key;
      bestLen = normalized.length;
    }
  }
  return bestKey;
}

/** Word-boundary contains check on already-normalized strings. Both inputs
 *  are lowercased and separator-collapsed, so the boundary rule reduces to:
 *  the match starts at index 0 or is preceded by a space, AND ends at the
 *  string end or is followed by a space. This avoids RegExp escaping and
 *  keeps the classifier allocation-free per candidate. */
function wordBoundaryContains(haystack: string, needle: string): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) return false;
    const before = idx === 0 || haystack.charCodeAt(idx - 1) === 32; // 32 = ' '
    const afterIdx = idx + needle.length;
    const after = afterIdx === haystack.length || haystack.charCodeAt(afterIdx) === 32;
    if (before && after) return true;
    from = idx + 1;
  }
  return false;
}

/** Built-in default filename-code mapping shipped in v1.1.0.
 *  The doc_type_key values are placeholders until the server first-run seed
 *  resolves them against the actual document_types registry (case-insensitive
 *  on the type LABEL). Do not import these keys directly on the client --
 *  always read the current mapping from useFilenameCodes(). */
export const DEFAULT_FILENAME_CODE_LABELS: ReadonlyArray<{ code: string; label: string }> = [
  { code: "OG", label: "Operator Guide" },
  { code: "UG", label: "User Guide" },
  { code: "TB", label: "Technical Bulletin" },
  { code: "SG", label: "Service Guide" },
  { code: "PG", label: "Parts Guide" },
  { code: "MG", label: "Maintenance Guide" },
  { code: "IG", label: "Installation Guide" },
];
