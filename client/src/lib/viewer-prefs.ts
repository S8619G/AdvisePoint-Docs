// v0.9.20 - Persisted viewer preferences (mouse-wheel action + scroll direction).
//
// Design notes:
// * Two knobs stored under a single localStorage key so future viewer prefs can
//   grow the object without more keys.
// * A tiny pub-sub so both the Settings page and the in-viewer toggle stay in
//   sync when either one changes the value.
// * SSR-safe: reads guard on `typeof window`, and the initial value falls back
//   to the defaults when localStorage is unavailable.

import { useEffect, useState, useCallback } from "react";

// v0.9.22 - added "page" so the wheel can flip pages.
export type WheelAction = "scroll" | "zoom" | "page";
export type WheelDirection = "natural" | "inverted";

export type ViewerPrefs = {
  wheelAction: WheelAction;
  wheelDirection: WheelDirection;
};

const STORAGE_KEY = "apd:viewer:prefs";

export const DEFAULT_VIEWER_PREFS: ViewerPrefs = {
  wheelAction: "scroll",
  wheelDirection: "natural",
};

function readFromStorage(): ViewerPrefs {
  if (typeof window === "undefined") return DEFAULT_VIEWER_PREFS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_VIEWER_PREFS;
    const parsed = JSON.parse(raw);
    const wheelAction: WheelAction =
      parsed?.wheelAction === "zoom" ? "zoom"
      : parsed?.wheelAction === "page" ? "page"
      : "scroll";
    const wheelDirection: WheelDirection =
      parsed?.wheelDirection === "inverted" ? "inverted" : "natural";
    return { wheelAction, wheelDirection };
  } catch {
    return DEFAULT_VIEWER_PREFS;
  }
}

function writeToStorage(next: ViewerPrefs): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* quota / private mode - non-fatal */
  }
}

// -----------------------------------------------------------------------
// Cross-component pub-sub. Both the Settings tab and the viewer's inline
// radio need to see each other's updates without a full page reload.
// -----------------------------------------------------------------------
type Listener = (prefs: ViewerPrefs) => void;
const listeners = new Set<Listener>();

function notify(prefs: ViewerPrefs): void {
  listeners.forEach((fn) => {
    try { fn(prefs); } catch { /* one bad listener shouldn't break the rest */ }
  });
}

// Also react to changes made from another browser tab.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    notify(readFromStorage());
  });
}

export function getViewerPrefs(): ViewerPrefs {
  return readFromStorage();
}

export function setViewerPrefs(update: Partial<ViewerPrefs>): ViewerPrefs {
  const prev = readFromStorage();
  const next: ViewerPrefs = { ...prev, ...update };
  writeToStorage(next);
  notify(next);
  return next;
}

// React hook: subscribe to preference changes so components re-render.
export function useViewerPrefs(): [
  ViewerPrefs,
  (update: Partial<ViewerPrefs>) => void,
] {
  const [prefs, setPrefsState] = useState<ViewerPrefs>(() => readFromStorage());
  useEffect(() => {
    const fn: Listener = (p) => setPrefsState(p);
    listeners.add(fn);
    // Re-sync on mount in case an update happened between render and effect.
    setPrefsState(readFromStorage());
    return () => { listeners.delete(fn); };
  }, []);
  const update = useCallback((u: Partial<ViewerPrefs>) => {
    setViewerPrefs(u);
  }, []);
  return [prefs, update];
}
