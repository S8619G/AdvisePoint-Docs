# AdvisePoint Docs 1.1.2

Release date: September 13, 2026

A follow-up to 1.1.1 addressing two issues found during field testing of the
Upload tab.

## Fixed

- **Document type is now detected automatically for single-file uploads.**
  Automatic classification from filename codes was only ever applied to
  batch uploads in per-file mode. When a single document was staged, the
  Document type field was left untouched and had to be set by hand — or by
  pressing Detect type. This affected every filename code, not only the
  Technical Bulletin codes where it was first noticed. Detection now also
  applies if the filename-code list finishes loading after the document has
  already been staged.

- **Filename codes separated from their number by a hyphen or underscore are
  now recognized.** Codes written as `TB-1`, `TB_1` or `TB-001` were not
  matched, so those documents were never classified. Forms such as `TB`,
  `TB1`, `TB1234` and `TB1a` were already recognized and are unchanged.

  A Document type that has been chosen manually is still never overwritten by
  automatic detection.

## Changed

- **The Title box in the Upload tab now spans the full width of the panel.**
  It previously occupied half the panel width, which left little room for
  long document titles once the Fix Title button was placed beside it.

## Notes

- Detection remains case-sensitive for codes it reads directly from a
  filename, so that ordinary lowercase words are not mistaken for codes.
- Fix Title behaviour is unchanged in this release.
