import "dotenv/config";
// v0.9.34: Install crash trap FIRST, before any other import can throw. Any
// synchronous error during module resolution (bad DB schema, missing native
// binding, corrupt file) will now leave a trail in server.log and a
// prominently marked line under [crash] before the process exits. Previous
// versions vanished silently under the hidden-window launcher.
import { installCrashTrap } from "./boot";
installCrashTrap();

import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "node:http";
import { rawDb } from "./storage";
import { backfillMissingLocations } from "./locate";
import { bootState, envSnapshot, logRotate, withPhase } from "./boot";
import { logInstallLocationAtBoot } from "./install-location";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// v0.9.16 hardening: cap JSON body size so a rogue tab on the same machine
// can't pin memory by streaming multi-megabyte JSON. Multipart uploads bypass
// this middleware entirely (multer handles them), so this doesn't affect
// legitimate 150 MB file uploads.
app.use(
  express.json({
    limit: "2mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false, limit: "2mb" }));

// -------------------------------------------------------------------
// Simple in-process rate limiter (v0.9.16)
//
// Sliding-window counter per remote address + endpoint bucket. The intent is
// not to defend against a determined attacker on the same box (impossible
// without OS-level controls) but to prevent a runaway browser tab or a
// mistyped for-loop in a colleague's terminal from wedging the server.
//
// - Buckets: writes (POST/PUT/DELETE) get 30 req/10s, reads get 300 req/10s.
// - Excluded: /api/heartbeat (fires every 5s legitimately).
// - Bind to 127.0.0.1 already keeps external traffic out; this handles the
//   local-loop misbehaving-client case.
// -------------------------------------------------------------------
const RATE_WINDOW_MS = 10_000;
const RATE_LIMITS: Record<string, number> = { write: 30, read: 300 };
type RateBucket = { windowStart: number; count: number };
const rateCounters = new Map<string, RateBucket>();

function checkRate(key: string, limit: number): boolean {
  const now = Date.now();
  const b = rateCounters.get(key);
  if (!b || now - b.windowStart > RATE_WINDOW_MS) {
    rateCounters.set(key, { windowStart: now, count: 1 });
    return true;
  }
  b.count += 1;
  return b.count <= limit;
}

app.use((req, res, next) => {
  if (!req.path.startsWith("/api")) return next();
  if (req.path === "/api/heartbeat") return next();
  const isWrite = req.method !== "GET" && req.method !== "HEAD";
  const bucket = isWrite ? "write" : "read";
  const key = `${req.ip ?? "local"}::${bucket}`;
  const limit = RATE_LIMITS[bucket];
  if (!checkRate(key, limit)) {
    res.setHeader("Retry-After", "10");
    return res.status(429).json({ message: "too many requests \u2014 slow down" });
  }
  next();
});

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

// -------------------------------------------------------------------
// Browser-tab heartbeat + idle-shutdown watcher
//
// The browser client pings /api/heartbeat every ~5 seconds while its tab is
// open. If we go longer than IDLE_SHUTDOWN_MS without a heartbeat AND we've
// received at least one heartbeat since startup, we shut down the server so
// the launcher's console can close on its own.
//
// Set RAG_NO_IDLE_SHUTDOWN=1 to disable (useful for headless testing).
//
// v0.9.28: The previous 15s idle timeout was far too aggressive for a portable
// desktop app that spends much of its life in a background tab. A user who
// Alt-Tabbed to Teams, minimized the window, or let the screen lock for more
// than 15 seconds would come back to a dead server (the browser heartbeat also
// pauses while the tab is hidden — see client/src/lib/heartbeat.ts). The
// symptom is the BackendDownOverlay firing seemingly at random. Raising the
// default to 10 minutes matches how techs actually use the tool.
// -------------------------------------------------------------------
const IDLE_SHUTDOWN_MS = parseInt(process.env.RAG_IDLE_SHUTDOWN_MS || "600000", 10);
const IDLE_CHECK_MS = 10000;
let lastHeartbeat = 0;
let hasSeenHeartbeat = false;

app.get("/api/heartbeat", (_req, res) => {
  lastHeartbeat = Date.now();
  hasSeenHeartbeat = true;
  res.json({ ok: true, ts: lastHeartbeat });
});

if (process.env.RAG_NO_IDLE_SHUTDOWN !== "1") {
  setInterval(() => {
    if (!hasSeenHeartbeat) return; // wait for the browser to connect at least once
    const idle = Date.now() - lastHeartbeat;
    if (idle > IDLE_SHUTDOWN_MS) {
      log(`no browser heartbeat for ${Math.round(idle / 1000)}s — shutting down`);
      // Give the log line a moment to flush, then exit cleanly.
      setTimeout(() => process.exit(0), 200);
    }
  }, IDLE_CHECK_MS).unref();
}

// v0.9.16: log method/path/status/duration only. Previous versions logged the
// full JSON response body, which meant search results and ingested document
// content ended up in server.log — sensitive for docs with customer configs,
// credentials, or PII. We keep response-size and error-message logging for
// diagnosability without dumping content.
app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;

  // Track error messages only — not full success bodies. If the response is a
  // 4xx/5xx JSON payload, capture its `message` field for the log line.
  let capturedErrorMessage: string | undefined;
  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    if (res.statusCode >= 400 && bodyJson && typeof bodyJson === "object" && "message" in bodyJson) {
      const m = (bodyJson as any).message;
      if (typeof m === "string") capturedErrorMessage = m.slice(0, 200);
    }
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedErrorMessage) logLine += ` :: ${capturedErrorMessage}`;
      log(logLine);
    }
  });

  next();
});

