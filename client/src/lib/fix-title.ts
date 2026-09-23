// -----------------------------------------------------------------------------
// Fix Title parser (v1.1.0)
// -----------------------------------------------------------------------------
//
// Originally ported VERBATIM from the "Fix Title -- Preview Tool" reference asset. The 16
// parser rules encoded here are LOCKED and were validated against the 25-line
// Doc-titles.txt real-filename corpus. Do NOT re-derive, "simplify", or tune
// these rules: the expected output for the whole corpus is pinned in
// scripts/fix-title.test.mjs and any behavioural change will fail that test.
//
// The only differences from the reference are TypeScript types and the removal
// of the tool's DOM wiring. v1.2.6 adds a conservative connector-word post-pass;
// the original corpus expectations remain unchanged.
//
// This module is PURE: no DOM, no I/O, no React. `fixTitle()` is safe to call
// from render paths and from tests under plain node.
// -----------------------------------------------------------------------------

export interface FixTitleResult {
  /** The cleaned, human-readable title. */
  title: string;
  /** The final token stream that produced `title`. */
  tokens: string[];
  /** Step-by-step tokenizer trace, or null unless `{ trace: true }` was passed. */
  trace: string[] | null;
}

export interface FixTitleOptions {
  /** Collect a human-readable tokenizer trace. Off by default (allocation-free). */
  trace?: boolean;
}

/** Model-number suffix letters. `x` is ALWAYS a real suffix letter, never dropped. */
const SUFFIX_LETTERS = new Set(['i', 'c', 'f', 'w', 'x', 'd', 'n']);

/**
 * Tokens that are recognized as standalone words even when glued to neighbours
 * (e.g. `...ENOGR2024` -> `EN` + `OG` + `R2024`). Order matters only in that
 * longer entries must not be shadowed by shorter prefixes; the reference set is
 * preserved exactly.
 */
const STANDALONE = new Set([
  'EN', 'FR', 'DE', 'ES', 'IT', 'JP', 'KO', 'ZH', // uppercase languages
  'OG', 'UG', 'SG', 'PG', 'MG', 'IG',             // guide types
  'TASKalfa', 'ECOSYS', 'KYOCERA',                // family names
  'HyPAS', 'KCC', 'GEN',                          // platform / family shorthand
]);
const LANGUAGE_CODES = new Set(['EN','FR','DE','ES','IT','JP','KO','ZH']);
// A glued language marker must be followed by a complete code chain or revision,
// not simply an uppercase letter in DEALER, DEVICE, DESIGN, ENGINE or ITALIAN.
function languageTailIsCode(tail: string): boolean {
  if (!tail || /^[0-9]/.test(tail) || /^(R|TB)\d/.test(tail) || /^[^A-Za-z]/.test(tail)) return true;
  const code = /^(EN|FR|DE|ES|IT|JP|KO|ZH|OG|UG|SG|PG|MG|IG)/.exec(tail);
  return !!code && languageTailIsCode(tail.slice(code[0].length));
}

/**
 * Lowercase single-letter language markers. ONLY recognized as an isolated
 * trailing token following a separator -- never inside a mixed word.
 */
const LOWERCASE_LANG_MARKERS = new Set(['e', 'f', 'd', 's', 'i', 'j']);

/** Expansions applied to specific standalone tokens after tokenization. */
const TOKEN_EXPANSIONS: Record<string, string> = { KDA: 'Kyocera' };

/** Compound lowercase words to split (case-insensitive match). */
const COMPOUND_SPLITS: Record<string, string[]> = {
  specsheet: ['Spec', 'Sheet'],
  datasheet: ['Data', 'Sheet'],
  whitepaper: ['White', 'Paper'],
};

// Deliberately bounded title vocabulary, not substring/dictionary segmentation.
// Only lowercase "and" joined to known task words is separated. This handles
// Printand / andscan / Printandscan without damaging Brand, Standard, Command,
// Android, names, model identifiers, or unknown compounds.
const CONNECTOR_NEIGHBORS = new Set([
  'print', 'scan', 'copy', 'fax', 'install', 'setup', 'configure', 'manage',
  'update', 'backup', 'restore', 'import', 'export', 'send', 'receive',
  'save', 'load', 'read', 'write',
]);

