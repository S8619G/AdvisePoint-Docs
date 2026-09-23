# AdvisePoint Docs — Change Log

## v1.3.1 (September 23, 2026)

Adds automatic browser-free preparation of eligible restricted PDFs with one
retained PDF, fixes DE-prefix title splitting, Document Type usage counts and
recoverable deletion wording, and preserves native PDF recovery geometry.
Simplifies whole-document PDF opening and removes the successful-open alert.
Full x64/ARM64 packages retain normal update controls and omit reset/delete-all
utilities. See `AdvisePoint-Docs-v1.3.1-release-notes.md`.

## v1.3.0 (final packages, September 22, 2026)

Final production-mode packaging restores the normal port-5000 working-library
launcher and update controls, preserving candidate 13 PDF behavior. Adds a
separate, confirmed prototype/test retirement utility with fixed-path identity
checks, verified recovery copies and staged removal. Includes the backup-first
working-library reset in both architectures. No automatic reset or cleanup.
See the consolidated v1.3.0 release notes and START-FRESH.txt.

### Historical candidate development

The entries below describe earlier development stages, not current launch
settings or new field certifications. Later candidates supersede earlier
printing behavior; final packages are not isolated local-test packages.

Candidate 13 corrects native ranges in encrypted, print-permitted manuals:
create a temporary selected-page image PDF when direct page copying is
unavailable, rather than silently opening the full original. Unrestricted
subsets still copy directly. Print prohibition/quality permissions remain
enforced; library originals are unchanged. Cancellation, cleanup, time and
memory guards cover the added preparation path.

Candidate 12 corrects native PDF subsets above 50 pages: copy only selected
PDF pages instead of handing the entire original to the reader. No page-image
rendering is introduced. Large whole-native-document jobs keep direct handoff;
the protected fallback described here is superseded by candidate 13.

Candidate 11 fixes print-range number editing: select-all on focus/click,
empty drafts during editing and validation on blur/Print. Viewer shortcuts
yield to editable controls, including the zero key. Background page changes
no longer reset the selected print mode or range. Both PDF flows are covered.

Candidate 10 hands print selections over 50 pages to the unchanged original,
when available, without image-PDF preparation. Smaller selections are unchanged.
Rendered imports retain originals without changing viewer mode; older entries
can attach their exact source using SHA-256 verification. The text-viewer toolbar
adds an availability-gated Download original PDF icon. Original bytes, filenames,
permissions, backup safety and candidate-9 fallback hardening are preserved.

Candidate 9 isolates rendered-print preparation in a dedicated child process.
Ready now requires a clean exit after PDF validation; successful jobs are not
forcibly terminated. Failure/cancel/timeout cleanup waits for confirmed exit.
Persistent phase, progress, memory, native-stderr and exit diagnostics support
recovery investigations. Active preparation holds off idle shutdown. The
candidate-8 lossless optimization and earlier dialog/updater safeguards remain.
Candidate 9 passed two reported ARM64 full-manual attempts; candidate 10 still
needs native Windows field testing. Updates remain disabled.

Candidate 8 accelerates rendered-PDF preparation with guarded native pixel
access and grouped lossless RGB packing. Unsupported native layouts/access
fall back to the previous conversion. Compression, resolution, page order,
completion checks and print cleanup remain unchanged. The 724-page app-level
test completed in 68.7 seconds with a byte-identical output PDF; laptop
performance still needs validation. Both architectures remain local-test only.

Candidate 7 moves both PDF preparation flows into an in-app dialog that remains
open after the reader handoff. Done/Close/Escape release job-owned resources
without touching library documents, downloaded copies or closing the reader.
Active transfers and file locks defer deletion with retry. Retained selections
use PDF handoff even for small ranges, with permission protections preserved.
Browser-neutral controls target Chrome, Edge and Firefox on x64/ARM64; Windows
field acceptance remains pending. The 724-page sandbox rerun passes in 85.3
seconds with the same 642 MiB image-PDF output, not a size/speed optimization.

Candidate 6 removes the redundant browser confirmation before both PDF print
flows. Current page, ranges and All pages go directly to preparation/preview,
preserving selection, safeguards and explicit reader/printing choices.
This focused change does not reduce PDF size or browser loading time.

Candidate 5 replaces whole-manual HTML image printing with sequential,
lossless temporary-PDF preparation in a worker. Complete-page verification,
progress, cancel/retry, bounded output, timeouts and explicit Chrome/download/
PC-reader handoff prevent incomplete jobs being labelled ready. The 724-page
test manual completes in 92 seconds; Windows preview acceptance is pending.
Stored library images and retained-PDF printing are unchanged.

