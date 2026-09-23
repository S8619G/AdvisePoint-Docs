AdvisePoint Docs
================

v1.3.1
-------------------------
September 23 PDF-controls revision: the whole-document print handoff has one
Open PDF action plus Download. Successful opening in the PC PDF app no longer
shows a pop-up message; opening failures still show an error.

Eligible copy-restricted PDFs are prepared automatically by a bundled open-source
PDF engine, without Chrome, Edge or Firefox. Import only documents you are
authorized to use. Opening-password and no-print restrictions are not bypassed.
After page and text validation, only the compatible PDF is retained, not two PDFs.
The file you selected is untouched. Normal PDFs remain byte-identical.
Conversion is bounded to 150 MiB, 2,000 pages and ten minutes. A refused conversion
keeps an explicit rendered-page fallback where permitted; it is never automatic.
Compatible PDFs can retain links and bookmarks, but the in-app page viewer has
not gained link navigation or a bookmark panel. Use your PDF reader for those.
The DEALER/DEVICE/DESIGN filename spacing issue is corrected.
Document Type counts refresh after library changes.
Deletion wording now explains recovery. Native PDF recovery restores page
geometry as well as the file, including compatible-PDF provenance.
Manually removed documents do not have a day-based expiry: restore them in
Settings > Backup/Restore > Removed documents until permanently deleted there.

This final build uses the normal working library and port 5000.
For isolated acceptance testing, run "Start isolated v1.3.1 test.bat" instead.
It uses port 5102 and a separate "AdvisePoint Docs v1.3.1 Test" data folder.
It leaves production and v1.3.0 test data untouched; updates cannot run there.
Normal update controls are restored. Extract into a new folder for first use.
No library is automatically reset, converted or deleted.
Protected native PDFs no longer silently open the full original for ranges.
Unrestricted ranges copy selected PDF pages directly. Print-permitted encrypted
PDFs produce temporary selected-page image PDFs at their allowed print quality.
No-print files remain blocked. Stored originals are unchanged. Whole native
manuals keep direct handoff. Choose All pages in the prepared subset's reader.
Print-range number entry: click to select the whole number,
clear it and type a new page. Zero and arrow keys edit fields instead of
triggering viewer shortcuts. Background page tracking preserves the range.
Rendered selections of 51 or more pages open the unchanged original PDF.
Selections of 1-50 pages keep the existing preparation flow.
New rendered imports also keep their original. Older image-only imports can
attach their exact source file after fingerprint verification, without reimport.
The extracted-text toolbar now has a Download original PDF icon, visible only
when the retained original is available. It saves the intact source file.
Both PDF print flows prepare inside the viewer, without an extra browser
confirmation or preparation tab. The dialog stays open after reader handoff.
Click Done after finishing in the reader: job-owned temporary files are
released, with retry if a transfer or file lock prevents removal. Library
documents and downloaded copies remain; the reader tab is not closed.
Rendered-PDF preparation runs in a separate process. Ready
requires a complete file and a clean process exit. A worker failure should
leave the library server available for retry. Progress/exit diagnostics are
saved automatically. Faster lossless pixel conversion is preserved.

NEW IN 1.3.0
New PDF imports retain their original PDF bytes, searchable embedded text
and page geometry. PDF.js renders a bounded in-memory page window locally;
there are no permanent page images for these imports. Existing image-only
documents remain supported, untouched and unconverted.
The compact print preview, original-PDF download and Open original PDF use
retained-PDF viewer behavior. External-reader edits affect only a
temporary copy, not the library. Selection copy/print and the Settings storage
breakdown are included. Retained PDFs no longer have a 20-page printing cap.
All in-app selections use a PDF handoff. Selections use a
temporary PDF or the unchanged original for whole-manual printing. Click
Open PDF to print, then use that PDF reader's Print button. Protected ranges
prepare selected-page image PDFs when printing is permitted. If you explicitly
open the original instead, select the original page range in that reader.
Rendered-page printing prepares a temporary PDF one saved image at a time.
Wait for all selected pages to be ready, then choose Open prepared PDF,
Download, or Open in PC PDF app. Nothing prints automatically. Missing pages
stop preparation instead of being skipped. Cancel and Prepare again recover
from failures. A one-minute warning, ten-minute deadline and 1 GiB temporary
output budget apply; allow 1.2 GiB free disk space. This does not change the
library images or add OCR. Use Fit to paper for very old rendered libraries.
PDF fallback drawing and encoding now
run in a dedicated worker so viewer requests are not blocked by that work.
Image quality and the one-document-at-a-time queue remain unchanged.
Opening-password files are rejected before import. Copy-restricted PDFs that
permit full-quality printing can be imported with an explicit rendered-page
fallback. Its confirmation explains legacy searchable-text extraction,
slower preparation and larger library/backup storage. This mode stores page
images alongside the unchanged original; keep your source file. PDF permission
settings are not changed. Scanned documents still require OCR before import.

