import { useEffect, useRef, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { APP_VERSION } from "@/version";

// v1.0.10 - Stale-tab detection.
//
// When the in-app updater swaps to a new version, any previously-opened
// browser tabs are still running the OLD client bundle against the NEW
// server. The tab keeps working for the most part, but users end up
// wondering which tab is which and end up with two AdvisePoint Docs tabs
// after every update.
//
// The tab that loaded before the update sees APP_VERSION (its own compiled
// constant) fall behind the server's /api/health.version. That tab is
// stale and shows this banner. The freshly-loaded tab has matching
// versions and shows nothing.
//
// We cannot close the tab programmatically -- browsers only allow
// window.close() on windows opened by script. The banner tells the user
// exactly what to do and stays visible until they close the tab.

type HealthResponse = {
  version?: string;
};

export function StaleTabBanner() {
  const { data } = useQuery<HealthResponse>({
    queryKey: ["/api/health"],
    // v1.0.10: tightened polling. During the v1.0.9.23 soak a user closed
    // the old tab within ~60s of the update completing, so the banner never
    // polled /api/health again to notice the version mismatch. A 10s poll
    // plus a window-focus refetch plus gcTime: 0 (so a remount always
    // fetches fresh rather than replaying a cached response) guarantees the
    // mismatch is caught even for users who tab-switch and close quickly.
    staleTime: 10 * 1000,
    refetchInterval: 10 * 1000,
    refetchOnWindowFocus: true,
    gcTime: 0,
  });

  const [dismissed, setDismissed] = useState(false);

  // Track the FIRST server version this tab observed. If the server
  // reports a different version later, the tab is stale -- flip and
  // stay flipped regardless of what /api/health reports after.
  const firstServerVersionRef = useRef<string | null>(null);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const v = data?.version;
    if (!v) return;
    if (firstServerVersionRef.current === null) {
      firstServerVersionRef.current = v;
      return;
    }
    if (v !== APP_VERSION && v !== firstServerVersionRef.current) {
      setStale(true);
    }
  }, [data?.version]);

  // Also catch the case where this tab was already loaded with an older
  // client bundle than the server is currently reporting on the very
  // first health response. That happens when the user does a hard refresh
  // JUST AS the update swap completes.
  useEffect(() => {
    const serverV = data?.version;
    if (serverV && serverV !== APP_VERSION) {
      setStale(true);
    }
  }, [data?.version]);

  if (!stale || dismissed) return null;

  return (
    <div
      role="status"
      data-testid="banner-stale-tab"
      className="border-b border-blue-500/30 bg-blue-500/10 text-blue-900 dark:text-blue-200"
    >
      <div className="mx-auto flex max-w-[1400px] items-center gap-3 px-6 py-2 text-xs">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium">
          This tab is out of date
        </span>
        <span className="opacity-80">
          The app was updated to v{data?.version ?? "?"} while this tab was
          open (this tab is running v{APP_VERSION}). Close this tab and use
          the newer one -- or reload to catch up.
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => window.location.reload()}
            className="rounded px-2 py-1 hover:bg-blue-500/20 inline-flex items-center gap-1"
            data-testid="button-stale-tab-reload"
          >
            Reload
          </button>
          <button
            onClick={() => setDismissed(true)}
            className="rounded px-2 py-1 hover:bg-blue-500/20 inline-flex items-center gap-1"
            data-testid="button-stale-tab-dismiss"
            title="Dismiss for this session"
          >
            <X className="h-3 w-3" />Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
