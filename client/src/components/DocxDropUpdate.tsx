// v1.0.7: drag-to-update drop zone + three-tier confirmation modal.
//
// This lives inside the doc-detail view (DocxViewerDialog) so it only
// activates when a specific document is open. Dragging a .docx onto the
// zone triggers:
//
//   1. POST /api/documents/:id/similarity-check with the file. Server
//      compares text-shingle overlap, w:sdt IDs, and structural counts,
//      returns tier 1..3.
//   2. Show a modal appropriate to the tier:
//        - Tier 1: silent update (still confirms if user wants), toast on success
//        - Tier 2: three-choice modal (Update / Import as new / Cancel)
//        - Tier 3: strong-warning modal (Cancel default focused)
//   3. On confirm, POST /api/documents/:id/update to actually replace.
//   4. Return an undo token that the parent can surface for ~30s.
//
// Design choices:
//   * We do NOT support "Import as new" from this component (that would
//     require re-plumbing the upload dialog with all its metadata form
//     fields). The button in the Tier 2 modal instead directs the user
//     to the Library upload button.
//   * We chose an inline drop overlay rather than a persistent toolbar
//     button because a toolbar button lands on the same visual layer as
//     Print / Zoom, and a drop zone that only appears while dragging is
//     less visually noisy for the 99% of the time the user isn't
//     replacing anything.

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw, X } from "lucide-react";

export interface DocxDropUpdateProps {
  documentId: string;
  documentTitle: string;
  /**
   * v1.0.7.4: which extension this doc uses. Drives the drop-zone label
   * and the drag-drop guard so users can't drop a .docx onto an .rtf doc
   * (or vice versa) even though both formats are accepted by the endpoint.
   * Lowercase, no leading dot. Defaults to "docx" for backward compat.
   */
  documentExt?: "docx" | "rtf";
  /** Renders only while the parent dialog is open. */
  active: boolean;
  /** Called after a successful update so the parent can refetch content. */
  onUpdated: (undoToken: string | null, undoExpiresSeconds: number) => void;
}

type SimilarityResp = {
  document_id: string;
  document_title: string;
  existing_file_name: string | null;
  incoming_file_name: string;
  incoming_size: number;
  tier: 1 | 2 | 3;
  reason: string;
  bytes_identical: boolean;
  text_overlap: number;
  sdt_overlap: number;
  structural_delta: number;
  existing: {
    bytesHash: string;
    textLen: number;
    shingleCount: number;
    sdtCount: number;
    structure: {
      paragraphs: number;
      headings: number;
      tables: number;
      drawings: number;
      sections: number;
    };
    textHead: string;
  };
  incoming: SimilarityResp["existing"];
};