Persistent bounded upload journals record each import. Settings > Export diagnostics includes upload
filenames, sizes, correlation IDs, stages and results; no separate diagnostic
launcher is needed. The upload journal excludes document text and metadata.
Review exported diagnostics before sharing. Existing documents are preserved
unless a separately confirmed maintenance operation is performed.

A local search tool for technical manuals and admin guides.
Everything runs on your own laptop. No internet connection required
after install.

The library starts empty. Upload your own PDFs, DOCX, RTF, TXT, or
Markdown files from the Upload tab and they're indexed locally on
your machine.


SYSTEM REQUIREMENTS
-------------------

Check these before you install so nothing surprises you later.

Operating system

  * Use the x64 package on supported Intel or AMD 64-bit Windows
    systems, or the ARM64 package on Windows ARM64 systems.
    Do not mix packages or copy one architecture over the other.

Disk space

  * About 500 MB free for the app folder itself.
  * Additional room in %LOCALAPPDATA%\AdvisePoint Docs\ for your
    library. A rough guide: budget 3-4x the total size of the
    documents you plan to upload, which covers the SQLite database,
    rendered page images, and the original files kept for viewing.
  * If you use Scheduled Backups, budget extra room for the
    backup destination folder as well - retention keeps N ZIPs on
    disk, each roughly the size of your current library.

Memory

  * 4 GB RAM minimum, 8 GB recommended if you plan to upload large
    PDFs (500+ pages) or work with several hundred documents.

Display

  * 1366 x 768 or larger. The Library, Query, and Settings pages
    are designed for a laptop-class screen; smaller windows still
    work but the filter rail may compress.

Browser

  * The app runs in your default web browser at
    http://127.0.0.1:5000 . Modern Chromium-based browsers
    (Chrome, Microsoft Edge) and Firefox are supported. The
    in-app PDF viewer and the Ctrl+F in-document search need a
    current browser build; Internet Explorer is not supported.

Network

  * No internet connection is required after install. All
    parsing, indexing, and searching happen locally on the same
    machine.
  * Optional outbound access to github.com is used only when you
    open Settings > System to check for a newer release, or when
    you install one via the built-in updater.

Permissions

  * A regular Windows user account is enough. No administrator
    rights are required to run the app or to install updates - the
    updater writes into the app folder you extracted, and the
    library lives under your own %LOCALAPPDATA% .
  * You need normal write access to the folder you extracted the
    app into and to your %LOCALAPPDATA% . Shared or read-only
    locations are not suitable install targets.

What's bundled - nothing extra to install

  * The Node.js 20 LTS runtime the server needs is shipped inside
    the app folder. There is no separate Node.js install to
    manage.
  * The SQLite database engine, PDF extractor, and DOCX/RTF
    parsers are all included. The app does not download runtime
    components at first launch.

Optional: SmartScreen and antivirus

  * See "Setup Icon (run once).bat" in Chapter 2 and the
    Troubleshooting chapter for the one-time SmartScreen prompt
    and antivirus exclusion notes. Neither is a hard requirement
    but both make the first launch smoother.


QUICK START
-----------

1. Extract this folder somewhere convenient, for example:
      C:\Tools\AdvisePoint Docs

2. FIRST TIME ONLY: Double-click "Setup Icon (run once).bat"
   This does two things:
     a) Clears Windows' "downloaded from the internet" flag from
        every file in the folder. This removes the SmartScreen
        popups you'd otherwise see every time the app launches.
     b) Creates an "AdvisePoint Docs" shortcut with the app icon
        that launches the app with no command window.
   You may see ONE "Windows protected your PC" popup for this
   .bat itself - click "More info" then "Run anyway". After it
   finishes you shouldn't see the popup again.

   Even if you skip step 2 and launch the app directly, "Start
   AdvisePoint Docs.bat" will self-unblock the folder on first run
   so the SmartScreen popup only shows up once instead of on every
   launch.

3. Double-click the new "AdvisePoint Docs" shortcut. Your browser
   opens at http://127.0.0.1:5000 with the app already loaded.
   No command window appears - the server runs invisibly in the
   background.

