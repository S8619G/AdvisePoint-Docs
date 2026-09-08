import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Loader2, AlertTriangle, ScanLine, FileX, TagIcon, ImageOff, GitCompare, Trash2 } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Link } from "wouter";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";

// v0.9.23 - Library maintenance scan panel (Settings > About tab).
// Kicks off a metadata-only sweep that looks for three integrity issues:
//   - Duplicate filenames (two or more docs sharing the same stem)
//   - Missing product_model on parent rows
//   - Missing page files (spot-check first/mid/last on each rendered doc)
// The scan is fast enough to run synchronously on demand (< 100 docs is typical
// for a field team), but heavy enough that we don't want to run it on every
// page load - hence the manual button. Empty state after a scan means "no
// issues found" which is a genuinely useful signal to the user.
//
// v0.9.27 - Compare + Delete controls on each duplicate group.
//   * Compare: fetches full metadata for every doc in the group and shows a
//     side-by-side table of the fields most likely to differ (dates, size,
//     page count, product_model, revision, language, region, all manually
//     added metadata like tags and notes). Rows where every doc agrees are
//     dimmed so mismatches stand out. This is the fastest way for a tech to
//     tell an old copy from a new one before deleting.
//   * Delete: per-row destructive action. Confirms first, then hits the same
//     DELETE /api/documents/:id endpoint the library page uses - which
//     already cascades to page images via purgePagesForDoc. On success the
//     dupe row disappears and, if the group has fewer than 2 remaining
//     copies, the whole group is removed (no longer a "duplicate").
//
// v0.9.28 - Delete is also surfaced inside the Compare dialog next to each
//   Copy column header. Reason: the outer duplicate list shows every copy
//   with the same filename and title, so telling them apart to click the
//   right Delete button requires eyeballing metadata that only the Compare
//   view exposes. Deleting from inside Compare guarantees the tech is
//   acting on the exact column they're comparing. Both Delete paths funnel
//   through the same confirm dialog + doDelete() so behavior is identical.

interface DupeGroup {
  id: string;
  title: string;
  file_name: string;
}

interface MissingPagesDoc {
  id: string;
  title: string;
  total_pages: number;
  missing: number[];
}

interface ScanResult {
  scanned_at: string;
  total_documents: number;
  duplicate_filenames: DupeGroup[][];
  missing_product_model: { id: string; title: string }[];
  missing_pages: MissingPagesDoc[];
  issue_count: number;
}

// Full doc shape returned by GET /api/documents/:id (only the fields the
// Compare panel actually surfaces). Everything is optional/permissive because
// this data comes straight from user-editable metadata and older imports.
interface FullDoc {
  id: string;
  title?: string;
  subtitle?: string;
  file_name?: string;
  document_type?: string;
  language?: string;
  summary?: string;
  product_family?: string;
  product_model?: string;
  product_sku?: string;
  product_version?: string;
  firmware_version?: string;
  release_channel?: string;
  lifecycle_status?: string;
  published_at?: string;
  updated_at?: string;
  ingested_at?: string;
  confidentiality?: string;
  file_hash_sha256?: string;
  pipeline_version?: string;
  total_chunks?: number;
  total_tokens?: number;
  source_uri?: string;
  source_system?: string;
  audience?: string[];
  platform?: string[];
  region?: string[];
  tags?: string[];
  keywords?: string[];
  [k: string]: unknown;
}

