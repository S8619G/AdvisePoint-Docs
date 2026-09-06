// v0.9.18 - zoom & pan controller for the page viewer.
//
// Design notes:
// * State is a plain (zoom, panX, panY) triple applied to the target <img>
//   as a CSS `transform: translate(...) scale(...)`. No canvas, no re-render
//   of the source JPEG - just GPU-accelerated CSS transforms.
// * Zoom is bounded [MIN_ZOOM, MAX_ZOOM]. Panning is clamped so the image
//   edges cannot pull past the container edges (no dragging into empty space).
// * "Zoom to cursor" - when the user scrolls the wheel, we compute the new
//   zoom then adjust pan so the pixel currently under the cursor stays under
//   the cursor. That is the natural feel every image viewer uses.
// * Panning only makes sense when zoom > 1. At exactly 1 (fit) the pan is
//   forced to (0, 0) and the drag/keyboard handlers no-op.
// * Consumers call `resetOnChange(pageNumber)` (or similar dep) to snap back
//   to fit-view whenever the page turns. Per user preference for v0.9.18,
//   zoom always resets on page change.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// -------- Configurable limits --------
// v0.9.25 - Fit mode uses zoom=1 with the image sized to fit both viewport
// dimensions (max-w-full max-h-full). Readable mode uses zoom = READABLE_ZOOM
// which magnifies the Fit render so the page overflows the viewport
// vertically, giving the user a closer read AND letting the wheel smart-scroll
// through the visible page before flipping to the next one.
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;
// v0.9.27 - Readable mode is now natural 100% zoom (was 1.6). This shows
// the page at the size the frontend receives it. The page image is still
// larger than a landscape viewport vertically, so wheel smart-scroll still
// kicks in - just at a more predictable magnification than the 1.6x default.
export const READABLE_ZOOM = 1.0;
export const ZOOM_STEP = 1.25;         // multiplicative for + / - buttons
export const ARROW_PAN_PX = 60;        // arrow-key nudge in image pixels
export const SHIFT_PAN_MULTIPLIER = 3.3; // Shift + arrow == 200px

export type ZoomPanState = {
  zoom: number;
  panX: number; // px, translate applied after scale
  panY: number;
};

// v0.9.20: mouse-wheel behavior is user-configurable.
// * "scroll" (default) - wheel scrolls the viewport container. When zoomed to
//   fit (1x) there's usually nothing to scroll; when zoomed in the container
//   is overflow: auto so the wheel scrolls through the page image.
// * "zoom" - wheel zooms toward the cursor (previous v0.9.18 behavior).
// * v0.9.22 "page" - wheel down = next page, wheel up = previous page. The
//   toolbar prev/next buttons still work; this just adds a hands-off nav
//   option for users who want to flip through a manual with the wheel.
// * `wheelDirection: "inverted"` flips the sign so users on trackpad-only
//   builds or with non-natural-scroll preferences can invert the axis without
//   changing their OS setting.
// v0.9.25 - "smart" combines line-by-line pan with automatic page flip when
// the pan reaches the bottom (or top) of the visible image. Used in Readable
// mode: scroll down through the page a few lines at a time, and when you
// bottom out the next wheel notch flips to the top of the next page. Wheel-up
// mirrors it: scroll up until you top out, then flip to the bottom of the
// previous page.
export type WheelAction = "scroll" | "zoom" | "page" | "smart";
export type WheelDirection = "natural" | "inverted";

export type UseZoomPanOptions = {
  enabled?: boolean;         // gates all handlers; used to disable during page render
  onZoomChange?: (z: number) => void;
  wheelAction?: WheelAction;
  wheelDirection?: WheelDirection;
  // v0.9.22 - invoked when wheelAction === "page" and the accumulated delta
  // crosses the notch threshold. dir = +1 for next page, -1 for previous.
  // Consumer applies page bounds (don't call setPageNumber past first/last).
  onWheelPageNav?: (dir: 1 | -1, opts?: { landAt?: "top" | "bottom" }) => void;
  // v0.9.27 - Optional override for pan clamp bounds. When the consumer knows
  // the actual displayed content is larger than the viewport (e.g. Readable
  // mode with the image rendered at natural height rather than clipped to
  // fit), it can pass a function returning the current content dimensions.
  // If omitted, panning falls back to the classic (vp * (zoom - 1)) / 2 model,
  // which only allows panning when zoom > 1.
  getContentSize?: () => { width: number; height: number } | null;
};

