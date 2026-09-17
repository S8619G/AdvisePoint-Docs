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
//
// v1.0.9: baseline advances to AdvisePoint-Docs-v1.0.8.3.zip, so
// EXPECTED is bumped to the v1.0.8.3 launcher hash (e6fd614e…). The
// launcher itself did NOT change again in v1.0.9 — only the sibling
// "Update AdvisePoint Docs.bat" gained a new APD_LOCAL_ZIP forwarding
// branch, and that file is unconditionally copied from the repo (no
// hash gate). Therefore NEW_LAUNCHER_SHA256 is null and we ship the
// baseline's copy of Start AdvisePoint Docs.bat as-is.
// v1.0.11.1: baseline is now v1.0.11, which already shipped the
// post-v1.0.9.23 rewritten launcher. The hash it expects to see in the
// baseline advances accordingly, and NEW_LAUNCHER_SHA256 goes back to
// null so we ship the baseline copy byte-identical -- the v1.0.11.1
// hotfix does not touch packaging/Start AdvisePoint Docs.bat.
const EXPECTED_LAUNCHER_SHA256 =
  "f488c598bf5c80dcb4c1ba5ff445372196c210bc40a9f7f282b8e6d47e175799";
// Set NEW_LAUNCHER_SHA256 to a hash string when a release intentionally
// changes the launcher; the packager then overwrites the baseline's
// launcher with the repo's copy and re-verifies. null = ship the
// baseline launcher as-is.
const NEW_LAUNCHER_SHA256 = null;
const APP_FOLDER = "AdvisePoint Docs";