4. When you are done, close the browser tab. To fully stop the
   server, right-click the AdvisePoint Docs entry in Task Manager
   and choose End Task, or just log off / restart your PC.

Optional: after step 2, you can drag the "AdvisePoint Docs"
shortcut to your Desktop or right-click and Pin to Taskbar for
one-click access.

If the shortcut doesn't work for any reason, you can always fall
back to double-clicking "Start AdvisePoint Docs.bat" - same result.

Your database lives in %LOCALAPPDATA%\AdvisePoint Docs\ so any
documents you upload stick around between sessions.


UPDATING
--------

You have two ways to install a new build:

  * IN-APP UPDATER (recommended for point releases)
    Open Settings > System. If a newer release is on GitHub the
    panel shows the version and release notes. Click "Update now"
    and the app chooses the package for the installed architecture.
    It downloads, checks the selected package's SHA-256, extracts
    and validates version and architecture BEFORE stopping the
    server. A bad download leaves the running application available.
    Once validation passes, it shuts down cleanly and installs.
    It never touches an unrelated process that
    happens to use port 5000. When the swap is complete the updater
    relaunches the app automatically - no extra window to close, no
    manual restart.

    You can also drag-and-drop a downloaded ZIP directly onto the
    Updates panel to install it without going to GitHub. Handy for
    a hotfix build that isn't a public release, or for machines
    that can't reach github.com.

  * COMMAND-LINE UPDATER
    Double-click "Update AdvisePoint Docs.bat" in the app folder.
    Same fetch, verify, and swap as the in-app path, run from a
    console window instead. Useful if the app won't start at all.

Whichever path you use, your database, uploaded documents, saved
searches, and settings under %LOCALAPPDATA%\AdvisePoint Docs\ are
never replaced. During replacement the updater keeps a verified
recovery copy of managed application files, including launchers,
modules and version markers. A failed replacement restores them
and tries to restart the previous application if it stopped it.
If recovery cannot finish, its folder is retained and update.log
identifies it; do not delete that folder or overlay more files.
The existing dist.bak is also retained after successful updates.

IMPORTANT WHEN INSTALLING 1.3.1 FROM AN OLDER BUILD:
The currently installed updater performs that first upgrade.
On ARM64, download AdvisePoint-Docs-v1.3.1-arm64.zip, leave it
zipped, and select Settings > System > Install from a local zip.
Click "Upgrade to v1.3.1 now" after validation. Architecture-aware
automatic selection is present in the v1.2.8 and later updater.
For manual downloads on either architecture, the application opens
the release page rather than guessing which download is suitable.
Windows field testing is required before public release.

POST-RESTORE GUIDANCE (new in 1.2.3)

When a restore finishes, the app now shows a completion dialog that
spells out what happened, where the pre-restore snapshot lives (for a
Wipe & Replace restore), and how the Recovery panel's "Delete all"
action interacts with the restore. Delete all in Recovery operates on
the library that exists AFTER the restore, so it removes what the
restore just added -- it does not undo the restore or return you to
the pre-restore state. To roll back, close AdvisePoint Docs, rename
the timestamped .bak folder next to your data directory over the
current data folder, and restart.

The same information is preserved to a small file next to your data
directory (AdvisePoint Docs.last-op.json) so that if the app is
force-closed before you dismiss the dialog, the next time you open
the Settings > System tab, a banner surfaces the same message. The
banner appears at most once per restore and is removed as soon as
you see it.

UPDATER --allow-same-version FLAG (new in 1.2.3)

The command-line updater accepts --allow-same-version to permit
reinstalling the same version that is already installed. Downgrades
remain refused. Intended for developer repairs of a corrupted install
and for reproducing a build during testing without having to bump
the version number.

Example:

  "C:\Program Files\AdvisePoint Docs\update.exe" --local-zip C:\Path\To\AdvisePoint-Docs-1.2.3.zip --allow-same-version

LOCAL-ZIP INTEGRITY CHECK (new in 1.2.2)

When you drop a downloaded update zip onto the Updates panel or
point the command-line updater at one, the updater now verifies the
file before touching your installation:

  * If a companion hash file (<zipname>.sha256 or SHA256SUMS.txt)
    sits in the same folder as the update zip, the updater hashes
    the zip and refuses to install on mismatch.
  * If no companion hash file exists, the updater walks the entire
    zip once and verifies every entry without writing anything.
    Any corrupt entry stops the install cleanly before your app
    folder is touched.

