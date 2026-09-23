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
  ScanSearch,
} from "lucide-react";
import { Link } from "wouter";
import {
  AUDIENCES as SHARED_AUDIENCES,
  CONFIDENTIALITY as SHARED_CONFIDENTIALITY,
  RELEASE_CHANNELS as SHARED_RELEASE_CHANNELS,
  releaseChannelLabel,
} from "@shared/schema";
import { ProductModelCombobox } from "@/components/ProductModelCombobox";
import { ProductFamilyCombobox } from "@/components/ProductFamilyCombobox";
import { useDocumentTypes, documentTypeColor } from "@/lib/documentTypes";
import { DocTypeDot } from "@/components/DocTypeDot";
// v0.9.30: TagsCombobox lives in its own component now (see the bottom of
// this file for a re-export that keeps library.tsx's `from "./upload"` path
// working). We still import it here for use inside MetaForm below.
import { TagsCombobox } from "@/components/TagsCombobox";
// v1.1.0: locked filename -> title parser. See client/src/lib/fix-title.ts.
import { fixTitle } from "@/lib/fix-title";
import { FixTitleButton } from "@/components/FixTitleButton";
// v1.1.8: mode-to-meta selection for the batch loop. See
// client/src/lib/upload-meta-select.ts for the history behind extracting this.
import { selectMetaForFile } from "@/lib/upload-meta-select";
import { deriveProduct } from "@/lib/derive-product";
// v1.1.0: auto-classify Document type from filename codes (item 9).
import { detectDocType } from "@/lib/detect-doctype";
import { useFilenameCodes } from "@/lib/filenameCodes";
// v1.2.4 (item 2): filename phrases (fallback classifier). Codes are the
// primary signal; phrases run only if the code detector returns null. Pass
// both mappings to detectDocType() so it can honor the code-wins rule.
import { useFilenamePhrases } from "@/lib/filenamePhrases";
// v1.1.0 item 5: tab-persistent upload workspace. The 8 useState fields
// that describe live upload work (staged files, per-file metadata,
// shared metadata, mode, batch loop status, success card history) now
// back onto a module-level singleton so a tab switch no longer discards
// them. Genuinely local UI state (dragging, dialog opens, file input
// ref, debouncedNames) still uses useState.
import { uploadTabStore } from "@/lib/uploadTabStore";
import { useStoreField } from "@/lib/tabStore";
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

// v1.0.7.4: added .rtf (application/rtf, text/rtf). RTF ingests via the
// homegrown stripper and gets a viewer with DOCX-style toolbar controls.
const ACCEPT_EXT = [".pdf", ".docx", ".rtf", ".txt", ".md", ".markdown"];
const ACCEPT_MIME =
  "application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/rtf,text/rtf,text/plain,text/markdown";
const MAX_BYTES = 150 * 1024 * 1024; // 150 MB — matches server cap

// v1.2.4: folder drop on the Upload dropzone. Browsers only populate
// dataTransfer.files with file entries; a dropped folder shows up in
// dataTransfer.items[] as a directory entry and does not appear in .files
// at all. We walk items with webkitGetAsEntry(), recurse directories, and
// collect every accepted file plus a skipped list with a fixed-vocabulary
// reason. Recursion depth is bounded only by the browser's own entry API
// (no hardcoded max); the existing per-file MAX_BYTES check is enforced
// alongside the extension filter. OS metadata / hidden files are silently
// dropped (not counted as skipped).
const SILENT_SKIP_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const SILENT_SKIP_DIR_NAMES = new Set(["__MACOSX"]);

type FolderSkipReason = "unsupported" | "too-large";
type FolderSkip = { path: string; reason: FolderSkipReason; ext?: string };
type FolderDropResult = {
  files: File[]; // in traversal order (breadth within a directory, depth across)
  skipped: FolderSkip[];
  subfolderCount: number; // number of subdirectories descended into (excludes the root)
  folderName: string; // best-effort root folder name, empty string if unavailable
};

// Shared by directory drops and the folder picker. The picker supplies the
// browser's webkitRelativePath; entry traversal supplies the same relative
// path shape. Keep filtering in one place rather than duplicating policy.
function isIgnoredFolderPath(path: string): boolean {
  return path.split("/").some((name) =>
    name.startsWith(".") || SILENT_SKIP_NAMES.has(name) || SILENT_SKIP_DIR_NAMES.has(name),
  );
}

function collectFolderFile(file: File, path: string, result: FolderDropResult): void {
  if (isIgnoredFolderPath(path)) return;
  const lower = file.name.toLowerCase();
  const dotIdx = lower.lastIndexOf(".");
  const ext = dotIdx >= 0 ? lower.slice(dotIdx) : "";
  if (!ACCEPT_EXT.includes(ext)) {
    result.skipped.push({ path, reason: "unsupported", ext });
  } else if (file.size > MAX_BYTES) {
    result.skipped.push({ path, reason: "too-large" });
  } else {
    result.files.push(file);
  }
}

function collectFolderSelection(files: File[]): FolderDropResult {
  const result: FolderDropResult = {
    files: [], skipped: [], subfolderCount: 0, folderName: "",
  };
  const directories = new Set<string>();
  for (const file of files) {
    const path = file.webkitRelativePath || file.name;
    const parts = path.split("/");
    if (!result.folderName && parts.length > 1) result.folderName = parts[0];
    if (isIgnoredFolderPath(path)) continue;
    // The FileList cannot expose empty directories. Count the non-root
    // directories represented in its paths, including unsupported files.
    for (let i = 2; i < parts.length; i++) {
      directories.add(parts.slice(0, i).join("/"));
    }
    collectFolderFile(file, path, result);
  }
  result.subfolderCount = directories.size;
  return result;
}