function splitJoinedAnd(token: string): string[] {
  const match = /^([A-Za-z]*?)and([A-Za-z]*)$/.exec(token);
  if (!match) return [token];
  const [, left, right] = match;
  if (!left && !right) return [token];
  if (left && !CONNECTOR_NEIGHBORS.has(left.toLowerCase())) return [token];
  if (right && !CONNECTOR_NEIGHBORS.has(right.toLowerCase())) return [token];
  return [left, 'and', right].filter(Boolean);
}

type Trace = string[] | null;

/** Case-normalize a matched standalone token back to its canonical form. */
function canonicalizeStandalone(tok: string): string {
  const up = tok.toUpperCase();
  for (const s of STANDALONE) {
    if (s.toUpperCase() === up) return s;
  }
  return tok;
}

interface ParsedDate {
  y: number;
  m: number;
  d: number;
}

/** Parse a 6-digit MMDDYY date. Returns null when it isn't a real calendar date. */
function tryParseSixDigitDate(digits: string): ParsedDate | null {
  if (!/^\d{6}$/.test(digits)) return null;
  const mm = +digits.slice(0, 2);
  const dd = +digits.slice(2, 4);
  const yy = +digits.slice(4, 6);
  if (mm < 1 || mm > 12) return null;
  if (dd < 1 || dd > 31) return null;
  // Two-digit year: 00-79 -> 2000s, 80-99 -> 1900s.
  const y = yy < 80 ? 2000 + yy : 1900 + yy;
  return { y, m: mm, d: dd };
}

function fmtDateYMD(d: ParsedDate): string {
  const mm = String(d.m).padStart(2, '0');
  const dd = String(d.d).padStart(2, '0');
  return `${d.y}/${mm}/${dd}`;
}

function fmtYearMonth(y: string, m: number): string {
  return `${y}/${String(m).padStart(2, '0')}`;
}

/** Revision year-month sticks to the R prefix with a dot separator. */
function fmtRevYearMonth(y: string, m: number): string {
  return `R${y}.${String(m).padStart(2, '0')}`;
}

function fmtRevYearOnly(y: string): string {
  return `R${y}`;
}

/**
 * Split a separator-free "word" into sub-tokens on CamelCase and model-number
 * boundaries. Mutually recursive with splitHyphenatedModels().
 */
