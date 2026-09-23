import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, CheckCircle2, Download, ExternalLink, Info, Loader2, RefreshCw, Upload, WifiOff, X } from "lucide-react";
// v1.1.7: pre-upgrade render-busy confirm dialog.
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { UpdateCheck, cmpVersion, type LatestRelease } from "@/lib/updateCheck";
import { LOCAL_TEST } from "@/build-mode";

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
  | { phase: "launched"; startedAt: number }
  | { phase: "failed"; message: string; kind: LaunchResult["kind"] };

// v1.0.9: last-attempt sentinel diagnostic. Reads the .updating sentinel state
// exposed by GET /api/updater/last-attempt. `stale` means the sentinel is
// older than 5 minutes and younger than 24 hours — i.e., an in-place update
// attempt was started, never completed, and the launcher's 24h self-heal
// window hasn't elapsed yet.
type LastAttempt = {
  present: boolean;
  stale: boolean;
  age_ms: number | null;
  path: string | null;
  log_path: string | null;
};

async function fetchLastAttempt(): Promise<LastAttempt | null> {
  try {
    const res = await fetch("/api/updater/last-attempt", { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as LastAttempt;
  } catch {
    return null;
  }
}

async function clearLastAttempt(): Promise<boolean> {
  try {
    const res = await fetch("/api/updater/last-attempt", { method: "DELETE" });
    return res.ok;
  } catch {
    return false;
  }
}

export function UpdateCheckPanel() {
  return LOCAL_TEST ? (
    <Card data-testid="local-test-update-notice">
      <CardHeader><CardTitle>v1.3.0 local-test candidate</CardTitle>
        <CardDescription>Update checks and installation are disabled. This test library is separate from your working installation.</CardDescription>
      </CardHeader>
    </Card>
  ) : <EnabledUpdateCheckPanel />;
}

function EnabledUpdateCheckPanel() {
  const [status, setStatus] = useState<Status>("idle");
  const [release, setRelease] = useState<LatestRelease | null>(null);
  const [lastCheckedMs, setLastCheckedMs] = useState<number | null>(readCachedFetchTime());
  const [launch, setLaunch] = useState<LaunchState>({ phase: "idle" });
  const [lastAttempt, setLastAttempt] = useState<LastAttempt | null>(null);
  const [dismissedAttempt, setDismissedAttempt] = useState(false);
  const [updateProgress, setUpdateProgress] = useState("Preparing and validating the update…");

  // v1.1.7: pre-upgrade render-busy warning. The render queue lives in RAM,
  // so restarting the app while it is working abandons queued and in-progress
  // documents. They will surface as interrupted-render entries on next launch
  // (see Settings > About > Interrupted or failed renders), but the source
  // file must be re-uploaded to actually view pages -- there is no resume.
  // Show a confirm dialog with the count so the user can choose to wait
  // instead of losing progress on a long batch.
  const [busyConfirm, setBusyConfirm] = useState<{ in_flight: number } | null>(null);

  const performLaunch = useCallback(async () => {
    setLaunch({ phase: "launching" });
    const result = await launchInAppUpdater();
    if (result.kind === "ok") {
      setUpdateProgress("Preparing and validating the update…");
      setLaunch({ phase: "launched", startedAt: Date.now() });
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

  const onUpdateNow = useCallback(async () => {
    // Best-effort busy probe. If it fails for any reason (endpoint absent on
    // an older backend, transport error, etc.) fall through to the launch --
    // the pre-existing behavior. Never let the check block an upgrade.
    try {
      const res = await fetch("/api/render/busy", { cache: "no-store" });
      if (res.ok) {
        const j = (await res.json()) as { busy?: boolean; in_flight?: number };
        if (j.busy) {
          setBusyConfirm({ in_flight: Number(j.in_flight ?? 0) || 0 });
          return;
        }
      }
    } catch {
      /* proceed */
    }
    void performLaunch();
  }, [performLaunch]);

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

  // v1.0.9: read the .updating sentinel state on mount so we can surface a
  // "previous update didn't complete" notice pointing users at update.log.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const attempt = await fetchLastAttempt();
      if (cancelled) return;
      setLastAttempt(attempt);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onDismissLastAttempt = useCallback(async () => {
    setDismissedAttempt(true);
    await clearLastAttempt();
    setLastAttempt((prev) => (prev ? { ...prev, present: false, stale: false } : prev));
  }, []);

  // v1.0.9: drop-a-zip local upgrade. Users can drag a downloaded release zip
  // onto the panel and skip the GitHub fetch entirely. Server validates the
  // zip layout, hands back a staged temp path, and the client confirms before
  // spawning updater.cjs against it.
  type LocalZipState =
    | { phase: "idle" }
    | { phase: "validating"; fileName: string }
    | {
        phase: "staged";
        fileName: string;
        version: string;
        installedVersion: string;
        tempPath: string;
        isDowngrade: boolean;
        isSameVersion: boolean;
        size: number;
      }
    | { phase: "launching" }
    | { phase: "launched"; startedAt: number }
    | { phase: "error"; message: string };

  const [localZip, setLocalZip] = useState<LocalZipState>({ phase: "idle" });
  const [isDragging, setIsDragging] = useState(false);
  const localZipInputRef = useRef<HTMLInputElement | null>(null);

  const uploadLocalZip = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".zip")) {
      setLocalZip({ phase: "error", message: "Please drop an AdvisePoint-Docs-vX.Y.Z.zip file." });
      return;
    }
    if (file.size > 150 * 1024 * 1024) {
      setLocalZip({ phase: "error", message: "That zip is larger than 150 MB. AdvisePoint Docs releases don't exceed that." });
      return;
    }
    setLocalZip({ phase: "validating", fileName: file.name });
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/update/upload-zip", { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLocalZip({
          phase: "error",
          message: (body?.message as string) || `Upload failed (HTTP ${res.status}).`,
        });
        return;
      }
      setLocalZip({
        phase: "staged",
        fileName: file.name,
        version: body.version,
        installedVersion: body.installed_version,
        tempPath: body.temp_path,
        isDowngrade: !!body.is_downgrade,
        isSameVersion: !!body.is_same_version,
        size: body.size,
      });
    } catch (err) {
      setLocalZip({
        phase: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  const onLocalZipDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (!file) return;
      void uploadLocalZip(file);
    },
    [uploadLocalZip],
  );

  const onLocalZipConfirm = useCallback(async () => {
    if (localZip.phase !== "staged") return;
    setLocalZip({ phase: "launching" });
    try {
      const res = await fetch("/api/updater/launch-local", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ temp_path: (localZip as { tempPath: string }).tempPath }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setLocalZip({
          phase: "error",
          message: (body?.message as string) || `Launch failed (HTTP ${res.status}).`,
        });
        return;
      }
      setUpdateProgress("Preparing and validating the update…");
      setLocalZip({ phase: "launched", startedAt: Date.now() });
    } catch (err) {
      setLocalZip({
        phase: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [localZip]);

  // The server intentionally remains alive throughout download/preflight.
  // Poll real updater status instead of treating a live server as a failure.
  useEffect(() => {
    const active = launch.phase === "launched" ? launch : localZip.phase === "launched" ? localZip : null;
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const res = await fetch("/api/updater/status", { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          if (cancelled) return;
          if (data.startedAt >= active.startedAt - 5000) {
            setUpdateProgress(data.message || "Update in progress…");
            if (data.phase === "failed") {
              if (launch.phase === "launched") setLaunch({ phase: "failed", kind: "error", message: data.message });
              else setLocalZip({ phase: "error", message: data.message });
              return;
            }
            if (data.phase === "complete") {
              setLaunch({ phase: "idle" });
              setLocalZip({ phase: "idle" });
              setStatus("idle");
              return;
            }
          } else if (Date.now() - active.startedAt > 60000) {
            // No updater status is different from a slow but active download.
            const message = "No update progress was received. Check the updater log before trying again; do not extract files over a running installation.";
            if (launch.phase === "launched") setLaunch({ phase: "failed", kind: "error", message });
            else setLocalZip({ phase: "error", message });
            return;
          }
        }
      } catch {
        if (!cancelled) setUpdateProgress("The application is restarting. Waiting for it to reconnect…");
      }
      if (!cancelled) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [launch, localZip]);

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
        {/* v1.0.9: previous-update-attempt diagnostic. Shown only when the
            .updating sentinel is present, older than 5 min, and younger than
            24 h. */}
        {lastAttempt?.stale && !dismissedAttempt && (
          <div
            className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200"
            data-testid="status-last-attempt-stale"
          >
            <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="font-medium">A previous update attempt didn&apos;t complete.</div>
              <div className="mt-0.5 opacity-90">
                See{" "}
                <span className="font-mono text-[11px]">
                  %LOCALAPPDATA%\AdvisePoint Docs\update.log
                </span>{" "}
                for details. You can try Update now again below.
              </div>
            </div>
            <button
              type="button"
              onClick={onDismissLastAttempt}
              className="shrink-0 self-center rounded border border-amber-500/40 px-3 py-1.5 text-xs font-medium hover:bg-amber-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/60"
              aria-label="Dismiss"
              data-testid="button-dismiss-last-attempt"
            >
              Dismiss
            </button>
          </div>
        )}

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
                    Update in progress…
                  </>
                ) : (
                  <>
                    <Download className="h-3 w-3" />Update now
                  </>
                )}
              </Button>
              <a
                href={release.htmlUrl}
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
                {updateProgress} The server stays available until package checks pass.
              </div>
            )}
            {launch.phase === "failed" && (
              <div
                className="pl-5 pt-1 text-[11px] text-destructive"
                data-testid="text-updater-launch-failed"
              >
                Update did not complete: {launch.message}
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
          <span className="min-w-0 break-words text-[11px] text-muted-foreground">
            Reads {" "}
            <a
              href="https://github.com/S8619G/AdvisePoint-Docs/releases/latest"
              target="_blank"
              rel="noopener noreferrer"
              className="break-all underline hover:text-foreground"
            >
              github.com/S8619G/AdvisePoint-Docs
            </a>
            . No account needed.
          </span>
        </div>

        {/* v1.0.9: drop-a-zip target. Lets users install a manually-downloaded
            release zip without going through GitHub. Same updater code path
            downstream. */}
        <div className="border-t border-border/60 pt-4">
          <div className="mb-2 text-xs font-medium">Install from a local zip</div>
          <p className="mb-2 text-[11px] text-muted-foreground">
            Use this when you already have the release zip and don&apos;t want the app to download it.
          </p>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={onLocalZipDrop}
            onClick={() => localZipInputRef.current?.click()}
            className={`cursor-pointer rounded-md border-2 border-dashed px-3 py-4 text-center text-xs transition-colors ${
              isDragging
                ? "border-primary bg-primary/10"
                : "border-border/60 bg-muted/20 hover:border-border"
            }`}
            data-testid="dropzone-local-zip"
          >
            <Upload className="mx-auto mb-1 h-4 w-4 text-muted-foreground" />
            <div className="text-foreground">
              Drop an <span className="font-mono">AdvisePoint-Docs-vX.Y.Z.zip</span> here to upgrade in place from a local file.
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">or click to browse</div>
            <input
              ref={localZipInputRef}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void uploadLocalZip(file);
                // Reset so selecting the same file again re-triggers.
                e.target.value = "";
              }}
              data-testid="input-local-zip"
            />
          </div>

          {localZip.phase === "validating" && (
            <div
              className="mt-2 flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-xs text-muted-foreground"
              data-testid="local-zip-validating"
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Validating <span className="font-mono text-[11px]">{localZip.fileName}</span>…
            </div>
          )}

          {localZip.phase === "staged" && (
            <div
              className={`mt-2 space-y-2 rounded-md border px-3 py-3 text-xs ${
                localZip.isDowngrade || localZip.isSameVersion
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200"
                  : "border-emerald-500/40 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200"
              }`}
              data-testid="local-zip-staged"
            >
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                <span className="font-medium">
                  Zip validated: v{localZip.version}
                </span>
                <span className="opacity-70">(installed v{localZip.installedVersion})</span>
              </div>
              {localZip.isSameVersion && (
                <div className="pl-5 opacity-90">
                  This is the same version you already have. The updater will refuse to install it.
                </div>
              )}
              {localZip.isDowngrade && (
                <div className="pl-5 opacity-90">
                  <AlertTriangle className="mr-1 inline h-3 w-3" />
                  This zip is older than your installed version. The updater will refuse to install it.
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2 pl-5 pt-1">
                <Button
                  size="sm"
                  onClick={onLocalZipConfirm}
                  disabled={localZip.isDowngrade || localZip.isSameVersion}
                  data-testid="button-confirm-local-zip"
                  className="h-7 gap-1"
                >
                  <Upload className="h-3 w-3" />Upgrade to v{localZip.version} now
                </Button>
                <button
                  type="button"
                  onClick={() => setLocalZip({ phase: "idle" })}
                  className="rounded px-2 py-1 text-[11px] hover:bg-black/10 dark:hover:bg-white/10"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {localZip.phase === "launching" && (
            <div
              className="mt-2 flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-xs text-muted-foreground"
              data-testid="local-zip-launching"
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Starting updater…
            </div>
          )}

          {localZip.phase === "launched" && (
            <div
              className="mt-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
              data-testid="local-zip-launched"
            >
              {updateProgress} The server stays available until package checks pass.
            </div>
          )}

          {localZip.phase === "error" && (
            <div
              className="mt-2 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              data-testid="local-zip-error"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div className="flex-1">{localZip.message}</div>
              <button
                type="button"
                onClick={() => setLocalZip({ phase: "idle" })}
                className="shrink-0 rounded p-1 hover:bg-destructive/20"
                aria-label="Dismiss"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}
        </div>
      </CardContent>

      {/* v1.1.7: pre-upgrade render-busy confirm dialog. Rendered inside the
          Card so the existing panel styling is unaffected. */}
      <AlertDialog open={busyConfirm !== null} onOpenChange={(open) => { if (!open) setBusyConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Renders are still running</AlertDialogTitle>
            <AlertDialogDescription>
              {busyConfirm && busyConfirm.in_flight > 0 ? (
                <>
                  {busyConfirm.in_flight === 1
                    ? "1 document is currently being processed for viewing."
                    : `${busyConfirm.in_flight} documents are currently being processed for viewing.`}{" "}
                  Restarting the app to install the update will interrupt them. Those documents will need to be re-uploaded afterward to view their pages.
                </>
              ) : (
                <>
                  The app is still processing documents for viewing. Restarting to install the update will interrupt them and they will need to be re-uploaded afterward to view their pages.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="btn-upgrade-busy-cancel">Wait for renders to finish</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                setBusyConfirm(null);
                void performLaunch();
              }}
              data-testid="btn-upgrade-busy-continue"
            >
              Update now anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