// Read a FileSystemDirectoryEntry until its reader drains. Browsers cap
// each readEntries call at ~100 entries, so we loop until an empty array
// comes back. Any read error rejects the whole recursion for the caller
// to swallow gracefully.
async function readAllEntries(dirEntry: any): Promise<any[]> {
  const reader = dirEntry.createReader();
  const all: any[] = [];
  // Loop until the reader returns an empty array.
  // Guard against a pathological browser that never drains by capping to a
  // huge number of iterations; each iteration adds up to ~100 entries so
  // 10_000 iterations = 1M entries, far beyond any real folder drop.
  for (let i = 0; i < 10000; i++) {
    const batch: any[] = await new Promise((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (!batch || batch.length === 0) break;
    all.push(...batch);
  }
  return all;
}

async function entryToFile(fileEntry: any): Promise<File> {
  return new Promise((resolve, reject) => {
    fileEntry.file(resolve, reject);
  });
}

// Walks a single top-level entry (file or directory) and appends to the
// mutable result. `relPrefix` is the path within the dropped folder, used
// only for the skipped-file expander display.
async function walkEntry(
  entry: any,
  relPrefix: string,
  result: FolderDropResult,
  seenPaths: Set<string>,
): Promise<void> {
  if (!entry) return;
  const name: string = entry.name || "";
  const rel = relPrefix ? `${relPrefix}/${name}` : name;
  if (isIgnoredFolderPath(rel)) return;
  if (entry.isFile) {
    let f: File;
    try {
      f = await entryToFile(entry);
    } catch {
      return; // unreadable file entries are silently dropped
    }
    collectFolderFile(f, rel, result);
    return;
  }
  if (entry.isDirectory) {
    // Follow symlinks/directories only once per unique resolved path.
    // fullPath is the entry API's canonical path inside the drop root; it is
    // enough to detect the rare cycle case without a resolved-target lookup.
    const key: string = entry.fullPath || (relPrefix ? `${relPrefix}/${name}` : name);
    if (seenPaths.has(key)) return;
    seenPaths.add(key);
    if (relPrefix) result.subfolderCount += 1;
    const children = await readAllEntries(entry);
    const nextPrefix = relPrefix ? `${relPrefix}/${name}` : name;
    for (const child of children) {
      await walkEntry(child, nextPrefix, result, seenPaths);
    }
  }
}

// Collect every accepted file from a DataTransferItemList. Handles a mix
// of plain files and folders in the same drop. Files at the root of the
// drop are collected with an empty relPrefix; folders push a trailing
// slash into the traversal via walkEntry. Returns a folderName derived
// from the FIRST directory in the drop (used in the summary toast); when
// the drop contains no directories, folderName is empty.
async function collectFolderDrop(items: DataTransferItemList): Promise<FolderDropResult> {
  const result: FolderDropResult = {
    files: [],
    skipped: [],
    subfolderCount: 0,
    folderName: "",
  };
  const seenPaths = new Set<string>();
  // Resolve entries up front -- webkitGetAsEntry() must be called before
  // any awaits, since the DataTransferItem is invalidated after the drop
  // event handler returns.
  const entries: any[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind !== "file") continue;
    const anyItem = item as any;
    const entry =
      typeof anyItem.webkitGetAsEntry === "function" ? anyItem.webkitGetAsEntry() : null;
    if (entry) entries.push(entry);
  }
  for (const entry of entries) {
    if (!result.folderName && entry.isDirectory) result.folderName = entry.name || "";
    // Root files have no prefix. Root folders start their own prefix inside walkEntry.
    await walkEntry(entry, "", result, seenPaths);
  }
  return result;
}

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
  //
  // v1.1.0 item 5: backed by uploadTabStore so it survives tab switches.
  // Setter signature is identical to useState's, so no JSX changes.
  const [shared, setShared] = useStoreField(uploadTabStore, "shared");

  // Files staged for upload. This holds 0..N files. When length === 1 we
  // effectively render the single-file mode; when length > 1 the batch UI
  // takes over.
  const [files, setFiles] = useStoreField(uploadTabStore, "files");
  // v0.9.30: after a batch upload succeeds we clear the successful rows out
  // of `files` (see the batch-complete handler for the why). The results are
  // stashed here so the success card below the form keeps rendering them.
  const [completedUploads, setCompletedUploads] = useStoreField(uploadTabStore, "completedUploads");

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
  const [mode, setMode] = useStoreField(uploadTabStore, "mode");

  // v1.1.9: shared-mode auto-fix titles toggle. Backed by the store so it
  // survives tab switches like the other shared-mode fields.
  const [autoFixTitles, setAutoFixTitles] = useStoreField(uploadTabStore, "autoFixTitles");

  // For pasted-text ingest (kept from the previous version)
  const [pastedBody, setPastedBody] = useStoreField(uploadTabStore, "pastedBody");
  const [pastedResult, setPastedResult] = useStoreField(uploadTabStore, "pastedResult");

  // Currently-uploading file key. Non-null means the sequential loop is running.
  const [uploadingKey, setUploadingKey] = useStoreField(uploadTabStore, "uploadingKey");
  const [batchDone, setBatchDone] = useStoreField(uploadTabStore, "batchDone");

  // v1.1.0: filename-code -> Document type mapping, cached by React Query.
  // Used at staging time for per-file auto-classification and by the Detect
  // type button (item 9). undefined while the first fetch is in flight --
  // classification just skips until it arrives.
  const { data: filenameCodes } = useFilenameCodes();
  const { data: filenamePhrases } = useFilenamePhrases();

  // v1.1.2 (field-test fix): auto-classify the SINGLE-file upload form.
  //
  // The v1.1.0 auto-classifier only ever wrote into each entry's `perFileMeta`
  // (see stageFiles below). But the single-file layout renders MetaForm bound
  // to `shared`, and submitSingle sends `shared` too -- `files[0].meta` is
  // never read when only one file is staged. Net effect: automatic Document
  // type detection silently did nothing for single-file uploads, for EVERY
  // code, not just TB. Per-file batch mode was unaffected.
  //
  // Running it as an effect rather than inside stageFiles also closes the
  // mapping-not-loaded-yet gap the stageFiles comment acknowledges: if the
  // codes arrive after the drop, this re-runs and classifies then.
  //
  // The empty/"document" guard preserves the "never overwrite a user
  // selection" rule, so a type the user chose himself is never clobbered.
  useEffect(() => {
    if (files.length !== 1) return;
    // v1.2.4: even if there are no code rows, we still want to try phrases,
    // so this early-return now requires BOTH to be empty.
    if (!filenameCodes?.mappings?.length && !filenamePhrases?.mappings?.length) return;
    const current = (shared.document_type || "").trim();
    if (current !== "" && current !== "document") return;
    const detected = detectDocType(
      files[0].file.name,
      filenameCodes?.mappings ?? [],
      filenamePhrases?.mappings ?? [],
    );
    if (detected && detected !== current) {
      setShared({ ...shared, document_type: detected });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, filenameCodes, filenamePhrases, shared.document_type]);

  // v1.1.3: auto-populate Product model / Product family for the SINGLE-file
  // form, mirroring the doc-type effect directly above.
  //
  // Two rules, both non-negotiable:
  //  * Fill ONLY when the field is empty. A value the user typed is never
  //    overwritten, and neither is one he cleared on purpose -- clearing only
  //    re-triggers this if the staged file also changes.
  //  * A blank result is a legitimate outcome. Product model is optional as of
  //    this release, and guessing is worse than leaving it empty.
  //
  // The doc-type codes are passed in LIVE so bulletin numbers like TB128 are
  // excluded from model matching, including codes the user added himself.
  useEffect(() => {
    if (files.length !== 1) return;
    const codes = (filenameCodes?.mappings ?? []).map((m) => m.code);
    const derived = deriveProduct(files[0].file.name, codes);
    const patch: Partial<typeof shared> = {};
    if (!(shared.product_model || "").trim() && derived.product_model) {
      patch.product_model = derived.product_model;
    }
    if (!(shared.product_family || "").trim() && derived.product_family) {
      patch.product_family = derived.product_family;
    }
    if (Object.keys(patch).length > 0) setShared({ ...shared, ...patch });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, filenameCodes, shared.product_model, shared.product_family]);

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["/api/document-types"] });
    qc.invalidateQueries({ queryKey: ["/api/stats"] });
    qc.invalidateQueries({ queryKey: ["/api/documents"] });
    qc.invalidateQueries({ queryKey: ["/api/facets"] });
    // v1.1.0: also refresh the page-render status.
    //
    // RenderStatusIndicator polls /api/render/status on a slow 10s cadence while
    // it believes the queue is idle, and only speeds up to 2s once it sees work.
    // A fresh upload enqueues render work immediately, so without this
    // invalidation the indicator could sit stale for up to ~10s after an upload
    // finished -- long enough to look like rendering never started.
    qc.invalidateQueries({ queryKey: ["/api/render/status"] });
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
      // Per-file metadata starts as a copy of the shared form — this way if
      // you switch to per-file mode you already have sensible defaults.
      const perFileMeta: Meta = {
        ...shared,
        // Auto-fill title from filename so per-file editing is fast
        title: f.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "),
      };
      // v1.1.0 (item 9): per-file Document type auto-classification. Runs
      // ONLY when the inherited doc_type is the default fallback (empty or
      // "document"). If the user set a non-default value in the shared field
      // before staging, per-file inherits that and we do not override -- this
      // upholds the "never overwrite a user selection" rule. Detection runs
      // per-file on the RAW filename, never on the shared field. If the
      // mapping hasn't loaded yet, we skip silently -- newly-added files
      // after it loads will still classify, and manual Detect always works.
      const inheritedDocType = (perFileMeta.document_type || "").trim();
      if (
        (filenameCodes?.mappings?.length || filenamePhrases?.mappings?.length) &&
        (inheritedDocType === "" || inheritedDocType === "document")
      ) {
        const detected = detectDocType(
          f.name,
          filenameCodes?.mappings ?? [],
          filenamePhrases?.mappings ?? [],
        );
        if (detected) perFileMeta.document_type = detected;
      }
      // v1.1.3: per-file Product model / family auto-population. Same
      // "only fill an empty field" rule as the single-file effect above --
      // perFileMeta inherits the shared form, so a value the user typed there
      // before staging is inherited and left alone.
      {
        const codes = (filenameCodes?.mappings ?? []).map((m) => m.code);
        const derived = deriveProduct(f.name, codes);
        if (!(perFileMeta.product_model || "").trim() && derived.product_model) {
          perFileMeta.product_model = derived.product_model;
        }
        if (!(perFileMeta.product_family || "").trim() && derived.product_family) {
          perFileMeta.product_family = derived.product_family;
        }
      }
      accepted.push({
        key,
        file: f,
        status: "pending",
        message: "",
        result: null,
        meta: perFileMeta,
        expanded: false,
      });
    }

    if (rejected > 0) {
      toast({
        title: `Skipped ${rejected} file${rejected === 1 ? "" : "s"}`,
        description: "Only PDF, DOCX, RTF, TXT, or Markdown files up to 150 MB are supported.",
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

  // v1.2.4: folder drop. Recurses the dropped entry tree, filters accepted
  // files exactly like stageFiles does (ACCEPT_EXT + MAX_BYTES), and hands
  // the accepted list to stageFiles so dedupe, per-file metadata seed,
  // and doc-type detection all run through their existing paths. Skipped
  // files are surfaced as a single summary toast with a copy-friendly
  // expander. Hidden files and OS metadata are dropped silently and do
  // not appear in the skipped list.
  const stageFolder = async (selection: DataTransferItemList | File[]) => {
    let collected: FolderDropResult;
    try {
      collected = Array.isArray(selection)
        ? collectFolderSelection(selection)
        : await collectFolderDrop(selection);
    } catch (e: any) {
      toast({
        title: "Could not add folder",
        description: e?.message ?? "Could not read the selected folder.",
        variant: "destructive",
      });
      return;
    }
    const { files: accepted, skipped, subfolderCount, folderName } = collected;
    const label = folderName || "the selected folder";
    const subfolderClause = subfolderCount > 0 ? ` (from ${subfolderCount} subfolder${subfolderCount === 1 ? "" : "s"})` : "";

    if (accepted.length > 0) {
      // Reuse the standard stager so dedupe + per-file metadata seed run
      // through the same path as a multi-file drop. Files here already
      // passed extension + size filters, so stageFiles' internal checks
      // are no-ops for this list (no double toasts).
      stageFiles(accepted);
    }

    const m = skipped.length;
    const summaryTitle = `Added ${accepted.length} file${accepted.length === 1 ? "" : "s"} from ${label}.`;
    const summaryBody = (
      <div className="text-xs">
        <div>{`Skipped ${m} unsupported or oversized file${m === 1 ? "" : "s"}.${subfolderClause}`}</div>
        {m > 0 && <SkippedFilesExpander items={skipped} />}
      </div>
    );
    if (m === 0 && accepted.length === 0) {
      toast({ title: `Added 0 files from ${label}.${subfolderClause}` });
      return;
    }
    if (m === 0) {
      toast({ title: summaryTitle + subfolderClause });
      return;
    }
    toast({ title: summaryTitle, description: summaryBody });
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
  const uploadOne = async (entry: FileEntry, metaOverride: Meta, rendered = false): Promise<FileEntry> => {
    const metadata: any = buildMetadataPayload(metaOverride, entry.file.name);
    try {
      const fd = new FormData();
      fd.append("file", entry.file);
      fd.append("metadata", JSON.stringify(metadata));
      if (rendered) fd.append("pdf_import_mode","rendered");
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      if (!res.ok) {
        // Try to pull a useful error message, but never leak raw HTML/stack traces.
        let msg = `HTTP ${res.status}`;
        try {
          const j = await res.json();
          if (j?.message) msg = j.message;
          if (j?.fallback_available === true && !rendered) {
            return {...entry,status:"error",message:msg,
              result:{fallbackAvailable:true,retryMeta:metaOverride,upload_id:j.upload_id}};
          }
          if (j?.upload_id) msg += ` (Upload ${j.upload_id})`;
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
        }${data.pdf_prepared ? " · Compatible PDF saved (one copy)" : ""}${data.rendering ? " · Page images are being prepared in the background" : ""}`,
        result: data,
      };
    } catch (err: any) {
      return { ...entry, status: "error", message: err?.message ?? "Upload failed" };
    }
  };

  const runRenderedFallback = async (key: string) => {
    if (uploadingKey !== null) return;
    const entry = files.find(f=>f.key === key);
    if (!entry?.result?.fallbackAvailable) return;
    setUploadingKey(key);
    setFiles(prev=>prev.map(f=>f.key===key ? {...f,status:"uploading",message:"Importing with rendered pages…"} : f));
    try {
      const finished = await uploadOne(entry,entry.result.retryMeta,true);
      if (finished.status === "done") {
        setCompletedUploads(prev=>[finished.result,...prev]);
        setFiles(prev=>prev.filter(f=>f.key!==key));
        toast({title:"Document added",description:"Search is available. Page images are being prepared in the background."});
      } else {
        setFiles(prev=>prev.map(f=>f.key===key ? finished : f));
        toast({title:"Rendered-page import failed",description:finished.message,variant:"destructive"});
      }
      invalidateAll();
    } finally {setUploadingKey(null);}
  };

  // -------- Sequential batch loop --------
  // Sequential (not parallel) because:
  //   - The server is single-process and PDF extraction is CPU-bound.
  //   - Parallel uploads would compete for RAM (up to 150 MB each).
  //   - Sequential gives the user a clear progress signal file by file.
  const runBatch = async () => {
    // Product model is OPTIONAL. It was required on single-file uploads from
    // v0.9.21 until this change, which forced a made-up value onto documents
    // that legitimately have no model -- pricing lists, software notes,
    // general reference. Multi-file uploads already allowed it to be empty,
    // and the server schema has always defaulted it to "", so an empty model
    // is an established, fully supported state rather than a new code path.

    setBatchDone(false);
    // Reset any errored/done entries so a retry actually re-attempts them
    setFiles((prev) => prev.map((f) => ({ ...f, status: "pending", message: "" })));

    // Process one file at a time
    const snapshot = files.slice();
    const outcomes: FileEntry[] = [];
    for (const entry of snapshot) {
      // Mark uploading
      setUploadingKey(entry.key);
      setFiles((prev) => prev.map((f) => (f.key === entry.key ? { ...f, status: "uploading", message: "Importing; preparing a compatible PDF automatically if needed…" } : f)));

      // v1.1.8: three modes, each sends what its UI advertises. Prior to v1.1.8
      // this line was `isBatch ? emptyMeta() : shared`, which pre-dated the
      // v1.1.1 addition of "Different per file" mode. That left both batch
      // modes silently dropping their staged metadata (Fix Title suggestions,
      // detected document type, per-file cards), so every batch-uploaded doc
      // arrived with a filename-derived title and document_type="document".
      //
      // The v0.9.21 "blank on multi-file" rule was intentional at the time --
      // there was no per-file card, and applying one metadata block to many
      // files was considered a footgun. Now that both a per-file mode and a
      // deliberate "Same metadata for all" mode exist, each mode sends exactly
      // what its selector promises. selectMetaForFile encapsulates the mapping
      // and is unit-tested in scripts/upload-meta-select.test.mjs.
      //
      // MetaForm on the shared block deliberately hides Title in batch mode
      // (see showTitle={!isBatch} around line 660), so Title is always filled
      // by the server from each filename on shared-mode batches -- no risk of
      // every file in the batch ending up with an identical title.
      const baseMeta: Meta = selectMetaForFile({
        isBatch,
        mode,
        entryMeta: entry.meta,
        shared,
      });

      // v1.1.9: shared-mode auto-fix titles. Only applies to batch-shared,
      // because batch-perfile already has per-card Fix Title buttons and
      // single-file has an inline Title field. When enabled, we call the
      // same fixTitle helper the manual button uses; if it returns a
      // confident non-empty title we send it, otherwise the field stays
      // empty and the server falls back to the filename-derived title
      // (server/routes.ts around line 1915). This is the behavior the
      // backlog entry calls out as "skipped": the auto-fill is skipped,
      // not the upload. selectMetaForFile stays pure -- the merge happens
      // here at the call site so its identity/regression test still holds.
      let metaForFile: Meta = baseMeta;
      if (isBatch && mode === "batch-shared" && autoFixTitles) {
        const suggestion = fixTitle(entry.file.name).title;
        if (suggestion && suggestion.trim().length > 0) {
          metaForFile = { ...baseMeta, title: suggestion };
        }
      }

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
    // Product model intentionally not checked here -- see runBatch().
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
            Drop one or many files at once — PDF, DOCX, RTF, TXT, or Markdown (up to 150 MB each). Every excerpt gets the metadata below attached, which powers the filters in Query.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Dropzone */}
          <Dropzone
            onFiles={stageFiles}
            onFolderDrop={stageFolder}
            onFolderSelect={stageFolder}
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
              onFallback={runRenderedFallback}
              busy={pending}
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
          {/*
            v1.1.8: render the shared MetaForm for single-file uploads (0 or 1
            files) AND for batch-shared mode. Prior to v1.1.8 the shared form
            was gated behind `!isBatch`, so in batch-shared mode there was no
            UI to enter metadata at all -- the banner used to say "metadata is
            not set during batch upload, use the Library tab after." That was
            the honest description of a footgun. Now that runBatch actually
            sends the shared block on batch-shared uploads (see line ~502),
            the form has to be visible for the user to fill in.

            Two rendering rules differ between the modes:
              - Single-file uploads show the Title field (Fix Title lives
                inside it, keyed to the one staged filename).
              - Batch-shared uploads hide Title -- one shared title across
                many files would collide and Fix Title needs a single source
                filename, which does not exist. Server fills Title per file
                from each filename, which is the pre-v1.1.8 behavior.
          */}
          {(!isBatch || mode === "batch-shared") && (
            <>
              <div className="flex items-center gap-2 border-t border-border pt-4">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {isBatch ? "Metadata applied to every file in this batch" : "Metadata"}
                </span>
              </div>
              <MetaForm
                value={shared}
                onChange={setShared}
                // v1.1.8: showTitle only in the single-file path. In batch-
                // shared mode Title is filled per file by the server from
                // each filename -- see the runBatch comment.
                showTitle={!isBatch}
                testIdPrefix=""
                // v1.1.1 (fix B): single-file uploads need the staged filename
                // so MetaForm can render the Fix Title / Detect type buttons.
                // When no file is staged (or in batch-shared mode where the
                // buttons make no sense) this is undefined and MetaForm's own
                // `originalFilename && (...)` gates hide both buttons.
                originalFilename={!isBatch ? files[0]?.file.name : undefined}
              />
            </>
          )}

          {/*
            v1.1.8: the pre-v1.1.8 banner said "metadata is not set during
            batch upload" and told the user to fix it in the Library tab. That
            was accurate before v1.1.8 (the shared form was hidden and every
            batch upload sent an empty meta block). Now that batch-shared mode
            actually applies the shared block to every file, the banner
            describes what happens instead of warning the user to work around
            it. In per-file mode the per-file cards carry metadata, so this
            note is only shown in shared mode.
          */}
          {isBatch && mode === "batch-shared" && (
            <div
              className="space-y-3 rounded-md border border-sky-300 bg-sky-50 p-3 text-xs text-sky-900 dark:border-sky-500/40 dark:bg-sky-950/40 dark:text-sky-100"
              data-testid="batch-metadata-banner"
            >
              <div className="flex items-start gap-3">
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="space-y-1 leading-relaxed">
                  <div className="font-semibold">One metadata block, applied to every file.</div>
                  <div>
                    The metadata you enter below is copied onto every file in
                    this batch. Title is filled per file: turn on
                    <span className="font-medium"> Auto-fix titles from filenames</span>
                    below to clean titles automatically, or switch to
                    <span className="font-medium"> Different per file</span> above
                    for per-document titles with the Fix Title suggestions.
                  </div>
                </div>
              </div>

              {/*
                v1.1.9: Auto-fix titles from filenames toggle. Off by default so
                v1.1.8 behavior is preserved (server fills each Title from the
                filename). When on, runBatch calls fixTitle on each file's name
                and sends the cleaned result as that file's title; files whose
                names fixTitle cannot resolve fall through to the server's
                filename-derived title. See the runBatch block around line 522.
              */}
              <label
                className="flex items-start gap-2 border-t border-sky-300/60 pt-3 dark:border-sky-500/30"
                data-testid="toggle-auto-fix-titles"
              >
                <input
                  type="checkbox"
                  className="mt-0.5 h-3.5 w-3.5 accent-sky-600"
                  checked={autoFixTitles}
                  onChange={(e) => setAutoFixTitles(e.target.checked)}
                  data-testid="checkbox-auto-fix-titles"
                />
                <span className="space-y-0.5 leading-relaxed">
                  <span className="block font-medium">Auto-fix titles from filenames</span>
                  <span className="block text-sky-900/80 dark:text-sky-100/80">
                    Clean up each file's title automatically. Files whose names
                    can't be cleaned up keep the filename as the title.
                  </span>
                </span>
              </label>
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
                disabled={pending}
                data-testid="button-ingest"
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

// v1.2.4: expander embedded in the folder-drop summary toast. Collapsed
// by default; when open, shows every skipped file on its own line with a
// fixed-vocabulary reason. The list is scrollable, visually capped so it
// never pushes the toast off-screen, and copyable as plain text (select
// all + copy works because we render plain text lines separated by
// newlines inside a <pre>). Not persisted -- dismissing the toast drops
// the list, matching the spec (summary of THIS drop only).
function SkippedFilesExpander({ items }: { items: FolderSkip[] }) {
  const [open, setOpen] = useState(false);
  const text = items
    .map((s) => {
      if (s.reason === "unsupported") return `${s.path}  --  unsupported type (${s.ext || "unknown"})`;
      if (s.reason === "too-large") return `${s.path}  --  over per-batch limit`;
      return `${s.path}  --  skipped`;
    })
    .join("\n");
  return (
    <div className="mt-1">
      <button
        type="button"
        className="text-xs underline hover:text-foreground"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        data-testid="folder-drop-skipped-toggle"
      >
        {open ? "Hide skipped" : `Show skipped (${items.length})`}
      </button>
      {open && (
        <pre
          className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-border bg-muted/30 p-2 text-[11px] leading-tight"
          data-testid="folder-drop-skipped-list"
        >
          {text}
        </pre>
      )}
    </div>
  );
}

function Dropzone({
  onFiles,
  onFolderDrop,
  onFolderSelect,
  hasFiles,
  fileInput,
}: {
  onFiles: (files: FileList | File[] | null) => void;
  onFolderDrop: (items: DataTransferItemList) => void;
  onFolderSelect: (files: File[]) => void;
  hasFiles: boolean;
  fileInput: React.RefObject<HTMLInputElement>;
}) {
  const [dragging, setDragging] = useState(false);
  const folderInput = useRef<HTMLInputElement>(null);
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
        // v1.2.4: prefer dataTransfer.items so folder drops are recursed.
        // Fall back to dataTransfer.files when items is empty or when no
        // item exposes webkitGetAsEntry (very rare outside Chromium).
        const items = e.dataTransfer.items;
        let hasEntryApi = false;
        if (items && items.length > 0) {
          for (let i = 0; i < items.length; i++) {
            if (items[i].kind === "file" && typeof (items[i] as any).webkitGetAsEntry === "function") {
              hasEntryApi = true;
              break;
            }
          }
        }
        if (hasEntryApi) {
          onFolderDrop(items);
        } else {
          onFiles(e.dataTransfer.files);
        }
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
        onClick={(e) => e.stopPropagation()}
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
      <input
        ref={folderInput}
        type="file"
        {...{ webkitdirectory: "" }}
        multiple
        hidden
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          // Snapshot before resetting so selecting the same folder works again.
          const selected = Array.from(e.currentTarget.files ?? []);
          e.currentTarget.value = "";
          if (selected.length > 0) onFolderSelect(selected);
        }}
        data-testid="input-folder"
      />
      <UploadIcon className="mb-2 h-8 w-8 text-muted-foreground" />
      <div className="text-sm font-medium">
        {hasFiles ? "Drop more files to add to the batch" : "Drop one or more files here, or click to browse"}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">PDF · DOCX · RTF · TXT · Markdown · up to 150 MB each</div>
      <div className="mt-1 text-[11px] text-muted-foreground">Drop or select a folder to add every supported file inside it.</div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-3"
        onClick={(e) => {
          e.stopPropagation();
          folderInput.current?.click();
        }}
        data-testid="button-select-folder"
      >
        Select folder...
      </Button>
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
  onFallback,
  busy,
}: {
  onFallback: (key: string) => void;
  busy: boolean;
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
            v0.9.21: the per-file-vs-shared metadata mode selector was retired.
            Multi-file uploads always skipped metadata; users set it per doc
            from the Library edit dialog after the batch finished.

            v1.1.1: the selector is restored. The v0.9.21 failure mode it was
            removed for (stray shared values silently applying to every file)
            is avoided by keeping "batch-shared" the default -- users only get
            per-file cards when they deliberately choose "Different per file".
            The per-file cards are also what surface the Fix Title and Detect
            type buttons, which were unreachable in batch without this toggle.
          */}
          {isBatch && (
            <div
              className="flex items-center overflow-hidden rounded-md border border-border"
              role="group"
              aria-label="Metadata mode"
              data-testid="group-upload-mode"
            >
              <Button
                variant={mode === "batch-shared" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => onModeChange("batch-shared")}
                className="h-8 rounded-none text-xs"
                aria-pressed={mode === "batch-shared"}
                data-testid="button-mode-shared"
              >
                Same metadata for all
              </Button>
              <Button
                variant={mode === "batch-perfile" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => onModeChange("batch-perfile")}
                className="h-8 rounded-none border-l border-border text-xs"
                aria-pressed={mode === "batch-perfile"}
                data-testid="button-mode-perfile"
              >
                Different per file
              </Button>
            </div>
          )}
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
              onFallback={()=>onFallback(f.key)}
              busy={busy}
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
  onFallback,
  busy,
}: {
  onFallback: () => void;
  busy: boolean;
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
  const [fallbackOpen,setFallbackOpen] = useState(false);
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

      {entry.status === "error" && entry.result?.fallbackAvailable && (
        <div className="flex flex-wrap gap-2 border-t p-3">
          <Button type="button" disabled={busy} onClick={()=>setFallbackOpen(true)} data-testid="button-rendered-fallback">Import with rendered pages</Button>
          <Button type="button" variant="outline" disabled={busy} onClick={onRemove}>Skip this file</Button>
          <AlertDialog open={fallbackOpen} onOpenChange={setFallbackOpen}>
            <AlertDialogContent data-testid="dialog-rendered-fallback">
              <AlertDialogHeader>
                <AlertDialogTitle>Import with rendered pages?</AlertDialogTitle>
                <AlertDialogDescription>
                  {entry.file.name} restricts copying. If you are authorized to import it, this option uses the legacy searchable-text import and creates a stored image of every page.
                  Your library and backups can become substantially larger, and a long manual can take several minutes to prepare.
                  The original PDF is retained alongside the rendered pages for large print jobs. This uses additional storage and does not remove or change PDF restrictions.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Not now</AlertDialogCancel>
                <AlertDialogAction disabled={busy} onClick={onFallback} data-testid="button-confirm-rendered-fallback">Import with rendered pages</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}
      {perFileMode && entry.expanded && (
        <div className="space-y-4 border-t border-border p-3">
          <MetaForm
            value={entry.meta}
            onChange={(m: Partial<Meta>) => onPatchMeta(m)}
            showTitle={true}
            testIdPrefix={`file-${entry.key}-`}
            compact
            originalFilename={entry.file.name}
          />
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
// DetectDocTypeButton — v1.1.0 (item 9), companion to FixTitleButton above.
//
// Small icon-only button placed inline right of the Document type select.
// Re-runs detectDocType() on the raw uploaded filename and applies the result
// against the CURRENT selection. Behavior rules locked with the user:
//
//   * Empty / default fallback ("document") current value  -> apply silently.
//   * Non-empty current value that matches detection       -> "unchanged" toast.
//   * Non-empty current value that differs from detection  -> confirm dialog
//     (Cancel keeps existing, Replace applies).
//   * No code detected at all                              -> "no code found"
//     toast; NEVER clears the field.
//
// The button never fires automatically — it is the manual counterpart to the
// per-file auto-fill at staging time in stageFiles() above. Renders only when
// originalFilename is present (per-file cards only), matching FixTitleButton.
// -----------------------------------------------------------------------------

function DetectDocTypeButton({
  originalFilename,
  currentDocTypeKey,
  onApply,
}: {
  originalFilename: string;
  currentDocTypeKey: string;
  onApply: (next: string) => void;
}) {
  const { data: filenameCodes } = useFilenameCodes();
  const { data: filenamePhrases } = useFilenamePhrases();
  const { data: documentTypes } = useDocumentTypes();
  const { toast } = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const detected = useMemo(
    () =>
      (filenameCodes?.mappings?.length || filenamePhrases?.mappings?.length)
        ? detectDocType(
            originalFilename,
            filenameCodes?.mappings ?? [],
            filenamePhrases?.mappings ?? [],
          )
        : null,
    [originalFilename, filenameCodes, filenamePhrases],
  );

  const currentKey = (currentDocTypeKey || "").trim();
  const isDefaultFallback = currentKey === "" || currentKey === "document";

  // Resolve keys to labels for the confirm dialog. Falls back to the raw key
  // if the type registry hasn't loaded yet -- rare, and still informative.
  const labelFor = (key: string): string =>
    documentTypes?.types.find((t) => t.key === key)?.label ?? key.replace(/_/g, " ");

  const handleClick = () => {
    if (!detected) {
      // No mapping row matched. Do NOT clear the field.
      toast({
        title: "No document type code found in filename",
        description: originalFilename,
      });
      return;
    }
    if (isDefaultFallback) {
      onApply(detected);
      return;
    }
    if (detected === currentKey) {
      toast({ title: "Document type unchanged" });
      return;
    }
    setConfirmOpen(true);
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleClick}
        className="shrink-0"
        aria-label="Detect type from filename"
        title={`Detect type from ${originalFilename}`}
        data-testid="button-detect-doctype"
      >
        <ScanSearch className="h-3.5 w-3.5" />
      </Button>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent data-testid="alert-detect-doctype-overwrite">
          <AlertDialogHeader>
            <AlertDialogTitle>Replace Document type with the detected value?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>The Document type is set. Detect type would replace it.</p>
                <div className="space-y-1">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">
                    Current type
                  </div>
                  <div className="rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-xs break-all">
                    {labelFor(currentKey)}
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">
                    Detected type
                  </div>
                  <div className="rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-xs break-all">
                    {detected ? labelFor(detected) : ""}
                  </div>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-detect-doctype-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOpen(false);
                if (detected) onApply(detected);
              }}
              data-testid="button-detect-doctype-replace"
            >
              Replace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
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
  originalFilename,
}: {
  value: Meta;
  onChange: MetaOnChange;
  showTitle: boolean;
  testIdPrefix: string;
  compact?: boolean;
  /**
   * v1.1.0: the RAW uploaded filename for this file, when the form is editing a
   * specific staged file. Presence of this prop is what enables the Fix Title
   * button -- the shared "apply to all" metadata block deliberately omits it,
   * because there is no single filename to parse there.
   */
  originalFilename?: string;
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
        <Row full>
          <Field label="Title (auto-filled from filename if blank)">
            {/* v1.1.0: Fix Title sits INLINE to the right of the input, so it
                never pushes the following fields down. `flex-wrap` + `basis-48`
                is deliberate: on a wide card the button stays on the same line,
                but once the column is too narrow to keep the input usable the
                button drops to its own line instead of crushing the input down
                to a few pixels. `shrink-0` keeps the button's label intact. */}
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={value.title}
                onChange={(e) => set({ title: e.target.value })}
                data-testid={`${testIdPrefix}input-title`}
                placeholder="e.g. TASKalfa 5054ci Admin Guide"
                className="min-w-0 flex-1 basis-48"
              />
              {originalFilename && (
                <FixTitleButton
                  originalFilename={originalFilename}
                  currentTitle={value.title}
                  onApply={(next) => set({ title: next })}
                />
              )}
            </div>
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
            {/* v1.1.0 (item 9): Detect type icon button sits INLINE right of
                the select, same flex-wrap + basis pattern as Fix Title so the
                select never gets crushed on narrow columns. Icon-only button
                keeps the row visually calm; the tooltip carries the label. */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-0 flex-1 basis-48">
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
              </div>
              {originalFilename && (
                <DetectDocTypeButton
                  originalFilename={originalFilename}
                  currentDocTypeKey={value.document_type}
                  onApply={(next) => set({ document_type: next })}
                />
              )}
            </div>
          </Field>
        </Row>
      )}
      {compact && (
        <Row>
          <Field label="Document type">
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-0 flex-1 basis-48">
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
              </div>
              {originalFilename && (
                <DetectDocTypeButton
                  originalFilename={originalFilename}
                  currentDocTypeKey={value.document_type}
                  onApply={(next) => set({ document_type: next })}
                />
              )}
            </div>
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
          {/* v1.0.15: swapped plain Input for an autocomplete combobox that
              surfaces previously-used family values from /api/facets. Both
              family and model are optional, so neither is wrapped in
              RequiredField. */}
          <ProductFamilyCombobox
            value={value.product_family}
            onChange={(v) => set({ product_family: v })}
            testId={`${testIdPrefix}combobox-product-family`}
          />
        </Field>
        <Field label="Product model">
          <ProductModelCombobox
            value={value.product_model}
            onChange={(v) => set({ product_model: v })}
            testId={`${testIdPrefix}combobox-product-model`}
          />
        </Field>
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

// `Row` is a two-up grid on sm+ screens. A Row holding a SINGLE Field
// therefore leaves the right-hand column empty, so that field renders at only
// half the card width.
//
// v1.1.2 (field-test fix): `full` opts a Row out of the 2-column split so its
// one child spans the entire card. Used by the Title row -- titles are the
// longest value on the form and were being edited through a half-width box
// that was further shortened by the inline Fix Title button.
function Row({ children, full = false }: { children: React.ReactNode; full?: boolean }) {
  return <div className={full ? "grid gap-4" : "grid gap-4 sm:grid-cols-2"}>{children}</div>;
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
