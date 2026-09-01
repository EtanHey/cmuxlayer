import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  WatchArmError,
  armWatch,
  httpNotifyWatch,
  readWatchRegistry,
  reserveWatchReportPath,
  releaseWatchReportPathReservation,
  removeWatches,
  sweepWatches,
} from "../src/watch-spec.js";

const TEST_DIR = join(tmpdir(), "cmuxlayer-watch-spec-test");
const registryPath = () => join(TEST_DIR, "watches.json");

describe("WatchSpec arm contract", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("notifies the transport only when the declared watch opts in", async () => {
    const silentTarget = join(TEST_DIR, "silent.md");
    const notifyingTarget = join(TEST_DIR, "notifying.md");
    writeFileSync(silentTarget, "", "utf8");
    writeFileSync(notifyingTarget, "", "utf8");
    const transport = vi.fn().mockResolvedValue(true);

    await armWatch(
      {
        owner: "lead-a",
        target: silentTarget,
        marker: "DONE",
        deadline: 60_000,
      },
      { registryPath: registryPath(), now: () => 1_000 },
    );
    await armWatch(
      {
        owner: "lead-a",
        target: notifyingTarget,
        marker: "DONE",
        deadline: 60_000,
        notify: true,
      },
      { registryPath: registryPath(), now: () => 1_000 },
    );
    appendFileSync(silentTarget, "DONE\n", "utf8");
    appendFileSync(notifyingTarget, "DONE\n", "utf8");

    await sweepWatches({
      registryPath: registryPath(),
      now: () => 2_000,
      notify: (event) =>
        httpNotifyWatch(event, "http://notify.invalid", transport),
    });

    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0]?.[0]).toMatchObject({
      title: "Declared watch changed",
      body: expect.stringContaining(`target=${notifyingTarget}`),
    });
    expect(transport.mock.calls[0]?.[1]).toBe("http://notify.invalid");
  });

  it("rejects a nonexistent file target immediately with a structured arm error", async () => {
    const target = join(TEST_DIR, "missing.md");

    await expect(
      armWatch(
        {
          owner: "lead-a",
          target,
          marker: "DONE_P2",
          deadline: 60_000,
        },
        { registryPath: registryPath(), now: () => 1_000 },
      ),
    ).rejects.toMatchObject<Partial<WatchArmError>>({
      name: "WatchArmError",
      code: "watch_target_missing",
      target,
    });
  });

  it("re-reads an interleaved content write and wakes exactly once", async () => {
    const target = join(TEST_DIR, "interleaved.md");
    writeFileSync(target, "before", "utf8");
    let revision = 1n;
    let interleave = false;
    const contentFingerprintIo = {
      stat: () => ({
        mtimeNs: revision,
        ctimeNs: revision,
        ino: 1n,
        size: revision === 1n ? 6n : 5n,
      }),
      read: () => {
        const content =
          revision === 1n ? Buffer.from("before") : Buffer.from("after");
        if (interleave && revision === 1n) revision = 2n;
        return content;
      },
    };
    const notify = vi.fn().mockResolvedValue(true);
    const armed = await armWatch(
      {
        owner: "lead-a",
        target,
        change: "content",
        notify: true,
        deadline: 60_000,
      },
      {
        registryPath: registryPath(),
        now: () => 1_000,
        contentFingerprintIo,
      },
    );

    interleave = true;
    const changed = await sweepWatches({
      registryPath: registryPath(),
      now: () => 2_000,
      notify,
      contentFingerprintIo,
    });
    const unchanged = await sweepWatches({
      registryPath: registryPath(),
      now: () => 3_000,
      notify,
      contentFingerprintIo,
    });

    expect(changed.fired).toEqual([armed.watch_id]);
    expect(unchanged.fired).toEqual([]);
    expect(notify).toHaveBeenCalledOnce();
  });

  it("does not wake when only file metadata changes", async () => {
    const target = join(TEST_DIR, "metadata-only.md");
    writeFileSync(target, "same report", "utf8");
    let revision = 1n;
    const contentFingerprintIo = {
      stat: () => ({
        mtimeNs: revision,
        ctimeNs: revision,
        ino: revision,
        size: 11n,
      }),
      read: () => Buffer.from("same report"),
    };
    const notify = vi.fn().mockResolvedValue(true);
    await armWatch(
      {
        owner: "lead-a",
        target,
        change: "content",
        deadline: 60_000,
      },
      { registryPath: registryPath(), now: () => 1_000, contentFingerprintIo },
    );

    revision = 2n;
    const result = await sweepWatches({
      registryPath: registryPath(),
      now: () => 2_000,
      notify,
      contentFingerprintIo,
    });

    expect(result.fired).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("migrates a legacy revision-suffixed content fingerprint without waking", async () => {
    const target = join(TEST_DIR, "legacy-fingerprint.md");
    writeFileSync(target, "same report", "utf8");
    const notify = vi.fn().mockResolvedValue(true);
    const armed = await armWatch(
      {
        owner: "lead-a",
        target,
        change: "content",
        deadline: 60_000,
      },
      { registryPath: registryPath(), now: () => 1_000 },
    );
    const registry = readWatchRegistry({ registryPath: registryPath() });
    writeFileSync(
      registryPath(),
      JSON.stringify({
        ...registry,
        watches: registry.watches.map((watch) => ({
          ...watch,
          fingerprint: `${watch.fingerprint}:1:2:3:4`,
        })),
      }),
      "utf8",
    );

    const result = await sweepWatches({
      registryPath: registryPath(),
      now: () => 2_000,
      notify,
    });

    expect(result.fired).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    expect(
      readWatchRegistry({ registryPath: registryPath() }).watches[0]
        ?.fingerprint,
    ).toBe(armed.fingerprint);
  });

  it("debounces delete then identical rewrite without a missing or changed wake", async () => {
    const target = join(TEST_DIR, "atomic-rewrite.md");
    writeFileSync(target, "same report", "utf8");
    const notify = vi.fn().mockResolvedValue(true);
    await armWatch(
      {
        owner: "lead-a",
        target,
        change: "content",
        deadline: 60_000,
      },
      { registryPath: registryPath(), now: () => 1_000 },
    );

    rmSync(target);
    const missing = await sweepWatches({
      registryPath: registryPath(),
      now: () => 1_500,
      notify,
    });
    writeFileSync(target, "same report", "utf8");
    const restored = await sweepWatches({
      registryPath: registryPath(),
      now: () => 2_000,
      notify,
    });

    expect(missing.failed).toEqual([]);
    expect(restored.fired).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("removes scoped watches before a closed child can wake its parent", async () => {
    const target = join(TEST_DIR, "closed-child.md");
    writeFileSync(target, "before", "utf8");
    const notify = vi.fn().mockResolvedValue(true);
    const armed = await armWatch(
      {
        owner: "lead-a",
        subject_agent_id: "worker-a",
        target,
        change: "content",
        deadline: 60_000,
      },
      { registryPath: registryPath(), now: () => 1_000 },
    );

    await removeWatches((watch) => watch.subject_agent_id === "worker-a", {
      registryPath: registryPath(),
    });
    writeFileSync(target, "after", "utf8");
    const result = await sweepWatches({
      registryPath: registryPath(),
      now: () => 2_000,
      notify,
    });

    expect(result.fired).not.toContain(armed.watch_id);
    expect(readWatchRegistry({ registryPath: registryPath() }).watches).toEqual(
      [],
    );
    expect(notify).not.toHaveBeenCalled();
  });

  it("rejects an agent watch without an independent observation provider", async () => {
    await expect(
      armWatch(
        {
          owner: "lead-a",
          target: "worker-a",
          predicate: "done",
          deadline: 60_000,
        },
        { registryPath: registryPath(), now: () => 1_000 },
      ),
    ).rejects.toMatchObject<Partial<WatchArmError>>({
      code: "invalid_watch_spec",
      target: "worker-a",
    });
  });

  it("rejects an unobservable agent predicate through the exported library API", async () => {
    await expect(
      armWatch(
        {
          owner: "lead-a",
          target: "worker-a",
          predicate: "ready",
          deadline: 60_000,
        } as any,
        {
          registryPath: registryPath(),
          now: () => 1_000,
          agentObservation: () => ({
            exists: true,
            state: "idle",
            source: "screen:surface-worker-a",
          }),
        },
      ),
    ).rejects.toMatchObject<Partial<WatchArmError>>({
      code: "invalid_watch_spec",
      target: "worker-a",
    });
  });

  it("notifies the owner when an armed agent consumer dies before its deadline", async () => {
    let consumerAlive = true;
    const notify = vi.fn().mockResolvedValue(undefined);
    const armed = await armWatch(
      {
        owner: "lead-a",
        target: "worker-a",
        predicate: "done",
        notify: true,
        deadline: 60_000,
      },
      {
        registryPath: registryPath(),
        now: () => 1_000,
        agentObservation: () => ({
          exists: consumerAlive,
          state: consumerAlive ? "idle" : null,
          source: "screen:surface-worker-a",
        }),
      },
    );

    consumerAlive = false;
    const result = await sweepWatches({
      registryPath: registryPath(),
      now: () => 5_000,
      agentObservation: () => ({
        exists: consumerAlive,
        state: consumerAlive ? "idle" : null,
        source: "screen:surface-worker-a",
      }),
      notify,
    });

    expect(result.failed).toEqual([armed.watch_id]);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        watch_id: armed.watch_id,
        owner: "lead-a",
        reason: "consumer_died",
        observed_at_ms: 5_000,
      }),
    );
    expect(
      readWatchRegistry({ registryPath: registryPath() }).watches[0],
    ).toMatchObject({
      state: "failed",
      liveness_source: "screen:surface-worker-a",
      liveness: { value: false, source: "screen", observed_at_ms: 5_000 },
    });
  });

  it("treats an error-state agent record as a dead consumer", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const armed = await armWatch(
      {
        owner: "lead-a",
        target: "worker-a",
        predicate: "done",
        notify: true,
        deadline: 60_000,
      },
      {
        registryPath: registryPath(),
        now: () => 1_000,
        agentObservation: () => ({
          exists: true,
          state: "idle",
          source: "screen:surface-worker-a",
        }),
      },
    );

    const result = await sweepWatches({
      registryPath: registryPath(),
      now: () => 5_000,
      agentObservation: () => ({
        exists: true,
        state: "error",
        source: "screen:surface-worker-a",
      }),
      notify,
    });

    expect(result.failed).toEqual([armed.watch_id]);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "consumer_died" }),
    );
  });

  it("judges an agent predicate only from the independent screen observation", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const armed = await armWatch(
      {
        owner: "lead-a",
        target: "worker-a",
        predicate: "done",
        deadline: 60_000,
      },
      {
        registryPath: registryPath(),
        now: () => 1_000,
        agentObservation: () => ({
          exists: true,
          state: "idle",
          source: "screen:surface-worker-a",
        }),
      },
    );

    const result = await sweepWatches({
      registryPath: registryPath(),
      now: () => 5_000,
      agentObservation: () => ({
        exists: true,
        state: "idle",
        source: "screen:surface-worker-a",
      }),
      notify,
    });

    expect(result.fired).toEqual([]);
    expect(result.armed).toEqual([armed.watch_id]);
    expect(notify).not.toHaveBeenCalled();
    expect(
      readWatchRegistry({ registryPath: registryPath() }).watches[0],
    ).toMatchObject({
      state: "armed",
      observed_value: "idle",
      liveness_source: "screen:surface-worker-a",
      liveness: { value: true, source: "screen" },
    });
  });

  it("keeps a watch armed when it was added after the sweep observation snapshot", async () => {
    await armWatch(
      {
        owner: "lead-a",
        target: "worker-existing",
        predicate: "done",
        deadline: 60_000,
      },
      {
        registryPath: registryPath(),
        now: () => 1_000,
        agentObservation: () => ({
          exists: true,
          state: "idle",
          source: "screen:surface-existing",
        }),
      },
    );

    let armedDuringSweep: Awaited<ReturnType<typeof armWatch>> | undefined;
    const notify = vi.fn().mockResolvedValue(true);
    const result = await sweepWatches({
      registryPath: registryPath(),
      now: () => 5_000,
      agentObservation: async (agentId) => {
        if (agentId === "worker-existing" && !armedDuringSweep) {
          armedDuringSweep = await armWatch(
            {
              owner: "lead-b",
              target: "worker-new",
              predicate: "done",
              deadline: 60_000,
            },
            {
              registryPath: registryPath(),
              now: () => 2_000,
              agentObservation: () => ({
                exists: true,
                state: "idle",
                source: "screen:surface-new",
              }),
            },
          );
        }
        return {
          exists: true,
          state: "idle",
          source: `screen:${agentId}`,
        };
      },
      notify,
    });

    expect(armedDuringSweep).toBeDefined();
    expect(result.failed).not.toContain(armedDuringSweep!.watch_id);
    expect(result.armed).toContain(armedDuringSweep!.watch_id);
    expect(notify).not.toHaveBeenCalled();
    expect(
      readWatchRegistry({ registryPath: registryPath() }).watches.find(
        (record) => record.watch_id === armedDuringSweep!.watch_id,
      ),
    ).toMatchObject({
      state: "armed",
      last_heartbeat_at_ms: 2_000,
      liveness: { value: true, source: "screen", observed_at_ms: 2_000 },
    });
  });

  it("recovers an abandoned stale registry lock", async () => {
    const target = join(TEST_DIR, "stale-lock.md");
    const lockPath = `${registryPath()}.lock`;
    writeFileSync(target, "", "utf8");
    mkdirSync(lockPath);
    utimesSync(lockPath, new Date(0), new Date(0));

    await expect(
      armWatch(
        {
          owner: "lead-a",
          target,
          marker: "DONE",
          deadline: 60_000,
        },
        { registryPath: registryPath(), now: () => 1_000 },
      ),
    ).resolves.toMatchObject({ state: "armed" });
  });

  it("waits for a live registry lock holder instead of failing with EEXIST", async () => {
    const target = join(TEST_DIR, "contended-lock.md");
    const lockPath = `${registryPath()}.lock`;
    writeFileSync(target, "", "utf8");
    mkdirSync(lockPath);
    const releaser = spawn(
      process.execPath,
      [
        "-e",
        "setTimeout(() => require('node:fs').rmSync(process.argv[1], { recursive: true, force: true }), 50)",
        lockPath,
      ],
      { stdio: "ignore" },
    );
    let timerTicks = 0;
    const timer = setInterval(() => {
      timerTicks += 1;
    }, 5);

    try {
      await expect(
        armWatch(
          {
            owner: "lead-a",
            target,
            marker: "DONE",
            deadline: 60_000,
          },
          { registryPath: registryPath(), now: () => 1_000 },
        ),
      ).resolves.toMatchObject({ state: "armed" });
    } finally {
      clearInterval(timer);
      if (releaser.exitCode === null) await once(releaser, "exit");
    }
    expect(timerTicks).toBeGreaterThan(0);
  });

  it("serializes report-path reservations across forced-inprocess processes", async () => {
    const target = join(TEST_DIR, "forced-inprocess-shared-report.md");
    const splitLog = join(TEST_DIR, "new-split.log");
    const conflictMarker = join(TEST_DIR, "reservation-conflict");
    writeFileSync(target, "", "utf8");
    const moduleUrl = new URL("../src/watch-spec.ts", import.meta.url).href;
    const childScript = `
      import { appendFileSync, existsSync, writeFileSync } from "node:fs";
      const { reserveWatchReportPath, releaseWatchReportPathReservation } = await import(process.env.TEST_WATCH_MODULE_URL);
      const options = { registryPath: process.env.TEST_WATCH_REGISTRY_PATH };
      const result = await reserveWatchReportPath({ owner: "lead-parent", target: process.env.TEST_REPORT_PATH }, options);
      if (!result.ok) {
        writeFileSync(process.env.TEST_CONFLICT_MARKER, "conflict", "utf8");
        process.stdout.write(JSON.stringify({ ok: false, error_code: "REPORT_PATH_IN_USE" }));
      } else {
        appendFileSync(process.env.TEST_SPLIT_LOG, "new-split\\n", "utf8");
        const deadline = Date.now() + 5000;
        while (!existsSync(process.env.TEST_CONFLICT_MARKER) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        try {
          if (!existsSync(process.env.TEST_CONFLICT_MARKER)) throw new Error("peer never observed reservation conflict");
          process.stdout.write(JSON.stringify({ ok: true }));
        } finally {
          await releaseWatchReportPathReservation(result.reservation.reservation_id, options);
        }
      }
    `;
    const launch = () =>
      spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", childScript],
        {
          env: {
            ...process.env,
            CMUXLAYER_FORCE_INPROCESS: "1",
            TEST_WATCH_MODULE_URL: moduleUrl,
            TEST_WATCH_REGISTRY_PATH: registryPath(),
            TEST_REPORT_PATH: target,
            TEST_SPLIT_LOG: splitLog,
            TEST_CONFLICT_MARKER: conflictMarker,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    const collect = async (child: ReturnType<typeof launch>) => {
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const [exitCode] = (await once(child, "exit")) as [number | null];
      expect(exitCode, stderr).toBe(0);
      return JSON.parse(stdout) as { ok: boolean; error_code?: string };
    };

    const results = await Promise.all([collect(launch()), collect(launch())]);

    expect(results.map((result) => result.ok).sort()).toEqual([false, true]);
    expect(results.find((result) => !result.ok)?.error_code).toBe(
      "REPORT_PATH_IN_USE",
    );
    expect(readFileSync(splitLog, "utf8").trim().split("\n")).toHaveLength(1);
    expect(existsSync(`${registryPath()}.report-path-reservations.json`)).toBe(
      false,
    );
  }, 30_000);

  it("self-heals a malformed report-path reservation sidecar", async () => {
    const target = join(TEST_DIR, "malformed-reservation-report.md");
    const sidecar = `${registryPath()}.report-path-reservations.json`;
    writeFileSync(target, "", "utf8");
    writeFileSync(sidecar, "{truncated", "utf8");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await reserveWatchReportPath(
      { owner: "lead-a", target, subject_agent_id: "child-a" },
      { registryPath: registryPath() },
    );

    expect(result.ok).toBe(true);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("ignoring malformed report-path reservations"),
    );
    if (result.ok) {
      await releaseWatchReportPathReservation(
        result.reservation.reservation_id,
        { registryPath: registryPath() },
      );
    }
    writeFileSync(sidecar, "{truncated-again", "utf8");
    await expect(
      releaseWatchReportPathReservation("missing", {
        registryPath: registryPath(),
      }),
    ).resolves.toBe(false);
    expect(existsSync(sidecar)).toBe(false);
    warning.mockRestore();
  });

  it("treats a subject-less legacy content watch as a reservation conflict", async () => {
    const target = join(TEST_DIR, "legacy-watch-report.md");
    writeFileSync(target, "before", "utf8");
    await armWatch(
      { owner: "lead-a", target, change: "content", deadline: 60_000 },
      { registryPath: registryPath(), now: () => 1_000 },
    );

    await expect(
      reserveWatchReportPath(
        { owner: "lead-a", target, subject_agent_id: "child-new" },
        { registryPath: registryPath() },
      ),
    ).resolves.toMatchObject({ ok: false, conflict_kind: "watch" });
  });

  it("reclaims a reservation whose PID was recycled after it was created", async () => {
    const target = join(TEST_DIR, "recycled-pid-report.md");
    const sidecar = `${registryPath()}.report-path-reservations.json`;
    writeFileSync(target, "", "utf8");
    writeFileSync(
      sidecar,
      `${JSON.stringify({
        version: 2,
        reservations: [
          {
            reservation_id: "stale-reservation",
            owner: "lead-a",
            target,
            subject_agent_id: "closed-child",
            pid: process.pid,
            created_at_ms: 1_000,
          },
        ],
      })}\n`,
      "utf8",
    );

    const result = await reserveWatchReportPath(
      { owner: "lead-a", target, subject_agent_id: "new-child" },
      {
        registryPath: registryPath(),
        reservationProcessAlive: () => true,
        reservationProcessStartedAtMs: () => 3_000,
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      await releaseWatchReportPathReservation(
        result.reservation.reservation_id,
        { registryPath: registryPath() },
      );
    }
  });

  it("drops a malformed persisted row without aborting valid watch evaluation", async () => {
    const target = join(TEST_DIR, "malformed-row.md");
    writeFileSync(target, "", "utf8");
    const valid = await armWatch(
      {
        owner: "lead-a",
        target,
        marker: "DONE",
        deadline: 60_000,
      },
      { registryPath: registryPath(), now: () => 1_000 },
    );
    writeFileSync(
      registryPath(),
      `${JSON.stringify(
        {
          version: 2,
          watches: [
            valid,
            {
              ...valid,
              watch_id: "malformed-row",
              marker: undefined,
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    appendFileSync(target, "DONE\n", "utf8");

    const result = await sweepWatches({
      registryPath: registryPath(),
      now: () => 2_000,
      notify: vi.fn().mockResolvedValue(true),
    });

    expect(result.fired).toEqual([valid.watch_id]);
    const persisted = JSON.parse(readFileSync(registryPath(), "utf8")) as {
      version: number;
      watches: Array<{ watch_id: string }>;
    };
    expect(persisted.version).toBe(2);
    expect(persisted.watches.map((record) => record.watch_id)).toEqual([
      valid.watch_id,
      "malformed-row",
    ]);
    expect(
      readWatchRegistry({ registryPath: registryPath() }).watches.map(
        (record) => record.watch_id,
      ),
    ).toEqual([valid.watch_id]);
  });

  it("records the terminal verdict before retrying notification with backoff", async () => {
    const target = join(TEST_DIR, "redelivery.md");
    writeFileSync(target, "", "utf8");
    const notify = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    let now = 1_000;
    const armed = await armWatch(
      {
        owner: "lead-a",
        target,
        marker: "DONE",
        notify: true,
        deadline: 60_000,
      },
      { registryPath: registryPath(), now: () => now },
    );
    appendFileSync(target, "DONE\n", "utf8");

    now = 2_000;
    const failedDelivery = await sweepWatches({
      registryPath: registryPath(),
      now: () => now,
      notify,
    });
    expect(failedDelivery.fired).toEqual([armed.watch_id]);
    expect(
      readWatchRegistry({ registryPath: registryPath() }).watches[0],
    ).toMatchObject({
      watch_id: armed.watch_id,
      state: "fired",
      terminal_reason: "predicate_matched",
      notification_pending: true,
      notification_attempts: 1,
    });

    now = 2_500;
    await sweepWatches({
      registryPath: registryPath(),
      now: () => now,
      notify,
    });
    expect(notify).toHaveBeenCalledTimes(1);

    now = 3_000;
    await sweepWatches({
      registryPath: registryPath(),
      now: () => now,
      notify,
    });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(
      readWatchRegistry({ registryPath: registryPath() }).watches[0],
    ).toMatchObject({ state: "fired", notification_pending: false });
  });

  it("bounds notification retries and records one exhausted escalation", async () => {
    const target = join(TEST_DIR, "retry-exhaustion.md");
    writeFileSync(target, "", "utf8");
    const notify = vi.fn().mockResolvedValue(false);
    const onNotificationExhausted = vi.fn();
    let now = 1_000;
    const armed = await armWatch(
      {
        owner: "lead-a",
        target,
        marker: "DONE",
        notify: true,
        deadline: Number.MAX_SAFE_INTEGER,
      },
      { registryPath: registryPath(), now: () => now },
    );
    appendFileSync(target, "DONE\n", "utf8");

    for (let attempt = 1; attempt <= 12; attempt += 1) {
      now += 60_000;
      await sweepWatches({
        registryPath: registryPath(),
        now: () => now,
        notify,
        onNotificationExhausted,
      });
    }

    expect(notify).toHaveBeenCalledTimes(8);
    expect(onNotificationExhausted).toHaveBeenCalledOnce();
    expect(onNotificationExhausted).toHaveBeenCalledWith(
      expect.objectContaining({
        notification: expect.objectContaining({ watch_id: armed.watch_id }),
        attempts: 8,
        reason: "retry_limit_exhausted",
      }),
    );
    expect(
      readWatchRegistry({ registryPath: registryPath() }).watches[0],
    ).toMatchObject({
      watch_id: armed.watch_id,
      state: "fired",
      notification_pending: false,
      notification_attempts: 8,
      notification_exhausted_reason: "retry_limit_exhausted",
    });
  });

  it("re-arms a persistent content watch after retry exhaustion", async () => {
    const target = join(TEST_DIR, "persistent-retry-exhaustion.md");
    writeFileSync(target, "before\n", "utf8");
    const notify = vi.fn(() => notify.mock.calls.length > 8);
    const onNotificationExhausted = vi.fn();
    let now = 1_000;
    const armed = await armWatch(
      {
        owner: "lead-a",
        target,
        change: "content",
        notify: true,
        deadline: Number.MAX_SAFE_INTEGER,
      },
      { registryPath: registryPath(), now: () => now },
    );
    writeFileSync(target, "first revision\n", "utf8");

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      now += 60_000;
      await sweepWatches({
        registryPath: registryPath(),
        now: () => now,
        notify,
        onNotificationExhausted,
      });
    }

    expect(
      readWatchRegistry({ registryPath: registryPath() }).watches[0],
    ).toMatchObject({
      watch_id: armed.watch_id,
      state: "armed",
      notification_pending: false,
      notification_attempts: 0,
      notification_exhausted_reason: "retry_limit_exhausted",
    });

    now += 60_000;
    await sweepWatches({
      registryPath: registryPath(),
      now: () => now,
      notify,
      onNotificationExhausted,
    });
    expect(notify).toHaveBeenCalledTimes(8);

    writeFileSync(target, "second revision\n", "utf8");
    now += 60_000;
    const secondRevision = await sweepWatches({
      registryPath: registryPath(),
      now: () => now,
      notify,
      onNotificationExhausted,
    });

    expect(secondRevision.fired).toEqual([armed.watch_id]);
    expect(notify).toHaveBeenCalledTimes(9);
    expect(onNotificationExhausted).toHaveBeenCalledOnce();
    expect(
      readWatchRegistry({ registryPath: registryPath() }).watches[0],
    ).toMatchObject({
      state: "armed",
      notification_pending: false,
      notification_attempts: 0,
      notification_delivered_at_ms: now,
    });
  });

  it("persists and delivers deadline_elapsed through the retryable transition", async () => {
    const target = join(TEST_DIR, "deadline.md");
    writeFileSync(target, "", "utf8");
    const notify = vi.fn().mockResolvedValue(true);
    const armed = await armWatch(
      {
        owner: "lead-a",
        target,
        marker: "DONE",
        notify: true,
        deadline: 2_000,
      },
      { registryPath: registryPath(), now: () => 1_000 },
    );

    const result = await sweepWatches({
      registryPath: registryPath(),
      now: () => 2_000,
      notify,
    });

    expect(result.failed).toEqual([armed.watch_id]);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "deadline_elapsed" }),
    );
    expect(
      readWatchRegistry({ registryPath: registryPath() }).watches[0],
    ).toMatchObject({
      state: "failed",
      terminal_reason: "deadline_elapsed",
      notification_pending: false,
      notification_attempts: 1,
      notification_delivered_at_ms: 2_000,
    });
  });

  it("claims a failed notice before dispatch so concurrent sweepers fire once", async () => {
    const target = join(TEST_DIR, "concurrent-deadline.md");
    writeFileSync(target, "", "utf8");
    await armWatch(
      {
        owner: "lead-a",
        target,
        marker: "DONE",
        deadline: 2_000,
      },
      { registryPath: registryPath(), now: () => 1_000 },
    );
    let finishDelivery!: (delivered: boolean) => void;
    const notify = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishDelivery = resolve;
        }),
    );

    const firstSweep = sweepWatches({
      registryPath: registryPath(),
      now: () => 2_000,
      notify,
    });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
    const secondSweep = sweepWatches({
      registryPath: registryPath(),
      now: () => 2_000,
      notify,
    });
    await secondSweep;

    expect(notify).toHaveBeenCalledOnce();
    finishDelivery(true);
    await firstSweep;
    expect(
      readWatchRegistry({ registryPath: registryPath() }).watches[0],
    ).toMatchObject({
      state: "failed",
      notification_pending: false,
      notification_attempts: 1,
      notification_delivered_at_ms: 2_000,
    });
  });

  it("fires a marker watch on count increase only", async () => {
    const target = join(TEST_DIR, "findings.md");
    writeFileSync(target, "DONE_P1\n", "utf8");
    const notify = vi.fn().mockResolvedValue(undefined);
    const armed = await armWatch(
      {
        owner: "lead-a",
        target,
        marker: "DONE_P1",
        notify: true,
        deadline: 60_000,
      },
      { registryPath: registryPath(), now: () => 1_000 },
    );

    const unchanged = await sweepWatches({
      registryPath: registryPath(),
      now: () => 2_000,
      notify,
    });
    writeFileSync(target, "", "utf8");
    const decreased = await sweepWatches({
      registryPath: registryPath(),
      now: () => 2_250,
      notify,
    });
    writeFileSync(target, "DONE_P1\n", "utf8");
    const restored = await sweepWatches({
      registryPath: registryPath(),
      now: () => 2_500,
      notify,
    });
    appendFileSync(target, "context mentions DONE_P1 again\n", "utf8");
    const increased = await sweepWatches({
      registryPath: registryPath(),
      now: () => 3_000,
      notify,
    });

    expect(armed.watermark).toBe(1);
    expect(unchanged.fired).toEqual([]);
    expect(decreased.fired).toEqual([]);
    expect(restored.fired).toEqual([]);
    expect(increased.fired).toEqual([armed.watch_id]);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        watch_id: armed.watch_id,
        reason: "predicate_matched",
        watermark: 1,
        observed_value: 2,
      }),
    );
  });
});