Candidate 4 isolates fallback PDF drawing/WebP encoding in a dedicated worker
while preserving the serial queue, 240 DPI/q88 images and parent database writes.
Worker deadlines, failure recovery and deletion cancellation prevent stuck or
late render jobs. Full-manual testing reduced active-render PDF delivery from
37.9 seconds to 0.7 seconds with byte-identical rendered images. The sandbox
gate passes; Windows active-render acceptance remains pending.

Candidate 3 removes the 20-page retained-PDF print cap. Large jobs use PDF
handoff rather than full-manual raster images; protected ranges preserve the
original and show explicit range instructions. In-app preparation warns at
one minute and stops at two minutes, offering the PC PDF app only on request.
Rendered-page printing was unchanged in candidate 3. The active-render responsiveness
test reproduced a 37.9-second PDF delivery delay, addressed by candidate 4.

Candidate 2 adds explicit rendered-page fallback for eligible copy-restricted
PDFs, with a storage/preparation warning and legacy searchable-text behavior.
The supplied 724-page manual renders fully; extracted text matches v1.2.8.
Normal startup now records bounded persistent upload and console logs, with
per-file correlation and diagnostics inclusion. The separate test library is
preserved; no publication, updates, migration or automatic reset is enabled.
Candidate 3 extends retained-PDF printing without changing fallback storage.

Integrated tested PDF Prototype 0.4 into the v1.2.8 source baseline. New PDFs
retain original bytes, searchable embedded text and page geometry; bounded
in-memory rendering replaces permanent page-image generation for new imports.
Added compact PDF print preview, original-file download/open, selected-section
copy/print and a library-storage breakdown. Existing image-based PDFs and
DOCX/RTF workflows remain supported without automatic migration. Backup/restore
verifies retained originals. The v1.2.8 updater implementation is preserved.

Matching x64/ARM64 candidates use a separate test library and port 5101.
Updates and production shortcut setup are disabled; nothing was published.
A separate, explicitly confirmed reset BAT preserves a verified backup and
the complete old folder before starting fresh. No existing user data was reset.
The current verification report records candidate-7 regression coverage;
npm audit reports zero findings. Fourteen pre-existing TypeScript
diagnostics remain. Native Windows acceptance and publication are pending.

## v1.2.8 (field-test candidate, September 18, 2026)

Architecture-aware automatic package selection and asset-bound checksums;
download/preflight before server shutdown; verified managed-file recovery and
restart attempts after failed replacement; real progress/error reporting instead
of a premature disconnect countdown. Manual download links now open the release
page. Existing ARM64 installations must use the matching local ZIP once to
install this updater. PDF rendering and browser-heartbeat policy are unchanged.
Publication awaits Windows field-test approval.

Consolidated history of functional releases, newest first. Each entry summarizes
what changed for someone using the application; the full per-version release
notes live alongside this file in `docs/`.

Documentation-only edits, repackages, and internal build-process changes are not
listed as releases. Where a build was repackaged before release, the corrected
content is folded into its parent version.

**Maintenance rule:** every functional release adds its entry here as part of
the release workflow, before the build is handed over for field testing. This
file is the single place to review what changed across versions, so it is kept
current rather than reconstructed later.

**Per-build packaging rule (added 2026-09-15):** every packaged build --
functional release, hotfix, or same-version repackage -- must (1) rebuild the
bundled Welcome Guide PDF from the current `packaging/README.txt` with the
release's VERSION line so the Welcome Guide inside the zip matches the
version being packaged, and (2) update this file with the version's entry
(or fold same-version repackage SHAs into the parent entry inline, per the
standing rule above). Both steps happen BEFORE zips are re-shared or
published. This rule was added after the v1.2.1 field test surfaced two
adjacent gaps: the first v1.2.1 zip shipped with the v1.2.0 Welcome Guide,
and the resulting second same-version zip was refused by the updater's
version guard on the user's field laptops.

