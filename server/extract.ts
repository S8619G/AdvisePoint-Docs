// Text extraction from uploaded files (PDF, DOCX, TXT, MD)
// Runs entirely locally — no external API calls.

// pdf-parse (v2) exposes a PDFParse class; mammoth exports a namespace.
// Load lazily so a broken install of one doesn't kill server startup.
function loadPdfParse() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("pdf-parse");
  return mod.PDFParse;
}
function loadMammoth() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("mammoth");
  return mod.default ?? mod;
}

export type ExtractResult = {
  text: string;
  page_count: number | null;
  format: "pdf" | "docx" | "text" | "markdown";
};

export async function extractTextFromFile(
  filename: string,
  buffer: Buffer,
): Promise<ExtractResult> {
  const lower = filename.toLowerCase();

  if (lower.endsWith(".pdf")) {
    const PDFParse = loadPdfParse();
    // The buffer we receive is a Node Buffer; pdf-parse v2 wants a Uint8Array-compatible value.
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      return {
        text: normalizePdfText(result.text ?? ""),
        page_count: typeof result.total === "number" ? result.total : (Array.isArray(result.pages) ? result.pages.length : null),
        format: "pdf",
      };
    } finally {
      try { await parser.destroy(); } catch { /* best-effort cleanup */ }
    }
  }

  if (lower.endsWith(".docx")) {
    const mammoth = loadMammoth();
    // convertToMarkdown preserves heading levels — perfect for our heading-aware chunker
    const result = await mammoth.convertToMarkdown({ buffer });
    return {
      text: result.value ?? "",
      page_count: null,
      format: "docx",
    };
  }

  if (lower.endsWith(".md") || lower.endsWith(".markdown")) {
    return {
      text: buffer.toString("utf8"),
      page_count: null,
      format: "markdown",
    };
  }

  if (lower.endsWith(".txt")) {
    return {
      text: buffer.toString("utf8"),
      page_count: null,
      format: "text",
    };
  }

  throw new Error(
    `Unsupported file type: ${filename}. Supported: .pdf, .docx, .txt, .md`,
  );
}

// PDFs come out of pdf-parse with awkward line breaks — collapse them into paragraphs
// while preserving double-newline paragraph breaks and heading-like lines.
function normalizePdfText(raw: string): string {
  // Normalize line endings
  let s = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Remove form feeds
  s = s.replace(/\f/g, "\n\n");

  // Join lines within a paragraph: a single newline followed by a lowercase letter
  // is almost always a wrap, not a real break.
  s = s.replace(/([^\n])\n(?=[a-z0-9(\[])/g, "$1 ");

  // Collapse runs of 3+ newlines
  s = s.replace(/\n{3,}/g, "\n\n");

  // Trim trailing spaces per line
  s = s
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n");

  return s.trim();
}
