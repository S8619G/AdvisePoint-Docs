# AdvisePoint Docs — Future-Build Backlog

Items accepted for a future release but deliberately deferred from the current
version. Each item should have enough detail that a fresh session can pick it
up without going back to the source conversation.

## Option B updater helper — `Update.bat` (planned for v0.9.32)

**Filed:** 2026-09-03
**Target release:** v0.9.32 (headline feature)
**Status:** Implemented for v0.9.32; Windows field validation remains required.
**User decision:** Ship Option B (external launcher-side updater) first,
test extensively across several releases, then decide whether to promote
to Option A (in-app "Install update" button) in v1.1.x or later.
**Explicitly deferred:** Option A in-app updater, code-signed installer.

### Goal

Users can update to a new release by double-clicking `Update.bat` in
their install folder — no unzipping, no copying files, no folder
shuffling. The user's data (%LOCALAPPDATA%\AdvisePoint Docs\) is never
touched.

### What ships in the zip

Alongside `Start AdvisePoint Docs.bat`, add a new file:

* `Update AdvisePoint Docs.bat` — the user-facing updater entry point.
* `packaging/updater/updater.cjs` — the Node script that does the real
  work, invoked by the .bat using the bundled `node\node.exe`. Keeps
  all the logic in one place we already know how to build and test.

### Update flow (what the .bat + updater.cjs do, in order)

1. **Bail if the app is running.** Check port 5000; if bound, prompt
   the user to close the app first and exit cleanly. Do NOT force-kill
   — the user might have unsaved state in the browser tab.
2. **Read the current version** from `dist/public/assets/*.js` or a
   sibling `version.txt` written at package time. Simpler: package
   a `VERSION` file at the install-folder root during zip creation
   so the updater can read it without parsing bundles.
3. **Query GitHub Releases API** for the latest release (reuse the
   endpoint and 60-req/hour anonymous limit already used by the
   in-app update checker in `client/src/lib/updateCheck.ts`).
4. **Compare versions.** If current >= latest, print "You are already
   on the latest version (vX.Y.Z)" and exit 0.
5. **Download the release zip** to `%TEMP%\apd-update-<version>.zip`
   using Node's built-in `https.get()` (no MOTW, no unblock dance
   needed on the extracted files because Node isn't Explorer).
6. **Verify the zip.** At minimum: check byte size matches the GitHub
   asset metadata. Ideal: SHA-256 hash comparison against a hash
   published in the release body (we already write structured release
   notes, add a `sha256:` line at package time).
