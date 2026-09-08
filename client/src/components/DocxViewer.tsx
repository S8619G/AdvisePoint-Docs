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
//
// v1.0.6.1 hotfixes on top of the above:
//   1. Page-break synthesis: docx-preview's `breakPages` only splits on
//      `<w:lastRenderedPageBreak>` markers desktop Word wrote at last
//      save; docs authored elsewhere (Word Online, LibreOffice, pandoc,
//      docx4j) often have zero of those, so the viewer previously showed
//      one giant section and "Page 1 of 1". We now walk the rendered
//      tree for any pagination hint (last-rendered breaks, explicit
//      `w:type="page"` line breaks, CSS `page-break-before` /
//      `break-before: page`) and slice the single section into multiple
//      synthetic sections at those points. When no hint exists at all
//      the toolbar switches to "Continuous view" and Prev/Next disable
//      themselves so we never lie to the user with "Page 1 of 1".
//   2. Fit-to-width: replaces the old two-state 100%/175% toggle. We
//      measure the natural rendered width of the docx (via a temporary
//      reset of the CSS scale) against the container's client width and
//      compute the exact scale that makes the doc fill the pane, then
//      toggle between that computed fit and 100%.
//   3. Print via hidden iframe: v1.0.6's window.open + document.write
//      approach shipped with a "<\/script>" escape that HTML5's script
//      end-tag parser doesn't recognize, so the print window ate the
//      rest of the document as script text and showed raw code. The
//      hidden-iframe path is well-formed HTML (srcdoc), has no popup
//      blocker risk, and hands off to the browser's native print
//      dialog directly.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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

// v1.0.6.1: DOCX zoom bounds are separate from use-zoom-pan's MIN_ZOOM
// (which is 1 -- native pixel size, appropriate for scanned page
// bitmaps). docx-preview renders at native paper width (~816 CSS px
// for US Letter at 96 DPI), and the dialog pane is often narrower than
// that, so Fit-to-width has to scale below 1 to actually fit. We
// allow down to 25% and up to 400% -- enough room for Fit on a small
// pane and for detailed inspection on wide docs, matching the range
// most PDF viewers expose.

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

// Natural / "100%" zoom. Fit is computed from container width at render
// time (v1.0.6.1); we no longer alternate against a hard-coded readable
// zoom because the two-state toggle was misleading users.
const DEFAULT_ZOOM = 1;
const DOCX_MIN_ZOOM = 0.25;
const DOCX_MAX_ZOOM = 4;

