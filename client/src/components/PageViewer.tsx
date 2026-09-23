// v0.9.18 - modal viewer for the original PDF page images.
//
// Design notes:
// * We deliberately lazy-load one page at a time via a plain <img>.
//   A 791-page manual pulled all-at-once would flood the app with 40+ MB of
//   JPEGs. Instead the server has rendered every page to a JPEG sidecar; we
//   just point <img src> at /api/documents/:id/pages/:n.jpg and let the
//   browser cache it.
// * If the render job is still in progress we poll /pages/status until pages
//   we care about show up. Existing images render immediately; missing ones
//   show a "rendering..." placeholder.
// * v0.9.18 additions:
//   - Zoom & pan via `useZoomPan` (mouse wheel, drag, keyboard). Zoom always
//     resets to fit (1x) when the page number changes.
//   - Zoom toolbar in the footer: [-] N% [+] Fit.
//   - In-document quick search panel (Ctrl+F). Reuses the /api/search endpoint
//     with `filters.document_id`, so results are ranked the same way as the
//     Query page but scoped to the current doc.
//   - Keyboard: `[` and `]` always navigate pages. ArrowLeft/Right navigate
//     pages when zoom == 1, and pan the image when zoomed in.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Printer,
  ArrowLeft,
  ArrowRight,
  Search as SearchIcon,
  X,
  ZoomIn as ZoomInIcon,
  ZoomOut as ZoomOutIcon,
  Maximize2,
} from "lucide-react";
import { useZoomPan, MIN_ZOOM, MAX_ZOOM, READABLE_ZOOM } from "@/hooks/use-zoom-pan";
import { Highlight } from "@/lib/highlight";
import { apiRequest } from "@/lib/queryClient";
import { useViewerPrefs } from "@/lib/viewer-prefs";
// v1.0.6: DOCX docs get a dedicated rich viewer (docx-preview + jszip)
// with print/zoom/page controls at parity with the PDF viewer.
import { DocxViewerDialog } from "./DocxViewer";
import { DocumentFileNameWithBadge } from "./DocumentFormatBadge";
import { ContinuousPdfPages, type ContinuousPdfHandle } from "./ContinuousPdfPages";
import { PdfPageSurface } from "./PdfPageSurface";
import { PrintPreparationDialog } from "./PrintPreparationDialog";

type PageInfo = {
  page_number: number;
  width: number;
  height: number;
  url: string;
};

type RenderStatus = {
  status: "pending" | "rendering" | "ready" | "error" | "missing";
  rendered: number;
  total: number;
  error: string | null;
};

// Server search result shape used by the in-doc search panel.
type SearchChunk = {
  content: string;
  section_title?: string | null;
  section_path_json?: string;
  page_start?: number | null;
  page_end?: number | null;
  content_type?: string;
};
type SearchResult = { score: number; chunk: SearchChunk };

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  documentId: string;
  documentTitle: string;
  // v0.9.30: optional accent color for the rendered title — #RRGGBB hex or
  // null/undefined to use the default text color. Applied inline so the
  // preview matches the library card / detail page.
  documentTitleColor?: string | null;
  initialPage?: number;
  // v1.0.5: original file name ("foo.docx", "notes.md", etc.). When
  // present and the extension is not .pdf, the dialog switches to the
  // reassembled-content viewer instead of the per-page image viewer.
  // When absent or .pdf, the classic PDF page viewer renders.
  documentFileName?: string | null;
}

// v1.0.5: thin router. Non-PDF documents (DOCX / TXT / MD) have no per-page
// image renders -- previously the viewer showed a permanent "Render error".
// Route them to a text-content viewer that reassembles from the chunks
// table via /api/documents/:id/content. Everything else stays on the PDF
// page viewer that has been there since v0.9.7.
//
// v1.0.6: DOCX splits off from that content viewer. When the file is a
// .docx we hand off to DocxViewerDialog, which uses docx-preview to
// render the original bytes retained at
// /api/documents/:id/original (falling back to the v1.0.5 text viewer
// only for pre-v1.0.6 uploads or renderer errors, which it handles
// internally). TXT/MD stay on the v1.0.5 text viewer.
export function PageViewerDialog(props: Props) {
  const fileName = (props.documentFileName ?? "").toLowerCase();
  // v1.0.7.4: RTF also routes through DocxViewerDialog. It short-circuits
  // the docx-preview render path for .rtf and shows the reassembled text
  // instead, while reusing the toolbar (Open in Word, Print), edit-in-place
  // pill, and drag-to-update infrastructure.
  if (fileName.endsWith(".docx") || fileName.endsWith(".rtf")) {
    return <DocxViewerDialog {...props} />;
  }
  const isNonPdfText =
    fileName.endsWith(".txt") ||
    fileName.endsWith(".md") ||
    fileName.endsWith(".markdown");
  if (isNonPdfText) {
    return <DocumentContentViewerDialog {...props} />;
  }
  return <PdfPageViewerDialog {...props} />;
}