7. **Extract to a staging folder** `%TEMP%\apd-update-<version>\`
   using the pure-Node ZIP decoder (mirror of the encoder we already
   ship for the diagnostics export in v0.9.31 — no new deps).
8. **Snapshot the current install** by renaming `dist\` → `dist.bak\`.
   Do NOT rename `node\` unless the incoming release also bundles a
   different Node version (compare `node\node.exe` file size or a
   packaged `NODE_VERSION` marker). Leave the launcher `.bat` alone
   unless the release zip includes an updated one.
9. **Move the staged files into place.** Copy `dist\` from staging
   into the install root. Copy any updated launcher `.bat` files.
   Copy `node\` only if it changed in this release.
10. **Update the `VERSION` marker file** at the install root.
11. **Clean up.** Delete `%TEMP%\apd-update-*` on success. Keep
    `dist.bak\` in place for one upgrade cycle (delete it on the
    NEXT successful update, or after 7 days, so a bad update is
    trivially recoverable by renaming it back).
12. **Prompt the user** "Update complete. Launch AdvisePoint Docs
    now? (Y/N)" and either invoke the launcher `.bat` or exit.

### Failure handling

* Any failure between steps 7 and 10 rolls back automatically by
  restoring `dist.bak\` → `dist\` and deleting the staging folder.
* Network failures print a friendly "Could not reach GitHub. Check
  your internet connection and try again." and exit non-zero.
* Version mismatch (release zip is somehow older than current) is
  rejected as a safety guard — no silent downgrades.
* Write a `%LOCALAPPDATA%\AdvisePoint Docs\update.log` capturing
  every step, downloaded URL, sizes, hashes, and any error, so
  we can debug remote reports.

### Test matrix (must pass before v0.9.32 ships)

* Fresh install of v0.9.32 (baseline), run updater with no newer
  release available — prints "already latest", exits 0, changes
  nothing.
* Simulate v0.9.32 → v0.9.33: publish a fake newer release in a
  test repo, run updater, verify `dist\` swapped and version bumped.
* Run with app still running — verify graceful "close the app first"
  prompt, no destructive changes.
* Simulate network failure mid-download — verify rollback leaves
  the install in the exact prior state.
* Simulate corrupted zip (byte-size mismatch or bad SHA) — verify
  the updater refuses to proceed and rolls back.
* Simulate mid-extract failure (delete the staging folder while the
  updater is running) — verify rollback restores `dist.bak\`.
* Verify `%LOCALAPPDATA%\AdvisePoint Docs\` is untouched throughout
  every scenario — DB, pages, logs, localStorage all intact.
* Verify the updated app launches cleanly on the first run after
  update (health endpoint responds, library loads, no errors in
  server.log).

### Release-notes-facing wording

> Adds a one-click updater. Double-click **Update AdvisePoint Docs.bat**
> in your install folder to fetch and install the latest release — no
> unzipping, no copying files. Your library, settings, and history are
> preserved automatically.

### Rough effort estimate

* `packaging/updater/updater.cjs` (~3 h) — GitHub API, download,
  verify, ZIP decode (mirror of encoder), atomic swap, rollback.
* `Update AdvisePoint Docs.bat` (~30 min) — port check, node.exe
  invocation, exit handling.
* Package `VERSION` marker file (~15 min) at the install root during
  zip build; wire into `scripts/bump-version.mjs`.
* Package `SHA256` line in the release notes at zip time (~30 min);
  add to the release-notes markdown template.
* Test matrix on Windows (~90 min); requires a throwaway GitHub repo
  or a local HTTP server to simulate a newer release.
* Release notes (~10 min).

**Total: ~5-6 hours of focused work.**

### Notes for the implementer

* Reuse `client/src/lib/updateCheck.ts` — the GitHub Releases logic
  is identical, so extract the shared "fetch latest release" helper
  into a module both the client and the updater can import (server
  side ships with the CJS build, client side ships in the bundle).
* The pure-Node ZIP encoder from `server/utils/zip.ts` (or wherever
  the v0.9.31 diagnostics export writes) already handles CRC32 and
  the local-file-header format. The decoder is the mirror — read
  the central directory, iterate entries, inflate. `zlib` from Node
  core does the inflate; no new native deps.
* Rollback must be idempotent — running the updater a second time
  after a partial failure should notice `dist.bak\` and offer to
  restore it first before trying the update again.
* Never delete the user's `%LOCALAPPDATA%\AdvisePoint Docs\` folder,
  even if the updater sees version-migration errors. That's the
  user's data. Log the error and exit non-zero instead.
* If the incoming release has a schema migration, the app itself
  runs it on next launch — the updater doesn't touch the database.

## Custom document types and ordering (v0.9.33)

**Filed:** 2026-09-03
**Target release:** v0.9.33
**Status:** Implemented for v0.9.33.
**Ask:** In Settings, let users create document types and choose whether
document-type lists are ordered alphabetically or by a custom importance
order.

### Required behavior

* Add a Document Types manager to Settings.
* Preserve the current built-in types and seed `Brochures` as a built-in type.
* Let the user add a custom document type with a required, trimmed,
  case-insensitively unique display name.
* Provide two ordering modes:
  * `Importance` — a persistent manual order controlled with accessible
    move-up/move-down controls (drag-and-drop may be added as a convenience).
  * `Alphabetical` — display all types A–Z by their user-facing labels.
* Apply the selected order consistently to Upload, Edit document, Library
  filters, and Search filters.
* Store the registry, built-in/custom flag, importance rank, and selected
  ordering mode in the app database under
  `%LOCALAPPDATA%\AdvisePoint Docs\`; do not rely only on browser
  `localStorage`.
* Replace static `z.enum(DOCUMENT_TYPES)` request validation where necessary
  with server-side validation against the configured registry.
* Existing documents must remain valid and retain their current
  `document_type` values.
* Creating or reordering document types must not rewrite document rows or
  trigger re-indexing.
* Let users rename document types. A rename must transactionally update the
  registry plus every matching `documents.document_type` and
  `chunks.document_type` value. It must not rebuild embeddings or page
  renders.
* Let users delete document types. Before deletion, show a confirmation that
  includes the number of affected documents. On confirmation,
  transactionally change every matching `documents.document_type` and
  `chunks.document_type` value to `document`, then remove the type from the
  registry.
* Protect the built-in `document` fallback from rename or deletion.
* Reject rename targets that are blank or duplicate another type after
  trimming and case normalization.
* If any rename or delete database step fails, roll back the entire operation
  so the registry, documents, and chunks cannot disagree.

### QA

* Create a custom type, restart the app, and confirm it persists.
* Upload and edit a document using the custom type.
* Filter Library and Search results by the custom type.
* Verify Importance order in every selector, then switch to Alphabetical and
  verify A–Z order everywhere.
* Reject blank names and duplicates that differ only by case or surrounding
  whitespace.
* Rename a type used by multiple documents and confirm the documents and
  Search filters immediately use the new name without re-indexing.
* Delete a type used by multiple documents and confirm all affected documents
  and chunks now use `document`.
* Confirm deletion reports the correct affected-document count and requires
  explicit confirmation.
* Confirm the `document` fallback cannot be renamed or deleted.
* Force a rename/delete failure and confirm the transaction leaves all type
  values unchanged.
* Confirm existing databases are upgraded without changing document
  metadata or `%LOCALAPPDATA%\AdvisePoint Docs\` content outside the required
  schema migration.

## Brochures document type (v0.9.33)

**Filed:** 2026-09-03
**Target release:** v0.9.33
**Status:** Implemented for v0.9.33.
**Ask:** Add a new document type called `Brochures`.

### Required behavior

* Seed `brochures` in the new document-type registry as a built-in type.
* Display the user-facing label as `Brochures`.
* Make it available anywhere document types are selected or filtered:
  Upload, Edit document, Library filters, and Search filters.
* Preserve existing document types and defaults; do not retag existing
  documents.
* Add coverage confirming a document tagged as `brochures` can be uploaded,
  edited, returned by the API, and isolated with the document-type filter.

## Reset Product model after upload (v0.9.33)

**Filed:** 2026-09-03
**Target release:** v0.9.33
**Status:** Implemented for v0.9.33.
**Observed behavior:** The Upload page initializes Product model from
`apd:upload:lastProductModel`. The prior selection therefore remains selected
for subsequent individual and batch staging, which can silently apply the
wrong model to later documents.

### Required behavior

* Do not auto-select the last-used Product model when the Upload page mounts
  or when a new upload is staged.
* Represent the default as the existing empty string and display it as
  `Not set`. Do not save a literal `Not set` or `Unknown` model value in the
  database or expose either as a product-model filter.
* After a successful single-file upload, pasted-text ingest, or completed
  batch, reset the shared Product model field to empty.
* Newly staged files must not inherit a Product model from an earlier
  completed upload.
* Preserve the selected Product model after a failed upload so the user can
  correct the error and retry without re-entering metadata.
* Keep the existing single-file validation: `Not set` is a visible empty
  state, not a valid model selection. Batch uploads may retain their current
  blank-model workflow.
* The last-used model may remain promoted in the dropdown list for
  convenience, but it must never populate the field automatically.

### QA

* Upload one document with a model and confirm the form returns to `Not set`.
* Stage and upload another individual document and confirm the previous model
  is not applied unless explicitly selected again.
* Complete a batch, stage a new batch, and confirm no Product model carries
  forward.
* Navigate away from Upload, return, and confirm Product model is `Not set`.
* Refresh/restart the app and confirm Product model is still `Not set`.
* Force an upload failure and confirm the chosen model remains available for
  retry.
* Confirm no document or facet stores `Not set` or `Unknown` as a literal
  model.

## Reset upload metadata defaults (v0.9.33)

**Filed:** 2026-09-03
**Target release:** v0.9.33
**Status:** Implemented for v0.9.33.
**Observed behavior:** Shared upload metadata remains selected after an
individual or pasted-text upload. This can carry the prior Document type,
Confidentiality, and Release channel into later uploads. Release channel has
the same carryover behavior even though it returns to `ga` after a page
reload.

### Required behavior

* After a successful single-file upload, pasted-text ingest, or completed
  batch, reset:
  * Document type to `document` (`Document`).
  * Confidentiality to `public` (`Public`).
  * Release channel to `ga` (`General Availability (GA)`).
* Change the default Confidentiality for all newly ingested documents from
  `internal` to `public` in the upload form, request schema, database
  bootstrap/defaults, and denormalized chunk metadata.
* Apply the Public default consistently to individual files, pasted text, and
  batch uploads when the user has not explicitly selected another value.
* Do not modify the Confidentiality or Release channel of any existing
  document during upgrade.
* Do not add custom-list management for Confidentiality or Release channel in
  v0.9.33; this item only fixes defaults and carryover.
* Preserve the user's selected values after a failed upload so the upload can
  be retried without re-entering metadata.
* Newly staged files must use the reset defaults and must not inherit values
  from an earlier completed upload.

### QA

* Upload documents with non-default Document type, Confidentiality, and
  Release channel values; after success, confirm the form shows Document,
  Public, and General Availability.
* Stage the next individual file and batch immediately and confirm the prior
  values do not carry forward.
* Upload without changing Confidentiality and confirm both the document and
  its chunks store `public`.
* Refresh and restart the app and confirm the same defaults.
* Force a failed upload and confirm all selected values remain available for
  retry.
* Upgrade an existing database and confirm existing `internal`,
  `confidential`, and `restricted` documents remain unchanged.

## Updater version-status wording (v0.9.33)

**Filed:** 2026-09-03
**Target release:** v0.9.33
**Status:** Implemented for v0.9.33.
**Observed behavior:** When the installed build is newer than the latest
GitHub release, the updater identifies the older GitHub tag as the "latest
version." The update is correctly skipped, but the wording is confusing.

### Required behavior

The updater must label each value by its source and tailor the status message
to the comparison:

* Always show `Running version: vX.Y.Z`.
* Always show `Latest version available on GitHub: vA.B.C`.
* If running equals GitHub, say `You are running the latest version.`
* If running is newer than GitHub, say `Your running version is newer than
  the latest version currently available on GitHub. No update is needed.`
* If running is older than GitHub, continue with the existing update flow.

Add automated coverage for all three comparison states so future wording
changes cannot misidentify the running or GitHub version.

## Automatic server shutdown during update (v0.9.33)

**Filed:** 2026-09-03
**Target release:** v0.9.33
**Status:** Implemented for v0.9.33.
**Observed behavior:** Closing the browser tab stops client heartbeats, but the
hidden Node server intentionally remains alive for up to 10 minutes. During
that window, the updater sees port 5000 in use and incorrectly implies that
closing the tab is sufficient before immediately retrying.

### Required behavior

* When port 5000 is occupied, first verify through the local health endpoint
  that the listener is this AdvisePoint Docs instance. Never terminate an
  unrelated process merely because it uses port 5000.
* If it is AdvisePoint Docs, prompt:
  `AdvisePoint Docs's background server is still running. Shut it down and continue? (Y/N)`
