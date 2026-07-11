import { describe, expect, it } from "vitest";
import {
  SurfaceWriteLivenessTracker,
  isBrokenPipeError,
} from "../src/surface-write-liveness.js";

describe("isBrokenPipeError", () => {
  it("recognizes structured and textual broken-pipe errors", () => {
    expect(
      isBrokenPipeError(
        Object.assign(new Error("write failed"), { code: "EPIPE" }),
      ),
    ).toBe(true);
    expect(
      isBrokenPipeError({ errno: 32, message: "socket write failed" }),
    ).toBe(true);
    expect(
      isBrokenPipeError(
        new Error("Failed to write to socket (Broken pipe, errno 32)"),
      ),
    ).toBe(true);
    expect(isBrokenPipeError(new Error("surface not found"))).toBe(false);
  });
});

describe("SurfaceWriteLivenessTracker", () => {
  it("marks repeated recent broken-pipe writes as dead", () => {
    let now = 1_000;
    const tracker = new SurfaceWriteLivenessTracker({
      now: () => now,
      failureThreshold: 2,
      failureWindowMs: 30_000,
    });

    tracker.recordFailure(
      "surface:1",
      Object.assign(new Error("write"), { code: "EPIPE" }),
    );
    now += 1_000;
    tracker.recordFailure("surface:1", new Error("Broken pipe, errno 32"));

    expect(tracker.observe("surface:1")).toMatchObject({
      pty_dead: true,
      consecutive_broken_pipe_failures: 2,
      last_attempt_at: 2_000,
    });
  });

  it("does not mark one transient broken-pipe write as dead", () => {
    const tracker = new SurfaceWriteLivenessTracker({
      failureThreshold: 2,
      failureWindowMs: 30_000,
      now: () => 1_000,
    });

    tracker.recordFailure(
      "surface:1",
      Object.assign(new Error("write"), { code: "EPIPE" }),
    );

    expect(tracker.observe("surface:1")?.pty_dead).toBe(false);
  });

  it("clears the consecutive failure chain after a healthy write", () => {
    let now = 1_000;
    const tracker = new SurfaceWriteLivenessTracker({
      now: () => now,
      failureThreshold: 2,
    });

    tracker.recordFailure("surface:1", new Error("EPIPE"));
    now += 1;
    tracker.recordSuccess("surface:1");
    now += 1;
    tracker.recordFailure("surface:1", new Error("EPIPE"));

    expect(tracker.observe("surface:1")).toMatchObject({
      pty_dead: false,
      consecutive_broken_pipe_failures: 1,
    });
  });

  it("interrupts the broken-pipe chain on a different write failure", () => {
    let now = 1_000;
    const tracker = new SurfaceWriteLivenessTracker({
      now: () => now,
      failureThreshold: 2,
    });

    tracker.recordFailure("surface:1", new Error("EPIPE"));
    now += 1;
    tracker.recordFailure("surface:1", new Error("permission denied"));
    now += 1;
    tracker.recordFailure("surface:1", new Error("Broken pipe"));

    expect(tracker.observe("surface:1")?.pty_dead).toBe(false);
  });

  it("expires an otherwise qualifying failure chain outside the window", () => {
    let now = 1_000;
    const tracker = new SurfaceWriteLivenessTracker({
      now: () => now,
      failureThreshold: 2,
      failureWindowMs: 10_000,
    });

    tracker.recordFailure("surface:1", new Error("EPIPE"));
    now += 1_000;
    tracker.recordFailure("surface:1", new Error("EPIPE"));
    now += 10_001;

    expect(tracker.observe("surface:1")?.pty_dead).toBe(false);
  });
});
