// -----------------------------------------------------------------------------
// Product model / family derivation (v1.1.3)
// -----------------------------------------------------------------------------
//
// Turns a filename into a suggested { product_family, product_model } pair for
// the Upload tab, so a tech does not retype a model that is already sitting in
// the filename.
//
// RELATIONSHIP TO fix-title.ts
// This module is strictly ADDITIVE and consumes `fixTitle().tokens` read-only.
// It does NOT modify, re-derive, or tune any of the 16 LOCKED parser rules, and
// it must never need to: if a change here would require a tokenizer change,
// that is a separate, explicit decision. The tokenizer's corpus test is the
// contract, and it stays byte-identical.
//
// WHY CLASSIFY HERE INSTEAD OF INSIDE THE TOKENIZER
// The plan originally called for adding a per-token "kind" to fixTitle()'s
// result. That would mean editing the locked module, and the classification
// needs something the tokenizer deliberately has no access to: the user's LIVE
// document-type code list. Keeping it out here means the tokenizer stays pure
// and pinned, and the code exclusion below stays correct when the user adds a
// code of their own.
//
// ALL RULES BELOW WERE DERIVED FROM THE REAL 25-FILENAME CORPUS in
// scripts/fix-title-corpus.txt, not from invented examples.
// -----------------------------------------------------------------------------

import { fixTitle } from "./fix-title";

export interface DerivedProduct {
  /** Suggested product family, or "" when none is recognized. */
  product_family: string;
  /** Suggested product model, or "" when none is recognized. */
  product_model: string;
  /** The tokens classified as models, before joining. Exposed for tests/debug. */
  modelTokens: string[];
}

/**
 * Product families we are willing to name. Deliberately SHORT.
 *
 * "Kyocera" is the manufacturer, not a family, and `KDA` expands to it on
 * nearly every brochure -- treating it as a family would tag most of the
 * library with one meaningless value. `HyPAS`, `KCC` and `GEN` are platform /
 * document shorthand, not product lines. Adding a name here is a deliberate
 * act; guessing produces a filter dimension nobody can trust.
 */
const FAMILY_NAMES = ["TASKalfa", "ECOSYS"];

/**
 * Sub-line words that appear glued to a model number ("Pro15000c"). The
 * tokenizer leaves these joined because splitting them is not needed for a
 * readable title. For the model FIELD the user wants "TASKalfa Pro 15000c",
 * so we separate the word from its digits here.
 *
 * NOTE: no filename in the current corpus exercises this. It is included
 * because the expected output was specified directly, but it is unverified
 * against a real file.
 */
const MODEL_PREFIX_WORDS = ["Pro"];

/** Trailing token meaning "this covers the whole series". */
const SERIES_TOKEN = "series";

/**
 * Tokens that look model-shaped but are revision or date markers.
 *   R2024.07, R2025.09, R1.5.0, R1
 * Anything with a dot or slash is a version/date, never a model number.
 */
function isRevisionOrDate(token: string): boolean {
  if (/[./]/.test(token)) return true;
  if (/^R\d+$/i.test(token)) return true;
  return false;
}

/**
 * Is this token a document-type code followed by a number -- TB1, TB17, TB128,
 * TB11bc, OG2, UG3?
 *
 * These are bulletin/guide numbers, NEVER product models. Confirmed by the user
 * 2026-09-13: "TB1 R1 is technical bulletin 1 revision one", "TB128 is the
 * 128th revision of that tech bulletin".
 *
 * The code list is passed in LIVE from the user's settings rather than
 * hardcoded, so a code the user adds themselves is excluded too.
 *
 * Known tradeoff: a real model whose name begins with a configured code and
 * then digits (a hypothetical "PG5000x" against the default `PG` code) would be
 * excluded. Accepted -- the codes are a small, user-controlled list, and a
 * wrongly-skipped suggestion is a blank field, not bad data.
 */
function isDocumentTypeCode(token: string, codes: string[]): boolean {
  for (const code of codes) {
    if (!code) continue;
    const re = new RegExp(`^${code}\\d+[a-z]*$`, "i");
    if (re.test(token)) return true;
  }
  return false;
}

