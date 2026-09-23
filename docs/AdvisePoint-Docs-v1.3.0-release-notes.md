# AdvisePoint Docs v1.3.0 release notes

Final production-mode packages, September 22, 2026. Supersedes local-test candidate 13; GitHub publication has not been performed.

## PDF storage and viewing

- **Retained originals:** New ordinary PDF imports keep the unchanged original, searchable embedded text and page geometry. Visible pages render on demand rather than creating permanent images for every page.
- **Existing libraries:** Older image-based documents remain supported. No automatic conversion, reset, deletion or reimport occurs.
- **Restricted-document fallback:** Eligible copy-restricted PDFs offer an explicit rendered-page import with a storage/time warning. New fallback imports retain the original alongside saved pages; opening-password and full-quality-print-restricted documents remain ineligible for this import route.
- **Original download:** The text-view toolbar offers Download original PDF only when the intact original is available. Older image-only entries can attach their exact source after fingerprint verification.
- **Background rendering:** Fallback drawing and encoding run in an isolated worker, keeping library requests separate from that CPU-intensive work.

## Printing

- **Native PDF ranges:** Unrestricted PDFs copy only selected pages. Encrypted PDFs that permit printing prepare a temporary selected-page image PDF at 200 DPI, or 150 DPI for low-quality-only permission. No-print restrictions remain enforced and stored originals remain unchanged.
- **Subset reader:** Open PDF to print opens the prepared subset. Choose All pages in that subset's reader. Open original PDF intentionally opens the entire original instead.
- **Whole manuals:** Whole-native-document jobs above 50 pages use direct original handoff. Large rendered-document jobs also prefer an available original; partial rendered selections on this route still require choosing the original range in the reader.
- **Print-range editing:** Number fields select their contents on focus, allow empty drafts and validate on blur/Print. Viewer keyboard shortcuts and background page tracking no longer interfere with range entry.
- **Preparation dialog:** Preparation stays inside the viewer and remains open after handoff. Done releases job-owned temporary resources, with deferred cleanup for active transfers or locked files. Downloaded files and library documents are preserved.
- **Rendered-page preparation:** The saved-image alternative runs in a dedicated child process, with faster lossless pixel conversion, complete-output validation, clean-exit checks, progress, cancellation/retry, deadlines and output limits. Nothing prints automatically.

## Library management and maintenance

- **Upload diagnostics:** Persistent bounded upload journals record filenames, stages, timing and results without document text or metadata.
- **Backup and restore:** Retained originals participate in verified backup/restore and reversible document removal. Storage reporting separates originals, database files and saved images.
- **Fresh start:** Both Windows packages include `Reset library (backup first).bat`. It verifies a database/file backup, preserves the complete previous folder, then creates an empty active library. It requires choosing a library and typing confirmation.
- **Prototype cleanup:** Both packages include `Clean prototype and test data (backup first).bat`. It targets only the PDF Prototype and v1.3.0 Test data roots, including their internal temporary files, after verifying a complete recovery copy. It never targets the working library, original source-document locations, Downloads or general Windows Temp.
- **Cleanup safeguards:** Fixed targets, identity checks, port reservations, prototype PID checks, link/junction refusal, file hashes, staged removal and explicit confirmation protect the boundary. A failure retains recovery material and reports remaining pending folders. Neither maintenance tool runs automatically.

## Final release behavior

The normal launcher uses port 5000 and `%LOCALAPPDATA%\AdvisePoint Docs`. Normal update controls are restored by explicit approval. The application version is 1.3.0, without a candidate banner or local-test package marker.

The v1.2.8 updater and architecture-specific Node 20.18.1/native runtime are preserved. Matching Windows x64 and ARM64 packages use one shared, architecture-neutral source archive.

For a fresh rebuild, extract into a new application folder, close all apps, run the optional WORKING reset, then start the final app and reimport. Read `START-FRESH.txt` first. Test cleanup is a separate, later action; recovery copies are not automatically purged.

## Validation and limitations

ARM64 candidate 13 was reported working as expected so far on September 22. This is limited field feedback, not full x64, browser-matrix or physical-print certification.

Candidate 13 previously passed actual four-page range/content/button-target checks for the three supplied native manuals in Linux Chromium and Firefox, and 35 focused automated tests. Final packaging and maintenance-tool checks are documented separately in `v1.3.0-final-verification.md`; prior fixture-backed checks must not be represented as fresh reruns.

Fourteen pre-existing TypeScript diagnostics remain. This release does not claim a clean whole-project typecheck, universal PDF compatibility, OCR, or resolution of the separate Edge idle-connection issue. Native Windows testing of the final launcher and new maintenance tools remains necessary.

No user library was reset or deleted, no in-place production installation was performed, and no GitHub release or public update feed was published during preparation.