* On `Y`, request a clean server shutdown, wait for the listener and file
  handles to close, then continue the update automatically.
* On `N`, exit without changing the installation.
* Add a loopback-only server shutdown endpoint for the updater. Require POST
  plus an updater-specific custom request header, reject normal cross-origin
  browser requests, and do not expose the endpoint beyond localhost.
* If graceful shutdown does not complete within a bounded timeout, stop the
  update and show a precise Task Manager fallback. Do not force-kill an
  unidentified process.
* Update README wording to explain that the browser tab and background server
  are separate and that the updater can close the verified server safely.

### QA

* Close the browser tab and immediately run the updater; approve shutdown and
  confirm the update check continues without waiting 10 minutes.
* Decline shutdown and confirm the installation remains untouched.
* Keep the browser tab open, approve shutdown, and confirm the server exits
  cleanly without database corruption.
* Put an unrelated test server on port 5000 and confirm the updater refuses
  to terminate it.
* Simulate a shutdown timeout and confirm the updater exits safely with clear
  recovery instructions.
* Confirm the shutdown endpoint rejects GET, non-loopback, missing-header,
  and cross-origin requests.

## "Back to library" link — larger, bold (next beta)

**Filed:** 2026-09-03
**Target release:** v0.9.32
**Status:** Implemented for v0.9.32.
**Ask:** Make the "← Back to library" link in the doc-detail header easier
to see.

