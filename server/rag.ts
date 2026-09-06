/**
 * Lightweight, self-contained RAG engine for the demo:
 *   - Heading-aware chunking
 *   - Entity extraction (error codes, CLI commands, UI paths, config keys)
 *   - TF-IDF bag-of-words vectors (no external embedding API required)
 *   - Cosine similarity + hybrid keyword boost
 *   - Metadata-first filter mapping mirroring the schema in /shared/schema.ts
 */

import { createHash, randomUUID } from "node:crypto";

const STOPWORDS = new Set(
  ("a an the and or of in on at to for with by from as is are was were be been being " +
    "this that these those it its i you we they he she them us our your their " +
    "not no if then else so than into out up down over under can may might must " +
    "will would should could do does did done have has had here there when where " +
    "how what which who whom why about above below between within without also")
    .split(/\s+/),
);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[`'"]/g, "")
    .split(/[^a-z0-9\-_.]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

// ---------- Chunking ----------

export interface ChunkDraft {
  content: string;
  content_type: string;
  section_path: string[];
  section_title: string;
  section_id: string;
  heading_level: number;
  page_start?: number;
  page_end?: number;
  chunk_index: number;
  token_count: number;
  error_codes: string[];
  cli_commands: string[];
  ui_paths: string[];
  extracted_tags: string[];
}

// Splits a markdown-ish body into heading-aware chunks.
// Each chunk carries the heading hierarchy up to that point.
export function chunkDocument(
  body: string,
  opts: { chunk_size_tokens: number; chunk_overlap_tokens: number },
): ChunkDraft[] {
  const lines = body.split(/\r?\n/);
  const stack: { level: number; title: string; id: string }[] = [];
  const drafts: ChunkDraft[] = [];
  let buffer: string[] = [];
  let bufferTokens = 0;
  let chunkIndex = 0;

  const flush = (opts2?: { forceType?: string }) => {
    const text = buffer.join("\n").trim();
    if (!text) return;
    const path = stack.map((s) => s.title);
    const section = stack[stack.length - 1] ?? {
      level: 0,
      title: "Body",
      id: "body",
    };
    const draft: ChunkDraft = {
      content: text,
      content_type: opts2?.forceType ?? classifyContent(text),
      section_path: path,
      section_title: section.title,
      section_id: section.id,
      heading_level: section.level,
      chunk_index: chunkIndex++,
      token_count: bufferTokens,
      error_codes: extractErrorCodes(text),
      cli_commands: extractCliCommands(text),
      ui_paths: extractUiPaths(text),
      extracted_tags: extractTags(text, path),
    };
    drafts.push(draft);
    // Overlap: keep the last N tokens as prefix of the next buffer
    if (opts.chunk_overlap_tokens > 0) {
      const tail = text.split(/\s+/).slice(-opts.chunk_overlap_tokens);
      buffer = [tail.join(" ")];
      bufferTokens = tail.length;
    } else {
      buffer = [];
      bufferTokens = 0;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      // Flush pending buffer before switching sections
      if (buffer.length) flush();
      const level = headingMatch[1].length;
      const title = headingMatch[2].trim();
      const id = slugify(title);
      // Pop deeper/equal headings from stack
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title, id });
      continue;
    }
    if (!line.trim()) {
      // paragraph break
      buffer.push("");
      continue;
    }
    const tokens = tokenize(line);
    if (bufferTokens + tokens.length > opts.chunk_size_tokens && buffer.length) {
      flush();
    }
    buffer.push(line);
    bufferTokens += tokens.length;
  }
  if (buffer.length) flush();
  return drafts;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

function classifyContent(text: string): string {
  const t = text.trim();
  if (/^```/m.test(t)) return "code_block";
  if (/^\s*\$\s+\S/m.test(t) || /^\s*[a-z0-9_-]+\s+--?[a-z]/mi.test(t)) return "cli_command";
  if (/^\s*(warning|caution|danger)[:!]/mi.test(t)) return "warning";
  if (/^\s*note[:!]/mi.test(t)) return "note";
  if (/^\s*(step\s*\d+|1\.|2\.|\d+\))/mi.test(t)) return "procedure";
  if (/\?$/m.test(t) && t.length < 400) return "faq";
  if (/^\s*[a-z_.]+\s*[:=]/mi.test(t)) return "config_snippet";
  return "prose";
}

