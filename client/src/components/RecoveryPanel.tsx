import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
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
import {
  Loader2,
  Undo2,
  Trash2,
  ArchiveRestore,
  HardDrive,
  ShieldAlert,
  RefreshCw,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// v1.0.13.0 -- Recovery panel.
//
// Two preserved-data holding areas were, until this build, only visible in
// File Explorer:
//
//   * Quarantined documents  -- <dataDir>/deleted/<ts>-<id>/  (both duplicate
//     removal and single-document DELETE write here since v1.0.12.3).
//   * Pre-restore snapshots  -- <parentOfDataDir>/<dataName>.bak-<ts>/  (the
//     wipe-and-replace path creates one before swapping the live data set).
//
// This panel lists both, restores one quarantined document at a time
// (server-side stage-verify-swap with id-collision refusal), and permanently
// deletes either kind on explicit per-item confirmation. Snapshot restore is
// deliberately NOT offered here -- swapping a whole data directory back in is
// safer done with the app closed.
//
// The optional auto-cleanup toggle sweeps ONLY quarantined DUPLICATES and
// only when the keeper is present, its SHA-256 still matches, and it is
// still viewable. Default off.

type RemovedItem = {
  folder: string;
  quarantined_at: string | null;
  reason: string | null;
  document_id: string | null;
  title: string | null;
  file_name: string | null;
  file_hash_sha256: string | null;
  chunk_count: number | null;
  pages_moved: boolean | null;
  original_moved: boolean | null;
  size_bytes: number;
  manifest_ok: boolean;
};

type RemovedListing = {
  root: string;
  total_bytes: number;
  items: RemovedItem[];
};

type SnapshotItem = {
  name: string;
  path: string;
  created_at: string;
  size_bytes: number;
};

type SnapshotListing = {
  parent: string;
  data_dir_name: string;
  total_bytes: number;
  items: SnapshotItem[];
};

function formatBytes(n: number | null | undefined): string {
  if (n == null || !isFinite(n) || n < 0) return "unknown";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "unknown time";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function RecoveryPanel() {
  const { toast } = useToast();
  // v1.0.14: react-query client for cache invalidation. The Library view
  // (client/src/pages/library.tsx) reads ["/api/documents"], the header/
  // sidebar counters read ["/api/stats"], and the Query page filters read
  // ["/api/facets"]. Any mutation here (restore, permanent delete, auto-
  // cleanup) can change the live document set, so we invalidate all three
  // after every successful action -- Library/Recovery/stats then refresh
  // on their own, no manual page reload.
  const qc = useQueryClient();
  const invalidateLibraryCaches = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["/api/documents"] });
    qc.invalidateQueries({ queryKey: ["/api/stats"] });
    qc.invalidateQueries({ queryKey: ["/api/facets"] });
  }, [qc]);
  const [removed, setRemoved] = useState<RemovedListing | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyFolder, setBusyFolder] = useState<string | null>(null);
  const [autoCleanup, setAutoCleanup] = useState<boolean>(false);
  const [autoLastRun, setAutoLastRun] = useState<string | null>(null);
  const [autoBusy, setAutoBusy] = useState(false);

  // Per-item confirmation state. Only one confirmation is open at a time.
  const [confirmDeleteRemoved, setConfirmDeleteRemoved] = useState<RemovedItem | null>(null);
  const [confirmDeleteSnapshot, setConfirmDeleteSnapshot] = useState<SnapshotItem | null>(null);

  // v1.2.0: card-header Delete All wipes every recently-removed document and
  // every snapshot in one confirmed action. Auto-cleanup settings are not
  // touched.
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [deleteAllBusy, setDeleteAllBusy] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [r1, r2, r3] = await Promise.all([
        fetch("/api/documents/removed"),
        fetch("/api/backups/snapshots"),
        fetch("/api/recovery/settings"),
      ]);
      const j1 = await r1.json();
      const j2 = await r2.json();
      const j3 = await r3.json();
      if (j1?.ok) setRemoved({ root: j1.root, total_bytes: j1.total_bytes, items: j1.items });
      if (j2?.ok) setSnapshots({
        parent: j2.parent,
        data_dir_name: j2.data_dir_name,
        total_bytes: j2.total_bytes,
        items: j2.items,
      });
      if (j3?.ok) {
        setAutoCleanup(!!j3.auto_cleanup_quarantined_dupes);
        setAutoLastRun(j3.last_run_at ?? null);
      }
    } catch {
      // Silent: the panel simply shows empty state.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadAll(); }, [loadAll]);

  // ---- Actions ----

  const restoreOne = useCallback(async (item: RemovedItem) => {
    setBusyFolder(item.folder);
    try {
      const r = await fetch(
        `/api/documents/removed/${encodeURIComponent(item.folder)}/restore`,
        { method: "POST" },
      );
      const j = await r.json();
      if (j?.ok) {
        toast({
          title: "Document restored",
          description:
            `${item.title ?? item.file_name ?? item.document_id ?? item.folder} is back in the library ` +
            `(${j.chunks_restored} excerpt(s), ${j.pages_restored} page image(s)` +
            `${j.original_restored ? ", original file restored" : ""}).`,
        });
      } else if (j?.code === "id_collision") {
        toast({
          variant: "destructive",
          title: "Cannot restore — id already in use",
          description:
            j.message ??
            "A live document with the same id is already present. The quarantine folder was not touched.",
        });
      } else {
        toast({
          variant: "destructive",
          title: "Restore did not complete",
          description: j?.message ?? "Nothing was left behind in the live library.",
        });
      }
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Restore failed",
        description: (err as Error).message || String(err),
      });
    } finally {
      setBusyFolder(null);
      void loadAll();
      invalidateLibraryCaches();
    }
  }, [toast, loadAll, invalidateLibraryCaches]);

  const permanentlyDeleteRemoved = useCallback(async (item: RemovedItem) => {
    setBusyFolder(item.folder);
    try {
      const r = await fetch(
        `/api/documents/removed/${encodeURIComponent(item.folder)}`,
        { method: "DELETE" },
      );
      const j = await r.json();
      if (j?.ok) {
        toast({
          title: "Removed permanently",
          description:
            `Freed ${formatBytes(j.bytes_freed)} from ` +
            `${item.title ?? item.file_name ?? item.document_id ?? item.folder}.`,
        });
      } else {
        toast({
          variant: "destructive",
          title: "Delete failed",
          description: j?.message ?? "The folder could not be removed.",
        });
      }
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Delete failed",
        description: (err as Error).message || String(err),
      });
    } finally {
      setBusyFolder(null);
      void loadAll();
      invalidateLibraryCaches();
    }
  }, [toast, loadAll, invalidateLibraryCaches]);

  const permanentlyDeleteSnapshot = useCallback(async (snap: SnapshotItem) => {
    setBusyFolder(snap.name);
    try {
      const r = await fetch(
        `/api/backups/snapshots/${encodeURIComponent(snap.name)}`,
        { method: "DELETE" },
      );
      const j = await r.json();
      if (j?.ok) {
        toast({
          title: "Snapshot deleted",
          description: `Freed ${formatBytes(j.bytes_freed)} from ${snap.name}.`,
        });
      } else {
        toast({
          variant: "destructive",
          title: "Delete failed",
          description: j?.message ?? "The snapshot could not be removed.",
        });
      }
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Delete failed",
        description: (err as Error).message || String(err),
      });
    } finally {
      setBusyFolder(null);
      void loadAll();
      // Snapshot delete doesn't touch the live library, but Library counters
      // and stats also show combined footprint, so invalidate for consistency.
      invalidateLibraryCaches();
    }
  }, [toast, loadAll, invalidateLibraryCaches]);

  // v1.2.0: batch permanent delete for the whole Recovery area. Uses the
  // existing per-item DELETE endpoints in sequence so no new server surface
  // is added for this pass; auto-cleanup configuration is deliberately
  // untouched (that section holds settings, not recoverable data). On the
  // first failure the loop stops, the panel refreshes, and a toast reports
  // the completed vs remaining counts -- silent partial success is refused.
  const deleteAllInRecovery = useCallback(async () => {
    setDeleteAllBusy(true);
    const removedTargets = removed?.items ?? [];
    const snapshotTargets = snapshots?.items ?? [];
    const totalPlanned = removedTargets.length + snapshotTargets.length;
    let removedDone = 0;
    let snapshotsDone = 0;
    let bytesFreed = 0;
    let failureMessage: string | null = null;
    try {
      for (const item of removedTargets) {
        const r = await fetch(
          `/api/documents/removed/${encodeURIComponent(item.folder)}`,
          { method: "DELETE" },
        );
        const j = await r.json();
        if (!j?.ok) {
          failureMessage = j?.message ?? "A preserved document could not be removed.";
          break;
        }
        removedDone += 1;
        bytesFreed += Number(j.bytes_freed) || 0;
      }
      if (!failureMessage) {
        for (const snap of snapshotTargets) {
          const r = await fetch(
            `/api/backups/snapshots/${encodeURIComponent(snap.name)}`,
            { method: "DELETE" },
          );
          const j = await r.json();
          if (!j?.ok) {
            failureMessage = j?.message ?? "A snapshot could not be removed.";
            break;
          }
          snapshotsDone += 1;
          bytesFreed += Number(j.bytes_freed) || 0;
        }
      }
    } catch (err) {
      failureMessage = (err as Error).message || String(err);
    } finally {
      setDeleteAllBusy(false);
      void loadAll();
      invalidateLibraryCaches();
    }
    const doneCount = removedDone + snapshotsDone;
    if (failureMessage) {
      toast({
        variant: "destructive",
        title: "Delete All stopped part-way through",
        description:
          `Removed ${doneCount} of ${totalPlanned} item(s) before the sweep was halted. ` +
          `${totalPlanned - doneCount} still in Recovery. ${failureMessage}`,
      });
    } else if (totalPlanned > 0) {
      toast({
        title: "Recovery cleared",
        description:
          `Removed ${removedDone} document(s) and ${snapshotsDone} snapshot(s) ` +
          `(freed ${formatBytes(bytesFreed)}). Auto-cleanup settings are unchanged.`,
      });
    }
  }, [removed, snapshots, toast, loadAll, invalidateLibraryCaches]);

  const toggleAutoCleanup = useCallback(async (next: boolean) => {
    setAutoCleanup(next); // optimistic
    try {
      const r = await fetch("/api/recovery/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auto_cleanup_quarantined_dupes: next }),
      });
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || "Server rejected the change");
      setAutoCleanup(!!j.auto_cleanup_quarantined_dupes);
      setAutoLastRun(j.last_run_at ?? null);
    } catch (err) {
      setAutoCleanup(!next);
      toast({
        variant: "destructive",
        title: "Could not save that setting",
        description: (err as Error).message || String(err),
      });
    }
  }, [toast]);

  const runAutoCleanupNow = useCallback(async () => {
    setAutoBusy(true);
    try {
      const r = await fetch("/api/documents/removed/auto-cleanup/run", { method: "POST" });
      const j = await r.json();
      if (j?.ok) {
        toast({
          title: "Auto-cleanup finished",
          description:
            `Scanned ${j.scanned} folder(s); removed ${j.removed}, kept ${j.skipped}. ` +
            `Freed ${formatBytes(j.bytes_freed)}.`,
        });
        setAutoLastRun(j.last_run_at ?? new Date().toISOString());
      } else {
        toast({
          variant: "destructive",
          title: "Auto-cleanup did not run",
          description: j?.message ?? "The sweep was refused.",
        });
      }
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Auto-cleanup failed",
        description: (err as Error).message || String(err),
      });
    } finally {
      setAutoBusy(false);
      void loadAll();
      invalidateLibraryCaches();
    }
  }, [toast, loadAll, invalidateLibraryCaches]);

  // ---- Render helpers ----

  const removedItems = removed?.items ?? [];
  const snapshotItems = snapshots?.items ?? [];
  // v1.2.0: Delete All is only meaningful when there is something to delete.
  const deleteAllTotal = removedItems.length + snapshotItems.length;
  const deleteAllEmpty = deleteAllTotal === 0;

  return (
    <Card data-testid="card-recovery">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <ArchiveRestore className="h-4 w-4" />
              Recovery
            </CardTitle>
            <CardDescription>
              Documents and data snapshots the app preserved instead of deleting. Restore what you
              need; permanently remove only what you're sure you don't.
            </CardDescription>
          </div>
          {/* v1.2.0: Refresh gains a visible border so it reads as an
              actionable control, and Delete All sits beside it as an
              outlined destructive-tone button that wipes every recently-
              removed document and every snapshot in one confirmed pass. */}
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void loadAll()}
              disabled={loading || deleteAllBusy}
              data-testid="button-recovery-refresh"
              aria-label="Refresh"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setConfirmDeleteAll(true)}
              disabled={deleteAllEmpty || deleteAllBusy || loading}
              className="border-destructive/60 text-destructive hover:bg-destructive/10 hover:text-destructive disabled:text-destructive/50"
              data-testid="button-recovery-delete-all"
            >
              {deleteAllBusy ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-1 h-4 w-4" />
              )}
              Delete All
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* ---- Recently removed ---- */}
        <section className="space-y-3" data-testid="section-recovery-removed">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">Recently removed documents</div>
            <div className="text-xs text-muted-foreground">
              {removedItems.length === 0
                ? "Nothing preserved."
                : `${removedItems.length} item(s), ${formatBytes(removed?.total_bytes)} on disk`}
            </div>
          </div>
          {removedItems.length === 0 ? (
            <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-6 text-center text-xs text-muted-foreground">
              Removed documents will appear here so you can put them back or delete them for good.
              Nothing is here right now.
            </div>
          ) : (
            <ul className="divide-y divide-border/60 rounded-md border border-border/60">
              {removedItems.map((item) => {
                const displayName =
                  item.title ?? item.file_name ?? item.document_id ?? item.folder;
                const rowBusy = busyFolder === item.folder;
                return (
                  <li key={item.folder} className="flex items-start gap-3 px-3 py-2" data-testid={`row-removed-${item.folder}`}>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <div className="truncate text-sm font-medium" title={displayName}>
                          {displayName}
                        </div>
                        {!item.manifest_ok && (
                          <Badge variant="destructive" className="gap-1">
                            <ShieldAlert className="h-3 w-3" /> manifest unusable
                          </Badge>
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                        <span>Removed {formatWhen(item.quarantined_at)}</span>
                        <span>{formatBytes(item.size_bytes)}</span>
                        {typeof item.chunk_count === "number" && (
                          <span>{item.chunk_count} excerpt(s)</span>
                        )}
                        <span>
                          pages: {item.pages_moved ? "kept" : "no"}
                          {" · "}
                          original: {item.original_moved ? "kept" : "no"}
                        </span>
                      </div>
                      {item.reason && (
                        <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={item.reason}>
                          Reason: {item.reason}
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void restoreOne(item)}
                        disabled={rowBusy || !item.manifest_ok}
                        data-testid={`button-restore-${item.folder}`}
                      >
                        {rowBusy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Undo2 className="mr-1 h-3.5 w-3.5" />}
                        Restore
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfirmDeleteRemoved(item)}
                        disabled={rowBusy}
                        className="text-destructive hover:text-destructive"
                        data-testid={`button-delete-${item.folder}`}
                      >
                        <Trash2 className="mr-1 h-3.5 w-3.5" />
                        Delete
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <Separator />

        {/* ---- Auto-cleanup ---- */}
        <section className="space-y-3" data-testid="section-recovery-auto-cleanup">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium">Automatic cleanup of duplicate removals</div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                When on, quarantined DUPLICATES are permanently removed on a periodic sweep — only if the
                kept copy is still in the library, its recorded SHA-256 still matches, and it is still
                viewable. Single-document deletes are never touched. Default: off.
              </div>
              {autoLastRun && (
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  Last run: {formatWhen(autoLastRun)}
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <Switch
                checked={autoCleanup}
                onCheckedChange={(v) => void toggleAutoCleanup(!!v)}
                aria-label="Enable automatic cleanup of duplicate removals"
                data-testid="switch-auto-cleanup"
              />
            </div>
          </div>
          {autoCleanup && (
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void runAutoCleanupNow()}
                disabled={autoBusy}
                data-testid="button-auto-cleanup-run-now"
              >
                {autoBusy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                Run cleanup now
              </Button>
            </div>
          )}
        </section>

        <Separator />

        {/* ---- Pre-restore snapshots ---- */}
        <section className="space-y-3" data-testid="section-recovery-snapshots">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium flex items-center gap-2">
              <HardDrive className="h-4 w-4" />
              Pre-restore snapshots
            </div>
            <div className="text-xs text-muted-foreground">
              {snapshotItems.length === 0
                ? "None on disk."
                : `${snapshotItems.length} snapshot(s), ${formatBytes(snapshots?.total_bytes)}`}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Created automatically before a wipe-and-replace restore so the previous data directory can be
            recovered if the new one turns out to be wrong. Swapping one back in is safer with the app
            closed; this panel only lists and deletes.
          </p>
          {snapshotItems.length === 0 ? (
            <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
              No pre-restore snapshots.
            </div>
          ) : (
            <ul className="divide-y divide-border/60 rounded-md border border-border/60">
              {snapshotItems.map((snap) => {
                const rowBusy = busyFolder === snap.name;
                return (
                  <li key={snap.name} className="flex items-start gap-3 px-3 py-2" data-testid={`row-snapshot-${snap.name}`}>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-xs" title={snap.path}>
                        {snap.name}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[11px] text-muted-foreground">
                        <span>Created {formatWhen(snap.created_at)}</span>
                        <span>{formatBytes(snap.size_bytes)}</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfirmDeleteSnapshot(snap)}
                        disabled={rowBusy}
                        className="text-destructive hover:text-destructive"
                        data-testid={`button-delete-snapshot-${snap.name}`}
                      >
                        <Trash2 className="mr-1 h-3.5 w-3.5" />
                        Delete
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </CardContent>

      {/* ---- Confirmation: permanently delete a quarantined document ---- */}
      <AlertDialog
        open={confirmDeleteRemoved !== null}
        onOpenChange={(open) => { if (!open) setConfirmDeleteRemoved(null); }}
      >
        <AlertDialogContent data-testid="dialog-confirm-delete-removed">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this preserved copy for good?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  This is the one irreversible action in the app. The document, its excerpts, page
                  images, and any retained original will be removed from disk. The live library is not
                  affected.
                </p>
                {confirmDeleteRemoved && (
                  <div className="rounded border border-border/60 bg-muted/30 px-3 py-2 text-xs">
                    <div className="font-medium">
                      {confirmDeleteRemoved.title ??
                        confirmDeleteRemoved.file_name ??
                        confirmDeleteRemoved.document_id ??
                        confirmDeleteRemoved.folder}
                    </div>
                    <div className="mt-0.5 text-muted-foreground">
                      {formatBytes(confirmDeleteRemoved.size_bytes)} · removed{" "}
                      {formatWhen(confirmDeleteRemoved.quarantined_at)}
                    </div>
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-confirm-delete-removed-cancel">
              Keep
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const target = confirmDeleteRemoved;
                setConfirmDeleteRemoved(null);
                if (target) void permanentlyDeleteRemoved(target);
              }}
              data-testid="button-confirm-delete-removed-confirm"
            >
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ---- Confirmation: Delete All (v1.2.0) ---- */}
      <AlertDialog
        open={confirmDeleteAll}
        onOpenChange={(open) => { if (!open && !deleteAllBusy) setConfirmDeleteAll(false); }}
      >
        <AlertDialogContent data-testid="dialog-confirm-delete-all">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete everything in Recovery?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  This permanently removes every recently-removed document and every
                  data snapshot listed below. Once this is done, restoring from
                  Recovery is no longer possible for these items.
                </p>
                <div className="rounded border border-border/60 bg-muted/30 px-3 py-2 text-xs">
                  <div className="font-medium">
                    {removedItems.length} document(s) and {snapshotItems.length} snapshot(s) will be deleted.
                  </div>
                  <div className="mt-0.5 text-muted-foreground">
                    Frees {formatBytes(
                      (removed?.total_bytes ?? 0) + (snapshots?.total_bytes ?? 0),
                    )} from disk.
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Auto-cleanup settings are not touched. Per-item Restore and Delete
                  controls are unaffected.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={deleteAllBusy}
              data-testid="button-confirm-delete-all-cancel"
            >
              Keep
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteAllEmpty || deleteAllBusy}
              onClick={(event) => {
                // Keep the dialog open until the sweep finishes so the user
                // sees the spinner and cannot fire it twice.
                event.preventDefault();
                setConfirmDeleteAll(false);
                void deleteAllInRecovery();
              }}
              data-testid="button-confirm-delete-all-confirm"
            >
              {deleteAllBusy ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-1 h-4 w-4" />
              )}
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ---- Confirmation: permanently delete a pre-restore snapshot ---- */}
      <AlertDialog
        open={confirmDeleteSnapshot !== null}
        onOpenChange={(open) => { if (!open) setConfirmDeleteSnapshot(null); }}
      >
        <AlertDialogContent data-testid="dialog-confirm-delete-snapshot">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this snapshot for good?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  This whole-data-directory snapshot was set aside before a wipe-and-replace restore.
                  Deleting it cannot be undone from inside the app.
                </p>
                {confirmDeleteSnapshot && (
                  <div className="rounded border border-border/60 bg-muted/30 px-3 py-2 text-xs">
                    <div className="font-mono">{confirmDeleteSnapshot.name}</div>
                    <div className="mt-0.5 text-muted-foreground">
                      {formatBytes(confirmDeleteSnapshot.size_bytes)} · created{" "}
                      {formatWhen(confirmDeleteSnapshot.created_at)}
                    </div>
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-confirm-delete-snapshot-cancel">
              Keep
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const target = confirmDeleteSnapshot;
                setConfirmDeleteSnapshot(null);
                if (target) void permanentlyDeleteSnapshot(target);
              }}
              data-testid="button-confirm-delete-snapshot-confirm"
            >
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