**Source-ships-with-build rule (added 2026-09-15):** every packaged build
must be accompanied by a matching source archive shipped in the same
session. Concretely, for every `AdvisePoint-Docs-vX.Y.Z[-arm64].zip` there
must also be an `AdvisePoint-Docs-vX.Y.Z-source.zip` (single source archive
covers both architectures) captured from the exact tree the binary was
built from, and both zips must be (1) committed into the project repo
under `builds/`, (2) accompanied by their `.sha256` companion files, and
(3) shared with the user in the same turn as the binary. Rationale: prior
releases (v1.2.0 and v1.2.1) shipped binary zips without a persisted
source snapshot, leaving those builds unreproducible from source in any
later session once the sandbox that built them was gone. Ownership of
this rule is packaging, not documentation -- do not proceed to `share_file`
for a binary until the source archive is also submitted and shared.

---

## 1.2.7

- Fixed persistent blank PDF regions after large scrollbar jumps and rapid
  scrolling on the shared x64/ARM64 viewer.
- Replaced visibility-dependent page discovery with scroll-position-driven
  page loading and stable, per-page layout.
- Added sized loading/rendering states and a Retry button for failed page
  images, while keeping the mounted page buffer bounded.
- Preserved reading position through zoom and resize. Explicit navigation
  now jumps immediately so it cannot race a later manual scroll.
- No database, launcher, updater, or native-runtime changes.

## 1.2.6

**Upload-parser security fixes:** updates multer to 2.3.0 and pins the
transitive qs parser to 6.16.0, addressing the documented malformed
multipart-field crash and bracket-key comma array-limit bypass. The
production server bundle is rebuilt with the patched dependencies.

**Fix Title separates joined "and" in recognized task words:** for example,
`CloudPrintandScan` becomes `Cloud Print and Scan`. The shared parser applies
this to Upload and Library without changing saved titles automatically.
Conservative matching preserves ordinary words such as Standard and Command;
unfamiliar compounds may still need manual spacing.

## 1.2.5

**Settings is organized into four tabs:** System, Formats, Backup / Restore,
and Developer. Existing panels retain their controls and data. Welcome Guide
and Manage values stay together on System; pre-restore snapshots remain
inside Recovery on Backup / Restore.

**Fix Title is available inside the Library's Edit document dialog, as well
as Upload.** It always reads the original filename, remains available after
applying a suggestion, and asks before replacing a hand-edited title.
Documents without a stored original filename do not show the button.

**Select folder on Upload adds the folder-picker path.** Folder selection
and folder drop share file filtering and staging: `.pdf`, `.docx`, `.rtf`,
`.txt`, `.md`, and `.markdown`, up to 150 MB per file. Unsupported and
oversized files are listed in the summary; hidden and OS bookkeeping
entries are ignored.

**Windows downloads now name both architectures explicitly:** the x64 ZIP
ends in `-x64.zip` and ARM64 remains `-arm64.zip`. Earlier x64 filenames
are unchanged. Both packages are accompanied by matching editable source
and SHA-256 files.

## 1.2.4

**A drop of a whole folder onto Upload now imports every supported file
inside it.** Dragging a folder from File Explorer onto the Upload page
walks the entire folder tree, gathers files matching `.pdf`, `.docx`,
`.rtf`, `.txt`, `.md`, and `.markdown`, and queues them as individual
files. Unsupported extensions and files over the 150 MB per-file cap
are skipped with a per-file note. OS bookkeeping entries (`.DS_Store`,
`Thumbs.db`, `desktop.ini`, `__MACOSX`) and dotfiles are silently ignored.
Subfolders are traversed recursively. Existing per-file progress, dedupe,
and auto-detect behavior is unchanged. The folder picker arrives in v1.2.5.

**Filename phrases join filename codes as a second free-text-to-document-type
rule.** Filename codes (uppercase 1-8 A-Z0-9 tokens like `TRB` or `SEC`)
remain the primary auto-detect rule and are always tried first. When no
code matches, the new Filename phrases table runs a second pass on the
lowercased, punctuation-normalized filename: any configured phrase that
appears as a whole-word match assigns its document type, longest phrase
wins. Phrases are 2-64 characters, must contain at least one letter, and
are deduplicated in normalized form so "Troubleshooting Guide",
"troubleshooting guide", and "troubleshooting_guide" all count as one
entry. A short starter set (Troubleshooting Guide, Security Guide) is
seeded on first boot; edit or delete phrases any time from Settings >
Document types > Filename phrases. Codes were not touched; their
validation and behavior are byte-identical to v1.2.3.

