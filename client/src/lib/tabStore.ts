// v0.9.31 - Tab-to-tab state preservation.
//
// The problem
//   Every top-level tab (Library, Query, Upload) is a route-mounted
//   component. Wouter unmounts the previous route when the user switches
//   tabs, so every local `useState` inside the tab is discarded. Users
//   type a query, filter it down, scroll through 40 hits, tap "Library"
//   to check a filename - and when they tap back to "Query", the input
//   is empty and every filter is cleared.
//
// The fix
//   Lift the state that matters into module-level singleton stores that
//   live outside the React tree, then subscribe to them via
//   useSyncExternalStore. Unmounting the tab no longer touches the
//   store, so remounting restores everything (input, filters, selected
//   result, expanded excerpts, scroll offset).
//
//   We deliberately do NOT persist to sessionStorage or localStorage.
//   State resets cleanly when the app restarts, which matches the
//   intended UX - "picking up where I left off *this session*", not
//   "carrying forward yesterday's search across an unrelated relaunch".
//
// URL sync (Option D from BACKLOG.md)
//   A subset of the state that identifies the current view - the search
//   text, the top-level filter values, the selected library doc - is
//   also mirrored to the URL query string on the hash. That means:
//     * The app can be deep-linked / bookmarked to a specific search.
//     * Refreshing the page keeps the current view.
//     * Copy-pasting a URL to a colleague reproduces what you're seeing.
//   Volatile state (scroll position, expanded-excerpt keys, kbd cursor
//   index, page viewer state) is NOT synced - it would clutter the URL
//   and doesn't need to survive a browser reload.
//
// Design choices
//   * Plain JS store, not Zustand or MobX. Zero new deps.
//   * `set(patch)` merges - callers pass either an object or a function.
//   * A single `subscribe(listener)` returns an unsubscribe function so
//     it plugs directly into useSyncExternalStore.
//   * The React binding (`useTabState`) selects a slice with a selector
//     function and uses Object.is equality to decide when to re-render.

type Listener = () => void;

interface StoreApi<T> {
  getState: () => T;
  setState: (patch: Partial<T> | ((prev: T) => Partial<T>)) => void;
  subscribe: (listener: Listener) => () => void;
  reset: () => void;
}

export function createTabStore<T extends object>(initial: T): StoreApi<T> {
  let state: T = initial;
  const listeners = new Set<Listener>();
  const initialSnapshot: T = { ...initial };

  return {
    getState: () => state,
    setState: (patch) => {
      const next = typeof patch === "function" ? patch(state) : patch;
      // Shallow merge - callers pass only the fields that changed. Using
      // Object.is per field would let us skip notifying when nothing
      // actually changed, but tabs update state often enough that a
      // blanket notify is fine and much simpler.
      state = { ...state, ...next };
      listeners.forEach((l) => l());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset: () => {
      state = { ...initialSnapshot };
      listeners.forEach((l) => l());
    },
  };
}

// -------- React binding --------
// Two hooks: `useTabStore` gives you the whole state (rerenders on any
// change; use sparingly) and `useTabState` selects a slice.
import { useCallback, useRef, useSyncExternalStore } from "react";

export function useTabStore<T extends object>(store: StoreApi<T>): T {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

export function useTabState<T extends object, S>(
  store: StoreApi<T>,
  selector: (state: T) => S,
): S {
  // getSnapshot must be stable across renders or React complains. We
  // re-derive on every subscription notification, but the selector is
  // called once per notification and its result is compared with
  // Object.is by useSyncExternalStore.
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(store.getState()),
  );
}

/**
 * useStoreField - the useState-shaped shim used inside page components.
 *
 * Returns [value, setValue] where value is a live read of one field and
 * setValue is a stable dispatcher that accepts either a new value or a
 * (prev => next) reducer, matching React's useState signature. This is
 * what lets us swap `useState<T>(init)` for `useStoreField(store, "x")`
 * without touching any of the surrounding JSX or handler code.
 */
export function useStoreField<T extends object, K extends keyof T>(
  store: StoreApi<T>,
  key: K,
): [T[K], (v: T[K] | ((prev: T[K]) => T[K])) => void] {
  const value = useTabState(store, (s) => s[key]);

  // v0.9.31 hotfix: the setter MUST have a stable identity across
  // renders. If it doesn't, any consumer that passes it into a
  // useEffect dep list (like DocSearchBar's `[debounced, onQueryChange]`
  // effect in library.tsx) will fire the effect on every render, and
  // if that effect writes back to the same store field the app spins
  // into an infinite update loop (React error #185).
  //
  // We can't useCallback([store, key]) because the store/key ARE stable
  // for the lifetime of the component but React's exhaustive-deps
  // linter warns anyway. Use a ref-and-empty-deps pattern instead, and
  // pin the latest store+key in the ref so consumers that swap keys
  // still get correct behavior.
  const targetRef = useRef({ store, key });
  targetRef.current = { store, key };
  const setValue = useCallback((v: T[K] | ((prev: T[K]) => T[K])) => {
    const { store: s, key: k } = targetRef.current;
    // The functional form must see the LATEST value from the store,
    // not a stale closure - otherwise consecutive rapid updates (like
    // typing fast) can compute against an old snapshot.
    if (typeof v === "function") {
      const fn = v as (prev: T[K]) => T[K];
      s.setState((prev) => ({ [k]: fn(prev[k]) }) as unknown as Partial<T>);
    } else {
      s.setState({ [k]: v } as unknown as Partial<T>);
    }
  }, []);
  return [value, setValue];
}
