// Sends a periodic heartbeat so the local server knows the browser tab is
// still open. When the tab closes, pings stop and the server shuts itself
// down after its idle timeout, which lets the launcher's console close.
//
// v0.9.28: Heartbeats now continue while the tab is hidden. The previous
// visibility-pause was well-intentioned (skip a fetch every 5s when the tab
// is backgrounded) but it combined with the server's 15s idle-shutdown to
// cause the "lost connection to the database" overlay to fire whenever a
// user Alt-Tabbed to another app, minimized the window, or the screen
// locked. A localhost ping every 5s is effectively free, so we always run.
// On visibilitychange -> visible we also fire an immediate ping so the
// server sees us right away if it was mid-check.

const HEARTBEAT_INTERVAL_MS = 5000;

let timer: number | null = null;

async function ping() {
  try {
    await fetch("/api/heartbeat", {
      method: "GET",
      cache: "no-store",
      // keepalive lets the request complete even during page unload
      keepalive: true,
    });
  } catch {
    // Server may be shutting down or restarting — ignore.
  }
}

export function startHeartbeat() {
  // Fire one immediately so the server knows we're here.
  void ping();

  if (timer == null) {
    timer = window.setInterval(ping, HEARTBEAT_INTERVAL_MS);
  }

  // Belt-and-suspenders: on any transition back to visible, ping immediately
  // so we don't wait up to 5s for the next interval tick.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      void ping();
    }
  });
}
