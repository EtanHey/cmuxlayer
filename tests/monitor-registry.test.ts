import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { queryMonitorRegistryForGates as queryMonitorRegistryForGatesFromPackage } from "../src/lib.js";
import {
  deregisterMonitor,
  queryMonitorRegistryForGates,
  readMonitorRegistry,
  reconcileMonitorRegistry,
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

  it("exposes gate #10 watcher metadata and addressee routing for valid monitors", async () => {
    await registerMonitor(
      {
        monitor_id: "scd-valid-offset",
        owner_seat: "skillcreatorLead",
        watch_targets: ["orchestrator/collab/example.md"],
        mechanism: "offset-poll",
        pattern: "@skillcreatorLead|BLOCKED",
        watermark_key: "orchestrator/collab/example.md:last-byte-offset",
        dedupe: "offset",
        deadman_timeout_s: 60,
      },
      { registryPath: registryPath(), now: () => 1_000 },
    );
    await signalMonitor("scd-valid-offset", {
      registryPath: registryPath(),
      now: () => 31_000,
    });

    const query = queryMonitorRegistryForGates({
      registryPath: registryPath(),
      now: () => 45_000,
      claimedMonitorIds: ["scd-valid-offset"],
    });

    expect(query.violations).toEqual([]);
    expect(query.monitors).toEqual([
      expect.objectContaining({
        monitor_id: "scd-valid-offset",
        state: "alive",
        liveness: "alive",
        mechanism: "offset-poll",
        watermark_key: "orchestrator/collab/example.md:last-byte-offset",
        dedupe: "offset",
        addressee: "skillcreatorLead",
      }),
    ]);
    expect(
      queryMonitorRegistryForGatesFromPackage({
        registryPath: registryPath(),
        now: () => 45_000,
      }).monitors,
    ).toEqual(query.monitors);
  });

  it("reports gate #9 and #10 fixture violations without inferring from invalid records", () => {
    writeFileSync(
      registryPath(),
      `${JSON.stringify(
        {
          version: 1,
          monitors: [
            {
              monitor_id: "offset-no-watermark",
              owner_seat: "skillcreatorLead",
              watch_targets: ["orchestrator/collab/example.md"],
              mechanism: "offset-poll",
              dedupe: "offset",
              deadman_timeout_s: 60,
              armed_at: iso(1_000),
              last_signal_at: iso(31_000),
              state: "alive",
            },
            {
              monitor_id: "tail-f-shape",
              owner_seat: "skillcreatorLead",
              watch_targets: ["tail -n0 -F orchestrator/collab/example.md"],
              mechanism: "event",
              deadman_timeout_s: 60,
              armed_at: iso(1_000),
              last_signal_at: iso(31_000),
              state: "alive",
            },
            {
              monitor_id: "missing-timeout",
              owner_seat: "skillcreatorLead",
              watch_targets: ["orchestrator/collab/example.md"],
              mechanism: "event",
              armed_at: iso(1_000),
              last_signal_at: iso(31_000),
              state: "alive",
            },
            {
              monitor_id: "dead-claim",
              owner_seat: "skillcreatorLead",
              watch_targets: ["orchestrator/collab/example.md"],
              mechanism: "event",
              deadman_timeout_s: 60,
              armed_at: iso(1_000),
              last_signal_at: iso(31_000),
              state: "dead",
            },
            {
              monitor_id: "lapsed-no-wake",
              owner_seat: "skillcreatorLead",
              watch_targets: ["orchestrator/collab/example.md"],
              mechanism: "event",
              deadman_timeout_s: 60,
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

    const query = queryMonitorRegistryForGates({
      registryPath: registryPath(),
      now: () => 62_000,
      claimedMonitorIds: ["absent-claim", "dead-claim", "lapsed-no-wake"],
    });

    expect(query.violations).toEqual([
      {
        gate: "gate-10",
        monitor_id: "offset-no-watermark",
        reason: "offset-poll-missing-watermark-key",
      },
      {
        gate: "gate-10",
        monitor_id: "tail-f-shape",
        reason: "tail-f-without-watermark",
      },
      {
        gate: "gate-10",
        monitor_id: "missing-timeout",
        reason: "missing-deadman-timeout",
      },
      {
        gate: "gate-9",
        monitor_id: "lapsed-no-wake",
        reason: "deadman-timeout-lapsed",
      },
      {
        gate: "gate-9",
        monitor_id: "absent-claim",
        reason: "monitor-id-absent",
      },
      {
        gate: "gate-9",
        monitor_id: "dead-claim",
        reason: "monitor-not-alive",
      },
    ]);
  });

  it("claims a lapsed monitor before notifying so concurrent sweeps emit exactly one wake", async () => {
    await registerMonitor(
      {
        monitor_id: "scd-concurrent",
        owner_seat: "skillcreatorLead",
        watch_targets: ["orchestrator/collab/example.md"],
        mechanism: "event",
        pattern: "@skillcreatorLead|BLOCKED",
        deadman_timeout_s: 60,
      },
      { registryPath: registryPath(), now: () => 1_000 },
    );

    const statesDuringNotify: string[] = [];
    const notify = vi.fn().mockImplementation((event) => {
      statesDuringNotify.push(String((rawRegistry() as any).monitors[0].state));
      expect(event).toEqual(
        expect.objectContaining({
          monitor_id: "scd-concurrent",
          addressee: "skillcreatorLead",
        }),
      );
    });

    const [first, second] = await Promise.all([
      sweepMonitorRegistry({
        registryPath: registryPath(),
        now: () => 62_000,
        notify,
        sweeperAgentId: "sweeper-a",
      }),
      sweepMonitorRegistry({
        registryPath: registryPath(),
        now: () => 62_000,
        notify,
        sweeperAgentId: "sweeper-b",
      }),
    ]);

    expect([...first.fired, ...second.fired]).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(statesDuringNotify).toEqual(["firing"]);
    const winningAgentId =
      first.fired.length === 1 ? "sweeper-a" : "sweeper-b";
    expect(rawRegistry()).toMatchObject({
      monitors: [
        {
          monitor_id: "scd-concurrent",
          state: "deadman-fired",
          firing_claimed_by_agent_id: winningAgentId,
        },
      ],
    });
  });

  it("claims one re-arm for a stale monitor with a live owner", async () => {
    const watchedFile = join(TEST_DIR, "collab.md");
    writeFileSync(watchedFile, "# collab\n", "utf8");
    await registerMonitor(
      {
        monitor_id: "stale-live-owner",
        owner_seat: "worker-a",
        watch_targets: [watchedFile],
        mechanism: "event",
        deadman_timeout_s: 60,
        rearm_command: `tail -n0 -F ${watchedFile}`,
      },
      { registryPath: registryPath(), now: () => 1_000 },
    );
    const rearm = vi.fn().mockResolvedValue(undefined);
    const escalate = vi.fn();

    const first = await reconcileMonitorRegistry({
      registryPath: registryPath(),
      now: () => 62_000,
      ownerPtyDead: async () => false,
      ownerAlive: async (ownerSeat) => ownerSeat === "worker-a",
      rearm,
      escalate,
    });
    const second = await reconcileMonitorRegistry({
      registryPath: registryPath(),
      now: () => 63_000,
      ownerAlive: async () => true,
      rearm,
    });
    const notify = vi.fn();
    const swept = await sweepMonitorRegistry({
      registryPath: registryPath(),
      now: () => 64_000,
      notify,
    });

    expect(first.rearmed).toEqual(["stale-live-owner"]);
    expect(second.rearmed).toEqual([]);
    expect(rearm).toHaveBeenCalledTimes(1);
    expect(escalate).not.toHaveBeenCalled();
    expect(swept.fired).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    expect(rearm).toHaveBeenCalledWith(
      expect.objectContaining({
        monitor_id: "stale-live-owner",
        owner_seat: "worker-a",
        rearm_command: `tail -n0 -F ${watchedFile}`,
        state: "rearming",
      }),
    );
    expect(readMonitorRegistry({ registryPath: registryPath() }).monitors[0]).toMatchObject({
      monitor_id: "stale-live-owner",
      state: "rearming",
      rearm_claimed_at: iso(62_000),
    });
  });

  it("collapses a pty-dead owner's monitor and escalates exactly once", async () => {
    const watchedFile = join(TEST_DIR, "owner-pty-dead.md");
    writeFileSync(watchedFile, "# collab\n", "utf8");
    await registerMonitor(
      {
        monitor_id: "owner-pty-dead",
        owner_seat: "worker-wedged",
        watch_targets: [watchedFile],
        mechanism: "event",
        deadman_timeout_s: 60,
        rearm_command: `tail -n0 -F ${watchedFile}`,
      },
      { registryPath: registryPath(), now: () => 1_000 },
    );
    const rearm = vi.fn();
    const escalate = vi.fn().mockResolvedValue(undefined);

    const first = await reconcileMonitorRegistry({
      registryPath: registryPath(),
      now: () => 62_000,
      ownerPtyDead: async (ownerSeat) => ownerSeat === "worker-wedged",
      ownerAlive: async () => true,
      rearm,
      escalate,
    });
    const second = await reconcileMonitorRegistry({
      registryPath: registryPath(),
      now: () => 63_000,
      ownerPtyDead: async () => true,
      ownerAlive: async () => true,
      rearm,
      escalate,
    });

    expect(first).toMatchObject({
      rearmed: [],
      collapsed: [
        { monitor_id: "owner-pty-dead", reason: "owner-pty-dead" },
      ],
      failed: [],
    });
    expect(second).toMatchObject({ rearmed: [], collapsed: [], failed: [] });
    expect(rearm).not.toHaveBeenCalled();
    expect(escalate).toHaveBeenCalledTimes(1);
    expect(escalate).toHaveBeenCalledWith(
      expect.objectContaining({
        monitor_id: "owner-pty-dead",
        owner_seat: "worker-wedged",
        state: "collapsed",
        collapsed_reason: "owner-pty-dead",
      }),
    );
    expect(
      readMonitorRegistry({ registryPath: registryPath() }).monitors[0],
    ).toMatchObject({
      monitor_id: "owner-pty-dead",
      state: "collapsed",
      collapsed_reason: "owner-pty-dead",
    });
  });

  it("continues reconciling later monitors when collapse escalation rejects", async () => {
    const watchedFile = join(TEST_DIR, "escalation-failure.md");
    writeFileSync(watchedFile, "# collab\n", "utf8");
    for (const [monitorId, ownerSeat] of [
      ["escalation-fails", "worker-wedged"],
      ["healthy-after-failure", "worker-healthy"],
    ] as const) {
      await registerMonitor(
        {
          monitor_id: monitorId,
          owner_seat: ownerSeat,
          watch_targets: [watchedFile],
          mechanism: "event",
          deadman_timeout_s: 60,
          rearm_command: `tail -n0 -F ${watchedFile}`,
        },
        { registryPath: registryPath(), now: () => 1_000 },
      );
    }
    const rearm = vi.fn().mockResolvedValue(undefined);

    await expect(
      reconcileMonitorRegistry({
        registryPath: registryPath(),
        now: () => 62_000,
        ownerPtyDead: async (ownerSeat) => ownerSeat === "worker-wedged",
        ownerAlive: async () => true,
        rearm,
        escalate: vi.fn().mockRejectedValue(new Error("notify unavailable")),
      }),
    ).resolves.toMatchObject({
      rearmed: ["healthy-after-failure"],
      collapsed: [
        { monitor_id: "escalation-fails", reason: "owner-pty-dead" },
      ],
      failed: [],
    });
    expect(rearm).toHaveBeenCalledTimes(1);
    expect(rearm).toHaveBeenCalledWith(
      expect.objectContaining({ monitor_id: "healthy-after-failure" }),
    );
  });

  it("rejects relative file targets for re-arm-capable monitors", async () => {
    await expect(
      registerMonitor(
        {
          monitor_id: "relative-target",
          owner_seat: "worker-a",
          watch_targets: ["relative/collab.md"],
          mechanism: "event",
          deadman_timeout_s: 60,
          rearm_command: "watch-collab",
        },
        { registryPath: registryPath(), now: () => 1_000 },
      ),
    ).rejects.toThrow(/absolute or home-relative/i);
  });

  it("expands home-relative file targets for re-arm-capable monitors", async () => {
    const record = await registerMonitor(
      {
        monitor_id: "canonical-targets",
        owner_seat: "worker-a",
        watch_targets: ["~/Gits/example/collab.md"],
        mechanism: "event",
        deadman_timeout_s: 60,
        rearm_command: "watch-collab",
      },
      { registryPath: registryPath(), now: () => 1_000 },
    );

    expect(record.watch_targets).toEqual([
      join(homedir(), "Gits/example/collab.md"),
    ]);
  });

  it("collapses a stale monitor whose owner is gone without firing deadman", async () => {
    const watchedFile = join(TEST_DIR, "owner-gone.md");
    writeFileSync(watchedFile, "# collab\n", "utf8");
    await registerMonitor(
      {
        monitor_id: "owner-gone",
        owner_seat: "worker-gone",
        watch_targets: [watchedFile],
        mechanism: "event",
        deadman_timeout_s: 60,
        rearm_command: `tail -n0 -F ${watchedFile}`,
      },
      { registryPath: registryPath(), now: () => 1_000 },
    );
    const rearm = vi.fn();
    const notify = vi.fn();

    const reconciled = await reconcileMonitorRegistry({
      registryPath: registryPath(),
      now: () => 62_000,
      ownerAlive: async () => false,
      rearm,
    });
    const swept = await sweepMonitorRegistry({
      registryPath: registryPath(),
      now: () => 63_000,
      notify,
    });

    expect(reconciled.collapsed).toEqual([
      { monitor_id: "owner-gone", reason: "owner-not-alive" },
    ]);
    expect(rearm).not.toHaveBeenCalled();
    expect(swept.fired).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    expect(readMonitorRegistry({ registryPath: registryPath() }).monitors[0]).toMatchObject({
      state: "collapsed",
      collapsed_reason: "owner-not-alive",
    });
  });

  it("collapses a stale monitor when its watched file is missing", async () => {
    const missingFile = join(TEST_DIR, "missing.md");
    await registerMonitor(
      {
        monitor_id: "target-missing",
        owner_seat: "worker-a",
        watch_targets: [missingFile],
        mechanism: "event",
        deadman_timeout_s: 60,
        rearm_command: `tail -n0 -F ${missingFile}`,
      },
      { registryPath: registryPath(), now: () => 1_000 },
    );
    const rearm = vi.fn();

    const reconciled = await reconcileMonitorRegistry({
      registryPath: registryPath(),
      now: () => 62_000,
      ownerAlive: async () => true,
      rearm,
    });

    expect(reconciled.collapsed).toEqual([
      { monitor_id: "target-missing", reason: "watch-target-missing" },
    ]);
    expect(rearm).not.toHaveBeenCalled();
    expect(readMonitorRegistry({ registryPath: registryPath() }).monitors[0]).toMatchObject({
      state: "collapsed",
      collapsed_reason: "watch-target-missing",
    });
  });

  it("surfaces legacy stale monitors without an exact re-arm command", async () => {
    const watchedFile = join(TEST_DIR, "legacy.md");
    writeFileSync(watchedFile, "# collab\n", "utf8");
    await registerMonitor(
      {
        monitor_id: "legacy-no-command",
        owner_seat: "worker-a",
        watch_targets: [watchedFile],
        mechanism: "event",
        deadman_timeout_s: 60,
      },
      { registryPath: registryPath(), now: () => 1_000 },
    );

    const reconciled = await reconcileMonitorRegistry({
      registryPath: registryPath(),
      now: () => 62_000,
      ownerAlive: async () => true,
      rearm: vi.fn(),
    });

    expect(reconciled.collapsed).toEqual([
      { monitor_id: "legacy-no-command", reason: "rearm-command-missing" },
    ]);
  });

  it("keeps a failed re-arm out of deadman and retries after its claim lease", async () => {
    const watchedFile = join(TEST_DIR, "retry.md");
    writeFileSync(watchedFile, "# collab\n", "utf8");
    await registerMonitor(
      {
        monitor_id: "rearm-retry",
        owner_seat: "worker-a",
        watch_targets: [watchedFile],
        mechanism: "event",
        deadman_timeout_s: 60,
        rearm_command: `tail -n0 -F ${watchedFile}`,
      },
      { registryPath: registryPath(), now: () => 1_000 },
    );
    const rearm = vi
      .fn()
      .mockRejectedValueOnce(new Error("inbox unavailable"))
      .mockResolvedValueOnce(undefined);

    const failed = await reconcileMonitorRegistry({
      registryPath: registryPath(),
      now: () => 62_000,
      rearmClaimTimeoutMs: 60_000,
      ownerAlive: async () => true,
      rearm,
    });
    const notify = vi.fn();
    const swept = await sweepMonitorRegistry({
      registryPath: registryPath(),
      now: () => 63_000,
      notify,
    });
    const beforeLease = await reconcileMonitorRegistry({
      registryPath: registryPath(),
      now: () => 63_000,
      rearmClaimTimeoutMs: 60_000,
      ownerAlive: async () => true,
      rearm,
    });
    const afterLease = await reconcileMonitorRegistry({
      registryPath: registryPath(),
      now: () => 122_001,
      rearmClaimTimeoutMs: 60_000,
      ownerAlive: async () => true,
      rearm,
    });

    expect(failed.failed).toEqual(["rearm-retry"]);
    expect(swept.fired).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    expect(beforeLease.rearmed).toEqual([]);
    expect(afterLease.rearmed).toEqual(["rearm-retry"]);
    expect(rearm).toHaveBeenCalledTimes(2);
  });

  it("returns a rearming monitor to alive when the restored watcher signals", async () => {
    const watchedFile = join(TEST_DIR, "restored.md");
    writeFileSync(watchedFile, "# collab\n", "utf8");
    await registerMonitor(
      {
        monitor_id: "restored-monitor",
        owner_seat: "worker-a",
        watch_targets: [watchedFile],
        mechanism: "event",
        deadman_timeout_s: 60,
        rearm_command: `tail -n0 -F ${watchedFile}`,
      },
      { registryPath: registryPath(), now: () => 1_000 },
    );
    await reconcileMonitorRegistry({
      registryPath: registryPath(),
      now: () => 62_000,
      ownerAlive: async () => true,
      rearm: vi.fn(),
    });

    const signaled = await signalMonitor("restored-monitor", {
      registryPath: registryPath(),
      now: () => 63_000,
    });

    expect(signaled).toMatchObject({
      monitor_id: "restored-monitor",
      state: "alive",
      last_signal_at: iso(63_000),
    });
    expect(signaled).not.toHaveProperty("rearm_claimed_at");
  });
});
