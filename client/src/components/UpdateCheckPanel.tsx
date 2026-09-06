import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, CheckCircle2, Download, ExternalLink, Loader2, RefreshCw, WifiOff } from "lucide-react";
import { UpdateCheck, cmpVersion, type LatestRelease } from "@/lib/updateCheck";

// Manual "Check for updates" panel, mounted under Settings.
//
// Distinct from the top-nav UpdateBanner, which is background-only. This panel
// gives the user a Check now button that force-refreshes the GitHub call
// (bypassing the 24h localStorage cache) and shows a status message inline.
//
// States (in order of user visibility):
//   - idle:      last-known cached result, "Check now" button enabled
//   - checking:  spinner + "Checking GitHub for a newer release…"
//   - uptodate:  green check, "You're on the latest version"
//   - available: amber, release title/notes, Download + What's new links
//   - unusual:   amber warning, GitHub says the latest tag is OLDER than the
//                installed version — added in v0.9.35 after a mistyped tag
//                (v0.0.34 for what should have been v0.9.34) silently rendered
//                the up-to-date state because cmpVersion compared numerically.
//                We surface the mismatch instead of pretending everything is
//                fine.
//   - offline:   red, "Couldn't reach GitHub — try again in a moment"

type Status = "idle" | "checking" | "uptodate" | "available" | "unusual" | "offline";

// Given a fresh release and the installed version, decide which post-check
// status to show. Split out from the click handler so both the mount-hydrate
// and the manual check can share the classification logic.
function classifyRelease(latest: LatestRelease, installed: string): Status {
  const cmp = cmpVersion(latest.version, installed);
  if (cmp > 0) return "available";
  if (cmp < 0) return "unusual";
  return "uptodate";
}

// Format a UTC epoch millis as a compact "N minutes/hours/days ago" string.
// Wraps to "just now" for < 60s and "on <ISO date>" for anything over 30 days,
// which is a friendly middle ground for a settings page (no i18n needed).
function formatRelative(ms: number | null): string {
  if (ms == null) return "never";
  const diffSec = Math.round((Date.now() - ms) / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? "" : "s"} ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
  return `on ${new Date(ms).toISOString().slice(0, 10)}`;
}

// Read the cache metadata (fetchedAt) without triggering a refresh. This lets
// us show "Last checked: N minutes ago" without hitting the network.
function readCachedFetchTime(): number | null {
  try {
    const raw = localStorage.getItem("apd:update:cache");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed?.fetchedAt === "number" ? parsed.fetchedAt : null;
  } catch {
    return null;
  }
}

// In-app updater client. Kicks the loopback launch endpoint that spawns the
// external `Update AdvisePoint Docs.bat` detached and, once the server dies
// mid-swap, the BackendDownOverlay takes over. Returns a discriminated result
// so the caller can distinguish transport failures (network / 5xx) from
// deliberate 404/501 responses that warrant a different UX message.
type LaunchResult =
  | { kind: "ok" }
  | { kind: "missing" } // 404: launcher .bat not next to app (dev build?)
  | { kind: "unsupported" } // 501: non-Windows
  | { kind: "error"; message: string };