On failure the updater prints an explicit "the update file on your
disk is damaged" message with the mismatched hashes (or the failing
entry name), and instructs you to redownload rather than retry
against the same corrupt copy. This addresses the failure pattern
where an in-flight file corruption -- from a bad USB thumbdrive,
network share, or interrupted download -- surfaced only after the
updater had begun extracting, and read to users as a generic "try
again" prompt.

TRANSFERRING THE UPDATE ZIP TO AN OFFLINE MACHINE

If you need to move the update ZIP from one machine to another --
for example, because the target laptop can't reach the internet
during the install -- treat the transfer as untrusted and verify
the copy before you install.

Good transfer methods, most reliable first:

  * Direct download on the target machine. Skips every intermediate
    step. Preferred whenever the target can reach the download page.
  * Cloud drop (OneDrive, Dropbox, Google Drive, iCloud Drive).
    Upload from the source machine, download on the target. These
    services verify bytes end-to-end on both transfers.
  * SMB network share between the two machines on the same trusted
    network.

Acceptable, but verify afterwards:

  * USB thumbdrive formatted as exFAT or NTFS with a full format
    (not a quick format). Cheap or old thumbdrives can silently
    return bad bytes on the largest files inside the ZIP, and the
    updater will refuse to install a damaged file rather than write
    a broken binary to your app folder. Ejecting the drive properly
    is required but not sufficient - the stick itself has to be
    healthy.

Avoid:

  * USB thumbdrives formatted as FAT32. FAT32 has no journaling
    and no per-block integrity, and the observed failure mode of a
    corrupt ZIP arriving at the target machine has always traced
    back to a FAT32 stick when USB was involved.

How to verify the copy is intact (recommended for any USB transfer):

  1. On the SOURCE machine, right after downloading, open PowerShell
     and run:
         Get-FileHash "<path-to-zip>" -Algorithm SHA256
     Copy the 64-character hash somewhere.
  2. On the TARGET machine, after the copy arrives, run the same
     command against the copy. Compare the two hashes character
     for character.
  3. If the two hashes match, install with confidence. If they
     differ, the file was corrupted somewhere in the transfer -
     do NOT run the updater against the damaged file. Redownload
     or use a different transfer method.

A <zipname>.sha256 file shipped alongside each release makes step 2
trivial: run Get-FileHash on the target machine and compare it to
the one line inside the .sha256 file.

If you install without verifying and the updater refuses the ZIP
with the "update file on your disk is damaged" message, the
transfer is the first place to look - not the build. The same
shipped build has already installed successfully on other machines.


INSTALL LOCATION - RECOMMENDED FOLDER SETUP
-------------------------------------------

Extract the AdvisePoint Docs folder to a plain local path like:

      C:\AdvisePoint Docs\
      D:\AdvisePoint Docs\
      C:\Tools\AdvisePoint Docs\

Do NOT extract or move it into:

      OneDrive              (personal or business)
      Dropbox
      Google Drive
      iCloud Drive
      Box / Box Sync
      Any network path starting with \\server\share

Why this matters:

  * Cloud-sync tools can mark files as online-only placeholders. When
    the app or your browser tries to open one, the sync client has to
    fetch it first, which can time out or fail silently.
  * Corporate OneDrive tenants often apply Data Loss Prevention (DLP)
    rules that block uploads to loopback services like this app.
    Symptom: the Upload tab shows "Failed to fetch" and no request
    ever reaches the server.
  * Sync clients hold short-lived file locks while a file is being
    written. Backups written into a sync folder can corrupt mid-write.
  * Files inherit the Mark-of-the-Web from the sync source, so
    SmartScreen popups keep coming back even after Setup Icon.

The app auto-detects the most common problem paths and shows an
amber banner at the top of the window when it's running from one
of them. The banner links back here and can be dismissed per
location. It reappears if you later move the app to a different
problem folder.

If the app is already installed inside a cloud-sync folder:

  1. Close the app (Task Manager -> AdvisePoint Docs -> End task, or
     right-click the taskbar icon -> Close).
  2. Move (not copy) the "AdvisePoint Docs" folder to a plain local
     path like C:\AdvisePoint Docs\ .
  3. Re-run "Setup Icon (run once).bat" from the new location so the
     desktop shortcut points at the right place.
  4. Launch the app. Your uploaded documents are unaffected because
     they live in %LOCALAPPDATA%\AdvisePoint Docs\ , which is outside
     the app folder and outside typical cloud-sync paths.


ADDING YOUR OWN DOCUMENTS
--------------------------

1. Click the Upload tab.
2. Drag a PDF, DOCX, RTF, TXT, or Markdown file onto the drop zone
   (or click the drop zone to browse for one).
