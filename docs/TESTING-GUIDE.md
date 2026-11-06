# AdvisePoint Docs v1.3.5 testing guide

Use the matching x64 or ARM64 binary ZIP and verify its SHA-256. Keep an
independent verified library backup before upgrading; shared source is not an
updater package.

## Upgrade and isolation

- **Upgrade:** from v1.3.4 or earlier, use the local-ZIP control (or Update
  now once the release is published) with the matching architecture package.
  Confirm v1.3.5, reconnect and an unchanged searchable library. Preserve
  diagnostics if updating fails.
- **Production:** the normal launcher uses the real library and port 5000.
  Prototype 5100 and separate test launcher 5101 remain distinct. No isolated
  launcher or reset/delete utility is bundled.
- **Test data:** use an isolated test setup or an approved disposable library
  copy for mutation, restore and backup-failure tests.

## Library quick search

- **Layout:** the description is on the Library heading line, right-aligned;
  the search box and Search button are under the heading. Check a full
  desktop window and a narrow window.
- **Matching:** "MZ9500 fax" finds the MZ9500 FAX guide. "MZ9500ci FAX",
  "MZ9500ci-FAX" and "mz9500ci_fax" give the same result. A word found only
  in a document's text (not its name, file name or details) finds nothing.
- **Fields:** search by an original file name, a tag, a product family and a
  document type label; each finds the expected documents.
- **Typing:** typing alone does not change the list; Enter or Search does.
  Emptying the box shows the full list again.
- **Clear:** the X in the box, the X on the pill and Esc each restore the full
  list with sort and filters intact. Reset clears the search, sort and filters.
- **With filters:** a search combined with Document type, Product model or
  Product family narrows by both; the count reads "N of M documents".
- **No matches:** shows "No documents match" with Clear.
- **Cards:** matching cards stay folded; Expand all and Collapse all work.
- **Persistence:** switch to Query and back; the search remains. Restart the
  app; the search is cleared.

## Query Auto Search

- **Default:** the switch at the right of the Filters header is on; Clear sits
  to its left when filters are set.
- **Re-run:** run a search, then change Product model; results update after a
  short pause. Repeat with family, Selected family only, document type,
  confidentiality, a tag, match mode and Clear.
- **Slider:** drag Max results; one search runs when it is released.
- **Rapid changes:** change several filters quickly; one search results, and
  the final results match the final filters.
- **No search yet:** before the first search, or with an empty box, changing
  filters does not search. After Reset, changing filters does not search
  until Search is used.
- **Recent searches:** after a manual search and several filter changes, the
  list shows the manual search and one entry for the latest filters.
- **Off:** turn the switch off; filter changes wait for Search. Restart the
  app; the switch keeps its setting.

## PDF viewer zoom

Open a retained (native) PDF, both portrait and landscape. From Fit, press +
once and twice; from Zoom Page, press +; zoom out again. The page keeps its
shape at every step, with no vertical stretch. Stored page-image documents
behave as before.

## Earlier features

Repeat a short check of the v1.3.4 update messages and the v1.3.3 Selected
family only, Query Reset, Upload result Reset, Backups to keep and Latest
backup + previous backup features. These are unchanged in v1.3.5.

## Continuing field gates

- **Architecture:** in-place upgrades and live update discovery on both x64 and
  ARM64.
- **Backups:** restore each paired archive into isolated libraries; exercise
  Windows file locks, disconnected destinations and interruptions with
  disposable copies only.
- **Lifecycle:** leave Edge awake and idle at least four hours, then use Query,
  Library and Check now. Test final-tab closure, explicit Stop and relaunch.
- **PDF and printing:** normal, compatible restricted and older stored-page
  documents, print preparation and a physical printer.

Known baseline: 14 TypeScript diagnostics and the `GENENZZ42` model /
`HyPASENCG` custom-code test failures. Export diagnostics promptly after a
failure; logs can include paths and filenames, so review them before sharing.
