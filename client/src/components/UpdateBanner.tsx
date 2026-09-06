import { useEffect, useState } from "react";
import { Download, ExternalLink, X } from "lucide-react";
import { UpdateCheck, type LatestRelease } from "@/lib/updateCheck";

// Small non-intrusive banner shown under the top nav when a newer release
// exists on GitHub. Auto-hides when the user skips or after they've dismissed
// via localStorage. Renders nothing when up to date, offline, or skipped.
export function UpdateBanner() {
  const [release, setRelease] = useState<LatestRelease | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      const latest = await UpdateCheck.getLatestRelease();
      if (cancelled) return;
      const skipped = UpdateCheck.getSkippedVersion();
      const showable = UpdateCheck.shouldShowBanner(UpdateCheck.installed, latest, skipped);
      setRelease(showable);
    }

    poll();
    // Poll again every 24h in case the app stays open for days
    const iv = window.setInterval(poll, 24 * 60 * 60 * 1000);
    return () => { cancelled = true; window.clearInterval(iv); };
  }, []);

  if (!release) return null;

  const onSkip = () => {
    UpdateCheck.skipVersion(release.tag);
    setRelease(null);
  };

  return (
    <div
      role="status"
      data-testid="banner-update-available"
      className="border-b border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200"
    >
      <div className="mx-auto flex max-w-[1400px] items-center gap-3 px-6 py-2 text-xs">
        <Download className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium">
          Update available: {release.name || release.tag}
        </span>
        <span className="opacity-70">
          You have v{UpdateCheck.installed}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <a
            href={release.htmlUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded px-2 py-1 hover:bg-amber-500/20 inline-flex items-center gap-1"
            data-testid="link-update-notes"
          >
            <ExternalLink className="h-3 w-3" />What's new
          </a>
          <a
            href={release.zipUrl || release.htmlUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded bg-amber-500/20 px-2 py-1 font-medium hover:bg-amber-500/30 inline-flex items-center gap-1"
            data-testid="link-update-download"
          >
            <Download className="h-3 w-3" />Download
          </a>
          <button
            onClick={onSkip}
            className="rounded px-2 py-1 hover:bg-amber-500/20 inline-flex items-center gap-1"
            data-testid="button-update-skip"
            title="Don't remind me about this version"
          >
            <X className="h-3 w-3" />Skip this version
          </button>
        </div>
      </div>
    </div>
  );
}
