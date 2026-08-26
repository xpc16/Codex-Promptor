import { EventEmitter } from "node:events";

export const DEFAULT_UI_GRACE_MS = 30_000;

export class UiLifecycle extends EventEmitter {
  private activeClients = 0;
  private armed = false;
  private stopped = false;
  private idleTimer: NodeJS.Timeout | null = null;

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
    if (!this.armed || this.activeClients !== 0 || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.stopped && this.armed && this.activeClients === 0) this.emit("idle");
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

  private cancelIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
