#!/usr/bin/env node
// v1.0.13.1: source zip packager with completeness guard.
//
// v1.0.12.4's source zip omitted postcss.config.js, tailwind.config.ts, and
// components.json. Rebuilds from it produced a Tailwind-less CSS bundle that
// silently shipped a broken UI in v1.0.13.0. Never again.
//
// This script:
//   1. Verifies every path in REQUIRED_SOURCE_PATHS exists at the repo root.
//   2. Fails loudly if any is missing.
//   3. Otherwise, produces a source zip under the requested --output path
//      with an `advisepoint-src/` prefix, excluding node_modules / dist /
//      build-out / .git / *.tsbuildinfo.
//
// Usage:
//   node scripts/package-source.mjs --output ../AdvisePoint-Docs-v1.0.13.1-source.zip

import { existsSync, mkdtempSync, rmSync, cpSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Files that MUST be in every source zip. A missing entry from this list is
// what silently broke v1.0.13.0. Do not remove without a written reason and
// a replacement guard.
const REQUIRED_SOURCE_PATHS = [
  // Build tooling
  "script/build.ts",
  "server/pdf-compat.ts",
  "server/workers/pdf-compat.cjs",
  "server/workers/compat-inspect.cjs",
  "server/workers/compat-inspection-process.cjs",
  "packaging/pdf-engine/x64/qpdf.exe",
  "packaging/pdf-engine/arm64/qpdf.exe",
  "packaging/pdf-engine/x64/SHA256SUMS",
  "packaging/pdf-engine/arm64/SHA256SUMS",
  "packaging/pdf-engine/x64/THIRD-PARTY.md",
  "packaging/pdf-engine/arm64/THIRD-PARTY.md",
  "packaging/pdf-engine/x64/qpdf30.dll",
  "packaging/pdf-engine/x64/libgcc_s_seh-1.dll",
  "packaging/pdf-engine/x64/libstdc++-6.dll",
  "packaging/pdf-engine/x64/libwinpthread-1.dll",
  "scripts/package-windows.mjs",
  "scripts/package-source.mjs",
  "scripts/bump-version.mjs",
  // Build/config surface Vite + PostCSS + Tailwind + shadcn depend on
  "vite.config.ts",
  "tsconfig.json",
  "postcss.config.js",
  "tailwind.config.ts",
  "components.json",
  "docs/RELEASE-NOTES.md",
  "docs/TESTING-GUIDE.md",
  "package.json",
  "package-lock.json",
  // Runtime tree roots
  "client",
  "server",
  "server/workers/render-worker.cjs",
  "server/render-worker-client.ts",
  "server/workers/rendered-print-worker.cjs",
  "server/workers/print-pixels.cjs",
  "server/rendered-print.ts",
  "server/pdf-handoff.ts",
  "client/src/pdf-handoff.ts",
  "scripts/pdf-handoff.test.mjs",
  "scripts/rendered-print.test.mjs",
  "client/src/rendered-print.ts",
  "client/src/components/PrintPreparationDialog.tsx",
  "shared",
  // Windows packaging assets consumed by scripts/package-windows.mjs
  "packaging/Start AdvisePoint Docs.bat",
  "packaging/Update AdvisePoint Docs.bat",
  "packaging/updater/updater.cjs",
  "packaging/launcher/AdvisePointDocs.ico",
  "packaging/launcher/create-shortcut.ps1",
  "packaging/launcher/run-hidden.vbs",
];

// Standard exclusions -- generated or environment-specific, never source.
const EXCLUDES = [
  "node_modules",
  "dist",
  "build-out",
  ".git",
  "**/*.tsbuildinfo",
  "verification",
  "docs",
  "packaging/test-v131.cjs",
  "packaging/local-test.cjs",
  "packaging/runtime-log.cjs",
  "packaging/LOCAL-TEST-README.txt",
  "packaging/tools",
  "scripts/local-candidate.test.mjs",
  // One-off personal maintenance tools are not part of future release source.
  "packaging/reset-library.cjs",
  "packaging/cleanup-test-data.cjs",
  "packaging/Reset library (backup first).bat",
  "packaging/Clean prototype and test data (backup first).bat",
  "packaging/START-FRESH.txt",
  "scripts/reset-library.test.cjs",
  "scripts/cleanup-test-data.test.cjs",
  ".DS_Store",
  "__MACOSX",
  "Thumbs.db",
  "desktop.ini",
];

function usage() {
  console.error("Usage: node scripts/package-source.mjs --output <path-to-zip>");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!k?.startsWith("--") || !v) { usage(); process.exit(2); }
    out[k.slice(2)] = v;
  }
  return out;
}

function assertRequiredPathsPresent(repoRoot) {
  const missing = [];
  for (const rel of REQUIRED_SOURCE_PATHS) {
    if (!existsSync(join(repoRoot, rel))) missing.push(rel);
  }
  if (missing.length > 0) {
    throw new Error(
      `Refusing to build a source zip -- required paths missing at repo root:\n` +
      `  ${missing.join("\n  ")}\n\n` +
      `A source zip missing any of these produces a broken rebuild. Restore ` +
      `the files and try again. See v1.0.13.1 hotfix notes for the failure ` +
      `mode this catches.`,
    );
  }
}

function run(command, args, cwd) {
  const r = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${command} failed: ${r.stderr || r.stdout}`);
}

const args = parseArgs(process.argv.slice(2));
if (!args.output) { usage(); process.exit(2); }

const repoRoot = resolve(import.meta.dirname, "..");
const output = resolve(args.output);

assertRequiredPathsPresent(repoRoot);

// Stage into a temp dir, copy under an advisepoint-src/ prefix, zip.
const scratch = mkdtempSync(join(tmpdir(), "apd-src-"));
try {
  const stageRoot = join(scratch, "advisepoint-src");
  const tarExcludeArgs = EXCLUDES.flatMap((e) => ["--exclude", e]);
  // Use tar for a fast copy that honours exclusions, then zip the staged tree.
  run("mkdir", ["-p", stageRoot]);
  run("bash", [
    "-c",
    `tar ${tarExcludeArgs.map((a) => JSON.stringify(a)).join(" ")} -cf - . ` +
    `| tar -xf - -C ${JSON.stringify(stageRoot)}`,
  ], repoRoot);

  // Keep current documentation, not historical candidate reports or plans.
  mkdirSync(join(stageRoot, "docs"), { recursive: true });
  for (const name of ["RELEASE-NOTES.md", "TESTING-GUIDE.md"])
    cpSync(join(repoRoot, "docs", name), join(stageRoot, "docs", name));

  // Re-verify inside the staged tree; guarantees the emitted zip is complete.
  for (const rel of REQUIRED_SOURCE_PATHS) {
    if (!existsSync(join(stageRoot, rel))) {
      throw new Error(`Post-stage sanity check failed -- missing ${rel} in staged tree`);
    }
  }

  // Zip it.
  const outName = basename(output);
  run("bash", ["-c", `rm -f ${JSON.stringify(output)} && cd ${JSON.stringify(scratch)} && zip -X9qr ${JSON.stringify(output)} advisepoint-src/`]);

  console.log(`Created ${outName}`);
  console.log(`stage: ${stageRoot}`);
  console.log(`output: ${output}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
