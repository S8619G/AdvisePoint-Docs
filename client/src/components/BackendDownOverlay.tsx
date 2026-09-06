// v0.9.30 - Two-tier backend health UI:
//   * Full-screen modal (this file's original behavior) when health is "down".
//     Shown after ~14s of sustained failure. Copy tells the user to relaunch.
//   * Slim banner across the top when health is "reconnecting". Shown after
//     one failed poll (~2s). Auto-clears the moment a poll succeeds. Non-
//     blocking so users can still click around and the app just recovers.
//
// The health poller ticks every POLL_INTERVAL_MS (2s). Each tick updates the
// shared BackendHealth state in queryClient.ts. Everything else in the app
// (query fetches, mutations) also updates that state via noteFetchFailure /
// noteFetchSuccess so a busy user detects a stall faster than the poll cadence.
//
// v0.9.26 lineage:
//   - Any React Query fetch that hit a network TypeError sets backend-down.
//   - Retry button forces one poll and re-invalidates all queries on success.

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, RefreshCw, Loader2 } from "lucide-react";
import {
  getBackendHealth,
  setBackendHealth,
  subscribeBackendHealth,
  queryClient,
  type BackendHealth,
} from "@/lib/queryClient";

const HEALTH_URL = "/api/health";
const POLL_INTERVAL_MS = 2000;
// Consecutive health failures required to escalate poller state.
const RECONNECT_THRESHOLD = 1; // first failed poll => "reconnecting" banner
const DOWN_THRESHOLD = 7;      // ~14s of sustained failure => full modal

async function pingHealth(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(HEALTH_URL, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

export function BackendDownOverlay() {
  const [health, setHealthState] = useState<BackendHealth>(getBackendHealth());
  const [retrying, setRetrying] = useState(false);
  const failCountRef = useRef(0);

  // Subscribe to global backend health state (also set by any failed fetch).
  useEffect(() => subscribeBackendHealth(setHealthState), []);

  // Health poller. Runs continuously. A healthy response resets the fail
  // counter and (if the app thought it was disconnected) flips back to "up".
  // Failures escalate reconnecting -> down at the thresholds above.
  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      const ok = await pingHealth();
      if (cancelled) return;
      if (ok) {
        failCountRef.current = 0;
        if (getBackendHealth() !== "up") {
          setBackendHealth("up");
          // Backend came back - refetch everything so stale error states
          // clear and the app resumes.
          queryClient.invalidateQueries();
        }
      } else {
        failCountRef.current += 1;
        if (failCountRef.current >= DOWN_THRESHOLD) {
          if (getBackendHealth() !== "down") setBackendHealth("down");
        } else if (failCountRef.current >= RECONNECT_THRESHOLD) {
          if (getBackendHealth() === "up") setBackendHealth("reconnecting");
        }
      }
    };

    // Fire once immediately, then on interval.
    tick();
    const id = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const handleRetry = async () => {
    setRetrying(true);
    const ok = await pingHealth();
    if (ok) {
      failCountRef.current = 0;
      setBackendHealth("up");
      queryClient.invalidateQueries();
    }
    setRetrying(false);
  };

  // "reconnecting": slim non-blocking banner across the top.
  if (health === "reconnecting") {
    return (
      <div
        className="fixed left-0 right-0 top-0 z-[9998] flex items-center justify-center gap-2 border-b border-amber-500/40 bg-amber-500/15 py-1.5 text-xs text-amber-900 backdrop-blur-sm dark:text-amber-200"
        data-testid="backend-reconnecting-banner"
        role="status"
        aria-live="polite"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        <span>
          Reconnecting to the local service&hellip; usually finishes on its own
          in a few seconds.
        </span>
      </div>
    );
  }

  // "up": render nothing.
  if (health !== "down") return null;

  // "down": full-screen modal with recovery steps.
  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-background/95 backdrop-blur-sm"
      data-testid="backend-down-overlay"
      role="alertdialog"
      aria-labelledby="backend-down-title"
      aria-describedby="backend-down-body"
    >
      <div className="max-w-lg w-[92%] rounded-lg border border-destructive/50 bg-card shadow-2xl">
        <div className="flex items-start gap-3 p-6 border-b border-border">
          <AlertTriangle
            className="h-6 w-6 text-destructive shrink-0 mt-0.5"
            aria-hidden="true"
          />
          <div>
            <h2
              id="backend-down-title"
              className="text-lg font-semibold text-foreground"
            >
              AdvisePoint Docs isn't responding
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              The local service that stores your documents has stopped.
            </p>
          </div>
        </div>
        <div id="backend-down-body" className="p-6 space-y-3 text-sm">
          <p>
            The local AdvisePoint Docs service has shut down, so this page
            can't reach its data. This can happen after the app is minimized
            or the screen locks for a long time.
          </p>
          <div className="rounded-md bg-muted/60 p-3 space-y-1">
            <p className="font-medium">To recover:</p>
            <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
              <li>Close this browser tab yourself (Ctrl+W or the tab's X).</li>
              <li>
                Double-click <span className="font-medium">Start AdvisePoint
                Docs</span> on your desktop (or Start menu) to relaunch.
              </li>
              <li>
                If it keeps happening, check{" "}
                <code className="text-xs bg-background px-1 py-0.5 rounded">
                  %LOCALAPPDATA%\AdvisePoint Docs\server.log
                </code>{" "}
                for the crash reason.
              </li>
            </ol>
          </div>
          <p className="text-xs text-muted-foreground">
            "Check again" only helps if you've already relaunched the app in
            another window and want this tab to reconnect. Otherwise, follow
            the steps above.
          </p>
        </div>
        <div className="flex items-center justify-end gap-2 p-4 border-t border-border bg-muted/20">
          <button
            type="button"
            onClick={handleRetry}
            disabled={retrying}
            className="inline-flex items-center gap-1.5 h-9 rounded-md bg-primary text-primary-foreground px-3 text-sm hover:bg-primary/90 disabled:opacity-60"
            data-testid="button-backend-retry"
          >
            <RefreshCw
              className={`h-4 w-4 ${retrying ? "animate-spin" : ""}`}
            />
            {retrying ? "Checking..." : "Check again"}
          </button>
        </div>
      </div>
    </div>
  );
}