3. Check the Product model field. AdvisePoint Docs suggests one
   from the filename; correct it if needed, or leave it blank for
   documents that aren't model-specific. This is what makes
   filtered searches work later.
4. Fill in whatever other metadata is useful - product family,
   firmware version, document type, confidentiality level,
   audience, tags.
5. Click Upload.

The file is parsed, split into searchable excerpts, and indexed
locally. Nothing is uploaded anywhere. Max file size is 150 MB.

Tip: the Tags field autocompletes from tags you've used before, so
similar documents end up with consistent labels.

Use Select folder... to choose a whole folder, or drag a folder onto
Upload. Both paths gather PDF, DOCX, RTF, TXT, MD, and MARKDOWN files
from its subfolders, up to 150 MB per file. Unsupported and oversized
files are listed in a summary; hidden files and OS bookkeeping entries
are ignored. Files are staged for review before upload.

Fix Title is available beside Title on Upload and in the Library's
Edit document dialog. It suggests a readable title from the original
filename, never from the current title. If the title was hand-edited,
compare the current and proposed wording before choosing Replace.
The button remains available after use, and repeated clicks give the
same suggestion. Older documents without a stored filename do not
show the button. In Library, Save commits the edited title; Cancel
leaves the document unchanged.

Joined task words such as CloudPrintandScan become Cloud Print and Scan.
This uses conservative matching for "and"; unfamiliar compounds may still
need manual spacing rather than risking changes to ordinary words.


SETTINGS
--------

Settings has four tabs, in this order:

  * System - installed version and updates, viewer preferences,
    Welcome Guide and Manage values side by side on wide windows,
    Library scan, and diagnostics. A pending restore notice appears
    first when present.
  * Formats - Document types, Filename codes, and Filename phrases.
  * Backup / Restore - backup controls, Recovery (including pre-restore
    snapshots), duplicates, and interrupted or failed renders.
  * Developer - Fields, Filter mapping, and Examples on one page.

System opens by default. This organization changes where controls
appear, not the saved settings or library data.


SEARCHING
---------

1. Click the Query tab.
2. Type a natural-language question like:
      "How do I configure LDAP authentication?"
      "What are the paper size limits on the MZ9500ci?"
      "Steps to reset the fuser count"
3. Use the filter panel on the left to narrow results.
4. Match mode:
      Smart    - blended keyword + semantic (default; recommended)
      Phrase   - exact-phrase match
      Semantic - meaning-based match only

Filters available on the left rail:

  * Product family  - the top-level product line the document
    belongs to. Independent from Product model, so you can pick
    any family/model combination. Documents that don't have a
    family recorded are always included when a family is picked,
    so older uploads that pre-date the field don't drop out. The
    filter is hidden when no document in your library has a
    family recorded.
  * Product model
  * Document type   - Service Guide, Admin Guide, Release Notes, etc.
  * Confidentiality - public / internal / restricted ceiling
  * Tags            - free-form labels you set at upload time

Each result shows a relevance score, the excerpt of text that
matched, and the source document. Your search terms are
highlighted in amber in the result text so you can spot them at a
glance. Click "Show metadata" to see the full record.

PDF PAGE SCROLLING:

Drag the vertical scrollbar, use the mouse wheel, or enter a page number
to move through a rendered PDF. The viewer loads the pages at the current
scroll position and a small nearby buffer, including after large jumps.
Page-number, Next/Previous, and search-result jumps move immediately.

A brief "Loading page" message can appear while a page image loads.
If an image fails to load, use its "Retry page" button. "Rendering page"
means the local renderer is still preparing that page. Zoom Page and
window resizing preserve the reading position.

DOCUMENT VIEWER (in-document search):
   Click a result to open the source document in the viewer. A
   small badge in the top-right of the viewer tells you the file
   type (PDF / DOCX / RTF / TXT / MD). Use Ctrl+F to search
   inside the open document; matches are highlighted the same way
   as query results.


LIBRARY MANAGEMENT
------------------

Click the Library tab to see everything you've uploaded.

  * Edit metadata           - click any document to edit its title,
                              tags, confidentiality, and other
                              fields.
  * Delete a document       - moved to Recovery (see below), never
                              hard-deleted until you say so.
  * Find duplicates         - the "Find duplicates" button scans
                              the library for documents with the
                              same SHA-256 file hash. Groups are
                              shown side-by-side; you pick which
                              copy to keep.
  * Manage values           - the "Manage values" button lists every
                              product model and product family in
                              use, with how many documents use each.
                              Rename one to fix a misspelling
                              everywhere at once, or rename it onto
                              an existing value to merge the two.
                              You are shown how many documents will
                              change before anything happens.

