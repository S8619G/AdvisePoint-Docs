// Derives page numbers and section titles for excerpts by parsing the
// "-- N of TOTAL --" markers that our PDF extractor leaves inline.
//
// Two entry points:
//   - deriveLocation(content, prevPage): pure function; use at ingest time
//     for every fresh excerpt.
//   - backfillMissingLocations(db): one-shot startup pass that populates
//     page_start / page_end / section_title for excerpts that don't have
//     them yet. Safe to run every startup — it's an idempotent no-op once
//     everything is populated.

import type Database from "better-sqlite3";

const PAGE_MARKER = /--\s+(\d+)\s+of\s+(\d+)\s+--/g;

export type DerivedLocation = {
  page_start: number | null;
  page_end: number | null;
  section_title: string | null;
};

/**
 * Given an excerpt's content and the last known page from the preceding
 * excerpt, derive the page range this excerpt covers and a best-guess
 * section title.
 */
export function deriveLocation(
  content: string,
  prevPage: number | null,
): DerivedLocation {
  const markers = Array.from(content.matchAll(PAGE_MARKER)).map((m) => parseInt(m[1], 10));
  let page_start: number | null;
  let page_end: number | null;

  if (markers.length === 0) {
    // No page marker in this excerpt — assume it's on the same page as the
    // last one we saw. If we don't know that either, leave null.
    page_start = prevPage;
    page_end = prevPage;
  } else {
    // The first marker in an excerpt is the page it moves *to*, so the
    // excerpt actually starts on the previous page (if we know it).
    page_start = prevPage ?? markers[0];
    page_end = markers[markers.length - 1];
  }

  const section_title = deriveSectionTitle(content);
  return { page_start, page_end, section_title };
}

/**
 * Best-effort section title extraction. Manufacturer manuals use short headers
 * like "Address Book" or "Configuring External Address Book Settings"
 * right before a "-- N of N --" marker or at the top of a page.
 * We look for a short line (<= 60 chars, mostly Title Case or Sentence
 * case, no trailing punctuation) that immediately precedes the first
 * page marker in the excerpt, or falls near the start.
 */
function deriveSectionTitle(content: string): string | null {
  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  // Strategy 1: line immediately before the first page marker.
  for (let i = 1; i < lines.length; i++) {
    if (PAGE_MARKER.test(lines[i])) {
      PAGE_MARKER.lastIndex = 0; // reset global regex state
      const candidate = lines[i - 1];
      const title = pickHeadingCandidate(candidate);
      if (title) return title;
      // Also try the line before that (footer often has "Section 5-8 User Guide" first)
      if (i >= 2) {
        const older = pickHeadingCandidate(lines[i - 2]);
        if (older) return older;
      }
      break;
    }
    PAGE_MARKER.lastIndex = 0;
  }

  // Strategy 2: first heading-like line in the excerpt.
  for (const line of lines.slice(0, 6)) {
    const title = pickHeadingCandidate(line);
    if (title) return title;
  }

  return null;
}

