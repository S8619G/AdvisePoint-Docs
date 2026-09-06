import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
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
// v1.0.0 baseline: AdvisePoint-Docs-baseline-v1.0.0.zip, derived from the
// v0.9.36.4 portable zip with the top folder and launcher filename renamed
// (bytes preserved). Launcher bytes match the v0.9.34+ [launcher] framing
// version, hash 524235b3…016211ed.
const EXPECTED_LAUNCHER_SHA256 =
  "524235b353e16dc98f3bebd44fa548c236b1484654d9eb03e5effbac016211ed";
// v0.9.34: launcher gained additive [launcher] framing lines around the node
// invocation so pre/post-node context lands in server.log alongside the
// server's own output. Set to null to keep the baseline launcher unchanged.
// v1.0.0: launcher renamed to "Start AdvisePoint Docs.bat"; internal REM
// comments and env-var names rebranded to the new app name and APD_ prefix.
// Hash recomputed from the renamed repo launcher.
const NEW_LAUNCHER_SHA256 =
  "7ac72e45fdaf2ad2ca366ecbd651f6f13e1854b73f78017720914f551fa75c98";
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
