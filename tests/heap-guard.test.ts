import { describe, expect, it, vi } from "vitest";
import { installHeapGuard } from "../src/heap-guard.js";

describe("heap guard", () => {
  it("logs loudly and exits non-zero when rss crosses the threshold", () => {
    let tick: (() => void) | null = null;
    const log = vi.fn();
    const exit = vi.fn();
    const clearIntervalFn = vi.fn();

    installHeapGuard({
      thresholdBytes: 1_500,
      intervalMs: 10,
      memoryUsage: () => ({ heapUsed: 1_100, rss: 1_600 }),
      log,
      exit,
      setIntervalFn: (fn) => {
        tick = fn;
        return "timer";
      },
      clearIntervalFn,
    });

    tick?.();

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("[cmuxlayer] FATAL heap guard"),
    );
    expect(exit).toHaveBeenCalledWith(expect.any(Number));
    expect(exit.mock.calls[0][0]).not.toBe(0);
    expect(clearIntervalFn).toHaveBeenCalledWith("timer");
  });
});
