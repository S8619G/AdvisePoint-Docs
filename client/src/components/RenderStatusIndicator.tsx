// v1.0.4 - Header render-status indicator.
//
// Visible states:
//   1. idle, no recent failures: nothing rendered (zero footprint)
//   2. active (rendering): muted animated spinner, hover shows current
//      doc title + page N of M + queue depth
//   3. clean completion: brief 2-second fade-out then disappears
//   4. failure state: red AlertCircle glyph, stays visible until the user
//      clicks it to dismiss. Hover lists every failed document by title
//      with its specific failure reason.
//
// Polling: 2 s while active or failures unacknowledged, 10 s while idle.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, AlertCircle } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface RenderStatusResponse {
  active: boolean;
  current_document: {
    id: string;
    title: string;
    file_name: string;
    pages_done: number;
    pages_total: number;
  } | null;
  queue_depth: number;
  recent_failures: Array<{
    document_id: string;
    title: string;
    file_name: string;
    error: string;
    failed_at: string;
    first_failed_page: number | null;
  }>;
}

export function RenderStatusIndicator() {
  // Track which failed docs the user has dismissed. Keyed by document_id
  // + failed_at timestamp so a re-upload that fails again re-alerts.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  // Fade-out timer for the clean-completion transition. When `active`
  // flips true -> false with no failures, keep the spinner visible for
  // 2 more seconds then hide.
  const [showAfterIdle, setShowAfterIdle] = useState(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Long-poll cadence: 2 s while active, 10 s while idle. useQuery's
  // refetchInterval accepts a function that receives the last data.
  const { data } = useQuery<RenderStatusResponse>({
    queryKey: ["/api/render/status"],
    refetchInterval: (query) => {
      const d = query.state.data as RenderStatusResponse | undefined;
      if (d?.active) return 2000;
      // Poll faster while there are unacknowledged failures too, so the
      // list stays fresh if another doc fails while the user is looking.
      const hasLiveFailures = (d?.recent_failures ?? []).some(
        (f) => !dismissed.has(`${f.document_id}:${f.failed_at}`),
      );
      if (hasLiveFailures) return 2000;
      return 10000;
    },
  });

  // Drive the 2-second post-completion visibility. Only when transitioning
  // active=true -> active=false.
  useEffect(() => {
    if (!data) return;
    if (data.active) {
      // Reset any pending fade if a new render kicks off.
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      setShowAfterIdle(true);
    } else if (showAfterIdle) {
      // Was active, now idle - schedule the hide.
      idleTimerRef.current = setTimeout(() => {
        setShowAfterIdle(false);
        idleTimerRef.current = null;
      }, 2000);
    }
    return () => {
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    };
  }, [data?.active]); // eslint-disable-line react-hooks/exhaustive-deps

  // Which failures are still surfaced (not dismissed by the user)?
  const liveFailures = useMemo(() => {
    if (!data) return [];
    return data.recent_failures.filter(
      (f) => !dismissed.has(`${f.document_id}:${f.failed_at}`),
    );
  }, [data, dismissed]);

  // Visibility contract:
  //   - Failures pending: always show (red glyph) - hard requirement, users
  //     must know which document failed.
  //   - Actively rendering: show (spinner).
  //   - Just finished rendering: show for 2 s (fade window).
  //   - Otherwise: hide entirely.
  const hasFailures = liveFailures.length > 0;
  const isActive = data?.active ?? false;
  const visible = hasFailures || isActive || showAfterIdle;

  if (!visible) return null;

  // Failure state trumps active state visually - if any docs failed while
  // the queue is still working, the user needs to see the red glyph.
  if (hasFailures) {
    const failCount = liveFailures.length;
    const label = failCount === 1 ? "1 render error" : `${failCount} render errors`;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-destructive hover:bg-destructive/10 focus:outline-none focus:ring-1 focus:ring-destructive/40"
            data-testid="btn-render-status-failure"
            aria-label={`${label}. Click to dismiss.`}
            onClick={() => {
              // Dismiss every currently-shown failure. New failures that
              // appear after this click will re-trigger the alert.
              setDismissed((prev) => {
                const next = new Set(prev);
                for (const f of liveFailures) {
                  next.add(`${f.document_id}:${f.failed_at}`);
                }
                return next;
              });
            }}
          >
            <AlertCircle className="h-4 w-4" />
            <span className="font-mono text-[10px] uppercase tracking-wider">
              {failCount}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm" side="bottom" align="end">
          <div className="mb-1 font-medium text-destructive">
            Render errors ({failCount})
          </div>
          <ul className="space-y-1 text-xs">
            {liveFailures.slice(0, 6).map((f) => (
              <li key={`${f.document_id}:${f.failed_at}`} className="leading-snug">
                <div className="font-medium">{f.title}</div>
                <div className="text-muted-foreground">
                  {f.first_failed_page
                    ? `Page ${f.first_failed_page}: ${f.error}`
                    : f.error}
                </div>
              </li>
            ))}
            {liveFailures.length > 6 && (
              <li className="text-muted-foreground">
                ... and {liveFailures.length - 6} more
              </li>
            )}
          </ul>
          <div className="mt-2 border-t border-border/50 pt-1 text-[10px] text-muted-foreground">
            Click to dismiss. Open Library for full detail.
          </div>
        </TooltipContent>
      </Tooltip>
    );
  }

  // Active or fade-window state - muted spinner.
  const cur = data?.current_document;
  const queued = data?.queue_depth ?? 0;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex items-center gap-1 text-muted-foreground"
          data-testid="indicator-render-status-active"
          aria-label="Rendering pages"
        >
          <Loader2 className="h-4 w-4 animate-spin" />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs" side="bottom" align="end">
        <div className="text-xs">
          <div className="mb-1 font-medium">Rendering pages</div>
          {cur ? (
            <>
              <div className="text-muted-foreground">Document: {cur.title}</div>
              {cur.pages_total > 0 && (
                <div className="text-muted-foreground">
                  Page {cur.pages_done} of {cur.pages_total}
                </div>
              )}
            </>
          ) : (
            <div className="text-muted-foreground">Preparing render...</div>
          )}
          {queued > 0 && (
            <div className="mt-1 text-muted-foreground">
              {queued} document{queued === 1 ? "" : "s"} queued
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
