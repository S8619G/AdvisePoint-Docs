import { useEffect, useState } from "react";
import { AlertTriangle, ExternalLink, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

// v1.0.5 — Non-intrusive banner shown under the top nav when the app is
// running from OneDrive / Dropbox / Google Drive / iCloud / Box / a UNC
// network path. Field report of a DOCX upload silently failing with
// browser "Failed to fetch" traced to a corporate OneDrive folder holding
// sync-time file locks and DLP rules. Warns once per install path.
//
// Dismissal persists in localStorage keyed by the masked path so the
// banner re-appears if the user later moves the app folder to a
// different problem location.

type InstallLocation = {
  ok: boolean;
  provider: string | null;
  masked_path: string;
};

type HealthResponse = {
  install_location?: InstallLocation;
};

function dismissKey(masked: string): string {
  return `installLocationDismissed:${masked}`;
}

export function InstallLocationBanner() {
  const { data } = useQuery<HealthResponse>({
    queryKey: ["/api/health"],
    // Health is polled by the BackendDownOverlay every 2 s; this component
    // is a passive reader against the same query cache. Set a longer
    // stale time so we don't inflate the network chatter -- the value
    // effectively never changes at runtime.
    staleTime: 60 * 1000,
    refetchInterval: 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const info = data?.install_location;
  const masked = info?.masked_path ?? "";
  const [dismissed, setDismissed] = useState<boolean>(false);

  // Re-read localStorage whenever the masked path changes -- the app can
  // legitimately migrate between paths across restarts.
  useEffect(() => {
    if (!masked) {
      setDismissed(false);
      return;
    }
    try {
      const v = window.localStorage.getItem(dismissKey(masked));
      setDismissed(v === "1");
    } catch {
      setDismissed(false);
    }
  }, [masked]);

  if (!info || info.ok || dismissed) return null;

  const onDismiss = () => {
    try {
      window.localStorage.setItem(dismissKey(masked), "1");
    } catch {
      // Private-browsing / storage-disabled: still hide for this session.
    }
    setDismissed(true);
  };

  // Link to the shipped README on GitHub so users can read the full
  // guidance without opening the local README.txt out-of-band.
  const learnMoreUrl =
    "https://github.com/S8619G/AdvisePoint-Docs#install-location--recommended-folder-setup";

  return (
    <div
      role="status"
      data-testid="banner-install-location"
      className="border-b border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200"
    >
      <div className="mx-auto flex max-w-[1400px] items-center gap-3 px-6 py-2 text-xs">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium">
          Running from a {info.provider} folder
        </span>
        <span className="opacity-80">
          Cloud-sync and network folders can silently block uploads and corrupt data. Move the app to a local root folder like <code className="font-mono">C:\AdvisePoint Docs\</code>.
        </span>
        <div className="ml-auto flex items-center gap-1">
          <a
            href={learnMoreUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded px-2 py-1 hover:bg-amber-500/20 inline-flex items-center gap-1"
            data-testid="link-install-location-learn"
          >
            <ExternalLink className="h-3 w-3" />Learn more
          </a>
          <button
            onClick={onDismiss}
            className="rounded px-2 py-1 hover:bg-amber-500/20 inline-flex items-center gap-1"
            data-testid="button-install-location-dismiss"
            title="Dismiss for this location"
          >
            <X className="h-3 w-3" />Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
