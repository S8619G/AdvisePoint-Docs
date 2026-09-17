# AdvisePoint Docs 1.1.9 — Release Notes

Small, focused release that adds two workflow conveniences to the main tabs: an
optional title cleanup during shared-metadata batch uploads, and a Recent
searches panel on the Query tab. Everything from 1.1.8 continues to work as it
did; both additions are opt-in from the user's perspective.

---

## What is new

### Query tab: Recent searches panel

The Query tab side column now includes a **Recent searches** card, positioned
directly under the Filters card. Every time a search completes, the exact
combination that produced the result -- the query text, match mode, maximum
result count, and every filter value -- is added to the top of the list.
Selecting a row restores that full state and reruns the search, so a re-run
reproduces the same hits, not just the input text.

The panel keeps the five most recent unique combinations. If the same search is
run again with the same filters, the existing row is bumped to the top rather
than duplicated. A **Clear** button in the card header wipes the list after a
short confirmation; this only affects the history panel and does not touch any
documents, filters, or other settings.

The list is stored on the server side, so it survives restarts and shows up
consistently across tab switches. Empty searches are never recorded.

### Upload tab: Auto-fix titles toggle in "Same metadata for all"

The batch-shared banner now includes an **Auto-fix titles from filenames**
toggle. When enabled, each file in the batch has its title cleaned up
individually from its own filename before upload, using the same rules the
per-file Fix Title action applies elsewhere in the app. Files whose names
cannot be cleaned up keep the filename as the title.

The toggle is off by default; when it is off, the 1.1.8 behavior is preserved
exactly (each file's title is filled server-side from its filename). Turning
the toggle on only affects the current batch mode; the other metadata fields
(document type, model, family, tags, and so on) continue to apply uniformly
across the batch as before.

---

## Behavior preserved

- Documents uploaded before 1.1.9 are unaffected.
- The batch-shared metadata form still shows and edits the same fields as in
  1.1.8. The new toggle appears above the shared form fields, not inside them.
- The Query tab main results grid, preview pane, and every existing filter
  keep their previous behavior. The new panel occupies the sidebar column
  only.
- Match mode, maximum result count, tag selection, confidentiality filter, and
  all product and error filters continue to serialize into the URL as they did
  in 1.1.8.
- Nothing about the recent searches list is exposed as a URL parameter; it is
  server-side state, private to the local install.

---

## Notes

- Recent searches are a convenience layer over the same search that the main
  Search button runs. There is no separate cache or shortcut path; clicking a
  row simply repopulates the fields and invokes the normal search flow.
- Clearing the panel is intentionally kept in the panel header so the action
  is visible next to the list it affects, and is disabled when the list is
  already empty.
- Auto-fix titles applies only in the "Same metadata for all" batch mode.
  "Different per file" mode already surfaces per-file Fix Title actions in
  each file's card and is unchanged.
