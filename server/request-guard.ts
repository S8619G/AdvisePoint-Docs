// v1.3.6: cross-site request guard for the local service.
//
// The service binds to 127.0.0.1, but a browser lets any web page send simple
// form, multipart and text/plain POSTs to it. Responses are not readable
// cross-site, yet such a request can still store data (found November 6, 2026:
// POST /api/query-history accepted `Origin: https://evil.example`). This guard
// runs before the JSON/urlencoded parsers and before multer, so a refused
// request is answered with 403 before any body is read or stored.
//
// Rules for /api writes (every method except GET, HEAD and OPTIONS):
//   1. Sec-Fetch-Site `cross-site` or `same-site` is refused.
//   2. An Origin header must be exactly `http://<Host>` (same origin). The
//      opaque origin "null" is refused.
//   3. Host must be 127.0.0.1, localhost or [::1] on the port this socket
//      accepted, with no user info (DNS-rebinding defence). When RAG_BIND
//      deliberately opts into a non-loopback address, rule 3 is relaxed to the
//      port check only; rules 1 and 2 still apply.
// Requests with no Origin and no Sec-Fetch-Site (the external updater, the
// launcher's health/stop calls, command-line tools on this PC) keep working:
// browsers always attach Origin to cross-site POSTs.
//
// Existing per-route checks (Stop, updater shutdown, PDF actions, uploads)
// stay in place; this guard only adds a common first line of defence.

import type { NextFunction, Request, Response } from "express";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

export type GuardReason =
  | "sec-fetch-site"
  | "origin-mismatch"
  | "origin-null"
  | "host-not-local"
  | "host-port-mismatch"
  | "host-invalid";

export interface GuardInput {
  method: string;
  path: string;
  host: string | undefined;
  origin: string | undefined;
  secFetchSite: string | undefined;
  localPort: number | undefined;
  /** True when RAG_BIND opts into a non-loopback bind address. */
  nonLoopbackBind?: boolean;
}

/** Pure decision: null when allowed, otherwise the refusal reason. */
export function crossSiteRefusal(input: GuardInput): GuardReason | null {
  const method = (input.method || "").toUpperCase();
  if (SAFE_METHODS.has(method)) return null;
  // Express matches routes case-insensitively, so "/API/..." reaches the
  // same handlers: compare the path case-insensitively too.
  const path = (input.path || "").toLowerCase();
  if (path !== "/api" && !path.startsWith("/api/")) return null;

  const site = (input.secFetchSite || "").toLowerCase();
  if (site === "cross-site" || site === "same-site") return "sec-fetch-site";

  let host: URL;
  try {
    if (!input.host || /[\s/\\?#@]/.test(input.host)) return "host-invalid";
    host = new URL(`http://${input.host}`);
  } catch {
    return "host-invalid";
  }
  if (host.username || host.password) return "host-invalid";
  const port = Number(host.port || "80");
  if (input.localPort !== undefined && port !== input.localPort) return "host-port-mismatch";
  if (!input.nonLoopbackBind && !LOOPBACK_HOSTNAMES.has(host.hostname.toLowerCase()))
    return "host-not-local";

  if (input.origin !== undefined) {
    if (input.origin.trim().toLowerCase() === "null") return "origin-null";
    let origin: URL;
    try {
      origin = new URL(input.origin);
    } catch {
      return "origin-mismatch";
    }
    if (origin.protocol !== "http:" || origin.host.toLowerCase() !== host.host.toLowerCase())
      return "origin-mismatch";
  }
  return null;
}

function isNonLoopbackBind(): boolean {
  const bind = (process.env.RAG_BIND || "127.0.0.1").trim().toLowerCase();
  return !["127.0.0.1", "localhost", "::1"].includes(bind);
}

let refusals = 0;

/** Express middleware. Register before any body parser or multer. */
export function crossSiteGuard(req: Request, res: Response, next: NextFunction) {
  const reason = crossSiteRefusal({
    method: req.method,
    path: req.path,
    host: req.get("host"),
    origin: req.get("origin"),
    secFetchSite: req.get("sec-fetch-site"),
    localPort: req.socket.localPort,
    nonLoopbackBind: isNonLoopbackBind(),
  });
  if (!reason) return next();
  refusals++;
  // Bounded logging: the first 20 refusals, then every 100th, so a hostile page
  // cannot flood server.log. No body is read, so nothing else is logged.
  if (refusals <= 20 || refusals % 100 === 0)
    console.warn(`[guard] refused ${req.method} ${req.path} reason=${reason} count=${refusals}`);
  res.setHeader("Connection", "close");
  return res.status(403).json({ message: "Cross-site request refused." });
}