// Marker class we attach to synthetic <section> wrappers so subsequent
// re-runs don't wrap them again and print CSS can page-break on them
// too. Distinct from docx-preview's own ".docx" class so we can tell
// engine-rendered sections apart from ones we created.
const SYNTHETIC_PAGE_CLASS = "advisepoint-docx-synthetic-page";

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
  // v1.0.6.1: when the source .docx has no pagination hints at all, we
  // collapse the pager UI to "Continuous view" instead of lying about
  // "Page 1 of 1". True only when the synthesizer couldn't produce >1
  // section from the render.
  const [continuous, setContinuous] = useState<boolean>(false);

  // Container refs for docx-preview.
  //  - renderRef: the pane where docx-preview appends its <section> pages.
  //  - styleRef: dedicated <style> host, keeps docx CSS scoped to us.
  //  - scrollRef: the scroll container around renderRef; parent of the
  //    scaled render pane, used both for scroll-to-section and for
  //    measuring "Fit-to-width" against its client width.
  //  - printFrameRef: hidden <iframe> we mount into (used by handlePrint).
  const renderRef = useRef<HTMLDivElement | null>(null);
  const styleRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const printFrameRef = useRef<HTMLIFrameElement | null>(null);

  // Zoom is applied as a CSS scale on the render pane. We keep track of
  // it in state so the toolbar readout stays in sync and we can honor
  // Fit / 100% toggles.
  const [zoom, setZoom] = useState<number>(DEFAULT_ZOOM);
  // v1.0.6.1: computed fit-to-width scale, refreshed after render and on
  // window resize. Zero means "not measured yet"; the Fit button falls
  // back to 100% until we have a real number.
  const [fitZoom, setFitZoom] = useState<number>(0);
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
    setContinuous(false);
    setFitZoom(0);
    setZoom(DEFAULT_ZOOM);
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
            // <section> count below (after v1.0.6.1's synthesis pass).
            breakPages: true,
          },
        );
        if (cancelled) return;

        // v1.0.6.1: try to synthesize extra page breaks if the engine only
        // emitted a single section. See synthesizePageBreaks() for the
        // heuristics list. If we still end up with 1 section, flip on
        // "Continuous view" so the toolbar tells the truth.
        const rendered = renderRef.current;
        let sectionCount = rendered
          ? rendered.querySelectorAll("section").length
          : 0;
        if (rendered && sectionCount <= 1) {
          const synthesized = synthesizePageBreaks(rendered);
          if (synthesized > 1) sectionCount = synthesized;
        }
        setPageCount(sectionCount || 1);
        setCurrentPage(1);
        setContinuous(sectionCount <= 1);
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
    if (continuous) return; // no pager UI to keep in sync
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
      { root: scrollRef.current, threshold: [0.15, 0.5, 0.85] },
    );
    for (const s of sections) observer.observe(s);
    return () => observer.disconnect();
  }, [renderState, pageCount, continuous]);

  // ---------- Fit-to-width measurement ----------
  //
  // Called after render completes and again on window resize. We reset
  // the CSS scale to 1 for the measurement so scrollWidth reports the
  // *natural* rendered width, then divide by the scroll container's
  // client width (minus a small horizontal padding budget). The result
  // is stored in state; the "Fit" button toggles between it and 100%.
  //
  // useLayoutEffect so the temporary scale reset never paints.
  const measureFit = useCallback(() => {
    const pane = renderRef.current;
    const wrapper = scrollRef.current;
    if (!pane || !wrapper) return;
    const prevTransform = pane.style.transform;
    // Reset scale for the measurement, but keep the origin so we don't
    // jump horizontally.
    pane.style.transform = "scale(1)";
    // Force a reflow before reading scrollWidth.
    const naturalWidth = pane.scrollWidth;
    pane.style.transform = prevTransform;
    if (!naturalWidth) return;
    // 24px padding budget matches the py-6 (24px vertical) rhythm and
    // leaves visual breathing room from the pane edges.
    const target = Math.max(1, wrapper.clientWidth - 24);
    const scale = target / naturalWidth;
    // Clamp to the same MIN/MAX_ZOOM band the +/- buttons obey so Fit
    // never lands somewhere the user can't get back from with -.
    const clamped = Math.max(DOCX_MIN_ZOOM, Math.min(DOCX_MAX_ZOOM, scale));
    setFitZoom(+clamped.toFixed(3));
  }, []);

  useLayoutEffect(() => {
    if (renderState !== "ready") return;
    // Measure once after the render commits.
    measureFit();
    // Re-measure on window resize; wrappers change width when the
    // Dialog resizes or the user drags the browser window.
    const onResize = () => measureFit();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [renderState, measureFit]);

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
  // Mirror the PDF viewer: [-] steps down, [+] steps up, Fit toggles
  // between the measured fit-to-width scale and 100%. Falls back to 100%
  // when Fit is clicked before the measurement lands.
  const zoomOut = useCallback(() => {
    setZoom((z) => Math.max(DOCX_MIN_ZOOM, +(z - 0.1).toFixed(2)));
  }, []);
  const zoomIn = useCallback(() => {
    setZoom((z) => Math.min(DOCX_MAX_ZOOM, +(z + 0.1).toFixed(2)));
  }, []);
  const zoomFit = useCallback(() => {
    // Use the measured fit; if we're already very close to it, toggle
    // back to 100% so a second click "undoes" fit.
    setZoom((z) => {
      if (!fitZoom || fitZoom <= 0) return DEFAULT_ZOOM;
      const nearFit = Math.abs(z - fitZoom) < 0.005;
      return nearFit ? DEFAULT_ZOOM : fitZoom;
    });
  }, [fitZoom]);

  // ---------- Print ----------
  //
  // v1.0.6.1: use a hidden <iframe> instead of window.open. The previous
  // implementation wrote a full HTML document into a popup, including a
  // "<\/script>" that HTML5's script-end-tag matcher doesn't accept as
  // a closing tag -- so the print window ate the rest of the document
  // (including </body></html>) as script text and rendered as raw code
  // instead of triggering the browser's print dialog.
  //
  // The iframe path:
  //   1. Build a well-formed HTML srcdoc (no inline <script>).
  //   2. Mount the iframe hidden inside our dialog (no popup blocker).
  //   3. On iframe 'load', call print() on its contentWindow.
  //   4. Clean up on 'afterprint' or after a 30s watchdog.
  const handlePrint = useCallback(() => {
    if (renderState !== "ready") return;
    const renderHtml = renderRef.current?.innerHTML ?? "";
    const styleHtml = styleRef.current?.innerHTML ?? "";
    if (!renderHtml) return;
    const safeTitle = escapeHtml(
      documentTitle || documentFileName || "Document",
    );

    // v1.0.6.1 hotfix-on-a-hotfix: docx-preview's styleRef.innerHTML is
    // NOT plain CSS text -- it's a sequence of real `<style>...</style>`
    // elements. Wrapping it inside another `<style>` (as the initial
    // v1.0.6.1 pass did) caused the first inner `</style>` to close our
    // outer `<style>` early, so every subsequent rule (`@page`,
    // page-break rules) plus `</style></head><body>` leaked out as body
    // text -- showing raw CSS like `@page { margin: 12mm; }` at the top
    // of the printed page. Emit the docx-preview stylesheet block
    // unmodified in <head>, and put our own overrides in a *separate*
    // <style> block after it so the cascade still favors our rules.
    //
    // The print-only overrides also flatten docx-preview's on-screen
    // "paper on a gray tray" chrome: it wraps each section in a white
    // page with box-shadow and centers it on a gray background, which
    // in print leaks a shadow strip along the top/left of the physical
    // page and shifts content off-center. We reset background,
    // shadows, and outer padding at print time so each section prints
    // edge-to-edge and the browser's own `@page` margin owns the
    // whitespace budget.
    // Note on margins: we set `@page { margin: 0 }` because each rendered
    // `<section>` already carries the DOCX's own page margins from
    // `w:pgMar` as inline padding. If we left the default browser page
    // margin in place, we'd stack the browser's margin ON TOP of the
    // doc's own margin and end up with an oversize inset. Section
    // padding stays untouched -- that IS the doc's page margin.
    //
    // We DO clear the wrapper chrome (background color, box-shadow,
    // outer margin/padding) that docx-preview uses to draw the
    // "paper on a gray tray" preview affordance, since in print those
    // decorations leak as a shadow strip along the top/left of the
    // physical page and shift content off-center.
    const printOverrides =
      `@page { margin: 0; }\n` +
      `html, body { margin: 0; padding: 0; background: #fff; }\n` +
      `.docx-wrapper {\n` +
      `  background: #fff !important;\n` +
      `  padding: 0 !important;\n` +
      `  margin: 0 !important;\n` +
      `  display: block !important;\n` +
      `}\n` +
      `section.docx, section.${SYNTHETIC_PAGE_CLASS} {\n` +
      `  box-shadow: none !important;\n` +
      `  margin: 0 !important;\n` +
      `  background: #fff !important;\n` +
      `  border: 0 !important;\n` +
      `  page-break-after: always;\n` +
      `}\n` +
      `section.docx:last-of-type, ` +
      `section.${SYNTHETIC_PAGE_CLASS}:last-of-type {\n` +
      `  page-break-after: auto;\n` +
      `}\n`;

    const srcdoc =
      `<!doctype html><html><head><meta charset="utf-8">` +
      `<title>${safeTitle}</title>` +
      styleHtml +
      `<style>${printOverrides}</style>` +
      `</head><body>${renderHtml}</body></html>`;

    // Remove any stale iframe from a previous print click.
    if (printFrameRef.current) {
      printFrameRef.current.remove();
      printFrameRef.current = null;
    }

    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    iframe.style.visibility = "hidden";
    // srcdoc is the reliable, no-script way to inject a full document
    // into an iframe. Content Security Policy on the outer app doesn't
    // interfere because srcdoc runs in an about:srcdoc origin.
    iframe.srcdoc = srcdoc;

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      try {
        iframe.remove();
      } catch {
        /* ignore */
      }
      if (printFrameRef.current === iframe) printFrameRef.current = null;
    };

    iframe.addEventListener("load", () => {
      // Give the browser one tick to lay out and resolve inline images
      // before printing. docx-preview base64-encodes embedded media so
      // there are no network fetches to wait on.
      const win = iframe.contentWindow;
      if (!win) {
        cleanup();
        return;
      }
      try {
        win.addEventListener("afterprint", cleanup);
      } catch {
        /* cross-origin edge case; watchdog handles it */
      }
      // requestAnimationFrame lets the browser commit layout first;
      // some engines throw NS_ERROR_NOT_AVAILABLE if print() runs
      // before that happens.
      win.requestAnimationFrame(() => {
        try {
          win.focus();
          win.print();
        } catch (err) {
          // Swallow -- worst case, the user closes the (invisible)
          // iframe via the watchdog. We deliberately don't surface a
          // toast because print failures are rare and users will
          // notice missing output on their own.
          console.warn("Print failed:", err);
          cleanup();
        }
      });
    });

    // Watchdog in case afterprint never fires (Safari historically
    // omits it in some print flows).
    window.setTimeout(cleanup, 30_000);

    document.body.appendChild(iframe);
    printFrameRef.current = iframe;
  }, [renderState, documentTitle, documentFileName]);

  // Clean up any lingering print iframe when the dialog closes.
  useEffect(() => {
    if (open) return;
    if (printFrameRef.current) {
      try {
        printFrameRef.current.remove();
      } catch {
        /* ignore */
      }
      printFrameRef.current = null;
    }
  }, [open]);

  // ---------- Legacy DOCX branch ----------
  // meta arrived, has_original === false -> pre-v1.0.6 upload.
  const isLegacy = meta !== null && meta.has_original === false;

  // Toolbar page-counter text. v1.0.6.1: prefer "Continuous view" over
  // the misleading "Page 1 of 1" when we couldn't synthesize any breaks.
  const pageLabel = (() => {
    if (renderState !== "ready") return "\u2014";
    if (continuous) return "Continuous view";
    return `Page ${currentPage} of ${pageCount}`;
  })();

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
            <div ref={scrollRef} className="h-full overflow-auto bg-background">
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
              disabled={
                renderState !== "ready" || continuous || currentPage <= 1
              }
              onClick={() => gotoPage(currentPage - 1)}
              title="Previous page"
              className="inline-flex items-center justify-center h-7 w-7 rounded hover:bg-muted disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="tabular-nums text-muted-foreground min-w-[110px] text-center">
              {pageLabel}
            </div>
            <button
              type="button"
              disabled={
                renderState !== "ready" ||
                continuous ||
                currentPage >= pageCount
              }
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
              disabled={renderState !== "ready" || zoom <= DOCX_MIN_ZOOM}
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
              disabled={renderState !== "ready" || zoom >= DOCX_MAX_ZOOM}
              title="Zoom in (+)"
              className="inline-flex items-center justify-center h-7 w-7 rounded hover:bg-muted disabled:opacity-40"
            >
              <ZoomInIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={zoomFit}
              disabled={renderState !== "ready"}
              title={
                fitZoom
                  ? `Fit to width (${Math.round(fitZoom * 100)}%)`
                  : "Fit to width"
              }
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

