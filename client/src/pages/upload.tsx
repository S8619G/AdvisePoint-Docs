import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useToast } from "@/hooks/use-toast";
import {
  Loader2,
  Sparkles,
  FileText,
  ArrowRight,
  Upload as UploadIcon,
  X,
  FileUp,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Info,
} from "lucide-react";
import { Link } from "wouter";
import {
  AUDIENCES as SHARED_AUDIENCES,
  CONFIDENTIALITY as SHARED_CONFIDENTIALITY,
  RELEASE_CHANNELS as SHARED_RELEASE_CHANNELS,
  releaseChannelLabel,
} from "@shared/schema";
import { ProductModelCombobox, RequiredField } from "@/components/ProductModelCombobox";
import { useDocumentTypes, documentTypeColor } from "@/lib/documentTypes";
import { DocTypeDot } from "@/components/DocTypeDot";
// v0.9.30: TagsCombobox lives in its own component now (see the bottom of
// this file for a re-export that keeps library.tsx's `from "./upload"` path
// working). We still import it here for use inside MetaForm below.
import { TagsCombobox } from "@/components/TagsCombobox";

// Sourced from shared/schema.ts so server + client stay in lockstep.
// Never re-add local hardcoded copies — that's how enums drift over time.
const AUDIENCES = SHARED_AUDIENCES as readonly string[];
const CONFIDENTIALITY = SHARED_CONFIDENTIALITY as readonly string[];
const RELEASE_CHANNELS = SHARED_RELEASE_CHANNELS as readonly string[];

// -----------------------------------------------------------------------------
// Shared metadata form state
// -----------------------------------------------------------------------------

interface Meta {
  title: string; // per-file, so only used in single-file view / when set inside a batch card
  subtitle: string;
  document_type: string;
  audience: string[];
  product_family: string;
  product_model: string;
  product_version: string;
  firmware_version: string;
  release_channel: string;
  confidentiality: string;
  allowed_tenants: string;
  tags: string;
}

const emptyMeta = (product_model = ""): Meta => ({
  title: "",
  subtitle: "",
  document_type: "document",
  audience: [],
  product_family: "",
  product_model,
  product_version: "",
  firmware_version: "",
  release_channel: "ga",
  confidentiality: "public",
  allowed_tenants: "",
  tags: "",
});

const ACCEPT_EXT = [".pdf", ".docx", ".txt", ".md", ".markdown"];
const ACCEPT_MIME =
  "application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown";
const MAX_BYTES = 150 * 1024 * 1024; // 150 MB — matches server cap

// -----------------------------------------------------------------------------
// Per-file record used by the batch UI
// -----------------------------------------------------------------------------

type FileStatus = "pending" | "uploading" | "done" | "error" | "skipped";

interface FileEntry {
  key: string; // stable ID for React keys (name + size + lastModified)
  file: File;
  status: FileStatus;
  message: string; // success or error message
  result: any | null; // server response, kept so we can link to Library
  meta: Meta; // per-file metadata (only used in per-file mode)
  expanded: boolean; // per-file card open/closed
}

const makeKey = (f: File) => `${f.name}::${f.size}::${f.lastModified}`;

// -----------------------------------------------------------------------------
// Page component
// -----------------------------------------------------------------------------

type UploadMode = "batch-shared" | "batch-perfile";