### Change

`client/src/pages/library.tsx` around line 1214. Current classes:

```tsx
className="text-xs text-muted-foreground hover:text-foreground"
```

Change to:

```tsx
className="text-sm font-semibold text-foreground hover:text-primary"
```

That gives:

* `text-xs` → `text-sm` (12px → 14px, matches the primary nav links).
* `text-muted-foreground` → `text-foreground` (full contrast instead of
  the low-contrast muted gray that made it hard to spot).
* Adds `font-semibold` for the bold weight the user asked for.
* Hover color moves to `text-primary` so the affordance still reads as
  a link on hover instead of collapsing into the same color it already
  is at rest.

Optionally: bump the arrow to a lucide `ChevronLeft` icon at `h-4 w-4`
for better visual weight, but text arrow is fine and lower risk.

### Verify

* Screenshot the doc-detail page at desktop and mobile widths.
* Confirm it doesn't visually crowd the title `<h1>` sitting below it.
* Confirm dark-mode contrast is still clean.

## v1.0.0 rename & rebrand — COMPLETED

**Filed:** 2026-09-03 · **Completed:** 2026-09-05 (v1.0.0 build)
**Target release:** v1.0.0

The rename to **AdvisePoint Docs** was executed in the v1.0.0 build session.
Spec archived here for historical reference.

### What shipped

* Product display name: **AdvisePoint Docs** everywhere in UI, launcher,
  updater, error dialogs, diagnostics bundle.
* GitHub repo: `S8619G/AdvisePoint-Docs` (release polling updated).
* Portable zip: `AdvisePoint-Docs-v<VERSION>.zip` containing an
  `AdvisePoint Docs/` folder.
* Runtime data folder: `%LOCALAPPDATA%\AdvisePoint Docs\`
  (DB filename: `advisepoint.db`). **No migration code** — users
  re-upload after upgrade.
* Env vars: legacy prefix → `APD_*` across launcher, server, updater, tests.
* localStorage keys: legacy prefix → `apd:*`.
* Updater handshake header: legacy header → `X-APD-Updater`.
* API `"app"` identifier: legacy slug → `"advisepoint-docs"`.
* Diagnostics zip filename: `advisepoint-docs-diagnostics-*.zip`.
* Icon: replaced with the blue AdvisePoint Docs mark. Full Windows
  `.ico` set + `favicon.ico` + `apple-touch-icon.png` shipped from the
  v1.0.0 icon bundle.
* Seed data: removed entirely. First launch presents an empty library;
  users upload their own content.
* Legacy-brand scrub: `rg -i` gate passes with zero hits across the
  repo (code, comments, packaging, docs, this backlog).

### What was intentionally skipped

* **Data-folder migration.** Decided at v1.0.0 handoff to skip auto-
  migration and have users re-upload rather than ship migration code.
* **GitHub repo rename / redirect.** New repo created fresh at
  `S8619G/AdvisePoint-Docs`; the pre-1.0.0 repo is kept as-is
  for v0.9.x history.
* **Older release notes.** Historical release-notes files outside this
  repo were not rewritten; only in-repo copies were scrubbed.

## v0.9.36 + hotfixes .1 .2 .3 .4 — SHIPPED, carried into v1.0.0

**Base v0.9.36 shipped:** 2026-09-05, three Library refinements
**Same-day hotfixes:** v0.9.36.1 through v0.9.36.4
**Final production-tested state:** v0.9.36.4
**Status in v1.0.0:** fully carried forward from v0.9.36.4 source snapshot;
legacy-name scrub re-applied on port; grep gates pass tree-wide.

### Base v0.9.36 features (all present in v1.0.0)

- **Product Family sort + filter** — symmetric with Product Model; empty
  families sort to top, ties break by title; filter dropdown excludes empty
  families; state persists in URL alongside other Library filters.
- **Reset button** — ghost variant, `RotateCcw` icon, positioned before
  Expand/Collapse All; disabled when Library is at defaults; scope is
  sortBy + filterType + filterModel + filterFamily only (does not touch
  search box, expanded cards, or doc-detail selection).
- **Per-document-type accent color** — nullable 7-char lowercase hex on
  `document_types.color`; picker duplicates TitleColorPicker (12 presets +
  custom + Clear); dot rendered in Library card badge, Library filter
  dropdown, Library edit dropdown, Library detail badge, Upload picker
  (both variants), Query filter dropdown; dot OMITTED entirely when color
  is NULL; independent from per-doc title color.

### Hotfix summary (all carried forward)

| Version | Fix | Files touched |
|---|---|---|
| 0.9.36.1 | In-app updater `spawn` broke on Windows paths with spaces. Rewrote to skip `cmd.exe /c start`, use `shell: true` on the .bat directly. Added `windowsHide: true` + `APD_UPDATE_ASSUME_YES=1` + `APD_UPDATE_NO_PROMPT=1` env vars so the in-app path runs silently. Added client-side `/api/health` fallback check after countdown so a failed launch surfaces a real error instead of a fake countdown. | `server/routes.ts`, `client/src/components/UpdateCheckPanel.tsx` |
| 0.9.36.2 | Doc-type color picker trigger was a 5×5 outlined circle that blended into rows on many themes. Swapped for a `Pipette` icon Button with the tint color applied to the icon when a color is set, plus a small dot at the bottom-right of the icon for at-a-glance recognition. Behavior and popover contents unchanged. | `client/src/components/DocumentTypeManager.tsx` |
| 0.9.36.3 | Client-side `cmpVersion` used `.slice(0, 3)`, collapsing 4-segment hotfix versions (0.9.36.1 == 0.9.36.2 == 0.9.36.3). Update checker reported "you're on the latest version" incorrectly. Now compares every numeric segment; missing trailing = 0. `updater.cjs`'s own `compareVersions` was already correct. | `client/src/lib/updateCheck.ts` |
| 0.9.36.4 | `PATCH /api/document-types/:key/color` used regex `/^#[0-9a-f]{6}$/`, rejecting the uppercase hex the client preset table emits (`#C42B1C` etc.) with a 400. Now accepts `[0-9a-fA-F]` and lowercases before storing so the DB stays canonical. Matches the sibling `shared/schema.ts` Zod validator. | `server/routes.ts` |