**Manage values moves out of Library into a dedicated Settings panel with a
real Delete control.** The Manage Values button and dialog previously
lived in the top-right of the Library page. It has moved to Settings >
About, next to the Welcome Guide panel, where it is easier to find
alongside the other library-wide tools. Each product model and product
family row now has a Delete button next to Rename. Delete opens a small
reassign dialog that asks whether to clear the value on affected
documents or merge it into another existing value; every affected
document is updated in one operation and nothing is lost. The Rename
flow is unchanged: typing a new name renames on every document, typing
an existing name folds the two together.

**Every packaged build now regenerates the Welcome Guide PDF from the
current README.** The Windows packager runs the Welcome Guide render
step automatically before copying the PDF into the shipped app root, so
the cover page, running header, and metadata always match the version
being packaged. Earlier v1.2.x builds shipped a PDF whose visible
version drifted from the shipped VERSION file because the render step
was a manual pre-package task; this closes that gap without changing
the Welcome Guide's content workflow (it still renders from
`packaging/README.txt` through `scripts/render-welcome-guide.py`).

All v1.2.4 zips ship with matching `.sha256` companions and a source
archive so target-machine verification and later reproduction from source
are both single-command operations.

**x64:** `AdvisePoint-Docs-v1.2.4.zip` --
sha256 `4e8caadf2f58a90dd2309b530571fa5513449710ee41a46ab6966fea7e982186`.

**ARM64:** `AdvisePoint-Docs-v1.2.4-arm64.zip` --
sha256 `b5ff80785bbcb386825b6914703eaa5e35b6ec29f04a544feff221c8ae77719a`.

**Source:** `AdvisePoint-Docs-v1.2.4-source.zip` --
sha256 `59d30a83f906915c196a067efd6fb6d74f6ff60f0c8ad9c2b3327b8a68a9e50b`.

---

## 1.2.3

**Post-restore guidance is now persistent, not a transient toast.** When a
backup restore finishes (either Wipe & Replace or Merge), the app shows an
acknowledgement dialog that summarizes what the restore did, points to the
pre-restore snapshot folder for Wipe & Replace (so you can roll back by
renaming it in File Explorer), and calls out that Recovery > Delete All
operates on the library that exists AFTER the restore -- it removes what
the restore just added, it does not undo the restore. The dialog stays on
screen until you dismiss it.

**A missed dialog no longer leaves you without guidance.** The same post-
restore information is preserved to a small file next to your data
directory (`AdvisePoint Docs.last-op.json`, a sibling of the data folder
rather than a child of it, so a wipe restore does not swap it away). If
the app is force-closed or the machine restarts before you see the dialog,
the next time you open Settings > About a banner surfaces the same
message. The banner appears at most once per restore and is cleared as
soon as it is shown -- there is no persistent noise.

**The updater accepts `--allow-same-version` for developer repairs.** The
command-line updater now takes an opt-in flag that permits reinstalling
the currently installed version. This makes it possible to repair a
damaged install with the same-version zip, and to reproduce a build
during testing without bumping the version number. Downgrades remain
refused. The default behavior for a same-version install without the flag
is unchanged: it prints a clear "same version already installed" message
and exits without touching the install.

All v1.2.3 zips ship with matching `.sha256` companions and a source
archive so target-machine verification and later reproduction from source
are both single-command operations.

**x64:** `AdvisePoint-Docs-v1.2.3.zip` --
sha256 `566a00160d049873ec3a406fa257efacaab0ddfd4ed2b742b7fda17df8174f4d`.

**ARM64:** `AdvisePoint-Docs-v1.2.3-arm64.zip` --
sha256 `bf65352569bddf5e3334af96bd76ee37642a2c9d1577a17e831b55b9febecc25`.

**Source:** `AdvisePoint-Docs-v1.2.3-source.zip` --
sha256 `0a8e817f2e5a54b3d4383d0c15e1c2285fc3fb896005cd1d8f03afbde2344bee`.

---

## 1.2.2

**Local update zips are verified before they touch your app folder.** When you
drop a downloaded update zip onto the Updates panel, or point the command-line
updater at one, the updater now runs an integrity preflight on the file before
unpacking anything. If a `<zipname>.sha256` companion (or a `SHA256SUMS.txt`)
sits in the same folder as the update zip, the updater hashes the zip and
refuses to install on any mismatch. If no companion hash file is present, the
updater walks the entire zip once and verifies every entry's CRC without
writing anything to disk; any corrupt entry stops the install cleanly.

