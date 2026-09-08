// -------------------------------------------------------------------
// install-location.ts (v1.0.5)
// -------------------------------------------------------------------
// Detects when the portable app is running from a cloud-sync folder
// (OneDrive, Dropbox, Google Drive, iCloud, Box) or a UNC network path
// so we can warn users up-front instead of debugging silent
// "Failed to fetch" upload errors after the fact.
//
// Background: v1.0.4 field report of a DOCX upload silently failing with
// browser-side "Failed to fetch" and NO POST /api/upload reaching the
// server at all. Root cause: the app was running from inside a corporate
// OneDrive-synced folder. OneDrive can mark files as online-only
// placeholders, apply tenant DLP rules that block loopback uploads, or
// hold file locks during sync -- any of which produces "Failed to fetch"
// with no server-side signal.
//
// Behaviour:
//   * detectInstallLocation() -- one-time boot-time inspection of
//     process.cwd(). Emits a `[boot] warn install_location=...` log line
//     when a match hits. Returns a shape suitable for /api/health.
//   * Masks the path so a tenant name inside "OneDrive - <Tenant>" does
//     not leak into support pastes.
// -------------------------------------------------------------------

import * as path from "node:path";

export interface InstallLocationInfo {
  // false = running from a cloud-sync / network path we recommend against.
  ok: boolean;
  // Human-readable provider name when ok=false; null when ok=true.
  provider: string | null;
  // Path with any tenant identifier or username masked out. Safe to log
  // and safe to display in a support paste.
  masked_path: string;
}

// Patterns we recognise. Order matters -- the first match wins. We require
// a path-separator boundary so a folder literally named "MyOneDriveArchive"
// doesn't trip the OneDrive rule.
//
// Windows uses backslash, but the app also runs under macOS/Linux for dev
// smoke tests. Normalise to backslash before matching so one rule set works
// on both. Also match a leading backslash so root-adjacent installs like
// "C:\OneDrive\..." still trip.
interface Rule {
  provider: string;
  test: (normalised: string) => boolean;
}

const RULES: Rule[] = [
  {
    provider: "OneDrive",
    test: (p) => /\\OneDrive( -[^\\]*)?\\/i.test(p),
  },
  {
    provider: "Dropbox",
    test: (p) => /\\Dropbox( \([^)]*\))?\\/i.test(p),
  },
  {
    provider: "Google Drive",
    test: (p) => /\\Google ?Drive\\/i.test(p),
  },
  {
    provider: "iCloud Drive",
    test: (p) => /\\iCloud ?Drive\\/i.test(p),
  },
  {
    provider: "Box",
    test: (p) => /\\Box( Sync)?\\/i.test(p),
  },
  {
    provider: "Network path (UNC)",
    // Windows UNC paths start with two backslashes.
    test: (p) => /^\\\\/.test(p),
  },
];

// Mask user-identifying segments in a path so support pastes don't leak
// a tenant or username. Turn:
//   C:\Users\a04956\OneDrive - Kyocera Document Solutions America Inc\...\AdvisePoint Docs
// into:
//   C:\Users\<user>\OneDrive - <tenant>\...\AdvisePoint Docs
function maskPath(raw: string): string {
  let masked = raw;
  // Users\<name>\  ->  Users\<user>\
  masked = masked.replace(/(\\Users\\)([^\\]+)(\\)/i, "$1<user>$3");
  // OneDrive - <tenant>  ->  OneDrive - <tenant>
  masked = masked.replace(/(\\OneDrive -\s)([^\\]+)/i, "$1<tenant>");
  // Dropbox (<Team>)  ->  Dropbox (<team>)
  masked = masked.replace(/(\\Dropbox \()([^)]+)(\))/i, "$1<team>$3");
  return masked;
}

function normaliseForMatching(raw: string): string {
  // Convert forward-slashes (macOS/Linux, or any code that leaked them in)
  // to backslashes so the Windows-flavoured RULES table matches either way.
  return raw.replace(/\//g, "\\");
}

let cached: InstallLocationInfo | null = null;

export function detectInstallLocation(overridePath?: string): InstallLocationInfo {
  if (cached && !overridePath) return cached;

  const cwd = overridePath ?? process.cwd();
  const normalised = normaliseForMatching(cwd);
  const masked = maskPath(cwd);

  let hit: Rule | null = null;
  for (const rule of RULES) {
    if (rule.test(normalised)) {
      hit = rule;
      break;
    }
  }

  const info: InstallLocationInfo = hit
    ? { ok: false, provider: hit.provider, masked_path: masked }
    : { ok: true, provider: null, masked_path: masked };

  if (!overridePath) cached = info;
  return info;
}

// Emit a one-shot boot warning. Called from server/index.ts during
// boot after the crash trap is installed and logging is live.
export function logInstallLocationAtBoot(): void {
  const info = detectInstallLocation();
  const ts = new Date().toISOString();
  if (!info.ok) {
    // eslint-disable-next-line no-console
    console.log(
      `${ts} [boot] warn install_location=cloud_sync provider="${info.provider}" path="${info.masked_path}"`,
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(`${ts} [boot] install_location=ok path="${info.masked_path}"`);
  }
}

// Exposed for tests / dev tooling only.
export function _resetInstallLocationCacheForTests(): void {
  cached = null;
}

// Suppress "unused import" lint if path is not directly referenced --
// it's kept for future path normalisation on non-Windows dev boxes.
void path;
