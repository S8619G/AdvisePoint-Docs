# AdvisePoint Docs v1.3.3

This release adds focused Query and Upload controls and an optional two-copy
scheduled backup mode. Existing library documents and saved count-based backup
settings are preserved.

## Changes

- **Selected family only:** an unchecked-by-default checkbox below Product
  family limits results to documents explicitly assigned to that family.
  Without it, documents with no family remain eligible. Family Any disables
  the option; model and family lists remain independent.
- **Query Reset:** beside Search, clears the query, results and filters without
  deleting recent searches or documents. Delayed responses from an earlier
  search cannot repopulate the reset results.
- **Search state:** family-only selection is restored with recent searches and
  search URLs. Filtered URLs now reopen the correct tab after reload, and a
  pending URL update cannot navigate back to a tab that was just left.
- **Upload Reset:** at the right of Upload result, clears completed feedback
  without refreshing the browser. Imported documents, pending/failed staged
  files and editable fields are preserved. Reset is unavailable during uploads.
- **Backup wording:** Scheduled backups now labels retention as Backups to keep.
  The existing default of 7 and saved counts are unchanged.
- **Optional backup pair:** Latest backup + previous backup creates and verifies
  a new full archive before committing the rotation. The prior valid latest
  becomes previous. Existing dated/manual files are not removed by pair mode.
  Interrupted rotations are reconciled from the saved record on a later run.

## Backup mode details

Count-based retention remains the default. Pair mode uses an
`AdvisePoint-Scheduled-Pair` subfolder; Settings shows the timestamp and filename
of each recovery copy. The first successful run creates latest, and the second
establishes previous. Switching modes preserves the saved retention count.

Two full archives are retained in normal operation, not incremental changes.
Extra temporary space is required for creation and verification. Failure leaves
existing recovery copies intact; a cleanup failure may temporarily retain more
files. If neither existing copy verifies, automatic rotation stops rather than
discarding both. Keep an independent backup for longer history and drive failure.

## Compatibility and verification limits

The release audit identified an aborted-upload disk-write issue in the prior
Multer version. Multer is pinned to 2.4.0 for the fix described in
[GHSA-3pph-fpjx-jg34](https://github.com/advisories/GHSA-3pph-fpjx-jg34).
Other dependency upgrades are outside this release.

The browser-free PDF converter, PDF viewing/printing, metadata, recovery and
architecture-aware updater behavior from v1.3.2 remain. No real library reset,
conversion or backup cleanup is performed by installing this release.

Windows x64/ARM64 installation, file-lock and interruption behavior, long-idle
Edge acceptance and physical printing still require field testing. Automated
checks do not certify every PDF or storage device. Fourteen pre-existing
TypeScript diagnostics and two pre-existing filename-code regression failures
remain recorded separately.

These packages are for local field acceptance. GitHub publication requires
separate approval.
