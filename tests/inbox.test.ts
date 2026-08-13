import { afterAll, describe, expect, it } from "vitest";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ack,
  ackedIds,
  agentDir,
  dispatch,
  dispatchOnce,
  inboxMonitorState,
  inboxCursorPath,
  inboxPath,
  monitorAlive,
  pendingDispatches,
  reapOrphanedPendingChannelMarkers,
  readInbox,
  readLastHeartbeat,
  removePendingChannelMarkerAfterRegistration,
  recommendedCodexWatch,
  recommendedMonitorCommand,
  replayUndelivered,
  readInboxCursor,
  surfacedLogPath,
  writeInboxCursor,
  writeHeartbeat,
} from "../src/inbox.js";

const baseDir = mkdtempSync(join(tmpdir(), "cmux-inbox-"));
let clock = 1_000_000;
const opts = { baseDir, now: () => clock };

afterAll(() => rmSync(baseDir, { recursive: true, force: true }));

describe("inbox write-channel", () => {
  it("removes only the provisional marker after pending-to-real registration", () => {
    const pendingId = "brainlayerClaude-pending-1000-dead";
    const finalId = "brainlayerClaude-12345678";
    writeHeartbeat(pendingId, opts);
    writeHeartbeat(finalId, opts);

    expect(
      removePendingChannelMarkerAfterRegistration(pendingId, finalId, opts),
    ).toBe(true);
    expect(
      existsSync(
        join(baseDir, ".channel-dirs", `${encodeURIComponent(pendingId)}.created`),
      ),
    ).toBe(false);
    expect(
      existsSync(
        join(baseDir, ".channel-dirs", `${encodeURIComponent(finalId)}.created`),
      ),
    ).toBe(true);
  });

  it("reaps only retained pending markers that are old and unknown", () => {
    const reapDir = mkdtempSync(join(tmpdir(), "cmux-inbox-reap-"));
    const reapOpts = { baseDir: reapDir, now: () => 2_000_000 };
    const oldOrphan = "brainlayerClaude-pending-1000-dead";
    const oldKnown = "brainlayerClaude-pending-1000-live";
    const youngOrphan = "brainlayerClaude-pending-1900-young";
    const realAgent = "brainlayerClaude-12345678";
    const malformedMarker = "malformed%ZZ.created";
    try {
      for (const agentId of [oldOrphan, oldKnown, youngOrphan, realAgent]) {
        writeHeartbeat(agentId, reapOpts);
      }
      appendFileSync(join(reapDir, ".channel-dirs", malformedMarker), "");

      const result = reapOrphanedPendingChannelMarkers(new Set([oldKnown]), {
        ...reapOpts,
        retentionMs: 500_000,
      });

      expect(result).toMatchObject({
        scanned: 5,
        reapable: 1,
        reaped: 1,
        retained_known: 1,
        retained_young: 1,
        retained_non_pending: 2,
        errors: 0,
      });
      expect(
        existsSync(
          join(reapDir, ".channel-dirs", `${encodeURIComponent(oldOrphan)}.created`),
        ),
      ).toBe(false);
      for (const agentId of [oldKnown, youngOrphan, realAgent]) {
        expect(
          existsSync(
            join(reapDir, ".channel-dirs", `${encodeURIComponent(agentId)}.created`),
          ),
        ).toBe(true);
      }
      expect(
        existsSync(join(reapDir, ".channel-dirs", malformedMarker)),
      ).toBe(true);
    } finally {
      rmSync(reapDir, { recursive: true, force: true });
    }
  });

  it("keeps marker count bounded across repeated orphan creation and reaping", () => {
    const reapDir = mkdtempSync(join(tmpdir(), "cmux-inbox-bounded-"));
    try {
      for (let cycle = 1; cycle <= 20; cycle += 1) {
        const agentId = `testClaude-pending-${cycle * 10}-cycle${cycle}`;
        writeHeartbeat(agentId, { baseDir: reapDir });
        reapOrphanedPendingChannelMarkers([], {
          baseDir: reapDir,
          now: () => (cycle * 10 + 2) * 1_000,
          retentionMs: 1_000,
        });
        expect(readdirSync(join(reapDir, ".channel-dirs"))).toHaveLength(0);
      }
    } finally {
      rmSync(reapDir, { recursive: true, force: true });
    }
  });

  it("fails safe when an invalid retention value is supplied", () => {
    const reapDir = mkdtempSync(join(tmpdir(), "cmux-inbox-invalid-retention-"));
    const pendingId = "testClaude-pending-1000-invalid";
    try {
      writeHeartbeat(pendingId, { baseDir: reapDir });

      const result = reapOrphanedPendingChannelMarkers([], {
        baseDir: reapDir,
        now: () => 2_000_000,
        retentionMs: Number.NaN,
      });

      expect(result.reaped).toBe(0);
      expect(result.retained_young).toBe(1);
      expect(
        existsSync(
          join(reapDir, ".channel-dirs", `${encodeURIComponent(pendingId)}.created`),
        ),
      ).toBe(true);
    } finally {
      rmSync(reapDir, { recursive: true, force: true });
    }
  });

  it("dispatch appends a message with defaults (to=agent, tag=dispatch) and id", () => {
    const m = dispatch("a1", { from: "orc", task: "do X" }, opts);
    expect(m.to).toBe("a1");
    expect(m.reply_to).toBe("orc");
    expect(m.tag).toBe("dispatch");
    expect(m.id).toBeTruthy();
    expect(m.ts_ms).toBe(1_000_000);
    const all = readInbox("a1", opts);
    expect(all).toHaveLength(1);
    expect(all[0].task).toBe("do X");
  });

  it("stores an optional stale-able surface hint only beside the durable reply id", () => {
    const m = dispatch(
      "coach",
      {
        from: "golems",
        reply_to: "golems-agent-id",
        via: "surface:golems",
        observed_at: "2026-08-12T18:00:00.000Z",
        task: "reply through the registry",
      },
      opts,
    );

    expect(m).toMatchObject({
      reply_to: "golems-agent-id",
      via: "surface:golems",
      observed_at: "2026-08-12T18:00:00.000Z",
    });
    expect(m).not.toHaveProperty("tab");
    expect(m).not.toHaveProperty("tab_name");
  });

  it("dispatchOnce keeps one durable message for a stable recovery id", () => {
    const first = dispatchOnce(
      "a1-once",
      { from: "daemon", task: "rearm", id: "monitor-rearm:m1:signal-1" },
      opts,
    );
    const second = dispatchOnce(
      "a1-once",
      {
        from: "daemon",
        task: "duplicate rearm",
        id: "monitor-rearm:m1:signal-1",
      },
      opts,
    );

    expect(second).toEqual(first);
    expect(readInbox("a1-once", opts)).toEqual([first]);
  });

  it("FM#2 replayUndelivered returns un-acked messages oldest-first; ack removes them", () => {
    const id1 = dispatch("a2", { from: "orc", task: "t1", id: "m1" }, opts).id;
    dispatch("a2", { from: "orc", task: "t2", id: "m2" }, opts);
    expect(replayUndelivered("a2", opts).map((m) => m.id)).toEqual([
      "m1",
      "m2",
    ]);
    ack("a2", id1, "done", opts);
    expect(replayUndelivered("a2", opts).map((m) => m.id)).toEqual(["m2"]);
    expect(ackedIds("a2", opts).has("m1")).toBe(true);
  });

  it("FM#2 replay survives a 'monitor was down' gap (acted-set, not tail offset)", () => {
    // 3 dispatched, only the middle acked → the other two still replay (incl. the first,
    // which would be lost by a naive post-arm tail).
    dispatch("a3", { from: "orc", task: "t1", id: "g1" }, opts);
    dispatch("a3", { from: "orc", task: "t2", id: "g2" }, opts);
    dispatch("a3", { from: "orc", task: "t3", id: "g3" }, opts);
    ack("a3", "g2", "done", opts);
    expect(replayUndelivered("a3", opts).map((m) => m.id)).toEqual([
      "g1",
      "g3",
    ]);
  });

  it("replays only messages strictly after the agent-written consumption cursor", () => {
    dispatch("cursor-a1", { from: "orc", task: "t1", id: "m1" }, opts);
    dispatch("cursor-a1", { from: "orc", task: "t2", id: "m2" }, opts);
    dispatch("cursor-a1", { from: "orc", task: "t3", id: "m3" }, opts);

    writeInboxCursor("cursor-a1", "m1", opts);

    expect(readInboxCursor("cursor-a1", opts)).toBe("m1");
    expect(replayUndelivered("cursor-a1", opts).map((message) => message.id)).toEqual([
      "m2",
      "m3",
    ]);
    expect(existsSync(inboxCursorPath("cursor-a1", opts))).toBe(true);
  });

  it("serializes cursor advancement with a per-agent cross-process lock", () => {
    dispatch("cursor-lock", { from: "orc", task: "t1", id: "m1" }, opts);
    mkdirSync(`${inboxCursorPath("cursor-lock", opts)}.lock`, {
      recursive: true,
    });

    expect(() => writeInboxCursor("cursor-lock", "m1", opts)).toThrow(
      /cursor.*locked/i,
    );
    expect(readInboxCursor("cursor-lock", opts)).toBeNull();
  });

  it("FM#3 pendingDispatches flags un-acked messages older than the ack-timeout", () => {
    clock = 5_000;
    dispatch("a4", { from: "orc", task: "old", id: "old1" }, opts);
    clock = 5_500;
    dispatch("a4", { from: "orc", task: "recent", id: "recent1" }, opts);
    clock = 10_500; // old1 is 5500ms old, recent1 is 5000ms old
    const stale = pendingDispatches("a4", 5_200, opts);
    expect(stale.map((m) => m.id)).toEqual(["old1"]);
    // once acked, no longer pending
    ack("a4", "old1", "done", opts);
    expect(pendingDispatches("a4", 5_200, opts)).toHaveLength(0);
  });

  it("FM#1 heartbeat + monitorAlive freshness gate", () => {
    clock = 20_000;
    writeHeartbeat("a5", opts);
    clock = 20_500;
    expect(inboxMonitorState("a5", 1_000, opts)).toBe("alive");
    expect(monitorAlive("a5", 1_000, opts)).toBe(true);
    clock = 22_000; // 2000ms since heartbeat
    expect(inboxMonitorState("a5", 1_000, opts)).toBe("stale");
    expect(monitorAlive("a5", 1_000, opts)).toBe(false);
  });

  it("FM#1 monitorAlive is false when no heartbeat exists", () => {
    expect(inboxMonitorState("never-armed", 1_000, opts)).toBe(
      "never-armed",
    );
    expect(monitorAlive("never-armed", 1_000, opts)).toBe(false);
  });

  it("FM#1 treats a future-dated agent heartbeat as stale", () => {
    clock = 50_000;
    writeHeartbeat("clock-skewed", opts);
    clock = 40_000;

    expect(inboxMonitorState("clock-skewed", 1_000, opts)).toBe("stale");
    expect(monitorAlive("clock-skewed", 1_000, opts)).toBe(false);
  });

  it("FM#1 server boot markers do not prove monitor liveness", () => {
    clock = 25_000;
    writeHeartbeat("a5-boot", opts, "server_boot");
    clock = 25_200;
    expect(readLastHeartbeat("a5-boot", opts)).toEqual({
      ts_ms: 25_000,
      source: "server_boot",
    });
    expect(inboxMonitorState("a5-boot", 1_000, opts)).toBe("never-armed");
    expect(monitorAlive("a5-boot", 1_000, opts)).toBe(false);

    writeHeartbeat("a5-boot", opts);
    expect(readLastHeartbeat("a5-boot", opts)).toEqual({
      ts_ms: 25_200,
      source: "agent",
    });
    expect(monitorAlive("a5-boot", 1_000, opts)).toBe(true);
  });

  it("FM#1 server boot markers do not mask an agent heartbeat", () => {
    clock = 27_000;
    writeHeartbeat("a5-mask", opts);
    clock = 27_100;
    writeHeartbeat("a5-mask", opts, "server_boot");
    expect(readLastHeartbeat("a5-mask", opts)).toEqual({
      ts_ms: 27_100,
      source: "server_boot",
    });
    expect(monitorAlive("a5-mask", 1_000, opts)).toBe(true);
  });

  it("ack writes a heartbeat (acting proves liveness)", () => {
    clock = 30_000;
    dispatch("a6", { from: "orc", task: "t", id: "h1" }, opts);
    ack("a6", "h1", "done", opts);
    clock = 30_200;
    expect(monitorAlive("a6", 1_000, opts)).toBe(true);
  });

  it("persist flag is preserved only when true (ingestion is opt-in)", () => {
    const persisted = dispatch(
      "a7",
      { from: "orc", task: "decision", persist: true },
      opts,
    );
    const ephemeral = dispatch("a7", { from: "orc", task: "routine" }, opts);
    expect(persisted.persist).toBe(true);
    expect(ephemeral.persist).toBeUndefined();
  });

  it("readers tolerate blank / corrupt lines without throwing", () => {
    const path = inboxPath("a8", opts);
    dispatch("a8", { from: "orc", task: "ok", id: "ok1" }, opts);
    // append junk directly
    appendFileSync(path, "\nnot json\n\n");
    const all = readInbox("a8", opts);
    expect(all.map((m) => m.id)).toEqual(["ok1"]);
  });

  it("recommendedMonitorCommand tails the agent's inbox (events only, no chatter)", () => {
    const cmd = recommendedMonitorCommand("a9", opts);
    expect(cmd).toBe(`tail -n0 -F ${inboxPath("a9", opts)}`);
  });

  it("Codex watch: bg-tails the inbox into a surfaced log (capture; poll-on-turn to consume)", () => {
    const cmd = recommendedCodexWatch("a10", opts);
    expect(cmd).toBe(
      `tail -n0 -F ${inboxPath("a10", opts)} >> ${surfacedLogPath("a10", opts)}`,
    );
  });

  it("Codex watch recreates a deleted channel dir before returning a surfaced-log write command", () => {
    const dir = agentDir("a10-deleted", opts);
    writeHeartbeat("a10-deleted", opts);
    rmSync(dir, { recursive: true, force: true });

    const cmd = recommendedCodexWatch("a10-deleted", opts);

    expect(existsSync(dir)).toBe(true);
    expect(cmd).toBe(
      `tail -n0 -F ${inboxPath("a10-deleted", opts)} >> ${surfacedLogPath("a10-deleted", opts)}`,
    );
  });

  it("Codex consume path reuses the universal lib (replayUndelivered + ack, no harness code)", () => {
    dispatch("a11", { from: "orc", task: "codex task", id: "c1" }, opts);
    // poll-on-turn: read what's undelivered, act, ack — same primitives as Claude
    expect(replayUndelivered("a11", opts).map((m) => m.id)).toEqual(["c1"]);
    ack("a11", "c1", "done", opts);
    expect(replayUndelivered("a11", opts)).toHaveLength(0);
  });
});