export function DocxDropUpdate({
  documentId,
  documentTitle,
  documentExt = "docx",
  active,
  onUpdated,
}: DocxDropUpdateProps) {
  // Human-facing extension label with a leading dot (".docx", ".rtf").
  const extLabel = `.${documentExt}`;
  const [dragOver, setDragOver] = useState(false);
  const [phase, setPhase] = useState<
    "idle" | "checking" | "confirming" | "updating" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [similarity, setSimilarity] = useState<SimilarityResp | null>(null);

  // Track drag events on the WINDOW (not just our zone) so users can drop
  // anywhere in the viewer -- the toolbar / body / etc. -- and we still
  // catch it. This matches how most webmail attachment zones behave.
  const dragCounter = useRef(0);

  useEffect(() => {
    if (!active) return;

    function isDocxDrag(e: DragEvent): boolean {
      const items = e.dataTransfer?.items;
      if (!items) return false;
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === "file") return true;
      }
      return false;
    }

    function onDragEnter(e: DragEvent) {
      if (!isDocxDrag(e)) return;
      e.preventDefault();
      dragCounter.current += 1;
      if (dragCounter.current === 1) setDragOver(true);
    }
    function onDragOver(e: DragEvent) {
      if (!isDocxDrag(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    }
    function onDragLeave(e: DragEvent) {
      if (!isDocxDrag(e)) return;
      dragCounter.current = Math.max(0, dragCounter.current - 1);
      if (dragCounter.current === 0) setDragOver(false);
    }
    function onDrop(e: DragEvent) {
      if (!isDocxDrag(e)) return;
      e.preventDefault();
      dragCounter.current = 0;
      setDragOver(false);
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      const first = files[0];
      // v1.0.7.4: enforce the drop matches the document's ext. A .rtf
      // dropped on a .docx doc (or vice versa) is rejected client-side
      // with a clear message before we hit the server.
      const dropExtMatch = first.name.match(/\.([A-Za-z0-9]+)$/);
      const dropExt = dropExtMatch ? dropExtMatch[1].toLowerCase() : "";
      if (dropExt !== documentExt) {
        setError(
          `"${first.name}" is not a ${extLabel} file. This document is ${extLabel}; drop a ${extLabel} file to update it.`,
        );
        setPhase("error");
        return;
      }
      void beginSimilarityCheck(first);
    }

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      dragCounter.current = 0;
      setDragOver(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, documentId, documentExt]);

  const beginSimilarityCheck = useCallback(
    async (file: File) => {
      setPendingFile(file);
      setPhase("checking");
      setError(null);
      try {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch(
          `/api/documents/${encodeURIComponent(documentId)}/similarity-check`,
          { method: "POST", body: form },
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.message || `similarity check failed (${res.status})`);
        }
        const data = (await res.json()) as SimilarityResp;
        setSimilarity(data);
        setPhase("confirming");
      } catch (err: any) {
        setError(err?.message || "similarity check failed");
        setPhase("error");
      }
    },
    [documentId],
  );

  const confirmUpdate = useCallback(async () => {
    if (!pendingFile) return;
    setPhase("updating");
    setError(null);
    try {
      const form = new FormData();
      form.append("file", pendingFile);
      const res = await fetch(
        `/api/documents/${encodeURIComponent(documentId)}/update`,
        { method: "POST", body: form },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.message || `update failed (${res.status})`);
      }
      const data = await res.json();
      onUpdated(data.undo_token ?? null, data.undo_expires_seconds ?? 0);
      setPhase("idle");
      setPendingFile(null);
      setSimilarity(null);
    } catch (err: any) {
      setError(err?.message || "update failed");
      setPhase("error");
    }
  }, [pendingFile, documentId, onUpdated]);

  const cancelPending = useCallback(() => {
    setPhase("idle");
    setPendingFile(null);
    setSimilarity(null);
    setError(null);
  }, []);

  if (!active) return null;

  return (
    <>
      {dragOver && phase === "idle" && (
        <div
          className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center bg-primary/10 backdrop-blur-sm"
          aria-hidden="true"
        >
          <div className="rounded-2xl border-2 border-dashed border-primary bg-background/95 px-8 py-6 shadow-xl">
            <div className="flex items-center gap-3 text-primary">
              <RefreshCw className="h-6 w-6" />
              <div>
                <div className="text-lg font-semibold">Drop to update</div>
                <div className="text-sm text-muted-foreground">
                  Replace &ldquo;{documentTitle}&rdquo; with the dropped {extLabel}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {phase === "checking" && (
        <SimpleModal onClose={cancelPending}>
          <div className="flex items-center gap-3">
            <Loader2 className="h-5 w-5 animate-spin" />
            <div className="text-sm">Checking whether this looks like an edited version&hellip;</div>
          </div>
        </SimpleModal>
      )}

      {phase === "confirming" && similarity && (
        <ConfirmModal
          similarity={similarity}
          documentTitle={documentTitle}
          onCancel={cancelPending}
          onConfirm={confirmUpdate}
        />
      )}

      {phase === "updating" && (
        <SimpleModal onClose={undefined}>
          <div className="flex items-center gap-3">
            <Loader2 className="h-5 w-5 animate-spin" />
            <div className="text-sm">Updating &ldquo;{documentTitle}&rdquo;&hellip;</div>
          </div>
        </SimpleModal>
      )}

      {phase === "error" && (
        <SimpleModal onClose={cancelPending}>
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
            <div>
              <div className="text-sm font-medium">Update failed</div>
              <div className="mt-1 text-sm text-muted-foreground">
                {error ?? "unknown error"}
              </div>
              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  onClick={cancelPending}
                  className="inline-flex items-center gap-1 h-8 px-3 rounded border border-input bg-background hover:bg-muted text-sm"
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        </SimpleModal>
      )}
    </>
  );
}

// ------------------------------------------------------------------
// Modal primitives -- deliberately hand-rolled rather than depending on
// the shadcn Dialog stack. DocxViewerDialog already owns a Dialog, and
// nesting Dialog inside Dialog is finicky with focus traps and pointer
// events on the docx-preview canvas. A plain fixed-position overlay is
// less fancy but doesn't compete for focus with the underlying viewer.
// ------------------------------------------------------------------
function SimpleModal({
  onClose,
  children,
}: {
  onClose: (() => void) | undefined;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose ?? undefined}
    >
      <div
        className="max-w-md w-full rounded-lg border border-border bg-background p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function ConfirmModal({
  similarity,
  documentTitle,
  onCancel,
  onConfirm,
}: {
  similarity: SimilarityResp;
  documentTitle: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Tier 3 defaults to Cancel focused; Tier 1 defaults to Confirm. Tier
    // 2 defaults to Cancel too so the user has to actively choose.
    if (similarity.tier === 1) {
      confirmBtnRef.current?.focus();
    } else {
      cancelBtnRef.current?.focus();
    }
  }, [similarity.tier]);

  const tier = similarity.tier;
  const overlapPct = Math.round(similarity.text_overlap * 100);
  const sdtOverlapPct = Math.round(similarity.sdt_overlap * 100);

  return (
    <SimpleModal onClose={onCancel}>
      <div className="flex items-start gap-3">
        {tier === 3 ? (
          <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
        ) : (
          <RefreshCw className="h-5 w-5 text-primary shrink-0 mt-0.5" />
        )}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">
            {tier === 1 && "Update in place?"}
            {tier === 2 && "This looks partially matched"}
            {tier === 3 && "This doesn’t look like the same document"}
          </div>
          <div className="mt-1 text-sm text-muted-foreground break-words">
            Replace{" "}
            <span className="font-medium text-foreground">
              &ldquo;{documentTitle}&rdquo;
            </span>{" "}
            with{" "}
            <span className="font-medium text-foreground">
              {similarity.incoming_file_name}
            </span>
            .
          </div>
          <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <div>Detector reason:</div>
            <div className="text-foreground">{similarity.reason}</div>
            <div>Text overlap:</div>
            <div className="text-foreground">{overlapPct}%</div>
            {similarity.existing.sdtCount > 0 && (
              <>
                <div>Content-control ID overlap:</div>
                <div className="text-foreground">
                  {sdtOverlapPct}% ({similarity.existing.sdtCount} in existing)
                </div>
              </>
            )}
            <div>Existing paragraphs:</div>
            <div className="text-foreground">
              {similarity.existing.structure.paragraphs} →{" "}
              {similarity.incoming.structure.paragraphs}
            </div>
            <div>Existing headings:</div>
            <div className="text-foreground">
              {similarity.existing.structure.headings} →{" "}
              {similarity.incoming.structure.headings}
            </div>
            <div>Existing tables:</div>
            <div className="text-foreground">
              {similarity.existing.structure.tables} →{" "}
              {similarity.incoming.structure.tables}
            </div>
          </div>
          {tier === 3 && (
            <div className="mt-3 rounded border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
              Almost nothing matches. If you meant to add this as a
              separate document, cancel and use the Library upload
              button. Replacing will delete the current chunks and search
              index for this document.
            </div>
          )}
          {tier === 2 && (
            <div className="mt-3 rounded border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-700 dark:text-amber-400">
              Some overlap detected but not enough to be sure this is an
              edited version. Double-check the filename and the paragraph
              counts before continuing.
            </div>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              ref={cancelBtnRef}
              onClick={onCancel}
              className="inline-flex items-center gap-1 h-8 px-3 rounded border border-input bg-background hover:bg-muted text-sm"
            >
              <X className="h-3.5 w-3.5" /> Cancel
            </button>
            <button
              type="button"
              ref={confirmBtnRef}
              onClick={onConfirm}
              className={`inline-flex items-center gap-1 h-8 px-3 rounded text-sm ${
                tier === 3
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : "bg-primary text-primary-foreground hover:bg-primary/90"
              }`}
            >
              <RefreshCw className="h-3.5 w-3.5" />{" "}
              {tier === 3 ? "Replace anyway" : "Update"}
            </button>
          </div>
        </div>
      </div>
    </SimpleModal>
  );
}
