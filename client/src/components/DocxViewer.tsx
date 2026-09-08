// v1.0.6: rich DOCX viewer.
//
// Backend counterpart: v1.0.6 retains the raw uploaded .docx bytes at
// /api/documents/:id/original, and augments /api/documents/:id/content
// with `has_original` so we can tell current-format uploads from
// pre-v1.0.6 (chunk-only) legacy ones.
//
// Rendering strategy: docx-preview (~50 KB gzip + ~130 KB jszip gzip).
// It parses the .docx and produces paginated DOM inside a container we
// own, with real fonts, tables, headers, images, and page breaks. That
// gives us three big wins over v1.0.5's markdown-text viewer:
//   1. Users see something recognizable as their document.
//   2. Browser print-to-PDF produces a sensible layout (the CSS
//      docx-preview injects already includes @page and page-break rules).
//   3. In-window zoom via CSS transform on the rendered section stack
//      matches the feel of the PDF viewer's Fit / Readable toggle.
//
// Toolbar parity with PdfPageViewerDialog (approximate; exact wiring
// differs because docx-preview lays out its own pages):
//   [prev] page X of N [next]   [-] N% [+] Fit   Print
//
// Failure modes handled here:
//   * has_original === false        -> Legacy DOCX. Show the re-upload UI.
//   * fetch fails (network / 5xx)   -> Retry button.
//   * renderAsync throws            -> Silent-fallback to /content text
//                                      with an amber "showing text
//                                      fallback" banner (v1.0.6 spec).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Loader2,
  Printer,
  ZoomIn as ZoomInIcon,
  ZoomOut as ZoomOutIcon,
  Maximize2,
  ChevronLeft,
  ChevronRight,
  Upload,
  AlertTriangle,
  FileText,
} from "lucide-react";
import { Link } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { MIN_ZOOM, MAX_ZOOM, READABLE_ZOOM } from "@/hooks/use-zoom-pan";

// ------------------------------------------------------------------
// Public API. Matches the fields PageViewerDialog forwards so the
// upstream router can just pass its Props through unchanged.
// ------------------------------------------------------------------
interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  documentId: string;
  documentTitle: string;
  documentTitleColor?: string | null;
  documentFileName?: string | null;
  // initialPage is accepted for signature parity with the PDF viewer, but
  // has no meaning here -- docx-preview lays out its own page 1..N and
  // there's no server-side correspondence to a specific page yet.
  initialPage?: number;
}

// ------------------------------------------------------------------
// Shape of /api/documents/:id/content payloads. Extended in v1.0.6 with
// has_original + original_ext + original_bytes.
// ------------------------------------------------------------------
type ContentResponse = {
  format: "docx" | "text" | "markdown";
  markdown: string;
  chunk_count: number;
  char_count: number;
  has_original?: boolean;
  original_ext?: string | null;
  original_bytes?: number | null;
};

// Zoom scale steps mirror the PDF viewer -- 1 = "Fit width", READABLE_ZOOM
// (~1.75) = "Comfortable read", MAX_ZOOM = "Deep inspect". docx-preview
// content is already laid out at natural size, so the transform we apply
// is CSS-only and doesn't re-render the docx.
const DEFAULT_ZOOM = 1;

