/**
 * TDD tests for LANE-MONITOR-REGISTRY-CORE — the minimal cross-agent monitor
 * deadman registry. Covers: register (deadman_timeout_s REQUIRED), signal bumps
 * liveness + recovers a fired monitor, the cross-agent deadman sweep (any live
 * agent flips a lapsed monitor and emits the wake), FAIL-CLOSED-ON-ATTRIBUTION
 * (ownerless/unknown-seat records are surfaced invalid and NEVER fired), and
 * first-to-fire idempotence. NO NETWORK: the wake transport is injected and
 * defaults to a no-op (the outbox-incident lesson).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  registerMonitor,
  deregisterMonitor,
  signalMonitor,
  readMonitorRegistry,
  sweepMonitorRegistry,
  leadMonitorStatus,
  createFileMonitorRegistryPort,
  type NotifyPayload,
} from "../src/monitor-registry.js";

const TEST_DIR = join(tmpdir(), "cmux-monitor-registry-test");
const REGISTRY_PATH = join(TEST_DIR, "monitor-registry.json");

/** A deliver spy that records payloads and never touches the network. */
function makeDeliverSpy() {
  const calls: Array<{ payload: NotifyPayload; url: string }> = [];
  const deliver = async (payload: NotifyPayload, url: string) => {
    calls.push({ payload, url });
    return true;
  };
  return { deliver, calls };
}

