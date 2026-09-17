// v1.1.4: canonical casing for document type labels.
//
// Three sources used to disagree about case:
//   1. BUILTIN_DOCUMENT_TYPE_LABELS  -- Title Case (correct)
//   2. DEFAULT_FILENAME_CODE_LABELS  -- Title Case (correct)
//   3. the historical backfill in initializeDocumentTypes(), which derives a
//      label from an orphaned key with key.replace(/_/g, " ") and therefore
//      produced lowercase labels like "technical bulletin".
//
// (3) was the real source of the lowercase labels: the backfill runs on every
// boot for any document_type still referenced by a document or chunk, and the
// code seeder then adopts that row via a CASE-INSENSITIVE label lookup, so the
// bad casing became sticky and re-created itself after each restart.
//
// Everything that writes a label now routes through titleCaseLabel().

/** Words whose canonical form is not simple Title Case. Keyed by UPPERCASE
 *  form so lookup is case-insensitive; the value is the exact output. */
export const LABEL_ACRONYMS: Record<string, string> = {
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
  KCC: "KCC",
};

/** True when a word carries deliberate internal casing or digits that naive
 *  title-casing would destroy -- "HyPAS", "MZ9500ci", "iOS". These are left
 *  exactly as the user typed them. */
function hasDeliberateShape(word: string): boolean {
  if (/\d/.test(word)) return true;
  // Genuine mixed case needs BOTH a lowercase letter and an uppercase letter
  // somewhere after the first character. Requiring the lowercase half matters:
  // without it an ALL-CAPS word like "SERVICE" reads as deliberate and is
  // never normalized down to "Service".
  const hasLower = /[a-z]/.test(word);
  const hasUpperAfterFirst = /[A-Z]/.test(word.slice(1));
  return hasLower && hasUpperAfterFirst;
}

/** Title Case a single word, preserving any leading/trailing punctuation. */
function caseWord(word: string): string {
  const m = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u.exec(word);
  if (!m) return word;
  const [, lead, core, trail] = m;
  if (!core) return word;

  const acronym = LABEL_ACRONYMS[core.toUpperCase()];
  if (acronym) return lead + acronym + trail;

  if (hasDeliberateShape(core)) return lead + core + trail;

  return lead + core.charAt(0).toUpperCase() + core.slice(1).toLowerCase() + trail;
}

/**
 * Canonical display casing for a document type label.
 *
 * Every word is capitalized, per the configured rule. Two exceptions:
 *   - words in LABEL_ACRONYMS keep their canonical form ("API", "HyPAS")
 *   - words with internal capitals or digits are left as typed ("MZ9500ci")
 *
 * Whitespace runs are collapsed to single spaces and the result is trimmed,
 * matching what the create/rename routes already do.
 */
export function titleCaseLabel(input: string): string {
  return String(input ?? "")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map(caseWord)
    .join(" ");
}

/** Label derived from a document_types key, used by the historical backfill.
 *  "technical_bulletin" -> "Technical Bulletin". */
export function labelFromKey(key: string): string {
  return titleCaseLabel(String(key ?? "").replace(/_/g, " "));
}
