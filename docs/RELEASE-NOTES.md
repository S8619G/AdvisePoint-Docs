# AdvisePoint Docs v1.3.2

This release reorganizes Settings and removes automatic shutdown caused by missing browser heartbeats. It continues from v1.3.1 and does not migrate, reset or convert an existing library.

## Changes

- **Long-idle reliability:** a quiet, backgrounded or suspended browser tab no longer causes the local service to exit. Closing all browser tabs also leaves the service running.
- **Intentional shutdown:** Settings > System > Diagnostics now includes Stop application. Confirmation explains that the stop affects every tab and pauses scheduled backups. Tracked writes, rendering, print preparation, PDF compatibility preparation, backups, restore, external editing and update activity block the stop.
- **Connection reporting:** heartbeat absence and recovery are logged without inferring that Windows slept. A connection warning describes an unavailable service rather than asserting that it crashed.
- **Manage Product Lists:** moved from System to Formats, directly below Document types and before Filename codes. The card, button and dialog share the new name. Product family/model counts, renaming, merging and delete-with-reassignment retain their existing behavior.
- **System layout:** Library maintenance and Diagnostics share a two-column row on wider windows and stack on narrow windows.
- **Welcome Guide:** reinstall moved to the bottom of Backup / Restore. The bundled Guide and README have been refreshed, including current PDF storage, printing, Settings navigation and retention wording.
- **Package hygiene:** no reset/delete-all utility, prototype launcher or isolated-test launcher is included in release ZIPs. Automated regression tests remain in shared source. Guide-generation failure now blocks packaging instead of silently shipping a stale guide.

## Features retained from v1.3.1

- **Browser-free PDF compatibility import:** supported printable, copy-restricted PDFs are prepared with the bundled open-source converter, not Chrome, Edge or Firefox. The retained compatible PDF replaces the input as the library copy, rather than keeping duplicate original and converted PDFs.
- **PDF viewing and printing:** new normal PDFs retain their PDF and render on demand. Existing stored-page documents remain supported. The redundant PDF-opening choice and unwanted successful-opening popup remain removed.
- **Links:** the compatibility path preserves links in the tested retained PDFs. Use an external reader for those links; the in-app viewer does not gain clickable links or bookmarks.
- **Metadata and recovery:** the DE word-splitting correction, Document Type usage counts and recoverable-deletion wording remain in place.
- **Updates:** official builds retain GitHub and local-ZIP update controls. The architecture-aware updater and its validation-before-shutdown path are unchanged.
- **Library storage:** Settings polls approximately every 15 seconds while active. Browser background throttling can delay updates. No manual refresh or app restart is required; database and retained recovery storage do not necessarily shrink when a document is removed.

## Scope and verification limits

The supplied x64 diagnostics show a successful v1.3.0-to-v1.3.1 GitHub upgrade and healthy restart. The earlier four-hour Edge incident is no longer present in the rotated logs, so its exact cause remains unconfirmed. This release removes a demonstrated failure path; it is not a claim that every possible disconnection is fixed.

Automated and isolated-browser verification is described separately. Native Windows long-idle Edge testing, ARM64 local-ZIP/in-place upgrade, x64 updater acceptance for this release and physical printing remain field gates. Not every PDF is supported.

TypeScript still has 14 pre-existing diagnostics. Two older custom filename-code tests also fail unchanged on v1.3.1 and are tracked separately; neither is represented as a new regression or a pass.

Excel/PowerPoint import-to-PDF remains a backlog item and is not implemented. Production remains on port 5000; separate prototype/test environments are not repointed or altered by this release.
