# AdvisePoint Docs — Future-Build Backlog

Items accepted for a future release but deliberately deferred from the current
version. Each item should have enough detail that a fresh session can pick it
up without going back to the source conversation.

## v1.0.4 — release scope summary

**Committed scope (2026-09-08):** 4 items — reliability drop.
Deferred DOCX viewer, node.exe rebrand, and Windows on ARM to v1.0.5
for scope + credit budget reasons. Update this summary whenever an
item is added, reordered, removed, or promoted to SHIPPED.

**Reliability (headline)**

1. [Renderer — per-page timeout, abort, and queue continuation](#renderer--per-page-timeout-abort-and-queue-continuation-v104--planned) — pdfjs calls get wrapped in configurable timeouts; hung pages skip forward, hung docs release the queue. Multi-doc uploads no longer starve on a single bad file.
2. [PageViewer — false "still rendering" spinner on non-PDF documents](#pageviewer--false-still-rendering-spinner-on-non-pdf-documents-v104--planned) — small client-only fix so DOCX/TXT/MD viewers stop showing a forever-spinner.

**Observability**

3. [Header — background rendering activity indicator](#header--background-rendering-activity-indicator-v104--planned) — subtle spinner between Query and stats counter, visible only while rendering is active. Hover-for-progress tooltip. Failure state (red glyph, click-to-dismiss) surfaces failed docs by name.

**Feature additions**

4. [Backup Settings — show current backup size for storage planning](#backup-settings--show-current-backup-size-for-storage-planning-v104--planned) — muted line under retention row showing DB + pages footprint so users can plan disk space.

### Suggested implementation order

1. **PageViewer non-PDF spinner fix** (~30 min) — trivial standalone client fix; unblocks nothing else but easy warm-up.
2. **Renderer per-page timeout** — reliability core; must land before header indicator so the failure signal is real.
3. **Header render-status indicator** — consumes the failed-doc signal from step 2.
4. **Backup size display** — small, self-contained, ship at the end.

### Cross-cutting concerns

- The **Header render-status indicator** (item 3) and **renderer timeout** (item 1) both touch queue bookkeeping. Land the timeout first so the indicator can consume the failed-doc signal for its red/badge state.
- **User-notification hard requirement:** every failure signal (toast, tooltip, badge, anywhere) MUST name the specific failing document by title. "A render failed" without saying which one is not acceptable in multi-document uploads. Both the renderer timeout entry (item 1) and the header render-status indicator entry (item 3) capture this.

## v1.0.5 — release scope summary

**Split from a proposed 5-item v1.0.5 on 2026-09-08.** ARM64 moved
to its own v1.0.6 release to isolate the highest-risk item and keep
v1.0.5 as a tight, low-risk consolidation release. Four items in
v1.0.5; ARM64 is the sole headline feature of v1.0.6 (see below).

**Feature additions**

1. [DOCX viewer — render extracted content in the PageViewer dialog](#docx-viewer--render-extracted-content-in-the-pageviewer-dialog-v105--planned) — real in-app viewer for DOCX/TXT/MD, reusing the mammoth-extracted HTML. Builds on the PageViewer fix already shipped in v1.0.4.
2. [Install-location guidance and cloud-sync detection](#install-location-guidance-and-cloud-sync-detection-v105--planned) — README section, boot-time path detection, dismissible header banner, and a muted note under the backup-folder input in Settings. Added 2026-09-08 after a KEY-OP-TRAINING.docx upload silently failed with browser-side "Failed to fetch" when the app was running from inside a OneDrive-synced folder.
3. [Render event-loop stalls — raise reconnect threshold and add micro-yields](#render-event-loop-stalls--raise-reconnect-threshold-and-add-micro-yields-v105--planned) — raise `RECONNECT_THRESHOLD` from 1 to 3 (banner appears after ~6s of failure instead of ~2s) and add `setImmediate` yields around `canvas.toBuffer` inside the render loop. Addresses the user-visible "reconnecting" banner false-positives from a v1.0.4 field report. Full architectural fix (worker_threads for pdfjs) deferred to v1.0.7-candidate for a focused sprint. NOT a v1.0.4 regression — exists since v0.9.30 — but v1.0.4's per-page timeout + queue continuation on failure makes the exposure slightly worse.

**Cosmetic / polish**

4. [node.exe Task Manager visibility — Version Resource + icon embed](#nodeexe-task-manager-visibility--version-resource--icon-embed-v105--planned) — rcedit rewrites node.exe's ProductName/FileDescription/icon so Task Manager shows "AdvisePoint Docs" instead of "Node.js JavaScript Runtime." Keeps filename `node.exe` to avoid launcher churn.

### Suggested implementation order

1. **Install-location guidance** first — pure additive, zero interaction with the other three, and ships user-visible value even if the release slips on the other items.
2. **Render event-loop stalls** — ~15 lines of code (threshold bump + micro-yields), no packaging risk. Do this right after install-location and it's essentially free.
3. **node.exe rebrand** — one-shot packaging change, isolates well from DOCX.
4. **DOCX viewer** — self-contained feature, largest item in this release, land it last so any UI issues don't block the other three.

Alternate ordering: if v1.0.4 field validation of the renderer
timeout surfaces any issue, hotfix that first before starting
v1.0.5 work.

### Batching decision (2026-09-08)

All four items batch into a single v1.0.5 build to share the
release + QA cycle overhead. Total code footprint is modest and
risk is low-to-medium across the set. ARM64 is deliberately NOT in
this release — it's the largest single line item in the v1.0.x
line and needs its own focused sprint with a separate QA cycle,
which v1.0.6 provides.

## v1.0.6 — release scope summary

**Split from v1.0.5 on 2026-09-08.** Single-headline release: full
Windows on ARM support. Isolating this item from v1.0.5 keeps the
high-risk multi-arch packaging + native-module-rebuild work from
colliding with the low-risk consolidation work in v1.0.5.

**Headline feature**

1. [Windows on ARM — full ARM64 support](#windows-on-arm--full-arm64-support-v106--planned) — first-class native ARM64 build alongside x64. Multi-arch packager, native module rebuilds (`better-sqlite3`, `@napi-rs/canvas`), launcher arch detection, in-app updater arch matching. Ships two portable zips per release (`AdvisePoint-Docs.zip` for x64, `AdvisePoint-Docs-arm64.zip` for arm64).

**Prerequisites:**

- v1.0.5 shipped and stable in the field for at least one release
  cycle, so any ARM64 issues surface against a known-good baseline
  rather than getting confused with concurrent DOCX-viewer or
  install-location changes.
- Field validation of the event-loop stalls fix (v1.0.5 item 3)
  confirms whether the cheap threshold/yield fix is sufficient or
  whether the worker_threads refactor also needs to land — the
  refactor would be its own item, NOT bundled into v1.0.6.

### Batching decision (2026-09-08)

ARM64 is a single focused sprint with its own build + QA cycle. Do
NOT bundle any additional items into v1.0.6 unless they're
directly related to ARM64 (e.g. arch-specific launcher fixes
discovered during development). Any unrelated feature or bugfix
found during the v1.0.6 sprint should be filed as v1.0.7 or a
v1.0.5.x hotfix rather than absorbed into v1.0.6.

**Suggested implementation order:** monolithic — one focused sprint
for the whole ARM64 stack. See the full spec below for the ordered
sub-tasks.

### Definition of done — v1.0.4 release gate

Before v1.0.4 ships, verify each item below. Any unchecked item is
a blocker. Update this checklist whenever a new release gate is
added.

**Failed-document naming (user requirement, 2026-09-08):**

- [ ] Upload-page toast on render failure names the failing document by title (falls back to filename if title is empty)
- [ ] Upload-page toast includes the specific failure reason (page N timeout, malformed stream, etc.) — not a generic "render failed"
- [ ] Upload-page toast uses `variant: "destructive"` and does not auto-dismiss
- [ ] Header render-status indicator's failure tooltip lists EACH failed document by title, one line per failure, with its specific reason
- [ ] Header indicator failure glyph stays visible until user clicks to dismiss (does not fade like the clean-completion signal)
- [ ] `GET /api/render/status` response includes a `recent_failures[]` array with `title`, `file_name`, and `error` per failed doc

**Renderer reliability (from renderer-timeout entry):**

- [ ] Per-page render timeout enforced (default 2 min, env-var configurable)
- [ ] `doc.getPage(n)` timeout enforced (default 30 sec)
- [ ] `pdfjs.getDocument()` load timeout enforced (default 1 min)
- [ ] Whole-document wall-clock timeout enforced (default 30 min)
- [ ] Hung page fails soft: rest of the doc still renders, doc marked `"ready"` with `(partial)` note when < 25% pages failed
- [ ] Hung page fails hard: doc marked `"error"` when > 25% pages failed, first failure reason recorded
- [ ] Hung doc does NOT starve the queue: next queued doc starts rendering
- [ ] Integration test: mock hung page in doc 1 of 3-doc batch, confirm docs 2 and 3 render normally

**DOCX / non-PDF handling:**

- [ ] PageViewer no longer shows "Page 1 is still rendering" for `status: "missing"` (DOCX/TXT/MD)
- [ ] PDF page-image viewer still works exactly as v1.0.3.1 (no regression)

_(DOCX viewer itself moved to v1.0.5; the PageViewer fix landed here to stop the false spinner without adding a new viewer surface.)_

**Standing gates (apply to every release):**

- [ ] `rg -i kyocera dist/ client/ server/ shared/ script/ scripts/ packaging/` returns zero hits
- [ ] Build smoke test passes (server binds port, port responds within 15s)
- [ ] `client/src/version.ts` bumped to 1.0.4
- [ ] Release notes written in impersonal tone (no signature, no location footer)
- [ ] Launcher `.bat` unchanged OR both `EXPECTED_LAUNCHER_SHA256` and `NEW_LAUNCHER_SHA256` in `scripts/package-windows.mjs` updated to match the shipped launcher
- [ ] Manual test: upload the KEY-OP-TRAINING_Guide_5012.docx file that surfaced the DOCX issue; confirm no false "Page 1 is still rendering" spinner (content viewer itself is v1.0.5)

_(Windows on ARM deferred to v1.0.5 on 2026-09-08. Its DoD items
will be re-added when v1.0.5 scope is finalized.)_

---

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

## "Back to library" link — larger, bold — SHIPPED

**Filed:** 2026-09-03
**Shipped in:** v0.9.32 (initial pass) and further strengthened in a later
build carried into v1.0.x.
**Status:** DONE. Confirmed live in v1.0.1.1 (2026-09-07).
**Ask:** Make the "← Back to library" link in the doc-detail header easier
to see.

### What actually shipped

`client/src/pages/library.tsx` (link-back on the doc-detail header). Final
classes used in v1.0.1.1:

```tsx
className="text-base font-bold text-foreground hover:text-primary hover:underline underline-offset-4"
```

Stronger than the original spec proposed (`text-sm font-semibold`) —
bumped one more size step to `text-base`, bumped weight to `font-bold`,
and added underline-on-hover for a clearer link affordance. Dark-mode
contrast confirmed clean during user evaluation.

## Query search box — select-on-focus (v1.0.3 — SHIPPED)

**Filed:** 2026-09-07
**Target release:** v1.0.3
**Status:** implemented on main, uncommitted release, awaiting v1.0.3 build
**Ask:** In Query mode the previous search text persists in the input
(correct behavior for reference), but starting a fresh search required
manually clearing the field first. Should auto-select the whole query
on focus so typing overwrites it.

### What shipped (staged for v1.0.3)

Added `onFocus={(e) => e.currentTarget.select()}` to the query input in
`client/src/pages/query.tsx`. Matches the existing `/` keyboard shortcut
behavior (which already does `focus()` + `select()`), so mouse-focus and
keyboard-focus are now consistent — both leave the prior query selected
and ready to be typed over. The user can still click twice or drag to
deselect and edit the prior query in place if they want to iterate
instead of replacing.

## Zip filename — version-free canonical name (v1.0.3 — SHIPPED)

**Filed:** 2026-09-07
**Target release:** v1.0.3
**Status:** planned, not implemented
**Ask:** Release zips are named `AdvisePoint-Docs-v<VERSION>.zip`. When
Windows Explorer extracts them it creates a wrapper folder named after
the zip (e.g. `AdvisePoint-Docs-v1.0.2\`) that contains the real app
folder. After the in-place updater bumps the app to v1.0.3, the wrapper
folder still says `v1.0.2` and misleads the user about what's actually
installed.

### Decision

Adopt Option 1a from the 2026-09-07 discussion: rename the release asset
to `AdvisePoint-Docs.zip` (no version) starting with v1.0.3. Version
identity remains discoverable via the GitHub release page title, the
git tag, the release notes SHA-256, and the app's header / About view.

One-time cost: v1.0.2's updater expects `AdvisePoint-Docs-v<VERSION>.zip`
and will not find `AdvisePoint-Docs.zip`, so v1.0.2 users must do a
single manual download of v1.0.3 from the release page. After that,
auto-updates resume normally.

### Changes to make when building v1.0.3

1. **`packaging/updater/updater.cjs`** — broaden `expectedName` matcher
   (currently line ~170) to accept EITHER `advisepoint-docs.zip` OR
   `advisepoint-docs-v<VERSION>.zip` (case-insensitive). Prefer the
   version-free name when both are present. The legacy pattern can be
   dropped in v1.1.0 after enough time on the new naming.
2. **Packaging invocation** — pass `--output
   /home/user/workspace/AdvisePoint-Docs.zip` to
   `scripts/package-windows.mjs`. Keep the local file in
   `/home/user/workspace/` versioned for archival
   (`AdvisePoint-Docs-v1.0.3.zip`) via a copy, but upload as
   `AdvisePoint-Docs.zip`.
3. **Release upload script** — upload asset with `name` parameter set to
   `AdvisePoint-Docs.zip`, not the versioned filename. Update the
   `create_release_v1_0_3.py` template accordingly.
4. **Release notes** — open with a clearly labeled "Upgrade note for
   v1.0.2 users" callout explaining that this release must be downloaded
   manually (in-app updater in v1.0.2 can't locate the renamed asset)
   and that auto-updates resume in v1.0.4+.
5. **Wiki convention** — update
   `projects/kyo-info-explorer-YsNMksjdR3.Nlw.5pQCZUw/knowledge/concepts/conventions.md`
   to record the new zip-naming rule and the transitional matcher rule
   in the updater.
6. **Share to user** — continue calling `share_file` with the same
   versioned display name pattern (`AdvisePoint-Docs-v1.0.3.zip`) so the
   asset appears in the artifact history with a distinguishable name,
   even though the file uploaded to GitHub is `AdvisePoint-Docs.zip`.

### Rejected alternatives

- **Option 1b (change filename in v1.0.3 without updater compat)** —
  breaks auto-updates for every existing install. Rejected.
- **Option 1 with 2-step rollout (updater fix in v1.0.3, rename in
  v1.0.4)** — no manual-download cost, but pushes the visible
  naming fix out another release. Rejected in favor of
  fixing it once.
- **Option 2 (versioned zip filename, version-free inner wrapper folder)**
  — requires users to know to move only the inner folder, which they
  won't. Rejected.
- **Option 3 (self-extracting exe or MSI)** — breaks the portable-app
  positioning, requires code-signing to avoid SmartScreen warnings.
  Rejected.
- **Option 4 (version-free filename + VERSION.txt marker inside)** —
  marker file has to be updated by the in-place updater to stay
  truthful, or it lies. Not worth the maintenance cost when the app's
  About view already shows the version.

## Favicon — tab icon shows document + chevron mark (v1.0.3 — SHIPPED)

**Filed:** 2026-09-07
**Target release:** v1.0.3 (alongside Backup & Restore)
**Status:** implemented on main, uncommitted release, awaiting v1.0.3 build
**Ask:** Browser tab was still showing an old / wrong icon (user described
it as "the old stacked hard drive symbol").

### Root cause

`client/public/favicon.ico` contained only the two blue chevrons on a navy
background — the document card that appears in `favicon.svg`,
`favicon.png`, and `apple-touch-icon.png` was missing from every `.ico`
frame (16, 24, 32, 48). Compounded by browsers aggressively caching
favicons on `localhost:5000`, so users could keep seeing a pre-AdvisePoint
icon even after we swapped assets.

### What shipped (staged for v1.0.3)

1. Regenerated `client/public/favicon.ico` from `favicon.svg` at five
   sizes (16, 24, 32, 48, 64), so every frame is the full document +
   chevron mark matching the other favicon assets. Generated with
   ImageMagick: `magick -background none -density 300 favicon.svg
   -resize NxN -gravity center -extent NxN PNG32:frame-N.png` per size,
   then `magick frame-*.png favicon.ico`.
2. Added a `?v=1.0.3` query string to every favicon `<link>` in
   `client/index.html` so browsers stop serving whatever they've cached
   for the app origin.

### Convention going forward

Bump the `?v=X.Y.Z` query string in `client/index.html` whenever *any*
favicon asset changes, so existing installs pick up the new icon after
an in-place update. The version tag doesn't have to match the app
version — it just has to change.

## Extended build smoke test — exercise Backup export endpoint (post-v1.0.3.1 — PLANNED)

**Filed:** 2026-09-08
**Target release:** v1.0.4 or opportunistic
**Status:** planned. Follow-on to the v1.0.3.1 launch smoke test.
**Ask:** The v1.0.3.1 build smoke test spawns the built server and confirms
it binds to a port. That catches the class of bug that hit v1.0.3 (a new
server dep missing from the esbuild allowlist crashes at module-load
time with MODULE_NOT_FOUND). It does NOT catch a runtime-loaded-but-broken
dep — e.g. `archiver` bundled successfully but throwing when `create()` is
called, or a native module that loads but crashes on first query.

**Deliverable:** Extend the smoke test in `script/build.ts` so that after
confirming the server bound to a port, it also:

1. Hits `POST /api/backup/export` on the ephemeral port and confirms a
   valid zip stream is returned (readable ZIP magic bytes `PK\x03\x04`,
   non-zero content-length).
2. Hits `GET /api/backup/settings` and confirms the JSON round-trips.
3. Hits `GET /api/documents` or another read-only endpoint that exercises
   `better-sqlite3` to prove the native module loaded correctly.

Each check has a short timeout; any failure aborts the build with the
endpoint's response body logged for post-mortem. Adds ~3–5s to build time,
worth it as a hard release gate.

**Notes:**
- Use `node --experimental-fetch` (built in on Node 20) so no new dep is
  needed.
- The smoke server writes to a fresh temp dir with `RAG_NO_SEED=1`, so
  documents will be empty — the /api/documents check should assert
  status 200 with an empty array, not that a specific document exists.
- Keep the smoke test skippable via `SKIP_SMOKE=1` env var for debugging
  edge cases in CI.

## Renderer — per-page timeout, abort, and queue continuation (v1.0.4 — PLANNED)

**Filed:** 2026-09-08
**Target release:** v1.0.4
**Status:** planned. Reliability fix. Server-side, no client changes
required (existing PageViewer already handles `status: "error"`).

### Problem

The page renderer has no timeout on any individual pdfjs operation.
When a single page hangs during render — malformed PDF stream, bad
embedded font, JPX decoder livelock, corrupted content stream, etc.
— the entire render pipeline blocks forever on that page and every
subsequent document in the queue is starved.

Current failure mode:

- `_renderQueue` in `server/pages.ts:124` runs at concurrency 1.
- `page.render({...}).promise` at line 261 has no timeout wrapper.
- `doc.getPage(n)` at line 251 has no timeout wrapper.
- If pdfjs spins inside its own pipeline (not throwing), the
  outer `.catch()` at line 133 never fires and the job never ends.
- Every subsequent doc sits in the queue as `status: "pending"`
  indefinitely.

User-visible symptom (from a v1.0.3.1 field report):

> "After several minutes, the renderer is still processing page one
> and does not seem to be able to finish it."

(Note: that report turned out to be the DOCX non-render bug — see
the two entries below — but the underlying concern is real for actual
render hangs on PDFs.)

### Fix

Wrap every pdfjs call that can block in a timeout race, treat the
timeout as a soft page failure, and let the outer job survive so the
queue continues to the next document.

#### Timeouts

Three distinct timeouts, all configurable via env var with sane
defaults:

| Env var | Default | Applies to |
| --- | --- | --- |
| `RAG_RENDER_PAGE_TIMEOUT_MS` | `120_000` (2 min) | Per-page render (`page.render(...).promise`) |
| `RAG_RENDER_GETPAGE_TIMEOUT_MS` | `30_000` (30 sec) | `doc.getPage(n)` |
| `RAG_RENDER_LOAD_TIMEOUT_MS` | `60_000` (1 min) | `pdfjs.getDocument(...).promise` (initial load) |

Rationale for 2-minute per-page default: v0.9.21's 240 DPI × 3.33x
scale WebP q88 render is roughly 1–5 seconds per page on modest
hardware. A 2-minute ceiling gives headroom for a legitimately-slow
page (dense scanned image, complex vector art) while catching
hard hangs in a reasonable window. Users can raise it via env var
if they routinely process very large slides.

#### Implementation — `withTimeout` helper

Add a small helper at the top of `server/pages.ts`:

```ts
class RenderTimeoutError extends Error {
  constructor(op: string, ms: number) {
    super(`${op} exceeded ${ms}ms`);
    this.name = "RenderTimeoutError";
  }
}

function withTimeout<T>(op: string, ms: number, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new RenderTimeoutError(op, ms)), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
```

#### Wrap the three call sites

In `renderInBackground()`:

1. `pdfjs.getDocument(...).promise` → `withTimeout("pdf load", loadMs, ...)`
2. `doc.getPage(n)` → `withTimeout("getPage " + n, getPageMs, ...)`
3. `page.render({...}).promise` → `withTimeout("render page " + n, pageMs, ...)`

#### Per-page error handling

The existing loop already has a per-page `try/finally` for cleanup.
Wrap it in `try/catch` so a single-page failure doesn't abort the
whole doc:

```ts
for (let n = 1; n <= total; n++) {
  let page: any | null = null;
  try {
    page = await withTimeout(`getPage ${n}`, getPageMs, doc.getPage(n));
    // ... existing render logic ...
    await withTimeout(`render page ${n}`, pageMs, page.render({...}).promise);
    // ... existing writeFileSync + storage.upsertPage ...
    rendered++;
  } catch (pageErr) {
    // Log but don't kill the whole doc. Individual page failure is
    // recoverable; other pages may still render fine.
    console.error(`[pages] page ${n} of ${document_id} failed:`, pageErr);
    // Track failed pages so we can surface them in status
    failedPages.push({ page_number: n, error: String(pageErr.message ?? pageErr) });
  } finally {
    try { page?.cleanup?.(); } catch { /* ignore */ }
  }
  // ... existing progress update + setImmediate yield ...
}
```

#### Whole-document abort threshold

If `failedPages.length` exceeds a fraction of `total` (say, > 25%),
treat the document as broken and mark it `status: "error"` with the
first failure as the primary cause. Otherwise mark it `"ready"` with
a `partial: true` flag and let the user see the pages that did work.

```ts
const failureRate = failedPages.length / total;
if (failureRate > 0.25) {
  storage.upsertRenderStatus({
    document_id, status: "error", rendered, total,
    error: `${failedPages.length} of ${total} pages failed. First: ${failedPages[0].error}`,
    updated_at: new Date().toISOString(),
  });
} else {
  storage.upsertRenderStatus({
    document_id, status: "ready", rendered, total,
    error: failedPages.length > 0
      ? `${failedPages.length} pages failed to render (partial)`
      : null,
    updated_at: new Date().toISOString(),
  });
}
```

#### Queue-level: abort the current job if it exceeds an absolute wall clock

Defense-in-depth: even with per-page timeouts, a doc with 10,000
pages could occupy the queue for hours. Add a whole-job wall clock:

| Env var | Default | Applies to |
| --- | --- | --- |
| `RAG_RENDER_JOB_TIMEOUT_MS` | `1_800_000` (30 min) | Whole-document render |

If the outer `renderInBackground()` promise doesn't resolve within
this window, `_drainRenderQueue` should abandon it, mark the doc
`status: "error"` with `"job exceeded 30-minute render budget"`, and
advance to the next queue entry.

Note: this requires structuring the race at the queue-drainer level,
not inside `renderInBackground`, since a truly-hung inner promise
can't be cancelled from within its own scope. pdfjs doesn't offer a
cancellation API for in-flight `render()` calls, so "abandon" here
means stop awaiting the promise and let the pdfjs worker be GC'd
with the doc reference. There is a small memory-leak risk if pdfjs
is genuinely wedged in native code; document this in the code
comment. Acceptable tradeoff versus a permanently-frozen queue.

### User notification — REQUIREMENT: document must be named

**Every failure signal to the user MUST include the failing
document's title** (or filename as fallback). "A document failed to
render" without saying which one is not acceptable — in a
multi-document upload the whole point is knowing which file to re-
upload, fix, or investigate.

Existing PageViewer already handles `status: "error"` inside the
viewer for a single doc (see `client/src/components/PageViewer.tsx:
591-593`), and the dialog header already shows the doc title — so
the single-doc-in-viewer case is covered.

**Multi-document upload case (the one that matters):**

Add a toast notification from the Upload page when any document in
the recent upload batch transitions to `status: "error"` while
rendering. The toast MUST include:

1. **Document title first**, followed by filename in parentheses if
   different from the title. Example:
   > "Render failed: KEY-OP-TRAINING Guide 5012
   > (KEY-OP-TRAINING_Guide_5012.pdf) — page 47 timed out after 2
   > minutes. Other documents in the batch continued."
2. **The specific failure reason** from the server's `error` field
   (page N timeout, malformed stream, etc.) — not just a generic
   "render failed."
3. **A hint that the batch continued** if there were other docs in
   the queue, so users know it's isolated to this file.

Implementation notes:

- Poll `/api/documents/:id/pages/status` for each recently-uploaded
  doc for ~5 minutes post-upload (or until it reaches `ready` /
  `error`), then fire the toast on transition to `error`.
- To get the title, either enrich the status endpoint response with
  the doc title, or the client can look it up from its already-
  cached `/api/documents` list keyed by `document_id`.
- Reuse the existing shadcn `Toaster` component. Use
  `variant: "destructive"` so failures visually stand out.
- Keep the toast persistent (no auto-dismiss) until the user
  dismisses it — render failures happen in the background and users
  shouldn't miss them because the toast timed out.

**Header render-status indicator interaction:**

The separate v1.0.4 Header render-status indicator entry also needs
to surface failed docs by name. When any doc in the recent queue
has `status: "error"`, the indicator should switch from spinner to
a red alert glyph, and its hover tooltip MUST list each failed doc
by title:

```
Render errors (2)
  • KEY-OP-TRAINING Guide 5012 — page 47 timed out
  • Copier Service Manual A3 — pdf load exceeded 60s
Hover to open Library for details.
```

The toast (user just uploaded) and header indicator (persistent
visible signal for later reference) are complementary, not
redundant.

### Server-side change needed to make this work

The current `document_render_status` schema tracks the failure
reason (`error` column) but not the failing page number in a
structured way. The recommendation is to keep `error` as a
human-readable string but ALSO record structured detail:

```ts
interface RenderStatus {
  document_id: string;
  status: "pending" | "rendering" | "ready" | "error" | "missing";
  rendered: number;
  total: number;
  error: string | null;
  // NEW in v1.0.4:
  failed_pages: number[] | null;  // for partial failures
  first_failed_page: number | null;
  updated_at: string;
}
```

The title is already reachable via the `documents` table row — no
schema change needed there — but the client should look it up and
include it in every user-visible message per the requirement above.

### Edge cases

- **Timeout race leaks pdfjs page reference.** The `page?.cleanup?.()`
  in the `finally` block still runs even if we timed out awaiting
  the render promise. pdfjs's cleanup is idempotent and safe on a
  partially-rendered page.
- **Whole-doc abandon leaks the pdfjs Document reference.** The
  `doc.cleanup()` and `doc.destroy()` at the end of
  `renderInBackground` won't run because the abandon happens above.
  Acceptable; the doc object becomes GC-eligible once the job
  reference drops.
- **Env-var misconfiguration.** If a user sets a timeout to `0` or
  negative, clamp to a sensible minimum (say, 1000 ms) with a
  console warning. Setting timeouts too low would make legitimately
  slow pages fail spuriously.
- **Concurrency changes.** If we ever raise queue concurrency
  above 1 (currently pinned to 1 because pdfjs pins CPU), the
  timeout logic still works but the toast "stuck on document X"
  wording needs revisiting.
- **Retry on failure.** Out of scope for this entry. If a user wants
  to retry a failed doc, they re-upload it. Future enhancement: an
  admin button to re-queue.

### Testing

- Unit-test `withTimeout` — resolves normally, rejects on timeout,
  cleans up the timer either way.
- Integration: build a mock pdfjs page that returns a never-
  resolving promise; confirm the per-page timeout fires and the
  overall doc completes with `status: "error"` and the correct
  message.
- Integration: mock one hung page in a 20-page doc; confirm 19
  pages render, doc ends `status: "ready"` with `error: "1 pages
  failed to render (partial)"` and pages 1–19 (skipping the hung
  one) are viewable.
- Integration: mock a hung page in doc 1 of a 3-doc batch; confirm
  doc 1 fails, doc 2 and doc 3 render normally.
- Manual: find a real hang-inducing PDF (if we have one in seed
  data or the field reports) and confirm behavior end-to-end.

### Effort estimate

~3 hours:

- ~30 min: `withTimeout` helper + env var wiring
- ~1h: per-page try/catch + failure bookkeeping + partial status
- ~1h: queue-level abandon logic
- ~30 min: testing + edge cases

User notification (~1h) additional if we go with the standalone
toast approach. Free if we defer to the Header render-status
indicator entry.

### Provenance

User request 2026-09-08: "if the renderer hangs, it has the ability
to abort and notify the user. Say if a document is 100 pages and
the renderer progresses through each page, it takes time but each
page is moving along. However, if a page stalls at render, it should
time out after several minutes so it does not hang up forever...
reject the one document and move to the next one and notify the
user." Confirmed by direct code inspection: no timeout wrappers on
any pdfjs call in `server/pages.ts` today.

## PageViewer — false "still rendering" spinner on non-PDF documents (v1.0.4 — PLANNED)

**Filed:** 2026-09-08
**Target release:** v1.0.4
**Status:** planned. Small client-only bug fix. UI-only, no server change.
**Bug:** Clicking "View original pages" on a DOCX (or TXT/MD) document
shows a permanent "Page 1 is still rendering..." spinner in the viewer
body, even though the tab header correctly reports "No page images
available for this document." The spinner will spin forever because
non-PDF documents deliberately never enter the page renderer.

### Root cause

`server/routes.ts:604` guards `if (extracted.format === "pdf")` before
calling `scheduleRender`. DOCX / TXT / MD uploads never register a
render job at all, so `GET /api/documents/:id/pages/status` returns
`{status: "missing", rendered: 0, total: 0}` forever.

`client/src/components/PageViewer.tsx:685-694` has a fallback branch
that renders when `currentPageRendered` is false:

```tsx
<div className="mt-16 text-center text-sm text-muted-foreground max-w-md">
  <Loader2 className="h-5 w-5 animate-spin mx-auto mb-3" />
  <div>Page {pageNumber} is still rendering.</div>
  {status && (
    <div className="mt-1 text-xs">
      {status.rendered} of {status.total} pages ready - this page
      will appear as soon as it's finished.
    </div>
  )}
</div>
```

It does not check for `status?.status === "missing"` before falling
into this branch, so DOCX viewers get "Page 1 is still rendering /
0 of 0 pages ready" indefinitely. The tab header at
`PageViewer.tsx:594-596` correctly handles `"missing"` — the body
does not.

### Fix

In the fallback branch, split the not-rendered case by status:

- `status?.status === "missing"` → show a friendly "no page images for
  this document" message. Reason: this document type doesn't produce
  page images. Suggest using the document text or the Query tab.
- `status?.status === "error"` → show the render error (existing
  header already does this; body can either mirror or defer to it).
- Otherwise (rendering in progress but this specific page not ready)
  → keep the existing "Page N is still rendering" spinner as-is.

Suggested "missing" body copy:
> This document has no rendered page images. DOCX, TXT, and Markdown
> files are searchable via the Query tab and readable via the
> document detail view, but don't produce visual page renders.

### Related concern — should "View original pages" even show for non-PDFs?

Currently `library.tsx:1328` renders the button unconditionally. Two
options:

1. **Hide the button entirely** for non-PDF documents. Cleanest.
   Slight risk: if we later ship the DOCX viewer (separate backlog
   entry), we'd need to unhide it.
2. **Keep the button, fix the body copy** so it explains why there
   are no page images. Zero surprise if the DOCX viewer arrives
   later — the button already exists, its behavior just improves.

**Recommendation:** Option 2. The button is a natural entry point for
the DOCX viewer feature; hiding it now just means adding it back
later. The body-copy fix already makes it not-broken.

### Testing

- Upload the sample DOCX (KEY-OP-TRAINING_Guide_5012.docx or any
  other DOCX). Click "View original pages" on the document. Confirm:
  - No spinning loader
  - No "Page 1 is still rendering" text
  - Friendly "no page images" message visible
  - Header still says "No page images available for this document."
- Same for a .txt and a .md upload.
- Upload a PDF. Confirm existing behavior unchanged:
  - Spinner + "Page N is still rendering / 0 of 5 pages ready"
    appears briefly, then real page images replace it as they finish.
- Upload a PDF that fails to render (corrupt or password-protected).
  Confirm existing error handling still works.

### Effort estimate

~30 minutes. ~10 lines of TSX plus one Playwright test if we want
regression coverage.

### Provenance

Reproduced end-to-end in the sandbox against a live v1.0.3.1 build:
upload returned HTTP 200 in 850 ms with 9 chunks / 24,876 tokens
extracted; `pages/status` returned `"missing"` immediately and stayed
that way — exactly matching the reported symptom.

## DOCX viewer — render extracted content in the PageViewer dialog (v1.0.5 — PLANNED)

**Filed:** 2026-09-08
**Target release:** v1.0.5 (deferred from v1.0.4 on 2026-09-08 for scope + credit budget)
**Status:** planned. New feature. Complements the PageViewer fix
above.

**Ask:** DOCX uploads extract cleanly (mammoth → markdown, ~200ms for
the test file) but users have no way to *see* the document — only its
chunks and search results. Give the "View original pages" button on a
DOCX something meaningful to open: an in-app viewer that renders the
mammoth-extracted content in a readable layout, with the same
navigation and search affordances as the PDF page viewer.

### Approach — render extracted HTML/markdown, not fake page images

We already have the fully-extracted document text (mammoth's markdown
output) sitting in the database. Rendering it as HTML in the existing
PageViewer dialog gets us 80% of the value at 10% of the cost of a
real page-image pipeline.

**Rejected alternatives (documented so they don't come back):**

1. **LibreOffice headless (`soffice --headless --convert-to pdf`)**
   — produces faithful page images by piggybacking on the existing
   pdfjs pipeline. Adds ~150 MB to the portable zip. Overkill for
   the user problem ("let me see the DOCX"), and blows our
   portable-download budget.
2. **DOCX → HTML → wkhtmltopdf / puppeteer** — smaller install than
   LibreOffice but page layout drifts noticeably from Word, and we
   inherit puppeteer's Chromium download (~120 MB). Same objection.

### Implementation

#### Server — expose extracted content

`documents` table already stores the extracted text (`body` column,
via `ingestParsed`). Options:

1. **Reuse `body`** if it's the mammoth markdown output verbatim.
2. **Extend extract-worker** to return both markdown (for chunking)
   and HTML (for viewing) in one pass. Mammoth has
   `convertToHtml({buffer})` alongside `convertToMarkdown`. Add
   `extracted.html` to the payload, store in a new column or a
   sidecar file next to the extracted text.

Option 2 gives cleaner viewer output (headings, lists, tables
preserved as real HTML). Option 1 works but forces the client to
re-parse markdown → HTML on open. Recommend option 2.

New endpoint:

```
GET /api/documents/:id/content
→ { format: "docx"|"text"|"markdown", html: "<...>" }
```

Returns 404 for PDFs (they use the page-image endpoints).

#### Client — PageViewer content mode

Extend PageViewer with a second display mode:

- **Page-image mode** (current): PDFs. Renders JPG/WebP images from
  `/pages/N.jpg`.
- **Content mode** (new): DOCX / TXT / MD. Fetches HTML from
  `/content` and renders it in a scrollable pane inside the same
  dialog frame.

Selector: based on `document.file_name` extension or a new
`document.viewer_mode` field.

Content-mode viewer:

- Same dialog chrome (header, close button, keyboard shortcuts)
- Sanitize the HTML (DOMPurify) — mammoth output is generally clean
  but we should not skip this
- Preserve mammoth's image embeds (mammoth inlines them as base64
  by default) so screenshots in the DOCX show up
- Reuse the existing Ctrl+F search panel if possible — it currently
  operates on page images (OCR text?); may need to switch to DOM
  text search in content mode
- Zoom via browser default (Ctrl+scroll on the pane) rather than the
  page-viewer's custom zoom — HTML content doesn't need the pixel-
  perfect zoom the page images do

#### Existing PageViewer plumbing to preserve

- Dialog open/close animation
- URL/state persistence via `pageViewerStart` and `docSearchQuery`
- The "View original pages" button in `library.tsx:1328` — no change
  needed; it opens the same dialog, which now branches internally

### Edge cases

- **DOCX with embedded images.** Mammoth inlines them as data URIs
  by default — verify sizes stay reasonable (large embedded images
  could balloon the response payload; consider streaming or
  extracting to `/pages/` sidecar files if this is a problem).
- **DOCX with unsupported content** (equations, complex tables,
  SmartArt). Mammoth already logs warnings via its `messages` array
  — surface a subtle "Some formatting may not display correctly"
  note when `messages.length > 0`.
- **TXT / MD files.** Same viewer, different transform: TXT wraps in
  `<pre>`, MD renders through a markdown-to-HTML pass (already have
  a markdown renderer in the codebase from chunk display).
- **Very long documents.** DOCX/MD/TXT can be 500k+ chars.
  Virtualize the content pane if scroll performance suffers.

### Interaction with the PageViewer fix above

Both ship in v1.0.4. Order of implementation:

1. Land the PageViewer fix first (~30 min) so any interim build has
   a clean fallback if the DOCX viewer isn't wired up yet.
2. Land the DOCX viewer, which replaces that fallback with the real
   content viewer.

The fix is intentionally self-contained so the DOCX viewer PR can
lean on it (the mode switcher just extends the same conditional
tree) without a merge conflict.

### Testing

- Upload the test DOCX (KEY-OP-TRAINING_Guide_5012.docx). Click
  "View original pages." Confirm the extracted content renders as
  formatted HTML with headings, lists, tables, and any embedded
  images.
- Upload a DOCX with an embedded image. Confirm the image appears
  inline.
- Upload a large DOCX (500+ pages of text). Confirm the viewer
  opens promptly and scrolling stays smooth.
- Upload a .md file. Confirm markdown renders (headings, links,
  code blocks).
- Upload a .txt file. Confirm plain-text display in monospace
  wrapping.
- Upload a PDF. Confirm the page-image viewer still works exactly
  as before — no regression from the mode switcher.
- Ctrl+F inside a DOCX viewer — confirm text search works against
  the rendered HTML.

### Effort estimate

~1 full day:

- ~2h: server — extract-worker HTML output + new endpoint + tests
- ~4h: client — PageViewer mode switcher, content pane component,
  HTML sanitization, image handling, keyboard shortcut integration
- ~1h: markdown / TXT handling
- ~1h: visual polish, edge cases, Playwright coverage

### Provenance

Same reproduction as the PageViewer fix above. Mammoth extracts the
full 4-page DOCX to 747 KB of markdown in ~200 ms, so the data we
need to render is already sitting there ready to use.

## Header — background rendering activity indicator (v1.0.4 — PLANNED)

**Filed:** 2026-09-08
**Target release:** v1.0.4
**Status:** planned. Small header-bar addition.
**Ask:** When uploading multiple manuals, page rendering (PDF → image
extraction + OCR / text extraction on worker threads) can take a while
to complete after the upload confirmation returns. Users have no visible
signal that background work is in progress — or how much is left. Add
a quiet activity indicator to the main page top row that only appears
while rendering is active, and reveals real-time progress on hover.

### Behavior

1. **Placement:** Header/top row, positioned between the Query search
   box and the stats counter (documents / pages count). Sized to match
   the visual weight of the existing header icons, not larger.

2. **Idle state:** Nothing rendered. Zero footprint when no work is
   happening — header layout is unchanged from today.

3. **Active state:** Animated circular arrow (Lucide `Loader2` or
   `RefreshCw` with a `animate-spin` Tailwind class). Uses
   `text-muted-foreground` so it doesn't compete for attention with the
   Query field or primary CTAs.

4. **Hover state (tooltip):** Show real-time status:
   ```
   Rendering pages
   Document: Acme Copier Service Manual
   Page 47 of 312
   3 documents queued
   ```
   Update the tooltip content live while it's open (not just at open
   time). Uses the existing shadcn `Tooltip` component pattern.

5. **Transition to idle:** When the last queued page finishes, wait
   ~2 seconds then fade out (so a fast single-page render still shows
   a brief signal). No completion toast — the indicator disappearing
   IS the signal.

6. **Failure state (new, tied to the renderer timeout entry):** If
   any document in the recent render batch reached `status: "error"`,
   the indicator switches from the muted spinner to a red alert
   glyph (Lucide `AlertCircle` with `text-destructive`). The
   indicator STAYS VISIBLE in this state until the user dismisses
   it (click to acknowledge), even after all rendering completes —
   the disappearing-glyph rule only applies to clean completions.

   Hover tooltip in failure state MUST list each failed document by
   title, one line per failure, with the specific failure reason:
   ```
   Render errors (2)
     • KEY-OP-TRAINING Guide 5012 — page 47 timed out
     • Copier Service Manual A3 — pdf load exceeded 60s
   Click to dismiss. Open Library for full details.
   ```

   Naming the document is a hard requirement, not a nice-to-have.
   The whole point of this signal is knowing which file to re-
   upload or investigate.

### Implementation

#### Server — new endpoint `GET /api/render/status`

Returns JSON:
```json
{
  "active": true,
  "recent_failures": [
    {
      "document_id": "...",
      "title": "KEY-OP-TRAINING Guide 5012",
      "file_name": "KEY-OP-TRAINING_Guide_5012.pdf",
      "error": "page 47 timed out after 120000ms",
      "failed_at": "2026-09-08T13:47:00Z"
    }
  ],
  "current_document": {
    "id": "...",
    "title": "Acme Copier Service Manual",
    "pages_done": 47,
    "pages_total": 312
  },
  "queued_document_count": 3,
  "queued_page_count": 848
}
```

When no rendering work is active, returns `{"active": false}`.

Render queue state is already tracked internally by `server/extract.ts`
/ `server/workers/*` — the worker-thread manager knows what's in
flight. This endpoint just exposes a snapshot of it. If no central
queue struct exists today, add one in extract.ts and update it in the
worker lifecycle callbacks (spawn / progress / done).

#### Client — header component

1. **New component `RenderStatusIndicator.tsx`** (or add to existing
   header component if one exists). Uses SWR / react-query with a
   polling interval of:
   - **2 seconds** while `active: true`
   - **10 seconds** while `active: false` (so a new upload lights it
     up within 10s without hammering the endpoint)

2. **Tooltip trigger:** shadcn `Tooltip` wrapping the spinner icon.
   Content re-renders on each poll while open.

3. **Fade-out on transition to idle:** ~2s delay + Tailwind
   `transition-opacity` for the fade. Use a small `useEffect` with
   `setTimeout` cleanup so a rapid off→on flip cancels the fade.

#### Existing extract/render pipeline

Audit `server/extract.ts`, `server/workers/pdf-worker.ts` (and any
sibling workers) for existing progress bookkeeping. Likely candidates:
any existing `_activeExtractions` map, per-document progress counters,
or the `documents` table's status column. Reuse whatever's there
instead of introducing a parallel counter.

### Edge cases

- **Upload finishes fast, no work queued.** Indicator never appears —
  correct. The 10s idle poll interval means a fast render might
  finish before the client learns it started, which is fine.
- **Multiple documents in flight.** "Current document" is the one
  the primary worker is on right now; "queued_document_count" covers
  the rest. If we have N parallel workers, show the highest-progress
  one in the tooltip primary line to give a sense of "almost done
  with this batch."
- **Server restart mid-render.** After restart, the render queue is
  empty (worker threads don't persist), so indicator will correctly
  report idle even if there were pages queued before the restart.
  Note in the tooltip? Probably not — restarts are rare and users
  can check document status individually if needed.
- **Failed render.** Don't surface errors in the header indicator —
  it's a status glyph, not an error UI. Existing per-document error
  handling continues to run as-is.
- **Very long queue.** Truncate the document title in the tooltip if
  > 60 chars.

### Testing

- Upload one small document — confirm spinner appears briefly and
  fades out cleanly.
- Upload 5 large PDFs at once — confirm spinner stays on for the
  full batch, tooltip cycles through documents, queued count
  decreases live.
- Hover over spinner while a long render is happening — confirm
  tooltip content updates live (not stuck on the value at hover
  start).
- Confirm header layout is byte-identical to today when no
  rendering is active (no reserved space, no phantom padding).
- Confirm the 2s poll interval doesn't produce visible layout jitter
  in the tooltip.

### Effort estimate

~3–4 hours:

- ~1h: server endpoint + progress bookkeeping (depends on how much
  of it already exists in extract.ts)
- ~1h: client component + tooltip + polling logic
- ~1h: fade transition + edge-case polish
- ~30min: visual QA on the header at various viewport widths

### Related / follow-on ideas (not for v1.0.4)

- **Click the spinner to open a full render-queue panel** with per-
  document progress bars. Overkill for v1.0.4; the tooltip is enough.
- **System tray notification when a large batch completes.** Would
  compose with the tray-icon idea if we ever add one.

## Backup Settings — show current backup size for storage planning (v1.0.4 — PLANNED)

**Filed:** 2026-09-08
**Target release:** v1.0.4
**Status:** planned. Small UX addition to the existing Backup card.
**Ask:** Users configuring scheduled backups have no visibility into
how much disk space each backup will consume, so they can't decide
intelligently between retention counts or plan for external storage.
Surface the current expected backup size directly in the Backup card so
the retention setting becomes an informed choice ("3 backups × 250 MB
= 750 MB").

### What to show

**"Current backup size: ~<size>"** — the expected size of a backup
taken right now, computed as: SQLite DB file size + total bytes under
the `pages/` directory + a small ZIP overhead estimate (~1–2%). Format
as human-readable (KB / MB / GB) with one decimal.

Example rendering:
```
Current backup size: ~487 MB
```

Optional secondary line if space allows:
```
Retention: 3 backups (~1.4 GB total at current size)
```

### Where to put it in the UI

Two reasonable placements in `BackupPanel.tsx`:

1. **Below the retention row, right-aligned or full-width
   muted-foreground note.** Cleanest — doesn't fight for space with
   the retention input.
2. **To the right of the retention number input.** Compact but tight;
   the retention row already carries a label + input + unit text
   ("backups"), so a size projection might crowd it on narrower Settings
   panels.

Recommend option 1 (below retention row, muted text) as the primary
layout, with the multiplied total on a second muted line only when
retention > 1. Matches the current shadcn spacing pattern used in
LibraryScanPanel and DiagnosticsPanel.

### Implementation

1. **Server:** Extend `GET /api/backup/settings` response with two new
   fields:
   - `current_backup_size_bytes: number` — sum of `statSync(DB_FILE_PATH).size`
     + recursive size of `getPagesDirForBackup()`.
   - `current_backup_size_estimate_bytes: number` — raw size + 2% ZIP
     overhead estimate (the store is mostly PDFs and SQLite pages,
     both of which compress ~2–5%; use 2% as a conservative floor so
     the shown estimate is never smaller than the actual backup).

   Compute lazily on each request; a full walk of the pages dir for
   the typical corpus (~500 MB) is fast (<50ms) and this endpoint is
   only hit when the Backup card is visible.

2. **Client (`BackupPanel.tsx`):** Add a `<p className="text-xs
   text-muted-foreground">` line under the retention row displaying
   "Current backup size: ~{human-readable}". When retention > 1, add
   a second line "{retention} backups × ~{size} = ~{total}". Poll
   this alongside the existing 30s settings refresh — no separate
   endpoint call needed.

3. **Format helper:** Reuse or add a `formatBytes(bytes: number,
   decimals = 1)` helper. If one already exists elsewhere in the
   client (check `client/src/lib/utils.ts`), reuse it.

### Edge cases

- **Empty library.** DB is ~40KB, pages/ is empty → shows
  "Current backup size: ~40 KB" — fine, informative.
- **Very large corpus.** Multi-GB pages/ dir. The recursive stat walk
  should still complete well under 500ms on SSD; if benchmarks show
  it slower on spinning disk, cache the value for 60s server-side.
- **Retention count edit in real time.** The multiplied "total" line
  should update live from the input's current value, not wait for a
  Save.
- **Actual backup size will vary.** ZIP compression on PDFs is
  minimal but not zero; the estimate is deliberately conservative
  (higher than actual). Add a subtle "~" prefix and treat this as a
  planning aid, not a precise measurement.

### Testing

- Freshly-installed empty install — confirm sensible small size.
- Install with a realistic corpus (500–1000 documents) — confirm
  size number matches within ±5% of an actual backup taken via the
  manual export button.
- Retention change from 1 → 5 — confirm the multiplied total
  updates without needing a Save click.

### Effort estimate

~1–2 hours: ~20 lines server + ~15 lines client + one round of
visual QA on the Settings panel.

## Render event-loop stalls — raise reconnect threshold and add micro-yields (v1.0.5 — PLANNED)

**Filed:** 2026-09-08
**Target release:** v1.0.5
**Status:** planned. Second implementation priority in v1.0.5
(cheap reliability fix, ~15 lines of code, no packaging risk).

**Ask:** After the v1.0.4 upgrade, a field report of the app tab
suddenly losing connection to the server while the tab was otherwise
idle, then trying to reconnect but failing. Investigation traced this
to pdfjs rendering blocking Node's single-threaded event loop for long
enough to trip the client-side reconnect threshold.

### Diagnosis

**Not a v1.0.4 regression per se.** The idle-shutdown timer
(`server/index.ts` lines 115–135) and client heartbeat interval
(`client/src/lib/heartbeat.ts`) are byte-identical between v0.9.35 and
v1.0.4. The 10-minute idle shutdown from v0.9.28 is still in place
and is not what's firing.

**Root cause:** In `server/pages.ts` (`renderInBackground`) pdfjs is
initialized with `disableWorker: true`, forcing all PDF parsing +
page rasterization onto the main Node event loop. The existing
`await new Promise((r) => setImmediate(r))` yield at line 441 does
give the event loop a tick BETWEEN pages, so steady-state rendering
is mostly fine. The remaining exposure is:

1. **Long uninterrupted burst inside a single `page.render()` call.**
   pdfjs can spend multiple seconds inside one page render (JP2
   decode, heavy vector paths). No yield opportunity mid-render —
   pdfjs owns the microtask queue during that time.
2. **Synchronous `canvas.toBuffer("image/webp", 88)` at line 388.**
   `@napi-rs/canvas` encodes WebP in-thread. For a 2400×3200 px page
   this is 100–400 ms of pure blocking on top of whatever pdfjs just
   did.
3. **Abandoned pdfjs promises after `withTimeout` fires** (v1.0.4-added).
   `Promise.race` moves on but pdfjs has no cancellation API, so the
   losing promise's CPU work keeps burning until it finishes naturally.
4. **Client-side threshold too tight.** `BackendDownOverlay.tsx` has
   `RECONNECT_THRESHOLD = 1`, so a SINGLE failed 2-second poll (with
   a 3.5-second abort) is enough to flash the amber banner. Any
   single-page render >~3.5 s trips it.

**Why v1.0.4 makes it slightly worse:** the new per-page + whole-doc
timeouts and queue continuation on failure mean more back-to-back
render activity on startup for large libraries, extending the total
window of exposure. Not the root cause.

**Secondary contributors (same failure mode, out of scope):**

- `server/rag.ts` search runs TF-IDF cosine similarity inline in the
  request handler.
- `better-sqlite3` is synchronous by design.
- Both are individually cheap today; will become a problem as
  libraries grow.

### Fix scope for v1.0.5

**Cheap and boring — 3 tiny code changes, no architecture work.**
The full worker_threads refactor was considered and deferred to
v1.0.6 (see below) because it introduces meaningful packaging risk
(new CJS to ship, `@napi-rs/canvas` native addon must load inside
worker, `createImageBitmap` polyfill must be re-applied inside
worker's globalThis, per-page transferList vs worker-writes-to-disk
decision) that isn't justified when a much simpler fix removes the
user-visible symptom.

1. **Raise `RECONNECT_THRESHOLD` in `client/src/components/BackendDownOverlay.tsx`
   from 1 to 3.** With the 2s poll interval this means the amber
   banner appears after ~6s of sustained failure (was ~2s). Keep
   `DOWN_THRESHOLD = 7` for the full modal — 14s of sustained
   failure is still correct for detecting a genuinely crashed
   server. A 6s tolerance comfortably covers even the slowest
   single-page render on the target hardware while still surfacing
   a real disconnect quickly.

2. **Add a `setImmediate` yield around `canvas.toBuffer` in
   `server/pages.ts` (~line 388).** Wrap the encode so the event
   loop gets a tick immediately before and after WebP encode. Not a
   silver bullet (pdfjs itself is still the biggest blocker) but
   costs nothing and eliminates the ~100–400 ms encoder-blocking
   window per page.

3. **Lower the per-page render timeout DEFAULT from 120s to 60s** in
   `server/pages.ts`. Shortens the maximum abandoned-promise window
   in the rare timeout path. Still overridable via
   `RAG_RENDER_PAGE_TIMEOUT_MS` for tuning. Legitimate slow renders
   on old hardware were the reason for 120s; 60s is still deep in
   the "something's wrong" tail per the code comment (240 DPI q88 is
   3–30s per page in the wild).

**Non-goals for v1.0.5:**

- Do not refactor pdfjs into a `worker_threads` worker (deferred to
  v1.0.6).
- Do not remove `disableWorker: true` (worker_threads change would
  invalidate the reason it's set).
- Do not move search or SQLite off the main thread.
- Do not lower `DOWN_THRESHOLD`.
- Do not remove the 10-minute idle shutdown.

### Reproduction (for QA)

1. Upload a large PDF known to render slowly (multi-hundred-page
   PowerPoint export with JP2 images). Any doc where per-page render
   exceeds 3.5s is sufficient.
2. Wait for the render queue to pick it up (header render-status
   indicator shows a spinner).
3. On current v1.0.4 code the amber "Reconnecting to the local
   service..." banner flickers whenever a page render exceeds 3.5s.
4. On the fixed v1.0.5 code the banner should not appear unless
   render stalls exceed ~6s.

### Definition of done

- [ ] `RECONNECT_THRESHOLD` in `BackendDownOverlay.tsx` bumped from
      1 to 3
- [ ] `canvas.toBuffer` in `server/pages.ts` wrapped in
      `setImmediate` yields on both sides
- [ ] `RENDER_PAGE_TIMEOUT_MS` default lowered from 120_000 to 60_000
      (env-var override still respected)
- [ ] Comment blocks in both files updated to reference this fix and
      point to the v1.0.6 worker refactor as follow-up
- [ ] Manual test: uploading the PowerPoint-export PDF that surfaced
      the JP2/JPX blank-graphics fix in v0.9.29 no longer triggers
      the amber "reconnecting" banner during render
- [ ] Manual test: forcing `RAG_RENDER_PAGE_TIMEOUT_MS=1` still
      produces the expected failure entries in `/api/render/status`
      (unchanged behavior, just faster default)
- [ ] Existing render-status behavior (per-page progress,
      `first_failed_page`, `failed_pages`, header indicator) is
      preserved unchanged
- [ ] `rg -i kyocera` returns zero hits after this change

**Rough size:** 3 code changes totaling ~15 lines, plus comment
updates. ~30 min work, zero packaging risk, no new dependencies, no
files added to the zip. Test on a large library reload (many docs
queued) and confirm the banner behavior matches expectations.

### Deferred follow-up: worker_threads refactor (v1.0.6 — CANDIDATE)

If field validation of the v1.0.5 fix shows the banner still
appears on truly pathological docs, refactor `server/pages.ts` to
move pdfjs + `@napi-rs/canvas` into a `worker_threads` Worker
following the pattern established in `server/extract.ts`. Worker
owns pdf.getDocument, per-page render, and disk writes; sends only
`{page_number, width, height, image_path}` metadata back to the
main thread (NOT the WebP bytes — avoids per-page postMessage
round-trips and giant transferList payloads). Terminating the
worker on `RENDER_JOB_TIMEOUT_MS` actually cancels CPU work,
unlike the current promise-race abandonment.

Known design risks to sort out before starting:

- `@napi-rs/canvas` is a native N-API addon. Confirmed to work in
  `worker_threads` per docs, but font registry + `loadImage` state
  is per-worker.
- The `createImageBitmap` polyfill at `pages.ts` line ~103 mutates
  `globalThis` and MUST be applied inside the worker's globalThis,
  not the main thread's. Missing this re-breaks the v0.9.29 JP2/JPX
  blank-graphics fix.
- Worker termination mid-page could leave a partial `.webp` file on
  disk. Write to `.webp.tmp` and rename on completion to make
  interrupted jobs cleanable.
- Packaging must include the new worker CJS in the zip under
  `dist/workers/render-worker.cjs` and the CJS must resolve
  `pdfjs-dist` + `@napi-rs/canvas` from `node_modules` at runtime.

Rough size: ~150 lines new render-worker CJS + ~80 lines refactored
`pages.ts` + 3 manual tests. Medium risk. Only pursue if v1.0.5's
cheap fix proves insufficient in field testing.

## Install-location guidance and cloud-sync detection (v1.0.5 — PLANNED)

**Filed:** 2026-09-08
**Target release:** v1.0.5
**Status:** planned. First implementation priority in v1.0.5 (pure
additive, zero interaction with the other three items).

**Ask:** After the v1.0.4 upgrade, a KEY-OP-TRAINING.docx upload silently
failed with browser-side "Failed to fetch" — no `POST /api/upload` ever
reached the server. Root cause was that the user was running the app
from inside a corporate OneDrive-synced folder
(`C:\Users\...\OneDrive - Kyocera Document Solutions America Inc\...\AdvisePoint Docs\`).
OneDrive can mark files as online-only placeholders, apply tenant DLP
rules that block uploads to loopback, or hold file locks during sync —
any of which produces browser `Failed to fetch` errors with no
server-side signal at all. Portable-app design assumes a stable local
working directory; running from inside cloud-sync folders violates that
assumption in ways that are difficult to debug from field reports.

Provide guidance to users about running the app from OneDrive or
similar structures and recommend a root folder setup.

**Scope (all three surfaces — user choice on 2026-09-08):**

1. **README section** — durable "Install location — recommended folder
   setup" section with:
   - The recommended pattern: extract to a root-adjacent folder like
     `C:\AdvisePoint Docs\` or `D:\AdvisePoint Docs\`; do NOT extract
     into OneDrive, Dropbox, Google Drive, iCloud, Box, or any network
     drive path.
   - Explicit "problem folders" list with the exact path patterns the
     app detects (see boot-time detection below).
   - Explanation of why: silent OneDrive placeholder fetch, DLP tenant
     rules, sync-time file locks, network path latency, MOTW
     inheritance from synced files.
   - Recovery instructions if the user already installed inside
     OneDrive: how to close the app, move the folder, and preserve the
     data folder at `%LOCALAPPDATA%\AdvisePoint Docs\` (which is
     unaffected because it's outside the app folder).

2. **Boot-time detection with header banner** — detect problem paths
   at startup, warn once per install location.

   Detection lives in `server/boot.ts` (or a new
   `server/install-location.ts`). On boot, compute the app's own path
   (`process.cwd()` or the `dirname` of the running node bundle) and
   match against known cloud-sync + network path patterns:

   - `\OneDrive` or `\OneDrive - ` anywhere in the path (personal +
     business)
   - `\Dropbox\` or `\Dropbox (`
   - `\Google Drive\` or `\GoogleDrive\`
   - `\iCloudDrive\` or `\iCloud Drive\`
   - `\Box\` or `\Box Sync\`
   - UNC network paths: starts with `\\`
   - Windows mapped drives: heuristic — skip for now to avoid false
     positives; users on genuinely local mapped drives shouldn't
     see the banner.

   Emit a `[boot] warn install_location=cloud_sync provider=<name>
   path=<masked>` log line whenever a match hits so support
   conversations can spot this immediately in server.log.

   Expose the detection result via a new field on `GET /api/health`:
   `install_location: { ok: boolean, provider: string | null,
   masked_path: string }` — masked so the tenant name in
   "OneDrive - <TenantName>" doesn't leak in support pastes.

   Client: new `InstallLocationBanner` component reads that field, only
   shows when `ok=false`, provides a Learn More link to the README
   anchor, and a dismiss button. Dismissal persists in localStorage
   keyed by `installLocationDismissed:<masked_path>` so the banner
   re-alerts if the user moves the app to a different problem folder.

3. **Settings note under backup-folder input** — muted `text-xs`
   line under the backup folder input in `BackupPanel.tsx`: "Tip: keep
   your backup folder outside OneDrive, Dropbox, and other cloud-sync
   locations — file locks during sync can corrupt backups mid-write."
   Do NOT actively detect the folder value here (users legitimately
   backup to sync folders sometimes) — pure informational.

**Non-goals for v1.0.5:**

- Do not block startup when a problem path is detected. Warn only.
  Some users may knowingly accept the risk (e.g. temporary evaluation).
- Do not auto-move the app folder. Too many edge cases; instructions
  in the README are enough.
- Do not warn about the data folder (`%LOCALAPPDATA%`) location —
  it's already outside the app folder by design and outside typical
  cloud-sync patterns.

**False-positive management:**

- Match on path substrings that require a following path separator
  (`\OneDrive\` or `\OneDrive - `), not just "OneDrive" anywhere, so a
  folder literally named `MyOneDriveArchive` doesn't trip it.
- Log the match reason so support can eyeball the path if a false
  positive is reported.

**Definition of done:**

- [ ] README has "Install location — recommended folder setup"
      section with recommended pattern, problem folders list, and
      recovery instructions
- [ ] `GET /api/health` response includes `install_location.ok`,
      `install_location.provider`, `install_location.masked_path`
- [ ] Server logs `[boot] warn install_location=...` line once at
      startup when a problem path is detected
- [ ] Header shows dismissible `InstallLocationBanner` component
      when `install_location.ok=false`; hidden when true
- [ ] Banner "Learn more" link opens README anchor in default browser
- [ ] Banner dismissal persists in localStorage per masked path
- [ ] `BackupPanel.tsx` shows muted tip line under backup-folder input
- [ ] Manual test: run app from `C:\AdvisePoint Docs\` — banner hidden,
      `install_location.ok=true` in health response
- [ ] Manual test: run app from a OneDrive-synced folder — banner
      visible, correct provider detected, log line written, dismiss
      persists across reload
- [ ] Manual test: banner does NOT re-appear on reload after dismiss
      for the same path
- [ ] Manual test: banner DOES re-appear after moving the app folder
      to a different problem location
- [ ] `rg -i kyocera` returns zero hits after this change

**Rough size:** ~40 lines server (detection + health field), ~60 lines
client (banner + Settings note), ~80 lines README. One focused sprint,
test across three scenarios (clean install, OneDrive, Dropbox).

## node.exe Task Manager visibility — Version Resource + icon embed (v1.0.5 — PLANNED)

**Filed:** 2026-09-08
**Target release:** v1.0.5 (deferred from v1.0.4 on 2026-09-08 for scope + credit budget)
**Status:** planned. Option A chosen (rewrite Windows Version Resource,
keep filename `node.exe` so launcher stays untouched).
**Ask:** In Task Manager today the app's Node process shows up as
generic `node.exe` with description "Node.js JavaScript Runtime" and
the Node hexagon icon. Users can't tell which running Node process is
AdvisePoint Docs vs. any other Node app they might have. Rewrite the
bundled `node.exe`'s Windows Version Resource block so Task Manager
shows it as an AdvisePoint Docs process without renaming the file.

### Deliverables

1. **Add `rcedit-linux` (or equivalent cross-platform rcedit wrapper)
   as a devDependency.** MIT-licensed, ~1MB, runs on Linux — needed
   because our packaging runs from a Linux sandbox.

2. **Modify `scripts/package-windows.mjs`** to, after extracting the
   baseline zip and before rezipping, run rcedit on
   `AdvisePoint Docs/node/node.exe` with:
   - `--set-file-version` → current app version (e.g. 1.0.4)
   - `--set-product-version` → current app version
   - `--set-version-string ProductName "AdvisePoint Docs"`
   - `--set-version-string FileDescription "AdvisePoint Docs Server"`
   - `--set-version-string CompanyName "AdvisePoint"`
   - `--set-version-string OriginalFilename "node.exe"` (kept as-is
     so any deep tooling that inspects it still works)
   - `--set-icon packaging/launcher/AdvisePointDocs.ico`

3. **Do NOT touch the launcher.** Filename stays `node.exe`; the
   launcher's `.\node\node.exe` path reference is unchanged. This
   preserves the launcher hash-pin rule.

### Why Option A over Option B (full filename rename)

- Preserves the launcher-baseline rule (no new SHA-256 pin needed)
- Task Manager's Details tab shows Description + Icon prominently —
  "AdvisePoint Docs" + our icon jumps out even with filename
  `node.exe`
- Zero risk to updater, backup, or any code path
- If we later want the filename rename too (Option B), Option A costs
  nothing to keep in place alongside

### Known side effect

Rewriting the Version Resource strips Microsoft's Authenticode
signature on `node.exe` ("Verified publisher: OpenJS Foundation"
disappears from file properties). Non-issue for us because we don't
code-sign our own builds today — the launcher itself is already
unsigned. Windows SmartScreen behavior doesn't change.

### Testing checklist

- Package a build; extract; run `powershell -c "(Get-Item .\node\node.exe).VersionInfo | Format-List"`
  on Windows to confirm ProductName / FileDescription / CompanyName /
  version numbers are set as expected.
- Launch the app; open Task Manager → Details tab; confirm
  Description column shows "AdvisePoint Docs Server" and the icon
  column shows the AdvisePoint Docs mark instead of the Node hexagon.
- Confirm launch smoke test still passes (Version Resource edits
  should have no runtime effect).
- Confirm launcher .bat still runs without changes.

### Effort estimate

~1–2 hours: install rcedit-linux, add ~10 lines to
`package-windows.mjs`, one round of Windows verification.

## Windows on ARM — full ARM64 support (v1.0.6 — PLANNED)

**Filed:** 2026-09-08
**Target release:** v1.0.6 (deferred from v1.0.4 on 2026-09-08 for scope + credit budget; split from v1.0.5 on 2026-09-08 into its own single-headline release; largest single line item in the v1.0.x line)
**Status:** planned, not yet started. Sole headline feature for v1.0.6. Do NOT start until v1.0.5 has shipped and been field-validated for at least one release cycle.
**Ask:** AdvisePoint Docs currently ships only an x64 Windows portable. Users
on Windows on ARM devices (Surface Pro X / Pro 9 5G / Pro 11, Copilot+ PCs
like the Surface Laptop 7 and various ARM-based ThinkPad/HP/Dell/Samsung
Galaxy Book models) fall back to the x64 emulator today, which drags the
native-module story down (better-sqlite3, pdf worker) and inflates memory
and startup time. Ship a real ARM64 build for v1.0.5.

### Deliverables

1. **Two portable zips per release**, side-by-side on the GitHub release:
   - `AdvisePoint-Docs.zip` — x64 (existing canonical name kept for the
     in-app updater matcher).
   - `AdvisePoint-Docs-arm64.zip` — native Windows ARM64.
   Rationale: keeping the version-free canonical filename means v1.0.3
   installs continue to auto-update to the x64 build normally. ARM users
   pick the arm64 asset once, then in-app updates from arm64 → arm64
   follow the same naming going forward.

2. **Native Node runtime per architecture.** Currently the packager
   downloads and bundles a specific Node binary (see
   `scripts/package-windows.mjs`, `--node-version` flag, default 20.18.1).
   Add an `--arch x64|arm64` flag; the arm64 build fetches the ARM64
   Windows Node distribution
   (`node-v<VERSION>-win-arm64.zip` from nodejs.org). Both zips get
   pinned to the same Node version for release parity.

3. **Native modules rebuilt for arm64.**
   - `better-sqlite3` — prebuilt ARM64 Windows binary must be present in
     the bundled `node_modules/better-sqlite3/build/Release/`. Verify
     `@mapbox/node-pre-gyp` picks the right asset for `--target_arch=arm64
     --target_platform=win32`.
   - Any other native addons pulled in transitively (audit
     `node_modules/**/binding.gyp` before build).
   - Package the ARM64 native binaries alongside the ARM64 Node runtime
     so the portable zip is self-sufficient.

4. **Launcher `.bat` unchanged.** The launcher is byte-identical to the
   v0.9.29 baseline (project rule); on ARM64 Windows it still runs `node
   dist/index.cjs` from the local folder — no architecture branching in
   the launcher.

5. **In-app updater architecture-aware matcher.** `packaging/updater/updater.cjs`
   currently expects one asset. Extend the matcher so:
   - An arm64 install looks first for `AdvisePoint-Docs-arm64.zip`, then
     falls back to `AdvisePoint-Docs-arm64-v<VERSION>.zip` (mirroring the
     v1.0.3 canonical + legacy pattern), and never picks the x64 zip.
   - An x64 install continues to prefer `AdvisePoint-Docs.zip` and never
     picks the arm64 asset.
   - Architecture detected via `process.arch` (`x64` → x64 asset, `arm64`
     → arm64 asset). Log the detected arch at updater startup so the
     diagnostics bundle captures which asset track a given install is
     following.

6. **`bump-version.mjs` / release-script updates.** Both zips share the
   same version number and the same release notes; the release-creation
   script uploads both assets under the same GitHub release. Update
   `create_release_v1_0_X.py` template to loop over `[("AdvisePoint-Docs.zip",
   x64_path), ("AdvisePoint-Docs-arm64.zip", arm64_path)]`.

7. **About page surfaces architecture.** Display `process.arch` in
   Settings → About next to the app version so users can confirm they
   installed the right build. Small footprint change; matches existing
   About panel style.

8. **Cross-arch backup portability.** Backup zips created on x64 must
   restore cleanly on arm64 and vice versa. The v1.0.3 backup manifest
   captures `app_version` and `schema_version` — add `source_arch` so
   restore logs can show "restored an x64 backup on an arm64 install".
   No data-format changes expected (SQLite files are byte-portable
   across x64/arm64 on the same endianness).

### Testing checklist

- Build both zips from the same source tag; verify SHAs differ (arch)
  but versions match.
- Install arm64 zip on a real ARM64 Windows device (Surface Pro X /
  Copilot+ PC). Confirm:
  - Launcher starts, Node reports `process.arch === "arm64"`.
  - better-sqlite3 loads without a rebuild prompt.
  - PDF ingest / worker-thread extractor runs at native speed (no
     emulation warnings in Event Viewer).
  - In-app updater from arm64 v1.0.4 to a future arm64 v1.0.5 picks the
     arm64 asset.
- Install x64 zip on the same ARM64 device (regression check that
  emulation path still works for users who grab the wrong asset).
  Confirm updater on that install picks the x64 asset, not the arm64.
- Backup on x64 install, restore on arm64 install, and vice versa —
  Merge and Wipe & Replace both.
- Diagnostics bundle from arm64 install includes `process.arch` in
  `bundle-info.txt`.

### Effort estimate

**~1–2 days:**

- ~half day: packager `--arch` flag + Node download logic + native-module
  audit.
- ~half day: updater matcher extension + `process.arch` logging + About
  panel touch.
- ~half day: release-script two-asset upload + release notes template
  refresh.
- ~half day: cross-arch testing on a real device (Surface Pro X / Copilot+
  PC required; not testable from a Linux dev environment).

### Open questions / decisions to resolve before implementation

1. **Node version alignment.** Current x64 build pins to Node 20.18.1.
   Confirm the same version is available as `node-v20.18.1-win-arm64.zip`
   before starting (Node has shipped Windows ARM64 builds since 20.0).
   If we ever have to skew versions across arches, document it in
   `concepts/build-and-test`.
2. **Third native module audit.** Beyond `better-sqlite3`, is anything
   else pulling native binaries at install time? Run `rg -l
   "binding.gyp"` under `node_modules/` after a clean install and list.
3. **Icon / branding parity.** No change expected — `.ico` and favicons
   are architecture-independent — but verify the launcher shortcut
   creator on arm64 picks up the same `AdvisePointDocs.ico`.
4. **Diagnostics bundle field.** Should `bundle-info.txt` gain a
   `Detected arch:` line specifically, or is `Node process.arch` inside
   the existing runtime-info section enough? Decide during
   implementation; the file is already free-form.

### Related open items to consider at the same time

- **Mac build.** Not scheduled, but the arm64 packaging work builds
  muscle for cross-arch packaging that a future Mac build (Universal /
  arm64 + x64) would reuse.
- **Cross-arch backup restore edge cases** — covered above; also
  worth capturing in `concepts/gotchas` once we've done the first
  round-trip on real hardware.

## Packager baseline refresh — rebase to v1.0.3.1 (v1.1.0 — PLANNED)

**Filed:** 2026-09-08
**Target release:** v1.1.0 (bundle with ARM64 packager work; both edit
`scripts/package-windows.mjs`)
**Status:** planned. Cleanup, not user-facing.
**Ask:** The packager currently starts from
`AdvisePoint-Docs-baseline-v1.0.0.zip` and carries version-compatibility
logic to bridge older launcher lineages (v0.9.29 origin → v0.9.34
additive framing → v1.0.0 rebrand). Refresh the baseline to v1.0.3.1
so the packager code can drop that history without losing safety.

### What changes

1. **Rebuild the baseline zip.** Take the current shipped
   `AdvisePoint-Docs.zip` (v1.0.3.1) and prepare it as the new template:
   - Wipe `dist/index.cjs` (packager overwrites this every release; a
     blank placeholder keeps the baseline generic).
   - Keep everything else (node/, node_modules/, packaging support
     files, launcher).
   - Rename to `AdvisePoint-Docs-baseline-v1.0.3.1.zip`, place in the
     workspace root next to the current baseline for a transition period.

2. **Update `scripts/package-windows.mjs`:**
   - Point default `--baseline` at the new zip filename.
   - Set `EXPECTED_LAUNCHER_SHA256` to the v1.0.0 launcher's current
     hash (`7ac72e45fdaf2ad2ca366ecbd651f6f13e1854b73f78017720914f551fa75c98`).
     Since the baseline now already contains the current launcher,
     `NEW_LAUNCHER_SHA256` can be set to `null` (nothing to copy over).
   - Delete the historical comment block explaining the v0.9.29 →
     v0.9.34 → v1.0.0 evolution — replace with a compact
     "baseline current as of v1.0.3.1" note.

3. **Delete the old baseline zip** from the workspace once the first
   release from the new baseline ships cleanly.

### Why bundle with the ARM64 work

ARM64 support requires the packager to either:
- Accept an `--arch` flag and download the ARM64 Node runtime at
  package time (drops the Node binary from the baseline), OR
- Ship two separate baselines (one per arch).

Either way, `scripts/package-windows.mjs` gets substantially rewritten.
Refreshing the baseline in the same PR is efficient because we're
touching the same code and the same testing surface.

### What we're NOT changing

- **The rule that launcher changes require a hash pin.** The mechanism
  (`EXPECTED_LAUNCHER_SHA256` + `NEW_LAUNCHER_SHA256`) stays; it just
  starts from a newer reference point.
- **The `RAG_DB_PATH` env var name.** Still needed for backward
  compatibility with any user who has an older launcher shell around a
  newer dist bundle (rare, but possible in the field).
- **Any user-visible behavior.** This is a packaging-internals change;
  the output zip is byte-equivalent to what we'd ship without the
  refresh.

### Testing checklist

- Package a release from the new baseline; confirm the zip contents
  match a release packaged from the old baseline (diff `unzip -l`
  output, verify launcher SHA-256 unchanged).
- Confirm the launch smoke test still passes.
- Confirm in-app updater accepts the new zip (asset filename
  unchanged: `AdvisePoint-Docs.zip`).
- Verify a v1.0.3.1 install can be upgraded in place by a release
  built from the new baseline (no data loss, no launcher mismatch
  errors).

### Effort estimate

~1–2 hours if done standalone, ~30 min extra on top of the ARM64
packager rewrite (mostly bounded by careful diff review of the
resulting zip vs. a same-version build from the old baseline).

## Page viewer — sharper zoom from Fit mode — SHIPPED

**Filed:** 2026-09-07
**Shipped in:** v1.0.2
**Status:** DONE. Confirmed in v1.0.2 build.
**Ask:** In the page viewer, opening a doc in whole-page "Fit" view and
then zooming in produced badly pixelated text. Zoom worked well only after
manually switching to Readable mode first.

### Root cause

Fit mode renders the page image with `max-w-full max-h-full` — shrunk to
fit the viewport, typically well below the source resolution. `use-zoom-pan`
uses CSS `transform: scale(...)` on that already-shrunk render, so scaling
up any factor > 1 just enlarged pixels.

### What shipped

Added fit-mode auto-promotion. Any zoom-in gesture initiated while in Fit
mode now first switches to Readable (which re-renders the image at natural
size) instead of scaling up the low-res render. Covered entry points:

* `+` toolbar button
* Keyboard `+` / `=`
* Ctrl + wheel-up (both "zoom" and "scroll" wheel modes)
* Double-click on the page

Implemented as a new `onZoomInFromFit?: () => boolean` option on
`useZoomPan`. The hook calls it whenever a zoom-in gesture is about to
cross `zoom = 1` upward and, if it returns true, aborts its own zoom.
`PageViewer` supplies a callback that calls `promoteToReadable()` (swap
fitMode + set zoom to `READABLE_ZOOM` + scrollToEdge("top")), which
mirrors the toolbar's Fit->Readable path.

Zoom-out and the explicit toolbar toggle keep their original behavior.

## Delete confirmation dialog — verbose warning before document delete (v1.0.1 BUG FIX — STAGED)

**Filed:** 2026-09-07 · **Target release:** v1.0.1 (promoted from v1.0.2 same day) · **Classification:** bug fix · **Status:** implemented, uncommitted, awaiting v1.0.1 build trigger

### Problem

On the doc detail page, the red **Delete** button in the upper-right corner
(`client/src/pages/library.tsx` line 1318) fires immediately on click with
zero confirmation. Misclick = permanent data loss with no undo. This is a
serious footgun, especially for service techs using a laptop trackpad in
the field.

### Fix

Wrap the Delete button in a confirmation dialog (shadcn `<AlertDialog>` —
already used elsewhere in the app) that requires an explicit second click
to proceed.

**Dialog copy (verbose, per user request):**

> **Delete this document?**
>
> This will permanently remove:
> - The document file and its extracted text
> - All rendered pages and thumbnails
> - Search index entries (this document will no longer appear in Query results)
> - Any document-specific settings (Product Model, Document Type, custom
>   metadata)
>
> **This action cannot be undone.**
>
> [Cancel] [Delete document]

- Default focus on **Cancel** (safer default).
- **Delete document** button uses the same destructive red as the trigger.
- Escape key = cancel; Enter = default action (Cancel).

### Implementation notes

- Replace the `onClick={() => del.mutate()}` handler on the Delete button
  with an `onClick` that opens a local `<AlertDialog>` state.
- Wire the dialog's confirm action to `del.mutate()`.
- No backend changes. No schema changes. No settings.
- Keep the existing toast ("Document deleted") and post-delete navigation
  (`window.location.hash = "/library"`).

### Testing checklist

- Click Delete → dialog opens, document still present.
- Cancel → dialog closes, document still present, no mutation fired.
- Confirm → document deleted, toast shows, navigation to library.
- Escape key closes dialog without deleting.
- Click outside dialog closes without deleting.
- Rapid double-click on trigger does NOT double-fire the mutation.
- Screen reader announces the dialog title and body correctly.

### Effort estimate

~30 minutes. Shipped as part of the v1.0.1 batch alongside the icon
integration, version-pill fix, and worker-thread PDF extractor.

### Related but separate

A proper Trash / recycle-bin feature with configurable retention and
restore is spec'd separately below ("Trash & Restore"). When that ships,
this dialog's copy changes to reflect the new soft-delete behavior
(e.g. "Move to trash? You can restore this within N days…").

## Trash & Restore — app-managed soft delete with configurable retention (post-v1.0.x)

**Filed:** 2026-09-07 · **Target release:** TBD (v1.1.0 candidate as a
headline feature) · **Depends on:** v1.0.1 delete confirmation dialog
(above) shipping first, so the two changes don't collide.

### Rationale

Even with the v1.0.1 confirmation dialog in place, misclicks and
misjudgments still cost users their data. A service tech who deletes
"MFP-4500 Service Manual" thinking it's the old revision, then realizes
the next morning it was the current one, has no recourse today. A proper
trash system with configurable retention gives users a safety net without
cluttering the primary library view.

### Architecture decision: app-managed trash folder

After comparing three approaches (Windows Recycle Bin only, app-managed
folder only, hybrid), we chose **app-managed trash folder** as the
primary storage.

**Why not Windows Recycle Bin as primary:**

- User or OS can silently break it: manual Empty Recycle Bin, size-limit
  auto-purge, Storage Sense timed cleanup, Recycle Bin disabled per
  drive, files over size limit skip Recycle Bin entirely with no error.
- No stable Node API to query Recycle Bin state — requires PowerShell +
  Shell.Application COM interop, slow and fragile.
- User can restore files themselves via Explorer, moving them elsewhere,
  breaking our restore path.
- Failure UX becomes "sorry, gone, not our fault" — worse than not
  offering restore at all.

**Why app-managed folder wins:**

- 100% restore reliability within the retention window.
- Accurate trash size, count, expiry — always.
- Consistent with existing "data folder never touched on updates" rule
  (see concepts/data-and-storage in the project wiki).
- Simpler implementation, fewer edge cases.
- Cross-platform-friendly if a Mac build ever happens.

**Optional future enhancement:** a "Also send a copy to Windows Recycle
Bin" setting could add belt-and-suspenders behavior for users who want
it. NOT in the initial MVP — add only if requested after real usage.

### Storage layout

```
%LOCALAPPDATA%\AdvisePoint Docs\
  trash\
    <doc_id>.apdoc.zip     ← bundled document
    <doc_id>.meta.json     ← restore metadata (see below)
```

**Bundle contents (`.apdoc.zip`):**

- `manifest.json` — full document metadata (title, product model,
  document type, custom fields, chunk IDs, upload date, original source
  filename, delete timestamp, retention expiry)
- `document.<ext>` — the original uploaded file (PDF, DOCX, etc.)
- `extracted.txt` — the extracted text
- `pages/` — all rendered page PNGs from `%LOCALAPPDATA%\AdvisePoint
  Docs\pages\<doc_id>\`
- `chunks.json` — FTS index entries exported for this document
- `settings.json` — doc-specific settings (Product Model, Document Type,
  metadata)

Bundle is created with standard zip (deflate), no encryption. Users
should be able to inspect a `.apdoc.zip` in Explorer if they want to
verify what's preserved.

**Sidecar `.meta.json`:**

Small JSON file kept OUTSIDE the zip so the Trash view can render
quickly without unzipping every bundle. Contains:

```json
{
  "doc_id": "...",
  "title": "MFP-4500 Service Manual",
  "product_model": "MFP-4500",
  "document_type": "service_manual",
  "page_count": 342,
  "size_bytes": 47582934,
  "deleted_at": "2026-09-07T14:00:00Z",
  "expires_at": "2026-10-07T14:00:00Z",
  "bundle_path": "<doc_id>.apdoc.zip"
}
```

### Backend changes

**Database:**

- No `deleted_at` column on `documents` — soft delete removes the row
  from `documents` entirely and creates the trash bundle. This keeps
  the query surface simple: no need to audit every SELECT to add
  `WHERE deleted_at IS NULL`. The trash folder + sidecars are the
  authoritative record of deleted docs.
- Trash discovery = read `%LOCALAPPDATA%\AdvisePoint Docs\trash\*.meta.json`.

**Endpoints:**

- `DELETE /api/documents/:id` — changes behavior: bundles + moves to
  trash instead of hard delete. Accepts optional `?permanent=true`
  query param for the "Delete permanently now" case.
- `GET /api/trash` — lists all `.meta.json` sidecars, sorted by
  deleted_at desc. Fast (no zip inspection).
- `POST /api/trash/:doc_id/restore` — unpacks the bundle, re-inserts
  into `documents`, restores pages to `pages/`, rebuilds chunks in FTS
  index, restores settings. Deletes the bundle + sidecar. Returns the
  restored document.
- `DELETE /api/trash/:doc_id` — permanently deletes bundle + sidecar.
- `DELETE /api/trash` — empties trash (with confirmation on the client).
- `GET /api/trash/stats` — returns `{ count, total_size_bytes,
  oldest_deleted_at }` for the Settings panel and trash badge.

**Purge job:**

- Runs on server startup + every hour thereafter (setInterval, cleared
  on shutdown).
- Reads all sidecars, finds any where `expires_at < now()`, deletes
  bundle + sidecar.
- Uses the same worker-thread pattern as the v1.0.1 PDF extractor to
  avoid stalling the event loop if trash is large.
- Logs each purge to the server log with doc title + size, so users
  investigating disk space can trace where it went.

**Settings storage:**

- New table `app_settings (key TEXT PRIMARY KEY, value TEXT)`, or
  reuse an existing settings mechanism if one exists.
- Keys: `trash.retention_days` (default: `30`),
  `trash.enabled` (default: `true`),
  `trash.confirm_on_permanent_delete` (default: `true`).

### Client UI

**New Settings panel (or route):**

The app currently has a Settings icon in the top nav that isn't fully
wired to a dedicated settings surface. This feature is a good excuse
to build that surface. Sections:

1. **Trash & Restore**
   - Toggle: "Enable Trash (recommended)" — default on
   - Slider or preset picker: Retention period — 7 / 30 / 90 days /
     Forever (default 30)
   - Read-only stats: "Current trash: 3 documents, 127 MB"
   - Button: "Open Trash" → navigates to trash view
   - Button: "Empty trash now" (with confirmation)

**New Trash view (`/library/trash` or `/trash`):**

- Table/grid of soft-deleted docs, showing:
  - Thumbnail (first page render, extracted from bundle on demand)
  - Title, product model, document type
  - Deleted timestamp + "Expires in N days" countdown
  - Bundle size
  - Row actions: **Restore** | **Delete permanently**
- Bulk selection: [Restore selected] [Delete selected permanently]
- Header: trash size total, count, [Empty trash] button
- Empty state: "Nothing in trash. Deleted documents appear here for N
  days before being permanently removed."

**Library view touches:**

- Small badge on the Settings icon (or a new "Trash" nav item) showing
  trash count when > 0.
- Toast after soft-delete: "Moved to trash · [Undo]" — undo restores
  immediately, expires after ~5 seconds.

**Delete confirmation dialog updates (evolves from v1.0.1 dialog):**

- If trash enabled:
  > "Move to trash?
  >
  > This document will be preserved in trash for N more days, after
  > which it will be permanently deleted. You can restore it any time
  > before then from Settings → Trash.
  >
  > [Cancel] [Move to trash] [Delete permanently]"
- If trash disabled: fall back to v1.0.1's verbose "permanently remove"
  copy.
- "Delete permanently" from the Trash view: separate second dialog
  with the strongest language.

### Restore edge cases

- **Restore when doc_id already exists in `documents`:** should never
  happen (delete removes the row), but if it does (imported same doc
  fresh while old copy in trash), refuse restore with clear message
  offering to open the existing doc instead.
- **Restore when Product Model or Document Type has been deleted since:**
  restore the doc with those fields set to whatever's in the manifest;
  the missing type/model will appear as an unknown value in the UI
  until the user reassigns. Do NOT silently drop the field.
- **Restore when FTS index schema has changed since delete:** rebuild
  chunks from `extracted.txt` on restore rather than trusting the
  cached `chunks.json`. Slightly slower but avoids stale-schema bugs
  across app versions.
- **Restore when bundle is corrupt/unreadable:** show error, offer to
  remove the sidecar (which will hide the entry from Trash view).
- **Disk full during restore:** partial restore rollback — delete any
  files we wrote, do not re-insert the row.

### Settings/data-folder implications

- Trash lives in `%LOCALAPPDATA%\AdvisePoint Docs\trash\` — consistent
  with the "data folder never touched on updates" rule. App updates
  will not disturb trash.
- If a user manually deletes the trash folder, sidecars go with the
  bundles — the app has no memory of them. This is acceptable; user
  chose it.
- Trash size counts toward the "data folder is getting big" mental
  model. Consider adding trash size as a separate line in whatever
  storage-diagnostic UI eventually appears.

### Migration

No migration needed. Feature is additive: pre-existing documents
behave normally; when deleted after the update, they go to trash.
Existing hard-deleted documents remain hard-deleted (no way to
recover them retroactively).

### Testing checklist

- Delete document with trash enabled → bundle appears in trash folder,
  sidecar created, doc gone from library, toast shows Undo option.
- Undo toast → restores immediately, no bundle left behind.
- Delete document with trash disabled → hard delete, no bundle created.
- Restore document from trash view → fully functional, pages render,
  Query results include it again, all metadata intact.
- Restore doc whose Product Model was deleted since → doc restored,
  model field shows as unknown.
- Permanent delete from trash view → bundle + sidecar gone, no recovery.
- Empty trash → all bundles + sidecars gone.
- Purge job on startup with expired items → removes them, logs each.
- Purge job with 100+ expired items → event loop stays responsive
  (heartbeat + upload requests still work during purge).
- Retention change from 30 → 7 days with existing trash items dated
  15 days ago → those items purge on next hourly cycle.
- Retention change from 30 → 90 days → existing items get their
  expires_at extended? OR do they keep their original expiry? Decide
  before implementation. Recommendation: **keep original expiry**
  (setting change is prospective, not retroactive) with a note in the
  Settings UI.
- Fresh install with no trash folder → folder created lazily on first
  delete.
- Bundle over 4GB → does zip creation succeed? (Node's zip libs vary
  in ZIP64 support.) Test with a large multi-manual doc.
- App update from pre-trash version → no crashes, trash folder created
  on first delete post-update.

### Effort estimate

**~2-3 days done properly:**

- ~half day: backend endpoints (delete, restore, list, permanent delete,
  stats, purge job with worker-thread offloading)
- ~half day: bundle format + zip creation + unzip/restore logic
- ~1 day: Trash view UI + Settings panel + delete-dialog evolution +
  undo-toast wiring + badge on nav
- ~half day: edge-case testing + docs

Good candidate for **v1.1.0 as a headline feature**, giving it enough
time for its own release cycle rather than piggybacking on a smaller
version bump.

### Out of scope for MVP

- Windows Recycle Bin secondary copy (optional future enhancement).
- Encrypted bundles.
- Cross-machine restore ("export bundle from laptop A, restore on
  laptop B") — the format supports it in principle but the UI flow is
  a separate feature; treat as bring-your-own workflow initially.
- Trash for other entity types (Product Models, Document Types) —
  documents first, expand only if needed.

## Text-to-Speech reader — read sections or selections aloud (post-v1.0.x)

Allow the user to have any portion of a document read aloud in a human-quality
voice. Two triggers: highlight-a-passage-and-click-play, or click the reader
button in the doc header to read the current section top-to-bottom. Playback
controls (play/pause/stop/speed/voice), remembered per-user preferences, and
visual highlight of the currently-spoken sentence.

### Rationale

Service techs frequently need to reference a manual while their hands are on
the printer — screws in one hand, screwdriver in the other, phone tucked
under chin. A read-aloud feature turns the doc viewer into a hands-free
reference. Also useful for accessibility (users with visual fatigue or
reading difficulties) and for long procedural sections where following along
by ear is easier than scanning.

### Three implementation paths considered

**Path 1 — Browser Web Speech API (RECOMMENDED for MVP):**

- Uses `window.speechSynthesis` — built into every modern browser.
- Zero cost, zero server changes, zero bundle bloat, works offline.
- Voice quality depends on what Windows SAPI voices are installed on the
  user's machine. Default David/Zira sound robotic; if the user installs
  the free Microsoft Natural voices (Aria, Guy, Jenny, Christopher, etc.
  via Settings → Time & Language → Speech → Add voices), quality jumps to
  genuinely pleasant "human voice" territory.
- We can detect voice quality via `voice.name` and surface a one-time
  inline hint ("Install Microsoft Natural voices for better quality → link
  to Settings") when only low-quality voices are present.
- Effort estimate: **~3 hours** for a full MVP with all the controls below.

**Path 2 — Cloud TTS (ElevenLabs / Azure Neural / OpenAI TTS):**

- Truly indistinguishable-from-human quality.
- Kills the offline / air-gapped story — service techs in printer closets
  with no WiFi lose the feature.
- Requires user's own API key + billing management on their end.
- Effort estimate: ~1-2 days (proxy endpoint, streaming, chunking for the
  5000-char API limits, caching to avoid re-synthesizing the same paragraph
  and burning credits, settings UI for API key and voice picker).
- Cost per user: ElevenLabs is ~$0.30/1000 chars cheap tier, ~$5/1000 chars
  high-quality. A 20-page manual section could easily be $2-5 per read
  (caching mitigates).

**Path 3 — Bundled local neural TTS (Piper):**

- Ship Piper binary (~15MB) + 1-2 voice models (~50-100MB each) inside the
  portable zip. Fully local, offline, human-quality.
- Voice quality: very good — better than SAPI defaults, close to (but not
  quite matching) ElevenLabs. See rhasspy/piper voice samples.
- **Bloats the portable zip from 54MB to 150-250MB** — meaningful for
  download and USB-stick distribution scenarios.
- More moving parts to test on customer machines (native binary, model
  path resolution, disk I/O). First-sentence cold-start of 1-3 sec on
  typical hardware.
- Effort estimate: ~3-5 days.

### Recommendation: ship Path 1 first, evaluate later

Build the Web Speech API MVP as the headline feature of a future release.
Treat it as validation of the feature itself — do users actually use it? On
what content? Is SAPI quality the ceiling they hit? If yes, revisit Path 2
or Path 3 with real usage data. If no, we saved ourselves days of work and
avoided bloating the portable zip or requiring an API key.

Do NOT combine paths in the MVP. The temptation is to build a settings
switch "local vs cloud" from day one — resist it. Every path except the
chosen MVP is dead code until we know the feature is used.

### MVP feature spec (Path 1)

**Trigger 1 — Read selection:**

- When the user highlights any text inside the document detail view, a
  small floating pill appears near the selection: **🔊 Read selection**
- Clicking it starts playback of the selected text.
- If the user clears the selection while playing, playback continues to
  the end of the previously-selected passage (does not stop mid-word).

**Trigger 2 — Read current section:**

- Small speaker icon in the doc detail header (next to the existing
  "Back to library" link).
- Clicking it starts reading the currently-visible section from the top.
- If a specific section anchor is in the URL (e.g. `/library/doc/foo#s-3`),
  playback starts at that section, not the top of the doc.

**Controls (bottom-of-viewport floating bar, appears only during playback):**

- Play / Pause / Stop
- Previous sentence / Next sentence (uses `onboundary` events to know
  sentence boundaries)
- Speed slider (0.5x – 2.0x, default 1.0x)
- Voice picker (dropdown populated from `speechSynthesis.getVoices()`,
  filtered to `voice.lang.startsWith('en')` and sorted with
  `localService === false` neural voices first)
- Close button (stops playback and hides the bar)

**Visual feedback during playback:**

- Currently-spoken sentence highlighted with a soft primary-color
  background in the doc viewer. Uses `speechSynthesis`'s `onboundary`
  event with `name === 'sentence'` where supported, falls back to
  word-level boundary counts otherwise.
- Auto-scroll toggle in the control bar — when on, scroll the viewport
  to keep the currently-spoken sentence centered.

**Persisted settings (localStorage, keyed like other prefs):**

- Preferred voice (name string)
- Preferred speed
- Auto-scroll on/off
- Have-seen-natural-voices-hint (boolean, so we don't nag the user every
  session if they've dismissed the install-natural-voices banner)

**Voice-quality hint:**

- On first mount, check `speechSynthesis.getVoices()`. If all English
  voices have `localService === true` AND `voice.name` matches known
  low-quality names (David, Zira, Mark, Hazel), show a one-time inline
  banner in the reader control bar:
  > "For better voice quality, install Microsoft Natural voices in
  > Windows Settings → Time & Language → Speech → Add voices."
- Dismissible with an X. Dismissal stored in localStorage.
- Never shown if the user already has a neural voice available.

**Chunking strategy:**

- Web Speech API can choke on long strings (browser-dependent, but 1000+
  chars can silently fail in Chrome). Split input into sentence-level
  utterances using a simple regex (`/(?<=[.!?])\s+/`), enqueue each as
  a separate `SpeechSynthesisUtterance`, wire `onend` of each to trigger
  the next.
- This also makes Previous / Next sentence controls trivial to implement.

**What we do NOT build in the MVP:**

- Cloud TTS / bring-your-own-API-key
- Bundled Piper binary
- Custom voice training / voice cloning
- Downloading synthesized audio as MP3 (nice-to-have; add later if
  requested)
- Reading whole documents end-to-end (start with sections and selections
  only; whole-doc reading has scroll/UX implications worth thinking
  through separately)

### Testing checklist

- Chrome, Edge, Firefox on Windows 10 and Windows 11
- With and without Microsoft Natural voices installed
- Text selection that spans multiple paragraphs
- Text selection that includes a code block, table, or numbered list
- Playback during scroll (does auto-scroll conflict with user scroll?)
- Switching tabs mid-playback (does audio continue? should it pause?)
- Very long section (5000+ chars) — verify chunking works, no silent fail
- App version pill and header remain readable while the reader control
  bar is shown
- Playback state on page navigation — stop cleanly, don't leak an
  utterance into the next page

### Open design questions to resolve before implementation

1. What happens if playback is active and the user navigates to a
   different doc? Auto-stop and clear the bar, or ask?
2. Should the reader be scoped only to the doc detail view, or also work
   on Query results (read the answer + citations aloud)?
3. Do we surface a keyboard shortcut? Suggestion: `Space` for play/pause
   when the reader bar is visible and the user isn't in a text input.

### Deferred to a later release, not the MVP

- Cloud TTS (Path 2) integration — revisit after we see real MVP usage.
- Bundled Piper (Path 3) integration — revisit only if MVP usage is
  strong AND SAPI quality complaints are recurring.
- Read-along mode for full documents with a persistent progress bar.
- Bookmarks ("read from here later").
- Export synthesized audio as MP3 for offline listening away from the app.

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

## Backup & Restore (v1.0.3 — SHIPPED)

**Filed:** 2026-09-03
**Retargeted:** 2026-09-07 (originally v1.0.0, moved to v1.0.3 after
v1.0.0 shipped without it; user chose to defer so the whole feature
ships as one release)
**Target release:** v1.0.3
**User decisions on scope:**

* Ship both Wipe-and-Replace and Merge import modes as one release.
  Merge intentionally allows duplicates through without warnings —
  users clean up afterward with the existing duplicate checker.
* Ship manual Export + Import PLUS in-server scheduled backups
  (see "Scheduled backups" section below — added 2026-09-07 after user
  asked whether backup runs when the tab is closed).

### Corrections vs the original 2026-09-03 spec

* **DB filename** in the current data folder is `rag.db`, not `kie.db`.
  Export/import paths must use `rag.db`.
* **Data folder** is `%LOCALAPPDATA%\AdvisePoint Docs\` in v1.0.0+
  (renamed from `%LOCALAPPDATA%\KyoInfoExplorer\`). Confirmed live in
  v1.0.2.
* **Zip encoder** — the v0.9.31 pure-Node encoder is in-memory-only
  with no ZIP64 support and is insufficient for hundreds-of-MB backups
  with `pages/**`. Add the `archiver` npm dependency (streaming, ZIP64,
  industry-standard, no native deps) for this feature. Keep the
  in-memory encoder for diagnostics export.
* **better-sqlite3 v11.7.0 supports `VACUUM INTO`** — confirmed in
  earlier analysis; safe to use for the consistent-snapshot path.

### What to build

A Settings-panel "Backup & Restore" section with two primary actions:

1. **Export backup** — produces a single `.zip` containing:
   * `db/rag.db` — SQLite snapshot written via `VACUUM INTO` so it is
     transactionally consistent even if writes are happening.
   * `pages/**` — every file under `RAG_PAGES_DIR` (page renders and
     extracted text) so the viewer works after restore with no re-render.
   * `localStorage.json` — dumped from the browser side (tab state,
     library UI preferences, remembered selections) so a restored install
     lands the user where they left off.
   * `manifest.json` — `{ app_version, schema_version, exported_at,
     document_count, chunk_count, pages_bytes }` for validation and
     compatibility checks on import.
   * Use the `archiver` npm package (streaming, ZIP64, no native deps).
     The v0.9.31 in-memory pure-Node encoder is retained for diagnostics
     export but is insufficient for hundreds-of-MB backups — see the
     "Corrections" section at the top of this entry.
   * Suggested filename: `advisepoint-docs-backup-YYYYMMDD-HHMMSS.zip`
     (matches the scheduled-backup filename pattern; makes retention
     filtering trivial).

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

### Scheduled backups (added 2026-09-07 for v1.0.3)

User context question that drove this: "Will this backup feature still
operate if the browser tab is not running?" Backup is server-side, so
it runs whenever the Node server is running — tab optional. But if the
launcher window is closed, the server exits and no backup can run.

Option chosen: **Option 2 — manual + in-server scheduled backups**
(runs while the launcher is open; skips if the app is fully closed).
Option 3 (Windows Task Scheduler) was rejected as too complex for now
and may need admin rights. Revisit if users ask for truly-offline
recurring backups in a later release.

#### What to build

* **Scheduler module** — server-side. Single-process app, so use
  `setInterval` + a persisted "next run" timestamp rather than a full
  cron library. On server start, compute the next scheduled run from
  the persisted last-run timestamp and the configured cadence; fire
  once now if we missed a scheduled slot while the app was closed
  (with a small grace window — e.g. don't fire if the app has only
  been open 30 s and we missed by an hour).
* **Settings UI additions** in the Backup & Restore card:
  * **Automatic backup** — radio: Off / Daily / Weekly
  * **Time of day** — for Daily/Weekly (default 02:00 local, but only
    fires if the app is open at that time)
  * **Backup folder** — path picker; default
    `%LOCALAPPDATA%\AdvisePoint Docs\backups\`
  * **Keep last N backups** — numeric input, default 7; oldest are
    deleted automatically after each successful run
  * **Last backup** — read-only display of timestamp + status
    (success / failed with reason)
* **Persisted settings** — add a small `app_settings` table (or extend
  the existing settings table if one already exists) with columns for
  `backup_cadence`, `backup_time`, `backup_folder`, `backup_retention`,
  `backup_last_run_at`, `backup_last_status`, `backup_last_error`.
* **Retention policy** — after a successful scheduled backup, delete
  the oldest backup files in the backup folder if the count exceeds
  the configured retention. Only delete files matching the
  `advisepoint-docs-backup-*.zip` pattern so we don't touch anything
  else the user may have placed there.
* **Filename convention for scheduled backups** —
  `advisepoint-docs-backup-YYYYMMDD-HHMMSS.zip` (matches manual export
  filename pattern; retention filter is straightforward).
* **Logging** — scheduled runs write to `server.log` with clear
  `[BACKUP]` prefix, and the last-run status is surfaced in the
  Settings UI. Consider a small "Backup history" collapsible section
  showing the last 10 runs with timestamps and outcomes.
* **Concurrency guard** — if a manual backup is in progress when the
  scheduled run fires (or vice versa), skip and log; do not queue.

#### Not doing yet

* Truly-offline scheduled backups (Windows Task Scheduler / service).
  Revisit if users report needing them.
* Notification / toast when scheduled backup completes. Optional
  polish; the Settings status readout is sufficient.

### Explicitly out of scope for v1.0.3

* Windows Task Scheduler integration for backups that run when the
  app is fully closed (see "Not doing yet" above).
* Import-side duplicate detection — user has requested we skip this
  deliberately and lean on the existing duplicate checker.
* Encrypted backups — not requested; add later if a user asks.
* Selective / partial export (single doc, single folder) — not asked
  for; the full-DB backup covers the stated use case.
* Cloud-target backups (S3, Google Drive, OneDrive). Not asked for.

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
