import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  deregisterMonitor,
  readMonitorRegistry,
  registerMonitor,
  signalMonitor,
  sweepMonitorRegistry,
} from "../src/monitor-registry.js";

const TEST_DIR = join(tmpdir(), "cmuxlayer-monitor-registry-test");

function registryPath(): string {
  return join(TEST_DIR, "monitor-registry.json");
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function rawRegistry(): unknown {
  return JSON.parse(readFileSync(registryPath(), "utf8"));
}

describe("monitor registry deadman core", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("keeps an armed monitor alive when signals are flowing and does not notify", async () => {
    await registerMonitor(
      {
        monitor_id: "scd-flowing",
        owner_seat: "skillcreatorLead",
        watch_targets: ["orchestrator/collab/example.md"],
        mechanism: "event",
        deadman_timeout_s: 60,
      },
      { registryPath: registryPath(), now: () => 1_000 },
    );
    await signalMonitor("scd-flowing", {
      registryPath: registryPath(),
      now: () => 31_000,
    });

    const notify = vi.fn().mockResolvedValue(undefined);
    const result = await sweepMonitorRegistry({
      registryPath: registryPath(),
      now: () => 60_000,
      notify,
      sweeperAgentId: "second-agent",
    });

    expect(result.fired).toEqual([]);
    expect(result.invalid).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    expect(readMonitorRegistry({ registryPath: registryPath() }).monitors[0]).toMatchObject({
      monitor_id: "scd-flowing",
      last_signal_at: iso(31_000),
      state: "alive",
    });
  });

  it("lets a second agent sweep fire a lapsed monitor exactly once and emit the injected wake", async () => {
    await registerMonitor(
      {
        monitor_id: "scd-lapsed",
        owner_seat: "skillcreatorLead",
        watch_targets: ["orchestrator/collab/example.md"],
        mechanism: "offset-poll",
        deadman_timeout_s: 60,
      },
      { registryPath: registryPath(), now: () => 1_000 },
    );
    const notify = vi.fn().mockResolvedValue(undefined);

    const first = await sweepMonitorRegistry({
      registryPath: registryPath(),
      now: () => 61_001,
      notify,
      sweeperAgentId: "second-agent",
    });
    const second = await sweepMonitorRegistry({
      registryPath: registryPath(),
      now: () => 62_000,
      notify,
      sweeperAgentId: "third-agent",
    });

    expect(first.fired).toEqual([
      expect.objectContaining({
        monitor_id: "scd-lapsed",
        owner_seat: "skillcreatorLead",
        fired_by_agent_id: "second-agent",
      }),
    ]);
    expect(second.fired).toEqual([]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        monitor_id: "scd-lapsed",
        owner_seat: "skillcreatorLead",
        fired_by_agent_id: "second-agent",
      }),
    );
    expect(readMonitorRegistry({ registryPath: registryPath() }).monitors[0]?.state).toBe(
      "deadman-fired",
    );
  });

  it("fail-closes ownerless or unknown-owner records as invalid instead of firing them", async () => {
    writeFileSync(
      registryPath(),
      `${JSON.stringify(
        {
          version: 1,
          monitors: [
            {
              monitor_id: "missing-owner",
              watch_targets: ["orchestrator/collab/example.md"],
              mechanism: "event",
              deadman_timeout_s: 1,
              armed_at: iso(1_000),
              last_signal_at: iso(1_000),
              state: "alive",
            },
            {
              monitor_id: "unknown-owner",
              owner_seat: "UNKNOWN",
              watch_targets: ["orchestrator/collab/example.md"],
              mechanism: "event",
              deadman_timeout_s: 1,
              armed_at: iso(1_000),
              last_signal_at: iso(1_000),
              state: "alive",
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const notify = vi.fn().mockResolvedValue(undefined);

    const result = await sweepMonitorRegistry({
      registryPath: registryPath(),
      now: () => 10_000,
      notify,
      sweeperAgentId: "second-agent",
    });

    expect(result.fired).toEqual([]);
    expect(result.invalid.map((entry) => entry.monitor_id)).toEqual([
      "missing-owner",
      "unknown-owner",
    ]);
    expect(notify).not.toHaveBeenCalled();
    expect(rawRegistry()).toMatchObject({
      monitors: [
        { monitor_id: "missing-owner", state: "alive" },
        { monitor_id: "unknown-owner", state: "alive" },
      ],
    });
  });

  it("deregisters intentional stops without letting later signals revive the monitor", async () => {
    await registerMonitor(
      {
        monitor_id: "scd-stop",
        owner_seat: "skillcreatorLead",
        watch_targets: ["orchestrator/collab/example.md"],
        mechanism: "event",
        deadman_timeout_s: 60,
      },
      { registryPath: registryPath(), now: () => 1_000 },
    );

    await deregisterMonitor("scd-stop", {
      registryPath: registryPath(),
      now: () => 2_000,
    });
    await signalMonitor("scd-stop", {
      registryPath: registryPath(),
      now: () => 3_000,
    });

    const monitor = readMonitorRegistry({ registryPath: registryPath() }).monitors[0];
    expect(monitor).toMatchObject({
      monitor_id: "scd-stop",
      last_signal_at: iso(1_000),
      state: "dead",
    });
  });
});