The Library list refreshes on its own whenever another panel
changes what's in the library (a restore from Recovery, a merge
restore, an auto-cleanup sweep). No manual reload needed.


DOCUMENT TYPES
--------------

Settings > Formats contains the Document types list you can tag a document
with. Each row can be renamed, given an accent color, reordered,
merged, or deleted.

  * Renaming             - fixes the name everywhere at once. Any
                           filename code pointing at that type follows
                           the rename automatically.
  * Merging              - the merge button folds one type into
                           another and re-tags every document that
                           used it. Use this for near-duplicates such
                           as "User Manual" and "User Guide".
  * Deleting             - removes the type and puts its documents
                           back on the plain "Document" type. If you
                           want to keep the tagging, merge instead.

New type names are capitalized for you, so typing "technical
bulletin" stores "Technical Bulletin". Acronyms such as API, MFP and
PDF keep their capitals, and names with deliberate mixed case such as
HyPAS or MZ9500ci are stored exactly as you type them.

BELOW the Document types list you'll find two editors that teach the
uploader to guess a Document type from the filename:

  * Filename codes   - short letter/digit codes such as OG, SB, or
                       TB1 that map to a Document type. Matched on
                       whole tokens.
  * Filename phrases - full phrases such as "user guide" or "release
                       notes" that map to a Document type. Matched
                       on whole words after normalizing case and
                       punctuation. Longest matching phrase wins.

Codes are checked first. Phrases run only when no code matches, so a
code you added won't be second-guessed by a phrase. Neither one ever
overwrites a Document type you already picked yourself; both only
run when the Document type is still blank or on the "Document"
fallback. A fresh install ships with seven default phrases (User
Guide, Admin Guide, Installation Guide, Quick Start, Release Notes,
Troubleshooting Guide, Security Guide) that you can edit or delete
any time from Settings > Formats > Filename phrases.


MANAGING VALUES
---------------

Product model and Product family are free-text fields on each document,
so near-duplicates like "PA6000x" and "PA6000x Series" can silently
split your filter results. Manage values gives you one place to fix
them: Settings > System > Manage values.

  * Rename         - typing a NEW name renames the value on every
                     document using it.
  * Merge          - typing an EXISTING name folds the two values
                     together, so "PA6000x" and "PA6000x Series"
                     become one.
  * Delete         - opens a small reassign dialog. Pick another
                     existing value to merge into, or clear the
                     field on the documents that used it. A delete
                     never loses a document -- it just moves the
                     value in a way you explicitly chose.

Every change updates every affected document at once. There is no
undo step, so export a backup first from Settings > Backup /
Restore if you want a restore point.


MANAGING DUPLICATES
-------------------

Uploading the same PDF twice, or merging in a backup that
overlaps with your current library, both leave duplicates around.
AdvisePoint Docs handles them non-destructively:

  1. FINDING - the Library "Find duplicates" scan groups files by
     SHA-256 hash. When there are no groups to show, the panel
     stays hidden so it doesn't take up space in the sidebar.

  2. CHOOSING A KEEPER - every group lists its copies newest first,
     with the date each one was added, whether it has rendered
     pages, and how many chunks it holds. One is pre-selected as
     the "keeper" (typically the one you can actually view - the
     original file still on disk with its rendered pages intact),
     and the newest copy is labeled so it is easy to spot. Select
     any other copy to keep that one instead; the KEEP and
     QUARANTINE labels update as you choose, so you can see the
     outcome before anything moves. The files in a group are
     byte-for-byte identical, so this is really a choice about
     which record to keep - its title, document type, tags,
     product values, and date added. If you re-uploaded a file
     after correcting its details, keep the newer copy. The other
     copies are removed from the library but not destroyed.

  3. WHERE THE REMOVED COPIES GO - every removed duplicate is moved
     into %LOCALAPPDATA%\AdvisePoint Docs\deleted\<timestamp>-<id>\
     with a manifest and the original file. Everything stays on
     disk under a name you can find.

  4. GETTING ONE BACK - open Settings > Backup / Restore > Recovery. The "Removed
     documents" list shows every quarantined document with its
     size and when it was removed. Click Restore to bring one back
     into the live library. Restore is a stage-verify-swap: the
     server unpacks the copy alongside the live data, verifies
     everything is intact, and only then puts it back. If a
     document with the same id is already in the library, the
     restore refuses instead of overwriting.

  5. PERMANENTLY DELETING - the Recovery panel also has a per-item
     Delete button for a quarantined document you're sure you
     don't need. It asks for a confirmation and then frees the
     disk space.

  6. OPT-IN AUTO-CLEANUP - the Recovery panel has a toggle labeled
     "Auto-cleanup quarantined duplicates". Off by default. When
     on, the app periodically sweeps ONLY quarantined DUPLICATES
     whose keeper is still present in the library, still matches
     by SHA-256, and is still viewable. Non-duplicate quarantined
     documents are never touched by the sweep. There's also a
     "Run cleanup now" button when the toggle is on.

