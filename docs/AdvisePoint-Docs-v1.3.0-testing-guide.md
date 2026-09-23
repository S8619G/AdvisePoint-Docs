# AdvisePoint Docs v1.3.0 installation and testing guide

Updated September 22, 2026 for the final production-mode packages. These replace the isolated candidate packages; the normal launcher now uses the working library and port 5000, with normal update controls restored.

## Install and optionally rebuild

1. Keep the original manuals and documents you plan to reimport.
2. Close every AdvisePoint app console and PDF reader.
3. Extract the matching x64 or ARM64 ZIP into a new folder. Do not overlay an old candidate or the working installation.
4. To start fresh, run `Reset library (backup first).bat` before launching. Choose WORKING, inspect the path, and type `RESET WORKING LIBRARY`. Allow enough free space for an additional complete library copy.
5. The reset verifies the database/file backup, preserves the previous folder and creates an empty active folder. Keep both recovery copies until the rebuild is checked. Do not delete the database manually.
6. Start `Start AdvisePoint Docs.bat`. Confirm version 1.3.0 and port 5000, with no candidate banner. The normal data location is `%LOCALAPPDATA%\AdvisePoint Docs`.
7. Import a small mixed batch, check it, then import the remaining documents. Default settings and the Welcome Guide may appear automatically.
8. Make and verify a fresh library backup after reimport.

Reset is optional and is never part of normal startup. Without reset, the normal app opens the existing working library. Existing rendered documents stay supported; they are not automatically converted to retained-original storage.

## Remove isolated prototype and test data

Run `Clean prototype and test data (backup first).bat` only when ready to retire both test environments. Close every app first and keep them closed throughout the operation.

The only targets are:

- **PDF Prototype:** `%LOCALAPPDATA%\AdvisePoint Docs PDF Prototype`
- **v1.3.0 Test:** `%LOCALAPPDATA%\AdvisePoint Docs v1.3.0 Test`

The tool removes all content inside those roots, including the test documents, databases, logs and temporary files. It first copies both roots into an existing recovery folder you choose, verifies each file, stages the originals, then removes them only after another verification pass.

Use a recovery folder on another drive if the goal is to reclaim laptop disk space. Review the exact paths and type `REMOVE PROTOTYPE AND TEST DATA`. Identity mismatches, occupied app ports, an active prototype process, links/junctions, changed files or backup failure stop the operation.

The working library, reset backups, source manuals, downloaded ZIPs/PDFs, extracted app folders, browser caches and general Windows Temp are not targets. Recovery copies are retained; there is no automatic purge. Starting an old test app may recreate a test data folder.

If cleanup stops, keep the reported recovery and `.cleanup-pending-` folders and the error message. Do not force deletion; stop all apps before seeking recovery help.

## PDF acceptance checks

- **Native ranges:** On a long manual, select 100–103 and choose Open PDF to print. Confirm exactly four correct pages; choose All pages in that prepared reader. Also check Current page, 1–3, 300–350 and a whole manual.
- **Protected PDFs:** Permitted encrypted ranges use a selected-page image PDF when direct copying fails. No-print restrictions remain enforced. Preparation failure must not silently substitute the entire original.
- **Original handoff:** Explicit Open original PDF always opens the entire original. Large rendered-PDF handoff still requires choosing the original page range in the reader.
- **Dialog behavior:** The preparation dialog stays open after handoff. Done closes it and cleans job-owned temporary resources without closing the reader or deleting downloads.
- **Input behavior:** Clicking or tabbing into range fields selects the number. Backspace permits an empty draft. Zero and arrow keys edit fields instead of controlling the viewer.
- **Recovery:** Check cancellation, retry, Close/Escape, a fresh print job, downloads and the Windows default PDF application.

Use Chrome, Edge and Firefox on both Windows architectures as practical. Record physical output separately from on-screen PDF preparation; successful preview is not proof of successful paper printing.

## Library acceptance checks

- **Mixed import:** Import ordinary PDFs and DOCX/RTF documents. Confirm titles, search, page viewing and intact originals where available.
- **Restricted fallback:** Check the explicit rendered-import warning and completion. Open another retained PDF while fallback rendering is active.
- **Backup/restore:** Use a disposable library or verified recovery plan. Confirm retained originals survive export and restore; never overwrite the only good library to test.
- **Responsiveness:** Check scrolling, page jumps and search during active background rendering.
- **Maintenance tools:** Test on disposable Windows data before relying on them for the real rebuild. The automated Linux filesystem tests do not certify Windows file-lock or filesystem behavior.

If anything fails, record architecture, browser, action, time and error. Settings > Export diagnostics includes upload journals; review filenames and paths before sharing.

## Known scope

Candidate 13 ARM64 changes were reported working as expected so far. Final production-launcher and maintenance-tool Windows acceptance, x64 coverage and physical printing remain open. Fourteen pre-existing TypeScript diagnostics remain, and the separate Edge idle-connection investigation is unresolved.

The final verification report distinguishes fresh automated results from prior candidate evidence. Supplied-manual and full 724-page fixture checks cannot be claimed as new reruns without those fixtures.