// ------------------------------------------------------------------
// v1.0.6.1: page-break synthesis.
//
// docx-preview's `breakPages` only fires for `<w:lastRenderedPageBreak>`
// markers desktop Word wrote on last save. Docs authored elsewhere often
// have zero of those, so we get one giant section and "Page 1 of 1".
//
// This function looks for other pagination hints the docx may carry
// through to the rendered DOM:
//
//   * <br class="lastRenderedPageBreak"> -- what docx-preview emits for
//     the same w:lastRenderedPageBreak marker when breakPages happens to
//     be disabled or the marker is deep inside nested content the engine
//     didn't split on.
//   * <br style="page-break-before: always"> and CSS-driven
//     `page-break-before: always` / `break-before: page` on any element
//     -- what most other converters (LibreOffice, pandoc, docx4j) emit.
//   * Elements with `mso-special-character: line-break` +
//     `page-break-before: always` -- the Word HTML export flavor.
//
// When we find any hint, we slice the single rendered section at those
// hint points, wrapping each slice in a synthetic <section> with the
// SYNTHETIC_PAGE_CLASS marker. Prev/Next then works page-by-page and
// print CSS breaks at the same points.
//
// Returns the resulting section count (>=1). If we couldn't produce >1
// section, the caller flips on "Continuous view".
// ------------------------------------------------------------------
function synthesizePageBreaks(host: HTMLElement): number {
  // Find the docx-preview wrapper (a .docx-wrapper > section.docx tree).
  // We operate on the innermost single <section> to keep the DOM shape
  // predictable.
  const sections = host.querySelectorAll("section");
  if (sections.length !== 1) return sections.length;
  const soleSection = sections[0] as HTMLElement;

  // Look for break candidates *inside* the section. We include the
  // section itself only if it has an explicit page-break-before set on
  // some descendant.
  const candidates: HTMLElement[] = [];
  const all = soleSection.querySelectorAll<HTMLElement>("*");
  for (const el of Array.from(all)) {
    if (isPageBreakElement(el)) candidates.push(el);
  }
  if (candidates.length === 0) return 1;

  // Build slices: everything from (last-break exclusive) to next-break
  // (exclusive) becomes one synthetic page. We walk the direct children
  // of soleSection to keep the slice granularity at the block level.
  //
  // For candidates that sit deep inside a block, we treat their nearest
  // top-level ancestor as the boundary marker so we don't split a
  // paragraph mid-word. That means multiple breaks inside the same
  // block collapse to one boundary, which is fine -- Word treats stacked
  // page breaks as one anyway.
  const topLevelBreakChildren = new Set<Element>();
  for (const c of candidates) {
    const topLevel = nearestTopLevelChild(soleSection, c);
    if (topLevel) topLevelBreakChildren.add(topLevel);
  }
  if (topLevelBreakChildren.size === 0) return 1;

  const kids = Array.from(soleSection.children);
  const slices: Element[][] = [[]];
  for (const kid of kids) {
    if (topLevelBreakChildren.has(kid)) {
      // Start a new slice; the break marker itself goes with the *next*
      // page (so page N+1 starts *at* the marker, matching Word's
      // behavior with a "page break before" paragraph).
      if (slices[slices.length - 1].length > 0) slices.push([]);
      slices[slices.length - 1].push(kid);
    } else {
      slices[slices.length - 1].push(kid);
    }
  }

  // If we ended up with only one slice (all breaks were in the very
  // first block), don't rebuild the DOM.
  if (slices.length <= 1) return 1;

  // Build synthetic sections. Preserve the sole section's className +
  // inline styles so page dimensions carry through.
  const parent = soleSection.parentNode;
  if (!parent) return 1;
  const originalClass = soleSection.className;
  const originalStyle = soleSection.getAttribute("style") ?? "";

  const frag = host.ownerDocument.createDocumentFragment();
  for (const slice of slices) {
    const s = host.ownerDocument.createElement("section");
    s.className = `${originalClass} ${SYNTHETIC_PAGE_CLASS}`.trim();
    if (originalStyle) s.setAttribute("style", originalStyle);
    for (const el of slice) s.appendChild(el);
    frag.appendChild(s);
  }
  parent.replaceChild(frag, soleSection);

  // Re-count on the actual DOM in case something upstream (e.g. an
  // adjacent .docx-wrapper node) also holds a stray section we didn't
  // touch.
  return host.querySelectorAll("section").length;
}