On failure the updater prints an explicit "the update file on your disk is
damaged" message with the mismatched hashes (or the name of the failing entry)
and tells you to redownload rather than retry the same corrupt file. Your
existing installation is not touched. This addresses the failure pattern where
an in-flight corruption -- most often from a FAT32 USB thumbdrive, an
interrupted download, or an untrusted network share -- only surfaced after the
updater had already begun extracting, and read to users as a generic "try
again" prompt.

The README's UPDATING section grows two new sub-sections that document the
preflight and lay out the recommended transfer methods for moving an update
zip to an offline machine (direct download, cloud drop, or SMB share as the
reliable options; exFAT/NTFS full-format USB with an after-transfer
`Get-FileHash` compare as acceptable; FAT32 explicitly called out as the
observed failure mode to avoid). The Welcome Guide inside the zip is rebuilt
from that README so the guidance ships with the build. Every v1.2.2 zip is
accompanied by its `.sha256` companion so target-machine verification is a
single command.

ARM64 build: the README's OS requirement line, which shipped with x64
wording in v1.2.1, is corrected to state ARM64-native.

Deferred to v1.2.3 (originally scoped for v1.2.2): (a) a post-restore modal
after a backup restore explaining that Delete All undoes only what the restore
added and how to recover to the pre-restore state; (b) a `last-op.json` side
file that lets the app show a first-launch banner after a restore even if the
UI process wasn't running at the moment of restore. v1.2.2 stays narrowly
scoped to the update-zip integrity fix and its associated version-display
correction so field testing can focus on the preflight behavior.

Build SHA-256 (x64) `2e2996e996f694619cac21eee2d9af486dd5447cda83596fd0dd1e00bf434cf0`.
Build SHA-256 (ARM64) `67df89287a3d6c28988e16fa47f115ff20b567a793aa1e8092b6f14f3f7ab5ec`.
Source SHA-256 `1e5f6cec6c885e59c1c4fb35692c1c2120c870e044b53d75ab720323c7de87b5`.
The first cut of v1.2.2 shipped as a direct-edit patch (updater.cjs only,
reused compiled bundles from v1.2.1) that self-reported as `1.2.1` in the
header badge; that regression was corrected by rebuilding from source with
`APP_VERSION = "1.2.2"`. Only the two rebuilt artifact zips and the source
zip identified by the hashes above are the shipped v1.2.2 artifacts.

---

## 1.2.1

**Backups restore correctly across machines, users, and architectures.**
Prior versions recorded each rendered PDF page's absolute filesystem path in
the local database at render time. That path only made sense on the machine
and Windows account where the page was originally rendered, so restoring a
backup onto a different PC -- or a different Windows account on the same PC,
or a different architecture -- left the database pointing at page images that
weren't there. The library still listed every document; opening one showed
no page images. The pages had actually been copied in from the backup zip;
the viewer just couldn't find them because it was looking at the exporter's
path.

Starting with 1.2.1, the page-image viewer resolves each page directly from
the current install's pages folder using the document id and page number,
ignoring the stored absolute path at read time. On first launch after
upgrading, a one-shot boot pass rewrites any stale absolute paths in the
database to their current location, so third-party tools and diagnostics
that still read the column see correct values. Restores performed by the
merge path also normalize the newly-imported rows inline before returning,
so the viewer works immediately without waiting for a restart. Existing
backups do not need to be recreated; a restored library from any earlier
version self-heals on next launch.

x64 build SHA-256
`e1d759ce6c329b70a41f07948ffe3470d686cba3d1a03bcfd01e1a0e2e32e693`; ARM64
build SHA-256
`969f140a2bd4ea1506c004fd16d4b39311bfc46533ae781cffc5ea400ab8f11b`.

---

## 1.2.0

**Windows on ARM64.** AdvisePoint Docs now ships as two Windows portable
zips, one for x64 and one for ARM64. Both zips are functionally identical --
same application, same behavior, same configuration -- and each carries a
native Node.js runtime and native modules built for its own architecture, so
the app runs natively on Windows on ARM devices without x64 emulation. Each
install is single-architecture; the installer inside the zip is unchanged.
The in-app updater now records an `ARCH` file in the install folder and
refuses to overlay an incoming update whose architecture does not match the
running install, so an x64 install cannot accidentally be replaced with an
ARM64 zip (or vice versa). Older installs that predate the sentinel are
treated as x64 for the purposes of this check. Download the ARM64 zip on an
ARM device and the x64 zip on an x64 device; there is no auto-detection or
unified installer, and the two builds are not interchangeable at runtime.

