ADVISEPOINT DOCS
===============

Local document search, viewing and library management.

SYSTEM REQUIREMENTS
-------------------

Use the x64 package on Intel/AMD 64-bit Windows and the ARM64 package
on Windows ARM64. Do not mix architectures. The runtime, database
engine, document parsers and open-source PDF compatibility converter
are bundled. No separate Node.js or PDF conversion browser is needed.

Allow about 500 MB for application files, plus space for the library,
temporary processing and backups. Actual library size depends on the
documents and any existing page images. Settings > System > Library
storage shows the current breakdown; there is no fixed size multiplier.
4 GB RAM is a practical minimum; 8 GB or more is recommended for
large documents. A laptop-size display is recommended.

The interface opens in the default browser at http://127.0.0.1:5000.
Use a current Edge, Chrome or Firefox version. Document processing
and search run locally. Internet access is needed for GitHub release
checks and update downloads, not normal library use.

QUICK START
-----------

1. Extract the complete ZIP into a writable local folder.
2. Keep the whole AdvisePoint Docs folder together. Do not run
   files from inside the ZIP.
3. Run "Start AdvisePoint Docs.bat".
4. Open the Welcome Guide in the library, or use Upload to add files.

"Setup Icon (run once).bat" creates shortcuts if desired. Windows
may warn about an unfamiliar downloaded launcher. Verify the package
origin and checksum before deciding whether to allow it.

Closing the browser tab leaves the local service running. Background
or suspended tabs do not trigger an automatic shutdown. Reopening
the launcher reconnects to the existing service.

To stop intentionally, use Settings > System > Diagnostics >
"Stop application". Confirm only after finishing uploads, printing,
external edits, backups and updates. Active tracked work blocks the
stop. No library data is deleted. Scheduled backups pause while the
service is stopped. Start the app again with its normal launcher.

INSTALL LOCATION
----------------

Keep the application in a writable local folder outside cloud-sync
folders, network shares and Program Files. Keep its files together
when moving it. Stop the service before moving application files.

Library data is stored separately under
%LOCALAPPDATA%\AdvisePoint Docs\.
Moving the application folder does not move or delete the library.
Do not manually change the data directory while the service is running.

UPDATING
--------

Settings > System shows the installed version and update controls
for official builds. "Check now" checks GitHub. An internet failure
does not mean the local library is unavailable.

Use the offered update action to download the matching architecture.
The updater validates the package before stopping the old service,
replaces the application files, restarts and checks the new service.
Keep the app folder writable and do not interrupt installation.

For a local package, use the ZIP update control in the same panel.
Select the complete binary ZIP for the installed architecture, not
the shared-source ZIP. Review the package information before confirming.
Keep an independent library backup before an upgrade.

If an update fails, read the displayed message and export diagnostics.
Do not delete the library to repair an update. A failed network check
can be retried later without restarting the local service.

ADDING DOCUMENTS
----------------

1. Open Upload and select or drop PDF, DOCX, RTF, TXT, MD or
   MARKDOWN files. The per-file limit is 150 MB.
2. Review the title, Product model, Product family and Document type.
   Product model is optional.
3. Add other useful metadata, then start the upload.

Folder selection and folder drag-and-drop include supported files in
subfolders. Unsupported and oversized files appear in the summary;
files are staged for review before import. Excel and PowerPoint
are not supported import formats.

"Fix Title" suggests readable wording from the stored original
filename. Review replacements for hand-edited titles. It also appears
in Library metadata editing when an original filename is available.
Filename-derived spacing avoids splitting ordinary words at DE.
Unfamiliar names may still need manual adjustment.

Tags autocomplete from existing values. Filename codes and phrases
suggest Document types without overwriting an explicit selection.
After import, searchable excerpts and metadata are stored locally.

PDF IMPORT AND PRINTING
----------------------

New normal PDFs retain one PDF and render pages on demand in the
viewer, rather than permanently storing a page image for every page.
Previously stored page images remain available; an upgrade does not
automatically convert or delete existing library documents.

For supported PDFs that permit printing but restrict copying, the
compatibility import uses the bundled open-source PDF converter.
It does not launch Chrome, Edge or Firefox to convert a document.
The converted PDF becomes the retained library copy; normal storage
does not keep both the original PDF and its converted duplicate.
Clickable links are preserved in the retained PDF where supported.
Use an external PDF reader for those links; the in-app viewer does
not add interactive links or bookmarks.

Compatibility is not universal. Damaged, unsupported or password-
protected files may still fail. Review the result and import only
documents that may lawfully be used. Do not assume every PDF is covered.

Use the viewer's print action to prepare the document. The app
provides the appropriate PDF handoff or rendered-page preparation for
the document. Complete printing in the browser or external reader
that opens. External-reader copies are temporary and are not counted
as active library storage.

Check page range, orientation, scaling and links before relying on
a printout. Large jobs can take time to prepare. Physical printer
behavior depends on the reader, printer and driver; broad physical
printing validation remains pending.

SEARCHING AND VIEWING
--------------------

Open Query, enter a question or phrase, and narrow the results with
Product model, Product family, Document type, confidentiality or tags.
Smart combines keyword and semantic matching. Phrase searches for
an exact phrase; Semantic searches by meaning.