(async () => {
  // v0.9.34: Print environment snapshot as soon as we can (imports and DB
  // opens have already run at this point via storage.ts side effects, but
  // this line is invaluable for correlating remote reports). Cheap.
  log(envSnapshot(), "boot");

  // v1.0.5: one-shot check whether the app is running from OneDrive /
  // Dropbox / other cloud-sync folder or a UNC network path. A field
  // report of a DOCX upload silently failing with browser "Failed to
  // fetch" traced to a corporate OneDrive folder holding sync-time file
  // locks. Warn once at boot; the /api/health endpoint surfaces the same
  // signal to the client's InstallLocationBanner.
  logInstallLocationAtBoot();

  // v0.9.34: Periodic log rotation while the app is running long-uptime
  // sessions. Rotates server.log -> server.log.1 when the file exceeds 10 MB,
  // keeping only those two files (which is exactly what the diagnostics
  // bundle already picks up). Best-effort: if PowerShell's Tee-Object retains
  // a stale handle, subsequent writes still land in the log stream via the
  // node child's stdout inheritance -- the rename just means the on-disk
  // file is fresh. Runs every 5 minutes.
  logRotate.start();

  // One-shot: derive page numbers + section titles for any excerpts that
  // don't have them yet. Idempotent — no-op once everything is populated.
  await withPhase("locate-backfill", async () => {
    try {
      const updated = backfillMissingLocations(rawDb);
      if (updated > 0) log(`backfilled location metadata for ${updated} excerpts`);
    } catch (err) {
      console.error("[locate] backfill failed:", err);
    }
  });

  await withPhase("register-routes", () => registerRoutes(httpServer, app));

  // v0.9.16: generic error responses. Full stack trace still hits the server
  // log for diagnosability, but the client only ever sees a status-appropriate
  // canned message. Prevents accidental disclosure of local file paths, DB
  // internals, or Node module names via error responses.
  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    // 4xx: pass through validation-style messages (short, safe). 5xx: canned.
    const clientMessage =
      status >= 500
        ? "server error \u2014 see server.log"
        : (err.message || "request failed").slice(0, 200);
    return res.status(status).json({ message: clientMessage });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // v0.9.16 hardening: bind to loopback only. Previous versions listened on
  // 0.0.0.0, meaning anyone on the same LAN could reach the app — a serious
  // concern for field techs on customer/public Wi-Fi. RAG_BIND=0.0.0.0 opts
  // back into wildcard binding for the (rare) case a team explicitly wants a
  // shared-machine setup.
  const port = parseInt(process.env.PORT || "5000", 10);
  const host = process.env.RAG_BIND || "127.0.0.1";
  httpServer.listen(
    {
      port,
      host,
      reusePort: true,
    },
    () => {
      bootState.markReady();
      log(`serving on http://${host}:${port}`);
    },
  );
})();