function PdfPageViewerDialog({
  open,
  onOpenChange,
  documentId,
  documentTitle,
  documentTitleColor,
  documentFileName,
  initialPage,
}: Props) {
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [nativePdf, setNativePdf] = useState(false);
  const [pdfPrepared,setPdfPrepared] = useState(false);
  const [status, setStatus] = useState<RenderStatus | null>(null);
  const [pageNumber, setPageNumber] = useState<number>(initialPage ?? 1);
  const [loading, setLoading] = useState(true);
  const [imgLoading, setImgLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<number | null>(null);

  // ------------------------------------------------------------------
  // v0.9.18: zoom & pan controller
  // v0.9.20: wheel behavior is user-configurable (scroll vs zoom, and
  // scroll direction). The setting lives in a shared preferences store
  // so the Settings page and this inline toolbar radio stay in sync.
  // ------------------------------------------------------------------
  const [viewerPrefs] = useViewerPrefs();

  // v0.9.22 - Fit / Page toggle. "fit" = zoom 1 (shrink to viewport).
  // "page" (default) = zoom to a value that shows the page at readable
  // native size (roughly 175% of fit). Toolbar button toggles between them.
  //
  // Default is "page" because field techs need to read the manual, not
  // survey the layout. One click on the toolbar button drops back to Fit
  // for anyone who preferred the old default.
  // v0.9.25 - Two-state viewer:
  //   "fit"      - whole page visible in the window (max-w max-h fit),
  //                zoom = 1, wheel flips pages
  //   "readable" - page magnified so it overflows the viewport vertically
  //                (zoom = READABLE_ZOOM), wheel smart-scrolls line by line
  //                and rolls over to the next / previous page at the edges.
  const [fitMode, setFitMode] = useState<"fit" | "readable">("fit");

  // v1.0.9.1.1: Zoom Page toggle inside the continuous-Fit stack. When
  // `false`, each page is capped at the viewport height ("fit"). When
  // `true`, each page is scaled up so its long edge exceeds the viewport
  // ("zoomed page"). Both states use the same virtualized continuous
  // stack, so native smooth scroll and the full-document scrollbar keep
  // working in both states. This replaces the old Fit / Readable toggle
  // that switched to a completely different single-page viewer and lost
  // the scrollbar + smooth scrolling.
  // v1.0.9.2: was 1.6 in v1.0.9.1.1 - visibly bigger but did not feel
  // like the page "filled the viewer". 2.2 makes the zoomed page clearly
  // dominant (roughly matches how the page fits at 100% on typical PDFs
  // where fit-to-height leaves horizontal breathing room).
  const [stackZoomed, setStackZoomed] = useState(false);

  // v1.0.2 - Fit-mode auto-promotion. Fit renders the image at a reduced
  // resolution (max-w-full max-h-full) so it fits the viewport; CSS-scaling
  // that shrunken render pixelates badly. When the user tries to zoom in
  // from Fit, promote to Readable (natural-size render) first, then apply
  // the same zoom step so the intent is preserved. Ref so the useZoomPan
  // callback stays stable across mode changes.
  const fitModeRef = useRef(fitMode);
  useEffect(() => { fitModeRef.current = fitMode; }, [fitMode]);

  // Refs so the wheel-page-nav callback (installed once in useZoomPan) can
  // reach the freshest pageNumber and status without re-binding on every
  // render.
  const pageNumberRef = useRef(pageNumber);
  useEffect(() => { pageNumberRef.current = pageNumber; }, [pageNumber]);
  const statusRef = useRef<RenderStatus | null>(null);
  useEffect(() => { statusRef.current = status; });

  // v0.9.25 - drive wheel behavior from fitMode, not the viewerPrefs radio
  // (which was removed from the toolbar). Fit -> "page" (wheel flips whole
  // pages). Readable -> "smart" (wheel pans line-by-line, rolls over to the
  // next/prev page at the edges). Ctrl+wheel still zooms in either mode.
  // v0.9.25 - track the desired landing edge across the page-change effect.
  const landAtRef = useRef<"top" | "bottom">("top");

  // v0.9.27 - Ref to the currently displayed page image, used by
  // getContentSize() so the smart-scroll math knows the real rendered size
  // (Readable at zoom=1 has the img bigger than the viewport, so it must
  // pan based on image height not viewport height).
  const imgRef = useRef<HTMLCanvasElement | HTMLImageElement | null>(null);
  const zoom = useZoomPan({
    enabled: true,
    wheelAction: fitMode === "readable" ? "smart" : "page",
    wheelDirection: viewerPrefs.wheelDirection,
    onWheelPageNav: (dir, opts) => {
      const cur = pageNumberRef.current;
      const total = statusRef.current?.total ?? 1;
      const next = Math.max(1, Math.min(total, cur + dir));
      if (next !== cur) {
        landAtRef.current = opts?.landAt ?? "top";
        setPageNumber(next);
      }
    },
    getContentSize: () => {
      const el = imgRef.current;
      if (!el) return null;
      // clientWidth/Height give the RENDERED size before CSS transform,
      // which is exactly what clampPan expects (it multiplies by zoom).
      return { width: el.clientWidth, height: el.clientHeight };
    },
    // v1.0.2 - Auto-promote to Readable on any zoom-in from Fit. The hook
    // fires this before actually zooming and, if we return true, aborts its
    // own zoom. We swap to Readable (which sets zoom to READABLE_ZOOM = 1
    // at natural image size) so the promoted view is already a crisp
    // render. The user's next `+` / wheel / double-click will then scale
    // the natural-size render, which stays sharp.
    onZoomInFromFit: () => {
      if (fitModeRef.current !== "fit") return false;
      promoteToReadable();
      return true;
    },
  });

  // v1.0.2 - Shared helper for auto-promotion. Mirrors the Fit->Readable
  // path of the toolbar toggle (setFitMode + setZoom + scrollToEdge dance)
  // but without changing the toggle's own behavior. Landing at the top of
  // the page matches the toggle: the user just asked to see this page
  // magnified, so start at the top of it.
  const promoteToReadable = useCallback(() => {
    setFitMode("readable");
    zoom.setZoom(READABLE_ZOOM);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => zoom.scrollToEdge("top"));
    });
    landAtRef.current = "top";
  }, [zoom]);

  // v0.9.25 - preserve zoom on page change and land at the requested edge.
  // Fit mode: always center (there's nothing to scroll).
  // Readable mode: after a smart-scroll page flip, land at the top of the
  //   new page when moving forward, or at the bottom when moving backward,
  //   so a continuous read never loses its place.
  //
  // v0.9.27 - The scrollToEdge call itself was moved to the image `onLoad`
  // handler because it needs the new page's real rendered dimensions to
  // compute the correct pan bounds. This effect still fires on page change
  // for Fit mode (where there's nothing to scroll but we still want to reset
  // any lingering pan), and it keeps landAtRef in sync for non-wheel jumps.
  useEffect(() => {
    if (fitMode !== "readable") {
      zoom.resetPan();
      landAtRef.current = "top";
    }
    // Note: for readable mode, landAtRef is set by the wheel handler right
    // before setPageNumber, and read (then reset to "top") by the img onLoad
    // handler once the image reports its true size. Do NOT reset it here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageNumber]);

  // ------------------------------------------------------------------
  // v0.9.18: in-document search panel state
  // ------------------------------------------------------------------
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [selectedResultIdx, setSelectedResultIdx] = useState<number>(-1);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Debounce input -> 200ms.
  useEffect(() => {
    const h = window.setTimeout(() => setDebouncedQuery(searchInput.trim()), 200);
    return () => window.clearTimeout(h);
  }, [searchInput]);

  // Kick off search whenever the debounced query changes and panel is open.
  useEffect(() => {
    if (!searchOpen) return;
    if (!debouncedQuery) {
      setSearchResults([]);
      setSelectedResultIdx(-1);
      setSearching(false);
      setSearchError(null);
      return;
    }
    let cancelled = false;
    setSearching(true);
    setSearchError(null);
    (async () => {
      try {
        const res = await apiRequest("POST", "/api/search", {
          query: debouncedQuery,
          top_k: 25,
          hybrid: true,
          filters: { document_id: documentId },
        });
        const body = await res.json();
        if (cancelled) return;
        const list = Array.isArray(body?.results) ? body.results : [];
        setSearchResults(list);
        setSelectedResultIdx(list.length > 0 ? 0 : -1);
      } catch (e: any) {
        if (cancelled) return;
        setSearchError(String(e?.message ?? e));
        setSearchResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    })();
    return () => { cancelled = true; };
  }, [debouncedQuery, searchOpen, documentId]);

  // Reset search state when the viewer closes or the document changes.
  useEffect(() => {
    if (!open) {
      setSearchOpen(false);
      setSearchInput("");
      setDebouncedQuery("");
      setSearchResults([]);
      setSelectedResultIdx(-1);
      setSearchError(null);
    }
  }, [open, documentId]);

  // Focus the search input every time the panel opens.
  useEffect(() => {
    if (searchOpen) {
      // Slight delay so Radix Dialog focus-trap doesn't steal focus back.
      window.setTimeout(() => searchInputRef.current?.focus(), 30);
    }
  }, [searchOpen]);

  // ------------------------------------------------------------------
  // Fetch pages + status. Called on open and repeatedly while status != ready.
  // ------------------------------------------------------------------
  const refresh = async () => {
    try {
      const [pagesResp, statusResp] = await Promise.all([
        fetch(`/api/documents/${documentId}/pages`),
        fetch(`/api/documents/${documentId}/pages/status`),
      ]);
      if (!pagesResp.ok) throw new Error(`pages: ${pagesResp.status}`);
      if (!statusResp.ok) throw new Error(`status: ${statusResp.status}`);
      const pj = await pagesResp.json();
      const sj = await statusResp.json();
      setPages(Array.isArray(pj?.pages) ? pj.pages : []);
      setNativePdf(pj?.viewer === "pdf-native");
      setPdfPrepared(!!pj?.pdf_prepared);
      setStatus(sj);
      setError(null);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setPages([]);
    setNativePdf(false);
    setPdfPrepared(false);
    setStatus(null);
    setError(null);
    setPageNumber(initialPage ?? 1);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, documentId, initialPage]);

  useEffect(() => {
    if (!open) return;
    if (!status) return;
    const done = status.status === "ready" || status.status === "error" || status.status === "missing";
    if (done) {
      if (pollTimer.current) {
        window.clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
      return;
    }
    if (pollTimer.current) return;
    pollTimer.current = window.setInterval(refresh, 1500);
    return () => {
      if (pollTimer.current) {
        window.clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, status?.status]);

  const totalPages = status?.total || pages.length || 0;
  const currentPageInfo = pages.find((p) => p.page_number === pageNumber);
  const currentPageRendered = Boolean(currentPageInfo);

  // v1.0.9 bounce-back fix: page-nav buttons (and keyboard shortcuts) are
  // "jump" gestures - they should re-anchor scroll in continuous mode.
  // jumpToPage() moves the continuous viewport immediately; Readable mode
  // continues to use the selected page's single image.
  const goPrev = () => jumpToPage(pageNumberRef.current - 1);
  const goNext = () => jumpToPage(pageNumberRef.current + 1);

  // ------------------------------------------------------------------
  // v1.1.0: page-number input draft state.
  //
  // The toolbar's "page N / total" box used to be a controlled input bound
  // straight to `pageNumber`, committing on every keystroke. That made it
  // impossible to type into: clearing the field produced an empty string, the
  // onChange guard rejected it as non-finite, and because the value came from
  // `pageNumber` the display immediately snapped back to the current page. Same
  // for a leading "0". The user had to fight the box on every edit.
  //
  // `pageDraft` holds exactly what the user has typed -- including transiently
  // empty or out-of-range text -- and nothing commits until Enter or blur.
  // ------------------------------------------------------------------
  const [pageDraft, setPageDraft] = useState<string>(String(initialPage ?? 1));

  // Keep the draft in step with the page we are actually on whenever the page
  // changes for any other reason (nav buttons, keyboard, continuous scroll,
  // reopening the viewer). This does not fight the user's typing: while the
  // input is focused they own the draft, and a commit sets `pageNumber` first,
  // so this effect just confirms the value they already see.
  useEffect(() => {
    setPageDraft(String(pageNumber));
  }, [pageNumber]);

  // Commit the draft as a jump. Silent on invalid input -- an empty box or a
  // stray "0" simply reverts to the current page with no toast and no jump,
  // which is what a user expects from a spinner-style field.
  const commitPageDraft = () => {
    const raw = pageDraft.trim();
    const v = parseInt(raw, 10);
    if (raw === "" || !Number.isFinite(v) || v < 1) {
      setPageDraft(String(pageNumber));
      return;
    }
    // Preserve the existing clamp so pasting a huge number still bounds to the
    // last page rather than jumping nowhere.
    const target = Math.min(v, totalPages || v);
    if (target === pageNumber) {
      // Normalize display (e.g. "007" -> "7") without a redundant jump.
      setPageDraft(String(pageNumber));
      return;
    }
    jumpToPage(target);
  };

  // ------------------------------------------------------------------
  // Keyboard shortcuts. Bound while the dialog is open.
  // Priority order (highest first):
  //   1. Search input is focused -> let the input handle its own keys
  //      (Escape closes panel; Enter/Shift+Enter navigate results)
  //   2. Ctrl/Cmd+F opens the search panel
  //   3. `[` and `]` always navigate pages
  //   4. Arrow keys pan when zoomed > 1x, else navigate pages
  //   5. `+`, `-`, `=`, `0` control zoom
  //   6. PageUp/PageDown navigate pages
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // Ctrl/Cmd+F opens the search panel from anywhere in the viewer.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      // If focus is inside the search input, let the input handle its own keys.
      // (Escape closes the panel below; nav keys go to result list handlers.)
      const active = document.activeElement as HTMLElement | null;
      const inSearchInput = active === searchInputRef.current;
      // Number fields need 0 and arrow keys for editing, not zoom/navigation.
      if (inSearchInput || active?.matches("input, textarea, select") || active?.isContentEditable) return;

      // Escape closes search panel when open; otherwise let the dialog close.
      if (e.key === "Escape") {
        if (searchOpen) { e.preventDefault(); setSearchOpen(false); }
        return;
      }
      // Always-active page navigation via `[` and `]`
      if (e.key === "[") { e.preventDefault(); goPrev(); return; }
      if (e.key === "]") { e.preventDefault(); goNext(); return; }
      // Zoom shortcuts
      if (e.key === "+" || (e.key === "=" && !e.shiftKey)) { e.preventDefault(); zoom.zoomIn(); return; }
      if (e.key === "-") { e.preventDefault(); zoom.zoomOut(); return; }
      if (e.key === "0") { e.preventDefault(); zoom.reset(); return; }
      // Arrow / PageUp / PageDown
      if (e.key === "PageUp") { e.preventDefault(); goPrev(); return; }
      if (e.key === "PageDown") { e.preventDefault(); goNext(); return; }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (zoom.isZoomed) zoom.panFromKey("left", e.shiftKey);
        else goPrev();
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        if (zoom.isZoomed) zoom.panFromKey("right", e.shiftKey);
        else goNext();
        return;
      }
      if (e.key === "ArrowUp") {
        if (zoom.isZoomed) { e.preventDefault(); zoom.panFromKey("up", e.shiftKey); }
        return;
      }
      if (e.key === "ArrowDown") {
        if (zoom.isZoomed) { e.preventDefault(); zoom.panFromKey("down", e.shiftKey); }
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pageNumber, pages.length, status?.total, zoom.isZoomed, searchOpen]);

  // Reset img-loading flag whenever the page changes so the skeleton flashes
  // during network fetch of the new JPEG. Only relevant in Readable (single-
  // page) mode; the continuous-scroll Fit view renders many <img>s directly
  // and doesn't gate on this flag.
  useEffect(() => { setImgLoading(true); }, [pageNumber]);

  // ------------------------------------------------------------------
  // v1.2.7: the continuous viewer derives its mounted range directly from
  // scrollTop and deterministic page geometry. Scrollbar jumps do not rely
  // on old pages intersecting the viewport. The separate Readable view
  // still uses the existing single-image zoom hook.
  // ------------------------------------------------------------------

  // v1.2.7: keep the continuous viewport mounted when the active page is
  // still rendering. Missing pages have sized placeholders, not a mode flip.
  const continuousFit = fitMode === "fit" && pages.length > 0 && totalPages > 0;
  const continuousRef = useRef<ContinuousPdfHandle>(null);

  const jumpToPage = useCallback((n: number) => {
    const total = statusRef.current?.total ?? pages.length ?? n;
    const target = Math.max(1, Math.min(total || n, n));
    continuousRef.current?.jumpToPage(target);
    setPageNumber(target);
  }, [pages.length]);

  // ------------------------------------------------------------------
  // Search input local key handling (Enter / Shift+Enter to navigate)
  // ------------------------------------------------------------------
  const onSearchInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setSearchOpen(false);
      return;
    }
    if (e.key === "Enter" && searchResults.length > 0) {
      e.preventDefault();
      const step = e.shiftKey ? -1 : 1;
      const next = (selectedResultIdx + step + searchResults.length) % searchResults.length;
      jumpToResult(next);
    }
  };

  const jumpToResult = (idx: number) => {
    const r = searchResults[idx];
    if (!r) return;
    setSelectedResultIdx(idx);
    const target = r.chunk.page_start ?? 1;
    // v1.0.9 bounce-back fix: search-result clicks are jump gestures too.
    if (target !== pageNumber) jumpToPage(target);
  };

  // ------------------------------------------------------------------
  // Print dialog state (unchanged from v0.9.17)
  // ------------------------------------------------------------------
  const [printOpen, setPrintOpen] = useState(false);
  const [preparationUrl, setPreparationUrl] = useState<string|null>(null);
  const [printCleanupNotice, setPrintCleanupNotice] = useState("");
  useEffect(()=>{if(!open)setPreparationUrl(null);},[open]);
  // v1.1.0: "all" added so printing a whole document is one click instead of
  // switching to Range and hand-typing 1..totalPages.
  const [printMode, setPrintMode] = useState<"current" | "all" | "range">("current");
  // Keep editable drafts, just like page jump: clearing a number must not
  // immediately insert 1 and fight the next keystroke.
  const [printFrom, setPrintFrom] = useState("1");
  const [printTo, setPrintTo] = useState("1");
  const normalizePrintPage = (draft: string) => {
    const value = Number(draft);
    return draft.trim() && Number.isInteger(value) && value > 0
      ? Math.min(totalPages || value, value)
      : pageNumber;
  };

  const doPrint = () => {
    if(!totalPages)return;
    let from=printMode==="all"?1:printMode==="current"?pageNumber:normalizePrintPage(printFrom);
    let to=printMode==="all"?totalPages:printMode==="current"?pageNumber:normalizePrintPage(printTo);
    if(from>to)[from,to]=[to,from];
    // Both flows go directly to preparation; opening/printing remains an explicit action there.
    const route=nativePdf?"/api/pdf/print":"/api/rendered-print";
    const printUrl=new URL(`${route}/${encodeURIComponent(documentId)}`,window.location.origin);
    printUrl.searchParams.set("from",String(from));printUrl.searchParams.set("to",String(to));
    printUrl.searchParams.set("embedded","1");printUrl.searchParams.set("job",crypto.randomUUID());
    setPrintCleanupNotice("");setPreparationUrl(printUrl.href);
    setPrintOpen(false);
  };

  const handlePrintButton = () => {
    if (!currentPageRendered) return;
    // Initialize only when opening, not when continuous-view page tracking
    // changes behind the menu while the user is editing a range.
    if (!printOpen) {
      setPrintMode("current");
      setPrintFrom(String(pageNumber));
      setPrintTo(String(pageNumber));
    }
    setPrintOpen((v) => !v);
  };

  // Pretty format for the zoom percentage label.
  const zoomPct = useMemo(() => `${Math.round(zoom.state.zoom * 100)}%`, [zoom.state.zoom]);

  // Cursor hint for the viewport
  const viewportCursor = zoom.isZoomed ? "grab" : "auto";

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
          <DialogDescription className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
            <span className="tabular-nums">
              Page {pageNumber}
              {totalPages ? ` of ${totalPages}` : ""}
            </span>
            <span className="tabular-nums text-muted-foreground/80" data-testid="text-zoom-pct">
              {zoomPct}
            </span>
            {status && (status.status === "rendering" || status.status === "pending") && (
              <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                <Loader2 className="h-3 w-3 animate-spin" />
                Rendering pages... ({status.rendered}/{status.total})
              </span>
            )}
            {status?.status === "error" && (
              <span className="text-destructive">Render error: {status.error ?? "unknown"}</span>
            )}
            {status?.status === "missing" && (
              <span className="text-muted-foreground">No page images available for this document.</span>
            )}
            {/* v1.0.10: filename + colored type badge. Header metadata only --
                the PDF toolbar and PDF search UI are deliberately untouched. */}
            <DocumentFileNameWithBadge fileName={documentFileName} />
          </DialogDescription>
        </DialogHeader>

        {/* Body: viewer + optional side search panel */}
        <div className="flex-1 min-h-0 flex">
          {/* Viewer */}
          <div className="flex-1 min-h-0 relative bg-muted/30">
            {loading && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Loading pages...
              </div>
            )}
            {!loading && error && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-destructive px-6 text-center">
                Failed to load pages: {error}
              </div>
            )}
            {!loading && !error && continuousFit && (
              <ContinuousPdfPages key={documentId} ref={continuousRef}
                documentId={documentId} pages={pages} totalPages={totalPages}
                initialPage={pageNumber} zoomed={stackZoomed}
                onZoom={setStackZoomed} onPageChange={setPageNumber}
                renderStatus={status?.status ?? "pending"} nativePdf={nativePdf} />
            )}
            {!loading && !error && !continuousFit && (
              <div
                ref={zoom.viewportRef}
                className="absolute inset-0 overflow-hidden flex items-start justify-center p-4 select-none touch-none"
                style={{ cursor: viewportCursor }}
                onWheel={zoom.onWheel}
                onPointerDown={zoom.onPointerDown}
                onPointerMove={zoom.onPointerMove}
                onPointerUp={zoom.onPointerUp}
                onPointerCancel={zoom.onPointerUp}
                onDoubleClick={zoom.onDoubleClick}
                data-testid="viewer-viewport"
              >
                {currentPageRendered ? (
                  <>
                    {imgLoading && (
                      <div className="absolute inset-0 flex items-center justify-center pointer-events-none text-muted-foreground">
                        <Loader2 className="h-5 w-5 animate-spin" />
                      </div>
                    )}
                    <PdfPageSurface
                      nativePdf={nativePdf}
                      key={pageNumber}
                      ref={imgRef}
                      documentId={documentId}
                      page={pageNumber}
                      onReady={() => {
                        setImgLoading(false);
                        // v0.9.27 - Land at the requested edge once the new
                        // image has real dimensions. landAtRef is set by the
                        // wheel handler (top on forward flip, bottom on
                        // backward flip) and defaults to "top" for jumps like
                        // section clicks or the page-number input.
                        if (fitMode === "readable") {
                          const edge = landAtRef.current;
                          landAtRef.current = "top";
                          // Two rAFs so React commits the img size before we
                          // measure it in getContentSize().
                          requestAnimationFrame(() => {
                            requestAnimationFrame(() => {
                              zoom.scrollToEdge(edge);
                            });
                          });
                        }
                      }}
                      className={
                        fitMode === "fit"
                          ? "max-w-full max-h-full h-auto w-auto shadow-md bg-white will-change-transform"
                          : "max-w-full h-auto shadow-md bg-white will-change-transform"
                      }
                      width={currentPageInfo?.width ?? 1200}
                      height={currentPageInfo?.height ?? 1600}
                      style={{
                        aspectRatio: currentPageInfo ? `${currentPageInfo.width} / ${currentPageInfo.height}` : undefined,
                        transform: zoom.transform,
                        transformOrigin: "center center",
                        transition: zoom.state.zoom === 1 ? "transform 120ms ease-out" : "none",
                        // v0.9.21: browsers default to bicubic smoothing when upscaling images,
                        // which softens small-glyph edges when zooming a page render. The
                        // -webkit-optimize-contrast hint (aka "crisp-edges" adjacent) tells
                        // the browser to preserve contrast on the upscale, which noticeably
                        // sharpens body text at 150-250% zoom without the pixelated look you
                        // get from image-rendering: pixelated.
                        imageRendering: "-webkit-optimize-contrast",
                      }}
                    />
                  </>
                ) : status?.status === "missing" ? (
                  // v1.0.4: non-PDF documents (DOCX/TXT/MD) never enter the
                  // render pipeline, so `currentPageRendered` is permanently
                  // false. Show a friendly explanation instead of a forever-
                  // spinning "Page N is still rendering" fallback.
                  <div className="mt-16 text-center text-sm text-muted-foreground max-w-md">
                    <div>No page images are available for this document.</div>
                    <div className="mt-1 text-xs">
                      Use search to find content within it.
                    </div>
                  </div>
                ) : status?.status === "error" ? (
                  // v1.0.4: surface render errors here instead of falling
                  // back to a spinner. Header already shows the short error
                  // string; body pane echoes it with more room.
                  <div className="mt-16 text-center text-sm text-destructive max-w-md px-6">
                    <div className="font-medium">Render failed for this document.</div>
                    {status.error && (
                      <div className="mt-1 text-xs text-muted-foreground">
                        {status.error}
                      </div>
                    )}
                  </div>
                ) : (
                  // Still rendering (status === "pending" | "rendering" or
                  // unknown) - keep the original spinner behavior.
                  <div className="mt-16 text-center text-sm text-muted-foreground max-w-md">
                    <Loader2 className="h-5 w-5 animate-spin mx-auto mb-3" />
                    <div>Page {pageNumber} is still rendering.</div>
                    {status && (
                      <div className="mt-1 text-xs">
                        {status.rendered} of {status.total} pages ready - this page will appear as soon as it's finished.
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* v0.9.18: In-document search side panel */}
          {searchOpen && (
            <div
              className="w-96 shrink-0 border-l border-border bg-background flex flex-col"
              data-testid="panel-doc-search"
            >
              <div className="px-3 py-2 border-b border-border flex items-center gap-2">
                <SearchIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  onKeyDown={onSearchInputKeyDown}
                  placeholder="Search this document"
                  className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
                  data-testid="input-doc-search"
                />
                <button
                  type="button"
                  onClick={() => setSearchOpen(false)}
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  title="Close search (Esc)"
                  data-testid="button-close-doc-search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="px-3 py-1.5 text-[11px] text-muted-foreground border-b border-border flex items-center justify-between gap-2">
                <span>
                  {searching ? (
                    <span className="inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> searching...</span>
                  ) : searchError ? (
                    <span className="text-destructive">{searchError}</span>
                  ) : !debouncedQuery ? (
                    <span>Enter a query. Enter jumps to next match.</span>
                  ) : searchResults.length === 0 ? (
                    <span>No matches in this document.</span>
                  ) : (
                    <span data-testid="text-result-count">
                      {searchResults.length} match{searchResults.length === 1 ? "" : "es"}
                      {selectedResultIdx >= 0 ? ` \u00b7 ${selectedResultIdx + 1} of ${searchResults.length}` : ""}
                    </span>
                  )}
                </span>
                <span className="text-muted-foreground/70">Ctrl+F</span>
              </div>
              <div className="flex-1 overflow-auto" data-testid="list-doc-search-results">
                {searchResults.map((r, idx) => {
                  const active = idx === selectedResultIdx;
                  const page = r.chunk.page_start ?? null;
                  const section = r.chunk.section_title && r.chunk.section_title !== "Body"
                    ? r.chunk.section_title
                    : null;
                  return (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => jumpToResult(idx)}
                      className={
                        "w-full text-left px-3 py-2 border-b border-border/60 transition-colors " +
                        (active
                          ? "bg-primary/10 text-foreground"
                          : "hover:bg-accent text-foreground")
                      }
                      data-testid={`doc-search-result-${idx}`}
                    >
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground mb-1 tabular-nums">
                        {page != null && <span>Page {page}</span>}
                        {page != null && section && <ChevronRight className="h-3 w-3 opacity-60" />}
                        {section && <span className="truncate">{section}</span>}
                      </div>
                      <div className="text-xs leading-snug line-clamp-3">
                        <Highlight text={r.chunk.content} query={debouncedQuery} />
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-border px-5 py-3 flex flex-wrap items-center justify-between gap-3 bg-background">
          <button
            type="button"
            onClick={goPrev}
            disabled={pageNumber <= 1}
            className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="button-page-prev"
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Previous
          </button>
          <div className="order-last w-full min-w-0 flex flex-wrap items-center justify-center gap-2 text-xs text-muted-foreground md:order-none md:w-auto md:flex-1">
            {/* v0.9.18: zoom cluster */}
            <div className="flex items-center gap-1 mr-2 pr-2 border-r border-border/60" data-testid="zoom-toolbar">
              <button
                type="button"
                onClick={zoom.zoomOut}
                disabled={zoom.state.zoom <= MIN_ZOOM + 0.001}
                title="Zoom out (-)"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                data-testid="button-zoom-out"
              >
                <ZoomOutIcon className="h-3.5 w-3.5" />
              </button>
              <span className="tabular-nums text-xs w-12 text-center" data-testid="text-zoom-toolbar-pct">
                {zoomPct}
              </span>
              <button
                type="button"
                onClick={zoom.zoomIn}
                disabled={zoom.state.zoom >= MAX_ZOOM - 0.001}
                title="Zoom in (+)"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                data-testid="button-zoom-in"
              >
                <ZoomInIcon className="h-3.5 w-3.5" />
              </button>
              {/* v1.0.9.1.1 - Zoom Page toggle. Stays inside the
                  continuous-Fit stack in BOTH states so smooth scroll and
                  the full-document scrollbar keep working - clicking
                  never drops out to the old single-page Readable viewer.
                  Fitted state: page height caps at the viewport (whole
                  page in view). Zoomed-in state: page is magnified past
                  the viewport for reading; native scroll walks the page
                  and continues into the next one. */}
              <button
                type="button"
                onClick={() => {
                  // Guard: if we somehow ended up in the legacy Readable
                  // (single-page) viewer, first drop back into the
                  // continuous stack; the Zoom Page state itself is
                  // authoritative from here on.
                  if (fitMode !== "fit") {
                    setFitMode("fit");
                    zoom.setZoom(1);
                    landAtRef.current = "top";
                  }
                  setStackZoomed((z) => !z);
                }}
                title={
                  stackZoomed
                    ? "Currently zoomed in for reading. Click to fit the whole page."
                    : "Currently fitting the whole page. Click to zoom in for reading (continuous scroll preserved)."
                }
                className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2 text-xs transition-colors hover:bg-accent hover:text-foreground"
                data-testid="button-zoom-fit"
                aria-pressed={stackZoomed}
              >
                <Maximize2 className="h-3.5 w-3.5" /> Zoom Page
              </button>
            </div>
            {/* v0.9.25 - wheel-action radio removed. The Fit/Readable toggle
                now implies the wheel behavior:
                  Fit -> wheel flips whole pages
                  Readable -> wheel smart-scrolls with roll-over at page edges
                Ctrl+wheel still zooms in either mode. */}
            {/* Large decrement flanking the page counter on the left */}
            <button
              type="button"
              onClick={() => jumpToPage(pageNumber - 1)}
              disabled={pageNumber <= 1}
              title="Previous page ([)"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              data-testid="button-step-prev"
              aria-label="Previous page"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            {/* Editable page counter.

                v1.1.0: driven by `pageDraft`, not by `pageNumber` directly.
                Previously the input was controlled by `pageNumber` and committed
                on every keystroke, so an intermediate empty string or "0" was
                rejected and the display snapped straight back to the current
                page -- the user could never clear the box to type a new number.
                Now typing only edits the draft; the jump commits on Enter or
                blur. `min`/`max` are kept for accessibility and native keyboard
                stepping but are NOT relied on for the controlled-value logic. */}
            <div className="flex items-center gap-1 text-xs tabular-nums">
              <input
                type="number"
                min={1}
                max={totalPages || undefined}
                value={pageDraft}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setPageDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitPageDraft();
                    e.currentTarget.blur();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    // Abandon the edit and show the page we are actually on.
                    setPageDraft(String(pageNumber));
                    e.currentTarget.blur();
                  }
                }}
                onBlur={commitPageDraft}
                className="w-14 rounded-md border border-border bg-background px-2 py-1.5 text-center text-sm tabular-nums outline-none focus:ring-1 focus:ring-primary/30 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                data-testid="input-page-jump"
                aria-label="Page number"
              />
              <span className="text-muted-foreground">/ {totalPages || "?"}</span>
            </div>
            {/* Large increment flanking the page counter on the right */}
            <button
              type="button"
              onClick={() => jumpToPage(pageNumber + 1)}
              disabled={!totalPages || pageNumber >= totalPages}
              title="Next page (])"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              data-testid="button-step-next"
              aria-label="Next page"
            >
              <ArrowRight className="h-4 w-4" />
            </button>
            {/* v0.9.18: Search button */}
            <button
              type="button"
              onClick={() => setSearchOpen((v) => !v)}
              title="Search this document (Ctrl+F)"
              className={
                "inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs transition-colors hover:bg-accent hover:text-foreground ml-1 " +
                (searchOpen ? "bg-accent text-foreground" : "")
              }
              data-testid="button-toggle-doc-search"
            >
              <SearchIcon className="h-3.5 w-3.5" /> Search
            </button>
            {/* Print button with popover (unchanged) */}
            {nativePdf && <button type="button" data-testid="button-open-original-pdf"
              className="inline-flex items-center rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-accent"
              title="Open a temporary copy in the Windows default PDF app; the retained original is unchanged."
              onClick={async(e)=>{
                const button=e.currentTarget;button.disabled=true;
                try{
                  const r=await fetch(`/api/pdf/open-original/${encodeURIComponent(documentId)}`,{
                    method:"POST",headers:{"X-APD-PDF-Action":"open-original"}});
                  if(!r.ok){
                    const data=await r.json();
                    throw new Error(data.message || "Could not open the PDF app.");
                  }
                }catch{alert("Could not open the PDF app. Use the print preview's Download original PDF option instead.");}
                finally{button.disabled=false;}
              }}>{pdfPrepared ? "Open compatible PDF" : "Open original PDF"}</button>}
            <div className="relative ml-1">
              <button
                type="button"
                onClick={handlePrintButton}
                disabled={!currentPageRendered}
                title="Print"
                className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                data-testid="button-print-page"
              >
                <Printer className="h-3.5 w-3.5" /> Print
              </button>
              {printOpen && (
                <div
                  className="absolute right-0 bottom-full mb-2 w-72 rounded-md border border-border bg-popover p-3 shadow-md z-50 text-xs"
                  data-testid="popover-print-range"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="font-medium text-foreground mb-2">Print</div>
                  <label className="flex items-start gap-2 py-1 cursor-pointer">
                    <input
                      type="radio"
                      name="printMode"
                      checked={printMode === "current"}
                      onChange={() => setPrintMode("current")}
                      className="mt-0.5"
                      data-testid="radio-print-current"
                    />
                    <span>Current page only (page {pageNumber})</span>
                  </label>
                  {/* v1.1.0: "All pages" sits between Current and Range so the
                      reading order runs narrowest -> widest -> custom. */}
                  <label className="flex items-start gap-2 py-1 cursor-pointer">
                    <input
                      type="radio"
                      name="printMode"
                      checked={printMode === "all"}
                      onChange={() => setPrintMode("all")}
                      className="mt-0.5"
                      data-testid="radio-print-all"
                    />
                    <span>All pages</span>
                  </label>
                  {printMode === "all" && (
                    <div className="mt-1 pl-6 text-muted-foreground" data-testid="text-print-all-count">
                      {`${totalPages} page${totalPages === 1 ? "" : "s"}`}
                    </div>
                  )}
                  <label className="flex items-start gap-2 py-1 cursor-pointer">
                    <input
                      type="radio"
                      name="printMode"
                      checked={printMode === "range"}
                      onChange={() => setPrintMode("range")}
                      className="mt-0.5"
                      data-testid="radio-print-range"
                    />
                    <span>Range</span>
                  </label>
                  <div className={`mt-2 flex items-center gap-2 pl-6 ${printMode === "range" ? "" : "opacity-50 pointer-events-none"}`}>
                    <span className="text-muted-foreground">From</span>
                    <input
                      type="number"
                      min={1}
                      max={totalPages || undefined}
                      value={printFrom}
                      aria-label="From page"
                      disabled={printMode !== "range"}
                      onFocus={(e) => e.currentTarget.select()}
                      onClick={(e) => e.currentTarget.select()}
                      onChange={(e) => setPrintFrom(e.target.value)}
                      onBlur={() => setPrintFrom(String(normalizePrintPage(printFrom)))}
                      className="w-16 rounded-md border border-border bg-background px-2 py-1 text-xs tabular-nums outline-none focus:ring-1 focus:ring-primary/30"
                      data-testid="input-print-from"
                    />
                    <span className="text-muted-foreground">To</span>
                    <input
                      type="number"
                      min={1}
                      max={totalPages || undefined}
                      value={printTo}
                      aria-label="To page"
                      disabled={printMode !== "range"}
                      onFocus={(e) => e.currentTarget.select()}
                      onClick={(e) => e.currentTarget.select()}
                      onChange={(e) => setPrintTo(e.target.value)}
                      onBlur={() => setPrintTo(String(normalizePrintPage(printTo)))}
                      className="w-16 rounded-md border border-border bg-background px-2 py-1 text-xs tabular-nums outline-none focus:ring-1 focus:ring-primary/30"
                      data-testid="input-print-to"
                    />
                  </div>
                  {printMode === "range" && (
                    <div className="mt-2 pl-6 text-muted-foreground">
                      {(() => {
                        if (!printFrom.trim() || !printTo.trim()) return "Enter a start and end page";
                        const a = Math.min(normalizePrintPage(printFrom), normalizePrintPage(printTo));
                        const b = Math.max(normalizePrintPage(printFrom), normalizePrintPage(printTo));
                        const n = Math.max(0, Math.min(totalPages || b, b) - Math.max(1, a) + 1);
                        return `${n} page${n === 1 ? "" : "s"}`;
                      })()}
                    </div>
                  )}
                  <div className="mt-3 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setPrintOpen(false)}
                      className="rounded-md border border-border px-3 py-1 text-xs hover:bg-accent"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={doPrint}
                      className="rounded-md bg-primary text-primary-foreground px-3 py-1 text-xs hover:bg-primary/90"
                      data-testid="button-print-confirm"
                    >
                      Print
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={goNext}
            disabled={!totalPages || pageNumber >= totalPages}
            className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="button-page-next"
          >
            Next <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
        {printCleanupNotice&&<p role="status" className="px-5 py-2 text-xs text-muted-foreground">{printCleanupNotice}</p>}
        {preparationUrl&&<PrintPreparationDialog url={preparationUrl} onDone={message=>{setPreparationUrl(null);setPrintCleanupNotice(message);}}/>}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// v1.0.5: DOCX / TXT / Markdown viewer.
//
// DOCX and other non-PDF documents have no per-page image renders in the
// pages sidecar, so the classic PageViewer stayed permanently on its
// "Render error" state for them. The new /api/documents/:id/content
// endpoint reassembles the extracted text out of the chunks table, so we
// can show the full body inside the same dialog chrome as the PDF viewer.
//
// Rendering is intentionally minimal for the v1.0.5 build:
//   * No markdown-to-HTML pass. The client has no markdown library and
//     we do not want to add one (plus DOMPurify) at 1.0.5 scope.
//   * Content is rendered inside <pre className="whitespace-pre-wrap"> so
//     headings, lists, and indentation all survive visually.
//   * <Highlight> is reused for the in-viewer search input so hits get
//     the same amber highlight as the query / library pages.
//
// A follow-up release can swap the <pre> for a real markdown renderer.
// ---------------------------------------------------------------------------

type ContentPayload = {
  format: "docx" | "text" | "markdown";
  markdown: string;
  chunk_count: number;
  char_count: number;
};

function DocumentContentViewerDialog({
  open,
  onOpenChange,
  documentId,
  documentTitle,
  documentTitleColor,
  documentFileName,
}: Props) {
  const [payload, setPayload] = useState<ContentPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [searchInput, setSearchInput] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  // v1.0.8: hidden-iframe print for TXT/MD viewers, mirroring the
  // pattern DocxViewer uses. srcdoc keeps CSP quiet and the invisible
  // iframe avoids popup blockers.
  const printFrameRef = useRef<HTMLIFrameElement | null>(null);
  useEffect(() => {
    if (open) return;
    // Dialog closed -- kill any lingering print iframe.
    if (printFrameRef.current) {
      printFrameRef.current.remove();
      printFrameRef.current = null;
    }
  }, [open]);

  const handlePrint = useCallback(() => {
    if (!payload) return;
    const safe = (s: string): string =>
      s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    const safeTitle = safe(documentTitle || documentFileName || "Document");
    const bodyHtml = safe(payload.markdown);
    const styles =
      `@page { margin: 15mm; }\n` +
      `html, body { margin: 0; padding: 0; background: #fff; color: #000; }\n` +
      `pre {\n` +
      `  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;\n` +
      `  font-size: 12pt;\n` +
      `  line-height: 1.45;\n` +
      `  white-space: pre-wrap;\n` +
      `  word-wrap: break-word;\n` +
      `  margin: 0;\n` +
      `}\n`;
    const srcdoc =
      `<!doctype html><html><head><meta charset="utf-8">` +
      `<title>${safeTitle}</title>` +
      `<style>${styles}</style>` +
      `</head><body><pre>${bodyHtml}</pre></body></html>`;

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
      const win = iframe.contentWindow;
      if (!win) {
        cleanup();
        return;
      }
      try {
        win.addEventListener("afterprint", cleanup);
      } catch {
        /* ignore */
      }
      win.requestAnimationFrame(() => {
        try {
          win.focus();
          win.print();
        } catch (err) {
          console.warn("Print failed:", err);
          cleanup();
        }
      });
    });
    window.setTimeout(cleanup, 30_000);
    document.body.appendChild(iframe);
    printFrameRef.current = iframe;
  }, [payload, documentTitle, documentFileName]);

  // Reset state whenever the dialog is (re)opened for a fresh document.
  useEffect(() => {
    if (!open) return;
    setPayload(null);
    setLoading(true);
    setError(null);
    setSearchInput("");
    setDebouncedQuery("");

    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(`/api/documents/${documentId}/content`);
        if (!resp.ok) {
          const bodyText = await resp.text().catch(() => "");
          let msg = `content: ${resp.status}`;
          try {
            const j = JSON.parse(bodyText);
            if (j?.message) msg = j.message;
          } catch {
            if (bodyText) msg = bodyText.slice(0, 200);
          }
          throw new Error(msg);
        }
        const j = (await resp.json()) as ContentPayload;
        if (!cancelled) setPayload(j);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, documentId]);

  // Debounce the in-viewer search so highlight recomputation stays cheap
  // even on large DOCX bodies (~200 KB is a realistic upper bound).
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(searchInput.trim()), 200);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  const formatLabel = payload
    ? payload.format === "docx"
      ? "DOCX"
      : payload.format === "text"
      ? "Text"
      : "Markdown"
    : "Document";

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
          <DialogDescription className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
            <span className="tabular-nums">{formatLabel} view</span>
            {payload && (
              <span className="tabular-nums text-muted-foreground/80">
                {payload.chunk_count} sections · {payload.char_count.toLocaleString()} chars
              </span>
            )}
            {/* v1.0.10: filename now carries the colored type badge. */}
            <DocumentFileNameWithBadge fileName={documentFileName} />
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 py-2 border-b border-border shrink-0 flex items-center gap-2">
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Highlight text in document…"
            className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
            data-testid="input-content-highlight"
          />
          {/* v1.0.8.2: bordered Print button for TXT / MD viewers so it
              reads as a control rather than sinking into the toolbar
              background. Matches the doc-detail "Print" affordance. */}
          <button
            type="button"
            onClick={handlePrint}
            disabled={!payload}
            title="Print"
            className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="button-print-content"
          >
            <Printer className="h-3.5 w-3.5" /> Print
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto px-6 py-5">
          {loading && (
            <div className="text-sm text-muted-foreground">Loading document…</div>
          )}
          {!loading && error && (
            <div className="text-sm text-destructive">
              Could not load document content: {error}
            </div>
          )}
          {!loading && !error && payload && (
            <pre
              className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-foreground"
              data-testid="text-document-content"
            >
              <Highlight text={payload.markdown} query={debouncedQuery} />
            </pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