Select a result to open its source document. Use the page controls,
scrollbar and zoom controls to navigate. In-document search helps
locate text inside the open document.

On-demand PDF pages may show a loading message. Existing page-image
documents remain viewable. A page retry control is available when
an image cannot be loaded. Reader capabilities depend on the format
and the text available in the document.

LIBRARY MANAGEMENT
------------------

Library lists the imported documents. Edit metadata to change a title,
product values, tags or other fields. Save commits the changes;
Cancel leaves the stored metadata unchanged.

Deleting a library document removes it from the active library and
keeps its retained recovery data according to the Recovery settings.
Deletion is not a promise that every byte is immediately erased.
Use Settings > Backup / Restore > Recovery to review retained items,
restore them or explicitly delete them permanently.

Duplicate handling groups matching file hashes and allows a keeper
to be selected. Review the affected documents before removing copies.
Do not assume that similarly named documents are identical.

External editing is available for supported retained editable files.
Save and finish the external editing session before stopping the app
or installing an update. Do not remove working files manually.

SETTINGS
--------

System:
  * Installed version and updates.
  * Library storage and viewer preferences.
  * Library maintenance on the left and Diagnostics on the right
    on wide windows; stacked on narrow windows.
  * Diagnostics includes export logs and Stop application.

Formats, in order:
  * Document types, including per-type document usage counts.
  * Manage Product Lists.
  * Filename codes.
  * Filename phrases.

Backup / Restore:
  * Backup and restore controls.
  * Recovery and pre-restore snapshots.
  * Duplicates and interrupted or failed renders.
  * Welcome Guide reinstall at the bottom.

Developer contains the metadata fields, filter mapping and examples.

Library storage refreshes about every 15 seconds while its panel is
mounted and the page is active. It is not an instantaneous counter.
Background browser throttling can delay refreshes. Reopening System
resumes polling; no manual refresh or application restart is required.

The active total includes retained files, the database, SQLite
working files and stored page images. Temporary external-reader
copies, logs, backups and retained recovery data are not the active
library total. SQLite files do not necessarily shrink immediately
after documents are removed.

DOCUMENT TYPES AND PRODUCT LISTS
-------------------------------

Settings > Formats > Document types supports renaming, recoloring,
reordering, merging and deleting types, with usage counts. Deleting
a type assigns its documents to the fallback Document type;
merge instead to preserve a specific classification.

Manage Product Lists is directly below Document types. Its Product
model and Product family lists come from values used by documents,
not a separate empty-list registry. Each entry shows usage.

  * Rename changes the value on affected documents.
  * Merge combines an entry with an existing value.
  * Delete reassigns the value or clears the field.

These changes keep the documents. Review the affected count and
make a backup before bulk changes; there is no single-click undo.

Filename codes are matched before Filename phrases. Phrases run when
no code matches. Both use the filename to suggest a Document type;
an explicit selection is retained.

BACKUP AND RECOVERY
------------------

Settings > Backup / Restore offers Quick Backup, Scheduled Backups
and Restore from Backup.

Quick Backup writes a library ZIP to the chosen folder. "Download
a copy" sends a backup through the browser instead. Backups include
the database, retained originals and stored page images.

Scheduled Backups allows a daily or weekly schedule and a retention
count. The local service must be running for the schedule to execute.
New backups are verified before older scheduled backups are pruned.
Keep the destination writable and allow enough free space.

Restore offers two modes:
  * Merge adds documents not already present by document ID.
  * Wipe replaces the live library, requires typed confirmation
    and keeps a pre-restore snapshot.

Restore stages and verifies the incoming backup before replacement.
Keep an independent backup and do not interrupt the operation.
Pre-restore snapshots are listed under Recovery and kept beside the
data directory. Manual snapshot recovery requires the service to be
stopped. A retained snapshot can help recover the previous state,
but it is not a substitute for an independent backup.

Recovery also lists removed documents. Review retention and any
optional automatic cleanup settings before enabling them. Permanent
deletion frees recovery storage and cannot be undone by that panel.

At the bottom of Backup / Restore, "Reinstall Welcome Guide" restores
the bundled guide to the library. Use it after updating when a fresh
copy of the guide is needed.

DATA AND TROUBLESHOOTING
-----------------------

The normal data folder is %LOCALAPPDATA%\AdvisePoint Docs\.
It contains advisepoint.db, originals, pages, recovery data and logs.
The data folder survives application updates and reinstallation.
Do not delete or reset it as a routine troubleshooting step.

If the interface cannot connect, wait briefly if an update is running,
then try the normal launcher. A connection warning does not establish
whether the cause is a crash, restart or other interruption.

Settings > System > Diagnostics > "Export logs for analysis" downloads
a diagnostic ZIP. It includes current and previous server logs,
update and backup records when available, and system information.
It excludes the library database and document contents, but logs can
contain filenames and local paths. Review the bundle before sharing.
Export promptly after a fault, before repeated restarts rotate logs.

If GitHub cannot be reached but Query and Library still work, retry
the update check later. This is separate from local-service health.
Do not clear library data or change security settings to repair a
network failure.

VERSION
-------

AdvisePoint Docs 1.3.2
Guide revision 1.3.2
Guide date: September 23, 2026
Native Windows field acceptance, long-idle Edge testing and physical
printing remain separate verification steps.
