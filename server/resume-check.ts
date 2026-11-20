// v1.3.6: listener self-check after a process timer gap (PC sleep/resume).
//
// Field report 2026-11-18: after two long timer gaps the browser tab could
// not reach the local service, yet nothing was logged. This module makes one
// request to the server's own listener after a gap and logs the result, so
// the next diagnostics bundle shows whether the listener survived resume.
//
// If the listener is dead (the connection is refused or reset, twice, a
// short while apart) and no work is active, the caller exits cleanly so the
// next launch starts fresh instead of finding a half-alive process. A slow
// answer (timeout) is NOT treated as dead: a busy event loop after resume is
// normal, and stopping a busy server could interrupt work.

import http from "node:http";

export interface SelfCheckResult {
  ok: boolean;
  /** HTTP status when a response arrived. */
  status?: number;
  /** Node error code when the request failed (ECONNREFUSED, ETIMEDOUT, ...). */
  code?: string;
  ms: number;
}

const DEAD_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EADDRNOTAVAIL", "EPIPE"]);

/** Request GET /api/health on the given loopback port. Never throws. */
export function checkOwnListener(port: number, timeoutMs = 5000): Promise<SelfCheckResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: Omit<SelfCheckResult, "ms">) => {
      if (settled) return;
      settled = true;
      resolve({ ...r, ms: Date.now() - started });
    };
    const req = http.get(
      { host: "127.0.0.1", port, path: "/api/health", agent: false, headers: { "x-apd-self-check": "1" } },
      (res) => {
        res.resume();
        res.on("end", () => done({ ok: (res.statusCode ?? 0) < 500, status: res.statusCode }));
        res.on("error", () => done({ ok: false, status: res.statusCode, code: "ERESPONSE" }));
      },
    );
    req.setTimeout(timeoutMs, () => {
      done({ ok: false, code: "ETIMEDOUT" });
      req.destroy();
    });
    req.on("error", (err: NodeJS.ErrnoException) => done({ ok: false, code: err.code ?? "EUNKNOWN" }));
  });
}

/** True only for failures that mean nothing is listening any more. */
export function isListenerDead(result: SelfCheckResult): boolean {
  return !result.ok && result.status === undefined && DEAD_CODES.has(result.code ?? "");
}

export function describeSelfCheck(result: SelfCheckResult): string {
  if (result.ok) return `listener self-check ok (HTTP ${result.status}, ${result.ms} ms)`;
  if (result.status !== undefined) return `listener self-check answered HTTP ${result.status} (${result.ms} ms)`;
  return `listener self-check failed: ${result.code} (${result.ms} ms)`;
}

export interface ResumeCheckDeps {
  port: () => number | null;
  listening: () => boolean;
  isBusy: () => boolean;
  log: (message: string) => void;
  exit: () => void;
  check?: typeof checkOwnListener;
  wait?: (ms: number) => Promise<void>;
  retryDelayMs?: number;
}

/** Run after a timer gap. Logs one line per attempt; exits only when the
 *  listener is dead on two attempts and no work is active. */
export async function runResumeCheck(deps: ResumeCheckDeps): Promise<"ok" | "kept" | "exited"> {
  const check = deps.check ?? checkOwnListener;
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref()));
  const port = deps.port();
  if (!port || !deps.listening()) {
    deps.log("listener self-check: server is not listening");
  } else {
    const first = await check(port);
    deps.log(describeSelfCheck(first));
    if (!isListenerDead(first)) return first.ok ? "ok" : "kept";
    await wait(deps.retryDelayMs ?? 15000);
    const second = await check(port);
    deps.log(`${describeSelfCheck(second)} (retry)`);
    if (!isListenerDead(second)) return second.ok ? "ok" : "kept";
  }
  if (deps.isBusy()) {
    deps.log("listener appears dead, but work is active; keeping the process running");
    return "kept";
  }
  deps.log("listener is not answering after resume; exiting cleanly so the next launch starts fresh");
  deps.exit();
  return "exited";
}
