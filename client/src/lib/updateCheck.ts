// Update checker - polls GitHub Releases for a newer tag than the installed version.
//
// Public-repo, no-auth API call. Silent failure if offline, GitHub rate-limited,
// or the endpoint is unreachable. Nothing is ever posted back to GitHub.
//
// Cadence:
//   - Checks on app load
//   - Then every 24 hours while the app is open
//   - Result cached in localStorage with a 24h freshness window so a browser
//     refresh doesn't hammer the endpoint
//
// Skip behavior:
//   - "Skip this version" writes the tag to localStorage
//   - Skipped versions never trigger the banner
//   - A newer release than the skipped one WILL re-trigger the banner
import { APP_VERSION } from "../version";

const OWNER = "S8619G";
const REPO = "advisepoint-docs";
const LATEST_URL = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;

const CACHE_KEY = "apd:update:cache";
const SKIP_KEY = "apd:update:skip";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface LatestRelease {
  version: string;       // "0.9.15"  (leading v stripped)
  tag: string;           // "v0.9.15" (raw tag)
  name: string;          // human-readable release name
  htmlUrl: string;       // GitHub release page
  body: string;          // release notes markdown
  publishedAt: string;   // ISO timestamp
  zipUrl: string | null; // direct .zip asset download URL if present
}

interface CachedResult {
  fetchedAt: number;
  release: LatestRelease | null;
  // v0.9.34: version the cache was created against. When the installed version
  // changes (fresh install of an update), a stale cached "you're up to date"
  // result would otherwise suppress the banner for another 24h even though the
  // user just installed a newer build and the cache was created against the
  // OLD version. Recording the installed version lets us invalidate the cache
  // the first time we're loaded under a different version.
  installedVersion?: string;
}

// Compare two semver-ish strings. Returns 1 if a > b, -1 if a < b, 0 if equal.
// v0.9.36.3: previously hard-capped to 3 segments via .slice(0, 3), which
// collapsed our same-day hotfix suffix convention (0.9.36.1 vs 0.9.36.2) to
// the same value and reported "on the latest version" incorrectly. Now
// compares every numeric segment. A missing trailing segment is treated as
// 0 so 0.9.36 == 0.9.36.0 < 0.9.36.1. Pre-release/build metadata after a
// `-` or `+` is still ignored (matches the isPlausibleTag guard).
export function cmpVersion(a: string, b: string): number {
  const parse = (s: string) =>
    s
      .replace(/^v/i, "")
      .split(/[\-+]/)[0] // drop pre-release / build metadata
      .split(".")
      .map((x) => {
        const n = parseInt(x, 10);
        return isNaN(n) ? 0 : n;
      });
  const av = parse(a);
  const bv = parse(b);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i++) {
    const ai = av[i] ?? 0;
    const bi = bv[i] ?? 0;
    if (ai !== bi) return ai > bi ? 1 : -1;
  }
  return 0;
}

// v0.9.16: strict URL guard. Anything we render as a link in the banner MUST
// point at the expected GitHub host and repo path. Belt-and-suspenders defense
// against a hypothetical compromised response — the browser origin restriction
// on the fetch already largely protects us, but let's not render a stray
// href we couldn't guarantee ourselves.
const ALLOWED_HOST = "github.com";
const ALLOWED_PATH_PREFIX = `/${OWNER}/${REPO}/`;

function isTrustedGithubUrl(u: unknown): u is string {
  if (typeof u !== "string") return false;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "https:") return false;
    if (parsed.hostname !== ALLOWED_HOST) return false;
    return parsed.pathname.startsWith(ALLOWED_PATH_PREFIX);
  } catch {
    return false;
  }
}

// Semver-ish tag names — refuses anything with unexpected characters.
function isPlausibleTag(t: unknown): t is string {
  return typeof t === "string" && /^v?\d+\.\d+\.\d+(?:[.\-+][\w.\-+]*)?$/.test(t);
}

