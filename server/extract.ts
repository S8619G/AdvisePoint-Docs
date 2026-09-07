// server/extract.ts
//
// Thin async wrapper around a long-lived worker_threads Worker that runs
// the actual PDF/DOCX/TXT/MD extraction off the main event loop.
//
// Why: pdf-parse and mammoth block Node's single-threaded event loop for
// many seconds on large files. While blocked, /api/health and /api/heartbeat
// can't respond, and the client shows a false "backend down" modal even
// though the upload is fine. Moving extraction to a worker keeps the event
// loop responsive so health polls succeed throughout the upload.
//
// Design decisions:
//   - Pool size 1. pdf-parse has non-trivial cold-start cost; reusing one
//     worker across uploads avoids that. Two uploads land at once? The
//     second waits for the first, which is exactly what happened before
//     (extract was serialized by the event loop anyway).
//   - Worker script is hand-written CJS at server/workers/extract-worker.cjs
//     (dev) / dist/workers/extract-worker.cjs (packaged). NOT bundled by
//     esbuild — it require()s pdf-parse and mammoth from node_modules at
//     runtime, which the portable zip already ships.
//   - Buffer is transferred (not copied) via postMessage transferList.
//     Even a 100 MB PDF moves to the worker with zero memcpy cost.
//   - If the worker crashes, respawn on the next request. Never leave the
//     server permanently unable to extract.

import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

export type ExtractResult = {
  text: string;
  page_count: number | null;
  format: "pdf" | "docx" | "text" | "markdown";
};

// ---------------------------------------------------------------------------
// Worker script path resolution.
//
// dev:      tsx server/index.ts runs from repo root
//           -> server/workers/extract-worker.cjs
// prod:     dist/index.cjs runs from wherever the launcher puts it
//           -> dist/workers/extract-worker.cjs (next to index.cjs)
//
// We try packaged layout first, dev layout second. __dirname behaves
// differently under CJS vs ESM tsx; handle both.
// ---------------------------------------------------------------------------
function resolveWorkerPath(): string {
  // In the bundled CJS output, __dirname is dist/. In dev under tsx-ESM,
  // import.meta.url is server/extract.ts. Handle both.
  let here: string;
  try {
    // ESM branch (tsx dev mode). @ts-expect-error avoided by runtime check.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const metaUrl = (import.meta as any)?.url as string | undefined;
    here = metaUrl ? dirname(fileURLToPath(metaUrl)) : __dirname;
  } catch {
    here = __dirname;
  }

  const candidates = [
    // Packaged: dist/index.cjs sits next to dist/workers/
    resolve(here, "workers", "extract-worker.cjs"),
    // Dev: server/extract.ts sits next to server/workers/
    resolve(here, "workers", "extract-worker.cjs"),
    // Fallback: repo-root relative (in case cwd is odd)
    resolve(process.cwd(), "server", "workers", "extract-worker.cjs"),
    resolve(process.cwd(), "dist", "workers", "extract-worker.cjs"),
  ];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  throw new Error(
    "extract-worker.cjs not found in any expected location. " +
      "Checked: " +
      candidates.join(", "),
  );
}

// ---------------------------------------------------------------------------
// Worker lifecycle: lazy spawn, respawn on death.
// ---------------------------------------------------------------------------
let worker: Worker | null = null;
const pending = new Map<
  string,
  { resolve: (r: ExtractResult) => void; reject: (e: Error) => void }
>();

function attachWorker(w: Worker): void {
  w.on("message", (msg: { id: string; ok: boolean; result?: ExtractResult; error?: string }) => {
    const p = pending.get(msg.id);
    if (!p) return; // stray message — ignore
    pending.delete(msg.id);
    if (msg.ok && msg.result) {
      p.resolve(msg.result);
    } else {
      p.reject(new Error(msg.error ?? "unknown extraction error"));
    }
  });

  w.on("error", (err) => {
    console.error("[extract-worker] worker error:", err);
    // Fail every in-flight request; the caller will get a clean error and can retry.
    const inflight = Array.from(pending.entries());
    pending.clear();
    for (const [, p] of inflight) {
      p.reject(new Error(`extraction worker error: ${err.message}`));
    }
    // Force next request to spawn a fresh worker.
    if (worker === w) worker = null;
  });

  w.on("exit", (code) => {
    if (code !== 0) {
      console.error(`[extract-worker] worker exited with code ${code}`);
    }
    const inflight = Array.from(pending.entries());
    pending.clear();
    for (const [, p] of inflight) {
      p.reject(new Error(`extraction worker exited (code ${code})`));
    }
    if (worker === w) worker = null;
  });
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const scriptPath = resolveWorkerPath();
  const w = new Worker(scriptPath);
  attachWorker(w);
  worker = w;
  return w;
}

// ---------------------------------------------------------------------------
// Public API — same signature as before. Existing callers work unchanged.
// ---------------------------------------------------------------------------
export function extractTextFromFile(
  filename: string,
  buffer: Buffer,
): Promise<ExtractResult> {
  return new Promise<ExtractResult>((resolvePromise, rejectPromise) => {
    const id = randomUUID();
    pending.set(id, { resolve: resolvePromise, reject: rejectPromise });

    // Transfer the underlying ArrayBuffer (not a copy). We slice into a fresh
    // ArrayBuffer view first because Node Buffer often shares an ArrayBuffer
    // with other Buffers — transferring the shared one would neuter them all.
    const view = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    );

    try {
      const w = ensureWorker();
      w.postMessage({ id, filename, buffer: view }, [view]);
    } catch (err) {
      pending.delete(id);
      rejectPromise(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// ---------------------------------------------------------------------------
// Test hook — lets a test suite tear down the worker between cases.
// Not called by production code.
// ---------------------------------------------------------------------------
export async function _shutdownExtractWorker(): Promise<void> {
  const w = worker;
  worker = null;
  if (w) {
    await w.terminate();
  }
}
