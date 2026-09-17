// Tests for client/src/lib/duplicate-keeper.ts -- keeper election for
// duplicate groups. Run with: npm run test:duplicate-keeper
import test from "node:test";
import assert from "node:assert/strict";

import {
  effectiveKeeper,
  isOverridden,
  isActionable,
  rowsForDisplay,
  removalCount,
  buildDeleteRequest,
} from "../client/src/lib/duplicate-keeper.ts";

function member(id, ingested_at, extra = {}) {
  return {
    id,
    title: `Title ${id}`,
    ingested_at,
    has_pages: true,
    has_original: true,
    chunks: 10,
    viewable: true,
    ...extra,
  };
}

/** The exact shape the user hit: one file uploaded twice, older nominated. */
function safeGroup() {
  return {
    group_key: "sha256:aaa",
    keep: "old",
    delete: ["new"],
    safe_to_delete: true,
    docs: [member("old", "2026-09-01T10:00:00Z"), member("new", "2026-09-13T21:00:00Z")],
  };
}

/** No copy viewable, so the server refuses to choose. */
function blockedGroup() {
  return {
    group_key: "sha256:bbb",
    keep: "b1",
    delete: [],
    safe_to_delete: false,
    docs: [
      member("b1", "2026-08-01T10:00:00Z", { has_pages: false, has_original: false, viewable: false }),
      member("b2", "2026-08-02T10:00:00Z", { has_pages: false, has_original: false, viewable: false }),
    ],
  };
}

test("defaults to the server's nominated keeper", () => {
  assert.equal(effectiveKeeper(safeGroup()), "old");
  assert.equal(isOverridden(safeGroup()), false);
});

test("honours an override to the newer copy", () => {
  const g = safeGroup();
  const o = { "sha256:aaa": "new" };
  assert.equal(effectiveKeeper(g, o), "new");
  assert.equal(isOverridden(g, o), true);
});

test("selecting the default explicitly is not an override", () => {
  const g = safeGroup();
  assert.equal(isOverridden(g, { "sha256:aaa": "old" }), false);
});

test("ignores an override naming an id outside the group", () => {
  const g = safeGroup();
  // A stale selection must never widen what gets removed.
  assert.equal(effectiveKeeper(g, { "sha256:aaa": "ghost" }), "old");
  assert.equal(isOverridden(g, { "sha256:aaa": "ghost" }), false);
});

test("an override for a different group does not leak across groups", () => {
  assert.equal(effectiveKeeper(safeGroup(), { "sha256:zzz": "new" }), "old");
});

test("a safe group is actionable with no confirmation", () => {
  assert.equal(isActionable(safeGroup()), true);
});

test("a blocked group needs both a choice and a confirmation", () => {
  const g = blockedGroup();
  assert.equal(isActionable(g), false);
  assert.equal(isActionable(g, { "sha256:bbb": "b2" }), false);
  assert.equal(isActionable(g, {}, { "sha256:bbb": true }), false);
  assert.equal(isActionable(g, { "sha256:bbb": "b2" }, { "sha256:bbb": true }), true);
});

test("rows are ordered newest first and flag the newest copy", () => {
  const rows = rowsForDisplay(safeGroup());
  assert.deepEqual(rows.map((r) => r.id), ["new", "old"]);
  assert.deepEqual(rows.map((r) => r.is_newest), [true, false]);
});

test("row actions follow the default keeper", () => {
  const rows = rowsForDisplay(safeGroup());
  assert.deepEqual(
    rows.map((r) => [r.id, r.action]),
    [["new", "quarantine"], ["old", "keep"]],
  );
});

test("row actions follow an override, so the outcome is visible first", () => {
  const rows = rowsForDisplay(safeGroup(), { "sha256:aaa": "new" });
  assert.deepEqual(
    rows.map((r) => [r.id, r.action]),
    [["new", "keep"], ["old", "quarantine"]],
  );
});

test("a blocked group shows skip until it is confirmed", () => {
  const g = blockedGroup();
  assert.deepEqual(
    rowsForDisplay(g, { "sha256:bbb": "b2" }).map((r) => r.action),
    ["keep", "skip"],
  );
  assert.deepEqual(
    rowsForDisplay(g, { "sha256:bbb": "b2" }, { "sha256:bbb": true }).map((r) => r.action),
    ["keep", "quarantine"],
  );
});

test("identical timestamps still produce a stable order", () => {
  const g = {
    ...safeGroup(),
    docs: [member("zzz", "2026-09-01T10:00:00Z"), member("aaa", "2026-09-01T10:00:00Z")],
    keep: "aaa",
  };
  assert.deepEqual(rowsForDisplay(g).map((r) => r.id), ["aaa", "zzz"]);
  // Both share the newest date, so both are flagged rather than picking one.
  assert.deepEqual(rowsForDisplay(g).map((r) => r.is_newest), [true, true]);
});

