import { afterAll, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultArchivePath,
  defaultOutboxPath,
  defaultStatePath,
  drainOutbox,
  parseOutboxEntries,
  type NotifyPayload,
  type OutboxDrainerOptions,
} from "../src/outbox-drainer.js";

const roots: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "cmux-outbox-"));
  roots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/** A deliver stub that records every payload and can be told to fail. */
function recorder(opts?: { fail?: boolean }) {
  const calls: NotifyPayload[] = [];
  const deliver = async (payload: NotifyPayload): Promise<boolean> => {
    calls.push(payload);
    return !opts?.fail;
  };
  return { calls, deliver };
}

function harness(root: string, overrides?: Partial<OutboxDrainerOptions>) {
  const outboxPath = join(root, "outbox.md");
  const statePath = join(root, ".outbox-drained.json");
  const archivePath = join(root, "outbox-archive.md");
  return { outboxPath, statePath, archivePath, ...overrides };
}

describe("parseOutboxEntries", () => {
  it("splits blank-line-separated blocks into indexed entries and ignores empties", () => {
    const raw = "first message\n\nsecond message\n\n\n\nthird message\n";
    const entries = parseOutboxEntries(raw);
    expect(entries.map((e) => e.body)).toEqual([
      "first message",
      "second message",
      "third message",
    ]);
    expect(entries.map((e) => e.index)).toEqual([0, 1, 2]);
    // Ids are stable + unique per entry.
    const ids = new Set(entries.map((e) => e.id));
    expect(ids.size).toBe(3);
  });

  it("returns [] for empty / whitespace-only content", () => {
    expect(parseOutboxEntries("")).toEqual([]);
    expect(parseOutboxEntries("\n\n   \n\n")).toEqual([]);
  });

  it("gives identical content at different positions distinct ids", () => {
    const [a, b] = parseOutboxEntries("dup\n\ndup");
    expect(a.body).toBe("dup");
    expect(b.body).toBe("dup");
    expect(a.id).not.toBe(b.id);
  });
});

describe("default paths", () => {
  it("outbox lives in ~/.golems-zikaron/outbox.md", () => {
    expect(defaultOutboxPath()).toMatch(/\.golems-zikaron\/outbox\.md$/);
  });
  it("state sidecar sits next to the outbox file", () => {
    expect(defaultStatePath("/x/y/outbox.md")).toBe(
      "/x/y/.outbox-drained.json",
    );
  });
});

