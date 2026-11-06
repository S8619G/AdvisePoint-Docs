// v1.3.5 - Query tab "Auto Search" switch helpers.
//
// The switch is on by default and remembered on this PC. It is stored in the
// browser's local storage for the app's local address (the same approach the
// Upload tab uses for the last-used model/family), so it survives app
// restarts without a database or server change.

import type { QueryHistoryEntry } from "@shared/query-history-types";

export const AUTO_SEARCH_STORAGE_KEY = "apd:query:autoSearch";
/** Coalesce rapid filter changes into one search. */
export const AUTO_SEARCH_DELAY_MS = 300;

export function readAutoSearchPref(storage: Pick<Storage, "getItem"> | null = safeStorage()): boolean {
  try {
    const v = storage?.getItem(AUTO_SEARCH_STORAGE_KEY);
    // Anything other than an explicit "off" means on (the default).
    return v !== "0";
  } catch {
    return true;
  }
}

export function writeAutoSearchPref(on: boolean, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    storage?.setItem(AUTO_SEARCH_STORAGE_KEY, on ? "1" : "0");
  } catch {
    /* storage unavailable -- the switch still works for this session */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Client copy of the Recent searches identity rule (server dedupeKeyFor):
 * query text, match mode, max results and every filter value; tags compared
 * as a sorted set. Used to keep a manual search's entry from being replaced
 * by an Auto Search chain that lands back on the same criteria.
 */
export function historyKeyFor(entry: Omit<QueryHistoryEntry, "ranAt">): string {
  const f = entry.filters ?? ({} as QueryHistoryEntry["filters"]);
  const tags = (f.selectedTags ?? []).slice().sort().join(",");
  return [
    entry.q.trim(),
    entry.matchMode,
    entry.maxResults,
    f.productModel ?? "",
    f.productFamily ?? "",
    f.productFamily && f.selectedFamilyOnly === true ? "family-only" : "",
    f.docType ?? "",
    f.firmware ?? "",
    f.errorCode ?? "",
    f.confidentialityMax ?? "",
    tags,
  ].join("|");
}
