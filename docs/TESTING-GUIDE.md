# AdvisePoint Docs v1.3.4 testing guide

Use the matching x64 or ARM64 binary ZIP and verify its SHA-256. Keep an
independent verified library backup before upgrading; shared source is not an
updater package.

## Upgrade and isolation

- **Upgrade:** from v1.3.3 or earlier, use Update now or the local-ZIP control
  with the matching architecture package. Confirm v1.3.4, reconnect and an
  unchanged searchable library. Preserve diagnostics if updating fails.
- **Production:** the normal launcher uses the real library and port 5000.
  Prototype 5100 and separate test launcher 5101 remain distinct. No isolated
  launcher or reset/delete utility is bundled.
- **Test data:** use an isolated test setup or an approved disposable library
  copy for mutation, restore and backup-failure tests.

## Update messages

Open Settings > System > About & updates.

- **Newer installed version:** when the installed version is newer than the
  latest online release, Check now shows "You have a newer version" in neutral
  styling, with both actual version numbers. No Update now, releases-page or
  downgrade action appears, and no alert banner is shown.
- **Same version:** shows "You're on the latest version".
- **Newer online release:** the top alert and panel show the release, with
  What's new, Download manually and Update now. Links open the trusted release
  page. Skip this version hides the alert until a later release appears.
- **Failure:** with the network disconnected, Check now reports that release
  information could not be retrieved from the update service. Query and
  Library continue to work.
- **Wording:** the Check now row has no repository address or "No account
  needed" text. Update titles, checking, failure and help text do not name the
  hosting provider. Check desktop and a narrow window.
- **Alert timing:** the check runs when the app loads and about once a day while
  it stays open in the browser. It does not run while the browser tab is closed
  and does not send push or email notifications.

## v1.3.3 features

Repeat a short check of Selected family only, Query Reset, Upload result Reset,
Backups to keep and Latest backup + previous backup, using the v1.3.3 procedures.
These features are unchanged in v1.3.4.

## Continuing field gates

- **Architecture:** in-place upgrades and live update discovery on both x64 and
  ARM64.
- **Backups:** restore each paired archive into isolated libraries; exercise
  Windows file locks, disconnected destinations and interruptions with
  disposable copies only.
- **Lifecycle:** leave Edge awake and idle at least four hours, then use Query,
  Library and Check now. Test final-tab closure, explicit Stop and relaunch.
- **PDF and printing:** normal, compatible restricted and older stored-page
  documents, print preparation and a physical printer.

Known baseline: 14 TypeScript diagnostics and the `GENENZZ42` model /
`HyPASENCG` custom-code test failures. Export diagnostics promptly after a
failure; logs can include paths and filenames, so review them before sharing.
