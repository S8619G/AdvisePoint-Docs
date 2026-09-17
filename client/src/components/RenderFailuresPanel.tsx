// v1.1.7 -- Interrupted / failed render listing on the Settings > About tab.
//
// Two failure kinds land here, both surfaced by the existing
// /api/render/status endpoint's `recent_failures` list (server/routes.ts).
// The two are distinguished by the error string's `interrupted:` prefix,
// which is written by the boot reconciler in server/pages.ts when a document
// was left mid-render by a shutdown, upgrade, or crash. Other error strings
// come from the renderer itself.
//
// The remedy is the same for both: re-upload the source file. The remove
// action here is not destructive -- it calls the existing quarantining
// DELETE /api/documents/:id, which stages the doc into <dataDir>/deleted/
// and only then unlinks. Restore is still possible from RecoveryPanel.
// This keeps the "destructive operations preserve existing data" rule.

import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { AlertCircle, Loader2, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type Failure = {
  document_id: string;
  title: string;
  file_name: string;
  error: string;
  failed_at: string;
  first_failed_page: number | null;
};

type RenderStatusResponse = {
  active: boolean;
  current_document: unknown;
  queue_depth: number;
  recent_failures: Failure[];
};

// The reconciler writes error strings starting with this prefix; anything
// else is a renderer failure. The prefix is user-visible only through the
// wording branch below; the raw prefix itself is stripped in the UI.
const INTERRUPTED_PREFIX = "interrupted:";

function classify(err: string): "interrupted" | "failed" {
  return err.startsWith(INTERRUPTED_PREFIX) ? "interrupted" : "failed";
}

function humanError(err: string): string {
  if (err.startsWith(INTERRUPTED_PREFIX)) {
    return err.slice(INTERRUPTED_PREFIX.length).trim();
  }
  return err;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

export function RenderFailuresPanel() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [confirmTarget, setConfirmTarget] = useState<Failure | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  // Reuse the existing endpoint the header indicator already polls, so a
  // second query doesn't cost an extra server round-trip when both are
  // mounted -- react-query dedupes by queryKey.
  const { data, isLoading, refetch } = useQuery<RenderStatusResponse>({
    queryKey: ["/api/render/status"],
    refetchInterval: 10000,
  });

  const failures = useMemo(() => data?.recent_failures ?? [], [data]);
  const interruptedCount = failures.filter((f) => classify(f.error) === "interrupted").length;
  const failedCount = failures.length - interruptedCount;

  const onRemove = useCallback(async (f: Failure) => {
    setRemovingId(f.document_id);
    try {
      // The existing DELETE /api/documents/:id already quarantines instead of
      // hard-deleting (see server/routes.ts and the v1.0.12.3 note there).
      // Do NOT add a hard-unlink path here.
      const res = await fetch(`/api/documents/${encodeURIComponent(f.document_id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          const j = await res.json();
          if (typeof j?.message === "string") msg = j.message;
        } catch {
          /* non-json body is fine */
        }
        throw new Error(msg);
      }
      toast({
        title: "Document removed",
        description: `${f.file_name} was moved into the recoverable removals area.`,
      });
      // Refresh both the render status (drops the failure row) and any
      // document lists that other panels may be showing.
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["/api/render/status"] }),
        qc.invalidateQueries({ queryKey: ["/api/documents"] }),
        qc.invalidateQueries({ queryKey: ["/api/documents/removed"] }),
      ]);
    } catch (err) {
      toast({
        title: "Couldn't remove that document",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setRemovingId(null);
      setConfirmTarget(null);
    }
  }, [qc, toast]);

  // Do not render the card at all when there are no failures -- the About
  // tab already has a lot going on. This keeps rare controls out of the
  // main workflow (user preference).
  if (!isLoading && failures.length === 0) {
    return null;
  }

  return (
    <Card data-testid="card-render-failures">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertCircle className="h-5 w-5 text-destructive" />
          Interrupted or failed renders
        </CardTitle>
        <CardDescription>
          {interruptedCount > 0 && failedCount > 0 && (
            <>
              {interruptedCount} document{interruptedCount === 1 ? "" : "s"} interrupted before rendering finished, and{" "}
              {failedCount} that failed while rendering. Re-upload the source file to view its pages.
            </>
          )}
          {interruptedCount > 0 && failedCount === 0 && (
            <>
              {interruptedCount === 1
                ? "One document was interrupted before rendering finished."
                : `${interruptedCount} documents were interrupted before rendering finished.`}{" "}
              This usually means the app was closed, upgraded, or lost power mid-render. Re-upload the source file to view its pages.
            </>
          )}
          {interruptedCount === 0 && failedCount > 0 && (
            <>
              {failedCount === 1
                ? "One document failed while rendering."
                : `${failedCount} documents failed while rendering.`}{" "}
              Re-upload the source file to try again.
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <ul className="space-y-2">
          {failures.map((f) => {
            const kind = classify(f.error);
            return (
              <li
                key={`${f.document_id}:${f.failed_at}`}
                className="flex items-start justify-between gap-3 rounded-md border border-border p-3"
                data-testid={`row-render-failure-${f.document_id}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium" title={f.file_name}>
                      {f.file_name}
                    </span>
                    <Badge
                      variant={kind === "interrupted" ? "secondary" : "destructive"}
                      data-testid={`badge-render-failure-kind-${f.document_id}`}
                    >
                      {kind === "interrupted" ? "Interrupted" : "Failed"}
                    </Badge>
                  </div>
                  {f.title && f.title !== f.file_name && (
                    <div className="mt-0.5 text-xs text-muted-foreground truncate" title={f.title}>
                      {f.title}
                    </div>
                  )}
                  <div className="mt-1 text-xs text-muted-foreground">
                    {f.first_failed_page
                      ? `Page ${f.first_failed_page}: ${humanError(f.error)}`
                      : humanError(f.error)}
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground/80">
                    Recorded {formatDate(f.failed_at)}
                  </div>
                </div>
                <div className="shrink-0">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setConfirmTarget(f)}
                    disabled={removingId === f.document_id}
                    data-testid={`btn-render-failure-remove-${f.document_id}`}
                  >
                    {removingId === f.document_id ? (
                      <>
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" /> Removing…
                      </>
                    ) : (
                      <>
                        <Trash2 className="mr-1 h-3 w-3" /> Remove this document
                      </>
                    )}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="pt-1 text-[11px] text-muted-foreground">
          Removals are reversible. Documents move to the recoverable removals list on the Backup &amp; Restore area and can be restored from there.
        </div>
      </CardContent>

      <AlertDialog open={confirmTarget !== null} onOpenChange={(open) => { if (!open) setConfirmTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this document?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmTarget && (
                <>
                  <span className="font-medium">{confirmTarget.file_name}</span> will be moved into the recoverable removals area. Nothing is erased -- it can be restored from Recovery in Settings &gt; About.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removingId !== null}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (confirmTarget) void onRemove(confirmTarget);
              }}
              disabled={removingId !== null}
              data-testid="btn-render-failure-remove-confirm"
            >
              {removingId !== null ? "Removing…" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Manual refetch hook for tests -- invisible in production. */}
      <button
        type="button"
        onClick={() => void refetch()}
        className="sr-only"
        data-testid="btn-render-failures-refetch"
        aria-hidden="true"
        tabIndex={-1}
      >
        refresh
      </button>
    </Card>
  );
}
