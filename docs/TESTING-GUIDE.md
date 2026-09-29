# AdvisePoint Docs v1.3.3 testing guide

Use the matching x64 or ARM64 binary ZIP and verify its SHA-256. Keep an
independent verified library backup before upgrading; shared source is not an
updater package. These packages are not yet published to GitHub.

## Upgrade and isolation

- **Local upgrade:** use the existing local-ZIP update control with the matching
  architecture package. Confirm v1.3.3, reconnect and an unchanged searchable
  library. Validate before shutdown; preserve diagnostics if updating fails.
- **Production:** the normal launcher uses the real library and port 5000.
  Prototype 5100 and separate test launcher 5101 remain distinct. No isolated
  launcher or reset/delete utility is bundled. Do not assume extracting a second
  application creates a separate library.
- **Test data:** use an explicitly isolated test setup or an approved disposable
  library copy for mutation, restore and backup-failure tests. Do not interrupt
  real production backups or delete genuine recovery copies for testing.

## Query controls

- **Default:** Selected family only starts unchecked. Selecting a family includes
  matching and unassigned documents, but not other assigned families.
- **Strict:** check the option and search again. Only explicitly matching
  families remain; blank/whitespace values are excluded. Case and surrounding
  whitespace do not affect matching. Any disables the option.
- **Combined filters:** check model, type and tags with strict mode. A zero-hit
  strict search must not silently broaden. Confirm the selected result limit
  applies after filtering.
- **Reset:** use Reset beside Search. Text, results, selection/preview and all
  filters should clear; the family-only checkbox becomes unchecked. Recent
  searches, documents, search mode and result limit remain.
- **State:** switch tabs and return; old cleared results must not return. Reload
  a bookmarked filtered URL and rerun a recent strict search. Reset during a
  slow search must prevent its late response from restoring old results.

## Upload result Reset

- **Completed results:** upload a disposable file or batch, then use Reset at
  the right of Upload result. The panel returns to its empty state without a
  browser refresh; imported documents remain in Library.
- **Partial failures:** reset after a mixed success/failure batch. Failed and
  pending staged rows and editable metadata remain available; completed results
  disappear. Already-imported files are not requeued by Reset.
- **Pasted text:** repeat with a pasted-text import.
- **Active work:** Reset is disabled while an upload is running, including after
  switching away and back. A subsequent completed upload should show only its
  new results.

## Scheduled backups

- **Compatibility:** the label is Backups to keep. Existing count-based mode,
  saved count, folder and cadence should remain unchanged. A fresh configuration
  still defaults to 7. Changing the label alone does not run or delete backups.
- **Opt in:** select Latest backup + previous backup and save. The count field
  shows 2 and is disabled in this mode; switching back restores the saved count.
- **First runs:** use Backup Now with an empty disposable destination. The first
  successful run creates latest; the second establishes previous. Settings lists
  both timestamps and filenames inside AdvisePoint-Scheduled-Pair.
- **Rotation:** after a third successful run, restore/test each retained ZIP in
  an isolated library. Verify metadata, search, retained PDFs/DOCX/RTF and stored
  page images. Check only the oldest pair-owned generation was retired.
- **Failures:** with disposable copies, test insufficient space, a disconnected
  destination, locked files, a corrupt new candidate and interruption/restart.
  Existing recovery copies must remain available; no old copy may be deleted
  simply to make room. Do not perform these tests on genuine backups.
- **Fallback:** a damaged latest must not replace a valid previous. If neither
  existing copy verifies, expect a refusal and preserved files for investigation.
- **Mode changes:** manual/historical files are not removed by pair mode.
  Switching settings alone does not delete them. A later count-mode backup
  still applies the configured count to matching dated archives in the parent
  folder; keep independent manual master copies in a separate folder.
- **Recovery record:** do not edit pair-state.json. Pending cleanup may leave
  extra files temporarily; verify a later successful run reconciles its owned
  interrupted generations. Report actual Windows file-lock/rename behavior on
  both architectures.

The pair is two full backups, not incremental storage or a permanent master.
Allow extra space for a new archive and extracted verification data. Keep an
independent copy on another drive.

## Regression and continuing field gates

- **PDF:** check normal, compatible restricted and older stored-page documents,
  including navigation, external-reader links, print preparation and a physical
  printer. No automatic library conversion is expected.
- **Metadata and Settings:** check DE title handling, type counts, Manage Product
  Lists and storage polling.
- **Lifecycle:** leave x64 Edge awake and idle at least four hours, then use
  Query, Library and update checking. Browser suspension differs from Windows
  sleep. Test final-tab closure, explicit Stop/cancel/busy refusal and relaunch.
- **Architecture:** exercise local in-place upgrading and backup behavior on
  both x64 and ARM64. Live GitHub OTA acceptance follows only after publication
  is separately authorized.

Known baseline: 14 TypeScript diagnostics and the `GENENZZ42` model /
`HyPASENCG` custom-code test failures. These are not newly claimed passes.
Export diagnostics promptly after a failure, recording the time, architecture,
browser, backup destination type and failed action. Logs can include paths and
filenames; review before sharing.
