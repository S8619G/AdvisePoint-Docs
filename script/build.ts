import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile, mkdir, cp, mkdtemp } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";

// server deps to bundle to reduce openat(2) syscalls
// which helps cold start times
const allowlist = [
  "@google/generative-ai",
  "archiver",
  "axios",
  "cors",
  "date-fns",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-rate-limit",
  "express-session",
  "jsonwebtoken",
  "memorystore",
  "multer",
  "nanoid",
  "nodemailer",
  "openai",
  "passport",
  "passport-local",
  "stripe",
  "uuid",
  "ws",
  "xlsx",
  "zod",
  "zod-validation-error",
];

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  console.log("building client...");
  await viteBuild();

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });

  // Copy hand-written worker scripts (not bundled by esbuild — they require
  // native deps like pdf-parse/mammoth from node_modules at runtime).
  // See server/extract.ts for the runtime path resolution that expects them
  // to live at dist/workers/ next to dist/index.cjs.
  console.log("copying workers...");
  await mkdir("dist/workers", { recursive: true });
  await cp("server/workers", "dist/workers", { recursive: true });

  // Post-build launch smoke test.
  //
  // Added after v1.0.3 shipped a build that crashed on startup with
  // MODULE_NOT_FOUND because a new server dep (archiver) was missing from
  // the esbuild allowlist above. The dist bundle compiled cleanly, but the
  // packaged app could not boot because `require('archiver')` had no
  // corresponding bundled or copied module.
  //
  // This spawns the just-built `node dist/index.cjs` in an isolated tempdir
  // and either sees it bind to a port (success) or dies within ~10s
  // (failure). Runs on Linux and macOS CI; skipped on Windows only because
  // this build script is invoked from Linux/macOS.
  console.log("smoke-testing built server...");
  await smokeTestBuiltServer();
}

async function smokeTestBuiltServer(): Promise<void> {
  // Windows dev environments run the build via WSL/Git-Bash; the smoke test
  // only needs to run in one place, and Linux/macOS is our CI target.
  if (platform === "win32") {
    console.log("  (skipping smoke test on win32)");
    return;
  }

  const scratch = await mkdtemp(join(tmpdir(), "apd-smoke-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    // Force a random ephemeral port so the smoke test never collides with
    // an already-running dev server on 5000.
    PORT: "0",
    RAG_DB_PATH: join(scratch, "data.db"),
    RAG_PAGES_DIR: join(scratch, "pages"),
    RAG_NO_SEED: "1",
    APD_LOG_DIR: scratch,
  };

  const child = spawn("node", ["dist/index.cjs"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

  const outcome = await new Promise<{ ok: boolean; reason: string }>((resolve) => {
    const settled = { done: false };
    const settle = (result: { ok: boolean; reason: string }) => {
      if (settled.done) return;
      settled.done = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // best-effort; the process may already be dead
      }
      resolve(result);
    };

    // Success signal: server prints a startup line indicating it's listening.
    // Match the current server.ts log ("serving on port" / "listening on") and
    // any explicit 127.0.0.1 bind.
    const readyRegex = /(serving on port|listening on|127\.0\.0\.1:\d+)/i;
    const checkOutput = () => {
      if (readyRegex.test(stdout) || readyRegex.test(stderr)) {
        settle({ ok: true, reason: "server bound to port" });
      }
    };
    child.stdout?.on("data", checkOutput);
    child.stderr?.on("data", checkOutput);

    // Failure signal: MODULE_NOT_FOUND / uncaught exceptions / early exit.
    child.on("exit", (code, signal) => {
      settle({
        ok: false,
        reason: `server exited before binding (code=${code} signal=${signal})`,
      });
    });
    child.on("error", (err) => {
      settle({ ok: false, reason: `spawn error: ${err.message}` });
    });

    // Hard timeout so a hang can't stall CI.
    setTimeout(() => {
      settle({ ok: false, reason: "timed out after 15s waiting for startup" });
    }, 15_000);
  });

  // Cleanup scratch directory best-effort; leave it around on failure for
  // post-mortem inspection.
  if (outcome.ok) {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }

  if (!outcome.ok) {
    console.error(`SMOKE TEST FAILED: ${outcome.reason}`);
    console.error("--- stdout ---");
    console.error(stdout);
    console.error("--- stderr ---");
    console.error(stderr);
    console.error(`scratch dir preserved at: ${scratch}`);
    throw new Error("smoke test failed; refusing to package a broken build");
  }

  console.log(`  smoke test OK: ${outcome.reason}`);
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
