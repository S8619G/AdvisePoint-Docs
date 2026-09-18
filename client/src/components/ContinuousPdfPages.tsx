import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect,
  useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { buildPdfPageLayout, pdfPageAtOffset, pdfVisibleWindow,
  type PdfPageSize, type PdfPageSlot } from "@/lib/pdf-page-layout";

export type ContinuousPdfHandle = { jumpToPage: (page: number) => void };
type Props = {
  documentId: string; pages: PdfPageSize[]; totalPages: number;
  initialPage: number; zoomed: boolean; onZoom: (zoomed:boolean) => void;
  onPageChange: (page:number) => void;
  renderStatus: string;
};

function PageImage({src, page, width, height}: {
  src:string; page:number; width:number; height:number;
}) {
  const image = useRef<HTMLImageElement>(null);
  const [state, setState] = useState<"loading"|"ready"|"error">("loading");
  const [attempt, setAttempt] = useState(0);
  // Cached images can finish before React attaches a load handler.
  useLayoutEffect(() => {
    if (image.current?.complete && image.current.naturalWidth > 0) setState("ready");
  }, [src, attempt]);
  return <div className="relative bg-white shadow-md shrink-0"
    style={{width,height}} data-testid={`page-image-frame-${page}`}>
    {state !== "ready" && <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-slate-600"
      role={state === "error" ? "alert" : "status"}>
      {state === "loading" ? <><Loader2 className="h-5 w-5 animate-spin" />
        <span>Loading page {page}…</span></> : <>
        <span>Could not load page {page}.</span>
        <button className="rounded border border-slate-400 px-3 py-1 text-slate-800"
          onClick={() => {setState("loading"); setAttempt(n => n + 1);}}>
          Retry page {page}
        </button></>}
    </div>}
    <img ref={image} key={attempt} src={attempt ? `${src}?retry=${attempt}` : src}
      alt={`Page ${page}`} width={width} height={height} draggable={false}
      loading="eager" decoding="async"
      onLoad={() => setState("ready")} onError={() => setState("error")}
      style={{width,height,visibility:state === "ready" ? "visible" : "hidden",
        imageRendering:"-webkit-optimize-contrast"}}
    />
  </div>;
}