describe("drainOutbox", () => {
  it("FN: a written entry is delivered exactly once", async () => {
    const root = tempRoot();
    const { outboxPath, statePath } = harness(root);
    writeFileSync(outboxPath, "hello operator\n");
    const rec = recorder();

    const result = await drainOutbox({
      outboxPath,
      statePath,
      deliver: rec.deliver,
    });

    expect(result.deliveredCount).toBe(1);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].body).toBe("hello operator");
    // Payload carries a title/source/priority for the 3847 notify listener.
    expect(rec.calls[0].title).toBeTruthy();
    expect(rec.calls[0].source).toBeTruthy();
    expect(rec.calls[0].priority).toBeTruthy();
    // State sidecar was written so the delivery is remembered.
    expect(existsSync(statePath)).toBe(true);
  });

  it("FP: draining twice never double-sends (same process)", async () => {
    const root = tempRoot();
    const { outboxPath, statePath } = harness(root);
    writeFileSync(outboxPath, "one\n\ntwo\n");
    const rec = recorder();

    const first = await drainOutbox({
      outboxPath,
      statePath,
      deliver: rec.deliver,
    });
    const second = await drainOutbox({
      outboxPath,
      statePath,
      deliver: rec.deliver,
    });

    expect(first.deliveredCount).toBe(2);
    expect(second.deliveredCount).toBe(0);
    expect(second.skippedCount).toBe(2);
    expect(rec.calls).toHaveLength(2);
  });

  it("FP: survives restart — a fresh drainer reading persisted state re-sends nothing", async () => {
    const root = tempRoot();
    const { outboxPath, statePath } = harness(root);
    writeFileSync(outboxPath, "durable\n");

    const first = recorder();
    await drainOutbox({ outboxPath, statePath, deliver: first.deliver });
    expect(first.calls).toHaveLength(1);

    // Simulate a process restart: brand-new deliver stub, same on-disk state.
    const afterRestart = recorder();
    const result = await drainOutbox({
      outboxPath,
      statePath,
      deliver: afterRestart.deliver,
    });
    expect(result.deliveredCount).toBe(0);
    expect(afterRestart.calls).toHaveLength(0);
  });

  it("delivers only newly-appended entries on a subsequent drain", async () => {
    const root = tempRoot();
    const { outboxPath, statePath } = harness(root);
    writeFileSync(outboxPath, "old entry\n");
    const rec = recorder();

    await drainOutbox({ outboxPath, statePath, deliver: rec.deliver });
    writeFileSync(outboxPath, "old entry\n\nbrand new entry\n");
    const second = await drainOutbox({
      outboxPath,
      statePath,
      deliver: rec.deliver,
    });

    expect(second.deliveredCount).toBe(1);
    expect(rec.calls.map((c) => c.body)).toEqual([
      "old entry",
      "brand new entry",
    ]);
  });

  it("does NOT mark an entry drained when delivery fails, and retries next time", async () => {
    const root = tempRoot();
    const { outboxPath, statePath } = harness(root);
    writeFileSync(outboxPath, "flaky\n");

    const failing = recorder({ fail: true });
    const firstResult = await drainOutbox({
      outboxPath,
      statePath,
      deliver: failing.deliver,
    });
    expect(firstResult.deliveredCount).toBe(0);
    expect(firstResult.failedCount).toBe(1);

    // Recovery: listener back up -> the same entry is retried and delivered once.
    const ok = recorder();
    const retry = await drainOutbox({
      outboxPath,
      statePath,
      deliver: ok.deliver,
    });
    expect(retry.deliveredCount).toBe(1);
    expect(ok.calls).toHaveLength(1);
    expect(ok.calls[0].body).toBe("flaky");
  });

  it("is a no-op when the outbox file does not exist", async () => {
    const root = tempRoot();
    const { outboxPath, statePath } = harness(root);
    const rec = recorder();
    const result = await drainOutbox({
      outboxPath,
      statePath,
      deliver: rec.deliver,
    });
    expect(result.totalEntries).toBe(0);
    expect(result.deliveredCount).toBe(0);
    expect(rec.calls).toHaveLength(0);
  });

  it("persisted state is valid JSON recording the drained ids", async () => {
    const root = tempRoot();
    const { outboxPath, statePath } = harness(root);
    writeFileSync(outboxPath, "audit me\n");
    await drainOutbox({ outboxPath, statePath, deliver: recorder().deliver });

    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as {
      version: number;
      drained: Array<{ id: string; at: number }>;
    };
    expect(parsed.version).toBe(1);
    expect(parsed.drained).toHaveLength(1);
    expect(typeof parsed.drained[0].id).toBe("string");
  });
});

describe("rotation-safe dedup", () => {
  it("FN rotation-safety: archiving/truncating outbox.md then re-draining re-sends nothing", async () => {
    const root = tempRoot();
    const { outboxPath, statePath, archivePath } = harness(root);
    // A multi-entry log; the earlier entries are what a rotation trims away.
    writeFileSync(outboxPath, "alpha\n\nbeta\n\ngamma\n");
    const first = recorder();
    const firstResult = await drainOutbox({
      outboxPath,
      statePath,
      archivePath,
      deliver: first.deliver,
    });
    expect(firstResult.deliveredCount).toBe(3);

    // Someone rotates/trims the unbounded log: only the tail entry survives, so
    // every surviving entry's file position shifts. A position-keyed id would
    // change here and re-send — the ~20-Telegram-spam class. Content-keyed ids
    // must survive the shift.
    writeFileSync(outboxPath, "gamma\n");
    const second = recorder();
    const secondResult = await drainOutbox({
      outboxPath,
      statePath,
      archivePath,
      deliver: second.deliver,
    });
    expect(secondResult.deliveredCount).toBe(0);
    expect(second.calls).toHaveLength(0);
  });

  it("a full truncate followed by a re-drain of old content re-sends nothing", async () => {
    const root = tempRoot();
    const { outboxPath, statePath, archivePath } = harness(root);
    writeFileSync(outboxPath, "one\n\ntwo\n");
    await drainOutbox({
      outboxPath,
      statePath,
      archivePath,
      deliver: recorder().deliver,
    });

    // Trim to empty, then the same content reappears verbatim (e.g. a restored
    // backup or a log that was rewound). Delivered ids must still match.
    writeFileSync(outboxPath, "");
    writeFileSync(outboxPath, "one\n\ntwo\n");
    const rec = recorder();
    const result = await drainOutbox({
      outboxPath,
      statePath,
      archivePath,
      deliver: rec.deliver,
    });
    expect(result.deliveredCount).toBe(0);
    expect(rec.calls).toHaveLength(0);
  });

  it("genuine repeated identical messages each deliver once", async () => {
    const root = tempRoot();
    const { outboxPath, statePath, archivePath } = harness(root);
    writeFileSync(outboxPath, "ping\n\nping\n");
    const rec = recorder();
    const result = await drainOutbox({
      outboxPath,
      statePath,
      archivePath,
      deliver: rec.deliver,
    });
    expect(result.deliveredCount).toBe(2);
    expect(rec.calls.map((c) => c.body)).toEqual(["ping", "ping"]);

    // Re-draining the unchanged file sends nothing.
    const again = recorder();
    const secondResult = await drainOutbox({
      outboxPath,
      statePath,
      archivePath,
      deliver: again.deliver,
    });
    expect(secondResult.deliveredCount).toBe(0);
    expect(again.calls).toHaveLength(0);
  });

  it("a newly-appended identical message after a drain still delivers", async () => {
    const root = tempRoot();
    const { outboxPath, statePath, archivePath } = harness(root);
    writeFileSync(outboxPath, "ping\n");
    await drainOutbox({
      outboxPath,
      statePath,
      archivePath,
      deliver: recorder().deliver,
    });

    writeFileSync(outboxPath, "ping\n\nping\n");
    const rec = recorder();
    const result = await drainOutbox({
      outboxPath,
      statePath,
      archivePath,
      deliver: rec.deliver,
    });
    // The first "ping" is already drained; the genuinely-new second occurrence
    // delivers.
    expect(result.deliveredCount).toBe(1);
    expect(rec.calls.map((c) => c.body)).toEqual(["ping"]);
  });
});

