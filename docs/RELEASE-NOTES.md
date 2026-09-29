# AdvisePoint Docs v1.3.4

This release clarifies update messages. Library documents, settings, backups
and the v1.3.3 Query, Upload and scheduled-backup features are unchanged.

## Changes

- **Newer installed version:** when a successful check finds that the installed
  version is newer than the latest online release, About & updates shows a
  neutral message: "You have a newer version". It states both actual versions,
  that no updates are currently active, and that an alert will appear once a
  newer version is available. The previous amber warning about release tags is
  removed. An older online release is never offered as an update or downgrade.
- **Update wording:** checking, up-to-date, update-available and failure
  messages now refer to the online release or update service. A failed check
  reads "Couldn't get release information from the update service". The
  updater window uses the same wording, including for a newer installed version.
- **Check now:** the repository address and "No account needed" text beside
  Check now are removed. Check now behaves as before.
- **Release links:** What's new and Download continue to open the trusted
  release page for a newer version.

## Update alerts

While AdvisePoint Docs is open in the browser, it checks for a newer online
release when it loads and about once a day, using a cached result between
checks. A newer release shows the alert at the top of the window; Skip this
version hides that alert until a later release appears. No check runs while the
browser tab is closed, and no push or email notification is sent.

## Unchanged safeguards

The update source, trusted-address checks, architecture-specific package
selection, checksum verification, install confirmation and failed-update
recovery are unchanged. Local-ZIP updates still refuse the same or an older
version.

## Verification limits

Automated checks cover the new messages, version comparison, alert and skip
behavior, failure states and desktop/narrow layout with simulated release
responses. Windows x64/ARM64 in-place upgrades, long-idle Edge, backup-pair
file-lock and restore behavior, and physical printing remain field tests.
Fourteen pre-existing TypeScript diagnostics and two pre-existing filename-code
test failures remain recorded separately.
