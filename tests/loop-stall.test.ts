import { describe, expect, it } from "vitest";
import { LoopStallMonitor } from "../src/engine/loop-stall.js";

describe("LoopStallMonitor (#810 per-sweep loop stall)", () => {
  it("counts a stall the timer has not observed yet when stopped", () => {
    let now = 1_000;
    const monitor = new LoopStallMonitor(10, () => now);
    monitor.start();
    now += 90; // the loop is held; no tick can fire before stop()
    expect(monitor.stop()).toBe(80);
  });

  it("reports no stall for a quiet sweep", () => {
    let now = 1_000;
    const monitor = new LoopStallMonitor(10, () => now);
    monitor.start();
    now += 5;
    expect(monitor.stop()).toBe(0);
  });

  it("measures a real synchronous block through the live timer", async () => {
    const monitor = new LoopStallMonitor(10);
    monitor.start();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const until = performance.now() + 80;
    while (performance.now() < until) { /* hold the loop */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(monitor.stop()).toBeGreaterThanOrEqual(60);
  });

  it("returns 0 when never started, and restarts from a clean max", () => {
    let now = 0;
    const monitor = new LoopStallMonitor(10, () => now);
    expect(monitor.stop()).toBe(0);
    monitor.start();
    now += 100;
    expect(monitor.stop()).toBe(90);
    monitor.start();
    now += 3;
    expect(monitor.stop()).toBe(0);
  });
});
