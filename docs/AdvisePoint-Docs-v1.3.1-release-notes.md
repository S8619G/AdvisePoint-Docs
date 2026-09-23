# AdvisePoint Docs v1.3.1

September 23, 2026. Full Windows x64 and ARM64 release packages with matching shared source. Includes the PDF-controls revision: one primary open action in the whole-document print handoff and no unnecessary successful-open pop-up.

## Improvements

- **Browser-free PDF import:** eligible copy-restricted PDFs are automatically prepared using the bundled native QPDF converter. Chrome, Edge, Firefox and printer drivers are not required for conversion.
- **One retained PDF:** ordinary PDFs remain unchanged. For a successfully prepared restricted PDF, the library saves only the validated compatible PDF, not an additional restricted original. The selected source file outside the library is never changed.
- **No false failure during preparation:** eligible files stay in the import workflow while preparation and validation run. Actual failures remain visible and logged; an authorized rendered-page fallback remains an explicit choice.
- **Title cleanup:** ordinary words such as DEALER, DEVICE and DESIGN no longer acquire a space after DE. Genuine language markers and existing filename rules remain supported.
- **Document Type counts:** Settings → Formats refreshes active-library usage counts after library changes instead of keeping an indefinitely cached value.
- **Accurate deletion warning:** removing a document is described as recoverable through Settings → Backup/Restore → Removed documents. Manually removed documents remain there until permanently deleted; scheduled backup retention is not a deleted-document expiry setting.
- **Native PDF recovery:** deletion now preserves the page information needed to restore native and compatible PDFs correctly. Older recovery entries can reconstruct missing page information from their retained PDF.
- **Clear file labels:** converted documents use “compatible PDF” wording for the retained download and whole-document print handoff. Selected-range printing continues to open a prepared subset.
- **Simpler PDF opening:** the whole-document print handoff has one primary open action rather than separate browser and PC-app buttons that can behave identically. Successfully opening a PDF from the viewer no longer shows an unnecessary browser alert; failures remain visible.
- **Clean packages:** no one-off reset, delete-all or prototype-cleanup tools are included. Unnecessary dependency test fixtures and CI files are removed while runtime code and legal notices remain.

## Storage and compatibility

Conversion is limited to PDFs that open without a password and permit high-quality printing. Password-protected files and copy-restricted files without that permission remain refused; permission flags do not replace the requirement to be authorized to convert and index a document.

Preparation checks PDF structure, page count, dimensions, extraction permission and page-by-page text before committing the import. It uses separate processes, temporary work folders, cancellation, timeouts and file-size limits. Current automatic-preparation limits are 150 MiB input/output, 2,000 pages and a ten-minute overall deadline, with shorter per-stage timeouts.

Normal success and handled failure remove temporary preparation files. An abrupt power loss or forced termination can leave temporary work; the next preparation sweeps this feature’s abandoned work folders older than 24 hours. One-copy storage does not guarantee every converted PDF will be smaller, and temporary input/output copies are needed while preparing.

The converter preserves PDF structure rather than printing to images. The supplied 76-page manual retained all 70 links and 80 bookmarks and became 5.34% smaller; this is a sample result, not a guarantee for every PDF. The app’s page viewer has not gained bookmark or clickable-link navigation in this release; use a supporting PDF reader for those features.

PDF preparation is not sanitization, OCR or digital-signature validation. Use trusted documents; signed PDFs, forms, unusual interactive content and arbitrary malformed PDFs are not comprehensively certified. Existing library entries are not automatically converted or re-imported.

## Delivery and testing

For upgrades from the last public release, v1.2.7, this release also includes the retained-original PDF storage and on-demand viewer introduced in v1.3.0, selected-page native printing, persistent upload logs and isolated background PDF work. Existing rendered entries remain supported and are not automatically converted. The v1.2.8 updater adds architecture-aware selection, visible validation progress and broader application-file rollback protection; the older installed updater still performs the first upgrade into v1.3.1.

The x64 and ARM64 packages contain identical application distribution files and matching architecture-specific converters. The authoritative shared source rebuild matched all 216 distribution files, and the existing updater, Node 20.18.1 and retained runtime files remain byte-identical to the preceding release.

Normal update controls remain available in the standard application. An optional **Start isolated v1.3.1 test.bat** uses port 5102 and a separate test library, with update execution blocked from that test session. No existing production or earlier test library is reset or migrated.

Automated import, storage, recovery, backup, browser, printing and updater checks passed. Restricted-PDF import has also been reported successful in the integrated ARM64 application. Type checking still reports the same 14 pre-existing diagnostics; broader Windows upgrade testing, the revised UI and physical printing remain field-test gates. Consult the accompanying testing guide and verification report before an in-place upgrade.

## Upgrade downloads

Use the architecture-named x64 or ARM64 ZIP for manual installation or local ZIP drag-and-drop. The shared source ZIP is not an installer. The additional **AdvisePoint-Docs.zip** asset is byte-identical to the x64 ZIP and exists only for compatibility with older GitHub updaters; it is not an ARM64 or universal package.

Each ZIP has a matching `.sha256` companion. The single checksum below is the x64 compatibility checksum read by older updaters; use the ARM64 companion when checking the ARM64 package.

sha256: 1f7822d6ea7f6a823619cdfc4913b7699e0c6b075b3af6b40e8dd5e06a662c22
