# AdvisePoint Docs v1.3.2 testing guide

Use the matching x64 or ARM64 binary package. Keep a verified independent backup before testing an upgrade; the shared-source ZIP is not an updater package.

## Package and upgrade checks

- **Identity:** verify the ZIP against the supplied SHA-256 manifest. Confirm the architecture before extracting or choosing a ZIP update.
- **ARM64:** test the local ZIP drag-and-drop/in-place upgrade from the existing installation. Confirm the version is 1.3.2, the same library is present and an existing document remains searchable and viewable.
- **x64:** the supplied diagnostics already establish one successful GitHub upgrade from 1.3.0 to 1.3.1. GitHub upgrading to 1.3.2 can only be tested after its publication; until then use the matching local ZIP if desired.
- **Updater behavior:** package validation should complete before the service stops. Expect a brief reconnect during installation, followed by the new version. On failure, preserve diagnostics and do not clear library data.
- **Isolation:** release ZIPs contain only the production launcher, which uses the normal library and port 5000. Do not run it expecting a disposable library. Existing prototype port 5100 and separate test-launcher port 5101 remain unchanged. The former optional v1.3.1 test launcher used 5102 and is not bundled here. Request a separate isolated test setup if one is needed.

## Edge long-idle field test

Run this on Windows x64 first, then ARM64. Keep Windows awake; record whether Edge is foreground, background, minimized or has put the tab to sleep.

- **Starting state:** open a document and confirm that Query and Library respond. Note the start time.
- **Idle:** leave the app unused for at least four hours without putting Windows to sleep. Browser tab suspension is a separate condition worth recording, not evidence of computer sleep.
- **Return:** use Library and Query, then Check now in Settings > System. A failed GitHub request must not stop the local service.
- **Closed tabs:** close every app tab, wait more than ten minutes, then run the normal launcher. It should reconnect to the existing service and library.
- **Evidence:** if a failure occurs, export diagnostics immediately after recovery, before repeated restarts rotate the logs. Record the approximate failure time, Windows architecture, Edge version and which control failed.

The automated eight-hour injected-time test and accelerated real-server check do not replace this native Windows field test.

## Settings acceptance

- **Formats:** Document types comes first, followed immediately by Manage Product Lists, then Filename codes and Filename phrases. Confirm that Product family and Product model entries show usage counts.
- **Product edits:** in disposable documents only, rename a value, merge it into another value and delete it using reassignment or field clearing. Confirm the affected count and that the documents remain. Back up before bulk edits; no one-click undo is provided.
- **System:** Library maintenance is on the left and Diagnostics on the right at a wide width. They stack at narrow widths. Run a read-only scan and export diagnostics.
- **Backup / Restore:** Welcome Guide reinstall is the last panel. Reinstall it and confirm the guide identifies v1.3.2 and the new Settings locations.
- **Storage:** add a disposable document and return to System. Allow at least 15 seconds with the panel active, then verify the storage figures refresh. Repeat after removing the disposable document. Do not expect SQLite allocation or retained recovery bytes to disappear immediately.

## Stop application

- **Cancel:** open Stop application, then Cancel. The app should remain available.
- **Busy refusal:** while a supported tracked operation is active, stopping should be refused with an explanation. Do not deliberately interrupt real production writes to test this.
- **Confirmed stop:** finish work, then confirm Stop application. The initiating tab should show that the application was intentionally stopped. Other tabs lose their connection because the shared service has stopped.
- **Restart:** use Start AdvisePoint Docs. Confirm the library is unchanged and scheduled backups are available again.
- **External printing:** finish the external reader/printer job before stopping. The app can track preparation, not every printer queue or external reader process.

## PDF and metadata regression checks

- **Normal PDF:** upload a disposable unrestricted PDF; view multiple pages, search, prepare a print range and open the result.
- **Restricted PDF:** repeat the previously successful printable, copy-restricted example. Confirm a compatible retained PDF, no conversion-browser launch and working links in an external PDF reader.
- **Existing documents:** check a previously retained PDF and an older stored-page document. No automatic library conversion should occur.
- **Metadata:** check a filename affected by the DE splitting correction and confirm Document Type counts update after import, reassignment and recoverable removal.
- **Printing:** confirm page range, count, orientation and scaling in preview and on a physical printer. Report the reader and driver used. Broad physical-printing acceptance remains pending.

## Known limits and remaining backlog

The earlier Edge failure is not fully captured in the uploaded logs. Its cause cannot be certified from the available evidence, and broader Windows reliability remains a field test.

There are 14 pre-existing TypeScript diagnostics and two baseline custom filename-code test failures involving joined EN/custom-code names. The new Settings and lifecycle checks do not resolve those unrelated cases.

Excel/PowerPoint-to-PDF import is deferred. No reset/delete-all tool is included, and no production library should be reset, deleted or converted as part of these tests.