export type UseZoomPanReturn = {
  state: ZoomPanState;
  // Transform string ready for a CSS `transform` prop.
  transform: string;
  isZoomed: boolean;
  // Explicit controls
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
  // v0.9.23.2 - reset only the pan (center the image) while preserving the
  // current zoom level. Used by the page viewer to keep zoom on page change.
  resetPan: () => void;
  // v0.9.25 - programmatic pan setter (image pixels). Clamped internally.
  setPan: (panX: number, panY: number) => void;
  // v0.9.25 - snap to the top or bottom edge of the currently-zoomed image.
  // Used by the Readable-mode smart-scroll when flipping to the previous page
  // (land at bottom) or the next page (land at top, which is the default).
  scrollToEdge: (edge: "top" | "bottom") => void;
  setZoom: (z: number) => void;
  // Handlers to bind to the viewport element.
  onWheel: (e: React.WheelEvent<HTMLElement>) => void;
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
  onDoubleClick: (e: React.MouseEvent<HTMLElement>) => void;
  // Ref to attach to the scroll container (used for wheel origin math).
  // Callback ref so we can attach a native non-passive wheel listener the
  // instant the DOM node mounts.
  viewportRef: React.Ref<HTMLDivElement>;
  // Programmatic pan (used by keyboard shortcuts elsewhere).
  panBy: (dx: number, dy: number) => void;
  // Nudge from a signed direction, respects Shift multiplier.
  panFromKey: (key: "up" | "down" | "left" | "right", fast: boolean) => void;
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function useZoomPan(opts: UseZoomPanOptions = {}): UseZoomPanReturn {
  const enabled = opts.enabled !== false;
  const [state, setState] = useState<ZoomPanState>({ zoom: 1, panX: 0, panY: 0 });
  // v0.9.22.1 - stateRef mirrors `state` synchronously so the wheel handler
  // can read the freshest zoom/pan without going through the reducer (which
  // strict mode double-invokes).
  const stateRef = useRef(state);
  stateRef.current = state;
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ active: boolean; startX: number; startY: number; basePanX: number; basePanY: number; pointerId: number | null }>({
    active: false, startX: 0, startY: 0, basePanX: 0, basePanY: 0, pointerId: null,
  });

  const isZoomed = state.zoom > 1.001;

  // Fire onZoomChange whenever zoom crosses a boundary
  const zoomRef = useRef(state.zoom);
  useEffect(() => {
    if (zoomRef.current !== state.zoom) {
      zoomRef.current = state.zoom;
      opts.onZoomChange?.(state.zoom);
    }
  }, [state.zoom, opts]);

  // Clamp pan so image edges stay within viewport bounds.
  // Two modes:
  //   (a) Classic (no getContentSize): image is CENTER-anchored in the
  //       viewport by CSS. At zoom>1 the extra size in each direction is
  //       (vp * (zoom-1)) and pan bounds are symmetric +/- extra/2.
  //   (b) Content-mode (getContentSize provided): image is TOP-anchored
  //       (items-start) and its rendered dimensions can already exceed the
  //       viewport at zoom=1. Overflow = content*zoom - viewport. Pan bounds
  //       become [-(overflow), 0] on the Y axis (translate up to reveal the
  //       bottom edge; can never translate down past initial top-alignment).
  //       X axis stays centered (max-w-full guarantees content fits
  //       horizontally in Readable at zoom=1; at zoom>1 we allow symmetric
  //       horizontal pan).
  const getContentSizeRef = useRef(opts.getContentSize);
  getContentSizeRef.current = opts.getContentSize;
  const clampPan = useCallback((panX: number, panY: number, zoom: number): { panX: number; panY: number } => {
    const vp = viewportRef.current;
    if (!vp) return { panX: 0, panY: 0 };
    const w = vp.clientWidth;
    const h = vp.clientHeight;
    const content = getContentSizeRef.current?.() ?? null;
    if (content) {
      const overflowY = Math.max(0, content.height * zoom - h);
      const overflowX = Math.max(0, content.width * zoom - w);
      // Y: top-anchored, so panY in [-overflowY, 0].
      // X: horizontally centered, symmetric pan bounds.
      const minY = -overflowY;
      const maxY = 0;
      const maxX = overflowX / 2;
      return {
        panX: clamp(panX, -maxX, maxX),
        panY: clamp(panY, minY, maxY),
      };
    }
    if (zoom <= 1) return { panX: 0, panY: 0 };
    const maxX = (w * (zoom - 1)) / 2;
    const maxY = (h * (zoom - 1)) / 2;
    return {
      panX: clamp(panX, -maxX, maxX),
      panY: clamp(panY, -maxY, maxY),
    };
  }, []);

  const setZoom = useCallback((next: number) => {
    setState((prev) => {
      const z = clamp(next, MIN_ZOOM, MAX_ZOOM);
      if (z === prev.zoom) return prev;
      // When zooming out to 1, snap pan to 0. Otherwise re-clamp.
      const { panX, panY } = clampPan(prev.panX, prev.panY, z);
      return { zoom: z, panX, panY };
    });
  }, [clampPan]);

  const zoomIn = useCallback(() => setZoom(zoomRef.current * ZOOM_STEP), [setZoom]);
  const zoomOut = useCallback(() => setZoom(zoomRef.current / ZOOM_STEP), [setZoom]);
  const reset = useCallback(() => setState({ zoom: 1, panX: 0, panY: 0 }), []);
  const resetPan = useCallback(() => setState((prev) => (prev.panX === 0 && prev.panY === 0 ? prev : { ...prev, panX: 0, panY: 0 })), []);
  const setPan = useCallback((panX: number, panY: number) => {
    setState((prev) => {
      const c = clampPan(panX, panY, prev.zoom);
      return { ...prev, panX: c.panX, panY: c.panY };
    });
  }, [clampPan]);
  const scrollToEdge = useCallback((edge: "top" | "bottom") => {
    setState((prev) => {
      const vp = viewportRef.current;
      if (!vp) return prev;
      const content = getContentSizeRef.current?.() ?? null;
      let panY: number;
      if (content) {
        // Top-anchored content: top edge is panY=0, bottom edge is
        // panY=-overflow. Only non-trivial when content overflows.
        const overflowY = Math.max(0, content.height * prev.zoom - vp.clientHeight);
        if (overflowY === 0) return prev;
        panY = edge === "top" ? 0 : -overflowY;
      } else {
        if (prev.zoom <= 1) return prev;
        const maxY = (vp.clientHeight * (prev.zoom - 1)) / 2;
        panY = edge === "top" ? maxY : -maxY;
      }
      if (panY === prev.panY) return prev;
      return { ...prev, panX: 0, panY };
    });
  }, []);

  const panBy = useCallback((dx: number, dy: number) => {
    setState((prev) => {
      // v0.9.27 - allow pan at zoom=1 when content is bigger than viewport.
      // clampPan will return {0,0} when there's nothing to pan.
      const { panX, panY } = clampPan(prev.panX + dx, prev.panY + dy, prev.zoom);
      if (panX === prev.panX && panY === prev.panY) return prev;
      return { ...prev, panX, panY };
    });
  }, [clampPan]);

  const panFromKey = useCallback((key: "up" | "down" | "left" | "right", fast: boolean) => {
    const step = ARROW_PAN_PX * (fast ? SHIFT_PAN_MULTIPLIER : 1);
    switch (key) {
      case "left":  return panBy(step, 0);   // pan right (view content on left)
      case "right": return panBy(-step, 0);
      case "up":    return panBy(0, step);
      case "down":  return panBy(0, -step);
    }
  }, [panBy]);

  // -------- Wheel handler (native, non-passive so we can preventDefault) --------
  // v0.9.20: behavior depends on `wheelAction` from options.
  // * "scroll" - default. Convert the wheel delta into a pan when zoomed >1,
  //   otherwise no-op (nothing to scroll at fit). This lets users read a
  //   zoomed page without holding a key. Honours `wheelDirection`.
  // * "zoom"   - previous v0.9.18 zoom-to-cursor behavior. Honours
  //   `wheelDirection` (natural: scroll up = zoom in).
  //
  // React's synthetic onWheel is passive by default, so preventDefault() there
  // is a no-op and the page scrolls behind us. Track the DOM node via state so
  // useEffect re-runs the instant the ref attaches, then bind a native listener
  // with { passive: false } (which does honour preventDefault).
  const wheelAction: WheelAction = opts.wheelAction ?? "scroll";
  const wheelDirection: WheelDirection = opts.wheelDirection ?? "natural";
  const onWheelPageNav = opts.onWheelPageNav;
  const [viewportEl, setViewportEl] = useState<HTMLDivElement | null>(null);

  // v0.9.22 - accumulate small wheel deltas for page-nav mode. A high-DPI
  // trackpad emits many tiny deltas per gesture; naive per-event nav would
  // fly through 20 pages in one flick. We flush a page turn only when the
  // running delta crosses a threshold, then reset. The 120 unit threshold
  // matches one "notch" on a classic mouse wheel.
  const pageWheelAccumRef = useRef(0);
  const pageWheelLastFireRef = useRef(0);

  useEffect(() => {
    if (!viewportEl || !enabled) return;
    const handler = (e: WheelEvent) => {
      const sign = wheelDirection === "inverted" ? -1 : 1;
      const dY = e.deltaY * sign;
      const dX = e.deltaX * sign;
      if (wheelAction === "smart") {
        // v0.9.25 - Readable mode. At the top or bottom edge of the zoomed
        // page a wheel notch flips a page (with a small hysteresis so a fast
        // scroll doesn't over-shoot). Otherwise the wheel pans line-by-line.
        // v0.9.27 - Uses getContentSize() when available so smart-scroll works
        // at zoom=1 as long as the actual content is taller than the viewport.
        if (e.ctrlKey || e.metaKey) return;
        e.preventDefault();
        e.stopPropagation();
        const vp = viewportEl;
        const rect = vp.getBoundingClientRect();
        setState((prev) => {
          const content = getContentSizeRef.current?.() ?? null;
          // Compute pan bounds for the smart-scroll math. Content-mode uses
          // top-anchored bounds [minY, maxY] = [-overflow, 0]; classic mode
          // stays symmetric.
          let minY: number;
          let maxY: number;
          if (content) {
            const overflowY = Math.max(0, content.height * prev.zoom - rect.height);
            minY = -overflowY;
            maxY = 0;
          } else {
            if (prev.zoom <= 1) return prev;
            const m = (rect.height * (prev.zoom - 1)) / 2;
            minY = -m;
            maxY = m;
          }
          if (minY === maxY) {
            // Content fits vertically - nothing to pan, so this notch is a
            // page flip request. Push the delta directly into the accumulator.
            pageWheelAccumRef.current += dY;
            return prev;
          }
          const nextPanY = prev.panY - dY; // wheel down = image up = panY smaller
          // If the new pan would go beyond the edge, snap to the edge and
          // request a page flip on the SAME notch (via accumulator).
          if (nextPanY < minY - 0.5) {
            // Bottomed out - hand off to the page-flip accumulator (below).
            pageWheelAccumRef.current += dY;
            return { ...prev, panY: minY };
          }
          if (nextPanY > maxY + 0.5) {
            pageWheelAccumRef.current += dY;
            return { ...prev, panY: maxY };
          }
          // Reset accumulator when we successfully pan (so a slow scroll to
          // the edge doesn't inherit stale delta).
          pageWheelAccumRef.current = 0;
          return { ...prev, panY: nextPanY };
        });
        // Now check the accumulator - if we bottomed/topped out and enough
        // delta has piled up, flip a page.
        const now = Date.now();
        const threshold = 60;
        // Cooldown must be long enough for React to commit the pan reset from
        // the page-change effect before the next wheel notch reads state -
        // otherwise the reducer sees stale (edge) panY and flips again.
        const cooldownMs = 260;
        if (
          Math.abs(pageWheelAccumRef.current) >= threshold &&
          now - pageWheelLastFireRef.current >= cooldownMs
        ) {
          const dir: 1 | -1 = pageWheelAccumRef.current > 0 ? 1 : -1;
          pageWheelAccumRef.current = 0;
          pageWheelLastFireRef.current = now;
          // Wheel-down flips forward and the new page lands at TOP.
          // Wheel-up flips backward and the new page lands at BOTTOM so the
          // read continues naturally from where the previous page ended.
          onWheelPageNav?.(dir, { landAt: dir === 1 ? "top" : "bottom" });
        }
        return;
      }
      if (wheelAction === "page") {
        // Ctrl/Cmd + wheel is still the universal browser-zoom shortcut;
        // let it through so users can escape to native zoom if needed.
        if (e.ctrlKey || e.metaKey) return;
        e.preventDefault();
        e.stopPropagation();
        // v0.9.23 - Page wheel mode ALWAYS flips pages, at every zoom level.
        // Prior versions tried to be clever by scrolling within a zoomed page
        // first and only flipping at the edges, but that violated the user's
        // mental model: they set the wheel to "Page", they expect the wheel
        // to turn pages full stop. Zoom + pan is still available via drag
        // (or the zoom mode) - the wheel just flips.
        //
        // Delta accumulation prevents a single trackpad gesture (which emits
        // dozens of tiny events) from flying through 20 pages. One "notch"
        // (~100 units on a classic mouse wheel) advances one page. A short
        // cooldown between flips keeps rapid scrolls readable.
        const now = Date.now();
        const threshold = 60;
        const cooldownMs = 120;
        pageWheelAccumRef.current += dY;
        if (
          Math.abs(pageWheelAccumRef.current) >= threshold &&
          now - pageWheelLastFireRef.current >= cooldownMs
        ) {
          const dir: 1 | -1 = pageWheelAccumRef.current > 0 ? 1 : -1;
          pageWheelAccumRef.current = 0;
          pageWheelLastFireRef.current = now;
          onWheelPageNav?.(dir);
        }
        return;
      }
      if (wheelAction === "zoom") {
        // Ctrl/Cmd + wheel already means "browser zoom" - let the browser have
        // it so users can bail out to native zoom if they want.
        if (e.ctrlKey || e.metaKey) return;
        e.preventDefault();
        e.stopPropagation();
        setState((prev) => {
          const factor = Math.exp(-dY * 0.0015);
          const newZoom = clamp(prev.zoom * factor, MIN_ZOOM, MAX_ZOOM);
          if (newZoom === prev.zoom) return prev;
          const rect = viewportEl.getBoundingClientRect();
          const cx = e.clientX - (rect.left + rect.width / 2);
          const cy = e.clientY - (rect.top + rect.height / 2);
          const ratio = newZoom / prev.zoom;
          const newPanX = cx - (cx - prev.panX) * ratio;
          const newPanY = cy - (cy - prev.panY) * ratio;
          const clamped = clampPan(newPanX, newPanY, newZoom);
          return { zoom: newZoom, panX: clamped.panX, panY: clamped.panY };
        });
        return;
      }
      // wheelAction === "scroll"
      // Ctrl/Cmd + wheel is the universal zoom shortcut - honour it.
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        setState((prev) => {
          const factor = Math.exp(-dY * 0.0015);
          const newZoom = clamp(prev.zoom * factor, MIN_ZOOM, MAX_ZOOM);
          if (newZoom === prev.zoom) return prev;
          const rect = viewportEl.getBoundingClientRect();
          const cx = e.clientX - (rect.left + rect.width / 2);
          const cy = e.clientY - (rect.top + rect.height / 2);
          const ratio = newZoom / prev.zoom;
          const newPanX = cx - (cx - prev.panX) * ratio;
          const newPanY = cy - (cy - prev.panY) * ratio;
          const clamped = clampPan(newPanX, newPanY, newZoom);
          return { zoom: newZoom, panX: clamped.panX, panY: clamped.panY };
        });
        return;
      }
      // Plain scroll:
      // At fit (zoom=1) there's nothing to pan and nothing to scroll inside
      // the viewport - leave the event alone so any ancestor (or the modal)
      // can react normally.
      setState((prev) => {
        if (prev.zoom <= 1) return prev;
        const clamped = clampPan(prev.panX - dX, prev.panY - dY, prev.zoom);
        return { ...prev, panX: clamped.panX, panY: clamped.panY };
      });
      // Only consume the event when we actually scrolled the image; leave it
      // untouched at fit so backdrop scroll (if any) still works.
      e.preventDefault();
      e.stopPropagation();
    };
    viewportEl.addEventListener("wheel", handler, { passive: false });
    return () => viewportEl.removeEventListener("wheel", handler);
  }, [viewportEl, enabled, clampPan, wheelAction, wheelDirection, onWheelPageNav]);

  // Consumer passes this callback ref to the viewport div. We mirror the node
  // to viewportRef.current (used by pan math) and to viewportEl state.
  const setViewportRef = useCallback((node: HTMLDivElement | null) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (viewportRef as any).current = node;
    setViewportEl(node);
  }, []);

  // No-op onWheel so callers can still spread the handler set; real work is
  // in the native listener above.
  const onWheel = useCallback((_e: React.WheelEvent<HTMLElement>) => {}, []);

  // -------- Pointer drag = pan --------
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!enabled) return;
    if (state.zoom <= 1) return; // no pan at fit
    // Only respond to primary button
    if (e.button !== 0) return;
    dragRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      basePanX: state.panX,
      basePanY: state.panY,
      pointerId: e.pointerId,
    };
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* not fatal */ }
  }, [enabled, state.zoom, state.panX, state.panY]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d.active || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    setState((prev) => {
      const { panX, panY } = clampPan(d.basePanX + dx, d.basePanY + dy, prev.zoom);
      return { ...prev, panX, panY };
    });
  }, [clampPan]);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (d.pointerId === e.pointerId) {
      dragRef.current = { active: false, startX: 0, startY: 0, basePanX: 0, basePanY: 0, pointerId: null };
      try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch { /* ok */ }
    }
  }, []);

  // -------- Double-click = toggle 2x centered on click, or reset --------
  const onDoubleClick = useCallback((e: React.MouseEvent<HTMLElement>) => {
    if (!enabled) return;
    e.preventDefault();
    const vp = viewportRef.current;
    if (!vp) return;
    setState((prev) => {
      if (prev.zoom > 1.001) {
        return { zoom: 1, panX: 0, panY: 0 };
      }
      const target = 2;
      const rect = vp.getBoundingClientRect();
      const cx = e.clientX - (rect.left + rect.width / 2);
      const cy = e.clientY - (rect.top + rect.height / 2);
      // Same math as wheel-zoom but from zoom=1.
      const ratio = target / 1;
      const newPanX = cx - (cx - 0) * ratio;
      const newPanY = cy - (cy - 0) * ratio;
      const clamped = clampPan(newPanX, newPanY, target);
      return { zoom: target, panX: clamped.panX, panY: clamped.panY };
    });
  }, [enabled, clampPan]);

  // The transform string. translate is applied before scale so that panX/panY
  // are in already-scaled (screen) pixel units - which is what the wheel/drag
  // math above computes.
  const transform = useMemo(
    () => `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`,
    [state.panX, state.panY, state.zoom],
  );

  return {
    state,
    transform,
    isZoomed,
    zoomIn,
    zoomOut,
    reset,
    resetPan,
    setPan,
    scrollToEdge,
    setZoom,
    onWheel,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onDoubleClick,
    viewportRef: setViewportRef,
    panBy,
    panFromKey,
  };
}
