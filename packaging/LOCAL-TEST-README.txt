AdvisePoint Docs v1.3.0 candidate 13 - LOCAL TEST ONLY

NEW IN CANDIDATE 13
Fixes the remaining native-PDF range problem in protected manuals. If direct
page copying is unavailable but printing is allowed, the app makes a temporary
selected-page image PDF at 200 DPI (150 DPI for low-quality-only permission).
Unrestricted PDFs still copy pages directly. Printing-prohibited PDFs remain
blocked. Your original PDF and library data are not changed.
Test 100-103: Open PDF to print must show exactly FOUR pages from that range.
Choose All pages in the prepared PDF reader. Done releases the temporary copy.
Do not use Open original PDF for this test: that intentionally opens all pages.
Whole native manuals still open the original directly for large jobs.
Rendered-PDF large-job original handoff is unchanged.

NEW IN CANDIDATE 11
Print > Range: click either From or To to select its whole number, then type
the page you want. Backspace can clear the box without inserting page 1.
Numbers containing zero work normally. Values are checked when leaving
the box or choosing Print; oversized values stop at the last page.
Background page tracking no longer resets your range while editing.

NEW IN CANDIDATE 10
Rendered-PDF selections of 51 or more pages prefer the unchanged original PDF:
no image-to-PDF preparation is needed. Selections of 1-50 pages are unchanged.
For a rendered subset, the FULL original opens: choose the displayed original
page range in the PDF reader. Native subsets follow the candidate 13 rule above.
The reader still handles loading and print preview.
Nothing prints automatically. Use Done after finishing in the reader.

New rendered-page imports retain their original alongside the page images.
For an older rendered manual, choose its exact source PDF in the print dialog
and click Verify and attach original. Fingerprints must match. Pages, metadata
and search content are preserved; no reset or reimport is needed.
Prepare from saved pages instead remains available as the backup route.

The extracted-text section toolbar has a small Download original PDF icon
beside Copy, Print and View. It appears only when the original is available,
saves its unchanged bytes and original filename, and does not open the viewer.
Files you download are yours; Done never deletes them.

The older candidate notes below describe the preserved preparation fallback.

1. Extract this ZIP into a NEW folder. Do not extract over your working app.
2. Double-click Start AdvisePoint Docs.bat. Leave its window open.
3. The test opens at http://127.0.0.1:5101.
4. Import a few PDFs, or restore a COPY of an exported backup into this test
   library. Your existing working installation and library remain separate.
5. Close the test console window when finished. Restart with the same BAT.

Test data is in:
%LOCALAPPDATA%\AdvisePoint Docs v1.3.0 Test\AdvisePoint Docs

Production remains on port 5000. PDF Prototype remains on port 5100.
If 5101 is occupied, startup refuses rather than stopping another application.
Do not run internal application/updater scripts or use this ZIP as an update.
Checks, update installation, and production shortcut setup are disabled.
No GitHub release has been published for this candidate.

New PDF imports retain their original bytes and render only while viewed.
Existing image-only PDFs still use the original viewer. Nothing is converted
or deleted automatically. Scanned image-only PDFs do not gain OCR.

Test rapid scrolling, jumps, zoom, search, selection copy/print, the compact
PDF print preview, Open original PDF, original download, backup and restore.
Open original uses a temporary copy; saving edits there does not change the
library. Retained PDFs no longer have a 20-page maximum for printing.
All in-app selections use PDF handoff, including small ranges:
click Open PDF to print, then use the PDF reader's Print button or Ctrl+P.
Keep the preparation dialog open until finished. If a protected PDF requires the
original-file route, select the displayed original page range in its print
dialog; do not leave All pages selected unless you want the whole manual.
After one minute, preparation warns and offers Open in PC PDF app; you can
keep waiting or cancel instead. Nothing opens or prints automatically.
Preparation is cancellable and stops after two minutes. Selected PDF copies
have a 128 MiB input/output budget; the original-file route remains available.
Rendered-page documents use the candidate-5 preparation flow described below.

Windows ARM64 and x64 each require local hardware validation.

Candidate 2: rendered-page fallback and persistent upload diagnostics
------------------------------------------------------------------
If a PDF is rejected because copying is restricted, its upload row offers
"Import with rendered pages" or "Skip this file". Confirm the storage warning
only if you are authorized to import the document. The fallback uses the
legacy searchable-text import and stores page images, not the original PDF.
Keep your source file. Password-required PDFs and PDFs that do not permit
full-quality printing are not eligible. Scanned PDFs still require OCR.

Large manuals can take several minutes to render after import. Search is
available first; the header shows rendering progress. Do not close the app
until rendering finishes. If interrupted, check the library status before
retrying; restarting does not automatically re-import the file.

Use ONLY Start AdvisePoint Docs.bat. No special diagnostic launcher needed.
Upload logs are recorded automatically, survive restarts and rotate by size.
If something fails, use Settings > Export diagnostics in the normal app.
Logs include filenames, sizes, stages, IDs, elapsed time and outcomes, but the
upload journal excludes document text and metadata. Review diagnostics before
sharing; the general server logs can contain paths and error details.

