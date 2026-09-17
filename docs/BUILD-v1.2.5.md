# AdvisePoint Docs v1.2.5 build record

This is an unpublished Windows field-test candidate. Both architectures use
the same application source. Native Windows launch, update, folder dialogs,
and restore field tests remain pending.

## Baseline and reproduction

- Source: `AdvisePoint-Docs-v1.2.4-source.zip`, SHA-256
  `59d30a83f906915c196a067efd6fb6d74f6ff60f0c8ad9c2b3327b8a68a9e50b`.
- x64 baseline: `AdvisePoint-Docs-v1.2.4.zip`, SHA-256
  `4e8caadf2f58a90dd2309b530571fa5513449710ee41a46ab6966fea7e982186`.
- ARM64 baseline: `AdvisePoint-Docs-v1.2.4-arm64.zip`, SHA-256
  `b5ff80785bbcb386825b6914703eaa5e35b6ec29f04a544feff221c8ae77719a`.
- Before edits, `npm ci` and `npm run build:nobump` reproduced the complete
  v1.2.4 shipped `dist/` tree byte-for-byte.
- v1.2.5 was built with `npm run build` once, advancing 1.2.4 to 1.2.5.
  Rebuilding this source must use `npm run build:nobump`; `npm run build`
  intentionally advances the version again.

## Implemented scope

- Four Settings tabs: System, Formats, Backup / Restore, Developer.
- Shared, verbatim-extracted FixTitleButton on Upload and inside Library's
  Edit document dialog. It remains visible whenever a filename is present.
- Select folder input and button using shared folder filtering and staging.
- Explicit `-x64` and `-arm64` binary ZIP filenames.
- Corrected v1.2.4 folder-drop wording and v1.2.5 CHANGELOG entry.
- Updated Settings navigation and Fix Title documentation, with a regenerated
  Welcome Guide. PDF author metadata is set to Perplexity Computer.

The baseline combines installed version and updates inside UpdateCheckPanel.
That component is not split or duplicated. Settings did not persist tab keys
in URLs, so the backlog's conditional deep-link alias requirement is a no-op.
Existing panel components, server/shared code, launcher, updater, package
manifest, and lockfile are unchanged. There is no data migration.

Folder filtering now shares hidden-path handling across both entry points;
hidden directory contents are ignored along with dotfiles and OS metadata.
The subfolder count excludes root folders. Empty directories are not exposed
by the browser's directory FileList, so picker counts cover directories
represented by files. Existing queue deduplication is unchanged.

## Automated checks

Run from the extracted source root:

```sh
npm ci
npm run check
npm run build:nobump
npx playwright install chromium
node --import tsx --test scripts/*.test.mjs scripts/*.test.cjs
```

On the Ubuntu 26.04 build sandbox, Playwright 1.59.0 needs
`PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64` for installation and
execution. This is a test-host workaround, not a Windows runtime change.

- 202 existing non-browser tests pass.
- 6 new folder-collection tests pass.
- 11 browser tests pass, including 4 new v1.2.5 scenarios.
- Typecheck retains the exact same 15 known errors: backup-scheduler (11),
  locate (2), routes (1), LibraryScanPanel (1). Typecheck is not clean.
- Build CSS guard and isolated Linux server startup smoke test pass.
- Browser title test uploads to a temporary database, checks confirmation,
  Cancel, repeated application, Save, and persisted title after reload.
- Settings tests supply read-only duplicate/render-failure fixtures because
  those panels intentionally hide themselves on a healthy library.
- Screenshot review covers all four tabs, folder staging, title editing and
  title confirmation, including narrow layout checks.

## Packaging

Use the verified baseline ZIP and extracted runtime assets:

```sh
npm run package:windows -- \
  --baseline /path/to/AdvisePoint-Docs-v1.2.4.zip \
  --output /path/to/AdvisePoint-Docs-v1.2.5-x64.zip \
  --arch x64 \
  --x64-modules "/path/to/extracted-x64/AdvisePoint Docs/node_modules"

npm run package:windows -- \
  --baseline /path/to/AdvisePoint-Docs-v1.2.4.zip \
  --output /path/to/AdvisePoint-Docs-v1.2.5-arm64.zip \
  --arch arm64 \
  --arm64-node "/path/to/extracted-arm64/AdvisePoint Docs/node/node.exe" \
  --arm64-modules "/path/to/extracted-arm64/AdvisePoint Docs/node_modules"

node scripts/package-source.mjs \
  --output /path/to/AdvisePoint-Docs-v1.2.5-source.zip
```

The packager regenerates the Welcome Guide from README before each copy.
Both PDF covers and extracted contents must match version 1.2.5. PDF creation
timestamps and ZIP timestamps can differ between package runs.
Launcher SHA-256 must remain
`f488c598bf5c80dcb4c1ba5ff445372196c210bc40a9f7f282b8e6d47e175799`.
Keep matching `.sha256` companions with both binaries and source.

## Known security findings

The unchanged lockfile's npm audit on 2026-09-17 reports two affected
packages: multer (high) and qs (moderate). No dependency upgrade is included
in this narrowly scoped UI candidate. Do not treat this as a clean security
audit or an approved public release; review the findings before publication.
Full audit output is retained with the project verification evidence.

## Field-test checklist

1. Back up an existing library. Test only the ZIP matching the machine's
   architecture. Verify its SHA-256 before selecting it for local update.
2. Update from v1.2.4 to v1.2.5 and confirm version/architecture and relaunch.
3. Open all four Settings tabs. Check existing preferences and values remain.
4. Confirm Welcome Guide and Manage values are paired on a wide window and
   stacked on a narrow one. Confirm pre-restore snapshots remain in Recovery.
5. In Library, edit a document: Fix Title, Cancel comparison, Replace,
   click again, Cancel edit, reopen, apply again, Save, and reopen.
6. On Upload, select a nested folder, then test the drag-folder path with the
   same contents. Check unsupported and oversized notes and repeat dedupe.
7. Reinstall Welcome Guide and verify its cover reads application 1.2.5.
8. Exercise backup/restore only on disposable copies. Do not approve GitHub
   publication until both x64 and ARM64 field tests pass.
