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

  it("forgets an otherwise qualifying failure chain outside the window", () => {
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

    expect(tracker.observe("surface:1")).toBeNull();
  });

  it("does not transfer a dead-PTY verdict between stable identities that reuse one ref", () => {
    const tracker = new SurfaceWriteLivenessTracker({
      failureThreshold: 2,
      now: () => 1_000,
    });

    tracker.recordFailure("surface:1", new Error("EPIPE"), "uuid:old");
    tracker.recordFailure("surface:1", new Error("EPIPE"), "uuid:old");

    expect(tracker.observe("surface:1", "uuid:old")?.pty_dead).toBe(true);
    expect(tracker.observe("surface:1", "uuid:new")).toBeNull();
  });

  it("does not transfer UUID-less ref liveness between surface observers", () => {
    const tracker = new SurfaceWriteLivenessTracker({
      failureThreshold: 2,
      now: () => 1_000,
    });

    tracker.recordFailure("surface:1", new Error("EPIPE"), null, "owner:a");
    tracker.recordFailure("surface:1", new Error("EPIPE"), null, "owner:a");

    expect(tracker.observe("surface:1", null, "owner:a")?.pty_dead).toBe(true);
    expect(tracker.observe("surface:1", null, "owner:b")).toBeNull();
  });

  it("bounds retained binding history while keeping the most recent identities", () => {
    const tracker = new SurfaceWriteLivenessTracker({
      failureThreshold: 2,
      now: () => 1_000,
      maxBindings: 2,
    });

    tracker.recordFailure("surface:1", new Error("EPIPE"), "uuid:oldest");
    tracker.recordFailure("surface:2", new Error("EPIPE"), "uuid:middle");
    tracker.recordFailure("surface:3", new Error("EPIPE"), "uuid:newest");

    expect(tracker.observe("surface:1", "uuid:oldest")).toBeNull();
    expect(tracker.observe("surface:2", "uuid:middle")).not.toBeNull();
    expect(tracker.observe("surface:3", "uuid:newest")).not.toBeNull();
  });

  it("does not retain healthy binding history", () => {
    const tracker = new SurfaceWriteLivenessTracker({
      failureThreshold: 2,
      now: () => 1_000,
    });

    tracker.recordFailure("surface:1", new Error("EPIPE"), "uuid:healthy");
    tracker.recordSuccess("surface:1", "uuid:healthy");

    expect(tracker.observe("surface:1", "uuid:healthy")).toBeNull();
  });

  it("prunes expired episodes when another binding records traffic", () => {
    let now = 1_000;
    const tracker = new SurfaceWriteLivenessTracker({
      failureThreshold: 2,
      failureWindowMs: 10_000,
      now: () => now,
    });

    tracker.recordFailure("surface:1", new Error("EPIPE"), "uuid:expired");
    now += 10_001;
    tracker.recordFailure("surface:2", new Error("EPIPE"), "uuid:active");

    expect(tracker.observe("surface:1", "uuid:expired")).toBeNull();
    expect(tracker.observe("surface:2", "uuid:active")).toMatchObject({
      consecutive_broken_pipe_failures: 1,
      pty_dead: false,
    });
  });
});
