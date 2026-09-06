// Bumps the patch component of APP_VERSION in client/src/version.ts.
// Called automatically at the start of `npm run build`.
// Idempotent: safe to run repeatedly, and does nothing if the file is unreadable.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const file = resolve(here, "..", "client", "src", "version.ts");

try {
  const src = readFileSync(file, "utf8");
  const m = src.match(/APP_VERSION\s*=\s*"(\d+)\.(\d+)\.(\d+)"/);
  if (!m) {
    console.warn("[bump-version] pattern not found; leaving file untouched");
    process.exit(0);
  }
  const [_, major, minor, patch] = m;
  const nextPatch = parseInt(patch, 10) + 1;
  const nextVersion = `${major}.${minor}.${nextPatch}`;
  const nextSrc = src.replace(/APP_VERSION\s*=\s*"[^"]+"/, `APP_VERSION = "${nextVersion}"`);
  writeFileSync(file, nextSrc);
  console.log(`[bump-version] ${major}.${minor}.${patch} \u2192 ${nextVersion}`);
} catch (err) {
  console.warn("[bump-version]", err.message);
  process.exit(0);
}