**Recovery panel: framed Refresh button and one-click Delete All.** The
Refresh control in Settings > Recovery now has a visible outline border so
it reads as an actionable control instead of decoration. A new **Delete
All** button appears beside it. Clicking it opens a confirmation dialog
that lists the current counts of recently-removed documents and snapshots,
their combined byte total, and states plainly that the action is permanent
and cannot be undone. On confirm, every recently-removed document and
every snapshot is permanently deleted in one pass through the existing
per-item endpoints, and the panel refreshes. Auto-cleanup settings are
not touched. Delete All is disabled when both sections are empty. If any
individual delete fails mid-pass, the sweep stops on that item, the panel
refreshes, and a toast reports the number completed vs the number remaining
so the user knows exactly where the sweep halted. Per-item Restore and
per-item permanent-delete controls in each section are unchanged.

**Change to the shipped `@napi-rs/canvas` version.** The document renderer's
native canvas library moves from the older baseline version to `0.1.100`
for both architectures. This is the first canvas version whose published
artifacts include the `win32-arm64-msvc` peer, so shipping the ARM64 build
required the wrapper and the peer to move together. The x64 build is
rebuilt on the same version so both architectures share one canvas
release. Rendering behavior is preserved.

x64 build SHA-256
`1b45cbdbdd165254aa995bdda7759a9d851b6e5710d42d5cf8a612a1a5a424fb`; ARM64
build SHA-256
`a1b1cb67c76dd720ada28f8dd07f5d95b965f4287844bb357c01c4037bfbb453`.

---

## 1.1.9

**Query tab: Recent searches panel.** The Query tab side column now includes
a Recent searches card immediately under Filters. Each completed search is
recorded as the full combination that produced the result -- query text,
match mode, maximum result count, and every filter value -- so selecting a
row restores that state and reruns the exact same search. The list keeps the
five most recent unique combinations, dedupes a repeat run to the top rather
than duplicating it, and never records blank queries. A Clear button in the
card header wipes the panel after a short confirmation and does not touch any
documents or filters. The list is server-persisted and survives restarts and
tab switches.

**Upload tab: Auto-fix titles toggle in "Same metadata for all" batch mode.**
The batch-shared banner now offers an Auto-fix titles from filenames toggle.
When enabled, each file in the batch has its title cleaned up individually
from its own filename before upload, using the same rules the per-file Fix
Title action applies. Files whose names cannot be cleaned up keep the
filename as the title. The toggle is off by default; when it is off, the
1.1.8 behavior is preserved exactly (each file's title is filled server-side
from its filename). The rest of the shared metadata continues to apply
uniformly to every file in the batch. Build SHA-256
`7269f77f62fe60ac388bc72fb8a1d40062e547533dd26683da3b400c3e9bf880`.

---

## 1.1.8

**Multi-file uploads honor the metadata entered on the Upload tab.** Both
batch modes -- "Different per file" and "Same metadata for all" -- used to
send an empty metadata block to the server, discarding the per-file cards
(Fix Title, Detect document type) and hiding the shared metadata form
altogether. Every batch-uploaded document arrived with a filename-derived
title and a document type of "document." Both modes now apply their
advertised metadata: per-file cards send each file's own metadata, and
shared mode makes the metadata form visible and applies it to every file
in the batch. Title in shared mode is filled per file from each filename
so multi-file batches never collide on titles. The defect was introduced
alongside "Different per file" mode in v1.1.1 and had not been surfaced
before. Documents uploaded before v1.1.8 are unaffected and can still be
corrected from the Library tab. Build SHA-256
`0c68201524177cc988f09b8ec0755356e9aff46fc91ea7bb114a6621705a0d1a`.

---

## 1.1.7

**Interrupted renders are surfaced and recoverable.** A document whose page
rendering was cut short by a shutdown, upgrade, or crash now settles into a
visible error state on next launch instead of spinning forever in the viewer.
Settings > About shows a list of interrupted or failed renders with each
file's name and a Remove-this-document action for cleanup. The header
indicator distinguishes an interrupted render from a rendering failure.
Removals are reversible from Recovery.

**Shutdown accounts for in-flight rendering.** The background server holds
off on its own idle timeout while documents are still processing, and the
in-app upgrade action warns before restarting if renders are running so the
user can choose to continue or wait. The warning is not a hard block.

**In-app upgrade is more tolerant of a slow exit.** The updater's grace
window is longer, the post-kill wait for Windows to release file handles is
longer, and the server's own hard-exit is no longer bound to an event loop
that can be blocked by shutdown work. Shutdown milestones are instrumented
for future diagnosis.