describe("monitor-registry core", () => {
  let now = 1_000_000;
  const clock = () => now;
  const baseOpts = () => ({ registryPath: REGISTRY_PATH, now: clock });

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    now = 1_000_000;
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("registers a monitor and requires deadman_timeout_s", () => {
    const rec = registerMonitor(
      {
        monitor_id: "m1",
        owner_seat: "cmuxlayerLead",
        watch_targets: ["collab/hub.md"],
        mechanism: "event",
        deadman_timeout_s: 3600,
      },
      baseOpts(),
    );
    expect(rec.state).toBe("alive");
    expect(rec.armed_at).toBe(new Date(now).toISOString());
    expect(rec.last_signal_at).toBe(new Date(now).toISOString());
    expect(readMonitorRegistry(baseOpts())).toHaveLength(1);

    expect(() =>
      registerMonitor(
        {
          monitor_id: "m-bad",
          owner_seat: "cmuxlayerLead",
          mechanism: "event",
          // @ts-expect-error deliberately omit the required timeout
          deadman_timeout_s: undefined,
        },
        baseOpts(),
      ),
    ).toThrow(/deadman_timeout_s/);

    expect(() =>
      registerMonitor(
        {
          monitor_id: "m-bad2",
          owner_seat: "cmuxlayerLead",
          mechanism: "event",
          deadman_timeout_s: 0,
        },
        baseOpts(),
      ),
    ).toThrow(/deadman_timeout_s/);
  });

  it("FP: an armed monitor with signals flowing stays alive (no fire)", async () => {
    registerMonitor(
      {
        monitor_id: "m1",
        owner_seat: "cmuxlayerLead",
        mechanism: "event",
        deadman_timeout_s: 60,
      },
      baseOpts(),
    );
    const spy = makeDeliverSpy();

    // Advance halfway, signal, advance again — never lapses.
    now += 30_000;
    signalMonitor("m1", baseOpts());
    now += 30_000;
    const result = await sweepMonitorRegistry({
      ...baseOpts(),
      deliver: spy.deliver,
    });

    expect(result.fired).toHaveLength(0);
    expect(result.alive).toHaveLength(1);
    expect(spy.calls).toHaveLength(0);
    expect(readMonitorRegistry(baseOpts())[0].state).toBe("alive");
  });

  it("FN-deadman: no signal past timeout flips to deadman-fired and emits a wake", async () => {
    registerMonitor(
      {
        monitor_id: "m1",
        owner_seat: "cmuxlayerLead",
        watch_targets: ["collab/hub.md"],
        mechanism: "event",
        deadman_timeout_s: 60,
      },
      baseOpts(),
    );
    const spy = makeDeliverSpy();

    now += 61_000;
    const result = await sweepMonitorRegistry({
      ...baseOpts(),
      deliver: spy.deliver,
    });

    expect(result.fired).toHaveLength(1);
    expect(result.fired[0].monitor_id).toBe("m1");
    expect(readMonitorRegistry(baseOpts())[0].state).toBe("deadman-fired");
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].payload.body).toContain("m1");
    expect(spy.calls[0].url).toContain("3847");
  });

  it("FAIL-CLOSED: a record with missing/unknown owner_seat is invalid, never fired", async () => {
    registerMonitor(
      {
        monitor_id: "m-null",
        owner_seat: null,
        mechanism: "event",
        deadman_timeout_s: 60,
      },
      baseOpts(),
    );
    registerMonitor(
      {
        monitor_id: "m-unknown",
        owner_seat: "unknown",
        mechanism: "event",
        deadman_timeout_s: 60,
      },
      baseOpts(),
    );
    const spy = makeDeliverSpy();

    now += 61_000;
    const result = await sweepMonitorRegistry({
      ...baseOpts(),
      deliver: spy.deliver,
    });

    expect(result.fired).toHaveLength(0);
    expect(result.invalid.map((r) => r.monitor_id).sort()).toEqual([
      "m-null",
      "m-unknown",
    ]);
    // ownerless records are NOT reaped/fired — they persist as-is for surfacing.
    const records = readMonitorRegistry(baseOpts());
    expect(records.every((r) => r.state === "alive")).toBe(true);
    expect(spy.calls).toHaveLength(0);
  });

  it("first-to-fire wins: a second sweep does not re-fire an already-fired monitor", async () => {
    registerMonitor(
      {
        monitor_id: "m1",
        owner_seat: "cmuxlayerLead",
        mechanism: "event",
        deadman_timeout_s: 60,
      },
      baseOpts(),
    );
    const spy = makeDeliverSpy();

    now += 61_000;
    const first = await sweepMonitorRegistry({
      ...baseOpts(),
      deliver: spy.deliver,
    });
    const second = await sweepMonitorRegistry({
      ...baseOpts(),
      deliver: spy.deliver,
    });

    expect(first.fired).toHaveLength(1);
    expect(second.fired).toHaveLength(0);
    expect(spy.calls).toHaveLength(1);
  });

  it("cross-agent: a sweep run by any (non-owner) agent fires the owner's lapsed monitor", async () => {
    // Owner "agentA" arms the monitor via one options context...
    registerMonitor(
      {
        monitor_id: "mA",
        owner_seat: "seatA",
        mechanism: "offset-poll",
        deadman_timeout_s: 60,
      },
      baseOpts(),
    );
    const spy = makeDeliverSpy();

    // ...owner process is gone; a DIFFERENT live agent runs the sweep over the
    // same shared registry file and fires the deadman.
    now += 61_000;
    const port = createFileMonitorRegistryPort({
      registryPath: REGISTRY_PATH,
      deliver: spy.deliver,
    });
    const result = await port.sweep(now);

    expect(result.fired.map((r) => r.monitor_id)).toEqual(["mA"]);
    expect(spy.calls).toHaveLength(1);
  });

  it("signal recovers a fired monitor back to alive (re-arm on recovery)", async () => {
    registerMonitor(
      {
        monitor_id: "m1",
        owner_seat: "cmuxlayerLead",
        mechanism: "event",
        deadman_timeout_s: 60,
      },
      baseOpts(),
    );
    now += 61_000;
    await sweepMonitorRegistry(baseOpts());
    expect(readMonitorRegistry(baseOpts())[0].state).toBe("deadman-fired");

    signalMonitor("m1", baseOpts());
    expect(readMonitorRegistry(baseOpts())[0].state).toBe("alive");
  });

  it("deregister marks a monitor dead so the sweep never fires it", async () => {
    registerMonitor(
      {
        monitor_id: "m1",
        owner_seat: "cmuxlayerLead",
        mechanism: "event",
        deadman_timeout_s: 60,
      },
      baseOpts(),
    );
    deregisterMonitor("m1", baseOpts());
    expect(readMonitorRegistry(baseOpts())[0].state).toBe("dead");

    const spy = makeDeliverSpy();
    now += 61_000;
    const result = await sweepMonitorRegistry({
      ...baseOpts(),
      deliver: spy.deliver,
    });
    expect(result.fired).toHaveLength(0);
    expect(spy.calls).toHaveLength(0);
  });

  it("no network by default: sweep with no injected deliver performs zero I/O to 3847", async () => {
    registerMonitor(
      {
        monitor_id: "m1",
        owner_seat: "cmuxlayerLead",
        mechanism: "event",
        deadman_timeout_s: 60,
      },
      baseOpts(),
    );
    now += 61_000;
    // Default deliver is a no-op; the state still flips (idempotent record of the
    // fire) but nothing is posted anywhere.
    const result = await sweepMonitorRegistry(baseOpts());
    expect(result.fired).toHaveLength(1);
    expect(readMonitorRegistry(baseOpts())[0].state).toBe("deadman-fired");
  });

  it("leadMonitorStatus reports firedNow + dueAtMs for a seat", () => {
    registerMonitor(
      {
        monitor_id: "m1",
        owner_seat: "cmuxlayerLead",
        mechanism: "event",
        deadman_timeout_s: 60,
      },
      baseOpts(),
    );
    // Alive, not yet lapsed → not fired, has a future due time.
    const before = leadMonitorStatus("cmuxlayerLead", { ...baseOpts() });
    expect(before.firedNow).toBe(false);
    expect(before.dueAtMs).toBe(now + 60_000);

    // Unknown seat → fail-closed (never fired, no due).
    const unknown = leadMonitorStatus(null, { ...baseOpts() });
    expect(unknown.firedNow).toBe(false);
    expect(unknown.dueAtMs).toBeNull();

    // Past the timeout → firedNow true even before a sweep flips the record.
    now += 61_000;
    const after = leadMonitorStatus("cmuxlayerLead", { ...baseOpts() });
    expect(after.firedNow).toBe(true);
  });

  it("does not create the registry file when reading a non-existent registry", () => {
    expect(existsSync(REGISTRY_PATH)).toBe(false);
    expect(readMonitorRegistry(baseOpts())).toEqual([]);
    expect(existsSync(REGISTRY_PATH)).toBe(false);
  });

  it("persists valid JSON on register", () => {
    registerMonitor(
      {
        monitor_id: "m1",
        owner_seat: "cmuxlayerLead",
        mechanism: "event",
        deadman_timeout_s: 60,
      },
      baseOpts(),
    );
    const raw = readFileSync(REGISTRY_PATH, "utf8");
    const parsed = JSON.parse(raw);
    expect(Array.isArray(parsed.monitors)).toBe(true);
    expect(parsed.monitors[0].monitor_id).toBe("m1");
  });
});