### v1.0.0-specific notes carried from the hotfix batch

1. **Hotfix suffix convention is load-bearing.** The 0.9.36.3 `cmpVersion`
   fix is what allows N-segment version strings to work with the update
   checker. v1.0.0 preserves this in `cmpVersion`; the same hotfix-suffix
   pattern will apply post-1.0.0.
2. **Color feature route validator pattern.** The route accepts both
   cases (`[0-9a-fA-F]`) and normalizes to lowercase before persisting.
   Any lookalike endpoint added post-1.0.0 (per-user, per-org, per-tag
   colors) should mirror this case-insensitive + normalize-to-lowercase
   pattern.
3. **In-app updater still not end-to-end verified on Windows.** The
   0.9.36.1 spawn fix, hidden window, and prompt-skip envs are all in
   place, but no round-trip test has been possible from the Linux
   development environment. First real-world validation will happen the
   next time a release ships AND a user runs the in-app updater from
   0.9.36.1-or-later (i.e. from v1.0.0). Consider this an
   untested-in-production code path.
4. **Env var rename applied on port.** The legacy updater env-var prefix
   became `APD_UPDATE_ASSUME_YES` and `APD_UPDATE_NO_PROMPT` when the
   v0.9.36.x files were ported into the AdvisePoint Docs tree. Server-side
   `spawn()`, `updater.cjs` reads, and updater test suite are all
   consistent.
5. **Color picker trigger icon pattern.** The `Pipette` glyph with tinted
   fill + corner dot from 0.9.36.2 is the correct UX and should be
   preserved. Any future per-entity color pickers should reuse it for
   consistency.

## Searchable combobox for Product Model filter (Library page)

**Status:** Deferred (still deferred in v1.0.0). Current Radix `<Select>`
handles viewport-bounded scrolling correctly, so the dropdown never
truncates. The concern is *usability at scale*, not correctness.

**Trigger:** swap when distinct `product_model` values in the library reach
**~200**. Below that the current sorted, scrollable list is fine. Above it,
finding a specific model in a 200-entry alphabetized list is tedious.

**Location:** `client/src/pages/library.tsx` around the `<Select>` that
renders `modelOptions` for the library filter row.

**Recommended replacement:** shadcn's `<Combobox>` pattern (`<Command>`
inside a `<Popover>`). Gives type-to-filter across all options, same
keyboard navigation, same viewport-bounded scroll, fits the existing
`h-8 w-[180px]` trigger footprint.

**Not needed yet:**
- Virtualization (react-window) — only necessary above ~1000 distinct
  models.
- Server-side model list endpoint — the `data` array in the library page
  is already loaded client-side.

**Related places to consider at the same time:**
- Upload page product-model input is currently free-text. Consider an
  autosuggest-on-focus mode so users can reuse existing model names and
  avoid near-duplicates (e.g. capitalization variants). Free-text entry
  must still work for brand-new models.
- Query page had a product-model filter historically (removed in v0.9.28);
  worth reconsidering as a combobox now that the pattern exists.

**Estimated effort:** 45–60 min for the Library filter alone. +30 min if
extending to the Upload page.

## v1.0.0 candidate: unified filter/sort management (toggle-based)

**Status:** v1.0.0 candidate. Explicitly OUT of v0.9.36 scope by user
decision on 2026-09-05. Confirm scope before implementing.

**Motivation:** Currently the Library page has an ad-hoc mix — some fields
sort, some filter, Product Model does both. Adding more sortable/filterable
fields over time will make the top control row grow unmanageably wide.

**Concept:** replace the fixed set of filter dropdowns with a user-
switchable model where the user chooses which fields get their own filter
dropdown active in the row.

### Tier options

1. **"+ Add filter" chip pattern (RECOMMENDED)** — filter row starts
   compact. A small `+ Add filter` button opens a menu of available filter
   fields; each pick becomes a removable dropdown. Sort dropdown stays
   separate. Familiar from Gmail/Notion/Linear. Estimated 3–4 hours.