Build SHA-256 `95648dd237c3a97e689ada5e7d73671bb23d249ffeafd52b191403d2c61dcc1c`.

## 1.1.6

**Sleep-aware idle shutdown.** The application shuts its own background server
down after a period with no browser tab connected, so the console window does
not linger. That timer previously measured elapsed wall-clock time, which could
not tell "the browser went away" apart from "the computer was asleep." A machine
left suspended overnight woke to find hours of apparent idleness and the server
exited before the open tab could reconnect, leaving the page disconnected.

The idle check now recognizes when the computer was suspended and does not count
that time against the idle limit. On wake the timer restarts and the open tab
reconnects on its own. Closing the last tab still winds the server down normally,
and a server no browser has ever reached is still left running.

A clock moved backwards is also handled, and a suspend within seconds of startup
no longer ends the session.

Build SHA-256 `bf4fd2616dadfb3a3671eff9905046ae2024ee45ecbb86bb869024e1950f6eff`.

## 1.1.5

**Choosing which copy of a duplicate to keep.** The duplicate review screen now
offers a keeper selection for every group, not only for groups the application
declined to resolve on its own. Copies are listed newest first with the most
recent labeled, and each row shows the date added, page count, whether the
original file was retained, whether the copy can be displayed, and its excerpt
count — enough to tell two similar files apart.

KEEP and QUARANTINE labels follow the selection as it changes, and the removal
count at the top reflects the current choices rather than the initial scan.
A confirmation checkbox is now required only for groups the application could
not verify.

Groups where the automatic choice is overridden are routed through the manual
review path, so a group can never be submitted through two channels at once.

Build SHA-256 `d8830ef38a1021659fa8c855facbee7166862325b8f368f61bc9b3c867b5b99d`.

## 1.1.4

**Document type names are capitalized automatically.** A hand-typed
"technical bulletin" is stored as "Technical Bulletin". Acronyms keep their
capitals (API, KB, MFP, PDF, OCR, USB, RFID, OEM, FAQ), and names with
deliberate mixed case or digits are stored exactly as entered.

**Merging document types.** Settings › Document types can fold one type into
another, re-tagging every document that used the old name.

**Built-in document type list tidied**, and filename code detection follows
type changes. Includes a path for reconciling a library created before this
release.

## 1.1.3

**Product model is now optional.** Documents can be added without one.

**Product model and family are suggested from the filename** during upload.

**Bulk rename and merge for product values.** Because model and family are
free-text rather than a fixed list, variant spellings accumulate; these can now
be renamed or merged across every document at once.

**Optional propagation** when editing a single document's product values.

## 1.1.2

**Document type is detected automatically for single-file uploads**, matching
the behavior already present for multi-file uploads.

**Filename codes separated from their number by a hyphen or underscore** are now
recognized.

**The Title box in the Upload tab spans the full width of the panel.**

## 1.1.1

**Fix Title and auto-detect Document type** now appear on multi-file uploads,
not only single-file ones.

**Multi-file uploads in "Different per file" mode auto-classify each file**
independently. "Same metadata for all" remains the default.

## 1.1.0

**Uploads auto-classify the Document type from recognized filename codes.**

**The Upload tab preserves staged files, per-file metadata, and in-flight work**
when navigating away and back.

## 1.0.15

**Product family suggestions** on upload and in library metadata.

**The Welcome Guide is seeded into the library on first launch** and excluded
from Query results so it does not crowd out real documents. Its revision tracks
the application version.

**The Product family filter** on the Query page was repositioned.

## 1.0.14

**Product family filter on the Query page.**

**Automatic refresh after Recovery and Restore actions**, so the Library,
Recovery, and related views no longer show stale contents.

**Native Windows folder picker** for Quick Backup and Scheduled Backup.

## 1.0.13.1

**Restored the application interface.** 1.0.13.0 shipped without its styling
bundle, which made the header icon fill the screen and collapsed the Library,
Schema, and Settings layouts.

**Build-time guards** now refuse a build with missing styling configuration, and
refuse a source archive that lacks any file needed for a working rebuild.

## 1.0.13.0

**Settings → Recovery panel.** Lists documents the application preserved instead
of deleting — both duplicate removals and single-document deletes — plus the
pre-restore snapshots taken before a wipe-and-replace restore. Preserved
documents can be restored or permanently deleted with a per-item confirmation.

