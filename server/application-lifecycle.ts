import type { Express, Request } from "express";
import type { Server } from "node:http";

/** Reject cross-site requests and DNS-rebinding hosts, even from loopback. */
export function isAuthorizedStop(req: Request): boolean {
  const remote = req.socket.remoteAddress;
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote ?? "")) return false;
  try {
    const host = new URL(`http://${req.get("host")}`);
    const origin = new URL(req.get("origin") ?? "");
    return ["localhost", "127.0.0.1", "[::1]"].includes(host.hostname) &&
      origin.origin === host.origin && !host.username && !host.password &&
      Number(host.port || "80") === req.socket.localPort &&
      req.get("x-apd-stop") === "1" && req.body?.confirm === true;
  } catch { return false; }
}

/** Register before API routes. No stop while tracked work is in flight. */
export function registerApplicationLifecycle(
  app: Express, server: Server,
  isBusy: () => boolean, shutdown: () => void,
) {
  let pendingWrites = 0;
  let stopping = false;
  app.use((req, res, next) => {
    if (!req.path.startsWith("/api/")) return next();
    if (stopping) return res.status(503).json({ message: "Application is stopping." });
    if (req.path !== "/api/system/stop" && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      pendingWrites++;
      // Do not treat an aborted connection as a completed write. It may
      // still be processing. A conservative refusal is safer than data loss.
      res.once("finish", () => { pendingWrites--; });
    }
    next();
  });
  app.post("/api/system/stop", (req, res) => {
    if (!isAuthorizedStop(req))
      return res.status(403).json({ message: "Confirmed same-origin local request required." });
    if (pendingWrites > 0 || isBusy())
      return res.status(409).json({ message: "Work is still active. Finish uploads, printing, external edits, backups or updates, then retry." });
    stopping = true;
    res.once("finish", () => {
      console.log("[shutdown] explicit Stop application accepted");
      // The response is flushed. Close in the same turn so a new background
      // task cannot start during an artificial shutdown delay.
      server.close(() => shutdown());
      server.closeAllConnections();
    });
    res.json({ ok: true });
  });
}