async function fetchLatest(): Promise<LatestRelease | null> {
  try {
    const resp = await fetch(LATEST_URL, {
      headers: { Accept: "application/vnd.github+json" },
      // No credentials - public endpoint, no cookies needed
      credentials: "omit",
      cache: "no-store",
    });
    if (!resp.ok) return null;
    const json = await resp.json();

    // Validate shape before trusting anything from the response.
    if (!json || typeof json !== "object") return null;
    if (!isPlausibleTag(json.tag_name)) return null;

    // html_url must point at our repo. Fall back to the /releases/latest URL
    // (which we built ourselves) if the returned one is missing or wrong.
    const htmlUrl = isTrustedGithubUrl(json.html_url)
      ? json.html_url
      : `https://github.com/${OWNER}/${REPO}/releases/latest`;

    // Find a .zip asset with a trusted download URL. If it doesn't validate,
    // set zipUrl to null and the banner shows only the "What's new" button.
    let zipUrl: string | null = null;
    if (Array.isArray(json.assets)) {
      const asset = json.assets.find(
        (a: any) =>
          typeof a?.name === "string" &&
          a.name.toLowerCase().endsWith(".zip") &&
          isTrustedGithubUrl(a?.browser_download_url),
      );
      if (asset) zipUrl = asset.browser_download_url;
    }

    // String fields — clamp lengths to defend against absurdly-long payloads.
    const nameRaw = typeof json.name === "string" ? json.name : json.tag_name;
    const bodyRaw = typeof json.body === "string" ? json.body : "";
    const publishedAtRaw = typeof json.published_at === "string" ? json.published_at : "";

    return {
      tag: json.tag_name,
      version: String(json.tag_name).replace(/^v/i, ""),
      name: nameRaw.slice(0, 200),
      htmlUrl,
      body: bodyRaw.slice(0, 20_000),
      publishedAt: publishedAtRaw.slice(0, 40),
      zipUrl,
    };
  } catch {
    return null;
  }
}

function readCache(): CachedResult | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedResult;
    if (typeof parsed?.fetchedAt !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(release: LatestRelease | null) {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        fetchedAt: Date.now(),
        release,
        installedVersion: APP_VERSION,
      }),
    );
  } catch { /* ignore quota */ }
}

/** Get the latest release, using cache if fresh (<24h). Returns null on failure. */
export async function getLatestRelease(forceRefresh = false): Promise<LatestRelease | null> {
  const cached = readCache();
  // v0.9.34: bypass the freshness window on the very first call after an app
  // version change. Without this, upgrading from vN to vN+1 leaves any prior
  // cached response (which was created against vN) in place for up to 24h,
  // hiding the fact that the user is now on a newer version and possibly
  // showing a stale "vN+2 available" banner from before the update ran. If
  // the cache lacks installedVersion (created by an older build) we also
  // treat it as version-mismatched to force one fresh fetch.
  const versionMismatch = cached && cached.installedVersion !== APP_VERSION;
  if (
    !forceRefresh &&
    !versionMismatch &&
    cached &&
    Date.now() - cached.fetchedAt < CHECK_INTERVAL_MS
  ) {
    return cached.release;
  }
  const fresh = await fetchLatest();
  writeCache(fresh);
  return fresh;
}

export function getSkippedVersion(): string | null {
  try { return localStorage.getItem(SKIP_KEY); } catch { return null; }
}

export function skipVersion(tag: string) {
  try { localStorage.setItem(SKIP_KEY, tag); } catch { /* ignore */ }
}

export function clearSkippedVersion() {
  try { localStorage.removeItem(SKIP_KEY); } catch { /* ignore */ }
}

/**
 * Decide whether an update banner should show, given the currently-installed
 * version and the latest release. Returns null if no banner should show.
 */
export function shouldShowBanner(
  installed: string,
  latest: LatestRelease | null,
  skipped: string | null,
): LatestRelease | null {
  if (!latest) return null;
  if (cmpVersion(latest.version, installed) <= 0) return null;
  // Only suppress if the skipped tag is >= the latest tag (i.e. user already
  // dismissed this or newer). If a NEWER version arrives after skipping, show.
  if (skipped && cmpVersion(latest.tag, skipped) <= 0) return null;
  return latest;
}

// Convenience singleton API for the React hook to consume
export const UpdateCheck = {
  installed: APP_VERSION,
  getLatestRelease,
  getSkippedVersion,
  skipVersion,
  shouldShowBanner,
};