**Restore is stage-verify-swap.** A restore rebuilds excerpts, page images, and
the retained original into a staging area and verifies them against the recorded
manifest before anything enters the live library. A restore that collides with a
live document's id is refused and touches nothing.

**Optional automatic cleanup of duplicate removals** (default off). Removes only
preserved copies from duplicate deletion, never single-document deletes, and only
when the kept copy is present, still matches its recorded SHA-256, and is still
viewable. Any failed check keeps the preserved copy.

**Post-update crash popup suppressed on all first launches.**

## 1.0.12.4

**No backup destination is preset on a new installation.** Earlier builds
pre-filled a folder, which meant a backup could be written somewhere the user
never chose. No folder is created on disk until a backup actually runs, enabling
a schedule without a destination is refused, and a scheduled run with no
destination is recorded as not run with the reason given.

## 1.0.12.3

**Duplicate detection tightened to content, not names.** Two documents are
duplicates only when their recorded SHA-256 matches; where an original file is
retained, the hash is recomputed from disk rather than trusted from the database.
The copy kept is the most complete one, viewability is judged by page images
actually present on disk, and groups where no copy can be displayed are reported
and left alone.

**Removal is reversible.** Duplicate removal and single-document deletion both
move the document into preserved storage, written before anything is unlinked.
The kept document is re-checked immediately before each removal.

**Manual review** is required for any group that cannot be verified
automatically.

## 1.0.12.2

**The duplicate panel is hidden unless the library contains duplicates.**

**Backups write to a dedicated log that survives restarts**, and the diagnostics
bundle now includes it.

## 1.0.12.1

**Update reliability.** Updates no longer fail when a release asset filename
differs from the expected pattern. The application relaunches immediately after
the file swap, the relaunch is verified and logged, and the reloaded page always
receives a cache-busting address. An instance still exiting is waited for rather
than treated as a conflict, file replacement retries when Windows briefly holds
a directory handle, and updater-only environment variables are no longer
inherited by the running application.

**The duplicate finder moved to the top of the duplicate list.**

## 1.0.12.0

**Duplicate review actions moved to the top of the results window.**

**In-app updates abort instead of half-applying** when a previous instance is
still running.

## 1.0.11.5

**Blank Settings page fixed.** The About tab, which hosts Backup & Restore and
the duplicates card, rendered as a blank white screen because a callback
referenced a later-declared callback in its dependency list and threw on every
mount.

**Drop-a-zip upgrade now opens a fresh tab.** After an in-app update the browser
was sent to the same address the pre-update tab already occupied, so the shell
focused that stale tab instead of reloading. The updater now leaves a
short-lived marker that the restarted server consumes at boot, opening a
distinct address for exactly one launch. Ordinary shortcut launches are
unchanged.

## 1.0.11.4

**Merge restore no longer duplicates existing documents.** Only documents whose
ids are absent from the live library are imported; the policy is deliberately
conservative and preserves live documents as-is rather than overwriting them.

**The "Reconnecting…" banner that flashed near the end of a merge restore** is
suppressed.

**New "Find duplicate documents" tool** on the Backup & Restore panel.

## 1.0.11.3

**Merge restore no longer fails outright.**

**In-place upgrade accepts more asset filenames.**

**A failed restore updates the panel without a page reload.**

## 1.0.11.2

**Reconnect banner** when the background server drops.

**Backup Now button** and a **last-operation result strip** on the backup panel.

**Restore no longer stalls the health check.**

## 1.0.11.1

**Manual backup honors the chosen folder.** Back up now on the Quick backup card
previously ignored it.

**Download a copy** sends a backup to the browser's download location.

**Drive listing no longer stalls the application**, and the folder picker has a
Refresh control for the Drives row.

## 1.0.11

**Backup and Restore rebuilt.** Backup export now writes a real ZIP; a defect in
how the archiver library was used had produced unusable archives. The panel is
redesigned as three columns with a folder picker on every path field, a live
folder check, a warning when backing up into a cloud-synced folder, and
plain-language errors. Scheduled backups show their last-run time and can be
started on demand. The panel opens noticeably faster.

## 1.0.10

**In-document search for DOCX and RTF viewers**, with a highlight box above the
viewer. The PDF viewer is deliberately untouched.

**Filename and file-type badge in viewer metadata headers.**

**Faster stale-tab detection** when the application is open in more than one
browser tab.

**The edit-in-place status pill now clears itself**, and **upload metadata resets
between uploads.**