/**
 * Does this token look like a product model number?
 *
 * Shapes seen in the corpus:
 *   2554ci  4004i  7353ci  308ci   -- digits + suffix letters, no prefix
 *   MA6000cifx  PA6000x  MZ10500i  -- letter prefix + digits + suffix
 *   IB-37  IB-38                   -- letter prefix + HYPHEN + digits
 *
 * Requirements, each one earning its place from the corpus:
 *  - at least two digits, so `4` and `0` from "ver.4.0" are not models;
 *  - EITHER a letter prefix OR trailing suffix letters, so the bare date code
 *    `0217` in the Nova brochure filename is not a model;
 *  - at most 3 prefix letters, so words like "Encription" never qualify.
 *
 * The hyphen in `IB-37` is part of the model NAME and is preserved. The
 * tokenizer already handles this correctly -- hyphens that SEPARATE models
 * ("MZ9500ci-MZ10500i") are split by the tokenizer before we see them.
 */
function isModelToken(token: string, codes: string[]): boolean {
  if (isRevisionOrDate(token)) return false;
  if (isDocumentTypeCode(token, codes)) return false;

  const m = /^([A-Za-z]{0,3})(-?)(\d{2,})([a-z]{0,4})$/.exec(token);
  if (!m) return false;
  const [, prefix, , , suffix] = m;
  // Must be anchored by a prefix or a suffix; bare digit runs are dates/codes.
  if (!prefix && !suffix) return false;
  return true;
}

/** "Pro15000c" -> "Pro 15000c". Leaves anything else untouched. */
function splitPrefixWord(token: string): string {
  for (const word of MODEL_PREFIX_WORDS) {
    const re = new RegExp(`^(${word})(\\d.*)$`, "i");
    const m = re.exec(token);
    if (m) return `${m[1]} ${m[2]}`;
  }
  return token;
}

/** Find a known family name among the tokens, matched case-insensitively. */
function findFamily(tokens: string[]): string {
  for (const token of tokens) {
    for (const family of FAMILY_NAMES) {
      if (token.toLowerCase() === family.toLowerCase()) return family;
    }
  }
  return "";
}

/**
 * Derive a family and model suggestion from a filename.
 *
 * @param filename  Raw filename, with or without extension.
 * @param codes     LIVE document-type codes from settings (TB, OG, UG, ...).
 */
export function deriveProduct(filename: string, codes: string[] = []): DerivedProduct {
  const { tokens } = fixTitle(filename);

  const modelTokens: string[] = [];
  let sawSeries = false;

  for (const token of tokens) {
    if (token.toLowerCase() === SERIES_TOKEN) {
      // Only meaningful if it follows at least one model; a "Series" in a
      // marketing name ("Nova Series Brochure") must not produce a model.
      if (modelTokens.length > 0) sawSeries = true;
      continue;
    }
    if (isModelToken(token, codes)) {
      modelTokens.push(splitPrefixWord(token));
    }
  }

  if (modelTokens.length === 0) {
    // No model found is a legitimate outcome now that Product Model is
    // optional. Report the family if we saw one -- it is still useful.
    return { product_family: findFamily(tokens), product_model: "", modelTokens: [] };
  }

  const family = findFamily(tokens);

  // Decision 2026-09-13: collapse repeated "Series" markers to ONE trailing
  // "Series". "MA6000cifxSeries-PA6000xSeries" reads as one series statement
  // covering both models, and this keeps it consistent with the already-correct
  // "MZ9500ci MZ10500i Series".
  const parts = [...modelTokens];
  if (sawSeries) parts.push("Series");

  // Decision 2026-09-13: populate BOTH fields, prefixing the family onto the
  // model so the model reads properly on its own. The Library card hides the
  // now-redundant Family row; the stored family is kept so the Family filter
  // still finds the document.
  const product_model = family ? `${family} ${parts.join(" ")}` : parts.join(" ");

  return { product_family: family, product_model, modelTokens };
}