export function DocxViewerDialog({
  open,
  onOpenChange,
  documentId,
  documentTitle,
  documentTitleColor,
  documentFileName,
}: Props) {
  // ---------- Data + render state ----------
  // meta.has_original drives the "legacy vs current" branch and is the
  // one thing we absolutely need from /content before we can decide what
  // to render. We fetch it in a lightweight probe when the dialog opens.
  const [meta, setMeta] = useState<ContentResponse | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [renderState, setRenderState] = useState<
    "idle" | "loading" | "rendering" | "ready" | "fallback" | "error"
  >("idle");
  const [renderError, setRenderError] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);

  // Container refs for docx-preview.
  //  - renderRef: the pane where docx-preview appends its <section> pages.
  //  - styleRef: dedicated <style> host, keeps docx CSS scoped to us.
  const renderRef = useRef<HTMLDivElement | null>(null);
  const styleRef = useRef<HTMLDivElement | null>(null);

  // Zoom is applied as a CSS scale on the render pane. We keep track of
  // it in state so the toolbar readout stays in sync and we can honor
  // Fit / Readable toggles.
  const [zoom, setZoom] = useState<number>(DEFAULT_ZOOM);
  const zoomPct = useMemo(() => `${Math.round(zoom * 100)}%`, [zoom]);

  // ---------- Effect: probe /content on open ----------
  // We fetch /content ahead of the heavy renderAsync call for two
  // reasons:
  //   1. has_original tells us whether to even try docx-preview or jump
  //      straight to the legacy-upload UI.
  //   2. The markdown field is our silent-fallback payload if docx-preview
  //      later throws -- fetching it once here means the fallback swap
  //      is instant.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setMeta(null);
    setMetaError(null);
    setRenderState("loading");
    (async () => {
      try {
        const res = await apiRequest("GET", `/api/documents/${documentId}/content`);
        const json = (await res.json()) as ContentResponse;
        if (cancelled) return;
        setMeta(json);
        // If there's no retained original we don't need to try rendering
        // -- go straight to the legacy-upload branch and stop the spinner.
        if (!json.has_original) {
          setRenderState("idle");
        }
      } catch (err) {
        if (cancelled) return;
        setMetaError(err instanceof Error ? err.message : String(err));
        setRenderState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, documentId]);

  // ---------- Effect: run docx-preview once container + meta are ready ----------
  //
  // docx-preview's renderAsync is async and mutates the container's
  // children. We guard against strict-mode double-invocation and dialog
  // close-during-fetch by tracking a per-run token and only committing
  // the result if it matches the latest one.
  //
  // On any thrown / rejected path, silent-fallback to the /content
  // markdown text. This matches the v1.0.6 spec: user always sees
  // *something*, never a "the viewer broke" error.
  useEffect(() => {
    if (!open) return;
    if (!meta?.has_original) return;
    if (!renderRef.current || !styleRef.current) return;

    let cancelled = false;
    setRenderState("rendering");
    setRenderError(null);

    (async () => {
      try {
        // Fetch the raw .docx bytes. Backend streams application/
        // vnd.openxmlformats-officedocument.wordprocessingml.document.
        const res = await fetch(`/api/documents/${documentId}/original`);
        if (!res.ok) {
          throw new Error(`GET /original failed: ${res.status}`);
        }
        const buf = await res.arrayBuffer();
        if (cancelled) return;

        // Dynamic import so docx-preview + jszip don't bloat the initial
        // bundle for users who never open a DOCX.
        const docxPreview = await import("docx-preview");
        if (cancelled) return;

        // Reset the container before re-rendering (Strict Mode remount /
        // reopen).
        if (renderRef.current) renderRef.current.innerHTML = "";
        if (styleRef.current) styleRef.current.innerHTML = "";

        await docxPreview.renderAsync(
          buf,
          renderRef.current!,
          styleRef.current!,
          {
            className: "advisepoint-docx",
            inWrapper: true,
            ignoreWidth: false,
            ignoreHeight: false,
            // Preserve fonts and last-rendered page numbers so the print
            // stylesheet matches what the user sees on-screen.
            useBase64URL: true,
            experimental: true,
            // Trust the docx's declared page numbers when present -- the
            // toolbar's "page X of N" reads directly off the rendered
            // <section> count below.
            breakPages: true,
          },
        );
        if (cancelled) return;

        // Count rendered pages so the toolbar can show "X of N".
        const sections = renderRef.current?.querySelectorAll("section") ?? [];
        setPageCount(sections.length || 1);
        setCurrentPage(1);
        setRenderState("ready");
      } catch (err) {
        if (cancelled) return;
        // Silent fallback: swap in the reassembled text with a banner.
        setRenderError(err instanceof Error ? err.message : String(err));
        setRenderState("fallback");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, meta?.has_original, documentId]);

  // ---------- Effect: scroll the render pane to a page-anchored section ----------
  //
  // docx-preview lays each page in its own <section>. When the user
  // clicks Prev/Next, scroll the container so the target section is at
  // the top. IntersectionObserver keeps currentPage in sync with manual
  // scroll.
  useEffect(() => {
    if (renderState !== "ready" || !renderRef.current) return;
    const sections = Array.from(renderRef.current.querySelectorAll("section"));
    if (sections.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        // Pick the entry whose section is most visible; ties go to the
        // one earliest in document order (matches scroll direction).
        let bestIdx = -1;
        let bestRatio = 0;
        for (const entry of entries) {
          if (entry.intersectionRatio > bestRatio) {
            bestRatio = entry.intersectionRatio;
            bestIdx = sections.indexOf(entry.target as HTMLElement);
          }
        }
        if (bestIdx >= 0) setCurrentPage(bestIdx + 1);
      },
      // Threshold list gives us reasonable resolution as pages scroll by.
      { root: renderRef.current, threshold: [0.15, 0.5, 0.85] },
    );
    for (const s of sections) observer.observe(s);
    return () => observer.disconnect();
  }, [renderState, pageCount]);

  const gotoPage = useCallback(
    (n: number) => {
      if (renderState !== "ready" || !renderRef.current) return;
      const sections = renderRef.current.querySelectorAll("section");
      const clamped = Math.max(1, Math.min(sections.length, n));
      const target = sections[clamped - 1] as HTMLElement | undefined;
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
        setCurrentPage(clamped);
      }
    },
    [renderState],
  );

  // ---------- Zoom controls ----------
  // Mirror the PDF viewer: [-] steps down, [+] steps up, Fit resets to 1.
  const zoomOut = useCallback(() => {
    setZoom((z) => Math.max(MIN_ZOOM, +(z - 0.1).toFixed(2)));
  }, []);
  const zoomIn = useCallback(() => {
    setZoom((z) => Math.min(MAX_ZOOM, +(z + 0.1).toFixed(2)));
  }, []);
  const zoomFit = useCallback(() => {
    // "Fit" and "Readable" alternate on repeated clicks so users can
    // toggle between the two the same way they do in the PDF viewer.
    setZoom((z) => (z === DEFAULT_ZOOM ? READABLE_ZOOM : DEFAULT_ZOOM));
  }, []);

  // ---------- Print ----------
  //
  // Open a new window with just the rendered DOCX + its stylesheet, then
  // window.print() after images/fonts settle. Same pattern the PDF
  // viewer uses for its Print action, minus the multi-page load
  // shepherding (docx-preview inlines everything so imgs load
  // synchronously off the base64 URLs).
  const handlePrint = useCallback(() => {
    if (renderState !== "ready") return;
    const renderHtml = renderRef.current?.innerHTML ?? "";
    const styleHtml = styleRef.current?.innerHTML ?? "";
    if (!renderHtml) return;
    const safeTitle = (documentTitle || documentFileName || "Document")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const w = window.open("", "_blank", "width=900,height=1100");
    if (!w) return;
    w.document.open();
    w.document.write(
      `<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title>` +
        `<style>${styleHtml}\n@page { margin: 12mm; }\nbody { margin: 0; background: #fff; }\n` +
        `section.docx { page-break-after: always; }\nsection.docx:last-of-type { page-break-after: auto; }\n</style>` +
        `</head><body>${renderHtml}` +
        `<script>window.addEventListener('load', function(){` +
        `  setTimeout(function(){ window.focus(); window.print(); }, 200);` +
        `  window.addEventListener('afterprint', function(){ window.close(); });` +
        `});<\\/script></body></html>`,
    );
    w.document.close();
  }, [renderState, documentTitle, documentFileName]);

  // ---------- Legacy DOCX branch ----------
  // meta arrived, has_original === false -> pre-v1.0.6 upload.
  const isLegacy = meta !== null && meta.has_original === false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl p-0 gap-0 h-[90vh] flex flex-col">
        <DialogHeader className="px-5 py-3 border-b border-border shrink-0">
          <DialogTitle
            className="text-sm font-medium truncate pr-8"
            style={{ color: documentTitleColor ?? undefined }}
          >
            {documentTitle}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Word document viewer for {documentTitle}.
          </DialogDescription>
        </DialogHeader>

        {/* Body -- swaps between: loading, legacy re-upload, fallback text, ready render, or hard error. */}
        <div className="flex-1 min-h-0 overflow-hidden bg-muted/40">
          {(renderState === "loading" || renderState === "rendering") && !isLegacy && (
            <div className="h-full flex flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              {renderState === "loading" ? "Loading document\u2026" : "Rendering document\u2026"}
            </div>
          )}

          {metaError && (
            <div className="h-full flex flex-col items-center justify-center gap-2 text-sm text-destructive px-6 text-center">
              <AlertTriangle className="h-5 w-5" />
              <div>Could not load the document:</div>
              <div className="font-mono text-xs opacity-80">{metaError}</div>
            </div>
          )}

          {isLegacy && (
            <div className="h-full flex flex-col items-center justify-center gap-4 px-6 text-center">
              <FileText className="h-10 w-10 text-muted-foreground" />
              <div className="space-y-1 max-w-md">
                <div className="text-sm font-medium">Legacy upload</div>
                <p className="text-sm text-muted-foreground">
                  This DOCX was uploaded before v1.0.6, before the app
                  started retaining original source files. Re-upload the
                  file to view it here with its original formatting.
                </p>
              </div>
              <Link
                href="/upload"
                onClick={() => onOpenChange(false)}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm hover:opacity-90"
              >
                <Upload className="h-4 w-4" /> Re-upload document
              </Link>
            </div>
          )}

          {renderState === "fallback" && meta && (
            <div className="h-full flex flex-col">
              <div className="shrink-0 bg-amber-50 border-b border-amber-200 text-amber-900 text-xs px-4 py-2 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" />
                <span>
                  Showing text fallback -- the original couldn't render{renderError ? ` (${renderError})` : ""}.
                </span>
              </div>
              <div className="flex-1 min-h-0 overflow-auto bg-background px-6 py-4">
                <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">
                  {meta.markdown}
                </pre>
              </div>
            </div>
          )}

          {/* Rendered docx container. Kept mounted whenever we're not in
              legacy or fallback so the render effect has somewhere to
              write. Hidden with visibility until the render completes so
              users don't see docx-preview's incremental build-up. */}
          {!isLegacy && renderState !== "fallback" && (
            <div className="h-full overflow-auto bg-background">
              <div ref={styleRef} />
              <div
                ref={renderRef}
                className="advisepoint-docx-host mx-auto py-6"
                style={{
                  transform: `scale(${zoom})`,
                  transformOrigin: "top center",
                  transition: "transform 0.15s ease-out",
                  visibility: renderState === "ready" ? "visible" : "hidden",
                }}
              />
            </div>
          )}
        </div>

        {/* Toolbar -- kept slim, parity with PdfPageViewerDialog. Hidden
            when the legacy re-upload UI is showing since none of these
            controls have anything to act on. */}
        {!isLegacy && (
          <div className="px-4 py-2 border-t border-border shrink-0 flex items-center gap-2 text-xs">
            <button
              type="button"
              disabled={renderState !== "ready" || currentPage <= 1}
              onClick={() => gotoPage(currentPage - 1)}
              title="Previous page"
              className="inline-flex items-center justify-center h-7 w-7 rounded hover:bg-muted disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="tabular-nums text-muted-foreground min-w-[80px] text-center">
              {renderState === "ready" ? `Page ${currentPage} of ${pageCount}` : "\u2014"}
            </div>
            <button
              type="button"
              disabled={renderState !== "ready" || currentPage >= pageCount}
              onClick={() => gotoPage(currentPage + 1)}
              title="Next page"
              className="inline-flex items-center justify-center h-7 w-7 rounded hover:bg-muted disabled:opacity-40"
            >
              <ChevronRight className="h-4 w-4" />
            </button>

            <div className="flex-1" />

            <button
              type="button"
              onClick={zoomOut}
              disabled={renderState !== "ready" || zoom <= MIN_ZOOM}
              title="Zoom out (-)"
              className="inline-flex items-center justify-center h-7 w-7 rounded hover:bg-muted disabled:opacity-40"
            >
              <ZoomOutIcon className="h-4 w-4" />
            </button>
            <div className="tabular-nums text-muted-foreground min-w-[42px] text-center">
              {zoomPct}
            </div>
            <button
              type="button"
              onClick={zoomIn}
              disabled={renderState !== "ready" || zoom >= MAX_ZOOM}
              title="Zoom in (+)"
              className="inline-flex items-center justify-center h-7 w-7 rounded hover:bg-muted disabled:opacity-40"
            >
              <ZoomInIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={zoomFit}
              disabled={renderState !== "ready"}
              title="Fit / Readable"
              className="inline-flex items-center gap-1 h-7 px-2 rounded hover:bg-muted disabled:opacity-40"
            >
              <Maximize2 className="h-3.5 w-3.5" /> Fit
            </button>
            <button
              type="button"
              onClick={handlePrint}
              disabled={renderState !== "ready"}
              title="Print"
              className="inline-flex items-center gap-1 h-7 px-2 rounded hover:bg-muted disabled:opacity-40"
            >
              <Printer className="h-3.5 w-3.5" /> Print
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
