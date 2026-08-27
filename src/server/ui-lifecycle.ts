import { EventEmitter } from "node:events";

export const DEFAULT_UI_GRACE_MS = 30_000;

export class UiLifecycle extends EventEmitter {
  private activeClients = 0;
  private armed = false;
  private stopped = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly backgroundHolds = new Set<string>();

  constructor(private readonly graceMs = DEFAULT_UI_GRACE_MS) {
    super();
  }

  connect(): void {
    if (this.stopped) return;
    this.armed = true;
    this.activeClients += 1;
    this.cancelIdleTimer();
  }

  disconnect(): void {
    if (this.stopped) return;
    this.activeClients = Math.max(0, this.activeClients - 1);
    this.scheduleIdleIfEligible();
  }

  setBackgroundHold(key: string, active: boolean): void {
    if (this.stopped || !key) return;
    if (active) {
      this.backgroundHolds.add(key);
      this.cancelIdleTimer();
      return;
    }
    if (!this.backgroundHolds.delete(key)) return;
    this.scheduleIdleIfEligible();
  }

  private scheduleIdleIfEligible(): void {
    if (!this.armed || this.activeClients !== 0 || this.backgroundHolds.size !== 0 || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.stopped && this.armed && this.activeClients === 0 && this.backgroundHolds.size === 0) this.emit("idle");
    }, this.graceMs);
    this.idleTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    this.cancelIdleTimer();
    this.removeAllListeners();
  }

  get clientCount(): number {
    return this.activeClients;
  }

  get backgroundHoldCount(): number {
    return this.backgroundHolds.size;
  }

  private cancelIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
