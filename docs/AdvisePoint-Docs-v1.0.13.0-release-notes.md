# AdvisePoint Docs v1.0.13.0 — Release Notes

Field-test build. Not published to GitHub.

Baseline: v1.0.12.4. Public release remains v1.0.12.1.

## New

- **Settings → Recovery panel.** Lists documents the app preserved instead of deleting (both duplicate removals and single-document deletes), and the pre-restore snapshots created before a wipe-and-replace restore. Each preserved document can be restored back into the library or permanently deleted with a per-item confirmation; each snapshot can be permanently deleted with its own confirmation. Snapshot restoration is intentionally not exposed inside the running app.
- **Restore is stage-verify-swap.** Restoring a preserved document rebuilds its excerpts, page images, and (when kept) original file into a staging area, verifies them against the recorded manifest, and only then places them in the live library. A restore that finds a live document already using the same id is refused with a clear message and touches nothing.
- **Optional automatic cleanup of duplicate removals.** New Settings toggle (default off). When on, the app periodically removes only the preserved copies produced by duplicate deletion — never single-document deletes — and only when the kept copy is still present in the library, its recorded SHA-256 still matches, and it is still viewable (page images or retained original). Any failed check keeps the preserved copy on disk. A "Run cleanup now" button is available while the toggle is on.

## Changed

- **Post-update crash popup suppressed on all first launches.** The `.updating` sentinel that the launcher checks is now detected and removed on every Windows boot immediately after an update, not only on the first launch that also opens the browser. A user who opens the app after an in-place upgrade without the automatic browser step no longer sees a stale "AdvisePoint Docs — crashed" window.
- **Update-check dismiss control is now a labelled button.** The banner surfaced when the most recent updater run was suppressed or aborted now shows a "Dismiss" button in place of the small unlabelled icon. Behavior, keyboard focus, and its `Dismiss` accessible name are unchanged.

## Data safety

- Recovery destructive actions are one at a time and always confirmed.
- The automatic duplicate-cleanup sweep re-verifies the keeper's presence, hash, and viewability at the moment of deletion. A missing hash record, a hash mismatch, or an unviewable keeper aborts the deletion for that folder and leaves the data in place.
- Path validation on every recovery endpoint refuses folder names outside the preserved-data directories.

## Compatibility

- Windows only for this line. Windows-on-ARM support remains planned for the v1.1 line.
- No database migration is required.
- No launcher change. `Start AdvisePoint Docs.bat` is byte-identical to prior versions in the v1.0 line.
