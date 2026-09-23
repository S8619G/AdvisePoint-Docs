# AdvisePoint Docs v1.3.1 testing guide

These are full v1.3.1 release packages with normal startup and update controls. Use the ZIP matching the installed application architecture; the shared source ZIP is not an installer. Restricted-PDF import has been reported working in the integrated ARM64 app, but in-place upgrades and the revised open controls still need Windows testing.

## Test an in-place upgrade before GitHub publication

1. In the existing normal application, export a current library backup through Settings → Backup/Restore. Keep that backup and the older application package.
2. Start from an older installed version, such as v1.2.7, v1.2.8 or v1.3.0. Save any edits and finish imports or print jobs.
3. Open Settings → System → Updates and use its local ZIP upload/install control. Select the new **AdvisePoint-Docs-v1.3.1-x64.zip** or **AdvisePoint-Docs-v1.3.1-arm64.zip**, matching the installed application. Select the unopened ZIP, not the source ZIP.
4. Review the detected version and architecture, then confirm installation. Let the existing updater finish validation, replacement and restart; do not interrupt it.
5. Confirm v1.3.1 and the normal port 5000. Confirm existing document counts, settings, search and stored PDFs remain intact.
6. Import the original restricted sample, then check a four-page print range, whole-document handoff, quiet PDF opening, Document Type counts and deletion/restoration of a disposable test document.

The local-ZIP path does not require a published GitHub release. The currently installed updater performs the first upgrade, so test from the actual older version you intend to support. An installation already labeled v1.3.1 is not an older-version upgrade test; do not edit version markers to force it. Report any refusal or error before trying a manual replacement.

The optional isolated test launcher blocks updates and is not suitable for this in-place upgrade test. No reset or delete-all tool is required.

## Start without touching the existing library

1. Close any previous v1.3.1 test console.
2. Open the extracted **AdvisePoint Docs** folder.
3. Run **Start isolated v1.3.1 test.bat**.
4. Leave its console open and confirm **v1.3.1** in the application.
5. Confirm the address is **http://127.0.0.1:5102**.

The isolated library is `%LOCALAPPDATA%\AdvisePoint Docs v1.3.1 Test\AdvisePoint Docs`. Repeat runs reuse that test data; nothing is reset. Production uses port 5000, the older PDF prototype uses 5100, and the older v1.3.0 test uses 5101.

Do not run **Start AdvisePoint Docs.bat** for isolated testing: that is the normal production launcher and uses the normal library. No delete-all or reset utility is bundled.

## Check the changed workflows

- **Original restricted PDF:** upload the original Cloud Capture Customer Admin Guide, not its Chrome-converted copy. It should import without a restrictions failure or browser print dialog. Open its pages, search its text and download the compatible PDF.
- **Mixed upload:** add ordinary PDFs, eligible restricted PDFs and text or Word documents together. Successful files should remain imported even if a different file has a genuine error.
- **Page ranges:** print Current page, 1–3, 2–5, a larger range and the whole manual. For 2–5, “Open PDF to print” must open exactly four correct pages; choose All pages in that subset’s PDF reader. For a whole manual over 50 pages, a direct handoff to the retained PDF is expected.
- **PDF-opening controls:** the whole-document handoff should show one **Open compatible PDF** action plus Download, not a second **Open in PC PDF app** button. Opening a PDF from the viewer should not display a success pop-up; an actual failure may still display an error.
- **Links:** open the downloaded compatible PDF in a supporting external reader and check its links. The in-app page viewer’s navigation features are unchanged.
- **Title spacing:** try DEALER.pdf, DEVICE.pdf and DESIGN.pdf with Fix Title enabled. Ordinary words should stay intact.
- **Usage counts:** visit Settings → Formats → Document types before importing. Import, reassign or delete a document, then return to confirm its type’s active count has changed without restarting.
- **Delete and restore:** delete a test document, read the revised warning, then restore it from Settings → Backup/Restore → Removed documents. Confirm pages, search and the retained PDF still work.
- **Backup:** export this disposable test library. Test restoration only into another disposable test library, not a production library.

Repeat on x64 and ARM64. Try Chrome, Edge and Firefox as practical for the application and printing; conversion itself must not depend on any installed browser.

## Expected limits

Not every PDF qualifies for automatic preparation. Opening passwords, insufficient printing permission, malformed files, size/page limits, validation differences or timeouts still produce a real error. Scanned image-only PDFs still need OCR for meaningful text indexing.

The library keeps one retained PDF per new native import. For a prepared document, that is the compatible copy; backup archives naturally contain their own backup copy, and deleted documents remain in recovery until permanently removed. Conversion may increase an individual PDF’s size.

## Report results

Report architecture, application version, browser, filename and the action that failed. Export diagnostics for errors; do not send the entire library unless specifically needed.

No online release, live update or production upgrade has been performed. Keep the current working installation until this integrated build passes the required field tests.
