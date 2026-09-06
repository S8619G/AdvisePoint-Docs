// v0.9.18 - Shared search-term highlighting.
//
// Extracted from query.tsx so the in-document search panel (PageViewer) can
// use the exact same tokenization + <mark> rendering. Behavior is unchanged
// from what shipped in v0.9.17.

import type { ReactNode } from "react";

const STOPWORDS = new Set([
  "a","an","and","or","the","is","are","was","were","be","been","being",
  "to","of","in","on","for","at","by","from","with","as","it","its",
  "this","that","these","those","i","you","we","they","he","she",
  "do","does","did","how","what","when","where","why","which","who",
  "can","could","should","would","will","may","might","must","about",
  "my","your","our","their","me","us","them","into","than","then",
  "so","if","but","not","no","yes","any","all","some","there","here",
]);

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Tokenize a raw search query into terms worth highlighting.
// Quoted phrases are preserved as whole terms; when quotes are present the
// unquoted remainder is ignored, matching the server's required-phrase gate.
export function extractTerms(query: string): string[] {
  if (!query) return [];
  const phrases: string[] = [];
  const quoteRe = /["\u201C\u201D]([^"\u201C\u201D]+)["\u201C\u201D]/g;
  let qm: RegExpExecArray | null;
  while ((qm = quoteRe.exec(query)) !== null) {
    const p = qm[1].trim();
    if (p.length > 0) phrases.push(p.toLowerCase());
  }
  if (phrases.length > 0) {
    return Array.from(new Set(phrases)).sort((a, b) => b.length - a.length);
  }
  const raw = query
    .toLowerCase()
    .split(/[^a-z0-9._-]+/i)
    .filter(Boolean);
  const terms = new Set<string>();
  for (const t of raw) {
    if (t.length < 2) continue;
    if (STOPWORDS.has(t)) continue;
    terms.add(t);
  }
  return Array.from(terms).sort((a, b) => b.length - a.length);
}

export function Highlight({ text, query }: { text: string; query: string }): ReactNode {
  const terms = extractTerms(query);
  if (terms.length === 0 || !text) return <>{text}</>;
  const patternSource = terms
    .map((t) => {
      if (t.includes(" ")) {
        return t.split(/\s+/).map(escapeRegex).join("\\s+");
      }
      return escapeRegex(t);
    })
    .join("|");
  const pattern = new RegExp(`(${patternSource})`, "gi");
  const parts = text.split(pattern);
  return (
    <>
      {parts.map((part, idx) => {
        if (idx % 2 === 1) {
          return (
            <mark
              key={idx}
              className="rounded-sm bg-amber-200/70 px-0.5 text-amber-950 dark:bg-amber-500/25 dark:text-amber-100"
              data-testid="highlight"
            >
              {part}
            </mark>
          );
        }
        return <span key={idx}>{part}</span>;
      })}
    </>
  );
}
