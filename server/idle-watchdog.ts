// Heartbeats are diagnostic only. A missing browser heartbeat cannot distinguish
// a closed tab from a suspended/discarded tab while Windows remains awake.
// Injected time permits multi-hour, awake-machine regressions without waiting.
export interface IdleWatchdogOptions {
  /** Diagnostic threshold only; never a shutdown deadline. */
  idleShutdownMs: number;
  checkMs: number;
  suspendGapMs?: number;
}
export type TickAction =
  | { action: "wait" }
  | { action: "resumed"; suspendedMs: number }
  | { action: "missing"; idleMs: number };

export class IdleWatchdog {
  private readonly idleShutdownMs: number;
  private readonly suspendGapMs: number;
  private lastHeartbeat = 0;
  private hasSeenHeartbeat = false;
  private lastTickAt: number | null = null;
  private missing = false;

  constructor(opts: IdleWatchdogOptions) {
    this.idleShutdownMs = opts.idleShutdownMs;
    this.suspendGapMs = opts.suspendGapMs ?? Math.max(opts.checkMs * 4, 60_000);
  }
  start(now: number): void { this.lastTickAt = now; }
  /** Returns true only when heartbeats recover after a reported absence. */
  heartbeat(now: number): boolean {
    const recovered = this.missing;
    this.lastHeartbeat = now;
    this.hasSeenHeartbeat = true;
    this.missing = false;
    return recovered;
  }
  get suspendThresholdMs(): number { return this.suspendGapMs; }
  get connected(): boolean { return this.hasSeenHeartbeat; }

  tick(now: number): TickAction {
    const previous = this.lastTickAt;
    this.lastTickAt = now;
    if (!this.hasSeenHeartbeat || previous === null) return { action: "wait" };
    const gap = now - previous;
    if (gap < 0 || gap >= this.suspendGapMs) {
      // A scheduling gap does not establish that Windows slept.
      this.lastHeartbeat = now;
      return { action: "resumed", suspendedMs: Math.max(0, gap) };
    }
    const idleMs = now - this.lastHeartbeat;
    if (idleMs > this.idleShutdownMs && !this.missing) {
      this.missing = true;
      return { action: "missing", idleMs };
    }
    return { action: "wait" };
  }
}
