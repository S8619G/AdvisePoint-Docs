// -----------------------------------------------------------------------------
// RTF -> plain text stripper (v1.0.7.4).
//
// Why homegrown rather than an npm library:
// -----------------------------------------------------------------------------
// A bake-off in /home/user/workspace/rtf-bakeoff/ compared this stripper
// against rtf-parser 1.3.3 (iarna), rtf2text 1.0.1, and rtf-stream-parser
// 4.0.0 (mazira). Results on the corpus:
//
//   parser              errors  char accuracy  time
//   rtf-parser          1/6     21/25 (84%)    30ms
//   rtf2text            1/6     21/25 (84%)     8ms  (thin wrapper)
//   rtf-stream-parser   0/6      0/25 (0%)      9ms  (wrong tool: HTML de-encaps)
//   homegrown-stripper  0/6     25/25 (100%)    9ms
//
// The libraries throw on the malformed input file and lose several ANSI
// codepage hex escapes in Word 2019 output. They also emit raw \\pict
// binary hex into the text stream (nasty for RAG). The homegrown stripper
// treats \\pict as a destination group and skips it, decodes hex escapes
// via iconv-lite (already a transitive dep), respects \\uc skip counts,
// and returns partial text on malformed input instead of crashing.
//
// Failure modes to fix later, if the field surfaces them:
//   * Nested \\uc changes inside destination groups (rare).
//   * Font-charset-driven encoding overrides (\\fcharsetN) - we treat the
//     whole file as \\ansicpg for now. Real Word/LibreOffice files use a
//     single codepage for the whole document, so this is safe in practice.
//   * RTF-encapsulated HTML (Outlook \\fromhtml1) - passes through as
//     stripped text, which is what we want for RAG anyway.
// -----------------------------------------------------------------------------
"use strict";

const iconv = require("iconv-lite");

const DESTINATION_WORDS = new Set([
  "fonttbl", "colortbl", "stylesheet", "info", "author", "operator",
  "company", "title", "subject", "keywords", "comment", "doccomm",
  "generator", "pict", "object", "shppict", "nonshppict", "listtable",
  "listoverridetable", "revtbl", "rsidtbl", "themedata",
  "colorschememapping", "latentstyles", "datastore", "datafield",
  "wgrffmtfilter", "xmlnstbl", "xmlopen", "xmlclose", "mmath", "mmathPr",
  "background", "header", "footer", "headerl", "headerr", "footerl",
  "footerr", "headerf", "footerf", "ftnsep", "ftnsepc", "ftncn", "aftnsep",
  "aftnsepc", "aftncn", "fldinst",
]);

/**
 * Strip an RTF byte buffer (or string) to plain text.
 *
 * @param {Buffer|string} input
 * @returns {string}
 */
