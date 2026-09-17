# AdvisePoint Docs v1.2.6 build record

Unpublished replacement candidate for v1.2.5. Both v1.2.5 architectures passed
user in-place upgrade testing. v1.2.6 needs its own Windows field testing
before GitHub publication; prior-version approval does not transfer.

## Scope

- Pin multer 2.3.0 and override transitive qs to 6.16.0.
- Add conservative joined-"and" token splitting to the shared title parser.
  `CloudPrintandScan` now becomes `Cloud Print and Scan` on Upload and Library.
  Unknown compounds are left alone. Existing corpus outputs are unchanged.
- No server route, storage, restore, launcher, updater, or native binary changes.
- Rebuild both architecture packages and formatted Welcome Guides.

The vulnerability fixes address the
[multer multipart-field crash](https://github.com/advisories/GHSA-wc9g-mqfw-jrwm)
and [qs bracket/comma array-limit bypass](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx).
An audit reporting zero findings is not a comprehensive security certification.

## Baseline and lockfile

Before editing, the v1.2.5 source rebuilt all 11 dist files byte-for-byte
against the delivered x64 archive. Both architectures shared those dist files.

- v1.2.5 source SHA-256: `a2c8c86fd4ee12c939634198c64b77c321ea407042596a6c2e619585c74e16d7`
- v1.2.5 x64 SHA-256: `9e0009f3bb7e2cc2e2a5eec7356ca386116908ed9d76ac63a05061adeee47797`
- v1.2.5 ARM64 SHA-256: `c72ebffcf6ef79209b67d5c83d8d313ef58da6420c6d2eb03e2abe08f37ae2ce`

Only multer and qs change versions in the existing dependency tree.
npm also adds six optional nested WASM dependency records below
`@tailwindcss/oxide-wasm32-wasi`; no other existing package versions change.
The exact lockfile and a clean `npm ci` were used for the build.
Express remains 5.2.1 and body-parser remains 2.3.0.

## Reproduction and tests

```sh
npm ci
npm run check
npm run build:nobump
npx playwright install chromium
node --import tsx --test scripts/*.test.mjs scripts/*.test.cjs
npm audit
```

Do not use `npm run build` for reproduction: it advances the patch version.
The initial candidate used it once to advance 1.2.5 to 1.2.6.
On this Ubuntu 26.04 sandbox, Playwright uses
`PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64`.

- 215 non-browser tests and 14 browser/API tests pass, 229 total.
- npm audit reports zero known findings on 2026-09-17.
- Typecheck retains the same 15 baseline errors, with identical output:
  backup-scheduler (11), locate (2), routes (1), LibraryScanPanel (1).
- New regressions cover qs limits, malicious multipart fields, memory/disk
  uploads, filename escaping, exact upload-size limits, partial-file cleanup,
  actual built upload/update/restore endpoints, and backup export/merge import.
- Title tests cover the reported filename, either/both attached neighbors,
  unchanged ordinary words/models, trace, repeated operation, both UI surfaces,
  and persisted Save. The existing 25-filename corpus is unchanged.
- All test requests run on loopback with disposable data. Native Windows
  execution and wipe-and-replace restore are not newly field-validated here.

## Windows packaging

Reuse the verified v1.2.5 x64 baseline and its x64 native modules. For ARM64,
use the corresponding v1.2.5 ARM64 node.exe and native modules. Those native
bytes are unchanged from v1.2.4, so the verified v1.2.4 extracted modules used
in this session yield the same result.

```sh
npm run package:windows -- \
  --baseline /path/to/AdvisePoint-Docs-v1.2.5-x64.zip \
  --output /path/to/AdvisePoint-Docs-v1.2.6-x64.zip \
  --arch x64 --x64-modules "/path/to/x64/AdvisePoint Docs/node_modules"

npm run package:windows -- \
  --baseline /path/to/AdvisePoint-Docs-v1.2.5-x64.zip \
  --output /path/to/AdvisePoint-Docs-v1.2.6-arm64.zip \
  --arch arm64 --arm64-node "/path/to/arm64/AdvisePoint Docs/node/node.exe" \
  --arm64-modules "/path/to/arm64/AdvisePoint Docs/node_modules"

node scripts/package-source.mjs --output /path/to/AdvisePoint-Docs-v1.2.6-source.zip
```

Keep SHA-256 companions with all three ZIPs. Bundle identity is verified
against the final source rebuild, while native architecture, unchanged
launcher/updater, and regenerated PDF version are verified per archive.

## Field test before publication

1. Back up the library and verify the downloaded architecture ZIP checksum.
2. Upgrade each architecture from v1.2.5 and confirm v1.2.6 after relaunch.
3. Upload an ordinary document and verify its metadata and searchability.
4. Use `CloudPrintandScan` through Fix Title in Upload and Library.
5. Verify folder selection, Settings, and backup/restore on disposable data.
6. Obtain explicit publication approval. The release tag must point to the
   matching source, not an older repository snapshot.