Nothing about this pipeline is destructive: every step keeps the
original bytes on disk until you explicitly say "delete
permanently" or turn on the opt-in sweep.


BACKUP AND RECOVERY
-------------------

Backups live under Settings > Backup / Restore, laid out as three cards
side-by-side.

QUICK BACKUP (Column 1)
   Pick a folder and click "Backup Now" - the whole library
   (database + rendered pages + originals) is packed into a
   timestamped ZIP written to that folder.

   The folder input has a Browse button that opens the native
   Windows folder picker (the same one you get from Save As in
   other apps). If a folder is already typed, the picker opens
   there; otherwise it uses the last folder you picked for Quick
   Backup, then falls back to Documents. You can still paste or
   type a path directly if you prefer.

   A live preflight strip under the input tells you at a glance:
     * whether the folder exists and is writable
     * how much free space is there vs how much the backup needs
     * whether the folder lives inside OneDrive / Dropbox /
       Google Drive / iCloud / Box - if so you get a plain-language
       warning and a checkbox to acknowledge you understand the
       risk (sync clients can lock files mid-write).

   "Download a copy" is a secondary button that sends the ZIP
   through the browser to its default download location, without
   writing to the folder above. Handy for grabbing a copy on a
   machine where you don't have write access to the chosen folder.

SCHEDULED BACKUPS (Column 2)
   Pick a destination folder, a cadence (daily / weekly), a time
   of day, a weekday (weekly only), and a retention count (how
   many backups to keep before the oldest is deleted). The folder
   picker works identically to Quick Backup, with its own
   "last folder picked" memory so the two Browse buttons don't
   share a starting point.

   Click "Save schedule" to activate it. The bottom of the card
   shows the last run's time, status, and size, plus an estimated
   next-run time. If the last scheduled run failed, a persistent
   amber banner appears above the card with plain-language failure
   details and a Try again button.

   "Backup now" on the scheduled card runs an immediate scheduled-
   style backup against the scheduled folder - so if you turn on
   scheduled backups for the first time you can get a baseline
   without waiting for 2 AM.

   Retention prunes only after a NEWER backup has been written
   AND verified. If the new run fails, the previous backups stay
   put - you're never left with only a broken one.

   Scheduled runs write their own log at
   %LOCALAPPDATA%\AdvisePoint Docs\backups.log so you can look
   back at what ran when even after several rotations.

RESTORE FROM BACKUP (Column 3)
   Click "Choose file" (native OS file picker), pick a
   previously-created backup ZIP, then pick a restore mode:

     * Wipe - replaces the live library with the backup. Asks for
       a typed confirmation. Uses stage-verify-swap under the
       hood: the backup is unpacked into a temporary directory
       alongside the live data, verified, THEN the swap happens.
       If verification fails, nothing is replaced. A pre-restore
       snapshot of the previous data set is kept as
       %LOCALAPPDATA%\AdvisePoint Docs.bak-<timestamp>\ so you
       can put things back if the restore was a mistake.

     * Merge - adds documents from the backup that aren't in the
       live library. Documents already present in the live
       library (matched by id) are skipped, not overwritten.

   Library, Recovery, and the header counters all refresh on their
   own when the restore completes - no manual page reload.

   Restores work across machines, Windows accounts, and
   architectures. From 1.2.1 on, a backup taken on one PC can be
   restored on any other supported Windows PC, under any Windows
   account, on either x64 or ARM64, and every document's page
   images will display correctly after the restore. Backups made
   by earlier versions restore correctly on 1.2.1 as well; a
   library restored on 1.2.1 or later self-heals its internal
   page-image references on the next launch, so no additional
   action is required.

PRE-RESTORE SNAPSHOTS
   Every wipe restore keeps a snapshot of what was replaced,
   under the parent of the data directory (usually
   %LOCALAPPDATA%\AdvisePoint Docs.bak-<timestamp>\). Recovery
   lists these snapshots so you can see their size and free the
   space when you're sure you don't need them.

   Swapping a snapshot BACK IN is deliberately not offered from
   the Recovery panel - restoring a whole data directory is
   safest done with the app closed. The snapshot folder is a
   full copy you can restore manually with the app closed if you
   ever need to.