function splitWord(word: string, trace: Trace): string[] {
  if (!word) return [];

  // Stray leading '-' from an upstream recursion.
  if (word.startsWith('-')) {
    trace && trace.push(`  ${word} → strip leading hyphen`);
    return splitWord(word.slice(1), trace);
  }

  // Hyphenated accessory model like `IB-37`, `IB-51`: the hyphen is PART of the
  // model token and must be retained.
  const hyphenModelMatch = word.match(/^([A-Z]{2}-\d+[a-z]{0,4})/);
  if (hyphenModelMatch) {
    const model = hyphenModelMatch[1];
    const rest = word.slice(model.length);
    trace && trace.push(`  ${word} → hyphen-model "${model}" + rest "${rest}"`);
    return [model, ...(rest ? splitWord(rest, trace) : [])];
  }

  // Ryyyy alone.
  const revYearMatch = word.match(/^R(\d{4})$/);
  if (revYearMatch) {
    const tok = fmtRevYearOnly(revYearMatch[1]);
    trace && trace.push(`  ${word} → ${tok}`);
    return [tok];
  }

  // Ryyyy.mm / Ryyyy_mm (defensive: outer level usually splits these already).
  const revYMMatch = word.match(/^R(\d{4})[._](\d{1,2})$/);
  if (revYMMatch) {
    const tok = fmtRevYearMonth(revYMMatch[1], +revYMMatch[2]);
    trace && trace.push(`  ${word} → ${tok}`);
    return [tok];
  }

  // TB<digits>[<lowercase>] Technical Bulletin code, e.g. TB1, TB128, TB11bc.
  const tbMatch = word.match(/^TB\d+[a-z]*/);
  if (tbMatch) {
    const tb = tbMatch[0];
    const rest = word.slice(tb.length);
    trace && trace.push(`  ${word} → TB compound "${tb}" + rest "${rest}"`);
    return [tb, ...(rest ? splitWord(rest, trace) : [])];
  }

  // Bare six-digit date word.
  const dateOnly = tryParseSixDigitDate(word);
  if (dateOnly) {
    trace && trace.push(`  ${word} → date ${fmtDateYMD(dateOnly)}`);
    return [fmtDateYMD(dateOnly)];
  }

  // Model token: optional two-letter prefix + digits + 0-4 suffix letters.
  const modelMatch = word.match(/^([A-Z]{2})?(\d+)([a-z]{0,4})/);
  if (
    modelMatch &&
    modelMatch[2] &&
    (!modelMatch[3] || [...modelMatch[3]].every((ch) => SUFFIX_LETTERS.has(ch)))
  ) {
    // Require a two-letter prefix OR at least one suffix letter, so a bare year
    // like `2019` is not misread as a model number.
    if (modelMatch[1] || modelMatch[3].length > 0) {
      const model = modelMatch[0];
      const rest = word.slice(model.length);
      trace && trace.push(`  ${word} → model "${model}" + rest "${rest}"`);
      if (rest.startsWith('-')) {
        const expanded = splitHyphenatedModels([rest], trace);
        return [model, ...expanded.flatMap((t) => splitWord(t, trace))];
      }
      return [model, ...(rest ? splitWord(rest, trace) : [])];
    }
  }

  // Standalone token at the start of the word.
  for (const s of STANDALONE) {
    if (word.toUpperCase().startsWith(s.toUpperCase()) && word.length > 0) {
      // Only match when followed by end, uppercase, or digit -- so `ENOG`
      // yields EN then leaves OG for the next round.
      const after = word[s.length];
      if (LANGUAGE_CODES.has(s) && !languageTailIsCode(word.slice(s.length))) continue;
      if (after === undefined || /[A-Z0-9]/.test(after) || !/[a-z]/.test(after)) {
        const rest = word.slice(s.length);
        trace && trace.push(`  ${word} → standalone "${s}" + rest "${rest}"`);
        return [
          canonicalizeStandalone(word.slice(0, s.length)),
          ...(rest ? splitWord(rest, trace) : []),
        ];
      }
    }
  }

  // CamelCase split on the first lowercase -> uppercase boundary.
  const camelMatch = word.match(/^([A-Za-z]+?[a-z])([A-Z].*)$/);
  if (camelMatch) {
    trace && trace.push(`  ${word} → camel "${camelMatch[1]}" + "${camelMatch[2]}"`);
    return [camelMatch[1], ...splitWord(camelMatch[2], trace)];
  }

  // Last resort: an unidentified internal hyphen.
  const hyphenIdx = word.indexOf('-');
  if (hyphenIdx > 0 && hyphenIdx < word.length - 1) {
    const left = word.slice(0, hyphenIdx);
    const right = word.slice(hyphenIdx + 1);
    trace && trace.push(`  ${word} → hyphen-split "${left}" + "${right}"`);
    return [...splitWord(left, trace), ...splitWord(right, trace)];
  }

  return [word];
}

/** Merge stray `R` + `yyyy` (+ optional `mm`) into `Ryyyy.mm`. */
function mergeRevYearMonth(tokens: string[], trace: Trace): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];
    if (t === 'R' && next && /^\d{4}$/.test(next)) {
      const after = tokens[i + 2];
      if (after && /^\d{1,2}$/.test(after) && +after >= 1 && +after <= 12) {
        const tok = fmtRevYearMonth(next, +after);
        out.push(tok);
        trace && trace.push(`  merge R + ${next} + ${after} → ${tok}`);
        i += 2;
        continue;
      }
      const tok = fmtRevYearOnly(next);
      out.push(tok);
      trace && trace.push(`  merge R + ${next} → ${tok}`);
      i += 1;
      continue;
    }
    out.push(t);
  }
  return out;
}

/**
 * Recognize nested software-version + date: `R<version>.<yyyy>.<mm>`, e.g.
 * `R1.5.0.2025.06` -> `R1.5.0` + `2025/06`.
 */
