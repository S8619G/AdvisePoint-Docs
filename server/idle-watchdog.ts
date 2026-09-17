// ---------------------------------------------------------------------------
// v1.1.6 -- sleep-aware idle shutdown.
//
// The server exits once the browser stops pinging /api/heartbeat, which is
// what lets the launcher's console window close on its own when the tab is
// closed. Until now that decision was made purely on elapsed wall-clock time:
//
//     if (Date.now() - lastHeartbeat > IDLE_SHUTDOWN_MS) process.exit(0);
//
// That cannot tell "the browser went away" from "the machine was suspended",
// and those need opposite responses. While a computer sleeps, node and the
// browser are both frozen, so no heartbeats arrive -- but the wall clock keeps
// advancing. On wake the watcher fired almost immediately, saw hours of
// apparent idleness, and exited before the browser tab had any chance to ping
// again. Any sleep longer than the idle window killed the server every time.
//
// The fix is to notice the suspend rather than to lengthen the window. This
// watcher is driven by a fixed-interval tick, so the interval itself is a
// clock: if far more wall-clock time passed than the tick interval accounts
// for, the process was not running for that difference. That time was not
// idle time and must not be counted as such.
//
// This module is pure and takes `now` as an argument so the behaviour can be
// tested directly, without real timers or real sleep.
// ---------------------------------------------------------------------------

export interface IdleWatchdogOptions {
  /** Exit after this much genuine idleness. */
  idleShutdownMs: number;
  /** How often tick() is expected to be called. */
  checkMs: number;
  /**
   * A tick arriving at least this late means the process was not running.
   *
   * Must sit well above normal scheduling jitter and well below
   * `idleShutdownMs`. A tick a full minute late on a ten-second interval is
   * not a loaded machine, it is a machine that was suspended.
   */
  suspendGapMs?: number;
}

export type TickAction =
  /** Keep running. */
  | { action: "wait" }
  /** Keep running; a suspend was detected and the idle clock was reset. */
  | { action: "resumed"; suspendedMs: number }
  /** Genuinely idle for longer than the window. */
  | { action: "shutdown"; idleMs: number };

export class IdleWatchdog {
  private readonly idleShutdownMs: number;
  private readonly suspendGapMs: number;

  private lastHeartbeat = 0;
  private hasSeenHeartbeat = false;
  private lastTickAt: number | null = null;

  constructor(opts: IdleWatchdogOptions) {
    this.idleShutdownMs = opts.idleShutdownMs;
    // Default: four tick intervals, but never less than a minute. The floor
    // matters because a short check interval would otherwise make the
    // threshold small enough for ordinary jitter to look like a suspend.
    this.suspendGapMs = opts.suspendGapMs ?? Math.max(opts.checkMs * 4, 60_000);
  }

  /**
   * Record the moment the tick interval was armed.
   *
   * Without this the very first tick has nothing to measure against, so a
   * machine suspended within one tick interval of startup would resume into
   * an immediate shutdown -- the exact failure this class exists to prevent,
   * just in a narrower window.
   */
  start(now: number): void {
    this.lastTickAt = now;
  }

  /** Record a browser heartbeat. */
  heartbeat(now: number): void {
    this.lastHeartbeat = now;
    this.hasSeenHeartbeat = true;
  }

  /** The gap that counts as a suspend. Exposed for logging and tests. */
  get suspendThresholdMs(): number {
    return this.suspendGapMs;
  }

  /** True once the browser has connected at least once. */
  get connected(): boolean {
    return this.hasSeenHeartbeat;
  }

  /**
   * Advance the watchdog. Call on a fixed interval.
   *
   * Ordering matters. The suspend check runs BEFORE the idle check, because
   * the tick that discovers the suspend is the same tick that would otherwise
   * shut the server down.
   */
  tick(now: number): TickAction {
    const previousTick = this.lastTickAt;
    this.lastTickAt = now;

    // Before the browser has ever connected there is nothing to miss. Still
    // record the tick above, so the first post-connection tick has a
    // baseline to measure against.
    if (!this.hasSeenHeartbeat) return { action: "wait" };

    // No baseline means we cannot distinguish elapsed time from suspended
    // time, so we must not act on it. Establishing the baseline (above) is
    // enough; the next tick can decide.
    if (previousTick === null) return { action: "wait" };

    {
      const gap = now - previousTick;

      // A backwards clock (an NTP correction, a manual change) makes every
      // elapsed-time comparison meaningless. Re-baseline and keep running:
      // staying up wrongly is recoverable, exiting wrongly is what we are
      // here to prevent.
      if (gap < 0) {
        this.lastHeartbeat = now;
        return { action: "resumed", suspendedMs: 0 };
      }

      if (gap >= this.suspendGapMs) {
        // The process was not running for most of this gap, so none of it
        // counts as idle. Restart the idle clock from the moment of resume
        // and give the browser the full window to reconnect. If the tab
        // really is gone, the next window elapses normally and we exit then.
        this.lastHeartbeat = now;
        return { action: "resumed", suspendedMs: gap };
      }
    }

    const idleMs = now - this.lastHeartbeat;
    if (idleMs > this.idleShutdownMs) return { action: "shutdown", idleMs };
    return { action: "wait" };
  }
}
