// v0.9.31 - Library tab state store.
//
// Preserves the Library page's top-level filters/sort and the selected
// doc's inner view state (sections vs excerpts, docSearchQuery) across
// tab switches. The selected doc ID itself is already carried by the
// URL (/library/:id), so we do not duplicate it here; we only capture
// what the URL doesn't already tell us.
//
// URL sync
//   The three top-level filters (sortBy, filterType, filterModel) are
//   mirrored to query-string params on the /library route, matching the
//   Query tab's convention. In-doc state (viewMode, docSearchQuery,
//   pageViewerStart, scroll offsets) is in-memory only - it's context
//   that only makes sense inside the current session.
//
// Notes
//   - `docDetail` is keyed by doc id so navigating between different
//     library docs remembers each one's viewMode and inner search text
//     independently. The store trims entries older than DOC_DETAIL_MAX
//     to keep memory bounded on long sessions.

import { createTabStore } from "./tabStore";

export type SortKey = "recent" | "title" | "document_type" | "product_model" | "product_family";

// Per-doc view state inside the Library detail pane.
export interface LibraryDocDetail {
  viewMode: "sections" | "excerpts";
  docSearchQuery: string;
  pageViewerStart?: number;
  selectedExcerpt?: number;
}

export interface LibraryTabState {
  // ---- URL-synced ----
  sortBy: SortKey;
  filterType: string; // "__any" or a specific document_type value
  filterModel: string; // "__any" or a specific product_model value
  filterFamily: string; // v0.9.36: "__any" or a specific product_family value

  // ---- In-memory only ----
  // Scroll offset on the Library list page (not the doc detail page).
  scrollY: number;
  // Doc-detail state keyed by doc id. Only doc ids the user has actually
  // visited during this session end up in here.
  docDetail: Record<string, LibraryDocDetail>;
  // v0.9.31: expanded-doc key on the Library list, so a card that was
  // opened stays open when the user tabs away and back.
  expandedDocId: string | null;
  // v0.9.31 hotfix 2: the last route the Library tab was viewing, so
  // clicking the top-nav "Library" link after a tab switch lands you
  // back on the same doc you were reading instead of the doc list.
  // Value is a wouter-style path with no leading '#', e.g. "/library"
  // or "/library/doc_abc". Null before the user has visited Library.
  lastLibraryPath: string | null;
}

const DOC_DETAIL_MAX = 32;

export const libraryTabStore = createTabStore<LibraryTabState>({
  sortBy: "recent",
  filterType: "__any",
  filterModel: "__any",
  filterFamily: "__any",
  scrollY: 0,
  docDetail: {},
  expandedDocId: null,
  lastLibraryPath: null,
});

// Helper: update a per-doc detail slice, trimming the oldest entries if
// we exceed the cap. The trimming is FIFO by insertion order, which
// JavaScript preserves on plain objects for string keys.
export function updateDocDetail(id: string, patch: Partial<LibraryDocDetail>) {
  libraryTabStore.setState((prev) => {
    const existing = prev.docDetail[id] ?? {
      viewMode: "sections" as const,
      docSearchQuery: "",
    };
    // Rebuild the object with the updated key at the end so recently
    // touched entries are cheapest to keep across the cap trim.
    const rest: Record<string, LibraryDocDetail> = {};
    for (const [k, v] of Object.entries(prev.docDetail)) {
      if (k !== id) rest[k] = v;
    }
    const nextEntry = { ...existing, ...patch };
    const merged: Record<string, LibraryDocDetail> = { ...rest, [id]: nextEntry };
    // Trim FIFO if we're over the cap.
    const keys = Object.keys(merged);
    if (keys.length > DOC_DETAIL_MAX) {
      const dropCount = keys.length - DOC_DETAIL_MAX;
      for (let i = 0; i < dropCount; i++) delete merged[keys[i]];
    }
    return { docDetail: merged };
  });
}

// -------- URL sync --------
// Library uses `/library` or `/library/:id` route paths. Filters get
// serialized as query params on either shape.
export function serializeLibraryStateToUrl(s: LibraryTabState): string {
  const params = new URLSearchParams();
  if (s.sortBy !== "recent") params.set("sort", s.sortBy);
  if (s.filterType !== "__any") params.set("type", s.filterType);
  if (s.filterModel !== "__any") params.set("model", s.filterModel);
  if (s.filterFamily !== "__any") params.set("family", s.filterFamily);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function hydrateLibraryStateFromUrl(hash: string): Partial<LibraryTabState> {
  const qmark = hash.indexOf("?");
  if (qmark < 0) return {};
  const params = new URLSearchParams(hash.slice(qmark + 1));
  const out: Partial<LibraryTabState> = {};
  const sort = params.get("sort");
  if (
    sort === "recent" ||
    sort === "title" ||
    sort === "document_type" ||
    sort === "product_model" ||
    sort === "product_family"
  ) {
    out.sortBy = sort;
  }
  const type = params.get("type");
  if (type) out.filterType = type;
  const model = params.get("model");
  if (model) out.filterModel = model;
  const family = params.get("family");
  if (family) out.filterFamily = family;
  return out;
}