// ---------- Entity extraction ----------

function extractErrorCodes(text: string): string[] {
  const patterns = [
    /\bE-?\d{2,5}\b/g,
    /\bERR[_-]?\d{2,5}\b/gi,
    /\bHTTP\s?\d{3}\b/gi,
    /\b0x[0-9A-Fa-f]{4,8}\b/g,
  ];
  const out = new Set<string>();
  for (const p of patterns) {
    const matches = Array.from(text.matchAll(p));
    for (const m of matches) out.add(m[0].toUpperCase().replace(/\s+/g, ""));
  }
  return Array.from(out);
}

function extractCliCommands(text: string): string[] {
  const out = new Set<string>();
  const dollarMatches = Array.from(text.matchAll(/(?:^|\n)\s*\$\s+([^\n]{2,120})/g));
  for (const m of dollarMatches) out.add(m[1].trim());
  const backtickMatches = Array.from(text.matchAll(/`([a-z][a-z0-9_-]{1,20}(?:\s+-{1,2}[a-z][\w-]*|\s+[a-z0-9_.\/-]+){0,4})`/gi));
  for (const m of backtickMatches) {
    if (/\s/.test(m[1])) out.add(m[1]);
  }
  return Array.from(out).slice(0, 20);
}

function extractUiPaths(text: string): string[] {
  const out = new Set<string>();
  const matches = Array.from(text.matchAll(/([A-Z][A-Za-z0-9 ]{1,30}(?:\s*>\s*[A-Z][A-Za-z0-9 ]{1,30}){1,6})/g));
  for (const m of matches) {
    out.add(m[1].trim().replace(/\s*>\s*/g, " > "));
  }
  return Array.from(out).slice(0, 10);
}

function extractTags(text: string, sectionPath: string[]): string[] {
  const words = new Set<string>();
  for (const s of sectionPath) {
    for (const w of tokenize(s)) if (w.length >= 3) words.add(w);
  }
  return Array.from(words).slice(0, 8);
}

// ---------- TF-IDF vectorizer ----------

export interface Vector {
  [term: string]: number;
}

export function termFrequency(text: string): Vector {
  const tf: Vector = {};
  const tokens = tokenize(text);
  for (const t of tokens) tf[t] = (tf[t] ?? 0) + 1;
  return tf;
}

export function buildTfIdfVector(
  text: string,
  documentFrequency: Map<string, number>,
  totalDocs: number,
): Vector {
  const tf = termFrequency(text);
  const vec: Vector = {};
  let norm = 0;
  const totalTerms = Object.values(tf).reduce((a, b) => a + b, 0) || 1;
  for (const [term, count] of Object.entries(tf)) {
    const df = documentFrequency.get(term) ?? 1;
    const idf = Math.log((1 + totalDocs) / (1 + df)) + 1;
    const w = (count / totalTerms) * idf;
    vec[term] = w;
    norm += w * w;
  }
  norm = Math.sqrt(norm) || 1;
  for (const k of Object.keys(vec)) vec[k] /= norm;
  return vec;
}

export function cosine(a: Vector, b: Vector): number {
  // both are pre-normalized; take dot product
  const shorter = Object.keys(a).length < Object.keys(b).length ? a : b;
  const longer = shorter === a ? b : a;
  let dot = 0;
  for (const [k, v] of Object.entries(shorter)) {
    const w = longer[k];
    if (w) dot += v * w;
  }
  return dot;
}

// Convenience: hash a string deterministically (for stable chunk IDs).
export function stableId(input: string, prefix: string): string {
  const h = createHash("sha256").update(input).digest("hex").slice(0, 20);
  return `${prefix}_${h}`;
}

export function newDocId(): string {
  return `doc_${randomUUID()}`;
}

export function newChunkId(): string {
  return `chk_${randomUUID()}`;
}