export default function Upload() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);

  // Shared metadata — used both for single-file uploads and for
  // "apply to all" batch uploads.
  const [shared, setShared] = useState<Meta>(() => emptyMeta());

  // Files staged for upload. This holds 0..N files. When length === 1 we
  // effectively render the single-file mode; when length > 1 the batch UI
  // takes over.
  const [files, setFiles] = useState<FileEntry[]>([]);
  // v0.9.30: after a batch upload succeeds we clear the successful rows out
  // of `files` (see the batch-complete handler for the why). The results are
  // stashed here so the success card below the form keeps rendering them.
  const [completedUploads, setCompletedUploads] = useState<any[]>([]);

  // v0.9.23: Duplicate-filename detection. As soon as the user stages a file
  // we ask the server "is this filename already in the library?". Match is on
  // stem only, case-insensitive. Non-blocking — users see an inline red
  // warning next to the offending row but can still choose to upload.
  //
  // We debounce the fetch (300ms) so rapid staging doesn't hammer the server.
  const stagedNames = useMemo(() => files.map((f) => f.file.name).sort().join(","), [files]);
  const [debouncedNames, setDebouncedNames] = useState("");
  useEffect(() => {
    if (!stagedNames) { setDebouncedNames(""); return; }
    const t = setTimeout(() => setDebouncedNames(stagedNames), 300);
    return () => clearTimeout(t);
  }, [stagedNames]);
  const dupeCheck = useQuery<{ duplicates: string[] }>({
    queryKey: ["/api/documents/filename-check", debouncedNames],
    queryFn: async () => {
      if (!debouncedNames) return { duplicates: [] };
      const url = `/api/documents/filename-check?names=${encodeURIComponent(debouncedNames)}`;
      const res = await apiRequest("GET", url);
      return res.json();
    },
    enabled: debouncedNames.length > 0,
    staleTime: 5000,
  });
  const duplicateNames = useMemo(() => {
    const stemOf = (s: string) => s.replace(/\.[^./\\]+$/, "").toLowerCase();
    const set = new Set((dupeCheck.data?.duplicates ?? []).map(stemOf));
    return set;
  }, [dupeCheck.data]);

  // "batch-shared" = one metadata block applied to every file (fastest)
  // "batch-perfile" = each file has its own metadata card that can be edited
  const [mode, setMode] = useState<UploadMode>("batch-shared");

  // For pasted-text ingest (kept from the previous version)
  const [pastedBody, setPastedBody] = useState("");
  const [pastedResult, setPastedResult] = useState<any>(null);

  // Currently-uploading file key. Non-null means the sequential loop is running.
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);
  const [batchDone, setBatchDone] = useState(false);

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["/api/stats"] });
    qc.invalidateQueries({ queryKey: ["/api/documents"] });
    qc.invalidateQueries({ queryKey: ["/api/facets"] });
  };

  // -------- Pasted-text ingest (unchanged behaviour) --------
  const textMut = useMutation({
    mutationFn: async (payload: any) => {
      const res = await apiRequest("POST", "/api/ingest", payload);
      return res.json();
    },
    onSuccess: (data) => {
      setPastedResult(data);
      setShared(emptyMeta());
      setPastedBody("");
      invalidateAll();
      toast({
        title: "Document added to library",
        description: `${data.document.title} · ${data.chunks.length} excerpts`,
      });
    },
    onError: (e: any) => {
      toast({ title: "Upload failed", description: e.message ?? "Unknown error", variant: "destructive" });
    },
  });

  // -------- File validation + staging --------
  const stageFiles = (list: FileList | File[] | null) => {
    if (!list || list.length === 0) return;

    const incoming = Array.from(list);
    const accepted: FileEntry[] = [];
    let rejected = 0;

    for (const f of incoming) {
      const lower = f.name.toLowerCase();
      if (!ACCEPT_EXT.some((ext) => lower.endsWith(ext))) {
        rejected += 1;
        continue;
      }
      if (f.size > MAX_BYTES) {
        rejected += 1;
        toast({
          title: "File skipped: too large",
          description: `${f.name} exceeds the 150 MB limit.`,
          variant: "destructive",
        });
        continue;
      }
      // De-dupe against files already staged
      const key = makeKey(f);
      accepted.push({
        key,
        file: f,
        status: "pending",
        message: "",
        result: null,
        // Per-file metadata starts as a copy of the shared form — this way if
        // you switch to per-file mode you already have sensible defaults.
        meta: {
          ...shared,
          // Auto-fill title from filename so per-file editing is fast
          title: f.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "),
        },
        expanded: false,
      });
    }

    if (rejected > 0) {
      toast({
        title: `Skipped ${rejected} file${rejected === 1 ? "" : "s"}`,
        description: "Only PDF, DOCX, TXT, or Markdown files up to 150 MB are supported.",
        variant: "destructive",
      });
    }

    if (accepted.length === 0) return;

    // Merge — dedupe by key
    setFiles((prev) => {
      const seen = new Set(prev.map((p) => p.key));
      const next = [...prev];
      for (const a of accepted) {
        if (!seen.has(a.key)) next.push(a);
      }
      return next;
    });
    // Batch mode by default when >1 file is staged; single file view otherwise
    setBatchDone(false);
  };

  const removeFile = (key: string) => {
    setFiles((prev) => prev.filter((f) => f.key !== key));
  };

  const clearAll = () => {
    setFiles([]);
    setCompletedUploads([]);
    setBatchDone(false);
    if (fileInput.current) fileInput.current.value = "";
  };

  const updateFileMeta = (key: string, patch: Partial<Meta>) => {
    setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, meta: { ...f.meta, ...patch } } : f)));
  };

  const toggleExpanded = (key: string) => {
    setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, expanded: !f.expanded } : f)));
  };

  // -------- Upload one file --------
  // Wrapped so the batch loop can call it sequentially and update per-file status.
  const uploadOne = async (entry: FileEntry, metaOverride: Meta): Promise<FileEntry> => {
    const metadata: any = buildMetadataPayload(metaOverride, entry.file.name);
    try {
      const fd = new FormData();
      fd.append("file", entry.file);
      fd.append("metadata", JSON.stringify(metadata));
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      if (!res.ok) {
        // Try to pull a useful error message, but never leak raw HTML/stack traces.
        let msg = `HTTP ${res.status}`;
        try {
          const j = await res.json();
          if (j?.message) msg = j.message;
        } catch {
          /* not JSON — keep the HTTP code */
        }
        throw new Error(msg);
      }
      const data = await res.json();
      return {
        ...entry,
        status: "done",
        message: `Added ${data.chunks?.length ?? 0} excerpts${
          data.extraction?.page_count ? ` · ${data.extraction.page_count} pages` : ""
        }`,
        result: data,
      };
    } catch (err: any) {
      return { ...entry, status: "error", message: err?.message ?? "Upload failed" };
    }
  };

  // -------- Sequential batch loop --------
  // Sequential (not parallel) because:
  //   - The server is single-process and PDF extraction is CPU-bound.
  //   - Parallel uploads would compete for RAM (up to 150 MB each).
  //   - Sequential gives the user a clear progress signal file by file.
  const runBatch = async () => {
    // v0.9.21: single-file uploads still require product_model up front. Multi-
    // file uploads skip metadata entirely at ingest time and the user fills it
    // in per-doc from the Library edit dialog after the batch finishes. That
    // fixes the old confusion where partial shared metadata silently applied
    // to every file, and where the Upload button stayed active without
    // flagging Product model as required.
    if (!isBatch) {
      if (!shared.product_model.trim()) {
        toast({
          title: "Product model is required",
          description: "Pick or type a product model before uploading.",
          variant: "destructive",
        });
        return;
      }
    }

    setBatchDone(false);
    // Reset any errored/done entries so a retry actually re-attempts them
    setFiles((prev) => prev.map((f) => ({ ...f, status: "pending", message: "" })));

    // Process one file at a time
    const snapshot = files.slice();
    const outcomes: FileEntry[] = [];
    for (const entry of snapshot) {
      // Mark uploading
      setUploadingKey(entry.key);
      setFiles((prev) => prev.map((f) => (f.key === entry.key ? { ...f, status: "uploading", message: "" } : f)));

      // v0.9.21: for multi-file uploads, send a blank metadata block so nothing
      // from the shared form leaks in. Only title (auto-filled from filename)
      // and required defaults survive.
      const metaForFile: Meta = isBatch ? emptyMeta() : shared;
      const finished = await uploadOne(entry, metaForFile);
      outcomes.push(finished);

      setFiles((prev) => prev.map((f) => (f.key === entry.key ? finished : f)));
    }

    setUploadingKey(null);
    setBatchDone(true);
    if (outcomes.some((entry) => entry.status === "done")) {
      setShared(emptyMeta());
    }
    invalidateAll();

    // v0.9.30: after a batch finishes, drop successful uploads out of the
    // staging list. Keep errored rows in place so users can retry them.
    // Previously the successful rows stayed staged, which:
    //   * left the user's Upload page looking cluttered after a large batch,
    //   * poisoned the /api/documents/filename-check query with the just-
    //     uploaded filenames (server now has them, and they're still in
    //     `stagedNames`, so every row got flagged as a false duplicate).
    // Preserve the completed results in a separate list so the success card
    // below can still display them.
    const done = files.length;
    setFiles((current) => {
      const ok = current.filter((f) => f.status === "done");
      const bad = current.filter((f) => f.status === "error");
      // Append newly successful uploads to the persistent success history so
      // the results panel below the form doesn't blink empty on batch end.
      if (ok.length > 0) {
        setCompletedUploads((prev) => [
          ...ok.map((f) => f.result).filter(Boolean),
          ...prev,
        ]);
      }
      toast({
        title: `Batch complete: ${ok.length}/${done} succeeded`,
        description: bad.length > 0
          ? `${bad.length} file${bad.length === 1 ? "" : "s"} failed — see details below.`
          : "All files added to your library.",
        variant: bad.length > 0 ? "destructive" : undefined,
      });
      // Only errored rows remain in staging.
      return bad;
    });
  };

  // -------- Pasted-text submit (only when no files staged) --------
  const submitPasted = () => {
    if (!shared.product_model.trim()) {
      toast({ title: "Product model is required", variant: "destructive" });
      return;
    }
    if (!pastedBody.trim()) {
      toast({ title: "Nothing to upload", description: "Paste text or attach files.", variant: "destructive" });
      return;
    }
    if (!shared.title.trim()) {
      toast({ title: "Title required", description: "Give the pasted document a title.", variant: "destructive" });
      return;
    }
    const metadata = buildMetadataPayload(shared, undefined);
    textMut.mutate({ ...metadata, body: pastedBody });
  };

  // -------- Derived helpers --------
  const anyFiles = files.length > 0;
  const isBatch = files.length > 1;
  const pending = uploadingKey !== null || textMut.isPending;

  // v0.9.21: single-file upload now blocks at the button when product_model
  // is empty, so users see the required rule before they click.
  const singleFileMissingModel = anyFiles && !isBatch && !shared.product_model.trim();
  // v0.9.30: successful results now live in two places while a batch is
  // in progress: still-staged rows (`files` with status="done", cleared on
  // batch complete) and the persistent history (`completedUploads`). Merge
  // both so the results panel below the form always reflects everything the
  // user just uploaded, whether or not the row was cleared.
  const successResults = useMemo(() => {
    const inStaging = files.filter((f) => f.status === "done").map((f) => f.result);
    return [...inStaging, ...completedUploads];
  }, [files, completedUploads]);

  // -------- Render --------
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card className="hover-elevate" data-testid="card-upload-form">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <Sparkles className="h-4 w-4 text-primary" />
            Upload documents
          </CardTitle>
          <CardDescription>
            Drop one or many files at once — PDF, DOCX, TXT, or Markdown (up to 150 MB each). Every excerpt gets the metadata below attached, which powers the filters in Query.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Dropzone */}
          <Dropzone
            onFiles={stageFiles}
            hasFiles={anyFiles}
            fileInput={fileInput}
          />

          {/* Staged files list */}
          {anyFiles && (
            <FileList
              files={files}
              isBatch={isBatch}
              mode={mode}
              onModeChange={setMode}
              onRemove={removeFile}
              onClear={clearAll}
              onToggle={toggleExpanded}
              onPatchMeta={updateFileMeta}
              duplicateNames={duplicateNames}
            />
          )}

          {/*
            v0.9.21: metadata behaviour by staging state
              - No files staged: show the Metadata form (used by pasted-text uploads).
              - Exactly one file staged: show the Metadata form (single-file upload).
              - Multiple files staged: hide the form entirely and show an info banner
                explaining that metadata is set per document from the Library tab
                after the batch finishes. Prevents the old failure mode where any
                stray value in the shared form silently applied to every file.
          */}
          {!isBatch && (
            <>
              <div className="flex items-center gap-2 border-t border-border pt-4">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Metadata
                </span>
              </div>
              <MetaForm
                value={shared}
                onChange={setShared}
                showTitle={!anyFiles}
                testIdPrefix=""
              />
            </>
          )}

          {isBatch && (
            <div
              className="flex items-start gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-100"
              data-testid="batch-metadata-banner"
            >
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="space-y-1 leading-relaxed">
                <div className="font-semibold">Metadata is not set during batch upload.</div>
                <div>
                  Each file will be added with just its filename as the title. After the
                  batch finishes, open the <span className="font-medium">Library</span> tab,
                  click the pencil icon on each new document, and set the Product model and
                  any other fields you want to filter by later.
                </div>
              </div>
            </div>
          )}

          {/* Paste text (only when no files staged) */}
          {!anyFiles && (
            <Field label="Or paste text directly (used only if no file is attached)">
              <Textarea
                value={pastedBody}
                onChange={(e) => setPastedBody(e.target.value)}
                className="min-h-[180px] font-mono text-xs"
                data-testid="input-body"
                placeholder="Paste markdown or plain text here. Use # / ## / ### to define sections for better splitting."
              />
            </Field>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-3 pt-2">
            {anyFiles ? (
              <Button
                onClick={runBatch}
                disabled={pending || singleFileMissingModel}
                data-testid="button-ingest"
                title={singleFileMissingModel ? "Product model is required" : undefined}
              >
                {pending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Uploading… ({files.filter((f) => f.status === "done").length}/{files.length})
                  </>
                ) : (
                  <>
                    {batchDone ? "Upload again" : isBatch ? `Upload ${files.length} files` : "Upload document"}
                    <ArrowRight className="ml-2 h-3.5 w-3.5" />
                  </>
                )}
              </Button>
            ) : (
              <Button onClick={submitPasted} disabled={textMut.isPending} data-testid="button-ingest">
                {textMut.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Uploading…
                  </>
                ) : (
                  <>
                    Upload text
                    <ArrowRight className="ml-2 h-3.5 w-3.5" />
                  </>
                )}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Result panel */}
      <div className="space-y-6">
        <Card className="hover-elevate" data-testid="card-preview">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl">
              <FileText className="h-4 w-4 text-primary" />
              Upload result
            </CardTitle>
            <CardDescription>
              {successResults.length > 0
                ? `Added ${successResults.length} document${successResults.length === 1 ? "" : "s"} to your library.`
                : pastedResult
                ? `Added ${pastedResult.chunks.length} searchable excerpts to your library.`
                : "Submit the form to see the records added to your library."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {successResults.length === 0 && !pastedResult ? (
              <div
                className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground"
                data-testid="text-preview-empty"
              >
                No document uploaded yet. Drop files above or paste text, then click Upload.
              </div>
            ) : successResults.length > 0 ? (
              <BatchResultView results={successResults} />
            ) : (
              <SingleResultView result={pastedResult} />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Dropzone
// -----------------------------------------------------------------------------

function Dropzone({
  onFiles,
  hasFiles,
  fileInput,
}: {
  onFiles: (files: FileList | File[] | null) => void;
  hasFiles: boolean;
  fileInput: React.RefObject<HTMLInputElement>;
}) {
  const [dragging, setDragging] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        onFiles(e.dataTransfer.files);
      }}
      onClick={() => fileInput.current?.click()}
      className={
        "relative flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 text-center transition-colors " +
        (dragging
          ? "border-primary bg-primary/5"
          : hasFiles
          ? "border-primary/40 bg-primary/5"
          : "border-border bg-muted/20 hover:border-primary/40 hover:bg-primary/5")
      }
      data-testid="dropzone-file"
    >
      <input
        ref={fileInput}
        type="file"
        accept={ACCEPT_MIME + "," + ACCEPT_EXT.join(",")}
        multiple
        className="hidden"
        onChange={(e) => {
          onFiles(e.target.files);
          // Reset value so re-selecting the same file still fires onChange
          if (fileInput.current) fileInput.current.value = "";
        }}
        data-testid="input-file"
      />
      <UploadIcon className="mb-2 h-8 w-8 text-muted-foreground" />
      <div className="text-sm font-medium">
        {hasFiles ? "Drop more files to add to the batch" : "Drop one or more files here, or click to browse"}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">PDF · DOCX · TXT · Markdown · up to 150 MB each</div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// File list (staged batch)
// -----------------------------------------------------------------------------

function FileList({
  files,
  isBatch,
  mode,
  onModeChange,
  onRemove,
  onClear,
  onToggle,
  onPatchMeta,
  duplicateNames,
}: {
  files: FileEntry[];
  isBatch: boolean;
  mode: UploadMode;
  onModeChange: (m: UploadMode) => void;
  onRemove: (key: string) => void;
  onClear: () => void;
  onToggle: (key: string) => void;
  onPatchMeta: (key: string, patch: Partial<Meta>) => void;
  // v0.9.23: lowercase filename stems already in the library. FileRow reads
  // this to render a red "already in library" warning inline.
  duplicateNames: Set<string>;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-3" data-testid="file-list">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {files.length} file{files.length === 1 ? "" : "s"} staged
        </div>
        <div className="flex items-center gap-2">
          {/*
            v0.9.21: the per-file-vs-shared metadata mode selector is retired.
            Multi-file uploads always skip metadata now; users set it per doc
            from the Library edit dialog after the batch finishes.
          */}
          <Button
            variant="ghost"
            size="sm"
            onClick={onClear}
            className="h-8 text-xs"
            data-testid="button-clear-all"
          >
            Clear all
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        {files.map((f) => {
          const stem = f.file.name.replace(/\.[^./\\]+$/, "").toLowerCase();
          return (
            <FileRow
              key={f.key}
              entry={f}
              perFileMode={isBatch && mode === "batch-perfile"}
              onRemove={() => onRemove(f.key)}
              onToggle={() => onToggle(f.key)}
              onPatchMeta={(patch) => onPatchMeta(f.key, patch)}
              isDuplicate={duplicateNames.has(stem)}
            />
          );
        })}
      </div>
    </div>
  );
}

function FileRow({
  entry,
  perFileMode,
  onRemove,
  onToggle,
  onPatchMeta,
  isDuplicate,
}: {
  entry: FileEntry;
  perFileMode: boolean;
  onRemove: () => void;
  onToggle: () => void;
  onPatchMeta: (patch: Partial<Meta>) => void;
  // v0.9.23: true if a document with the same filename stem is already in the
  // library. Renders an inline red warning under the filename. Non-blocking
  // — the user can still submit; the server will accept the upload.
  isDuplicate: boolean;
}) {
  const sizeKb = (entry.file.size / 1024).toFixed(1);
  const sizeMb = (entry.file.size / 1024 / 1024).toFixed(1);
  const sizeText = entry.file.size > 1024 * 1024 ? `${sizeMb} MB` : `${sizeKb} KB`;

  return (
    <div
      className="rounded-md border border-border bg-background"
      data-testid={`file-row-${entry.key}`}
    >
      <div className="flex items-center gap-3 p-3">
        {perFileMode && (
          <button
            type="button"
            onClick={onToggle}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            data-testid={`button-expand-${entry.key}`}
            aria-label="Toggle metadata"
          >
            {entry.expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        )}
        <FileUp className="h-5 w-5 flex-shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" data-testid={`text-file-name-${entry.key}`}>
            {entry.file.name}
          </div>
          {isDuplicate && (
            <div
              className="mt-1 flex items-center gap-1.5 text-[11px] font-medium text-red-600 dark:text-red-400"
              data-testid={`text-dupe-warning-${entry.key}`}
            >
              <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span>A document with this filename is already in the library. Uploading will create a duplicate.</span>
            </div>
          )}
          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            <span>{sizeText}</span>
            {perFileMode && entry.meta.product_model && (
              <>
                <span>·</span>
                <span className="truncate">
                  <span className="font-mono">{entry.meta.product_model}</span> · {entry.meta.document_type.replace(/_/g, " ")}
                </span>
              </>
            )}
            {entry.message && (
              <>
                <span>·</span>
                <span className={entry.status === "error" ? "text-destructive" : ""}>{entry.message}</span>
              </>
            )}
          </div>
        </div>
        <StatusBadge status={entry.status} />
        {entry.status !== "uploading" && (
          <button
            type="button"
            onClick={onRemove}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            data-testid={`button-remove-${entry.key}`}
            aria-label="Remove file"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {perFileMode && entry.expanded && (
        <div className="space-y-4 border-t border-border p-3">
          <MetaForm value={entry.meta} onChange={(m: Partial<Meta>) => onPatchMeta(m)} showTitle={true} testIdPrefix={`file-${entry.key}-`} compact />
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: FileStatus }) {
  if (status === "uploading") {
    return (
      <Badge variant="outline" className="gap-1 text-[10px]">
        <Loader2 className="h-3 w-3 animate-spin" />
        Uploading
      </Badge>
    );
  }
  if (status === "done") {
    return (
      <Badge variant="outline" className="gap-1 border-emerald-400/40 bg-emerald-500/10 text-[10px] text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="h-3 w-3" />
        Done
      </Badge>
    );
  }
  if (status === "error") {
    return (
      <Badge variant="outline" className="gap-1 border-destructive/40 bg-destructive/10 text-[10px] text-destructive">
        <AlertCircle className="h-3 w-3" />
        Failed
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-[10px] text-muted-foreground">
      Pending
    </Badge>
  );
}

// -----------------------------------------------------------------------------
// MetaForm — reusable metadata editor (shared block + per-file cards)
// -----------------------------------------------------------------------------

// The `Partial<Meta>` overload here lets the per-file card pass patches instead
// of full state — cleaner than lifting the setter each time.
type MetaOnChange = ((next: Meta) => void) | ((patch: Partial<Meta>) => void);

function MetaForm({
  value,
  onChange,
  showTitle,
  testIdPrefix,
  compact,
}: {
  value: Meta;
  onChange: MetaOnChange;
  showTitle: boolean;
  testIdPrefix: string;
  compact?: boolean;
}) {
  const { data: documentTypes } = useDocumentTypes();
  // Support both signatures — pass a full object if the setter is a state
  // setter, or a patch if it's `onPatchMeta`.
  const set = (patch: Partial<Meta>) => {
    // A React state setter always receives one arg — check arity as a heuristic.
    // The MetaForm passes a full merged Meta by default (safer default).
    (onChange as (n: Meta) => void)({ ...value, ...patch });
  };

  return (
    <div className="space-y-4">
      {showTitle && (
        <Row>
          <Field label="Title (auto-filled from filename if blank)">
            <Input
              value={value.title}
              onChange={(e) => set({ title: e.target.value })}
              data-testid={`${testIdPrefix}input-title`}
              placeholder="e.g. TASKalfa 5054ci Admin Guide"
            />
          </Field>
        </Row>
      )}
      {!compact && (
        <Row>
          <Field label="Subtitle">
            <Input
              value={value.subtitle}
              onChange={(e) => set({ subtitle: e.target.value })}
              data-testid={`${testIdPrefix}input-subtitle`}
              placeholder="Optional"
            />
          </Field>
          <Field label="Document type">
            <Select value={value.document_type} onValueChange={(v) => set({ document_type: v })}>
              <SelectTrigger data-testid={`${testIdPrefix}select-document-type`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {documentTypes?.types.map((type) => (
                  <SelectItem key={type.key} value={type.key}>
                    <span className="inline-flex items-center gap-2">
                      <DocTypeDot color={type.color} />
                      {type.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </Row>
      )}
      {compact && (
        <Row>
          <Field label="Document type">
            <Select value={value.document_type} onValueChange={(v) => set({ document_type: v })}>
              <SelectTrigger data-testid={`${testIdPrefix}select-document-type`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {documentTypes?.types.map((type) => (
                  <SelectItem key={type.key} value={type.key}>
                    <span className="inline-flex items-center gap-2">
                      <DocTypeDot color={type.color} />
                      {type.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Confidentiality">
            <Select value={value.confidentiality} onValueChange={(v) => set({ confidentiality: v })}>
              <SelectTrigger data-testid={`${testIdPrefix}select-confidentiality`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONFIDENTIALITY.map((v) => (
                  <SelectItem key={v} value={v}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </Row>
      )}
      <Row>
        <Field label="Product family">
          <Input
            value={value.product_family}
            onChange={(e) => set({ product_family: e.target.value })}
            data-testid={`${testIdPrefix}input-product-family`}
            placeholder="e.g. Model 3500"
          />
        </Field>
        <RequiredField label="Product model">
          <ProductModelCombobox
            value={value.product_model}
            onChange={(v) => set({ product_model: v })}
            testId={`${testIdPrefix}combobox-product-model`}
          />
        </RequiredField>
      </Row>
      {!compact && (
        <>
          <Row>
            <Field label="Product version">
              <Input
                value={value.product_version}
                onChange={(e) => set({ product_version: e.target.value })}
                data-testid={`${testIdPrefix}input-product-version`}
                placeholder="Optional"
              />
            </Field>
            <Field label="Revision">
              <Input
                value={value.firmware_version}
                onChange={(e) => set({ firmware_version: e.target.value })}
                data-testid={`${testIdPrefix}input-firmware-version`}
                placeholder="Optional"
              />
            </Field>
          </Row>
          <Row>
            <Field label="Release channel">
              <Select value={value.release_channel} onValueChange={(v) => set({ release_channel: v })}>
                <SelectTrigger data-testid={`${testIdPrefix}select-release-channel`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RELEASE_CHANNELS.map((v) => (
                    <SelectItem key={v} value={v}>
                      {releaseChannelLabel(v)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Confidentiality">
              <Select value={value.confidentiality} onValueChange={(v) => set({ confidentiality: v })}>
                <SelectTrigger data-testid={`${testIdPrefix}select-confidentiality`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONFIDENTIALITY.map((v) => (
                    <SelectItem key={v} value={v}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </Row>
          <Field label="Audience (click to toggle)">
            <div className="flex flex-wrap gap-1.5">
              {AUDIENCES.map((a) => {
                const on = value.audience.includes(a);
                return (
                  <button
                    key={a}
                    type="button"
                    onClick={() =>
                      set({
                        audience: on ? value.audience.filter((x) => x !== a) : [...value.audience, a],
                      })
                    }
                    data-testid={`${testIdPrefix}chip-audience-${a}`}
                    className={
                      "rounded-md border px-2 py-1 text-xs transition-colors " +
                      (on
                        ? "border-primary/40 bg-primary/10 text-foreground"
                        : "border-border bg-secondary text-muted-foreground hover:text-foreground")
                    }
                  >
                    {a.replace(/_/g, " ")}
                  </button>
                );
              })}
            </div>
          </Field>
          <Row>
            {/* v0.9.29: Tags is now a chip combobox with global autocomplete
                (see TagsCombobox). Allowed tenants input removed — single-tenant
                deployment doesn't need it; DB column + Zod schema + server
                route still support it for future multi-tenant use. */}
            <TagsCombobox
              value={value.tags}
              onChange={(next: string) => set({ tags: next })}
              testId={`${testIdPrefix}input-tags`}
            />
          </Row>
        </>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Batch result view (list of successful uploads with links)
// -----------------------------------------------------------------------------

function BatchResultView({ results }: { results: any[] }) {
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-emerald-400/30 bg-emerald-500/5 p-3 text-sm">
        <div className="mb-1 flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="h-4 w-4" />
          {results.length} document{results.length === 1 ? "" : "s"} added
        </div>
        <div className="text-xs text-muted-foreground">
          Total{" "}
          <span className="font-mono">
            {results.reduce((sum, r) => sum + (r.chunks?.length ?? 0), 0)}
          </span>{" "}
          excerpts across all documents.
        </div>
      </div>
      <div className="max-h-[400px] space-y-2 overflow-auto">
        {results.map((r) => (
          <div key={r.document.id} className="rounded-md border border-border bg-muted/20 p-2 text-xs">
            {/* v0.9.30: title accent color propagated from Library. Uploads
                default to null, but re-ingests of previously colored docs
                keep their accent, and Query/Library results match. */}
            <div
              className="font-medium"
              style={{ color: r.document.title_color ?? undefined }}
            >
              {r.document.title}
            </div>
            <div className="mt-0.5 flex flex-wrap gap-1 text-[11px] text-muted-foreground">
              <span className="font-mono">{r.document.product_model}</span>
              <span>·</span>
              <span>{r.document.document_type.replace(/_/g, " ")}</span>
              {r.extraction?.page_count && (
                <>
                  <span>·</span>
                  <span>{r.extraction.page_count} pages</span>
                </>
              )}
              <span>·</span>
              <span>{r.chunks.length} excerpts</span>
            </div>
          </div>
        ))}
      </div>
      <div className="flex gap-2 pt-2">
        <Link href="/library" className="text-xs text-primary hover:underline" data-testid="link-library">
          View in Library →
        </Link>
        <Link href="/query" className="text-xs text-primary hover:underline" data-testid="link-query">
          Try a query →
        </Link>
      </div>
    </div>
  );
}

function SingleResultView({ result }: { result: any }) {
  return (
    <div className="space-y-4">
      {result.extraction && (
        <div className="flex flex-wrap gap-2 text-xs">
          <Badge variant="outline" className="font-mono">
            {result.extraction.format}
          </Badge>
          {result.extraction.page_count && (
            <Badge variant="outline" className="font-mono">
              {result.extraction.page_count} pages
            </Badge>
          )}
          <Badge variant="outline" className="font-mono">
            {result.extraction.char_count.toLocaleString()} chars extracted
          </Badge>
          <Badge variant="outline" className="font-mono">
            {result.chunks.length} excerpts
          </Badge>
        </div>
      )}
      <div className="flex items-center gap-2 text-sm">
        <Badge variant="secondary" className="font-mono text-[10px]">
          parent_document
        </Badge>
        <span className="truncate font-mono text-xs text-muted-foreground">{result.document.id}</span>
      </div>
      <JsonBlock data={result.document} />
      <div className="flex items-center gap-2 pt-2 text-sm">
        <Badge variant="secondary" className="font-mono text-[10px]">
          chunk
        </Badge>
        <span className="text-xs text-muted-foreground">1 of {result.chunks.length}</span>
      </div>
      <JsonBlock data={result.chunks[0]} />
      <div className="flex gap-2 pt-2">
        <Link href="/library" className="text-xs text-primary hover:underline" data-testid="link-library">
          View in Library →
        </Link>
        <Link href="/query" className="text-xs text-primary hover:underline" data-testid="link-query">
          Try a query →
        </Link>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function splitList(s: string): string[] {
  return s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
}

function buildMetadataPayload(meta: Meta, filename: string | undefined): any {
  const defaultTitle = filename ? filename.replace(/\.[^.]+$/, "") : undefined;
  return {
    title: meta.title.trim() || defaultTitle,
    subtitle: meta.subtitle.trim() || undefined,
    document_type: meta.document_type,
    audience: meta.audience,
    product_family: meta.product_family.trim() || undefined,
    product_model: meta.product_model.trim(),
    product_version: meta.product_version.trim() || undefined,
    firmware_version: meta.firmware_version.trim() || undefined,
    release_channel: meta.release_channel || undefined,
    confidentiality: meta.confidentiality,
    // v0.9.29: UI input removed for single-tenant deployments. Always send
    // an empty array so the server-side JSON column stays well-formed.
    allowed_tenants: [] as string[],
    tags: splitList(meta.tags),
    chunk_size_tokens: 220,
    chunk_overlap_tokens: 40,
  };
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2">{children}</div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

// v0.9.30: RequiredField was hoisted into components/ProductModelCombobox.tsx
// so the Library edit dialog can render the same red "(Required)" hint. It's
// re-imported at the top of this file.

// -----------------------------------------------------------------------------
// TagsCombobox re-export
//
// v0.9.30: the component moved to components/TagsCombobox.tsx so the Library
// edit dialog can use the same implementation. This file still re-exports it
// so the existing `import { TagsCombobox } from "./upload"` in library.tsx
// keeps working; new call sites should import from the shared path.
// -----------------------------------------------------------------------------
export { TagsCombobox } from "@/components/TagsCombobox";

export function JsonBlock({ data }: { data: any }) {
  return (
    <pre
      className="max-h-[420px] overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-[11px] leading-relaxed"
      data-testid="pre-json"
    >
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}