// The scroll offset owns the render window, even when a native scrollbar drag
// skips the entire previously mounted range. No IntersectionObserver deadlock,
// image-height measurement feedback, or timed suppression of user scrolling.
export const ContinuousPdfPages = forwardRef<ContinuousPdfHandle, Props>(
function ContinuousPdfPages({documentId,pages,totalPages,initialPage,zoomed,
  onZoom,onPageChange,renderStatus}, ref) {
  const container = useRef<HTMLDivElement>(null);
  const [size,setSize] = useState({width:0,height:0});
  const [top,setTop] = useState(0);
  const scrollPosition = useRef(0);
  const frame = useRef<number|null>(null);
  const firstPage = useRef(initialPage);
  const previousLayout = useRef<PdfPageSlot[]>([]);
  const lastReported = useRef(initialPage);
  const slots = useMemo(() => buildPdfPageLayout(pages,totalPages,size.width,size.height,zoomed),
    [pages,totalPages,size.width,size.height,zoomed]);
  const rendered = useMemo(() => new Set(pages.map(p => p.page_number)),[pages]);

  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    const measure = () => setSize(old => old.width === el.clientWidth &&
      old.height === el.clientHeight ? old : {width:el.clientWidth,height:el.clientHeight});
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const publishPosition = useCallback(() => {
    const el = container.current;
    if (!el || !slots.length) return;
    scrollPosition.current = el.scrollTop;
    setTop(el.scrollTop);
    const active = slots[pdfPageAtOffset(slots,el.scrollTop + Math.min(80,el.clientHeight / 4))].page;
    if (active !== lastReported.current) {
      lastReported.current = active;
      onPageChange(active);
    }
  },[slots,onPageChange]);

  // Preserve the top page and fractional offset when width, zoom or metadata
  // changes. Absolute slot geometry never changes just because a JPEG loads.
  useLayoutEffect(() => {
    const el = container.current;
    if (!el || !slots.length) return;
    const previous = previousLayout.current;
    if (!previous.length) {
      el.scrollTop = slots[Math.max(0,Math.min(slots.length-1,firstPage.current-1))].top;
    } else {
      const index = pdfPageAtOffset(previous,scrollPosition.current);
      const fraction = Math.max(0,Math.min(1,
        (scrollPosition.current - previous[index].top) / previous[index].height));
      const next = slots[Math.min(index,slots.length-1)];
      el.scrollTop = next.top + fraction * next.height;
    }
    previousLayout.current = slots;
    publishPosition();
  },[slots,publishPosition]);

  useImperativeHandle(ref,() => ({
    jumpToPage(page) {
      const el = container.current;
      if (!el || !slots.length) return;
      // An immediate explicit jump cannot race a later scrollbar gesture.
      const index = Math.max(0,Math.min(slots.length-1,page-1));
      el.scrollTop = slots[index].top;
      scrollPosition.current = el.scrollTop;
      setTop(el.scrollTop);
      lastReported.current = page;
    },
  }),[slots]);
  useEffect(() => () => {if (frame.current !== null) cancelAnimationFrame(frame.current);},[]);

  // Native wheel listener is non-passive so Ctrl+wheel zoom does not also
  // zoom the browser. Ordinary wheel and scrollbar gestures stay native.
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const wheel = (event:WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      onZoom(event.deltaY < 0);
    };
    el.addEventListener("wheel",wheel,{passive:false});
    return () => el.removeEventListener("wheel",wheel);
  },[onZoom]);

  const window = pdfVisibleWindow(slots,top,size.height);
  // Let even a short landscape final page align at the top on explicit jumps.
  const totalHeight = slots.length ? slots[slots.length-1].top +
    Math.max(slots[slots.length-1].height,size.height) : 0;
  return <div ref={container} className="absolute inset-0 overflow-y-auto overflow-x-hidden bg-muted/30"
    style={{overflowAnchor:"none",scrollBehavior:"auto",scrollbarGutter:"stable"}}
    data-testid="viewer-continuous-stack" tabIndex={0}
    aria-label="PDF pages"
    onScroll={() => {
      scrollPosition.current = container.current?.scrollTop ?? 0;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {frame.current=null; publishPosition();});
    }}>
    <div className="relative w-full" style={{height:totalHeight}}>
      {slots.slice(window.start,window.end+1).map(slot =>
        <div key={slot.page} data-page-number={slot.page}
          data-testid={`stack-page-${slot.page}`}
          className="absolute left-0 w-full flex flex-col items-center"
          style={{top:slot.top,height:slot.height}}>
          {slot.separator > 0 && <div className="flex items-center gap-2 text-xs text-muted-foreground w-[90%] shrink-0"
            style={{height:slot.separator}} aria-hidden="true">
            <span className="h-px flex-1 bg-border" />
            <span className="px-1 tabular-nums">Page {slot.page}</span>
            <span className="h-px flex-1 bg-border" />
          </div>}
          <div className="py-2 flex justify-center w-full">
            {rendered.has(slot.page)
              ? <PageImage src={`/api/documents/${documentId}/pages/${slot.page}.jpg`}
                  page={slot.page} width={slot.imageWidth} height={slot.imageHeight} />
              : <div className="flex items-center justify-center bg-background text-muted-foreground text-sm"
                  style={{width:slot.imageWidth,height:slot.imageHeight}} role="status">
                  {renderStatus === "pending" || renderStatus === "rendering"
                    ? `Rendering page ${slot.page}…` : `Page ${slot.page} is not available.`}
                </div>}
          </div>
        </div>)}
    </div>
  </div>;
});
