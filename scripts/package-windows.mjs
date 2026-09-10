import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Expected baseline launcher hash. Guards against a hostile or corrupt
// baseline slipping an unauthorized launcher change past us. When a release
// intentionally ships a new launcher, set NEW_LAUNCHER_SHA256 below and the
// packager will copy the repo's packaging/Start AdvisePoint Docs.bat over
// the baseline's copy.
//
// v1.0.8.1 baseline: AdvisePoint-Docs-v1.0.8.zip. Launcher bytes
// unchanged since v1.0.0 ("Start AdvisePoint Docs.bat" with the
// v0.9.34+ [launcher] framing plus the v1.0.0 rebrand of REM comments
// and APD_ env vars). Bookkeeping catch-up: prior v1.0.0..v1.0.8
// releases still pinned the pre-rename v0.9.36 hash (524235b3…) in
// EXPECTED, so re-packaging against the shipped v1.0.8 baseline was
// blocked. No launcher behavior change through v1.0.8.2.
//
// v1.0.8.3: launcher intentionally changes for the first time since
// v1.0.0. New behavior: suppress the "AdvisePoint Docs - crashed"
// window when %LOCALAPPDATA%\AdvisePoint Docs\.updating is present
// (coordinated with updater.cjs so an in-place upgrade no longer leaves
// a stray crash popup for the user to dismiss). EXPECTED is bumped to
// the shipped v1.0.8.2 baseline hash (still 7ac72e45… — v1.0.8.2 did
// not change the launcher). NEW_LAUNCHER_SHA256 is set to the v1.0.8.3
// hash so the packager overwrites the baseline copy with the repo copy.
const EXPECTED_LAUNCHER_SHA256 =
  "7ac72e45fdaf2ad2ca366ecbd651f6f13e1854b73f78017720914f551fa75c98";
// Set NEW_LAUNCHER_SHA256 to a hash string when a release intentionally
// changes the launcher; the packager then overwrites the baseline's
// launcher with the repo's copy and re-verifies. null = ship the
// baseline launcher as-is.
const NEW_LAUNCHER_SHA256 =
  "e6fd614e19549a0d79c654d5334c14073b225936e68a3529bd2eb267654b5967";
const APP_FOLDER = "AdvisePoint Docs";

function usage() {
  console.error(
    "Usage: npm run package:windows -- --baseline <v0.9.31.2.zip> " +
    "--output <release.zip> [--node-version 20.18.1]",
  );
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) {
      usage();
      process.exit(2);
    }
    result[key.slice(2)] = value;
  }
  return result;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  }
}