2. **Per-field mode toggle** — every field header has icon set (⇅ sort,
   ▼ filter). User clicks to enable each independently. Highest UI
   complexity — icon vocabulary users have to learn. 5–6 hours.
3. **Global sort/filter mode switch** — one dropdown per field, radio
   toggles "these are SORTS" vs "these are FILTERS." Compact but
   confusing, actually REMOVES capability. NOT recommended.

### Belongs in the same v1.0.0 design conversation as

- Saved views (persist a named sort + filter combination)
- Custom sort orders (user-defined ordering beyond alphabetical)
- Multi-select filtering (show docs for models X, Y, AND Z)
- Column visibility toggles

Treat as one coherent "Library table controls" feature area for v1.0.0
planning rather than piecemeal additions.

### Data available today

Filter/sort-candidate fields on the doc type:
- `document_type` — currently: sort + filter
- `product_model` — currently: sort + filter
- `product_family` — v0.9.36+: sort + filter
- `firmware_version` (labeled "Revision") — currently neither, easy to add
- `title` — currently: sort only
- `ingested_at` — currently: sort only (as "Recently added")

Six sortable/filterable fields is at the threshold where the current
fixed-dropdown row starts feeling cluttered on smaller windows.

## Backup & Restore (planned for v1.0.0)

**Filed:** 2026-09-03
**Target release:** v1.0.0 (the AdvisePoint Docs rename)
**User decision on scope:** ship as a headline v1.0.0 feature, with both
Wipe-and-Replace and Merge import modes. Merge intentionally allows
duplicates through without warnings — users clean up afterward with the
existing duplicate checker.

### What to build

A Settings-panel "Backup & Restore" section with two primary actions:

1. **Export backup** — produces a single `.zip` containing:
   * `db/kie.db` — SQLite snapshot written via `VACUUM INTO` so it is
     transactionally consistent even if writes are happening.
   * `pages/**` — every file under `RAG_PAGES_DIR` (page renders and
     extracted text) so the viewer works after restore with no re-render.
   * `localStorage.json` — dumped from the browser side (tab state,
     library UI preferences, remembered selections) so a restored install
     lands the user where they left off.
   * `manifest.json` — `{ app_version, schema_version, exported_at,
     document_count, chunk_count, pages_bytes }` for validation and
     compatibility checks on import.
   * Reuse the pure-Node ZIP encoder that already ships for diagnostics
     export (added in v0.9.31) — no new native dependency.
   * Suggested filename: `kie-backup-YYYYMMDD-HHMMSS.zip`.

2. **Import backup** — accepts a `.zip` produced by Export and offers
   a mode picker:

   * **Wipe and Replace** (default, safest single-user path):
     * Confirm modal makes it clear this destroys the current library.
     * Server extracts to a staging dir, validates the manifest, then
       does an atomic swap: rename current data dir to `data.bak`,
       move staging into place, restart the DB connection.
     * Keep the `.bak` for one cycle so a bad import is recoverable
       from disk (documented in the release notes; user can delete
       manually when they are satisfied).
     * Restore `localStorage.json` on the client after the server
       confirms the swap.

   * **Merge** (multi-source / add-to-existing path):
     * Bulk-insert every document, chunk, embedding, and metadata row
       from the backup DB into the current DB.
     * **No duplicate detection.** If the same doc is present in both,
       both copies end up in the library. This is the explicit user
       choice — the existing duplicate checker handles cleanup on
       their schedule.
     * Implementation: attach the backup DB as a second SQLite
       connection, `INSERT ... SELECT` each table, remap primary keys
       where they collide (documents, chunks, embeddings all use
       string IDs today, so collisions are only expected when the
       same doc was exported from an install descended from the same
       source — remap with a fresh UUID and rewrite FK references).
     * Copy `pages/**` from the backup into the current pages dir;
       filenames are keyed on doc ID, so if we remapped an ID we
       also rename the corresponding page files.
     * `localStorage` is NOT merged (would be nonsensical); merge
       mode leaves the current UI state alone.
     * Progress UI shows "Merging N documents…" with a running count.

### UI shape

* Settings page gains a "Backup & Restore" card.
* Two buttons: **Export backup** and **Import backup**.
* Export shows a progress dialog (backups can be hundreds of MB with
  pages) and hands the browser a download when done.
* Import shows a file picker → mode picker (Wipe vs Merge) → confirm
  modal (only the Wipe path warns destructively) → progress dialog →
  success screen with a "Reload app" button.
* On schema-version mismatch: show a warning but allow the user to
  proceed. Older backups should generally load into newer schemas
  because migrations are idempotent-forward; log the mismatch.

### Server endpoints

* `GET /api/backup/export` — streams the zip. Long-running; use
  chunked transfer encoding.
* `POST /api/backup/import` — multipart upload of the zip, with a
  `mode=wipe|merge` field. Streams a JSON progress log back over SSE
  or returns a job ID that the client polls.
* `POST /api/backup/finalize` — client calls this after `localStorage`
  restore is complete on the Wipe path, so the server can clear the
  `.bak` retention timer on the next cycle.

### Cross-PC workflow this enables

1. Old PC: Settings → Export backup → save the zip somewhere portable
   (USB, network share, cloud drive).
2. New PC: install the v1.0.0 portable, launch once so the launcher
   initializes empty data dirs.
3. Settings → Import backup → pick the zip → choose Wipe and Replace
   → confirm → wait for progress → Reload.
