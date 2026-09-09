// v1.0.7: document similarity for the drag-to-update flow.
//
// When a user drops a .docx onto an existing library document, we want
// to know whether it's plausibly an edited version of what's already
// there vs. an unrelated file that got dropped by mistake. The client
// uses the returned tier to decide how loudly to confirm:
//
//   Tier 1 (high):    silent update, small toast
//   Tier 2 (medium):  modal offering Update-existing / Import-as-new
//   Tier 3 (low):     strong warning, defaults to Cancel
//
// The signals we combine, in order of cost:
//
//   1. Word Structured Document Tag IDs (`w:sdt` `w:id`). Word
//      preserves these across Save, so a matching set is a very
//      strong "same document family" signal (Word newsletter and
//      template docs use them heavily).
//   2. Structural fingerprint: heading count, paragraph count, image
//      count, section count from the docx-preview-ready DOM. Diverges
//      slowly with edits.
//   3. Text overlap: character-level shingling of the extracted plain
//      text via a 5-gram Jaccard estimate. Cheap enough to compute on
//      docs up to a few MB, robust to reordering.
//
// None of these need external libraries -- we already have a XML-ish
// parse via the extract pipeline and a text extractor. We deliberately
// do NOT ship SimHash / MinHash / embeddings here: the tier decision
// only needs to be roughly right, and any of those add complexity
// disproportionate to the value.

import { createHash } from "node:crypto";

import { extractTextFromFile } from "./extract";

export interface DocSignature {
  /** SHA-256 of the raw file bytes; identical files short-circuit to Tier 1. */
  bytesHash: string;
  /** Extracted plain-text length in characters. */
  textLen: number;
  /** Text shingles as a bag of 5-gram hashes for Jaccard estimation. */
  shingles: Set<string>;
  /** Set of Word `w:sdt` `w:id` values found in the doc, if any. */
  sdtIds: Set<string>;
  /** Structural counts derived from raw XML. */
  structure: {
    paragraphs: number;
    headings: number;
    tables: number;
    drawings: number;
    sections: number;
  };
  /** First ~200 chars of extracted text -- used for compare-summary UI. */
  textHead: string;
}

/**
 * Build a DocSignature for a docx buffer. Extracts text + reads the raw
 * `word/document.xml` to count structural elements and pull sdt ids
 * without going through docx-preview.
 */
export async function buildDocxSignature(
  fileName: string,
  bytes: Buffer,
): Promise<DocSignature> {
  const bytesHash = createHash("sha256").update(bytes).digest("hex");

  let extractedText = "";
  try {
    const extracted = await extractTextFromFile(fileName, bytes);
    extractedText = extracted.text ?? "";
  } catch (err) {
    // Extraction can fail on corrupt docs; we still produce a signature
    // so the caller can decide. Empty text just means shingles is empty
    // and text-overlap comparisons return 0.
    console.warn(`[similarity] extract failed for ${fileName}:`, err);
  }

  const shingles = shinglesOf(extractedText, 5);
  const { sdtIds, structure } = parseDocxStructure(bytes);
  const textHead = extractedText.slice(0, 200);

  return {
    bytesHash,
    textLen: extractedText.length,
    shingles,
    sdtIds,
    structure,
    textHead,
  };
}

/** 5-character overlapping shingles, hashed to keep the set small. */
function shinglesOf(text: string, n: number): Set<string> {
  const out = new Set<string>();
  if (text.length < n) return out;
  // Collapse whitespace so trivial reflow doesn't fake divergence.
  const norm = text.replace(/\s+/g, " ").toLowerCase();
  for (let i = 0; i + n <= norm.length; i++) {
    // Hash to 8-hex-char string -- shortens the Set at negligible collision risk
    // for docs up to millions of chars.
    const s = norm.slice(i, i + n);
    out.add(createHash("md5").update(s).digest("hex").slice(0, 8));
  }
  return out;
}

/**
 * Read the docx zip in memory, pull out word/document.xml, and count
 * structural elements + sdt ids via regex. We deliberately do not use
 * an XML parser -- docx-preview already does that on the client, and a
 * few well-targeted regexes over the raw XML are cheap and stable.
 */
