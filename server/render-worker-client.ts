import {Worker} from "node:worker_threads";
import {existsSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

type Callbacks = {
  page: (page: any, bytes: Uint8Array) => void;
  status: (status: any) => void;
};
function workerPath(): string {
  const url = (import.meta as any)?.url;
  const here = url ? dirname(fileURLToPath(url)) : __dirname;
  const paths = [resolve(here, "workers/render-worker.cjs"),
    resolve(process.cwd(), "server/workers/render-worker.cjs"),
    resolve(process.cwd(), "dist/workers/render-worker.cjs")];
  const path = paths.find(existsSync);
  if (!path) throw Error("Background renderer worker is missing. Re-extract the complete application package.");
  return path;
}

// One worker per queued document. No SQLite connection or filesystem writes
// in the worker: the server commits one completed encoded page, then ACKs it.
// Parent timers can stop CPU-bound PDF/encoder work even if its loop is stuck.
export function runRenderWorker(
  document_id: string, buffer: Buffer, callbacks: Callbacks,
  options: {path?: string; jobTimeout?: number} = {},
): {done: Promise<void>; cancel: () => void} {
  let cancel = () => {};
  const done = new Promise<void>((resolveJob, rejectJob) => {
    const worker = new Worker(options.path ?? workerPath());
    let settled = false;
    let stageTimer: NodeJS.Timeout | undefined;
    const jobTimeout = options.jobTimeout ?? (Number(process.env.RAG_RENDER_JOB_TIMEOUT_MS) || 1_800_000);
    const jobTimer = setTimeout(() => finish(Error(`Whole-document render exceeded ${jobTimeout}ms`)), jobTimeout);
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(jobTimer); clearTimeout(stageTimer);
      // Keep the serial queue occupied until the old worker really has exited.
      void worker.terminate().then(
        () => error ? rejectJob(error) : resolveJob(),
        err => rejectJob(error ?? err),
      );
    }
    cancel = () => finish(new Error("Rendering cancelled"));
    worker.on("error", err => finish(err));
    worker.on("exit", code => {
      if (!settled) finish(Error(`Renderer exited before completion (code ${code})`));
    });
    worker.on("message", message => {
      if (settled) return;
      try {
        switch (message.type) {
          case "stage": {
            clearTimeout(stageTimer);
            if (!Number.isFinite(message.ms) || message.ms <= 0) throw Error("Invalid renderer deadline");
            stageTimer = setTimeout(() => finish(Error(`${message.op} timed out after ${message.ms}ms`)), message.ms);
            break;
          }
          case "status":
            callbacks.status({...message.status, document_id});
            break;
          case "page":
            callbacks.page({...message.page, document_id}, message.bytes);
            worker.postMessage({type: "ack"});
            break;
          case "done":
            finish();
            break;
          case "error":
            finish(Error(message.error || "Background renderer failed"));
            break;
          default:
            throw Error("Unknown renderer message");
        }
      } catch (err) {finish(err instanceof Error ? err : Error(String(err)));}
    });
    // Copy only this upload, then transfer ownership. Never detach a caller's
    // pooled buffer (the original is still needed by other import operations).
    const bytes = new Uint8Array(buffer);
    worker.postMessage({document_id, bytes}, [bytes.buffer]);
  });
  return {done, cancel: () => cancel()};
}
