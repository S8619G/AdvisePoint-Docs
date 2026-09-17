// -----------------------------------------------------------------------------
// server/query-history.ts -- Recent searches persistence (v1.1.9)
// -----------------------------------------------------------------------------
//
// The Query tab shows the last 5 searches in a side panel so users can
// re-run a search without retyping it. The full search state (query
// text, match mode, max results, and every filter) is stored so a
// re-run reproduces the same hits, not just the input box.
//
// Persistence
//   Stored in the existing app_settings table under a single JSON
//   blob key. Same shape and safety model as
//   readFilenameCodeMapping / writeFilenameCodeMapping in
//   server/filename-codes.ts.
//
// Bounds
//   Hard cap of 5 rows. Deduplication is by full-payload equality
//   (query, matchMode, maxResults, all filter values) -- a matching
//   re-run updates the existing row's ranAt and bumps it to the top
//   instead of creating a duplicate.
//
// Not exported for direct use by other server code: the HTTP handlers
// in server/routes.ts are the only callers.
// -----------------------------------------------------------------------------

import type Database from "better-sqlite3";
import type { QueryHistoryEntry, QueryHistoryFilters } from "@shared/query-history-types";

const QUERY_HISTORY_KEY = "query_history_v1";
const HISTORY_LIMIT = 5;

// Re-export so route callers only need to import from this module.
export type { QueryHistoryEntry, QueryHistoryFilters };

// -----------------------------------------------------------------------------
// Read / write helpers
// -----------------------------------------------------------------------------

function coerceEntry(raw: any): QueryHistoryEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const q = typeof raw.q === "string" ? raw.q : "";
  if (q.trim().length === 0) return null;
  const matchMode =
    raw.matchMode === "phrase" || raw.matchMode === "semantic"
      ? raw.matchMode
      : "smart";
  const maxResults =
    typeof raw.maxResults === "number" && Number.isFinite(raw.maxResults)
      ? Math.floor(raw.maxResults)
      : 12;
  const filtersIn =
    raw.filters && typeof raw.filters === "object" ? raw.filters : {};
  const filters: QueryHistoryFilters = {
    productModel: typeof filtersIn.productModel === "string" ? filtersIn.productModel : "",
    productFamily: typeof filtersIn.productFamily === "string" ? filtersIn.productFamily : "",
    docType: typeof filtersIn.docType === "string" ? filtersIn.docType : "",
    firmware: typeof filtersIn.firmware === "string" ? filtersIn.firmware : "",
    errorCode: typeof filtersIn.errorCode === "string" ? filtersIn.errorCode : "",
    confidentialityMax:
      typeof filtersIn.confidentialityMax === "string" ? filtersIn.confidentialityMax : "",
    selectedTags: Array.isArray(filtersIn.selectedTags)
      ? filtersIn.selectedTags.filter((t: any) => typeof t === "string")
      : [],
  };
  const ranAt =
    typeof raw.ranAt === "number" && Number.isFinite(raw.ranAt) ? raw.ranAt : Date.now();
  return { q, matchMode, maxResults, filters, ranAt };
}

/** Read the persisted list, newest first. Returns [] when nothing has been
 *  stored yet or the row is corrupt. */
export function readQueryHistory(rawDb: Database.Database): QueryHistoryEntry[] {
  try {
    const row = rawDb
      .prepare("SELECT value FROM app_settings WHERE key = ?")
      .get(QUERY_HISTORY_KEY) as { value: string } | undefined;
    if (!row?.value) return [];
    const parsed = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(coerceEntry)
      .filter((e): e is QueryHistoryEntry => e !== null)
      .slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function writeRaw(rawDb: Database.Database, list: QueryHistoryEntry[]): void {
  const value = JSON.stringify(list.slice(0, HISTORY_LIMIT));
  rawDb
    .prepare(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(QUERY_HISTORY_KEY, value);
}

// -----------------------------------------------------------------------------
// Dedupe key
//
// Two searches are considered identical when the query text (trimmed),
// match mode, max results, and every filter value all match. Tags are
// compared as sorted-set equality so { tags: [a,b] } and
// { tags: [b,a] } collapse to one row.
// -----------------------------------------------------------------------------

export function dedupeKeyFor(entry: QueryHistoryEntry): string {
  const f = entry.filters ?? {};
  const tags = (f.selectedTags ?? []).slice().sort().join(",");
  return [
    entry.q.trim(),
    entry.matchMode,
    entry.maxResults,
    f.productModel ?? "",
    f.productFamily ?? "",
    f.docType ?? "",
    f.firmware ?? "",
    f.errorCode ?? "",
    f.confidentialityMax ?? "",
    tags,
  ].join("|");
}

// -----------------------------------------------------------------------------
// Public mutators
// -----------------------------------------------------------------------------

/**
 * Prepend `entry` to the persisted history. If an existing row has the
 * same dedupe key, remove it first (its ranAt is updated by the new
 * prepend). Truncated to HISTORY_LIMIT rows.
 *
 * Returns the updated list, newest first, for the caller to send back
 * as the response body.
 */
export function pushQueryHistoryEntry(
  rawDb: Database.Database,
  entry: QueryHistoryEntry,
): QueryHistoryEntry[] {
  if (entry.q.trim().length === 0) {
    // Never record blank queries. Return the existing list unchanged.
    return readQueryHistory(rawDb);
  }
  const current = readQueryHistory(rawDb);
  const key = dedupeKeyFor(entry);
  const filtered = current.filter((e) => dedupeKeyFor(e) !== key);
  const next = [entry, ...filtered].slice(0, HISTORY_LIMIT);
  writeRaw(rawDb, next);
  return next;
}

/** Wipe the persisted history entirely. */
export function clearQueryHistory(rawDb: Database.Database): void {
  rawDb.prepare("DELETE FROM app_settings WHERE key = ?").run(QUERY_HISTORY_KEY);
}

// Exposed for tests.
export const __TEST_ONLY__ = { QUERY_HISTORY_KEY, HISTORY_LIMIT };
