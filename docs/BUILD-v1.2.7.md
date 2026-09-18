# AdvisePoint Docs v1.2.7 Release Notes

## PDF scrolling reliability

Fixed a shared PDF viewer defect affecting x64 and ARM64: dragging the vertical
scrollbar beyond the currently mounted pages could leave a persistent blank
viewport. Entering a page number previously recovered that destination but did
not prevent subsequent blank regions.

- The page window now follows the actual scroll position, including large jumps
  and rapid direction changes, rather than waiting for old pages to intersect
  the viewport.
- Page dimensions determine stable layout before images finish loading. Mixed
  page sizes, zoom changes, and window resizing retain the reading position.
- Visible pages and a small nearby buffer load eagerly; the entire document is
  not mounted at once.
- Loading and rendering placeholders explain short waits. Failed image requests
  offer a per-page Retry button.
- Next/Previous, page-number entry, and search-result navigation jump immediately,
  avoiding delayed scroll animations that could conflict with manual scrolling.

## Compatibility and scope

No database migration, saved-document rewrite, launcher change, updater change,
or native-runtime dependency change is included. Both Windows architecture
packages use the same updated viewer and matching source.

This is a focused viewer release. Browser-heartbeat lifecycle changes, the
DEALER title-parsing correction, architecture-aware GitHub asset selection,
and dependency-security monitoring remain on the active roadmap.

## Verification and limits

The release gate includes a production build and boot smoke test; 215 existing
non-browser tests; 14 existing browser tests; and 12 new PDF checks (five layout
tests and seven browser scenarios). PDF coverage includes actual rendered guide
images, a 791-page mixed-size fixture, native scrollbar dragging, rapid reversals,
page jumps, zoom/resize, delayed/failed images, retry, partially rendered pages,
search-result jumps, print controls, and close/reopen.

Browser automation runs on Linux Chromium. It does not certify native Windows
x64/ARM64 execution or separately installed Chrome/Edge builds. Physical printing
and overnight browser lifecycle behavior are not tested by this viewer gate.
The existing 15 unrelated TypeScript diagnostics remain; no new diagnostic was
introduced in the changed files. The full npm dependency audit reports zero
known vulnerabilities at build time; this is not a guarantee against unknown
vulnerabilities or a complete runtime support-lifecycle audit.

The Welcome Guide is regenerated for v1.2.7. Release packaging verifies archive
integrity, architecture markers and native PE headers, unchanged native files
and launcher/updater, checksums, and matching rebuilt source output.

## Downloads and updating

- `AdvisePoint-Docs-v1.2.7-x64.zip`: Windows Intel/AMD x64.
- `AdvisePoint-Docs-v1.2.7-arm64.zip`: Windows ARM64.
- `AdvisePoint-Docs-v1.2.7-source.zip`: shared editable source, not an installer.
- `AdvisePoint-Docs-v1.2.7.zip`: byte-identical x64 compatibility alias.
- Each ZIP has a matching `.sha256` file.

Use the architecture-specific package. ARM64 users should use the local-ZIP
update route until architecture-aware GitHub updating is implemented; the
unmarked compatibility ZIP is x64, not a universal package.

Publication after the automated/package checks was explicitly authorized for
this release. Windows field confirmation remains outstanding at publication.
