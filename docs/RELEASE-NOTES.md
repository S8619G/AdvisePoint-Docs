# AdvisePoint Docs v1.3.5

This release adds a Library quick search and a Query Auto Search switch, and
fixes a vertical stretch when zooming retained PDF pages. Library documents,
settings, backups, update checks and the v1.3.3/v1.3.4 features are unchanged.

## Changes

- **Library quick search:** a search box and Search button now sit under the
  Library heading; the page description moves to the right of the heading.
  The search narrows the normal list by the displayed document name, the
  original file name and metadata fields (document type, product model,
  product family, SKU, version, firmware, release channel, lifecycle status,
  confidentiality, tags and keywords). It never searches document text.
  Matching ignores capital letters and treats spaces, hyphens, underscores
  and periods alike; every entered word must appear somewhere in those
  fields. Enter or Search applies it; the X in the box or Esc clears it.
  Results keep the current sort and filters, with no scores or special
  ordering, and cards stay folded. A pill beside Search shows the active
  search, the count shows "N of M documents", and no matches shows a Clear
  option. Reset also clears the search. The search stays while switching tabs
  and clears when the app restarts.
- **Query Auto Search:** a switch at the right of the Filters header, on by
  default and remembered on this PC. While on, after a search has run,
  changing a filter (model, family, Selected family only, document type,
  confidentiality, tags, error-code and model suggestions, Clear, match
  mode) searches again with the current query after a short pause; the Max
  results slider searches again when released. Rapid changes produce one
  search, and an older response never replaces a newer one. It never searches
  from an empty box, and Reset never searches. A series of automatic re-runs
  leaves one Recent searches entry; the manual search that started it is kept.
  With the switch off, filters wait for Search as before.
- **PDF viewer zoom:** zooming in on a retained PDF page, including + after
  Fit or Zoom Page, no longer stretches the page vertically. The page keeps
  its proportions when the viewer narrows it to the window width.

## Verification limits

Automated checks cover quick-search matching, the Library layout and
keyboard use, Auto Search timing, stale-response and Recent searches
behavior, and retained-PDF page proportions across zoom steps in a Linux
browser with isolated data. Windows x64/ARM64 in-place upgrades, long-idle
Edge, backup-pair file-lock and restore behavior, and physical printing remain
field tests. Fourteen pre-existing TypeScript diagnostics and two pre-existing
filename-code test failures remain recorded separately.