Close the previous v1.3.0 test console before opening candidate 13. This build
reuses the separate v1.3.0 TEST library and keeps its existing documents.
Do not run Reset library unless you separately choose to reset your test data.
Also test viewer opening, original-PDF opening, search and navigation while a
large fallback manual is still rendering. Compare with the same actions once
rendering finishes; note page progress and any disconnection or long delay.

Candidate 4: responsive viewing during fallback rendering
-------------------------------------------------------
PDF drawing and WebP encoding now run in a separate background worker.
Imports still render one document at a time, at the same 240 DPI/WebP quality.
The app keeps progress, upload logs and database writes under its control.
A stuck worker can be stopped on a timeout without blocking the server.
Deleting a document cancels its queued/active rendering to prevent late pages.

Candidate 3 printing improvements are preserved. Chrome large-manual preview
has been reported successful on x64 and ARM64; physical printing is untested.
Please recheck opening another large PDF and Open Original PDF while the
724-page fallback manual is actively rendering on each laptop.

Candidate 5: large rendered-page print jobs
-----------------------------------------
Open the 7353 manual, choose Print > All pages, then click Print.
The in-app dialog prepares a temporary PDF one saved page at a time. Keep it open.
Only after every selected page is included does Open prepared PDF appear.
Click it, then use Chrome's Print button or Ctrl+P. Choose All pages there.
For a selected range, the prepared PDF contains only that range, starting at
PDF page 1; do not enter the original range a second time in Chrome.

Nothing prints automatically. You can instead download the prepared PDF or
click Open in PC PDF app once preparation is complete. Cancel stops work;
Prepare again retries. Missing/corrupt images stop the job, never skip pages.
At one minute a warning offers waiting, cancelling or using your source PDF.
Older image-only imports need an exact original attached for direct handoff.
There is a ten-minute preparation deadline, a 60-second per-page deadline
and a 1 GiB total temporary-output budget. Allow at least 1.2 GiB free space.
Try a smaller range if a limit is reached. Temporary PDFs expire after 30
minutes without activity; download one to keep it. Do not clear the prepared
PDF or close the application while the reader is still using it.

Sandbox: all 724 pages prepared in 92 seconds, creating a 642 MiB temporary
PDF with no additional image-quality loss. It does not enlarge the library
or its backups. Current saved images are interpreted at 240 DPI; for older
110/200-DPI libraries use Fit to paper and check orientation and margins.
Chrome's own print-preview processing occurs after preparation and cannot
be timed or cancelled by this application. Windows results may differ.
Check that Chrome offers all 724 pages, including 299, 452 and the final page,
on BOTH ARM64 and x64. Physical printing remains untested.

Candidate 6: direct print preparation
------------------------------------
Both retained PDFs and rendered-page documents now go straight from the
viewer's Print button to their preparation/preview screen. The extra
"Open xxx pages for printing?" browser confirmation has been removed.
Current page, selected ranges and All pages still use the same selection.
Explicit reader/printing choices are preserved.
This does not reduce the temporary PDF size or Chrome's own loading time.

Candidate 7: in-app dialog and Done cleanup
-----------------------------------------
Preparation no longer opens its own tab. The dialog stays open after you
open the PDF reader; opening the reader does not restart preparation.
Use Done AFTER finishing printing or viewing. It closes the dialog and
clears job-owned temporary resources. Active transfers and locked files
defer cleanup with retry. Close and Escape use the same cleanup.
Library originals/images, backups and downloaded copies are not deleted.
The app does not close the PDF-reader tab. A temporary URL may stop working
after Done; download a copy if it needs to remain available.

Support targets: Chrome, Microsoft Edge and Firefox on Windows x64 and ARM64.
Test each browser/architecture combination; Linux automation does not
certify Windows preview, physical printing or external-reader associations.
Browser settings may download PDFs rather than display them. The Download
and PC PDF app alternatives remain available. Reader loading is a separate
step, not a second app preparation job. No size reduction is claimed.

Candidate 8: faster rendered-PDF preparation
-------------------------------------------
Native pixel access and grouped RGB packing reduce conversion overhead.
A compatibility check and automatic fallback preserve the prior method
when native pixel access is unsupported. Quality, size and cleanup are
unchanged. The 724-page app-level sandbox check took 68.7 seconds and made
a byte-identical PDF; actual Windows laptop timing must still be tested.
Time the wait BEFORE Open prepared PDF separately from reader loading.
Extract into a new folder, close the previous test app and start normally.
The existing isolated test library is reused. No reset/reimport is needed.

Candidate 9: isolated preparation and safer completion
------------------------------------------------------
Rendered-PDF preparation now runs in its own process, separate from the
library server. Successful jobs exit normally rather than being forcibly
stopped. Ready is shown only after full output validation and a clean exit.
Native worker failure, cancellation and timeout do not expose a partial PDF.
Active preparation also holds off the normal idle shutdown.
The existing print dialog, Done cleanup and lossless optimization remain.
Repeat All pages on the rendered 724-page manual at least three times on
each laptop. Open and inspect the PDF, then use Done before the next attempt.
Also cancel near the end, retry, and verify the library remains usable.
If a job fails, note the message/time and collect diagnostics from Settings.
New progress, memory, finalization, native error and exit records are saved
automatically. No separate diagnostic launch or database reset is required.
This is still a local-test build, not a GitHub release or in-place update.
