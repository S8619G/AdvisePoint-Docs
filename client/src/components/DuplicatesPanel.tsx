import { useCallback, useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import { Loader2, ShieldAlert, Copy } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { setBusy } from "@/lib/queryClient";
import {
  buildDeleteRequest,
  effectiveKeeper,
  isActionable,
  isOverridden,
  removalCount,
  rowsForDisplay,
} from "@/lib/duplicate-keeper";

// v1.0.12.2 -- Find duplicate documents. Self-detecting: the panel renders
// NOTHING unless the library actually contains duplicates, so a clean library
// shows no dead control. It checks once on mount and re-checks after a
// deletion, hiding itself as soon as the last duplicate is gone.
//
// v1.0.12.1 -- Find duplicate documents.
//
// This control shipped inside BackupPanel in v1.0.11.4, which put it under
// the "Backup & Restore" heading -- visually it read as a backup feature and
// sat below the library scan results it actually relates to. It now lives in
// its own component so the Settings page can place it at the top of the
// duplicate list, above the scan results, without dragging the backup
// columns along with it.
//
// v1.1.5 -- the kept copy is now a choice, not a verdict. The server still
// nominates the most complete copy, but every group shows which copy that is
// and lets a person pick a different one before anything moves. Re-uploading
// a corrected file used to mean the older row won on the date tiebreak with
// no way to say otherwise. Selection logic lives in lib/duplicate-keeper.ts.
//
// v1.0.12.3 -- the rules this panel describes changed, so its wording did
// too. Two documents now count as duplicates only when their recorded file
// hashes are identical, and the copy that is KEPT is the most complete one
// (rendered pages, then a retained original), not simply the oldest. Removal
// moves a document to a quarantine folder rather than deleting it.

type DuplicateGroup = {
  group_key: string;
  file_name: string;
  size_bytes: number;
  size_source: "bytes";
  keep: string;
  delete: string[];
  safe_to_delete: boolean;
  blocked_reason: string | null;
  docs: Array<{
    id: string;
    title: string;
    ingested_at: string;
    has_pages: boolean;
    has_original: boolean;
    chunks: number;
    viewable: boolean;
  }>;
};

// Copied verbatim from BackupPanel so the sizes shown in the duplicate
// groups are formatted exactly as they were before this move.
function formatBytes(n: number | null | undefined): string {
  if (n == null || !isFinite(n) || n < 0) return "unknown";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

export function DuplicatesPanel() {
  const { toast } = useToast();
  const [dupScanRunning, setDupScanRunning] = useState(false);
  const [dupGroups, setDupGroups] = useState<DuplicateGroup[] | null>(null);
  const [dupTotal, setDupTotal] = useState(0);
  const [dupPreviewOpen, setDupPreviewOpen] = useState(false);
  const [dupConfirmAllOpen, setDupConfirmAllOpen] = useState(false);
  const [dupDeleting, setDupDeleting] = useState(false);

  // v1.0.12.2: silent detection. Distinct from runDupScan below, which is
  // user-initiated and therefore reports failures with a toast. This runs
  // unprompted on mount, so a failure must stay quiet -- an unreachable
  // endpoint should leave the panel hidden, exactly as a clean library does,
  // rather than firing an error toast the user did not ask for.
  const detectDuplicates = useCallback(async () => {
    try {
      const r = await fetch("/api/documents/duplicates");
      const j = await r.json();
      if (!j?.ok) return;
      setDupGroups((j.groups ?? []) as DuplicateGroup[]);
      setDupTotal(j.total_duplicates ?? 0);
    } catch {
      // Stay hidden; see note above.
    }
  }, []);

  useEffect(() => {
    void detectDuplicates();
  }, [detectDuplicates]);

  // `reviewKeeper` maps a group to the copy the person chose to keep, and
  // `reviewConfirmed` records an explicit confirmation.
  //
  // v1.1.5: the keeper choice now applies to EVERY group. The confirmation
  // is still required for groups the app could not verify -- there it is the
  // only thing standing behind the removal -- but a provably safe group does
  // not need it, and demanding it there is pure friction.
  const [reviewKeeper, setReviewKeeper] = useState<Record<string, string>>({});
  const [reviewConfirmed, setReviewConfirmed] = useState<Record<string, boolean>>({});

  const runDupScan = useCallback(async (): Promise<DuplicateGroup[] | null> => {
    setDupScanRunning(true);
    try {
      const r = await fetch("/api/documents/duplicates");
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || "Scan failed");
      const groups = (j.groups ?? []) as DuplicateGroup[];
      setDupGroups(groups);
      setDupTotal(j.total_duplicates ?? 0);
      return groups;
    } catch (err) {
      toast({
        title: "Couldn't scan for duplicates",
        description: err instanceof Error ? err.message : "Try again in a moment.",
        variant: "destructive",
      });
      return null;
    } finally {
      setDupScanRunning(false);
    }
  }, [toast]);

  const onFindDuplicatesPreview = useCallback(async () => {
    const groups = await runDupScan();
    if (!groups) return;
    if (groups.length === 0) {
      toast({
        title: "No duplicates found",
        description: "No two documents in the library have identical file hashes.",
      });
      return;
    }
    setDupPreviewOpen(true);
  }, [runDupScan, toast]);

  const onFindDuplicatesDeleteAll = useCallback(async () => {
    const groups = await runDupScan();
    if (!groups) return;
    if (groups.length === 0) {
      toast({
        title: "No duplicates found",
        description: "No two documents in the library have identical file hashes.",
      });
      return;
    }
    setDupConfirmAllOpen(true);
  }, [runDupScan, toast]);

  const performDupDelete = useCallback(async (
    idsToDelete: string[],
    manualReview: Array<{ group_key: string; keep: string; remove: string[]; confirmed: true }> = [],
  ) => {
    setDupDeleting(true);
    setBusy(true);
    try {
      const r = await fetch("/api/documents/duplicates/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: idsToDelete, manual_review: manualReview }),
      });
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || "Delete failed");
      const removed = j.deleted ?? 0;
      const refusedCount = Array.isArray(j.refused) ? j.refused.length : 0;
      toast({
        title: removed > 0 ? "Duplicates moved to quarantine" : "Nothing was removed",
        description:
          (removed > 0
            ? `${removed} duplicate document(s) moved to the quarantine folder, where they can be recovered.`
            : "No document met the safety checks for removal.") +
          (refusedCount > 0 ? ` ${refusedCount} skipped for safety.` : ""),
        variant: removed > 0 ? undefined : "destructive",
      });
      setDupPreviewOpen(false);
      setDupConfirmAllOpen(false);
      setReviewKeeper({});
      setReviewConfirmed({});
      // v1.0.12.2: re-detect instead of blanking. If that was the last
      // duplicate the panel disappears on its own; if duplicates remain
      // (a partial failure), it stays and shows the real remaining count.
      await detectDuplicates();
    } catch (err) {
      toast({
        title: "Couldn't delete duplicates",
        description: err instanceof Error ? err.message : "Try again in a moment.",
        variant: "destructive",
      });
    } finally {
      setDupDeleting(false);
      setBusy(false);
    }
  }, [toast, detectDuplicates]);

  // v1.0.12.2: nothing to address -> render nothing at all. Kept after the
  // hooks above so hook order stays stable across renders.
  const groups = dupGroups ?? [];
  // v1.1.5: the headline count must track the current selection, not the
  // server's original tally. Overriding a keeper or confirming a blocked
  // group changes how many copies will actually move.
  const pendingRemovals = removalCount(groups, reviewKeeper, reviewConfirmed);
  const blockedGroups = groups.filter((g) => !g.safe_to_delete);
  const hasDuplicates = groups.length > 0;
  if (!hasDuplicates && !dupDeleting) return null;
  const removable = dupTotal;

  return (
    <div className="space-y-4">
      <Card data-testid="backup-duplicates">
        <CardContent className="pt-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-2">
              <Copy className="h-4 w-4 mt-0.5 text-muted-foreground" />
              <div>
                <div className="text-sm font-medium" data-testid="duplicates-headline">
                  {removable === 1 ? "1 duplicate document found" : `${removable} duplicate documents found`}
                </div>
                <div className="text-xs text-muted-foreground">
                  {groups.length === 1 ? "1 group of documents" : `${groups.length} groups of documents`} have identical file
                  hashes. The most complete copy is kept; the rest are moved to a quarantine folder so they can be recovered.
                </div>
                {blockedGroups.length > 0 ? (
                  <div className="text-xs text-amber-600 dark:text-amber-500 mt-1" data-testid="duplicates-blocked">
                    {blockedGroups.length === 1 ? "1 group is" : `${blockedGroups.length} groups are`} left alone: no copy in
                    them can be displayed, so removing any of them could leave nothing viewable.
                  </div>
                ) : null}
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onFindDuplicatesPreview}
                disabled={dupScanRunning || dupDeleting}
                data-testid="btn-duplicates-preview"
              >
                {dupScanRunning ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Preview and confirm
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={onFindDuplicatesDeleteAll}
                disabled={dupScanRunning || dupDeleting}
                data-testid="btn-duplicates-delete-all"
              >
                {dupScanRunning ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Delete all duplicates
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* v1.0.11.4: Duplicate preview + confirm modal */}
      <AlertDialog open={dupPreviewOpen} onOpenChange={(open) => { if (!dupDeleting) setDupPreviewOpen(open); }}>
        <AlertDialogContent className="max-w-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Copy className="h-5 w-5" /> Duplicate documents found
            </AlertDialogTitle>
            <AlertDialogDescription>
              {dupGroups && dupGroups.length > 0
                ? `${dupGroups.length} group(s), ${pendingRemovals} duplicate document(s) will be moved to quarantine. A copy is suggested in each group -- select a different one if you want to keep that record instead.`
                : "No duplicates."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/* v1.0.12: actions live at the top of the results dialog so the
              review and delete controls are visible without scrolling past
              the group list. */}
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end" data-testid="duplicates-preview-actions">
            <AlertDialogCancel disabled={dupDeleting} className="mt-0">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                // v1.1.5: routed through buildDeleteRequest so a group whose
                // keeper was changed travels by manual_review instead of the
                // automatic ids channel. Sending it on both would make the
                // server reject the second copy as already queued.
                const req = buildDeleteRequest(dupGroups ?? [], reviewKeeper, reviewConfirmed);
                void performDupDelete(req.ids, req.manual_review);
              }}
              disabled={dupDeleting || pendingRemovals === 0}
              data-testid="btn-duplicates-preview-delete"
            >
              {dupDeleting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Move {pendingRemovals} duplicate document{pendingRemovals === 1 ? "" : "s"} to quarantine
            </AlertDialogAction>
          </div>
          <div className="max-h-80 overflow-y-auto border rounded-md divide-y text-sm">
            {(dupGroups ?? []).map((g) => (
              <div key={g.group_key} className="p-3 space-y-1">
                <div className="font-medium break-all">
                  {g.file_name}{" "}
                  <span className="text-muted-foreground font-normal">
                    ({g.size_bytes > 0 ? formatBytes(g.size_bytes) : "identical file hash"})
                  </span>
                </div>
                {!g.safe_to_delete ? (
                  <div className="text-xs text-amber-600 dark:text-amber-500">
                    Needs your review: {g.blocked_reason}
                  </div>
                ) : null}

                {/* v1.1.5: one picker for every group. Each row shows the
                    date and the metadata that actually differs between the
                    copies, because the bytes are identical by definition --
                    the group is formed from a matching file hash, so what is
                    really being chosen is which record to keep. */}
                <div
                  className="rounded-md border p-2 space-y-1"
                  data-testid={`duplicates-review-${g.group_key}`}
                >
                  <div className="text-xs text-muted-foreground">
                    These files are identical. Choose the copy whose details you want to keep --
                    the rest move to quarantine, where they can be recovered.
                  </div>
                  {rowsForDisplay(g, reviewKeeper, reviewConfirmed).map((d) => (
                    <label
                      key={d.id}
                      className="flex items-start gap-2 py-1 cursor-pointer"
                      data-testid={`duplicates-row-${d.id}`}
                    >
                      <input
                        type="radio"
                        className="mt-1 shrink-0"
                        name={`review-${g.group_key}`}
                        checked={effectiveKeeper(g, reviewKeeper) === d.id}
                        onChange={() => setReviewKeeper((m) => ({ ...m, [g.group_key]: d.id }))}
                        disabled={dupDeleting}
                        data-testid={`duplicates-review-keep-${d.id}`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          {d.action === "keep" ? (
                            <span className="text-xs font-semibold text-emerald-600 shrink-0">KEEP</span>
                          ) : d.action === "quarantine" ? (
                            <span className="text-xs font-semibold text-destructive shrink-0">QUARANTINE</span>
                          ) : (
                            <span className="text-xs font-semibold text-muted-foreground shrink-0">SKIP</span>
                          )}
                          <span className="truncate">{d.title || d.id}</span>
                          {d.is_newest ? (
                            <span className="text-xs font-medium text-sky-600 dark:text-sky-400 shrink-0">
                              newest
                            </span>
                          ) : null}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          Added {d.ingested_at}
                          {" \u00b7 "}
                          {d.has_pages ? "pages" : d.has_original ? "original only" : "not viewable"}
                          {" \u00b7 "}
                          {d.chunks} chunk{d.chunks === 1 ? "" : "s"}
                        </span>
                      </span>
                    </label>
                  ))}

                  {/* The confirmation stands in for the check the app could
                      not make. A provably safe group does not need it. */}
                  {!g.safe_to_delete ? (
                    <label className="flex items-start gap-2 text-xs pt-1">
                      <input
                        type="checkbox"
                        className="mt-0.5 shrink-0"
                        checked={reviewConfirmed[g.group_key] === true}
                        onChange={(e) =>
                          setReviewConfirmed((m) => ({ ...m, [g.group_key]: e.target.checked }))
                        }
                        disabled={dupDeleting || !reviewKeeper[g.group_key]}
                        data-testid={`duplicates-review-confirm-${g.group_key}`}
                      />
                      <span>
                        I opened these documents and confirm the copy selected above is the one to keep.
                      </span>
                    </label>
                  ) : null}

                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={dupDeleting || !isActionable(g, reviewKeeper, reviewConfirmed)}
                    onClick={() => {
                      const req = buildDeleteRequest(
                        dupGroups ?? [],
                        reviewKeeper,
                        reviewConfirmed,
                        g.group_key,
                      );
                      if (req.ids.length === 0 && req.manual_review.length === 0) return;
                      void performDupDelete(req.ids, req.manual_review);
                    }}
                    data-testid={`duplicates-review-submit-${g.group_key}`}
                  >
                    {dupDeleting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                    Move the other copies to quarantine
                  </Button>
                  {isOverridden(g, reviewKeeper) ? (
                    <div className="text-xs text-muted-foreground">
                      Keeping a copy other than the one suggested.
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </AlertDialogContent>
      </AlertDialog>

      {/* v1.0.11.4: Delete-all-duplicates single confirm */}
      <AlertDialog open={dupConfirmAllOpen} onOpenChange={(open) => { if (!dupDeleting) setDupConfirmAllOpen(open); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-destructive" /> Move all duplicates to quarantine?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRemovals} duplicate document(s) will be moved to the quarantine folder next to the database, across {(dupGroups ?? []).length} group(s) of documents with identical file hashes. The copy selected in each group is kept, and it is re-checked as viewable before anything in that group is touched. Nothing is erased, so this can be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={dupDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                // Same routing as the preview, so a selection made there
                // is still honoured if this shortcut is used afterwards.
                const req = buildDeleteRequest(dupGroups ?? [], reviewKeeper, reviewConfirmed);
                void performDupDelete(req.ids, req.manual_review);
              }}
              disabled={dupDeleting}
            >
              {dupDeleting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Move {pendingRemovals} document{pendingRemovals === 1 ? "" : "s"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default DuplicatesPanel;