describe("archive", () => {
  it("appends delivered entries to the durable archive file", async () => {
    const root = tempRoot();
    const { outboxPath, statePath, archivePath } = harness(root);
    writeFileSync(outboxPath, "archive me\n\narchive me too\n");
    const rec = recorder();
    await drainOutbox({
      outboxPath,
      statePath,
      archivePath,
      deliver: rec.deliver,
    });

    expect(existsSync(archivePath)).toBe(true);
    const archived = readFileSync(archivePath, "utf8");
    expect(archived).toContain("archive me");
    expect(archived).toContain("archive me too");
  });

  it("preserves operator history even after the live outbox is trimmed", async () => {
    const root = tempRoot();
    const { outboxPath, statePath, archivePath } = harness(root);
    writeFileSync(outboxPath, "alpha\n\nbeta\n");
    await drainOutbox({
      outboxPath,
      statePath,
      archivePath,
      deliver: recorder().deliver,
    });

    // The live outbox is later trimmed to nothing; the archive still holds it.
    writeFileSync(outboxPath, "");
    const archived = readFileSync(archivePath, "utf8");
    expect(archived).toContain("alpha");
    expect(archived).toContain("beta");
  });

  it("only archives entries that were actually delivered", async () => {
    const root = tempRoot();
    const { outboxPath, statePath, archivePath } = harness(root);
    writeFileSync(outboxPath, "never sent\n");
    const failing = recorder({ fail: true });
    await drainOutbox({
      outboxPath,
      statePath,
      archivePath,
      deliver: failing.deliver,
    });
    // Delivery failed -> nothing archived (no archive file, or no content).
    if (existsSync(archivePath)) {
      expect(readFileSync(archivePath, "utf8")).not.toContain("never sent");
    }
  });

  it("archive sidecar sits next to the outbox by default", () => {
    expect(defaultArchivePath("/x/y/outbox.md")).toBe("/x/y/outbox-archive.md");
  });
});

describe("default deliver is a no-op (incident guard)", () => {
  it("draining without injecting a transport delivers nothing and never posts", async () => {
    const root = tempRoot();
    const { outboxPath, statePath, archivePath } = harness(root);
    writeFileSync(outboxPath, "must never reach 127.0.0.1:3847\n");
    // No `deliver` injected: the library default MUST be a no-op so the test
    // suite (and any caller that forgets to wire a transport) never hits the
    // notify listener. Only prod entrypoints inject the real HTTP POST.
    const result = await drainOutbox({ outboxPath, statePath, archivePath });
    expect(result.totalEntries).toBe(1);
    expect(result.deliveredCount).toBe(0);
    // Nothing delivered -> no drained-state and no archive written.
    expect(existsSync(statePath)).toBe(false);
    expect(existsSync(archivePath)).toBe(false);
  });
});