function pickHeadingCandidate(line: string): string | null {
  if (!line) return null;
  const t = line.trim();
  if (t.length < 3 || t.length > 60) return null;
  // Skip lines with obvious non-heading punctuation
  if (/[.:;,…]$/.test(t)) return null;
  // Skip lines that are all digits, page markers, dots, or dashes
  if (/^\d+$/.test(t)) return null;
  if (/^-{2,}/.test(t) || /-{2,}\s+\d+\s+of\s+\d+/.test(t)) return null;
  if (/^[.\-–—•▪▫\s]+$/.test(t)) return null;
  // Skip vendor-specific footer / product-line noise
  if (/\b(user guide|command center rx|operation guide)\b/i.test(t)) return null;
  // Skip TOC bleed: "Chapter 3 About Login", "Chapter 1 Introduction", etc.
  // (real section headings almost never lead with "Chapter")
  if (/^chapter\s+\d+\b/i.test(t)) return null;
  // Skip lines with commas or slashes suggesting a list, not a header
  if (/[,⁄\/]/.test(t) && (t.match(/[,⁄\/]/g) || []).length >= 2) return null;
  // Skip inline sentences (lots of lowercase words)
  const lowerWords = (t.match(/\b[a-z]{4,}\b/g) || []).length;
  const totalWords = (t.match(/\S+/g) || []).length;
  if (totalWords > 3 && lowerWords / totalWords > 0.5) return null;
  // Skip lines starting with typical body prefixes
  if (/^(select|enter|configure|specify|to |the |this |for |if |when |you |we |your |a |an |from )/i.test(t)) return null;
  // Skip TOC lines that end with a page number (".... 5-8" or "..... 42")
  if (/[.… ]\d+$/.test(t)) return null;
  // Skip TOC entries containing "(page X)" references
  if (/\(page\s+[\d-]+\)/i.test(t)) return null;
  // Skip lines that are mostly dots or ellipses (TOC dotted leaders)
  if ((t.match(/\./g) || []).length >= 4) return null;
  // Skip breadcrumb-style headers starting with ">" or "›"
  if (/^[>›]/.test(t)) return null;
  // Skip callout labels
  if (/^(NOTE|IMPORTANT|CAUTION|WARNING|TIP|DANGER|Page)$/i.test(t)) return null;
  // Skip table column headers (tab-separated words)
  if (/\t/.test(t)) return null;
  // Skip "refer to X" fragments and cut-offs
  if (/\brefer to\b|\bsee\b/i.test(t)) return null;
  // Skip lines with unbalanced parens (likely cut off)
  const opens = (t.match(/\(/g) || []).length;
  const closes = (t.match(/\)/g) || []).length;
  if (opens !== closes) return null;
  // Skip fragments ending in a stopword (preposition / conjunction / article)
  if (/\s(in|on|of|to|for|the|a|an|at|by|and|or|is|are|was|were|be|as|with|from|into|onto)$/i.test(t)) return null;
  // Skip fragments starting with a bullet or a lowercase word
  if (/^[•▪▫*\-]/.test(t)) return null;
  if (/^[a-z]/.test(t)) return null;
  // Prefer headings that are Title Case or contain at least one capitalized word
  const capitalized = (t.match(/\b[A-Z][a-z]+/g) || []).length;
  if (capitalized === 0 && !/^[A-Z]{2,}\b/.test(t)) return null;
  return t;
}

/**
 * Populate page_start / page_end / section_title for any chunks that
 * don't have them yet. Groups by parent_id and processes each document's
 * chunks in order so we can carry the running page forward.
 */
export function backfillMissingLocations(db: Database.Database): number {
  const docs = db
    .prepare(
      `SELECT DISTINCT parent_id FROM chunks
       WHERE page_start IS NULL OR section_title IS NULL OR section_title = 'Body'`,
    )
    .all() as { parent_id: string }[];

  if (docs.length === 0) return 0;

  const selectStmt = db.prepare(
    `SELECT id, content, page_start, section_title
     FROM chunks WHERE parent_id = ? ORDER BY chunk_index ASC`,
  );
  const updateStmt = db.prepare(
    `UPDATE chunks
     SET page_start = COALESCE(@page_start, page_start),
         page_end   = COALESCE(@page_end,   page_end),
         section_title = COALESCE(@section_title, section_title)
     WHERE id = @id`,
  );

  let updated = 0;
  const txn = db.transaction(() => {
    for (const { parent_id } of docs) {
      const rows = selectStmt.all(parent_id) as {
        id: string;
        content: string;
        page_start: number | null;
        section_title: string | null;
      }[];
      let prevPage: number | null = null;
      // Carry the last known section title forward when a chunk yields none
      let lastSection: string | null = null;

      for (const row of rows) {
        const derived = deriveLocation(row.content, prevPage);
        const nextPage = derived.page_end ?? prevPage;

        // Only overwrite section_title if it's still the default or empty.
        const shouldSetSection =
          !row.section_title ||
          row.section_title === "Body" ||
          row.section_title === "";
        const finalSection = shouldSetSection
          ? derived.section_title ?? lastSection
          : row.section_title;

        if (
          row.page_start == null ||
          shouldSetSection
        ) {
          updateStmt.run({
            id: row.id,
            page_start: derived.page_start,
            page_end: derived.page_end,
            section_title: shouldSetSection ? finalSection : null,
          });
          updated++;
        }

        if (finalSection) lastSection = finalSection;
        prevPage = nextPage;
      }
    }
  });
  txn();
  return updated;
}