function usage() {
  console.error(
    "Usage: npm run package:windows -- --baseline <v0.9.31.2.zip> " +
    "--output <release.zip> [--node-version 20.18.1] [--arch x64|arm64] " +
    "[--arm64-node <node.exe>] [--arm64-modules <node_modules>] " +
    "[--x64-modules <node_modules>]",
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

// v1.2.0: allowed target architectures for the shipped Windows portable
// zip. x64 is the historical target; arm64 is introduced in v1.2.0 as a
// separate zip alongside the x64 zip. Neither the launcher nor the
// updater try to auto-detect at runtime -- each install is single-arch and
// the ARCH sentinel file (below) enforces that on upgrade.
const SUPPORTED_ARCHES = new Set(["x64", "arm64"]);

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
const targetArch = (args.arch || "x64").toLowerCase();
if (!SUPPORTED_ARCHES.has(targetArch)) {
  console.error(
    `Unsupported --arch value: ${targetArch}. Use one of: ${[...SUPPORTED_ARCHES].join(", ")}`,
  );
  process.exit(2);
}
if (targetArch === "arm64") {
  // The arm64 build cannot be assembled from the x64 baseline alone: the
  // baseline ships x64 copies of node.exe and every native .node file. We
  // require an arm64 node.exe on disk and an arm64 node_modules tree that
  // was installed with `npm install --os=win32 --cpu=arm64 --ignore-scripts`
  // -- the packager only copies the two native module folders that ship in
  // the end-user zip (see dependency-audit.md in the project files).
  if (!args["arm64-node"] || !args["arm64-modules"]) {
    console.error(
      "--arch arm64 requires --arm64-node <path-to-arm64-node.exe> and " +
      "--arm64-modules <path-to-arm64-node_modules>. See " +
      "wip/v1.2.0-arm64/dependency-audit.md for how to prepare them.",
    );
    process.exit(2);
  }
  if (!existsSync(resolve(args["arm64-node"]))) {
    console.error(`--arm64-node path does not exist: ${args["arm64-node"]}`);
    process.exit(2);
  }
  if (!existsSync(resolve(args["arm64-modules"]))) {
    console.error(`--arm64-modules path does not exist: ${args["arm64-modules"]}`);
    process.exit(2);
  }
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

  // v1.1.4 shipped a one-time tools/ folder containing the Align Document
  // Types utility, used to reconcile a library created before the document
  // type cleanup. That alignment has been run, so the tool is no longer
  // packaged. It remains in the repo at packaging/tools/ and can be run
  // directly with the bundled node if it is ever needed again:
  //   node "packaging/tools/align-doc-types.cjs" --db "<advisepoint.db>"

  // v1.0.15: ship the pre-rendered Welcome Guide PDF alongside README.txt.
  // The server's first-boot seeder (server/seed-welcome-guide.ts + the
  // seedWelcomeGuideIfNeeded() call in server/routes.ts) locates this file
  // via <APP>/welcome-guide/*.pdf and ingests it as a document with the
  // fixed id "seed-readme-v1". If the folder is missing from the repo
  // (e.g. the render step was skipped) the packager warns loudly but does
  // not fail; the server will still boot and log a warning.
  const welcomeSrc = join(repoRoot, "packaging", "welcome-guide");
  const welcomeDst = join(appRoot, "welcome-guide");
  rmSync(welcomeDst, { recursive: true, force: true });

  // v1.2.4 (item 4 fix): always REGENERATE the Welcome Guide PDF from the
  // current packaging/README.txt before packaging. Previous releases relied
  // on someone running scripts/render-welcome-guide.py by hand and copying
  // the output into packaging/welcome-guide/. That step was skipped for
  // v1.2.2 and v1.2.3 -- both shipped a PDF whose cover, running header,
  // and metadata still read "v1.2.1", because the source PDF in
  // packaging/welcome-guide/ was never re-rendered. The updater is not the
  // culprit; syncAppRoot() overwrites the shipped PDF just fine. The
  // shipped PDF was stale at packaging time.
  //
  // Regenerating here guarantees the PDF that lands in the zip has the
  // same version as README.txt (and therefore VERSION / client/src/version.ts,
  // which the release process keeps in lockstep). The render script is
  // idempotent -- passing the same README twice produces byte-identical
  // output on the same reportlab version -- so this adds nothing to the
  // per-build diff except when README.txt itself changed.
  //
  // If the render step fails (Python or reportlab missing on the packaging
  // host), we WARN and fall through to the existing behavior: the current
  // on-disk PDF is shipped. That keeps CI-less packaging from a fresh
  // clone from breaking outright, but the warning is loud enough to notice
  // when the version-mismatch bug is about to recur.
  const renderScript = join(repoRoot, "scripts", "render-welcome-guide.py");
  const welcomePdf = join(welcomeSrc, "AdvisePoint-Docs-Welcome-Guide.pdf");
  if (existsSync(renderScript)) {
    const py = process.env.PYTHON || "python3";
    const render = spawnSync(py, [renderScript, welcomePdf], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (render.status === 0) {
      const line = (render.stdout || "").trim().split("\n").pop() || "";
      console.log(`[package-windows] rendered Welcome Guide -- ${line}`);
    } else {
      console.warn(
        "[package-windows] render-welcome-guide.py failed; shipping the " +
        "existing on-disk PDF (may be stale). " +
        `Exit code: ${render.status}. Stderr:\n${render.stderr || "(empty)"}`,
      );
    }
  }

  if (existsSync(welcomeSrc)) {
    cpSync(welcomeSrc, welcomeDst, { recursive: true });
  } else {
    console.warn(
      "[package-windows] packaging/welcome-guide/ is missing -- " +
      "the shipped zip will NOT include the seed Welcome Guide PDF. " +
      "Run scripts/render-welcome-guide.py and copy the PDF into " +
      "packaging/welcome-guide/ before packaging.",
    );
  }

  // v1.2.0: refresh @napi-rs/canvas (the JS wrapper) alongside the
  // architecture-appropriate peer package so the wrapper and the native
  // binary always come from the same published canvas release. The
  // baseline zip carries an older wrapper+peer pair that predates the
  // win32-arm64-msvc peer; keeping the wrapper stale while dropping in a
  // newer arm64 peer would be an ABI mismatch (NAPI-RS pairs a wrapper
  // and a peer by exact version). For x64, refreshing the wrapper too is
  // an intentional but noted change -- the baseline's older
  // wrapper+x64 peer pair is replaced with the current pair so both
  // arches ship the identical canvas release. `bufferutil` remains
  // excluded on both arches (its optionalDependency has no win32-arm64
  // prebuild; ws works without it).
  const modulesSrc =
    targetArch === "arm64" ? args["arm64-modules"] : args["x64-modules"];
  if (!modulesSrc) {
    throw new Error(
      `--${targetArch}-modules <node_modules> is required so the packager can pull ` +
      `the win32-${targetArch}-msvc @napi-rs/canvas peer and the matching JS ` +
      `wrapper. Install with: npm install --os=win32 --cpu=${targetArch} ` +
      `--ignore-scripts into a scratch folder and pass its node_modules path.`,
    );
  }
  const modulesRoot = resolve(modulesSrc);

  // 1. @napi-rs/canvas JS wrapper: replace baseline copy with the copy from
  //    the scratch install. Same version+lockfile as the app, so the
  //    wrapper matches whichever peer we drop in next to it.
  const canvasWrapperSrc = join(modulesRoot, "@napi-rs", "canvas");
  const canvasWrapperDst = join(appRoot, "node_modules", "@napi-rs", "canvas");
  if (!existsSync(canvasWrapperSrc)) {
    throw new Error(
      `@napi-rs/canvas wrapper missing at ${canvasWrapperSrc}. Install with ` +
      `npm install --os=win32 --cpu=${targetArch} --ignore-scripts into the ` +
      `${targetArch} modules folder.`,
    );
  }
  rmSync(canvasWrapperDst, { recursive: true, force: true });
  cpSync(canvasWrapperSrc, canvasWrapperDst, { recursive: true });

  // 2. @napi-rs/canvas peer: remove the baseline x64 peer folder and drop
  //    in the architecture-appropriate one. `@napi-rs/canvas/js-binding.js`
  //    picks a peer by process.arch at runtime, so both folders CANNOT be
  //    present (the other would be dead weight and, in unrelated apps, has
  //    caused loader confusion when the wrong arch loads first).
  const canvasBaselineX64 = join(
    appRoot, "node_modules", "@napi-rs", "canvas-win32-x64-msvc",
  );
  const canvasPeerName = `canvas-win32-${targetArch}-msvc`;
  const canvasPeerSrc = join(modulesRoot, "@napi-rs", canvasPeerName);
  const canvasPeerDst = join(appRoot, "node_modules", "@napi-rs", canvasPeerName);
  if (!existsSync(canvasPeerSrc)) {
    throw new Error(
      `${targetArch} @napi-rs/canvas peer missing at ${canvasPeerSrc}. Install with ` +
      `npm install --os=win32 --cpu=${targetArch} --ignore-scripts into the ` +
      `${targetArch} modules folder.`,
    );
  }
  rmSync(canvasBaselineX64, { recursive: true, force: true });
  rmSync(canvasPeerDst, { recursive: true, force: true });
  cpSync(canvasPeerSrc, canvasPeerDst, { recursive: true });

  if (targetArch === "arm64") {
    // 3. node runtime: replace <appRoot>/node/node.exe with the arm64 build.
    const nodeDest = join(appRoot, "node", "node.exe");
    rmSync(nodeDest, { force: true });
    cpSync(resolve(args["arm64-node"]), nodeDest);

    // 4. better-sqlite3: replace the shipped x64 .node with the arm64 one
    //    installed into args["arm64-modules"]. Same NAPI ABI, same on-disk
    //    file layout, same file name -- the app resolves
    //    node_modules/better-sqlite3/build/Release/better_sqlite3.node
    //    regardless of arch, so only the binary needs to change.
    const bsqSrc = join(
      modulesRoot,
      "better-sqlite3",
      "build",
      "Release",
      "better_sqlite3.node",
    );
    const bsqDst = join(
      appRoot,
      "node_modules",
      "better-sqlite3",
      "build",
      "Release",
      "better_sqlite3.node",
    );
    if (!existsSync(bsqSrc)) {
      throw new Error(
        `arm64 better-sqlite3 prebuild missing at ${bsqSrc}. Install with ` +
        `npm install --os=win32 --cpu=arm64 --ignore-scripts into the arm64 ` +
        `modules folder, then npx prebuild-install --target=<node-version> ` +
        `--runtime=node --arch=arm64 --platform=win32 inside better-sqlite3/.`,
      );
    }
    rmSync(bsqDst, { force: true });
    cpSync(bsqSrc, bsqDst);
  }

  writeFileSync(join(appRoot, "VERSION"), `${version}\r\n`, "utf8");
  writeFileSync(join(appRoot, "NODE_VERSION"), `${args["node-version"] || "20.18.1"}\r\n`, "utf8");
  // v1.2.0: ARCH sentinel. The updater refuses an upgrade whose incoming
  // ARCH does not match the installed one, so an x64 user cannot
  // accidentally overlay an arm64 zip (or vice versa) and end up with a
  // half-swapped mixed-arch install.
  writeFileSync(join(appRoot, "ARCH"), `${targetArch}\r\n`, "utf8");
  rmSync(join(appRoot, "seed.db"), { force: true });
  rmSync(join(appRoot, "pages"), { recursive: true, force: true });
  rmSync(join(appRoot, "dist.bak"), { recursive: true, force: true });

  rmSync(output, { force: true });
  run("zip", ["-qr", output, APP_FOLDER], scratch);

  console.log(`Created ${basename(output)}`);
  console.log(`version: ${version}`);
  console.log(`arch: ${targetArch}`);
  console.log(`sha256: ${sha256File(output)}`);
  console.log(`launcher-sha256: ${sha256File(launcher)}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
