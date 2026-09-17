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
import { appendBackupLogSessionStart } from "./backup-log";
import { IdleWatchdog } from "./idle-watchdog";
import {
  getRenderQueueSnapshot,
  reconcilePersistedRenderStatuses,
  reconcilePersistedPageImagePaths,
} from "./pages";
// v1.1.7: import the shared shutdown watchdog so it is instantiated at boot.
// The worker thread is idle until /api/updater/shutdown arms it.
import "./shutdown-watchdog-holder";
import { APP_VERSION } from "../client/src/version";

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
//
// v1.1.6: the elapsed-time test moved into IdleWatchdog so it can tell a
// suspended machine from an absent browser. Sleeping the computer for longer
// than the idle window used to kill the server every time: node and the
// browser freeze together, no heartbeats arrive, but the wall clock keeps
// running, so the first tick after wake saw hours of "idleness" and exited
// before the tab could ping again. The watchdog now treats a tick that
// arrives far later than the interval as proof the process was not running,
// and restarts the idle clock from the moment of resume.
// -------------------------------------------------------------------
const IDLE_SHUTDOWN_MS = parseInt(process.env.RAG_IDLE_SHUTDOWN_MS || "600000", 10);
const IDLE_CHECK_MS = 10000;

const idleWatchdog = new IdleWatchdog({
  idleShutdownMs: IDLE_SHUTDOWN_MS,
  checkMs: IDLE_CHECK_MS,
});

app.get("/api/heartbeat", (_req, res) => {
  const ts = Date.now();
  idleWatchdog.heartbeat(ts);
  res.json({ ok: true, ts });
});

// v1.1.7: log the render-busy hold at most once per busy interval so
// server.log doesn't fill with the same line every 10 s while a long batch
// finishes. Reset once we've actually exited the busy state.
let renderBusyHoldLogged = false;

