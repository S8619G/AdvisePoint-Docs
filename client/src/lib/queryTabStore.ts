// v0.9.31 - Query tab state store.
//
// Every user-facing piece of state on the Query page lives here so that
// unmounting the tab (via a wouter route switch) doesn't wipe it. The
// store is a plain singleton with a React binding via useSyncExternalStore.
//
// URL sync
//   A subset of the state (search text, filter values, selected result
//   id) is mirrored to the hash-route query string on every change so
//   the URL always identifies the current view. Volatile state (kbd
//   cursor, expanded-excerpt keys, scroll offset, page-viewer modal,
//   search response cache) stays in-memory only.
//
// Notes
//   - `expandedKeys` is stored as a plain array (not a Set) so the state
//     is trivially serializable if we ever want to persist it, and so
//     store snapshots can be compared by React with Object.is on the
//     reference alone.
//   - `lastResponse` holds the raw SearchResponse the mutation returned,
//     which is what lets a user tab back to Query and still see their
//     previous results. Cleared explicitly on Clear or on a new submit.
//   - The store itself does NOT talk to the network. The mutation still
//     lives inside the component and writes into the store on success.

import { createTabStore } from "./tabStore";

// Kept as a permissive shape - the concrete types are declared in
// pages/query.tsx and we don't want an import cycle here.
export type MatchMode = "smart" | "phrase" | "semantic";
export interface PageViewerRef {
  id: string;
  title: string;
  titleColor: string | null;
  page: number;
}

// SearchResponse mirrors what /api/search returns. Kept as `unknown` in
// the store type to avoid the import cycle - the component casts on read.
export type QuerySearchResponse = unknown;

export interface QueryTabState {
  // ---- URL-synced ----
  q: string;
  matchMode: MatchMode;
  maxResults: number;
  productModel: string;
  docType: string;
  firmware: string;
  errorCode: string;
  confidentialityMax: string;
  selectedTags: string[];
  selectedResultId: string | null;

  // ---- In-memory only ----
  previewOn: boolean;
  expandedKeys: string[];
  lastQuery: string;
  kbdIdx: number | null;
  pageViewer: PageViewerRef | null;
  lastResponse: QuerySearchResponse | null;
  scrollY: number;
}

export const queryTabStore = createTabStore<QueryTabState>({
  q: "",
  matchMode: "smart",
  maxResults: 12,
  productModel: "",
  docType: "",
  firmware: "",
  errorCode: "",
  confidentialityMax: "",
  selectedTags: [],
  selectedResultId: null,
  previewOn: false,
  expandedKeys: [],
  lastQuery: "",
  kbdIdx: null,
  pageViewer: null,
  lastResponse: null,
  scrollY: 0,
});

// -------- URL sync --------
// We use hash-mode routing (see App.tsx) so the "URL" is really the hash
// after '#'. Query params after a '?' inside the hash are still parsed
// by URLSearchParams.
//
// serializeToUrl: build a query-string fragment from the URL-synced
// fields. Empty fields are omitted to keep the URL short and readable.
export function serializeQueryStateToUrl(s: QueryTabState): string {
  const params = new URLSearchParams();
  if (s.q) params.set("q", s.q);
  if (s.matchMode !== "smart") params.set("mode", s.matchMode);
  if (s.maxResults !== 12) params.set("top_k", String(s.maxResults));
  if (s.productModel) params.set("model", s.productModel);
  if (s.docType) params.set("type", s.docType);
  if (s.firmware) params.set("fw", s.firmware);
  if (s.errorCode) params.set("err", s.errorCode);
  if (s.confidentialityMax) params.set("conf", s.confidentialityMax);
  if (s.selectedTags.length) params.set("tags", s.selectedTags.join(","));
  if (s.selectedResultId) params.set("sel", s.selectedResultId);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

// hydrateFromUrl: read the query params on the current hash location and
// return a partial state patch. Missing keys keep their defaults - a
// hard reload with `#/query` (no params) restores the empty defaults.
export function hydrateQueryStateFromUrl(hash: string): Partial<QueryTabState> {
  // hash looks like "#/query?q=foo&mode=phrase"
  const qmark = hash.indexOf("?");
  if (qmark < 0) return {};
  const params = new URLSearchParams(hash.slice(qmark + 1));
  const out: Partial<QueryTabState> = {};
  const q = params.get("q");
  if (q) out.q = q;
  const mode = params.get("mode");
  if (mode === "phrase" || mode === "semantic" || mode === "smart") out.matchMode = mode;
  const topK = params.get("top_k");
  if (topK) {
    const n = parseInt(topK, 10);
    if (Number.isFinite(n) && n > 0 && n <= 200) out.maxResults = n;
  }
  const model = params.get("model");
  if (model) out.productModel = model;
  const type = params.get("type");
  if (type) out.docType = type;
  const fw = params.get("fw");
  if (fw) out.firmware = fw;
  const err = params.get("err");
  if (err) out.errorCode = err;
  const conf = params.get("conf");
  if (conf) out.confidentialityMax = conf;
  const tags = params.get("tags");
  if (tags) out.selectedTags = tags.split(",").filter(Boolean);
  const sel = params.get("sel");
  if (sel) out.selectedResultId = sel;
  return out;
}
