// v1.3.5 - Library quick search by name and details.
//
// Pure helpers so the matching rules can be tested without a browser. The
// Library page filters the document list it has already loaded; nothing here
// talks to the server, and document text (chunks, excerpts, sections, the
// generated summary) is never consulted.
//
// Rules
//   - Case-insensitive.
//   - Spaces, underscores, hyphens and periods are treated alike, so
//     "MZ9500ci FAX", "MZ9500ci-FAX" and "mz9500ci_fax" are the same search.
//   - Every entered word must appear in at least one searchable field
//     (substring match), so "MZ9500 fax" finds the MZ9500 FAX guide.

export interface QuickSearchDoc {
  title?: string | null;
  subtitle?: string | null;
  file_name?: string | null;
  document_type?: string | null;
  product_model?: string | null;
  product_family?: string | null;
  product_sku?: string | null;
  product_version?: string | null;
  firmware_version?: string | null;
  release_channel?: string | null;
  lifecycle_status?: string | null;
  confidentiality?: string | null;
  tags?: string[] | null;
  keywords?: string[] | null;
}

/** Lowercase and fold the separator characters into single spaces. */
export function normalizeQuickSearch(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[\s_.\-]+/g, " ")
    .trim();
}

/** Split a query into the words that must each match. Empty -> []. */
export function quickSearchWords(query: string | null | undefined): string[] {
  const n = normalizeQuickSearch(query);
  return n ? n.split(" ") : [];
}

/**
 * The searchable values for one document, already normalized. Only the
 * displayed name, the original file name and metadata fields are included.
 * `typeLabel` is the display label for document_type (for example
 * "Service Manual" for the key "service_manual"); both are searched.
 * `channelLabel` is the display label for release_channel, when it differs.
 */
export function quickSearchFields(
  doc: QuickSearchDoc,
  labels: { typeLabel?: string | null; channelLabel?: string | null } = {},
): string[] {
  const values: Array<string | null | undefined> = [
    doc.title,
    doc.subtitle,
    doc.file_name,
    doc.document_type,
    labels.typeLabel,
    doc.product_model,
    doc.product_family,
    doc.product_sku,
    doc.product_version,
    doc.firmware_version,
    doc.release_channel,
    labels.channelLabel,
    doc.lifecycle_status,
    doc.confidentiality,
    ...(Array.isArray(doc.tags) ? doc.tags : []),
    ...(Array.isArray(doc.keywords) ? doc.keywords : []),
  ];
  const out: string[] = [];
  for (const v of values) {
    const n = normalizeQuickSearch(v);
    if (n) out.push(n);
  }
  return out;
}

/** True when every word appears in at least one of the given fields. */
export function fieldsMatchWords(fields: string[], words: string[]): boolean {
  if (words.length === 0) return true;
  return words.every((w) => fields.some((f) => f.includes(w)));
}

export function docMatchesQuickSearch(
  doc: QuickSearchDoc,
  query: string,
  labels: { typeLabel?: string | null; channelLabel?: string | null } = {},
): boolean {
  return fieldsMatchWords(quickSearchFields(doc, labels), quickSearchWords(query));
}
