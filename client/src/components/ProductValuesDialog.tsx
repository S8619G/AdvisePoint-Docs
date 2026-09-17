import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Pencil, Merge, Trash2, Eraser } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

// v1.1.3 -- bulk rename / merge for Product model and Product family.
//
// WHY THIS EXISTS
// Unlike document types, there is no registry table for these two fields.
// They are free-text columns on `documents`, and every filter dropdown in the
// app is built by DISTINCT over whatever strings happen to exist. That means:
//   * a misspelling can only be corrected one document at a time, and
//   * near-duplicates ("PA6000x" vs "PA6000x Series") silently split query
//     results, with nothing flagging it as a problem.
// This panel gives one place to see every value with its usage count and to
// rename or merge it across all documents in a single transaction.
//
// WHY IT LIVES ON THE LIBRARY TAB (decision 2026-09-13)
// Settings holds app configuration -- document types, filename codes, updates.
// Model and family are data derived from the documents themselves, not
// configuration, and the Library is where the problem gets noticed.
//
// MERGE, NOT DELETE
// Renaming onto a value that already exists is a merge, and that is the point
// rather than an edge case. There is deliberately no Delete button: the rows
// have to go somewhere, so "remove this value" is either a merge into another
// value or clearing it to blank. Both are reachable here and both say plainly
// what they will do.
//
// v1.2.4 COMPANION NOTE -- DELETE IS NOW REACHABLE, VIA REASSIGN
// Field testing showed the rename-only path was confusing for users who
// arrived at this dialog wanting to "get rid of" a value: the mental model
// is delete, and "rename into another value" reads as an odd workaround. So
// v1.2.4 added an explicit per-row Delete button. It does NOT cascade -- it
// opens a small reassign dialog that offers exactly the two safe outcomes
// the paragraph above describes: merge into another existing value, or clear
// the field on referencing documents. Both paths route through the same
// /api/product-values/rename endpoint (empty `to` == clear, matching `to`
// == merge), so the server contract is unchanged; only the entry point is
// new. This preserves the "destructive operations preserve existing data"
// rule -- there is still no path here that silently loses a document.

type Field = "product_model" | "product_family";

interface ValueEntry {
  value: string;
  count: number;
}

interface ProductValues {
  models: ValueEntry[];
  families: ValueEntry[];
}

interface RenameResult {
  field: Field;
  from: string;
  to: string;
  affected: number;
}

const FIELD_LABEL: Record<Field, string> = {
  product_model: "Product model",
  product_family: "Product family",
};

function docCount(n: number) {
  return `${n} ${n === 1 ? "document" : "documents"}`;
}