function mergeRSoftwareVersionAndDate(tokens: string[], trace: Trace): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    const rDigitMatch = /^R(\d+)$/.exec(t);
    if (rDigitMatch) {
      const versionParts: string[] = [rDigitMatch[1]];
      let j = i + 1;
      while (j < tokens.length && /^\d+$/.test(tokens[j])) {
        versionParts.push(tokens[j]);
        j++;
      }
      // Peel a trailing calendar year+month off the version chain.
      if (versionParts.length >= 3) {
        const maybeYear = versionParts[versionParts.length - 2];
        const maybeMonth = versionParts[versionParts.length - 1];
        if (
          /^\d{4}$/.test(maybeYear) &&
          +maybeYear >= 1900 &&
          +maybeYear <= 2099 &&
          /^\d{1,2}$/.test(maybeMonth) &&
          +maybeMonth >= 1 &&
          +maybeMonth <= 12
        ) {
          const version = versionParts.slice(0, -2).join('.');
          const date = fmtYearMonth(maybeYear, +maybeMonth);
          out.push(`R${version}`, date);
          trace &&
            trace.push(
              `  merge R-version+date [${versionParts.join(',')}] → R${version} ${date}`,
            );
          i = j;
          continue;
        }
      }
      if (versionParts.length > 1) {
        const version = versionParts.join('.');
        out.push(`R${version}`);
        trace && trace.push(`  merge R-version [${versionParts.join(',')}] → R${version}`);
        i = j;
        continue;
      }
    }
    out.push(t);
    i++;
  }
  return out;
}

/** Convert hyphen-glued model chains into space-separated model tokens. */
function splitHyphenatedModels(tokens: string[], trace: Trace): string[] {
  const modelShape = /^([A-Z]{2}\d+[a-z]{0,4}|\d+[a-z]{1,4})$/;
  const out: string[] = [];
  for (const t of tokens) {
    if (!t.includes('-')) {
      out.push(t);
      continue;
    }
    const parts = t.split('-').filter(Boolean);
    // Peel model-shaped tokens off the FRONT.
    let peeled = 0;
    while (peeled < parts.length && modelShape.test(parts[peeled])) peeled++;
    if (peeled === 0) {
      out.push(t);
      continue;
    }

    const models = parts.slice(0, peeled);
    const tailParts = parts.slice(peeled);

    if (tailParts.length === 0) {
      trace && trace.push(`  split hyphen-chain "${t}" → [${models.join(', ')}]`);
      out.push(...models);
    } else {
      trace &&
        trace.push(
          `  peel hyphen-models "${t}" → [${models.join(', ')}] + tail "${tailParts.join('-')}"`,
        );
      out.push(...models);
      const firstTail = tailParts[0];
      out.push(...splitWord(firstTail, trace));
      // Later tail segments keep their hyphenation.
      if (tailParts.length > 1) {
        out.push('-' + tailParts.slice(1).join('-'));
      }
    }
  }
  return out;
}

/** Trailing edition tags like `-CCRX`, `-FAX`, `-UserGuide` become words. */
function stripTrailingEditionHyphen(s: string, trace: Trace): string {
  const m = s.match(/((?:-[A-Za-z][A-Za-z0-9]*)+)$/);
  if (!m) return s;
  const replaced = s.slice(0, -m[0].length) + ' ' + m[0].slice(1).replace(/-/g, ' ');
  trace &&
    trace.push(
      `strip trailing edition hyphens "${m[0]}" → " ${m[0].slice(1).replace(/-/g, ' ')}"`,
    );
  return replaced;
}

/** Expand mapped tokens (KDA -> Kyocera) and split known compound words. */
function expandTokens(tokens: string[], trace: Trace): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    if (TOKEN_EXPANSIONS[t]) {
      trace && trace.push(`  expand ${t} → ${TOKEN_EXPANSIONS[t]}`);
      out.push(TOKEN_EXPANSIONS[t]);
      continue;
    }
    const lower = t.toLowerCase();
    if (COMPOUND_SPLITS[lower]) {
      const parts = COMPOUND_SPLITS[lower];
      trace && trace.push(`  compound-split ${t} → ${parts.join(' ')}`);
      out.push(...parts);
      continue;
    }
    out.push(t);
  }
  return out;
}

/**
 * Turn a raw uploaded filename into a clean document title.
 *
 * ALWAYS call this with the ORIGINAL uploaded filename (`doc.originalFilename`),
 * never with the current Title field value -- re-parsing an already-parsed
 * title is not idempotent and would degrade it.
 */
