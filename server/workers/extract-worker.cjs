// Text-extraction worker (runs in a worker_threads Worker).
//
// Why this file exists:
// -----------------------------------------------------------------------------
// pdf-parse and mammoth do heavy CPU work synchronously enough to stall Node's
// event loop for many seconds on a large PDF (~50 MB, hundreds of pages). While
// that stall is happening, the main thread cannot respond to /api/health,
// /api/heartbeat, or anything else — so the client's health poller (2s cadence,
// 3.5s abort) racks up failures and eventually shows the "backend down" modal
// even though the upload is proceeding fine.
//
// Fix: move extraction off the main thread. This file is that worker.
//
// Contract with server/extract.ts:
//   - Send:    { id: string, filename: string, buffer: ArrayBuffer }
//   - Receive: { id: string, ok: true,  result: ExtractResult }
//              { id: string, ok: false, error: string }
//
// The buffer is transferred (not copied) via postMessage transferList, so
// even very large PDFs move to the worker with zero memcpy cost.
//
// This is a hand-written CJS file, NOT bundled by esbuild. It requires
// pdf-parse and mammoth from node_modules at runtime, which the portable
// zip already ships with the app.
//
// Lifecycle: the parent spawns one long-lived worker on first use and reuses
// it. If this worker crashes or exits, the parent respawns on next request.
"use strict";

const { parentPort } = require("node:worker_threads");

if (!parentPort) {
  // Guard: this file should only run as a Worker. If someone requires it
  // directly, exit cleanly rather than crashing the server.
  console.error("extract-worker.cjs was loaded outside a worker_threads Worker; exiting");
  process.exit(1);
}

// -----------------------------------------------------------------------------
// Loaders — lazy so a broken install of one library doesn't kill the worker
// -----------------------------------------------------------------------------
function loadPdfParse() {
  const mod = require("pdf-parse");
  return mod.PDFParse;
}
function loadMammoth() {
  const mod = require("mammoth");
  return mod.default ?? mod;
}
function loadRtfStripper() {
  // v1.0.7.4: homegrown RTF -> plain text (see rtf-stripper.cjs header for
  // rationale). Zero third-party parser dep; iconv-lite is a transitive dep
  // used across the codebase.
  return require("./rtf-stripper.cjs").stripRtf;
}

// -----------------------------------------------------------------------------
// PDF text normalization — verbatim copy from the old in-process extractor.
// Keep this in sync if the main-thread version is ever tweaked; the worker
// version is now the source of truth.
// -----------------------------------------------------------------------------
function normalizePdfText(raw) {
  let s = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  s = s.replace(/\f/g, "\n\n");
  // A single newline followed by a lowercase/opening character is almost
  // always a wrap, not a real paragraph break.
  s = s.replace(/([^\n])\n(?=[a-z0-9(\[])/g, "$1 ");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n");
  return s.trim();
}

// -----------------------------------------------------------------------------
// The actual extraction logic — moved verbatim from server/extract.ts.
// -----------------------------------------------------------------------------
async function extractTextFromFile(filename, buffer, renderedFallback = false) {
  const lower = filename.toLowerCase();

  if (lower.endsWith(".pdf")) {
    const PDFParse = loadPdfParse();
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const info = await parser.getInfo({parsePageInfo:true});
      // Inspect permissions before indexing any extracted content. Do not
      // treat accessibility-only extraction as general copy permission.
      const restricted = Array.isArray(info.permission) && !info.permission.includes(16);
      const canPrint = !Array.isArray(info.permission) || (info.permission.includes(4) && info.permission.includes(2048));
      // Compatibility mode is explicit user consent to the legacy 1.2.8
      // searchable import. Never change encryption/permission bytes, accept
      // opening passwords, or offer image conversion for print-disabled PDFs.
      if ((restricted || renderedFallback) && !canPrint) {
        const err = new Error("This PDF does not permit full-quality printing. Rendered-page import is unavailable; use an authorized unrestricted copy.");
        err.code = "PDF_RENDER_RESTRICTED";
        throw err;
      }
      if (restricted && !renderedFallback) {
        const err = new Error("This PDF restricts copying. You can choose a legacy rendered-page import if authorized, or skip this file. No document was imported.");
        err.code = "PDF_COPY_RESTRICTED";
        throw err;
      }
      const result = await parser.getText();
      if (info.pages.length !== result.total) throw new Error("PDF page geometry is incomplete.");
      return {
        pages: info.pages.map(p=>({
          page_number:p.pageNumber, width:p.width * 240 / 72, height:p.height * 240 / 72,
        })),
        text: normalizePdfText(result.text ?? ""),
        page_count:
          typeof result.total === "number"
            ? result.total
            : Array.isArray(result.pages)
              ? result.pages.length
              : null,
        format: "pdf",
      };
    } finally {
      try { await parser.destroy(); } catch { /* best-effort cleanup */ }
    }
  }

  if (lower.endsWith(".docx")) {
    const mammoth = loadMammoth();
    // convertToMarkdown preserves heading levels — perfect for our heading-aware chunker
    const result = await mammoth.convertToMarkdown({ buffer: Buffer.from(buffer) });
    return {
      text: result.value ?? "",
      page_count: null,
      format: "docx",
    };
  }

  if (lower.endsWith(".md") || lower.endsWith(".markdown")) {
    return {
      text: Buffer.from(buffer).toString("utf8"),
      page_count: null,
      format: "markdown",
    };
  }

  if (lower.endsWith(".txt")) {
    return {
      text: Buffer.from(buffer).toString("utf8"),
      page_count: null,
      format: "text",
    };
  }

  if (lower.endsWith(".rtf")) {
    // v1.0.7.4: RTF -> plain text via homegrown stripper. See
    // rtf-stripper.cjs for the bake-off rationale.
    const stripRtf = loadRtfStripper();
    return {
      text: stripRtf(Buffer.from(buffer)),
      page_count: null,
      format: "rtf",
    };
  }

  throw new Error(
    `Unsupported file type: ${filename}. Supported: .pdf, .docx, .rtf, .txt, .md`,
  );
}

// -----------------------------------------------------------------------------
// Message loop
// -----------------------------------------------------------------------------
parentPort.on("message", async (msg) => {
  const { id, filename, buffer } = msg || {};
  if (typeof id !== "string") {
    // Malformed message — nothing we can reply to. Log for debugging.
    console.error("extract-worker: received message with no id");
    return;
  }
  try {
    if (typeof filename !== "string" || !(buffer instanceof ArrayBuffer)) {
      throw new Error("extract-worker: bad message shape");
    }
    const result = await extractTextFromFile(filename, buffer, msg.renderedFallback === true);
    parentPort.postMessage({ id, ok: true, result });
  } catch (err) {
    const password = err?.name === "PasswordException";
    const code = password ? "PDF_PASSWORD_REQUIRED" : err?.code;
    const message = password
      ? "This PDF requires an opening password. Password-protected import is not supported in AdvisePoint Docs. No document was imported and no password was saved. If authorized, use a separate unlocked copy."
      : err && err.message ? String(err.message) : String(err);
    parentPort.postMessage({ id, ok: false, error: message, code });
  }
});

// Unhandled errors within the worker — log and let the parent see the exit.
process.on("uncaughtException", (err) => {
  console.error("extract-worker uncaughtException:", err);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  console.error("extract-worker unhandledRejection:", err);
  process.exit(1);
});
