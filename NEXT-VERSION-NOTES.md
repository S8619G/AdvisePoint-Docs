# Next version — planned changes

## 1. Duplicate-filename warning on the Upload screen

**Trigger**: when a file is staged in the Upload dropzone, check its filename
against existing library documents.

**Detection** (locked): filename stem only, case-insensitive. Ignore extension
so `MZ9500.pdf` staged against `MZ9500.PDF` already in library trips the
warning. No content hashing in this release.

**UI**: near the staged file row, show a red inline warning:

> ⚠ A document with this filename is already in the Library.

Do NOT block upload — user may intentionally want a newer version. Just warn.

**Batch mode**: same check applies per-file inside the staged list.

**Implementation sketch**:
- New endpoint `GET /api/documents/filename-check?names=a.pdf,b.pdf` returning
  `{ "a.pdf": true, "b.pdf": false }` (case-insensitive stem match).
- Client calls it whenever the staged file list changes (debounced).
- Store result in a `Set<string>` of duplicate filenames; render warning row
  when a staged file's name is in the set.

## 2. Settings → "Scan library for issues"

New section in the Settings drawer: **Library maintenance**.

### Scan action
Button: **Scan for duplicates and errors**. On click, backend runs:
- **Duplicate detection**: group documents by case-insensitive filename stem
  only. No content hashing.
- **Error detection**: docs whose page files are missing on disk, docs with
  zero excerpts, docs with `product_model` empty (already flagged in Library
  but list them here too as a "needs metadata" bucket).

### Results UI
A results panel showing three collapsible sections:
- **Duplicates** (N groups): each group is a card showing all copies side by
  side with title, upload date, product_model, page count, excerpt count.
  User picks which one to keep; others get **Delete** buttons.
- **Missing page files**: list with "Re-ingest" or "Delete" options.
- **Missing metadata**: list with "Open in Library" (jumps to edit).

**Thumbnails** (locked): metadata only, no thumbnails. Show title, upload
date, product_model, page count, excerpt count per copy.

### Backend
- `POST /api/library/scan` → returns `{ duplicates: [...], missingPages: [...], missingMetadata: [...] }`
- `DELETE /api/documents/:id` already exists; reuse it.

## Version target (locked)
Both features in **v0.9.22**.