export function fixTitle(rawFilename: string, opts: FixTitleOptions = {}): FixTitleResult {
  const trace: Trace = opts.trace ? [] : null;

  // 1. Strip extension. The first char must be a letter so trailing revision
  //    fragments like `.7` or `.09` are NOT mistaken for an extension.
  let s = rawFilename.replace(/\.[A-Za-z][A-Za-z0-9]{0,4}$/, '');
  trace && trace.push(`strip ext → "${s}"`);

  // 1b. Extract a trailing lowercase language marker (`_e`, `_f`, ...) now so it
  //     survives later processing, then re-append it at step 11.
  let trailingLangMarker: string | null = null;
  const langMatch = s.match(/[_\-\s]([efdsij])$/);
  if (langMatch && LOWERCASE_LANG_MARKERS.has(langMatch[1])) {
    trailingLangMarker = langMatch[1]; // kept lowercase, per the locked rules
    s = s.slice(0, -langMatch[0].length);
    trace && trace.push(`extract trailing lang marker "${trailingLangMarker}" → "${s}"`);
  }

  // 1c. Trailing edition hyphen tokens.
  s = stripTrailingEditionHyphen(s, trace);

  // 2. Stash `_MMDDYY` dates behind a sentinel that survives step 4.
  const datePlaceholders: string[] = [];
  s = s.replace(/_(\d{6})(?=[^\d]|$)/g, (m, digits: string) => {
    const d = tryParseSixDigitDate(digits);
    if (!d) return m; // not a real date -- leave it alone
    const key = `§DATE${datePlaceholders.length}§`;
    datePlaceholders.push(fmtDateYMD(d));
    return ` ${key} `;
  });
  trace &&
    trace.push(
      `date stash → "${s}" ${datePlaceholders.length ? JSON.stringify(datePlaceholders) : ''}`,
    );

  // 3. Stash Ryyyy.mm / Ryyyy_mm so their inner separators survive step 4.
  s = s.replace(/R(\d{4})[._](\d{1,2})(?![\d])/g, (m, y: string, mm: string) => {
    if (+mm < 1 || +mm > 12) return m;
    const key = `§REV${datePlaceholders.length}§`;
    datePlaceholders.push(fmtRevYearMonth(y, +mm));
    return ` ${key} `;
  });
  trace && trace.push(`rev stash → "${s}"`);

  // 4. Underscores, periods, and commas become spaces. Hyphens are preserved
  //    for splitHyphenatedModels() to handle post-tokenization.
  s = s.replace(/[_.,]/g, ' ');
  trace && trace.push(`separators → space → "${s}"`);

  // 5. Collapse, trim, split into words.
  s = s.replace(/\s+/g, ' ').trim();
  const words = s.length ? s.split(' ') : [];

  // 6. Sub-split each word (placeholders pass straight through).
  let tokens: string[] = [];
  for (const w of words) {
    if (/^§(?:DATE|REV)\d+§$/.test(w)) {
      const idx = +w.replace(/\D/g, '');
      tokens.push(datePlaceholders[idx]);
      continue;
    }
    trace && trace.push(`split word "${w}"`);
    tokens.push(...splitWord(w, trace));
  }

  // 7-10. Post-passes, in this exact order.
  tokens = mergeRevYearMonth(tokens, trace);
  tokens = mergeRSoftwareVersionAndDate(tokens, trace);
  tokens = splitHyphenatedModels(tokens, trace);
  tokens = expandTokens(tokens, trace);
  tokens = tokens.flatMap((token) => {
    const parts = splitJoinedAnd(token);
    if (parts.length > 1) trace && trace.push(`  connector-split ${token} → ${parts.join(' ')}`);
    return parts;
  });

  // 11. Re-append the trailing language marker from step 1b.
  if (trailingLangMarker) tokens.push(trailingLangMarker);

  // 12. Join. Note: `x` is always a real model-suffix letter -- there is no
  //     special-casing of "x before Series".
  const finalStr = tokens.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  trace && trace.push(`final → "${finalStr}"`);

  return { title: finalStr, tokens, trace };
}

/**
 * Basic filename cleanup used ONLY to decide whether the current Title looks
 * "untouched" (i.e. still machine-derived) before Fix Title overwrites it.
 * Deliberately dumb: strip the extension and swap separators for spaces.
 */
export function basicFilenameCleanup(rawFilename: string): string {
  return rawFilename
    .replace(/\.[A-Za-z][A-Za-z0-9]{0,4}$/, '')
    .replace(/[_.,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