// True when the element should be treated as a page-break marker for
// synthesis purposes. Checks class hints first (cheap), then inline
// style, then computed style (most expensive, only reached when the
// element looks like it could be a break carrier).
function isPageBreakElement(el: HTMLElement): boolean {
  if (el.tagName === "BR") {
    if (el.classList.contains("lastRenderedPageBreak")) return true;
    if (el.classList.contains("pageBreak")) return true;
    const styleAttr = el.getAttribute("style") ?? "";
    if (/page-break-before\s*:\s*always/i.test(styleAttr)) return true;
    if (/break-before\s*:\s*page/i.test(styleAttr)) return true;
  }
  const inline = el.getAttribute("style") ?? "";
  if (/page-break-before\s*:\s*always/i.test(inline)) return true;
  if (/break-before\s*:\s*page/i.test(inline)) return true;
  // Skip computed-style probes on non-BR / non-styled elements to keep
  // this cheap on large documents. The two lookups above cover the
  // formats we've seen in practice.
  return false;
}

// Walk up from `descendant` until we hit a direct child of `section`,
// or bail (return null) if we walked out of the section entirely.
function nearestTopLevelChild(
  section: HTMLElement,
  descendant: HTMLElement,
): Element | null {
  let cur: Element | null = descendant;
  while (cur && cur.parentElement && cur.parentElement !== section) {
    cur = cur.parentElement;
  }
  if (!cur || cur.parentElement !== section) return null;
  return cur;
}

// Minimal HTML escaper for <title> injection into the print iframe. We
// don't ship a real escaping lib because this is the only spot in the
// component that needs one and the input surface is tiny.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