function parseDocxStructure(bytes: Buffer): {
  sdtIds: Set<string>;
  structure: DocSignature["structure"];
} {
  const zeroed = {
    sdtIds: new Set<string>(),
    structure: { paragraphs: 0, headings: 0, tables: 0, drawings: 0, sections: 0 },
  };

  // The docx is a zip. Find and inflate word/document.xml. We use the
  // built-in zlib on the deflated slice rather than pulling in a full zip
  // library -- keeps this module dep-free.
  let xml = "";
  try {
    xml = readDocumentXml(bytes);
  } catch (err) {
    console.warn(`[similarity] failed to read document.xml:`, err);
    return zeroed;
  }
  if (!xml) return zeroed;

  const structure = {
    paragraphs: countMatches(xml, /<w:p\b/g),
    // Heading is a paragraph with pStyle w:val starting with "Heading".
    // The XML uses w:val="Heading1", "Heading2", etc.
    headings: countMatches(xml, /<w:pStyle\s+w:val="Heading\d/g),
    tables: countMatches(xml, /<w:tbl\b/g),
    drawings: countMatches(xml, /<w:drawing\b/g),
    // Section properties -- roughly, page-layout boundaries.
    sections: countMatches(xml, /<w:sectPr\b/g),
  };

  const sdtIds = new Set<string>();
  const sdtIdRe = /<w:sdt\b[^>]*>[\s\S]*?<w:id\s+w:val="(\d+)"/g;
  let m: RegExpExecArray | null;
  while ((m = sdtIdRe.exec(xml)) !== null) {
    sdtIds.add(m[1]);
  }

  return { sdtIds, structure };
}

function countMatches(hay: string, re: RegExp): number {
  const m = hay.match(re);
  return m ? m.length : 0;
}

/**
 * Inflate word/document.xml out of a docx zip without a zip library. We
 * scan the central directory for the entry, then inflate its deflated
 * payload via zlib. Returns "" if not found or on any parse error.
 *
 * Docx uses store (00) or deflate (08) compression only. We handle both.
 */
function readDocumentXml(zip: Buffer): string {
  // End-of-central-directory record has signature 0x06054b50 and lives
  // in the last ~65KB of the file. Scan backwards.
  const EOCD_SIG = 0x06054b50;
  const CDH_SIG = 0x02014b50;
  const LFH_SIG = 0x04034b50;

  let eocdOffset = -1;
  const scanStart = Math.max(0, zip.length - 65557);
  for (let i = zip.length - 22; i >= scanStart; i--) {
    if (zip.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) return "";

  const cdCount = zip.readUInt16LE(eocdOffset + 10);
  const cdOffset = zip.readUInt32LE(eocdOffset + 16);

  // Walk central directory entries looking for word/document.xml.
  let p = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (zip.readUInt32LE(p) !== CDH_SIG) break;
    const method = zip.readUInt16LE(p + 10);
    const compSize = zip.readUInt32LE(p + 20);
    const uncompSize = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const lfhOffset = zip.readUInt32LE(p + 42);
    const name = zip.slice(p + 46, p + 46 + nameLen).toString("utf8");

    if (name === "word/document.xml") {
      // Read the local file header to get its own nameLen/extraLen (may
      // differ from the CDH entry), then the compressed payload follows.
      if (zip.readUInt32LE(lfhOffset) !== LFH_SIG) return "";
      const lfhNameLen = zip.readUInt16LE(lfhOffset + 26);
      const lfhExtraLen = zip.readUInt16LE(lfhOffset + 28);
      const dataStart = lfhOffset + 30 + lfhNameLen + lfhExtraLen;
      const payload = zip.slice(dataStart, dataStart + compSize);

      if (method === 0) {
        return payload.toString("utf8");
      } else if (method === 8) {
        // Raw deflate (no zlib header). Use inflateRawSync.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const zlib = require("node:zlib") as typeof import("node:zlib");
        const inflated = zlib.inflateRawSync(payload, { maxOutputLength: 32 * 1024 * 1024 });
        return inflated.toString("utf8");
      } else {
        // Unknown method -- can't handle.
        return "";
      }
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return "";
}

/**
 * Compare two signatures and return a tier plus supporting metrics that
 * the UI can display in its confirmation dialog.
 */
export interface SimilarityResult {
  tier: 1 | 2 | 3;
  reason: string;
  bytesIdentical: boolean;
  jaccard: number;
  sdtOverlap: number; // fraction of existing sdt ids present in new (0..1)
  structuralDelta: number; // 0..1 -- 0 = identical structure, 1 = totally different
  existing: DocSignature;
  incoming: DocSignature;
}

export function compareSignatures(
  existing: DocSignature,
  incoming: DocSignature,
): SimilarityResult {
  const bytesIdentical = existing.bytesHash === incoming.bytesHash;
  const jaccard = jaccardSets(existing.shingles, incoming.shingles);
  const sdtOverlap = fractionOverlap(existing.sdtIds, incoming.sdtIds);
  const structuralDelta = structuralDeltaOf(existing.structure, incoming.structure);

  // Decision tree, most-confident signals first.
  //
  // Identical bytes: trivially Tier 1 (same file re-dropped).
  if (bytesIdentical) {
    return tier(1, "Identical file bytes", existing, incoming, jaccard, sdtOverlap, structuralDelta, bytesIdentical);
  }

  // Strong sdt-id overlap: template-based docs (Word newsletters, forms)
  // preserve these across edits, and a solid overlap is very high signal.
  // Guard: only trust this if the existing doc actually HAS sdt ids
  // (otherwise a doc without any always "matches").
  if (existing.sdtIds.size >= 3 && sdtOverlap >= 0.7) {
    return tier(1, `Content-control IDs match (${Math.round(sdtOverlap * 100)}% overlap)`, existing, incoming, jaccard, sdtOverlap, structuralDelta, bytesIdentical);
  }

  // Strong text overlap: standard edit case (typo fix, paragraph tweak,
  // section rewrite). Structural delta corroborates.
  if (jaccard >= 0.8) {
    return tier(1, `Text overlap ${Math.round(jaccard * 100)}%`, existing, incoming, jaccard, sdtOverlap, structuralDelta, bytesIdentical);
  }

  // Medium confidence: heavy edit or major restructuring. Ask.
  if (jaccard >= 0.2 || (existing.sdtIds.size >= 3 && sdtOverlap >= 0.3)) {
    return tier(2, `Partial match (${Math.round(jaccard * 100)}% text overlap)`, existing, incoming, jaccard, sdtOverlap, structuralDelta, bytesIdentical);
  }

  // Low confidence: probably a different document. Warn loudly.
  return tier(3, `Very little overlap (${Math.round(jaccard * 100)}% text)`, existing, incoming, jaccard, sdtOverlap, structuralDelta, bytesIdentical);
}

function tier(
  n: 1 | 2 | 3,
  reason: string,
  existing: DocSignature,
  incoming: DocSignature,
  jaccard: number,
  sdtOverlap: number,
  structuralDelta: number,
  bytesIdentical: boolean,
): SimilarityResult {
  return {
    tier: n,
    reason,
    bytesIdentical,
    jaccard,
    sdtOverlap,
    structuralDelta,
    existing,
    incoming,
  };
}

function jaccardSets(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const s of small) if (large.has(s)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function fractionOverlap(existing: Set<string>, incoming: Set<string>): number {
  if (existing.size === 0) return 0;
  let hit = 0;
  for (const id of existing) if (incoming.has(id)) hit++;
  return hit / existing.size;
}

function structuralDeltaOf(a: DocSignature["structure"], b: DocSignature["structure"]): number {
  // Symmetric relative distance, averaged across keys. Robust to zero counts.
  const keys: Array<keyof DocSignature["structure"]> = [
    "paragraphs",
    "headings",
    "tables",
    "drawings",
    "sections",
  ];
  let sum = 0;
  for (const k of keys) {
    const av = a[k];
    const bv = b[k];
    const denom = Math.max(av, bv);
    if (denom === 0) continue;
    sum += Math.abs(av - bv) / denom;
  }
  return sum / keys.length;
}

/**
 * Slim serializable form for /api endpoints -- Sets don't survive JSON, so
 * we swap them for counts.
 */
export function summarizeSignature(sig: DocSignature): {
  bytesHash: string;
  textLen: number;
  shingleCount: number;
  sdtCount: number;
  structure: DocSignature["structure"];
  textHead: string;
} {
  return {
    bytesHash: sig.bytesHash,
    textLen: sig.textLen,
    shingleCount: sig.shingles.size,
    sdtCount: sig.sdtIds.size,
    structure: sig.structure,
    textHead: sig.textHead,
  };
}

export function summarizeResult(r: SimilarityResult): {
  tier: 1 | 2 | 3;
  reason: string;
  bytes_identical: boolean;
  text_overlap: number;
  sdt_overlap: number;
  structural_delta: number;
  existing: ReturnType<typeof summarizeSignature>;
  incoming: ReturnType<typeof summarizeSignature>;
} {
  return {
    tier: r.tier,
    reason: r.reason,
    bytes_identical: r.bytesIdentical,
    text_overlap: r.jaccard,
    sdt_overlap: r.sdtOverlap,
    structural_delta: r.structuralDelta,
    existing: summarizeSignature(r.existing),
    incoming: summarizeSignature(r.incoming),
  };
}
