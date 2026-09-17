// -----------------------------------------------------------------------------
// shared/query-history-types.ts -- Recent searches wire types (v1.1.9)
// -----------------------------------------------------------------------------
//
// Kept in shared/ so the client and server agree on the exact payload
// shape without either side importing the other's implementation. The
// server module server/query-history.ts owns validation and coerces
// unknown fields defensively; this file only describes the happy-path
// shape.
// -----------------------------------------------------------------------------

export interface QueryHistoryFilters {
  productModel?: string;
  productFamily?: string;
  docType?: string;
  firmware?: string;
  errorCode?: string;
  confidentialityMax?: string;
  selectedTags?: string[];
}

export interface QueryHistoryEntry {
  q: string;
  matchMode: "smart" | "phrase" | "semantic";
  maxResults: number;
  filters: QueryHistoryFilters;
  ranAt: number; // ms since epoch, server-stamped
}