WHERE YOUR DATA LIVES
---------------------

Everything is stored under:

   %LOCALAPPDATA%\AdvisePoint Docs\
     advisepoint.db          <- the SQLite database
     pages\                  <- rendered page images for the viewer
     originals\              <- the source files you uploaded
     deleted\                <- quarantined documents (see Managing
                                Duplicates). Each subfolder has
                                the manifest + original + pages
                                needed to restore it, or you can
                                just delete the folder in File
                                Explorer to free the space.
     server.log              <- rolling log for diagnosing crashes
     backups.log             <- rolling log for scheduled backups

Snapshots created by a wipe restore live one level up:

   %LOCALAPPDATA%\AdvisePoint Docs.bak-<timestamp>\

That data folder survives reinstalls and updates. If you ever want
a truly fresh start, close the app and delete
%LOCALAPPDATA%\AdvisePoint Docs\ - the next launch recreates an
empty database.


TROUBLESHOOTING
---------------

* "Windows protected your PC" popup:
  Expected the first time you run "Setup Icon (run once).bat" or,
  if you skip that, the first time you run "Start AdvisePoint
  Docs.bat". Click "More info" then "Run anyway". Both launchers
  clear the "downloaded" flag from every other file in the folder,
  so subsequent launches should NOT show the popup.

  If you ever see it again after setup, you can also strip the
  flag from a PowerShell window in the app folder:

      Get-ChildItem -Path "C:\path\to\AdvisePoint Docs" -Recurse | Unblock-File

  Or, before extracting, right-click the .zip in File Explorer,
  choose Properties, and tick "Unblock" - that clears the flag at
  the source.

* Antivirus flags node.exe:
  This is the standard Node.js runtime from nodejs.org. If your
  antivirus is aggressive, add the AdvisePoint Docs folder to its
  exclusions list.

* Port 5000 is already in use:
  Close whatever else is using it (another AdvisePoint Docs window,
  or another local dev server). The start script tries to free the
  port automatically.

* Browser opens but nothing loads:
  Wait 5-10 more seconds and refresh. The server takes a moment
  to come up on first launch.

* PDF upload takes forever:
  Large PDFs (500+ pages) can take 30-60 seconds. This is normal.
  Look at the console window for progress.

* "Reconnecting..." banner during a long operation:
  Backups, restores, and large uploads can hold the loopback
  connection open long enough for the reconnect probe to blink.
  The banner is suppressed during known-busy operations so you
  shouldn't see it in normal use. If it does appear, wait for the
  op to finish; the app reconnects automatically.

* Library counter doesn't match what I see in the list:
  If you're on a build older than 1.0.14 you may need to refresh
  the page after a delete/restore. From 1.0.14 on, the list and
  header counters refresh automatically after Recovery restores,
  Library deletes, backup restores, and auto-cleanup sweeps.

* An update failed / the app won't start after updating:
  The updater keeps the previous build as dist.bak next to the new
  dist folder. To roll back manually: close the app, rename dist
  to dist.broken, rename dist.bak to dist, and relaunch.

* Restore says "id already in use":
  The Recovery panel refuses to overwrite a live document with a
  quarantined one that has the same id. This is deliberate - it
  keeps a mistaken Restore click from stomping on a document you
  edited after removing the earlier copy. Delete or export the
  live document first if you want the quarantined version back.


TECHNICAL DETAILS
-----------------

* Runtime: Portable Node.js 20 LTS (bundled - no install required)
* Database: SQLite via better-sqlite3
* Extraction: pdf-parse for PDFs, mammoth for DOCX, native RTF
  parser, pdf.js for page rendering (with cMap and standard font
  support so PowerPoint-exported PDFs render correctly)
* Search: TF-IDF hybrid retrieval (vector + keyword)
* Integrity: SHA-256 hashes on uploaded files (duplicate detection)
  and on backup ZIP contents (restore verification)
* All processing happens locally. No network calls are made
  except the update check to GitHub and the update download itself
  when you use the built-in updater.


REMOVING THE APP
----------------

Delete the "AdvisePoint Docs" folder. To also remove your uploaded
documents, delete the %LOCALAPPDATA%\AdvisePoint Docs\ folder and
any %LOCALAPPDATA%\AdvisePoint Docs.bak-* snapshot folders left by
past restores.


VERSION
-------

AdvisePoint Docs 1.3.1
Bundled Node.js: 20.18.1
