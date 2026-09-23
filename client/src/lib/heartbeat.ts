// Diagnostic browser presence only. A quiet tab never stops the local server.
const HEARTBEAT_INTERVAL_MS = 5000;
let timer: number | null = null;
let pending = false;

async function ping() {
  if (pending) return;
  pending = true;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 4000);
  try {
    await fetch("/api/heartbeat", {
      method: "GET", cache: "no-store", signal: controller.signal,
    });
  } catch {
    // Health polling handles a stopped or restarting service.
  } finally {
    window.clearTimeout(timeout);
    pending = false;
  }
}

export function startHeartbeat() {
  if (timer !== null) return;
  void ping();
  timer = window.setInterval(ping, HEARTBEAT_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void ping();
  });
  window.addEventListener("focus", () => void ping());
  window.addEventListener("pageshow", () => void ping());
}