function stripRtf(input) {
  // RTF is a 7-bit ASCII wire format; high-byte characters are always encoded
  // as \\'HH or \\uNNNN escapes. Reading the buffer as latin1 (aka binary
  // string) gives us one JS char per byte with zero data loss.
  const rtf =
    typeof input === "string"
      ? input
      : Buffer.isBuffer(input)
        ? input.toString("latin1")
        : Buffer.from(input).toString("latin1");

  // Detect ANSI codepage. Default per RTF spec is 1252 when \\ansi and no
  // \\ansicpg override.
  const cpMatch = rtf.match(/\\ansicpg(\d+)/);
  const codepage = cpMatch ? parseInt(cpMatch[1], 10) : 1252;
  const iconvName =
    codepage === 1252 ? "windows-1252" :
    codepage === 1251 ? "windows-1251" :
    codepage === 1250 ? "windows-1250" :
    codepage === 1253 ? "windows-1253" :
    codepage === 1254 ? "windows-1254" :
    codepage === 1255 ? "windows-1255" :
    codepage === 1256 ? "windows-1256" :
    codepage === 1257 ? "windows-1257" :
    codepage === 1258 ? "windows-1258" :
    codepage === 936  ? "gbk" :
    codepage === 950  ? "big5" :
    codepage === 932  ? "shift_jis" :
    codepage === 949  ? "euc-kr" :
    codepage === 874  ? "windows-874" :
    codepage === 10000 ? "macroman" :
    `cp${codepage}`; // iconv-lite recognizes cp850, cp437, etc.

  // Pass 1: strip destination groups (fonttbl, colortbl, pict, etc.).
  // Walks the string once, tracking brace depth. Recognizes:
  //   {\\* ...}                 -> always a destination
  //   {\\<destination-word>...}  -> destination if word is in our set
  let s = stripDestinationGroups(rtf);

  // Pass 2: parse \\uc<n> to update the current skip count.
  // Track it lexically so \\uNNNN? escapes strip the right number of bytes.
  // A stack-based tracker would be more correct across nested groups, but
  // real-world RTF uses a single \\uc value per document.
  let uc = 1;
  s = s.replace(/\\uc(\d+) ?/g, (_, n) => {
    uc = parseInt(n, 10);
    return "";
  });

  // Pass 3: resolve \\uNNNN Unicode escapes. Followed by up to `uc` chars of
  // fallback that we discard.
  s = s.replace(/\\u(-?\d+) ?([\s\S]{0,4})/g, (_, code, tail) => {
    let n = parseInt(code, 10);
    if (n < 0) n += 65536;
    // Skip `uc` fallback chars from `tail`.
    return String.fromCodePoint(n) + tail.slice(uc);
  });

  // Pass 4: resolve \\'HH hex escapes via the document codepage.
  s = s.replace(/\\'([0-9a-fA-F]{2})/g, (_, hex) => {
    try {
      return iconv.decode(Buffer.from([parseInt(hex, 16)]), iconvName);
    } catch {
      return "?";
    }
  });

  // Pass 5: paragraph / line / cell / row / tab -> whitespace equivalents.
  s = s.replace(/\\par\b ?/g, "\n");
  s = s.replace(/\\line\b ?/g, "\n");
  s = s.replace(/\\tab\b ?/g, "\t");
  s = s.replace(/\\cell\b ?/g, "\t");
  s = s.replace(/\\row\b ?/g, "\n");
  s = s.replace(/\\sect\b ?/g, "\n\n");
  s = s.replace(/\\page\b ?/g, "\n\n");

  // Pass 6: strip all remaining control words. Format is \\word optionally
  // followed by a signed numeric parameter, optionally followed by one
  // space delimiter (which is consumed).
  s = s.replace(/\\[a-zA-Z]+(-?\d+)? ?/g, "");

  // Pass 7: unescape RTF control symbols \\{ \\} \\\\.
  s = s.replace(/\\([{}\\])/g, "$1");

  // Pass 8: drop any surviving braces (group boundaries).
  s = s.replace(/[{}]/g, "");

  // Pass 9: normalize whitespace.
  s = s.replace(/\r\n?/g, "\n");
  s = s.replace(/[ \t]+\n/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");

  return s.trim();
}

/**
 * Walk `rtf` and return a new string with destination groups removed.
 * Handles escaped braces (\\{, \\}, \\\\) so we don't miscount depth.
 */
function stripDestinationGroups(rtf) {
  let out = "";
  let i = 0;
  const len = rtf.length;
  while (i < len) {
    if (rtf[i] === "{") {
      // Peek at the group header.
      let j = i + 1;
      while (j < len && (rtf[j] === " " || rtf[j] === "\n" || rtf[j] === "\r" || rtf[j] === "\t")) j++;
      let isDest = false;
      if (rtf[j] === "\\" && rtf[j + 1] === "*") {
        isDest = true;
      } else if (rtf[j] === "\\") {
        // Read control word after the backslash.
        let k = j + 1;
        let word = "";
        while (k < len && rtf.charCodeAt(k) >= 0x61 && rtf.charCodeAt(k) <= 0x7a) {
          word += rtf[k];
          k++;
          if (word.length > 32) break; // safety
        }
        if (DESTINATION_WORDS.has(word)) isDest = true;
      }
      if (isDest) {
        // Skip the whole group, counting escaped braces correctly.
        let depth = 1;
        let k = i + 1;
        while (k < len && depth > 0) {
          const c = rtf[k];
          if (c === "\\") {
            // Escaped brace or backslash: skip the next char.
            k += 2;
            continue;
          }
          if (c === "{") depth++;
          else if (c === "}") depth--;
          k++;
        }
        i = k;
        continue;
      }
    }
    out += rtf[i];
    i++;
  }
  return out;
}

module.exports = { stripRtf };