export function ProductValuesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const [field, setField] = useState<Field>("product_model");
  const [editing, setEditing] = useState<ValueEntry | null>(null);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState(false);
  // v1.2.4: reassign flow. `deleting` is the row the user clicked Delete on;
  // `deleteMode` picks between the two safe outcomes; `deleteTarget` is the
  // OTHER value to merge into when mode === "merge".
  const [deleting, setDeleting] = useState<ValueEntry | null>(null);
  const [deleteMode, setDeleteMode] = useState<"merge" | "clear">("clear");
  const [deleteTarget, setDeleteTarget] = useState<string>("");

  const { data, isLoading } = useQuery<ProductValues>({
    queryKey: ["/api/product-values"],
    enabled: open,
  });

  const entries = useMemo(
    () => (field === "product_model" ? data?.models : data?.families) ?? [],
    [data, field],
  );

  const trimmed = draft.trim();
  const current = editing?.value ?? "";

  // Does the target value already exist under a DIFFERENT name? If so this is
  // a merge, and the user is told so before confirming -- the count they are
  // about to affect is bigger than the row they clicked.
  const mergeTarget = useMemo(() => {
    if (!trimmed || trimmed === current) return null;
    return entries.find((e) => e.value.toLowerCase() === trimmed.toLowerCase() && e.value !== current) ?? null;
  }, [entries, trimmed, current]);

  const unchanged = !trimmed && !current ? true : trimmed === current;
  const clearing = trimmed === "" && current !== "";

  const rename = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/product-values/rename", {
        field,
        from: current,
        to: trimmed,
      });
      return (await res.json()) as RenameResult;
    },
    onSuccess: (result) => {
      // Every surface that reads these strings has to be refreshed: the value
      // list itself, the document list, and the facet-driven filter dropdowns.
      queryClient.invalidateQueries({ queryKey: ["/api/product-values"] });
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/facets"] });
      toast({
        title: result.to
          ? `Updated ${docCount(result.affected)}`
          : `Cleared ${FIELD_LABEL[field].toLowerCase()} on ${docCount(result.affected)}`,
        description: result.to ? `“${result.from}” → “${result.to}”` : undefined,
      });
      setConfirming(false);
      setEditing(null);
      setDraft("");
    },
    onError: (error: any) => {
      setConfirming(false);
      toast({
        title: "Rename failed",
        description: error?.message ?? String(error),
        variant: "destructive",
      });
    },
  });

  const startEdit = (entry: ValueEntry) => {
    setEditing(entry);
    setDraft(entry.value);
  };

  const affectedTotal = (editing?.count ?? 0) + (mergeTarget?.count ?? 0);

  // v1.2.4: delete flow -- shares the /api/product-values/rename endpoint.
  // clear  == PUT with to="" (blanks the field on referencing documents)
  // merge  == PUT with to=<other existing value> (folds this row into that one)
  // The Delete button just opens a small reassign panel; the panel's Apply
  // routes to the SAME server mutation the rename path uses, so the two
  // paths converge in one place. If a merge target no longer exists at apply
  // time (rare -- values changed under us) the rename call still succeeds
  // and simply RENAMES rather than merging; that's the same behavior the
  // existing rename path has and is not a bug.
  const deleteTargetOptions = useMemo(
    () => (deleting ? entries.filter((e) => e.value !== deleting.value) : []),
    [entries, deleting],
  );
  const deleteMerge = useMutation({
    mutationFn: async () => {
      if (!deleting) throw new Error("No value selected.");
      const to = deleteMode === "clear" ? "" : deleteTarget.trim();
      const res = await apiRequest("POST", "/api/product-values/rename", {
        field,
        from: deleting.value,
        to,
      });
      return (await res.json()) as RenameResult;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/product-values"] });
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/facets"] });
      toast({
        title: result.to
          ? `Merged into “${result.to}” on ${docCount(result.affected)}`
          : `Cleared ${FIELD_LABEL[field].toLowerCase()} on ${docCount(result.affected)}`,
        description: result.to ? `“${result.from}” → “${result.to}”` : undefined,
      });
      setDeleting(null);
      setDeleteMode("clear");
      setDeleteTarget("");
    },
    onError: (error: any) => {
      toast({
        title: "Delete failed",
        description: error?.message ?? String(error),
        variant: "destructive",
      });
    },
  });

  const startDelete = (entry: ValueEntry) => {
    setDeleting(entry);
    // Default to "clear" -- it's the safer, always-available choice. If
    // there are no other values to merge into, it's also the only choice.
    setDeleteMode("clear");
    setDeleteTarget("");
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            setEditing(null);
            setDraft("");
          }
          onOpenChange(next);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Manage product values</DialogTitle>
            <DialogDescription>
              Rename a value everywhere it is used, or merge two values that should be one.
              Changes apply to every document using the value.
            </DialogDescription>
          </DialogHeader>

          <div className="flex gap-1">
            {(["product_model", "product_family"] as Field[]).map((option) => (
              <Button
                key={option}
                size="sm"
                variant={field === option ? "default" : "outline"}
                onClick={() => {
                  setField(option);
                  setEditing(null);
                  setDraft("");
                }}
                data-testid={`button-field-${option}`}
              >
                {FIELD_LABEL[option]}
              </Button>
            ))}
          </div>

          {isLoading ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading values…
            </div>
          ) : entries.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground" data-testid="text-no-values">
              No {FIELD_LABEL[field].toLowerCase()} values in use yet.
            </div>
          ) : (
            <div className="max-h-[320px] space-y-1 overflow-y-auto pr-1">
              {entries.map((entry) => (
                <div
                  key={entry.value}
                  className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                  data-testid={`row-value-${entry.value}`}
                >
                  <span className="min-w-0 flex-1 truncate text-sm">{entry.value}</span>
                  <Badge variant="secondary" className="shrink-0 text-[10px]">
                    {docCount(entry.count)}
                  </Badge>
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0 gap-1.5"
                    onClick={() => startEdit(entry)}
                    data-testid={`button-rename-value-${entry.value}`}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    Rename
                  </Button>
                  {/* v1.2.4: per-row Delete. Opens a reassign dialog rather
                      than cascading -- the value has to go somewhere. */}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="shrink-0 gap-1.5 text-muted-foreground hover:text-destructive"
                    onClick={() => startDelete(entry)}
                    data-testid={`button-delete-value-${entry.value}`}
                    aria-label={`Delete ${entry.value}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                  </Button>
                </div>
              ))}
            </div>
          )}

          {editing && (
            <div className="space-y-2 rounded-md border bg-muted/40 p-3">
              <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                New {FIELD_LABEL[field].toLowerCase()}
              </Label>
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={200}
                autoFocus
                placeholder={field === "product_model" ? "Leave blank to clear" : "Leave blank to clear"}
                data-testid="input-rename-value"
              />
              {mergeTarget ? (
                <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                  <Merge className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    “{mergeTarget.value}” already exists with {docCount(mergeTarget.count)}. This will
                    merge both into one value used by {docCount(affectedTotal)}.
                  </span>
                </p>
              ) : clearing ? (
                <p className="text-xs text-muted-foreground">
                  This clears {FIELD_LABEL[field].toLowerCase()} on {docCount(editing.count)}.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  This renames the value on {docCount(editing.count)}.
                </p>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-values-close">
              Close
            </Button>
            <Button
              disabled={!editing || unchanged || rename.isPending}
              onClick={() => setConfirming(true)}
              data-testid="button-values-apply"
            >
              {mergeTarget ? "Merge…" : clearing ? "Clear…" : "Rename…"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* v1.2.4: Delete-with-reassign dialog. Two radio-like buttons pick
          the outcome, then Apply routes through the same rename endpoint the
          Rename path uses. Never a cascading delete. */}
      <AlertDialog
        open={!!deleting}
        onOpenChange={(next) => {
          if (!next) {
            setDeleting(null);
            setDeleteMode("clear");
            setDeleteTarget("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete “{deleting?.value ?? ""}”?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm">
                <p>
                  This value is used by {docCount(deleting?.count ?? 0)}. Pick
                  what should happen to those documents.
                </p>
                <div className="space-y-2">
                  <Button
                    type="button"
                    variant={deleteMode === "clear" ? "default" : "outline"}
                    className="w-full justify-start gap-2"
                    onClick={() => setDeleteMode("clear")}
                    data-testid="button-delete-mode-clear"
                  >
                    <Eraser className="h-4 w-4" />
                    Clear {FIELD_LABEL[field].toLowerCase()} on those documents
                  </Button>
                  <Button
                    type="button"
                    variant={deleteMode === "merge" ? "default" : "outline"}
                    className="w-full justify-start gap-2"
                    disabled={deleteTargetOptions.length === 0}
                    onClick={() => setDeleteMode("merge")}
                    data-testid="button-delete-mode-merge"
                  >
                    <Merge className="h-4 w-4" />
                    Merge into another value
                  </Button>
                  {deleteMode === "merge" && (
                    <Select
                      value={deleteTarget || undefined}
                      onValueChange={(v) => setDeleteTarget(v)}
                    >
                      <SelectTrigger data-testid="select-delete-target">
                        <SelectValue placeholder="Pick an existing value" />
                      </SelectTrigger>
                      <SelectContent>
                        {deleteTargetOptions.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {opt.value} ({docCount(opt.count)})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
                <p className="text-muted-foreground">
                  {deleteMode === "clear"
                    ? `${FIELD_LABEL[field]} will be cleared on ${docCount(deleting?.count ?? 0)}. The documents themselves are not deleted.`
                    : deleteTarget
                    ? `“${deleting?.value ?? ""}” will be merged into “${deleteTarget}”, giving one value used by ${docCount((deleting?.count ?? 0) + (deleteTargetOptions.find((o) => o.value === deleteTarget)?.count ?? 0))}.`
                    : "Pick a value above to merge into."}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-delete-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={
                deleteMerge.isPending ||
                (deleteMode === "merge" && !deleteTarget.trim())
              }
              onClick={(e) => {
                e.preventDefault();
                deleteMerge.mutate();
              }}
              data-testid="button-delete-apply"
            >
              {deleteMerge.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Applying…
                </>
              ) : deleteMode === "clear" ? (
                "Clear field"
              ) : (
                "Merge"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Destructive bulk change: always confirm, and always show the exact
          count and both values so there is no ambiguity about the scope. */}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {mergeTarget ? "Merge these values?" : clearing ? "Clear this value?" : "Rename this value?"}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                {mergeTarget ? (
                  <p>
                    “{current}” ({docCount(editing?.count ?? 0)}) will be merged into “{mergeTarget.value}”
                    ({docCount(mergeTarget.count)}), giving one value used by {docCount(affectedTotal)}.
                  </p>
                ) : clearing ? (
                  <p>
                    {FIELD_LABEL[field]} will be cleared on {docCount(editing?.count ?? 0)} currently using
                    “{current}”.
                  </p>
                ) : (
                  <p>
                    “{current}” will become “{trimmed}” on {docCount(editing?.count ?? 0)}.
                  </p>
                )}
                <p className="text-muted-foreground">
                  This updates every affected document at once. You can rename it back, but there is no undo
                  step — export a backup first from Settings if you want a restore point.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-confirm-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                rename.mutate();
              }}
              data-testid="button-confirm-rename"
            >
              {rename.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Applying…
                </>
              ) : mergeTarget ? (
                "Merge"
              ) : clearing ? (
                "Clear"
              ) : (
                "Rename"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