4. Library, documents, page renders, embeddings, metadata, and last
   UI state all present. Search works immediately with no
   re-embedding, no re-ingest.

### Explicitly out of scope for v1.0.0

* Scheduled/automatic backups with retention policy — nice to have,
  defer to a later release.
* Import-side duplicate detection — user has requested we skip this
  deliberately and lean on the existing duplicate checker.
* Encrypted backups — not requested; add later if a user asks.
* Selective / partial export (single doc, single folder) — not asked
  for; the full-DB backup covers the stated use case.

### Rough effort estimate (from planning session on 2026-09-03)

* Server export endpoint (~45 min)
* Server import (wipe path with atomic swap) (~90 min)
* Server import (merge path with ID remap and page-file rename) (~2 h)
* Manifest schema + compatibility check (~30 min)
* Client UI (buttons, progress dialogs, confirm modals, mode picker) (~90 min)
* `localStorage` dump / restore (~30 min)
* Smoke test matrix: export → wipe → import; export → merge into
  populated DB → verify duplicates present; version mismatch warning
  path (~45 min)
* Release notes (~10 min)

**Total: ~6-7 hours of focused work**, up from the ~4-5 h estimate for
wipe-only, because merge requires the ID-remap path and its tests.

## Update checker — refresh on every app launch

**Filed:** 2026-09-02 (post-v0.9.30.2)
**Chosen approach:** Option B (fresh at startup, 24h between polls while open)

### What to change

`client/src/lib/updateCheck.ts` — `getLatestRelease()` currently returns the
cached result whenever it is <24h old, including on the very first call after
app startup. This hides freshly-published releases from users who had the app
open (or a stale cache) when the release went live.

Change the check flow so:

* **On every app startup / mount**, the first `getLatestRelease()` call
  bypasses the cache and hits GitHub fresh. Update the cache with the result.
* **While the app stays open**, the polling loop keeps the current 24h
  interval and uses the cache for background checks — no need to hammer
  GitHub if someone leaves the app running all day.

### Suggested implementation sketch

Add a `hasCheckedThisSession` module-level boolean (or accept a
`forceOnFirstCall` flag from the caller):

```ts
let hasCheckedThisSession = false;

export async function getLatestRelease(forceRefresh = false): Promise<LatestRelease | null> {
  const isFirstCall = !hasCheckedThisSession;
  hasCheckedThisSession = true;

  const cached = readCache();
  const useCache = !forceRefresh && !isFirstCall && cached
    && Date.now() - cached.fetchedAt < CHECK_INTERVAL_MS;
  if (useCache) return cached!.release;

  const fresh = await fetchLatest();
  writeCache(fresh);
  return fresh;
}
```

### Notes for the implementer

* The React hook that drives the banner mounts once per app load, so the
  "first call" heuristic naturally maps to "one fresh check per app open."
* GitHub's anonymous rate limit is 60 requests/hour per IP. Even a heavy user
  opening the app 20x/day is nowhere near that ceiling, so no throttling is
  needed.
* If the fresh fetch fails (offline, GitHub down), fall back to whatever is
  in the cache rather than showing nothing — the existing `fetchLatest()`
  returns `null` on failure and `writeCache(null)` currently overwrites a
  good cached entry with `null`. Consider only writing the cache when the
  fetch succeeds, so a transient network blip doesn't erase a good cached
  result.
* Update the comment block at the top of `updateCheck.ts` — the current text
  says "Result cached in localStorage with a 24h freshness window so a
  browser refresh doesn't hammer the endpoint," which is no longer accurate.
* No release-note-facing behavior change beyond "the update banner will pick
  up new releases faster." Users won't need to know the mechanism.

## Server-side boot instrumentation

**Filed:** 2026-09-02 (post-v0.9.30.2)
**Motivated by:** v0.9.30 / v0.9.30.1 crash-on-launch investigation that took
multiple round trips because we could not tell whether node had run at all,
where in startup it had died, or whether the port ever bound.

### What to change

Add structured boot-phase instrumentation to the server so any future launch
failure leaves an unambiguous trail in `server.log`. All of this is inside
`server/` and independent of the Windows launcher.

1. **Register uncaught-exception + unhandled-rejection handlers first.**
   At the very top of `server/index.ts`, before any other import, wire
   `process.on('uncaughtException', ...)` and `process.on('unhandledRejection', ...)`
   to log a full stack trace and flush stdout/stderr synchronously before
   exiting non-zero. This is the single most important change - a crash in
   any early module (DB open, migrations, seed copy) currently vanishes with
   no trace under the hidden-window launcher.

2. **Phase markers with timings.** Wrap each boot phase in a helper like
   `withPhase('db-open', () => openDb())` that logs
   `[boot] phase=db-open start` / `[boot] phase=db-open done elapsed=34ms`.
   Phases to instrument:
   * load-config (env vars, resolved paths)
   * db-open (better-sqlite3 open + PRAGMAs)
   * db-migrate (idempotent ALTER TABLE loop)
   * seed-check (copy seed.db if fresh install)
   * seed-pages (copy page images)
   * seed-rewrite (fix image_path column in document_pages)
   * backfill (location metadata backfill)
   * express-build (route registration)
   * listen (server.listen resolve)
   Any phase >5s gets a WARN line so slow migrations on huge DBs are visible.
   If node dies mid-phase, the last "phase=X start" without a matching "done"
   pinpoints exactly where.