// v1.0.8.1: guard against a future worker `require("X")` slipping past
// WORKER_RUNTIME_DEPS. Scans every dist/workers/*.cjs for bare-name
// require() calls, filters out node: builtins and workers' own
// worker_threads/util/etc, and fails the build if any package name is
// not in either the copy list or the set of deps the baseline
// node_modules already ships (better-sqlite3, mammoth, pdf-parse, ...).
const NODE_BUILTINS = new Set([
  "assert", "buffer", "child_process", "cluster", "console", "constants",
  "crypto", "dgram", "dns", "domain", "events", "fs", "http", "http2",
  "https", "module", "net", "os", "path", "perf_hooks", "process",
  "punycode", "querystring", "readline", "repl", "stream", "string_decoder",
  "sys", "timers", "tls", "tty", "url", "util", "v8", "vm", "worker_threads",
  "zlib",
]);
// Present in the v1.0.0 baseline node_modules -- workers can safely
// require these without an explicit WORKER_RUNTIME_DEPS entry.
const BASELINE_NODE_MODULES = new Set([
  "better-sqlite3", "mammoth", "pdf-parse", "pdfjs-dist",
  "@napi-rs/canvas", "dotenv",
]);
function assertWorkerDeps(workersDir, extraDeps) {
  const allowed = new Set([...BASELINE_NODE_MODULES, ...extraDeps]);
  const bareRequire = /require\(\s*["']([^"'./][^"']*)["']\s*\)/g;
  const missing = new Set();
  for (const file of readdirSync(workersDir)) {
    if (!file.endsWith(".cjs")) continue;
    const src = readFileSync(join(workersDir, file), "utf8");
    let match;
    while ((match = bareRequire.exec(src)) !== null) {
      const raw = match[1];
      // Strip node: prefix and scoped-package subpaths -> package name.
      const noNodePrefix = raw.startsWith("node:") ? raw.slice(5) : raw;
      const pkg = noNodePrefix.startsWith("@")
        ? noNodePrefix.split("/").slice(0, 2).join("/")
        : noNodePrefix.split("/")[0];
      if (NODE_BUILTINS.has(pkg)) continue;
      if (allowed.has(pkg)) continue;
      missing.add(`${file}: require("${pkg}")`);
    }
  }
  if (missing.size > 0) {
    throw new Error(
      `Worker dep guard failed. dist/workers/ has require() calls to packages ` +
      `not in WORKER_RUNTIME_DEPS or the baseline node_modules:\n` +
      `  ${[...missing].join("\n  ")}\n` +
      `Add the package to WORKER_RUNTIME_DEPS in scripts/package-windows.mjs ` +
      `(if it's a new dep) or BASELINE_NODE_MODULES (if it ships in the ` +
      `v1.0.0 baseline). See v1.0.8.1 hotfix notes for the RTF regression ` +
      `this catches.`,
    );
  }
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const args = parseArgs(process.argv.slice(2));
if (!args.baseline || !args.output) {
  usage();
  process.exit(2);
}

const repoRoot = resolve(import.meta.dirname, "..");
const baseline = resolve(args.baseline);
const output = resolve(args.output);
const versionSource = readFileSync(join(repoRoot, "client", "src", "version.ts"), "utf8");
const version = versionSource.match(/APP_VERSION\s*=\s*"([\d.]+)"/)?.[1];
if (!version) throw new Error("Could not read APP_VERSION");
if (!existsSync(join(repoRoot, "dist", "index.cjs"))) {
  throw new Error("dist/index.cjs is missing; run npm run build:nobump first");
}

const scratch = mkdtempSync(join(tmpdir(), "apd-package-"));
try {
  run("unzip", ["-q", baseline, "-d", scratch]);
  const appRoot = join(scratch, APP_FOLDER);
  if (!existsSync(appRoot)) throw new Error(`Baseline has no "${APP_FOLDER}" folder`);

  const launcher = join(appRoot, "Start AdvisePoint Docs.bat");
  const baselineLauncherHash = sha256File(launcher);
  if (baselineLauncherHash !== EXPECTED_LAUNCHER_SHA256) {
    throw new Error(`Launcher baseline mismatch: ${baselineLauncherHash}`);
  }

  // v0.9.34: if the repo has an updated launcher and NEW_LAUNCHER_SHA256 is
  // set, copy the repo's launcher over the baseline's copy and verify its
  // hash matches what we recorded. This gives us two independent guards:
  //   1. The baseline's original launcher must still match its expected hash
  //      (so no baseline drift went unnoticed).
  //   2. The new launcher we're shipping must match its expected hash (so
  //      the repo checkout hasn't drifted from what we intended to ship).
  if (NEW_LAUNCHER_SHA256) {
    const repoLauncher = join(repoRoot, "packaging", "Start AdvisePoint Docs.bat");
    const repoLauncherHash = sha256File(repoLauncher);
    if (repoLauncherHash !== NEW_LAUNCHER_SHA256) {
      throw new Error(
        `Repo launcher mismatch. Expected ${NEW_LAUNCHER_SHA256}, got ${repoLauncherHash}. ` +
        `Update NEW_LAUNCHER_SHA256 in scripts/package-windows.mjs if this change is intentional.`,
      );
    }
    cpSync(repoLauncher, launcher);
  }

  rmSync(join(appRoot, "dist"), { recursive: true, force: true });
  cpSync(join(repoRoot, "dist"), join(appRoot, "dist"), { recursive: true });

  // v1.0.8: EXTRA_RUNTIME_DEPS retired. Direct deps added since v1.0.0
  // (e.g. iconv-lite, safer-buffer for RTF) are now bundled into
  // dist/index.cjs by script/build.ts. That script's assertKnownDeps()
  // fails the build if a direct dep isn't categorized, so the class of
  // bug this list existed to catch (v1.0.7.4.1 MODULE_NOT_FOUND at
  // startup) can no longer happen silently.
  //
  // v1.0.8.1 HOTFIX: the retirement of EXTRA_RUNTIME_DEPS above was
  // premature. dist/index.cjs is the *main-thread* server bundle, but
  // hand-written worker scripts in dist/workers/*.cjs (rtf-stripper.cjs,
  // extract-worker.cjs) are NOT bundled -- they run in worker_threads
  // and resolve their `require("...")` calls through node_modules at
  // runtime. Bundling iconv-lite into the main server broke RTF upload
  // because the worker still needs iconv-lite present on disk. Restore
  // a per-worker allowlist so worker deps are copied into the shipped
  // node_modules alongside the baseline deps. See assertWorkerDeps()
  // below for the guard that prevents this regression from recurring.
  const WORKER_RUNTIME_DEPS = [
    // rtf-stripper.cjs
    "iconv-lite",
    "safer-buffer",
  ];
  const workerNodeModules = join(repoRoot, "node_modules");
  const appNodeModules = join(appRoot, "node_modules");
  for (const dep of WORKER_RUNTIME_DEPS) {
    const src = join(workerNodeModules, dep);
    const dst = join(appNodeModules, dep);
    if (!existsSync(src)) {
      throw new Error(
        `Worker runtime dep '${dep}' missing from repo node_modules (${src}). ` +
        `Run 'npm install' before packaging.`,
      );
    }
    rmSync(dst, { recursive: true, force: true });
    cpSync(src, dst, { recursive: true });
  }
  assertWorkerDeps(join(appRoot, "dist", "workers"), WORKER_RUNTIME_DEPS);
  cpSync(
    join(repoRoot, "packaging", "Update AdvisePoint Docs.bat"),
    join(appRoot, "Update AdvisePoint Docs.bat"),
  );
  cpSync(
    join(repoRoot, "packaging", "updater"),
    join(appRoot, "packaging", "updater"),
    { recursive: true },
  );
  // v1.0.0: refresh the launcher-icon helper folders and the setup-icon .bat
  // from the repo so icon and shortcut changes actually reach the shipped
  // portable zip. Two locations get updated:
  //   - <appRoot>/launcher/          <- what Setup Icon (run once).bat reads
  //                                     at runtime (create-shortcut.ps1,
  //                                     run-hidden.vbs, and the .ico used by
  //                                     the desktop shortcut).
  //   - <appRoot>/packaging/launcher/ <- kept in sync so future baselines
  //                                      pick up the same files.
  // Remove any baseline copy first so stale files (e.g., an old .ico filename
  // like kyo.ico) don't linger alongside the new ones.
  rmSync(join(appRoot, "launcher"), { recursive: true, force: true });
  cpSync(
    join(repoRoot, "packaging", "launcher"),
    join(appRoot, "launcher"),
    { recursive: true },
  );
  rmSync(join(appRoot, "packaging", "launcher"), { recursive: true, force: true });
  cpSync(
    join(repoRoot, "packaging", "launcher"),
    join(appRoot, "packaging", "launcher"),
    { recursive: true },
  );
  cpSync(
    join(repoRoot, "packaging", "Setup Icon (run once).bat"),
    join(appRoot, "Setup Icon (run once).bat"),
  );
  cpSync(join(repoRoot, "packaging", "README.txt"), join(appRoot, "README.txt"));

  writeFileSync(join(appRoot, "VERSION"), `${version}\r\n`, "utf8");
  writeFileSync(join(appRoot, "NODE_VERSION"), `${args["node-version"] || "20.18.1"}\r\n`, "utf8");
  rmSync(join(appRoot, "seed.db"), { force: true });
  rmSync(join(appRoot, "pages"), { recursive: true, force: true });
  rmSync(join(appRoot, "dist.bak"), { recursive: true, force: true });

  rmSync(output, { force: true });
  run("zip", ["-qr", output, APP_FOLDER], scratch);

  console.log(`Created ${basename(output)}`);
  console.log(`version: ${version}`);
  console.log(`sha256: ${sha256File(output)}`);
  console.log(`launcher-sha256: ${sha256File(launcher)}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
