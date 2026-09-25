/**
 * Longest event-loop stall during one sweep (#810 reopen signal).
 *
 * Node's monitorEventLoopDelay histogram can't do this per sweep: it records
 * a stall only when its timer next fires, and reset() also drops the next
 * sample. So a stall at the end of a sweep is lost either way. This timer
 * keeps its own baseline and, on stop, also counts the still-open gap since
 * the last tick. That gap is exactly a stall the timer hasn't observed yet.
 */
export class LoopStallMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTickMs = 0;
  private maxStallMs = 0;

  constructor(
    private readonly intervalMs = 10,
    private readonly now: () => number = () => performance.now(),
  ) {}

  start(): void {
    if (this.timer) return;
    this.lastTickMs = this.now();
    this.maxStallMs = 0;
    this.timer = setInterval(() => this.observe(), this.intervalMs);
    this.timer.unref?.();
  }

  /** Stop and return the longest stall in ms (one decimal), counting the open gap. */
  stop(): number {
    if (!this.timer) return 0;
    clearInterval(this.timer);
    this.timer = null;
    this.observe();
    return Math.round(this.maxStallMs * 10) / 10;
  }

  private observe(): void {
    const now = this.now();
    const stall = now - this.lastTickMs - this.intervalMs;
    if (stall > this.maxStallMs) this.maxStallMs = stall;
    this.lastTickMs = now;
  }
}
