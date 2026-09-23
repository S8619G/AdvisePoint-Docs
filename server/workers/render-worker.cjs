// v1.3.0 candidate 4: legacy 240 DPI/WebP q88 renderer isolated from HTTP.
// No database or filesystem access. One encoded page is ACKed before the next.
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
const { parentPort } = require("node:worker_threads");
const storage = { upsertRenderStatus(status) {
  parentPort.postMessage({ type: "status", status });
} };
async function emitPage(page, buf) {
  const bytes = new Uint8Array(buf);
  await new Promise((resolve, reject) => {
    parentPort.once("message", (message) => message.type === "ack" ? resolve() : reject(Error("Missing page acknowledgement")));
    parentPort.postMessage({ type: "page", page, bytes }, [bytes.buffer]);
  });
}
parentPort.once("message", async ({ document_id, bytes }) => {
  try {
    await renderInBackground(document_id, bytes);
    parentPort.postMessage({ type: "done" });
  } catch (error) {
    parentPort.postMessage({ type: "error", error: error?.message || String(error) });
  }
});
const RENDER_PAGE_TIMEOUT_MS = Number(process.env.RAG_RENDER_PAGE_TIMEOUT_MS) || 6e4;
const RENDER_GETPAGE_TIMEOUT_MS = Number(process.env.RAG_RENDER_GETPAGE_TIMEOUT_MS) || 3e4;
const RENDER_LOAD_TIMEOUT_MS = Number(process.env.RAG_RENDER_LOAD_TIMEOUT_MS) || 6e4;
const RENDER_JOB_TIMEOUT_MS = Number(process.env.RAG_RENDER_JOB_TIMEOUT_MS) || 18e5;
class RenderTimeoutError extends Error {
  constructor(op, ms) {
    super(`${op} timed out after ${ms}ms`);
    this.name = "RenderTimeoutError";
  }
}
async function withTimeout(p, ms, op) {
  parentPort.postMessage({ type: "stage", op, ms });
  let timer;
  try {
    return await Promise.race([
      p,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new RenderTimeoutError(op, ms)), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
let _pdfjs = null;
async function loadPdfjs() {
  if (_pdfjs) return _pdfjs;
  _pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return _pdfjs;
}
let _canvasMod = null;
function loadCanvas() {
  if (_canvasMod) return _canvasMod;
  _canvasMod = require("@napi-rs/canvas");
  const g = globalThis;
  if (typeof g.createImageBitmap !== "function") {
    g.createImageBitmap = async (source) => {
      let bytes;
      if (source && typeof source.arrayBuffer === "function") {
        const ab = await source.arrayBuffer();
        bytes = Buffer.from(ab);
      } else if (source instanceof Uint8Array) {
        bytes = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
      } else if (Buffer.isBuffer(source)) {
        bytes = source;
      } else if (source && source.data instanceof Uint8Array) {
        bytes = Buffer.from(source.data.buffer, source.data.byteOffset, source.data.byteLength);
      } else {
        throw new TypeError("createImageBitmap polyfill: unsupported source type");
      }
      return _canvasMod.loadImage(bytes);
    };
  }
  return _canvasMod;
}
async function renderInBackground(document_id, buffer) {
  const jobStartedAt = Date.now();
  const jobExpiresAt = jobStartedAt + RENDER_JOB_TIMEOUT_MS;
  const pdfjs = await loadPdfjs();
  const { createCanvas } = loadCanvas();
  const bytes = new Uint8Array(buffer.length);
  bytes.set(buffer);
  const nodePath = require("node:path");
  const pdfjsRoot = nodePath.dirname(require.resolve("pdfjs-dist/package.json"));
  const cMapUrl = `${pdfjsRoot}/cmaps/`;
  const standardFontDataUrl = `${pdfjsRoot}/standard_fonts/`;
  const wasmUrl = `${pdfjsRoot}/wasm/`;
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    disableWorker: true,
    // PDF.js runs within this dedicated render thread, never the HTTP thread.
    isEvalSupported: false,
    // safer, we don't need eval'd font code
    useSystemFonts: false,
    // v0.9.29: system-font fallback drops graphics on Windows
    cMapUrl,
    cMapPacked: true,
    standardFontDataUrl,
    wasmUrl
    // v0.9.29: OpenJPEG/QCMS wasm for JP2/JPX images
  });
  const doc = await withTimeout(
    loadingTask.promise,
    RENDER_LOAD_TIMEOUT_MS,
    `pdfjs.getDocument() for ${document_id}`
  );
  const total = doc.numPages;
  const startedAt = (/* @__PURE__ */ new Date()).toISOString();
  storage.upsertRenderStatus({
    document_id,
    status: "rendering",
    rendered: 0,
    total,
    error: null,
    updated_at: startedAt
  });
  const scale = 240 / 72;
  const webpQuality = 88;
  const failedPages = [];
  let firstFailure = null;
  let rendered = 0;
  for (let n = 1; n <= total; n++) {
    if (Date.now() >= jobExpiresAt) {
      for (let m = n; m <= total; m++) failedPages.push(m);
      if (!firstFailure) {
        firstFailure = {
          page: n,
          error: `whole-document render exceeded ${RENDER_JOB_TIMEOUT_MS}ms`
        };
      }
      break;
    }
    let page = null;
    try {
      page = await withTimeout(
        doc.getPage(n),
        RENDER_GETPAGE_TIMEOUT_MS,
        `doc.getPage(${n}) for ${document_id}`
      );
      const viewport = page.getViewport({ scale });
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, width, height);
      await withTimeout(
        page.render({ canvasContext: ctx, viewport, canvas }).promise,
        RENDER_PAGE_TIMEOUT_MS,
        `page.render(${n}) for ${document_id}`
      );
      await new Promise((r) => setImmediate(r));
      parentPort.postMessage({ type: "stage", op: `Encode/write page ${n}`, ms: RENDER_PAGE_TIMEOUT_MS });
      const buf = canvas.toBuffer("image/webp", webpQuality);
      await new Promise((r) => setImmediate(r));
      const outPath = "";
      const pageRow = {
        document_id,
        page_number: n,
        image_path: outPath,
        width,
        height,
        generated_at: (/* @__PURE__ */ new Date()).toISOString()
      };
      await emitPage(pageRow, buf);
      rendered++;
      if (n % 10 === 0 || n === total) {
        storage.upsertRenderStatus({
          document_id,
          status: "rendering",
          rendered,
          total,
          error: failedPages.length > 0 ? `${failedPages.length} of ${total} pages failed so far` : null,
          updated_at: (/* @__PURE__ */ new Date()).toISOString(),
          failed_pages: failedPages.length > 0 ? JSON.stringify(failedPages) : null,
          first_failed_page: firstFailure?.page ?? null
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[pages] page ${n} of ${document_id} failed:`, message);
      failedPages.push(n);
      if (!firstFailure) {
        firstFailure = { page: n, error: message };
      }
    } finally {
      try {
        page?.cleanup?.();
      } catch {
      }
    }
    await new Promise((r) => setImmediate(r));
  }
  const failureRate = total > 0 ? failedPages.length / total : 0;
  const finalStatus = failureRate > 0.25 ? "error" : "ready";
  const finalError = failedPages.length === 0 ? null : finalStatus === "error" ? `${failedPages.length} of ${total} pages failed to render. First failure on page ${firstFailure?.page}: ${firstFailure?.error}` : `${failedPages.length} of ${total} pages failed to render (partial). First failure on page ${firstFailure?.page}: ${firstFailure?.error}`;
  storage.upsertRenderStatus({
    document_id,
    status: finalStatus,
    rendered,
    total,
    error: finalError,
    updated_at: (/* @__PURE__ */ new Date()).toISOString(),
    failed_pages: failedPages.length > 0 ? JSON.stringify(failedPages) : null,
    first_failed_page: firstFailure?.page ?? null
  });
  parentPort.postMessage({ type: "stage", op: "Renderer cleanup", ms: RENDER_LOAD_TIMEOUT_MS });
  try {
    await doc.cleanup?.();
  } catch {
  }
  try {
    await doc.destroy?.();
  } catch {
  }
}
