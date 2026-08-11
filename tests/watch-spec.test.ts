import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  WatchArmError,
  armWatch,
  readWatchRegistry,
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

  it("notifies the owner when an armed agent consumer dies before its deadline", async () => {
    let consumerAlive = true;
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
        agentExists: () => consumerAlive,
      },
    );

    consumerAlive = false;
    const result = await sweepWatches({
      registryPath: registryPath(),
      now: () => 5_000,
      agentExists: () => consumerAlive,
      agentState: () => null,
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
    expect(readWatchRegistry({ registryPath: registryPath() }).watches[0])
      .toMatchObject({
        state: "failed",
        liveness: { value: false, source: "registry", observed_at_ms: 5_000 },
      });
  });

  it("treats an error-state agent record as a dead consumer", async () => {
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
        agentExists: () => true,
      },
    );

    const result = await sweepWatches({
      registryPath: registryPath(),
      now: () => 5_000,
      agentExists: () => true,
      agentState: () => "error",
      notify,
    });

    expect(result.failed).toEqual([armed.watch_id]);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "consumer_died" }),
    );
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