export function LibraryScanPanel() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compareGroup, setCompareGroup] = useState<DupeGroup[] | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DupeGroup | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const { toast } = useToast();

  const runScan = async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await apiRequest("POST", "/api/library/scan", {});
      const data = (await res.json()) as ScanResult;
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed");
    } finally {
      setRunning(false);
    }
  };

  const doDelete = async (doc: DupeGroup) => {
    setDeletingId(doc.id);
    try {
      await apiRequest("DELETE", `/api/documents/${doc.id}`);
      // Prune the deleted doc out of any duplicate group in local state so
      // the UI updates immediately (no need to re-scan for the common case).
      // Also adjust total_documents and issue_count so the header summary
      // stays truthful without forcing another scan.
      setResult((prev) => {
        if (!prev) return prev;
        const prevGroupCount = prev.duplicate_filenames.length;
        const nextGroups = prev.duplicate_filenames
          .map((g) => g.filter((d) => d.id !== doc.id))
          .filter((g) => g.length >= 2); // <2 copies isn't a duplicate any more
        const removedGroups = prevGroupCount - nextGroups.length;
        return {
          ...prev,
          duplicate_filenames: nextGroups,
          total_documents: Math.max(0, prev.total_documents - 1),
          issue_count: Math.max(0, prev.issue_count - removedGroups),
        };
      });
      // v0.9.28: also prune the Compare dialog's view of the group. If the
      // group drops below 2 copies it's no longer a duplicate cluster, so
      // close the dialog; otherwise keep it open with the survivors.
      setCompareGroup((prev) => {
        if (!prev) return prev;
        const next = prev.filter((d) => d.id !== doc.id);
        return next.length >= 2 ? next : null;
      });
      // Also invalidate the shared documents query so the Library page reflects
      // the delete without a full navigation refresh.
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
      toast({ title: "Deleted", description: `${doc.title} removed from the library.` });
    } catch (err) {
      toast({
        title: "Delete failed",
        description: err instanceof Error ? err.message : "The server refused the delete.",
        variant: "destructive",
      });
    } finally {
      setDeletingId(null);
      setPendingDelete(null);
    }
  };

  return (
    <Card data-testid="panel-library-scan">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ScanLine className="h-4 w-4" />
          Library maintenance
        </CardTitle>
        <CardDescription className="text-xs">
          Quick integrity sweep for duplicates, missing metadata, and page files that never rendered. Metadata-only —
          nothing is re-hashed or re-rendered.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <Button
            onClick={runScan}
            disabled={running}
            size="sm"
            data-testid="button-scan-library"
          >
            {running ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Scanning…
              </>
            ) : (
              <>
                <ScanLine className="mr-2 h-4 w-4" />
                Scan library now
              </>
            )}
          </Button>
          {result && (
            <span className="text-xs text-muted-foreground" data-testid="text-scan-summary">
              Scanned {result.total_documents} document{result.total_documents === 1 ? "" : "s"}
              {" · "}
              {result.issue_count === 0
                ? "no issues found"
                : `${result.issue_count} issue${result.issue_count === 1 ? "" : "s"}`}
            </span>
          )}
          {error && (
            <span className="text-xs text-red-600 dark:text-red-400" data-testid="text-scan-error">
              {error}
            </span>
          )}
        </div>

        {result && result.issue_count === 0 && (
          <div
            className="flex items-center gap-2 rounded-md border border-green-500/30 bg-green-500/10 p-3 text-xs text-green-900 dark:text-green-100"
            data-testid="text-scan-clean"
          >
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            All clear — no duplicate filenames, no missing product models, no missing page files.
          </div>
        )}

        {result && result.duplicate_filenames.length > 0 && (
          <ScanSection
            icon={<FileX className="h-4 w-4" />}
            title="Duplicate filenames"
            description="Two or more documents share the same filename stem (case-insensitive). Use Compare to see what's different, then Delete the older copies."
            count={result.duplicate_filenames.length}
            testid="section-duplicates"
          >
            <ul className="space-y-2">
              {result.duplicate_filenames.map((group, idx) => (
                <li
                  key={idx}
                  className="rounded-md border border-border/60 bg-muted/30 p-2 text-xs"
                  data-testid={`dupe-group-${idx}`}
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {group[0].file_name} · {group.length} copies
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 gap-1 px-2 text-[11px]"
                      onClick={() => setCompareGroup(group)}
                      data-testid={`button-compare-group-${idx}`}
                    >
                      <GitCompare className="h-3 w-3" />
                      Compare
                    </Button>
                  </div>
                  <ul className="space-y-1 pl-3">
                    {group.map((doc) => (
                      <li
                        key={doc.id}
                        className="flex items-center justify-between gap-2"
                        data-testid={`dupe-item-${doc.id}`}
                      >
                        <Link
                          href={`/library/${doc.id}`}
                          className="truncate text-foreground hover:underline"
                          title={doc.title}
                        >
                          {doc.title}
                        </Link>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 shrink-0 px-1.5 text-[11px] text-red-600 hover:bg-red-500/10 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                          onClick={() => setPendingDelete(doc)}
                          disabled={deletingId === doc.id}
                          data-testid={`button-delete-dupe-${doc.id}`}
                          title="Delete this document (removes DB rows and page images)"
                        >
                          {deletingId === doc.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <>
                              <Trash2 className="mr-1 h-3 w-3" />
                              Delete
                            </>
                          )}
                        </Button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </ScanSection>
        )}

        {result && result.missing_product_model.length > 0 && (
          <ScanSection
            icon={<TagIcon className="h-4 w-4" />}
            title="Missing product model"
            description="Documents with a blank product_model field. Edit the doc's metadata to fix."
            count={result.missing_product_model.length}
            testid="section-missing-model"
          >
            <ul className="space-y-1">
              {result.missing_product_model.map((doc) => (
                <li key={doc.id} className="text-xs" data-testid={`missing-model-${doc.id}`}>
                  <Link href={`/library/${doc.id}`} className="text-foreground hover:underline">
                    {doc.title}
                  </Link>
                </li>
              ))}
            </ul>
          </ScanSection>
        )}

        {result && result.missing_pages.length > 0 && (
          <ScanSection
            icon={<ImageOff className="h-4 w-4" />}
            title="Missing page files"
            description="Rendered docs where at least one spot-checked page (first / mid / last) is missing from disk."
            count={result.missing_pages.length}
            testid="section-missing-pages"
          >
            <ul className="space-y-1">
              {result.missing_pages.map((doc) => (
                <li key={doc.id} className="text-xs" data-testid={`missing-pages-${doc.id}`}>
                  <Link href={`/library/${doc.id}`} className="text-foreground hover:underline">
                    {doc.title}
                  </Link>
                  <span className="ml-2 font-mono text-[10.5px] text-muted-foreground">
                    total {doc.total_pages} · missing p{doc.missing.join(", p")}
                  </span>
                </li>
              ))}
            </ul>
          </ScanSection>
        )}
      </CardContent>

      <CompareDialog
        group={compareGroup}
        onOpenChange={(open) => !open && setCompareGroup(null)}
        onDeleteDoc={(doc) => setPendingDelete(doc)}
        deletingId={deletingId}
      />

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && !deletingId && setPendingDelete(null)}
      >
        <AlertDialogContent data-testid="dialog-confirm-dupe-delete">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this document?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="mb-2 block">
                <span className="font-medium text-foreground">{pendingDelete?.title}</span>
              </span>
              <span className="block">
                Removes the parent row, every excerpt, and the rendered page images from
                <code className="mx-1 rounded bg-muted px-1 py-0.5 text-[11px]">
                  %LOCALAPPDATA%\AdvisePoint Docs\pages\{pendingDelete?.id}
                </code>
                . Other copies of this file stay in the library.
              </span>
              <span className="mt-2 block font-medium text-red-600 dark:text-red-400">This cannot be undone.</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-dupe-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700"
              onClick={(e) => {
                // AlertDialogAction closes the dialog by default; we want to
                // hold it open while the delete is in flight so the spinner
                // in the trigger row is visible. Prevent the auto-close and
                // rely on setPendingDelete(null) inside doDelete().
                e.preventDefault();
                if (pendingDelete) doDelete(pendingDelete);
              }}
              disabled={deletingId !== null}
              data-testid="button-confirm-dupe-delete"
            >
              {deletingId ? (
                <>
                  <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                  Deleting…
                </>
              ) : (
                "Delete document"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function ScanSection({
  icon,
  title,
  description,
  count,
  testid,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  count: number;
  testid: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3"
      data-testid={testid}
    >
      <div className="mb-2 flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        <span className="text-xs font-semibold text-foreground">{title}</span>
        <Badge variant="outline" className="text-[10px]">{count}</Badge>
      </div>
      <p className="mb-2 text-[11px] text-muted-foreground">{description}</p>
      {children}
    </div>
  );
}

// -------- Compare dialog --------
// Fetches each duplicate's full record in parallel and renders a side-by-side
// comparison. Rows where every doc agrees are dimmed so mismatches (usually
// revision, publish_date, or page count) jump out.

function CompareDialog({
  group,
  onOpenChange,
  onDeleteDoc,
  deletingId,
}: {
  group: DupeGroup[] | null;
  onOpenChange: (open: boolean) => void;
  // v0.9.28: parent handles the confirm+delete flow so both delete paths
  // (outer per-row buttons and these in-dialog buttons) share the same
  // AlertDialog and doDelete().
  onDeleteDoc: (doc: DupeGroup) => void;
  deletingId: string | null;
}) {
  const [docs, setDocs] = useState<FullDoc[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Load whenever a new group is opened.
  const openKey = group ? group.map((g) => g.id).join(",") : "";
  const [loadedKey, setLoadedKey] = useState<string>("");

  if (group && openKey !== loadedKey && !loading) {
    setLoading(true);
    setFetchError(null);
    Promise.all(
      group.map((g) =>
        apiRequest("GET", `/api/documents/${g.id}`)
          .then((r) => r.json())
          .then((j) => (j.document as FullDoc)),
      ),
    )
      .then((full) => {
        setDocs(full);
        setLoadedKey(openKey);
      })
      .catch((err) => {
        setFetchError(err instanceof Error ? err.message : "Failed to load documents");
      })
      .finally(() => setLoading(false));
  }

  const rows = [
    { key: "id", label: "Document ID", mono: true },
    { key: "file_name", label: "Filename" },
    { key: "file_hash_sha256", label: "File hash (SHA-256)", mono: true, format: fmtHash },
    { key: "total_chunks", label: "Excerpts" },
    { key: "total_tokens", label: "Tokens", format: fmtNum },
    { key: "language", label: "Language" },
    { key: "document_type", label: "Doc type" },
    { key: "product_family", label: "Product family" },
    { key: "product_model", label: "Product model" },
    { key: "product_sku", label: "Product SKU" },
    { key: "product_version", label: "Product version" },
    { key: "firmware_version", label: "Revision" },
    { key: "release_channel", label: "Release channel" },
    { key: "lifecycle_status", label: "Lifecycle status" },
    { key: "published_at", label: "Published", format: fmtDate },
    { key: "ingested_at", label: "Ingested", format: fmtDate },
    { key: "updated_at", label: "Last updated", format: fmtDate },
    { key: "confidentiality", label: "Confidentiality" },
    { key: "pipeline_version", label: "Pipeline version" },
    { key: "source_uri", label: "Source URI" },
    { key: "source_system", label: "Source system" },
    { key: "audience", label: "Audience", format: fmtArr },
    { key: "platform", label: "Platform", format: fmtArr },
    { key: "region", label: "Region", format: fmtArr },
    { key: "tags", label: "Tags (manual)", format: fmtArr },
    { key: "keywords", label: "Keywords (manual)", format: fmtArr },
    { key: "subtitle", label: "Subtitle" },
    { key: "summary", label: "Summary" },
  ] as const;

  return (
    <Dialog open={group !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-5xl overflow-hidden" data-testid="dialog-compare-dupes">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <GitCompare className="h-4 w-4" />
            Compare duplicates
          </DialogTitle>
          <DialogDescription className="text-xs">
            Side-by-side metadata for every copy sharing this filename. Rows where every column agrees are dimmed —
            focus on the highlighted mismatches to pick the correct copy.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center gap-2 py-8 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading document metadata…
          </div>
        )}

        {fetchError && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-300">
            {fetchError}
          </div>
        )}

        {!loading && !fetchError && docs.length > 0 && (
          <div className="overflow-auto" style={{ maxHeight: "calc(85vh - 120px)" }}>
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 z-10 bg-background">
                <tr className="border-b border-border">
                  <th className="sticky left-0 z-20 bg-background px-2 py-1.5 text-left font-medium text-muted-foreground">
                    Field
                  </th>
                  {docs.map((d, i) => {
                    // Match the doc back to its DupeGroup entry so onDeleteDoc
                    // gets the same {id, title, file_name} shape the confirm
                    // dialog expects. Fall back to a synthesized entry if the
                    // group list drifted (shouldn't happen in practice).
                    const groupEntry: DupeGroup =
                      group?.find((g) => g.id === d.id) ?? {
                        id: d.id,
                        title: d.title ?? d.file_name ?? d.id,
                        file_name: d.file_name ?? "",
                      };
                    const isDeleting = deletingId === d.id;
                    return (
                      <th
                        key={d.id}
                        className="min-w-[220px] px-2 py-1.5 text-left align-bottom"
                        title={d.title ?? ""}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="text-[10.5px] uppercase tracking-wide text-muted-foreground">
                              Copy {i + 1}
                            </div>
                            <div className="mt-0.5 max-w-[220px] truncate font-medium text-foreground">
                              {d.title ?? d.file_name ?? d.id}
                            </div>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 shrink-0 gap-1 px-1.5 text-[11px] text-red-600 hover:bg-red-500/10 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                            onClick={() => onDeleteDoc(groupEntry)}
                            disabled={isDeleting || deletingId !== null}
                            data-testid={`button-compare-delete-${d.id}`}
                            title="Delete this copy (removes DB rows and page images)"
                          >
                            {isDeleting ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <>
                                <Trash2 className="h-3 w-3" />
                                Delete
                              </>
                            )}
                          </Button>
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const values = docs.map((d) => {
                    const raw = d[r.key as keyof FullDoc];
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    return (r as any).format ? (r as any).format(raw) : fmtScalar(raw);
                  });
                  const allSame = values.every((v) => v === values[0]);
                  return (
                    <tr
                      key={r.key}
                      className={`border-b border-border/40 ${allSame ? "opacity-55" : "bg-amber-500/5"}`}
                      data-testid={`compare-row-${r.key}`}
                    >
                      <td className="sticky left-0 z-10 whitespace-nowrap bg-background px-2 py-1.5 pr-4 font-medium text-muted-foreground">
                        {r.label}
                      </td>
                      {values.map((v, i) => (
                        <td
                          key={i}
                          className={`px-2 py-1.5 align-top ${r.mono ? "font-mono text-[11px]" : ""}`}
                        >
                          {v || <span className="text-muted-foreground/60">—</span>}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---- formatters ----
function fmtScalar(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "yes" : "no";
  try { return JSON.stringify(v); } catch { return String(v); }
}
function fmtArr(v: unknown): string {
  if (!Array.isArray(v) || v.length === 0) return "";
  return v.map((x) => String(x)).join(", ");
}
function fmtNum(v: unknown): string {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString();
}
function fmtDate(v: unknown): string {
  if (!v && v !== 0) return "";
  // Accept ISO strings, epoch millisecond numbers, or numeric-looking strings.
  let d: Date;
  if (typeof v === "number") d = new Date(v);
  else if (typeof v === "string" && /^\d{10,}$/.test(v)) d = new Date(parseInt(v, 10));
  else d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  // v1.0.6.1: format in the user's local time zone. Prior versions used
  // toISOString(), which always renders in UTC and can be off by several
  // hours (or a full day) from what Windows Explorer shows for the same
  // file. The compare-duplicates dialog surfaces "Ingested" and "Last
  // updated" side-by-side, so local time is what users expect.
  return d.toLocaleString();
}
function fmtHash(v: unknown): string {
  if (!v) return "";
  const s = String(v);
  return s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s;
}