async function launchInAppUpdater(): Promise<LaunchResult> {
  try {
    const res = await fetch("/api/updater/launch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (res.ok) return { kind: "ok" };
    if (res.status === 404) return { kind: "missing" };
    if (res.status === 501) return { kind: "unsupported" };
    let body = "";
    try {
      const j = await res.json();
      body = typeof j?.message === "string" ? j.message : "";
    } catch {
      /* non-JSON body is fine */
    }
    return { kind: "error", message: body || `HTTP ${res.status}` };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

type LaunchState =
  | { phase: "idle" }
  | { phase: "launching" }
  | { phase: "launched"; secondsLeft: number }
  | { phase: "failed"; message: string; kind: LaunchResult["kind"] };

export function UpdateCheckPanel() {
  const [status, setStatus] = useState<Status>("idle");
  const [release, setRelease] = useState<LatestRelease | null>(null);
  const [lastCheckedMs, setLastCheckedMs] = useState<number | null>(readCachedFetchTime());
  const [launch, setLaunch] = useState<LaunchState>({ phase: "idle" });

  // After the launcher .bat spawns, updater.cjs takes ~10 s to acquire the
  // release list and post the shutdown handshake. We show a visible countdown
  // to reassure the user something is happening. When it hits zero, the
  // BackendDownOverlay will already be showing because the server has died.
  useEffect(() => {
    if (launch.phase !== "launched") return;
    if (launch.secondsLeft <= 0) return;
    const t = setTimeout(() => {
      setLaunch((prev) =>
        prev.phase === "launched" ? { phase: "launched", secondsLeft: prev.secondsLeft - 1 } : prev,
      );
    }, 1000);
    return () => clearTimeout(t);
  }, [launch]);

  // v0.9.36.1: launch verification. The server returns 200 as soon as it
  // successfully calls spawn(), but on Windows the spawned .bat can still
  // fail at the OS layer (e.g. the pre-v0.9.36.1 quoting bug where
  // `start` couldn't parse the launcher path with spaces in it). In that
  // case the server stays alive, no updater window appears, and the user
  // is left staring at a fake countdown. Detect this by polling /api/health
  // 20 s after "launched" — by then updater.cjs should have released the
  // port. If the server is still responsive, treat the launch as failed
  // and surface the manual-download fallback with an actionable message.
  useEffect(() => {
    if (launch.phase !== "launched") return;
    if (launch.secondsLeft > 0) return;
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        if (!res.ok) return; // server dying — updater is doing its thing
        // Server is still alive after the countdown. Launch never took effect.
        setLaunch({
          phase: "failed",
          kind: "error",
          message:
            "The updater didn't start. Close this app manually, then use Download below to install v" +
            (release?.tag?.replace(/^v/, "") ?? "the latest release") +
            " by extracting the zip on top of your current install folder.",
        });
      } catch {
        // Fetch threw — server likely dead as expected.
      }
    }, 15000);
    return () => clearTimeout(t);
  }, [launch, release]);

  const onUpdateNow = useCallback(async () => {
    setLaunch({ phase: "launching" });
    const result = await launchInAppUpdater();
    if (result.kind === "ok") {
      setLaunch({ phase: "launched", secondsLeft: 5 });
    } else if (result.kind === "missing") {
      setLaunch({
        phase: "failed",
        kind: result.kind,
        message:
          "The updater launcher file is not next to the app. Use the Download link above to update manually.",
      });
    } else if (result.kind === "unsupported") {
      setLaunch({
        phase: "failed",
        kind: result.kind,
        message: "In-app updates are Windows-only. Use the Download link above to update manually.",
      });
    } else {
      setLaunch({ phase: "failed", kind: result.kind, message: result.message });
    }
  }, []);

  // On mount, hydrate from cache without hitting the network. Users may have
  // opened this panel just to see the version number.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cached = await UpdateCheck.getLatestRelease(); // cache-first
      if (cancelled) return;
      setRelease(cached);
      setLastCheckedMs(readCachedFetchTime());
      if (cached) {
        setStatus(classifyRelease(cached, UpdateCheck.installed));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onCheck = useCallback(async () => {
    setStatus("checking");
    // Force a network fetch — skips the 24h cache
    const fresh = await UpdateCheck.getLatestRelease(true);
    setLastCheckedMs(readCachedFetchTime());
    if (!fresh) {
      // Null return means fetch threw / non-2xx / malformed. Treat as offline.
      setStatus("offline");
      return;
    }
    setRelease(fresh);
    setStatus(classifyRelease(fresh, UpdateCheck.installed));
    // A new release list may change what "update available" looks like, so
    // reset any prior launch feedback so it's not stuck on "launched" after
    // the user hits Check again.
    setLaunch({ phase: "idle" });
  }, []);

  const installed = UpdateCheck.installed;

  return (
    <Card data-testid="card-update-check">
      <CardHeader>
        <CardTitle className="text-sm">About & updates</CardTitle>
        <CardDescription className="text-xs">
          AdvisePoint Docs checks GitHub for new releases in the background about once a day.
          Use the button below to check right now.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Version + last-checked row */}
        <div className="flex items-center gap-3 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs">
          <span className="text-muted-foreground">Installed version</span>
          <Badge variant="secondary" className="font-mono" data-testid="badge-installed-version">
            v{installed}
          </Badge>
          <span className="ml-auto text-muted-foreground">
            Last checked: <span data-testid="text-last-checked">{formatRelative(lastCheckedMs)}</span>
          </span>
        </div>

        {/* Status card */}
        {status === "idle" && (
          <div className="rounded-md border border-border/60 px-3 py-3 text-xs text-muted-foreground">
            Click <span className="font-medium text-foreground">Check now</span> to see if a newer version is available.
          </div>
        )}

        {status === "checking" && (
          <div
            className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-3 text-xs text-muted-foreground"
            data-testid="status-checking"
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Checking GitHub for a newer release…
          </div>
        )}

        {status === "uptodate" && (
          <div
            className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-3 text-xs text-emerald-800 dark:text-emerald-200"
            data-testid="status-uptodate"
          >
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
            <span>
              You&apos;re on the latest version
              {release ? <span className="opacity-70"> (v{release.version})</span> : null}.
            </span>
          </div>
        )}

        {status === "unusual" && release && (
          <div
            className="space-y-2 rounded-md border border-amber-500/50 bg-amber-500/15 px-3 py-3 text-xs text-amber-900 dark:text-amber-200"
            data-testid="status-unusual"
          >
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span className="font-medium">
                Unexpected release version on GitHub
              </span>
            </div>
            <div className="pl-5">
              GitHub advertises{" "}
              <span className="font-mono">v{release.version}</span> as the latest release, but
              you&apos;re running <span className="font-mono">v{installed}</span>, which is newer.
              This usually means a release tag was mistyped or an older release was mistakenly
              re-marked as latest. Not treating this as an update.
            </div>
            <div className="flex items-center gap-2 pl-5 pt-1">
              <a
                href={release.htmlUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded px-2 py-1 hover:bg-amber-500/20"
                data-testid="link-panel-update-unusual"
              >
                <ExternalLink className="h-3 w-3" />Open releases page
              </a>
            </div>
          </div>
        )}

        {status === "available" && release && (
          <div
            className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-3 text-xs text-amber-900 dark:text-amber-200"
            data-testid="status-available"
          >
            <div className="flex items-center gap-2">
              <Download className="h-3.5 w-3.5 shrink-0" />
              <span className="font-medium">
                Update available: {release.name || release.tag}
              </span>
              <span className="opacity-70">you have v{installed}</span>
            </div>
            {release.publishedAt && (
              <div className="pl-5 text-[11px] opacity-70">
                Published {new Date(release.publishedAt).toLocaleDateString()}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2 pl-5 pt-1">
              {/* v0.9.35: primary path is now the in-app updater button. The
                  Download link is retained as a fallback for the failure and
                  unsupported-platform cases, and for users who prefer the
                  manual path. */}
              <Button
                size="sm"
                onClick={onUpdateNow}
                disabled={launch.phase === "launching" || launch.phase === "launched"}
                data-testid="button-update-now"
                className="h-7 gap-1"
              >
                {launch.phase === "launching" ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" />Starting updater…
                  </>
                ) : launch.phase === "launched" ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Closing in {launch.secondsLeft}s…
                  </>
                ) : (
                  <>
                    <Download className="h-3 w-3" />Update now
                  </>
                )}
              </Button>
              <a
                href={release.zipUrl || release.htmlUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] hover:bg-amber-500/20"
                data-testid="link-panel-update-download"
              >
                <Download className="h-3 w-3" />Download manually
              </a>
              <a
                href={release.htmlUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] hover:bg-amber-500/20"
                data-testid="link-panel-update-notes"
              >
                <ExternalLink className="h-3 w-3" />What&apos;s new
              </a>
            </div>
            {launch.phase === "launched" && (
              <div className="pl-5 pt-1 text-[11px] opacity-80" data-testid="text-updater-countdown">
                Update AdvisePoint Docs is running in a new window. This app will disconnect
                shortly — the updater will download and swap the new build, then relaunch
                automatically.
              </div>
            )}
            {launch.phase === "failed" && (
              <div
                className="pl-5 pt-1 text-[11px] text-destructive"
                data-testid="text-updater-launch-failed"
              >
                Couldn&apos;t start the in-app updater: {launch.message}
              </div>
            )}
          </div>
        )}

        {status === "offline" && (
          <div
            className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-3 text-xs text-destructive"
            data-testid="status-offline"
          >
            <WifiOff className="h-3.5 w-3.5 shrink-0" />
            Couldn&apos;t reach GitHub &mdash; check your connection and try again in a moment.
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={onCheck}
            disabled={status === "checking"}
            data-testid="button-check-updates"
          >
            <RefreshCw className={`mr-2 h-3.5 w-3.5 ${status === "checking" ? "animate-spin" : ""}`} />
            {status === "checking" ? "Checking…" : "Check now"}
          </Button>
          <span className="text-[11px] text-muted-foreground">
            Reads {" "}
            <a
              href="https://github.com/S8619G/AdvisePoint-Docs/releases/latest"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-foreground"
            >
              github.com/S8619G/AdvisePoint-Docs
            </a>
            . No account needed.
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