test("default keeper routes through the automatic ids channel", () => {
  const req = buildDeleteRequest([safeGroup()]);
  assert.deepEqual(req.ids, ["new"]);
  assert.deepEqual(req.manual_review, []);
});

test("an overridden group routes through manual_review only", () => {
  const req = buildDeleteRequest([safeGroup()], { "sha256:aaa": "new" });
  // Critical: not in both channels, or the server rejects the duplicate entry.
  assert.deepEqual(req.ids, []);
  assert.deepEqual(req.manual_review, [
    { group_key: "sha256:aaa", keep: "new", remove: ["old"], confirmed: true },
  ]);
});

test("the chosen keeper is never in its own remove list", () => {
  for (const pick of ["old", "new"]) {
    const req = buildDeleteRequest([safeGroup()], { "sha256:aaa": pick });
    const all = [...req.ids, ...req.manual_review.flatMap((m) => m.remove)];
    assert.ok(!all.includes(pick), `${pick} must not be queued for removal`);
  }
});

test("mixed groups split across both channels without overlap", () => {
  const other = {
    group_key: "sha256:ccc",
    keep: "c1",
    delete: ["c2"],
    safe_to_delete: true,
    docs: [member("c1", "2026-07-01T10:00:00Z"), member("c2", "2026-07-02T10:00:00Z")],
  };
  const req = buildDeleteRequest([safeGroup(), other], { "sha256:aaa": "new" });
  assert.deepEqual(req.ids, ["c2"]);
  assert.deepEqual(req.manual_review.map((m) => m.group_key), ["sha256:aaa"]);
  const overlap = req.ids.filter((id) =>
    req.manual_review.some((m) => m.remove.includes(id)),
  );
  assert.deepEqual(overlap, []);
});

test("unconfirmed blocked groups are omitted entirely", () => {
  const req = buildDeleteRequest([safeGroup(), blockedGroup()]);
  assert.deepEqual(req.ids, ["new"]);
  assert.deepEqual(req.manual_review, []);
});

test("a confirmed blocked group is sent as manual_review", () => {
  const req = buildDeleteRequest(
    [blockedGroup()],
    { "sha256:bbb": "b2" },
    { "sha256:bbb": true },
  );
  assert.deepEqual(req.ids, []);
  assert.deepEqual(req.manual_review, [
    { group_key: "sha256:bbb", keep: "b2", remove: ["b1"], confirmed: true },
  ]);
});

test("`only` restricts the request to a single group", () => {
  const other = {
    group_key: "sha256:ccc",
    keep: "c1",
    delete: ["c2"],
    safe_to_delete: true,
    docs: [member("c1", "2026-07-01T10:00:00Z"), member("c2", "2026-07-02T10:00:00Z")],
  };
  const req = buildDeleteRequest([safeGroup(), other], {}, {}, "sha256:ccc");
  assert.deepEqual(req.ids, ["c2"]);
  assert.deepEqual(req.manual_review, []);
});

test("a single-member group produces no work", () => {
  const g = { ...safeGroup(), docs: [member("old", "2026-09-01T10:00:00Z")], delete: [] };
  const req = buildDeleteRequest([g]);
  assert.deepEqual(req.ids, []);
  assert.deepEqual(req.manual_review, []);
});

test("a three-way group removes both non-keepers", () => {
  const g = {
    group_key: "sha256:ddd",
    keep: "d1",
    delete: ["d2", "d3"],
    safe_to_delete: true,
    docs: [
      member("d1", "2026-01-01T00:00:00Z"),
      member("d2", "2026-02-01T00:00:00Z"),
      member("d3", "2026-03-01T00:00:00Z"),
    ],
  };
  const req = buildDeleteRequest([g], { "sha256:ddd": "d3" });
  assert.deepEqual(req.manual_review[0].remove.sort(), ["d1", "d2"]);
});

test("removalCount tracks the current selection", () => {
  assert.equal(removalCount([safeGroup()]), 1);
  assert.equal(removalCount([safeGroup()], { "sha256:aaa": "new" }), 1);
  assert.equal(removalCount([safeGroup(), blockedGroup()]), 1);
  assert.equal(
    removalCount([safeGroup(), blockedGroup()], { "sha256:bbb": "b2" }, { "sha256:bbb": true }),
    2,
  );
});

test("empty input is handled", () => {
  const req = buildDeleteRequest([]);
  assert.deepEqual(req.ids, []);
  assert.deepEqual(req.manual_review, []);
  assert.equal(removalCount([]), 0);
});