3. **Environment snapshot at boot.** Log a single line early:
   `[boot] node=v20.11.1 os=win32 build=10.0.22631 cwd=... db=... port=5000
   dist_sha=abcd1234 dist_bytes=1478332 free_gb=12.4`. Cheap, invaluable when
   debugging remotely.

4. **Enriched `/api/health` response.** Currently returns `{ ok, documents,
   chunks }`. Extend to also return:
   * `boot_phase` - current phase name, or `"ready"` once listen completes
   * `boot_completed_at` - ISO timestamp of when listen resolved
   * `uptime_ms` - `Date.now() - process_start`
   * `last_error` - most recent uncaught error message + timestamp, or null
   * `version` - APP_VERSION so we can confirm which build is running
   Serve `/api/health` from a route mounted BEFORE any DB-dependent middleware
   so it stays responsive even during a slow migration.

5. **Structured JSON log lines (optional, defer if the plain format is
   sufficient).** Every log line becomes `{ts, level, phase, msg, ...extra}`
   on stdout when `APD_LOG_FORMAT=json` is set, otherwise the current
   human-readable format. Keeps grep-friendliness while enabling later
   analysis.

6. **Size-based log rotation.** The current .bat rotates only on launch;
   `server.log` grows unbounded during a long uptime. Add a periodic check
   (once per hour is fine) that rotates `server.log` -> `server.log.1` when
   size exceeds 10 MB, keeping at most 3 historical files.

### Notes for the implementer

* Do not import anything heavy in the uncaught-exception handler itself - the
  process is dying, keep the handler self-contained with fs.appendFileSync
  and a hardcoded path.
* The `withPhase` helper should be sync-or-async agnostic (`await
  withPhase('db-open', async () => ...)` should work).
* The `/api/health` route with boot state means the FE update banner and
  troubleshooting page can distinguish "server is running but stuck in
  migrations" from "server never started."
* This is independently valuable regardless of whether the launcher-side
  logging item below ships.

## Launcher-side pre/post log framing

**Filed:** 2026-09-02 (post-v0.9.30.2)
**Motivated by:** During the v0.9.30.1 debugging the user's crashed installs
left `server.log` untouched entirely - we couldn't distinguish "node crashed"
from "the .bat/PowerShell chain died before invoking node" without a
separate diagnostic round trip.

**IMPORTANT:** Any changes to `Start AdvisePoint Docs.bat` must be
smoke-tested end-to-end on Windows before shipping. v0.9.30 and v0.9.30.1
both broke fresh installs despite the server code being unchanged, because
cmd + PowerShell quoting is much more fragile in practice than on paper.
The current launcher is byte-identical to the known-good v0.9.29 pattern -
treat it as a stable baseline and make changes strictly additive.

### What to change

Add minimal framing lines around the PowerShell/node invocation in
`packaging/Start AdvisePoint Docs.bat` so that even a total node-side
failure leaves a signature in the log:

1. **Pre-launch line.** Immediately before the `powershell ... Tee-Object`
   line, append (not overwrite) a marker to `%APD_LOG%` from cmd:
   ```bat
   >> "%APD_LOG%" echo [launcher] === session start %DATE% %TIME% pid=%RANDOM% ===
   >> "%APD_LOG%" echo [launcher] app_root=%~dp0
   >> "%APD_LOG%" echo [launcher] node=%~dp0node\node.exe
   >> "%APD_LOG%" echo [launcher] entry=%~dp0dist\index.cjs
   >> "%APD_LOG%" echo [launcher] db=%RAG_DB_PATH%
   ```
   Use `>>` (append) so the Tee-Object -Overwrite that follows doesn't nuke
   these lines - or reorder so the framing lines come AFTER PowerShell exits.
   The exact ordering interacts with Tee-Object's default overwrite semantics
   and must be tested on Windows before shipping.

2. **Post-exit line.** Immediately after `set "APD_EXIT=%ERRORLEVEL%"`, append:
   ```bat
   >> "%APD_LOG%" echo [launcher] === node exited code=%APD_EXIT% at %DATE% %TIME% ===
   ```
   This survives the PowerShell process exit and gives us the exit code even
   when the crash-surface console window flashes and disappears.

3. **Log any launcher-level branch that skips node.** If the .bat bails out
   in the self-relaunch section, the MOTW-unblock block, the port-5000
   taskkill, or anywhere before the PowerShell call, the log will be silent.
   Consider a tiny helper that echoes each phase to a *separate*
   `launcher.log` file at `%LOCALAPPDATA%\AdvisePoint Docs\launcher.log` so
   even those pre-server failures leave a trail without touching the
   Tee-Object dance around `server.log`.

### Notes for the implementer

* This item is lower priority than the server-side instrumentation. If the
  server-side handlers are in place, any node-execution failure will be
  captured well; launcher-level framing mostly helps when PowerShell itself
  is the culprit, which is rarer now that the launcher is back to the
  v0.9.29 baseline.
* Test matrix before shipping:
  * Fresh folder, first launch (MOTW unblock runs)
  * Fresh folder, second launch (MOTW sentinel skips)
  * Upgrade over existing folder (versioned sentinel forces re-unblock)
  * Simulated node crash (temporarily rename node.exe) - verify launcher
    framing survives and crash-surface console still opens
  * Port 5000 already in use - verify taskkill branch logs and node still
    starts cleanly on the freed port
* Do NOT introduce a separate `.ps1` script file (v0.9.30.1's failed
  approach) or move the PowerShell command into any construct that requires
  additional cmd quoting layers. Framing is `echo` from cmd, nothing more.
