# AdvisePoint Docs v1.2.8

Focused updater reliability build. Prepared for Windows x64 and ARM64 field testing; not yet published.

## Changes

- Select the explicit binary for the installed architecture, independently of release-asset ordering. Exclude source ZIPs and other architectures. Legacy unmarked ZIPs remain x64-only fallbacks.
- Verify the selected download against its GitHub asset digest or matching checksum companion. An ambiguous release-wide checksum is not applied to an architecture-specific ZIP.
- Download, extract, and check integrity, version and architecture before stopping the application. Failed checks leave the running server alone.
- During file replacement, keep a verified recovery copy of managed application files. Recover launchers, modules, runtime and version markers along with the application bundle if replacement fails.
- Attempt to restart a safely preserved application after an updater-requested shutdown and failed installation. Verify application health rather than only an occupied port. If recovery itself fails, retain its files and report the need for manual recovery instead of launching a mixed installation.
- Prevent concurrent updater processes for the same installation. Do not delete a user-supplied local ZIP.
- Replace the misleading shutdown countdown and 20-second launch-failure assumption with updater progress/error reporting. Manual-download links open the release page instead of choosing an arbitrary asset.

## First upgrade into this version

An update is performed by the updater already installed on the laptop. Installing v1.2.8 cannot retroactively correct v1.2.6/v1.2.7 updater behavior.

On ARM64, use `AdvisePoint-Docs-v1.2.8-arm64.zip` through Settings > System > Install from a local zip, then click **Upgrade to v1.2.8 now**. Do not extract it over a running installation. The corrected automatic architecture selection applies to subsequent updates initiated from v1.2.8.

The unmarked `AdvisePoint-Docs-v1.2.8.zip` remains a byte-identical x64 compatibility alias. Shared editable source has no architecture suffix.

## Unchanged and limits

No database schema, runtime dependency, browser-heartbeat policy, title-parser or PDF-rendering change is included. The v1.2.7 PDF fix remains intact. This does not claim to fix the separate Edge/idle disconnection investigation.

Recovery here covers caught update failures, not a guarantee against power loss, forced process termination, disk failure or database-schema rollback. A successfully installed version that fails to start is reported for manual diagnosis rather than silently rolling back after it may have opened the database.

Windows x64 and ARM64 upgrade/restart field tests are required before publication. Automated Linux tests cannot verify Windows launcher/process behavior.