if (process.env.RAG_NO_IDLE_SHUTDOWN !== "1") {
  idleWatchdog.start(Date.now());
  setInterval(() => {
    const result = idleWatchdog.tick(Date.now());
    if (result.action === "resumed") {
      // Logged because this is the one event that explains an otherwise
      // puzzling gap in server.log, and because it confirms the sleep
      // handling is doing its job on a real machine.
      if (result.suspendedMs > 0) {
        log(
          `resumed after ${Math.round(result.suspendedMs / 1000)}s suspended — ` +
            `idle timer reset, waiting for the browser`,
        );
      } else {
        log("system clock moved backwards — idle timer reset");
      }
      return;
    }
    if (result.action === "shutdown") {
      // v1.1.7: hold off idle shutdown while renders are still in flight. The
      // render queue lives in RAM, so exiting here would abandon queued and
      // in-progress documents (they show as interrupted after next boot's
      // reconcile pass). The tab is already gone -- nobody to prompt -- so we
      // just wait. The next tick reruns this branch; when the queue drains
      // the shutdown fires normally. The busy check lives at the call site
      // deliberately so IdleWatchdog stays pure and testable (no queue
      // state injected). Backoff log is emitted at most once per busy state
      // to keep server.log readable across long-lived queues.
      const snap = getRenderQueueSnapshot();
      const busy = snap.running || snap.queue_depth > 0;
      if (busy) {
        if (!renderBusyHoldLogged) {
          const inFlight = (snap.running ? 1 : 0) + snap.queue_depth;
          log(
            `idle shutdown held: ${inFlight} document${inFlight === 1 ? "" : "s"} still rendering; will retry on next tick`,
          );
          renderBusyHoldLogged = true;
        }
        return;
      }
      renderBusyHoldLogged = false;
      log(`no browser heartbeat for ${Math.round(result.idleMs / 1000)}s — shutting down`);
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

  // v1.0.12.2: mark each app start in the dedicated backup log. Without a
  // start marker, a night with no backup line is ambiguous -- it could mean
  // the scheduled run failed silently, or simply that the app was never
  // open. The marker makes those two cases distinguishable when reading a
  // bundle weeks later.
  appendBackupLogSessionStart(APP_VERSION);

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

  // v1.1.7: settle any render_status rows left at pending/rendering by a
  // previous crash, upgrade, or forced shutdown. Interrupted documents reach
  // a terminal error state instead of spinning forever in the PageViewer
  // and start appearing in /api/render/status.recent_failures. See
  // server/pages.ts::reconcilePersistedRenderStatuses for the rules.
  await withPhase("reconcile-render-status", async () => {
    try {
      const result = reconcilePersistedRenderStatuses();
      if (result.scanned > 0) {
        log(
          `render-status reconcile: scanned=${result.scanned} ` +
            `promoted_ready=${result.promoted_ready} ` +
            `marked_interrupted=${result.marked_interrupted}`,
        );
      }
    } catch (err) {
      console.error("[reconcile] render-status reconcile failed:", err);
    }
  });

  // v1.2.1: heal document_pages.image_path values that point at the previous
  // machine's absolute paths after a cross-machine or cross-user restore.
  // Runs after render-status reconcile so we operate on the freshest view of
  // what's actually on disk. See
  // server/pages.ts::reconcilePersistedPageImagePaths for the exact rules.
  await withPhase("reconcile-page-image-paths", async () => {
    try {
      const result = reconcilePersistedPageImagePaths();
      if (result.rewritten > 0 || result.missing > 0) {
        log(
          `page-image-path reconcile: scanned=${result.scanned} ` +
            `rewritten=${result.rewritten} missing=${result.missing}`,
        );
      }
    } catch (err) {
      console.error("[reconcile] page-image-path reconcile failed:", err);
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

      // v1.0.12.5: detect and clear the post-update `.updating` sentinel
      // unconditionally, before (and independent of) the browser-open
      // path. Previously this lived inside the `APD_OPEN_BROWSER === "1"`
      // block, so any launch that did not open a browser (or any launch
      // where APD_JUST_UPDATED=1 was already set by updater.cjs since
      // v1.0.12.1) left the sentinel on disk. That stale marker made
      // Settings > Update show "A previous update attempt didn't
      // complete." after every successful in-app update, once the file
      // aged past readSentinelStatus()'s 5-minute freshness window.
      //
      // Detection: env var OR sentinel presence on Windows. Cleanup:
      // unconditionally attempt to unlink the sentinel on Windows so a
      // successful boot always clears it, regardless of how justUpdated
      // was determined. Kept non-fatal on any filesystem error so a
      // permissions hiccup can never block boot.
      let justUpdated = process.env.APD_JUST_UPDATED === "1";
      if (process.platform === "win32") {
        try {
          const fs = require("node:fs") as typeof import("node:fs");
          const path = require("node:path") as typeof import("node:path");
          const base = process.env.LOCALAPPDATA || process.env.APPDATA;
          if (base) {
            const sentinel = path.join(base, "AdvisePoint Docs", ".updating");
            let sentinelPresent = false;
            try { sentinelPresent = fs.existsSync(sentinel); } catch { /* non-fatal */ }
            if (sentinelPresent) {
              justUpdated = true;
            }
            // Consume the sentinel now so a subsequent restart
            // (e.g. wipe-and-replace restore) doesn't misread us
            // as still coming out of an update. Unlinking a
            // missing file throws ENOENT; the try/catch swallows it.
            try { fs.unlinkSync(sentinel); } catch { /* non-fatal */ }
          }
        } catch { /* non-fatal */ }
      }

      // v1.0.9.23: open the browser from the server, once we're actually
      // listening. This replaces the launcher's old PowerShell
      // "Start-Sleep 3; Start-Process http://..." one-shot, which was
      // one of two PowerShell processes the launcher used to spawn and
      // which contributed to the persistent-taskbar-entry issue on
      // Windows 11 26200. Firing after listen() also means the browser
      // never gets to the URL before the server is ready to respond,
      // eliminating a class of first-load races that used to require
      // manual refresh on slow disks.
      if (process.env.APD_OPEN_BROWSER === "1") {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { spawn } = require("node:child_process");
          // v1.0.11.5: when we've just come out of an update, the previous
          // browser tab is already sitting on http://127.0.0.1:<port> (now
          // showing the down modal because the server was killed and
          // relaunched). If we open the exact same URL, Chrome/Edge just
          // focus that stale tab without reloading -- the user sees the
          // "disconnected" page and thinks the update failed. Append a
          // unique query string so the shell URL association picks a
          // fresh navigation. Either the stale tab reloads to the new
          // URL (loading the new client bundle) or a new tab opens.
          // `justUpdated` was determined and the sentinel cleared above.
          const url = justUpdated
            ? `http://127.0.0.1:${port}/?updated=${Date.now()}`
            : `http://127.0.0.1:${port}`;
          if (process.platform === "win32") {
            // `cmd /c start "" <url>` opens the default browser via the
            // Windows shell URL association, then cmd exits. windowsHide
            // + detached + stdio ignore means no window is ever mapped.
            spawn("cmd.exe", ["/c", "start", "", url], {
              detached: true,
              stdio: "ignore",
              windowsHide: true,
            }).unref();
          } else if (process.platform === "darwin") {
            spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
          } else {
            spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
          }
        } catch (err) {
          log(`browser-open skipped: ${String(err)}`);
        }
      }
    },
  );
})();
