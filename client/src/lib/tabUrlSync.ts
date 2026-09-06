// v0.9.31 - hash-URL sync helper for the per-tab stores.
//
// The app uses wouter's useHashLocation, so the URL looks like:
//   http://127.0.0.1:5000/#/query?q=foo&mode=phrase
//
// This helper updates the query-string portion after the '?' inside the
// hash without touching the base pathname (/query, /library, /library/:id)
// and without triggering a page reload.
//
// We debounce writes to avoid a history entry per keystroke on the
// search input. The debounce is short (150ms) so navigating to another
// tab doesn't race the pending write.

const DEBOUNCE_MS = 150;

let pendingHash: string | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Write `queryString` (e.g. "?q=foo&mode=phrase" or "") into the hash's
 * query-string portion. Callers pass the full `?...` fragment or an
 * empty string; the base path in front of the '?' is preserved.
 *
 * Uses history.replaceState so the browser back-button isn't polluted
 * with an entry per keystroke.
 */
export function writeHashQuery(queryString: string): void {
  // hash always starts with '#' when set; window.location.hash returns
  // the '#' too. Strip it so we can rebuild cleanly.
  const currentHash = window.location.hash || "#/";
  const withoutHash = currentHash.startsWith("#") ? currentHash.slice(1) : currentHash;
  const qmark = withoutHash.indexOf("?");
  const basePath = qmark >= 0 ? withoutHash.slice(0, qmark) : withoutHash;
  const nextHash = `#${basePath}${queryString}`;

  // No-op if nothing changed - avoids a redundant replaceState.
  if (nextHash === currentHash) return;

  pendingHash = nextHash;
  if (pendingTimer) return;
  pendingTimer = setTimeout(() => {
    if (pendingHash) {
      try {
        history.replaceState(null, "", pendingHash);
      } catch {
        // replaceState can throw in odd sandbox contexts; fall back to
        // a direct hash assign which does trigger a hashchange event.
        window.location.hash = pendingHash;
      }
    }
    pendingHash = null;
    pendingTimer = null;
  }, DEBOUNCE_MS);
}

/**
 * Read the current hash and return everything after the '?' (or "" if
 * there is no query string). Prefixed with "#" so it matches the shape
 * the store hydrators expect.
 */
export function readHashQuery(): string {
  return window.location.hash || "";
}
