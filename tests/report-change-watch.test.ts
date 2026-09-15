import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  armWatch,
  readWatchRegistry,
  sweepWatches,
} from "../src/watch-spec.js";
const TEST_DIR = join(tmpdir(), "cmuxlayer-report-change-watch-test");
const registryPath = join(TEST_DIR, "watches.json"), owner = "cmuxlayerCodex-b012b093";
describe("report header content watches", () => {
  beforeEach(() => { rmSync(TEST_DIR, { recursive: true, force: true }); mkdirSync(TEST_DIR, { recursive: true }); });
  afterEach(() => { rmSync(TEST_DIR, { recursive: true, force: true }); });
  it("persists and delivers one coalesced header batch after quiet debounce", async () => {
    const target = join(TEST_DIR, "collab.md");
    writeFileSync(target, "### historical → lead — old\n", "utf8");
    const notify = vi.fn().mockResolvedValue(true);
    const armed = await armWatch(
      { owner, target, change: "content", deadline: 300_000 },
      { registryPath, now: () => 0 },
    );
    appendFileSync(target, "### worker-a → lead — first\n", "utf8");
    let result = await sweepWatches({
      registryPath,
      now: () => 1_000,
      notify,
    });
    expect(result.fired).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    appendFileSync(target, "### reviewer-b → lead — second\n", "utf8");
    result = await sweepWatches({
      registryPath,
      now: () => 30_000,
      notify,
    });
    expect(result.fired).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    expect(readWatchRegistry({ registryPath }).watches[0]).toMatchObject({
      watch_id: armed.watch_id,
      state: "armed",
      report_change_batch: {
        pendingHeaders: [
          "### worker-a → lead — first",
          "### reviewer-b → lead — second",
        ],
      },
    });
    result = await sweepWatches({
      registryPath,
      now: () => 89_999,
      notify,
    });
    expect(result.fired).toEqual([]);
    result = await sweepWatches({
      registryPath,
      now: () => 90_000,
      notify,
    });
    expect(result.fired).toEqual([armed.watch_id]);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "target_changed",
        report_headers: [
          "### worker-a → lead — first",
          "### reviewer-b → lead — second",
        ],
      }),
    );
  });
  it("keeps pending headers across a registry reread and failed delivery retry", async () => {
    const target = join(TEST_DIR, "restart.md");
    writeFileSync(target, "", "utf8");
    const notify = vi.fn().mockResolvedValue(false);
    await armWatch(
      { owner, target, change: "content", deadline: 300_000 },
      { registryPath, now: () => 0 },
    );
    appendFileSync(target, "### worker-a → lead — pending\n", "utf8");
    await sweepWatches({ registryPath, now: () => 1_000, notify });
    const persisted = readWatchRegistry({ registryPath }).watches[0];
    expect(persisted).toMatchObject({
      state: "armed",
      report_change_batch: {
        pendingHeaders: ["### worker-a → lead — pending"],
      },
    });
    await sweepWatches({ registryPath, now: () => 61_000, notify });
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        report_headers: ["### worker-a → lead — pending"],
      }),
    );
    expect(readWatchRegistry({ registryPath }).watches[0]).toMatchObject({
      state: "fired",
      notification_pending: true,
      report_change_batch: {
        pendingHeaders: ["### worker-a → lead — pending"],
      },
    });
  });
  it("does not wake for owner-only headers and retains mixed worker headers", async () => {
    const target = join(TEST_DIR, "owner.md");
    writeFileSync(target, "", "utf8");
    const notify = vi.fn().mockResolvedValue(true);
    await armWatch(
      { owner, target, change: "content", deadline: 300_000 },
      { registryPath, now: () => 0 },
    );
    appendFileSync(
      target,
      `### cmuxlayer lead ${owner} → reviewer — self\n`,
      "utf8",
    );
    await sweepWatches({ registryPath, now: () => 1_000, notify });
    await sweepWatches({ registryPath, now: () => 61_000, notify });
    expect(notify).not.toHaveBeenCalled();
    appendFileSync(
      target,
      `### reviewer-a → ${owner} — retained\n`,
      "utf8",
    );
    await sweepWatches({ registryPath, now: () => 62_000, notify });
    await sweepWatches({ registryPath, now: () => 122_000, notify });
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        report_headers: [`### reviewer-a → ${owner} — retained`],
      }),
    );
  });
  it("batches rewrite additions but immediately reports lost headers", async () => {
    const target = join(TEST_DIR, "rewrite.md");
    const keep = "### worker-a → lead — keep";
    const lost = "### worker-b → lead — lost";
    writeFileSync(target, `${keep}\n${lost}\n`, "utf8");
    const notify = vi.fn().mockResolvedValue(true);
    await armWatch(
      { owner, target, change: "content", deadline: 300_000 },
      { registryPath, now: () => 0 },
    );
    writeFileSync(
      target,
      `preface rewritten\n${keep}\n${lost}\n### worker-c → lead — new\n`,
      "utf8",
    );
    let result = await sweepWatches({
      registryPath,
      now: () => 1_000,
      notify,
    });
    expect(result.fired).toEqual([]);
    writeFileSync(target, `${keep}\n### worker-c → lead — new\n`, "utf8");
    result = await sweepWatches({
      registryPath,
      now: () => 2_000,
      notify,
    });
    expect(result.fired).toHaveLength(1);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        report_lost_header_count: 1,
        report_lost_headers: [lost],
      }),
    );
  });
  it("preserves immediate arbitrary content, marker, and deadline behavior", async () => {
    const contentTarget = join(TEST_DIR, "plain.txt");
    const markerTarget = join(TEST_DIR, "marker.txt");
    writeFileSync(contentTarget, "before\n", "utf8");
    writeFileSync(markerTarget, "", "utf8");
    const notify = vi.fn().mockResolvedValue(true);
    const contentWatch = await armWatch(
      { owner, target: contentTarget, change: "content", deadline: 300_000 },
      { registryPath, now: () => 0 },
    );
    const markerWatch = await armWatch(
      { owner, target: markerTarget, marker: "DONE", deadline: 2_000 },
      { registryPath, now: () => 0 },
    );
    writeFileSync(contentTarget, "after\n", "utf8");
    appendFileSync(markerTarget, "DONE\n", "utf8");
    const changed = await sweepWatches({
      registryPath,
      now: () => 1_000,
      notify,
    });
    expect(changed.fired).toEqual(
      expect.arrayContaining([contentWatch.watch_id, markerWatch.watch_id]),
    );
    const deadlineTarget = join(TEST_DIR, "deadline.txt");
    writeFileSync(deadlineTarget, "", "utf8");
    const deadlineWatch = await armWatch(
      { owner, target: deadlineTarget, marker: "NEVER", deadline: 2_000 },
      { registryPath, now: () => 1_000 },
    );
    const elapsed = await sweepWatches({
      registryPath,
      now: () => 2_000,
      notify,
    });
    expect(elapsed.failed).toContain(deadlineWatch.watch_id);
  });
  it("defers an unstable file snapshot without changing durable state", async () => {
    const target = join(TEST_DIR, "unstable.md");
    writeFileSync(target, "before\n", "utf8");
    const armed = await armWatch(
      { owner, target, change: "content", deadline: 300_000 },
      { registryPath, now: () => 0 },
    );
    let revision = 0n;
    const contentFingerprintIo = {
      stat: () => ({
        mtimeNs: revision,
        ctimeNs: revision,
        ino: 1n,
        size: 7n,
      }),
      read: () => {
        revision += 1n;
        return Buffer.from("changing\n");
      },
    };
    await expect(
      sweepWatches({ registryPath, now: () => 1_000, contentFingerprintIo }),
    ).rejects.toThrow("Content changed during both snapshot attempts");
    expect(readWatchRegistry({ registryPath }).watches[0]).toMatchObject({
      watch_id: armed.watch_id,
      state: "armed",
      fingerprint: armed.fingerprint,
    });
  });
});
