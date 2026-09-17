// ---------------------------------------------------------------------------
// v1.1.5 -- choosing which copy of a duplicate group to keep.
//
// Duplicate groups are formed from an identical SHA-256, so every copy in a
// group holds the same bytes. What differs is the DATABASE ROW: title,
// document type, tags, product values, and the date it was ingested. Keeping
// the "wrong" copy therefore loses metadata, not content.
//
// The server ranks each group and nominates a keeper (most complete copy;
// oldest on a tie). That nomination is a sensible default, not a verdict --
// a person re-uploading a corrected file wants the NEWER row. This module
// holds the logic for overriding it and for turning the result into a
// request body, kept out of the component so it can be tested directly.
//
// Two request channels exist on /api/documents/duplicates/delete:
//
//   ids[]           - the automatic path. The server recomputes the group,
//                     picks its own keeper, and refuses any id that is not
//                     on that group's delete list.
//   manual_review[] - names the keeper explicitly. The server validates the
//                     keeper is a member of the group and refuses to remove
//                     it, but does not second-guess the choice.
//
// An overridden group MUST travel by manual_review only. Sending it through
// both channels would queue the same group twice, and the server rejects the
// second occurrence as "already queued for removal".
// ---------------------------------------------------------------------------

export interface DuplicateMember {
  id: string;
  title: string;
  ingested_at: string;
  has_pages: boolean;
  has_original: boolean;
  chunks: number;
  viewable: boolean;
}

export interface DuplicateGroupLike {
  group_key: string;
  keep: string;
  delete: string[];
  safe_to_delete: boolean;
  docs: DuplicateMember[];
}

/** Which copy a person picked, keyed by group. Absent means "use the default". */
export type KeeperOverrides = Record<string, string | undefined>;

/** Explicit confirmation, keyed by group. Only required for blocked groups. */
export type ReviewConfirmations = Record<string, boolean | undefined>;

/**
 * The copy that will actually be kept: the person's choice when they made a
 * valid one, otherwise the server's nomination.
 *
 * An override naming an id that is not in the group is ignored rather than
 * honoured. A stale selection left over from a previous scan must never be
 * able to widen what gets removed.
 */
export function effectiveKeeper(
  group: DuplicateGroupLike,
  overrides: KeeperOverrides = {},
): string {
  const picked = overrides[group.group_key];
  if (picked && group.docs.some((d) => d.id === picked)) return picked;
  return group.keep;
}

/** True when a person has chosen a copy other than the server's nomination. */
export function isOverridden(
  group: DuplicateGroupLike,
  overrides: KeeperOverrides = {},
): boolean {
  return effectiveKeeper(group, overrides) !== group.keep;
}

/**
 * A blocked group still needs an explicit confirmation, because the app could
 * not establish that any copy is viewable. A safe group does not: the removal
 * is already provably recoverable and the extra checkbox is only friction.
 */
export function isActionable(
  group: DuplicateGroupLike,
  overrides: KeeperOverrides = {},
  confirmations: ReviewConfirmations = {},
): boolean {
  if (group.safe_to_delete) return true;
  return Boolean(overrides[group.group_key]) && confirmations[group.group_key] === true;
}

export type RowAction = "keep" | "quarantine" | "skip";

export interface DisplayRow extends DuplicateMember {
  action: RowAction;
  /** Newest copy in the group -- surfaced so "which one is new" is obvious. */
  is_newest: boolean;
}

/**
 * Rows for display, newest first.
 *
 * Sorting by date rather than by the server's ranking is deliberate: the
 * question a person is answering is "which of these is the one I just
 * uploaded", and the answer is the date. Ties fall back to id so the order
 * is stable across re-renders.
 */
export function rowsForDisplay(
  group: DuplicateGroupLike,
  overrides: KeeperOverrides = {},
  confirmations: ReviewConfirmations = {},
): DisplayRow[] {
  const keeper = effectiveKeeper(group, overrides);
  const actionable = isActionable(group, overrides, confirmations);

  const sorted = [...group.docs].sort((a, b) => {
    if (a.ingested_at !== b.ingested_at) return a.ingested_at < b.ingested_at ? 1 : -1;
    return a.id < b.id ? -1 : 1;
  });
  const newestDate = sorted.length > 0 ? sorted[0].ingested_at : "";

  return sorted.map((d) => ({
    ...d,
    is_newest: Boolean(newestDate) && d.ingested_at === newestDate,
    action: d.id === keeper ? "keep" : actionable ? "quarantine" : "skip",
  }));
}

/** How many copies would be removed right now, across every group. */
export function removalCount(
  groups: DuplicateGroupLike[],
  overrides: KeeperOverrides = {},
  confirmations: ReviewConfirmations = {},
): number {
  let n = 0;
  for (const g of groups) {
    if (!isActionable(g, overrides, confirmations)) continue;
    const keeper = effectiveKeeper(g, overrides);
    n += g.docs.filter((d) => d.id !== keeper).length;
  }
  return n;
}

export interface DeleteRequest {
  ids: string[];
  manual_review: Array<{
    group_key: string;
    keep: string;
    remove: string[];
    confirmed: true;
  }>;
}

/**
 * Build the request body.
 *
 * Routing rule, and the reason this function exists: a group goes through
 * `ids` only when it is safe AND the person accepted the default keeper.
 * Any overridden group -- and any blocked group they reviewed -- goes through
 * `manual_review` instead. No group ever appears in both.
 *
 * Pass `only` to act on a single group, which is what the per-group button
 * does; omit it for the bulk action.
 */
export function buildDeleteRequest(
  groups: DuplicateGroupLike[],
  overrides: KeeperOverrides = {},
  confirmations: ReviewConfirmations = {},
  only?: string,
): DeleteRequest {
  const ids: string[] = [];
  const manual_review: DeleteRequest["manual_review"] = [];

  for (const g of groups) {
    if (only !== undefined && g.group_key !== only) continue;
    if (!isActionable(g, overrides, confirmations)) continue;

    const keeper = effectiveKeeper(g, overrides);
    const remove = g.docs.map((d) => d.id).filter((id) => id !== keeper);
    if (remove.length === 0) continue;

    if (g.safe_to_delete && !isOverridden(g, overrides)) {
      ids.push(...remove);
    } else {
      manual_review.push({ group_key: g.group_key, keep: keeper, remove, confirmed: true });
    }
  }

  return { ids, manual_review };
}
