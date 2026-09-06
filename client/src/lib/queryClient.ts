import { QueryClient, QueryFunction } from "@tanstack/react-query";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

// v0.9.26: Distinguish "backend not reachable at all" (TypeError from fetch,
// or an aborted connection) from "backend returned an HTTP error" (5xx / 4xx).
// The BackendDownOverlay listens for BackendUnreachableError to trigger.
export class BackendUnreachableError extends Error {
  constructor(message = "Backend is not reachable") {
    super(message);
    this.name = "BackendUnreachableError";
  }
}

// Global backend health state. Two levels:
//   "reconnecting" - a brief disconnect (server busy rendering, brief network
//                    hiccup, resumed laptop). Shown as an unobtrusive banner
//                    at the top of the app.
//   "down"         - a prolonged disconnect. Shown as a full-screen modal
//                    that tells the user to relaunch the app.
// Both are set by the health-poller in BackendDownOverlay and by any query
// that hits a TypeError from fetch. Subscribed to by useBackendHealth().
export type BackendHealth = "up" | "reconnecting" | "down";
type Listener = (health: BackendHealth) => void;
const listeners = new Set<Listener>();
let _health: BackendHealth = "up";

export function getBackendHealth(): BackendHealth {
  return _health;
}

export function setBackendHealth(health: BackendHealth) {
  if (_health === health) return;
  _health = health;
  listeners.forEach((l) => {
    try { l(health); } catch { /* ignore listener errors */ }
  });
}

// Back-compat aliases so existing call sites keep working. `down` maps to the
// terminal "down" state; `up` clears back to "up".
export function isBackendDown(): boolean {
  return _health === "down";
}
export function setBackendDown(down: boolean) {
  setBackendHealth(down ? "down" : "up");
}

export function subscribeBackendHealth(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// v0.9.28: Do NOT flip the overlay on a single failed fetch. One flaky
// request (a resumed laptop, a paused main thread, a stalled
// vite-hmr socket, an in-flight restart) used to blow away the whole UI.
// Instead we count consecutive unreachable-fetches and only trip after
// FETCH_FAIL_THRESHOLD in a row. The health poller in BackendDownOverlay
// is still the primary signal; this is a fast complementary path so we
// don't have to wait for its poll cadence when the user is actively
// clicking around and every request fails.
// v0.9.30: two-stage escalation. First failure flips to "reconnecting"
// (lightweight banner) so users see we're aware. Sustained failure (7+
// in a row, ~14s at the 2s health-poll cadence) escalates to "down"
// (full modal). A single success drops all the way back to "up".
const FETCH_RECONNECT_THRESHOLD = 1;
const FETCH_DOWN_THRESHOLD = 7;
let consecutiveFetchFails = 0;

function noteFetchFailure() {
  consecutiveFetchFails += 1;
  if (consecutiveFetchFails >= FETCH_DOWN_THRESHOLD) {
    setBackendHealth("down");
  } else if (consecutiveFetchFails >= FETCH_RECONNECT_THRESHOLD && _health === "up") {
    setBackendHealth("reconnecting");
  }
}

function noteFetchSuccess() {
  if (consecutiveFetchFails !== 0) {
    consecutiveFetchFails = 0;
  }
  if (_health !== "up") setBackendHealth("up");
}

async function safeFetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
  try {
    const res = await fetch(input, init);
    // A response arrived from the server, even if it's an HTTP error.
    // Only 5xx-family gateway errors indicate an actual dead backend.
    if (res.status !== 502 && res.status !== 503 && res.status !== 504) {
      noteFetchSuccess();
    }
    return res;
  } catch (err) {
    // fetch() throws a TypeError when the network layer failed to make the
    // request at all (server is down, port refused, DNS gone). Increment
    // the consecutive-failure counter; only trip the overlay if we
    // accumulate FETCH_FAIL_THRESHOLD in a row.
    noteFetchFailure();
    throw new BackendUnreachableError(
      err instanceof Error ? err.message : "Failed to reach backend",
    );
  }
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    // 502/503/504 typically mean the backend process died but a proxy is
    // still up (or the OS returned a socket error). Count as unreachable.
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      noteFetchFailure();
      throw new BackendUnreachableError(`${res.status}: ${text}`);
    }
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await safeFetch(`${API_BASE}${url}`, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await safeFetch(`${API_BASE}${queryKey.join("/")}`);

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
