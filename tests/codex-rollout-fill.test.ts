import { describe, expect, it, vi } from "vitest";
import { open, stat } from "node:fs/promises";
import {
  CODEX_ROLLOUT_MAX_TAIL_BYTES,
  CODEX_ROLLOUT_MAX_PENDING_LINE_BYTES,
  CODEX_ROLLOUT_READ_CHUNK_BYTES,
  makeCodexRolloutFillProvider,
} from "../src/codex-rollout-fill.js";

vi.mock("node:fs/promises", () => ({
  open: vi.fn(),
  stat: vi.fn(),
}));

function tokenCountLine(
  totalTokens: number,
  modelContextWindow = 258_400,
): string {
  return `${JSON.stringify({
    timestamp: "2026-07-18T02:45:55.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { total_tokens: 999_999 },
        last_token_usage: {
          input_tokens: totalTokens - 1_000,
          cached_input_tokens: 50_000,
          output_tokens: 1_000,
          reasoning_output_tokens: 500,
          total_tokens: totalTokens,
        },
        model_context_window: modelContextWindow,
      },
    },
  })}\n`;
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe("CodexRolloutFillProvider", () => {
  it("cold-reads the exact rollout path and computes fill against 400K", async () => {
    const path = "/tmp/rollout-session-a.jsonl";
    const bytes = Buffer.from(tokenCountLine(100_000));
    const provider = makeCodexRolloutFillProvider({
      now: () => 1_000,
      statFile: async (requestedPath) => {
        expect(requestedPath).toBe(path);
        return {
          size: bytes.length,
          mtimeMs: 1,
          dev: 2,
          ino: 3,
          isFile: true,
        };
      },
      readFileRange: async (requestedPath, start, length) => {
        expect(requestedPath).toBe(path);
        return bytes.subarray(start, start + length);
      },
    });

    await expect(provider.get(path)).resolves.toEqual({
      token_count: 100_000,
      context_window: 400_000,
      context_pct: 25,
      observed_model_context_window: 258_400,
    });
  });

  it("uses asynchronous production file operations when no reader is injected", async () => {
    const path = "/tmp/rollout-session.jsonl";
    const bytes = Buffer.from(tokenCountLine(80_000));
    vi.mocked(stat).mockResolvedValue({
      size: bytes.length,
      mtimeMs: 1,
      dev: 2,
      ino: 3,
      isFile: () => true,
    } as Awaited<ReturnType<typeof stat>>);
    const read = vi.fn(
      async (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) => {
        const chunk = bytes.subarray(position, position + length);
        chunk.copy(buffer, offset);
        return { bytesRead: chunk.length, buffer };
      },
    );
    const close = vi.fn().mockResolvedValue(undefined);
    vi.mocked(open).mockResolvedValue({ read, close } as any);

    const provider = makeCodexRolloutFillProvider();
    await expect(provider.get(path)).resolves.toMatchObject({
      token_count: 80_000,
      context_pct: 20,
    });
    expect(stat).toHaveBeenCalledWith(path);
    expect(open).toHaveBeenCalledWith(path, "r");
    expect(read).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it("completes bounded range reads when the filesystem returns short chunks", async () => {
    const path = "/tmp/rollout-short-reads.jsonl";
    const bytes = Buffer.from(tokenCountLine(44_000));
    const reads: Array<{ start: number; length: number }> = [];
    const provider = makeCodexRolloutFillProvider({
      statFile: async () => ({
        size: bytes.length,
        mtimeMs: 1,
        dev: 2,
        ino: 30,
        isFile: true,
      }),
      readFileRange: async (_requestedPath, start, length) => {
        reads.push({ start, length });
        return bytes.subarray(start, start + Math.min(length, 7));
      },
    });

    await expect(provider.get(path)).resolves.toMatchObject({
      token_count: 44_000,
    });
    expect(reads.length).toBeGreaterThan(1);
    expect(reads.every(({ length }) => length <= 64 * 1024)).toBe(true);
  });

  it("cold-searches only the bounded tail in 64 KiB chunks and selects the newest event", async () => {
    const path = "/tmp/rollout-large.jsonl";
    const filler = `${JSON.stringify({
      type: "event_msg",
      payload: { type: "agent_message", message: "x".repeat(1_000) },
    })}\n`;
    const bytes = Buffer.from(
      filler.repeat(700) +
        tokenCountLine(50_000) +
        filler.repeat(20) +
        tokenCountLine(120_000),
    );
    const reads: Array<{ start: number; length: number }> = [];
    const provider = makeCodexRolloutFillProvider({
      statFile: async () => ({
        size: bytes.length,
        mtimeMs: 1,
        dev: 2,
        ino: 4,
        isFile: true,
      }),
      readFileRange: async (_requestedPath, start, length) => {
        reads.push({ start, length });
        return bytes.subarray(start, start + length);
      },
    });

    await expect(provider.get(path)).resolves.toMatchObject({
      token_count: 120_000,
      context_pct: 30,
    });
    expect(reads.length).toBeGreaterThan(1);
    expect(
      reads.every(({ length }) => length <= CODEX_ROLLOUT_READ_CHUNK_BYTES),
    ).toBe(true);
    expect(
      reads.some(
        ({ start }) =>
          start === Math.max(0, bytes.length - CODEX_ROLLOUT_MAX_TAIL_BYTES),
      ),
    ).toBe(true);
  });

  it("keeps a complete token row that starts exactly at the cold-tail boundary", async () => {
    const path = "/tmp/rollout-tail-boundary.jsonl";
    const token = Buffer.from(tokenCountLine(70_000));
    const fillerLine = Buffer.from('{"type":"event_msg"}\n');
    const tailParts = [token];
    let tailLength = token.length;
    while (
      tailLength + fillerLine.length <=
      CODEX_ROLLOUT_MAX_TAIL_BYTES
    ) {
      tailParts.push(fillerLine);
      tailLength += fillerLine.length;
    }
    const remaining = CODEX_ROLLOUT_MAX_TAIL_BYTES - tailLength;
    if (remaining > 0) {
      tailParts.push(Buffer.from(`${" ".repeat(remaining - 1)}\n`));
    }
    const prefix = Buffer.from('{"type":"event_msg","prefix":true}\n');
    const bytes = Buffer.concat([prefix, ...tailParts]);
    const provider = makeCodexRolloutFillProvider({
      statFile: async () => ({
        size: bytes.length,
        mtimeMs: 1,
        dev: 2,
        ino: 45,
        isFile: true,
      }),
      readFileRange: async (_requestedPath, start, length) =>
        bytes.subarray(start, start + length),
    });

    await expect(provider.get(path)).resolves.toMatchObject({
      token_count: 70_000,
    });
  });

  it("discards cold bytes when the rollout identity rotates between stat and read", async () => {
    const path = "/tmp/rollout-stat-read-rotation.jsonl";
    const replacementBytes = Buffer.from(tokenCountLine(200_000));
    let statCalls = 0;
    const provider = makeCodexRolloutFillProvider({
      statFile: async () => {
        statCalls += 1;
        return {
          size: replacementBytes.length,
          mtimeMs: statCalls,
          dev: 2,
          ino: statCalls === 1 ? 46 : 47,
          isFile: true,
        };
      },
      readFileRange: async (_requestedPath, start, length) =>
        replacementBytes.subarray(start, start + length),
    });

    await expect(provider.get(path)).resolves.toBeNull();
  });

  it("coalesces concurrent cold reads and serves warm data without more I/O", async () => {
    const path = "/tmp/rollout-coalesced.jsonl";
    const bytes = Buffer.from(tokenCountLine(40_000));
    let statCalls = 0;
    let readCalls = 0;
    const provider = makeCodexRolloutFillProvider({
      now: () => 10_000,
      statFile: async () => {
        statCalls += 1;
        await Promise.resolve();
        return {
          size: bytes.length,
          mtimeMs: 1,
          dev: 2,
          ino: 5,
          isFile: true,
        };
      },
      readFileRange: async (_requestedPath, start, length) => {
        readCalls += 1;
        await Promise.resolve();
        return bytes.subarray(start, start + length);
      },
    });

    const fills = await Promise.all(
      Array.from({ length: 20 }, () => provider.get(path)),
    );
    expect(fills.every((fill) => fill?.token_count === 40_000)).toBe(true);
    expect(statCalls).toBe(2);
    expect(readCalls).toBe(1);

    await expect(provider.get(path)).resolves.toMatchObject({
      token_count: 40_000,
    });
    expect(statCalls).toBe(2);
    expect(readCalls).toBe(1);
  });

  it("refreshes warm entries from the append cursor while returning the stale sample immediately", async () => {
    const path = "/tmp/rollout-appended.jsonl";
    let now = 0;
    let bytes = Buffer.from(tokenCountLine(40_000));
    let mtimeMs = 1;
    const reads: Array<{ start: number; length: number }> = [];
    const provider = makeCodexRolloutFillProvider({
      now: () => now,
      statFile: async () => ({
        size: bytes.length,
        mtimeMs,
        dev: 2,
        ino: 6,
        isFile: true,
      }),
      readFileRange: async (_requestedPath, start, length) => {
        reads.push({ start, length });
        return bytes.subarray(start, start + length);
      },
    });

    await expect(provider.get(path)).resolves.toMatchObject({
      token_count: 40_000,
    });
    const previousSize = bytes.length;
    reads.length = 0;
    bytes = Buffer.concat([bytes, Buffer.from(tokenCountLine(80_000))]);
    mtimeMs = 2;
    now = 1_001;

    await expect(provider.get(path)).resolves.toMatchObject({
      token_count: 40_000,
    });
    await flushAsyncWork();
    await expect(provider.get(path)).resolves.toMatchObject({
      token_count: 80_000,
    });
    expect(reads.some(({ start }) => start === previousSize)).toBe(true);
    expect(reads.every(({ length }) => length <= 64 * 1024)).toBe(true);
  });

  it("reboots from the bounded tail after a large append gap", async () => {
    const path = "/tmp/rollout-large-gap.jsonl";
    let now = 0;
    let mtimeMs = 1;
    let bytes = Buffer.from(tokenCountLine(40_000));
    const reads: Array<{ start: number; length: number }> = [];
    const provider = makeCodexRolloutFillProvider({
      now: () => now,
      statFile: async () => ({
        size: bytes.length,
        mtimeMs,
        dev: 2,
        ino: 31,
        isFile: true,
      }),
      readFileRange: async (_requestedPath, start, length) => {
        reads.push({ start, length });
        return bytes.subarray(start, start + length);
      },
    });

    await provider.get(path);
    reads.length = 0;
    bytes = Buffer.concat([
      bytes,
      Buffer.from("x".repeat(CODEX_ROLLOUT_MAX_TAIL_BYTES + 100) + "\n"),
      Buffer.from(tokenCountLine(140_000)),
    ]);
    mtimeMs = 2;
    now = 1_001;

    await expect(provider.get(path)).resolves.toMatchObject({
      token_count: 40_000,
    });
    await flushAsyncWork();
    await expect(provider.get(path)).resolves.toMatchObject({
      token_count: 140_000,
    });
    expect(
      reads.some(
        ({ start }) =>
          start === Math.max(0, bytes.length - CODEX_ROLLOUT_MAX_TAIL_BYTES),
      ),
    ).toBe(true);
  });

  it("skips a complete token row that exceeds the 64 KiB line bound", async () => {
    const path = "/tmp/rollout-oversized.jsonl";
    const oversized = Buffer.from(
      `${JSON.stringify({
        timestamp: "2026-07-18T02:45:55.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          padding: "x".repeat(CODEX_ROLLOUT_MAX_PENDING_LINE_BYTES),
          info: { last_token_usage: { total_tokens: 123_000 } },
        },
      })}\n`,
    );
    const provider = makeCodexRolloutFillProvider({
      statFile: async () => ({
        size: oversized.length,
        mtimeMs: 1,
        dev: 2,
        ino: 7,
        isFile: true,
      }),
      readFileRange: async (_requestedPath, start, length) =>
        oversized.subarray(start, start + length),
    });

    await expect(provider.get(path)).resolves.toBeNull();
  });

  it("discards an oversized partial row through its newline before parsing later rows", async () => {
    const path = "/tmp/rollout-oversized-partial.jsonl";
    let now = 0;
    let mtimeMs = 1;
    let bytes = Buffer.from(
      tokenCountLine(40_000) +
        "x".repeat(CODEX_ROLLOUT_MAX_PENDING_LINE_BYTES + 1),
    );
    const provider = makeCodexRolloutFillProvider({
      now: () => now,
      statFile: async () => ({
        size: bytes.length,
        mtimeMs,
        dev: 2,
        ino: 8,
        isFile: true,
      }),
      readFileRange: async (_requestedPath, start, length) =>
        bytes.subarray(start, start + length),
    });

    await expect(provider.get(path)).resolves.toMatchObject({
      token_count: 40_000,
    });
    bytes = Buffer.concat([bytes, Buffer.from(tokenCountLine(200_000))]);
    mtimeMs = 2;
    now = 1_001;
    await provider.get(path);
    await flushAsyncWork();
    await expect(provider.get(path)).resolves.toMatchObject({
      token_count: 40_000,
    });

    bytes = Buffer.concat([bytes, Buffer.from(tokenCountLine(80_000))]);
    mtimeMs = 3;
    now = 2_002;
    await provider.get(path);
    await flushAsyncWork();
    await expect(provider.get(path)).resolves.toMatchObject({
      token_count: 80_000,
    });
  });

  it("caps concurrent rollout refreshes across distinct paths", async () => {
    const bytes = Buffer.from(tokenCountLine(20_000));
    let releaseStats: (() => void) | null = null;
    const statsMayFinish = new Promise<void>((resolve) => {
      releaseStats = resolve;
    });
    let activeStats = 0;
    let maxActiveStats = 0;
    const provider = makeCodexRolloutFillProvider({
      maxConcurrentReads: 4,
      statFile: async () => {
        activeStats += 1;
        maxActiveStats = Math.max(maxActiveStats, activeStats);
        await statsMayFinish;
        activeStats -= 1;
        return {
          size: bytes.length,
          mtimeMs: 1,
          dev: 2,
          ino: 9,
          isFile: true,
        };
      },
      readFileRange: async (_requestedPath, start, length) =>
        bytes.subarray(start, start + length),
    });

    const pending = Array.from({ length: 6 }, (_, index) =>
      provider.get(`/tmp/rollout-concurrency-${index}.jsonl`),
    );
    await flushAsyncWork();
    expect(maxActiveStats).toBe(4);
    releaseStats?.();
    await expect(Promise.all(pending)).resolves.toHaveLength(6);
    expect(maxActiveStats).toBe(4);
  });

  it("does not let a newcomer steal a permit reserved for a queued reader", async () => {
    const firstPath = "/tmp/rollout-permit-first.jsonl";
    let releaseFirst: (() => void) | null = null;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let releaseFollowers: (() => void) | null = null;
    const followersMayFinish = new Promise<void>((resolve) => {
      releaseFollowers = resolve;
    });
    let activeStats = 0;
    let maxActiveStats = 0;
    const provider = makeCodexRolloutFillProvider({
      maxConcurrentReads: 1,
      statFile: async (path) => {
        activeStats += 1;
        maxActiveStats = Math.max(maxActiveStats, activeStats);
        if (path === firstPath) await firstMayFinish;
        else await followersMayFinish;
        activeStats -= 1;
        return null;
      },
    });

    const first = provider.get(firstPath);
    await flushAsyncWork();
    const queued = provider.get("/tmp/rollout-permit-queued.jsonl");
    await flushAsyncWork();

    const intruders: Array<Promise<unknown>> = [];
    let intruderIndex = 0;
    const enqueueIntruder = (): void => {
      queueMicrotask(() => {
        intruders.push(
          provider.get(`/tmp/rollout-permit-intruder-${intruderIndex++}.jsonl`),
        );
        if (intruderIndex < 50) enqueueIntruder();
      });
    };
    enqueueIntruder();
    releaseFirst?.();
    for (let index = 0; index < 100; index += 1) await Promise.resolve();
    const observedMax = maxActiveStats;

    releaseFollowers?.();
    await Promise.all([first, queued, ...intruders]);
    expect(observedMax).toBe(1);
  });

  it("evicts the least-recently-used settled path when the cache cap is reached", async () => {
    const bytes = Buffer.from(tokenCountLine(20_000));
    let now = 0;
    const statCalls = new Map<string, number>();
    const provider = makeCodexRolloutFillProvider({
      now: () => now,
      maxEntries: 2,
      statFile: async (path) => {
        statCalls.set(path, (statCalls.get(path) ?? 0) + 1);
        return {
          size: bytes.length,
          mtimeMs: 1,
          dev: 2,
          ino: path.charCodeAt(path.length - 1),
          isFile: true,
        };
      },
      readFileRange: async (_requestedPath, start, length) =>
        bytes.subarray(start, start + length),
    });
    const first = "/tmp/rollout-cache-1";
    const second = "/tmp/rollout-cache-2";
    const third = "/tmp/rollout-cache-3";

    await provider.get(first);
    now += 1;
    await provider.get(second);
    now += 1;
    await provider.get(third);
    now += 1;
    await provider.get(first);

    expect(statCalls.get(first)).toBe(4);
    expect(statCalls.get(second)).toBe(2);
    expect(statCalls.get(third)).toBe(2);
  });

  it("rejects a cold admission while every cache slot is in flight", async () => {
    const firstPath = "/tmp/rollout-cache-inflight-1";
    const secondPath = "/tmp/rollout-cache-inflight-2";
    const bytes = Buffer.from(tokenCountLine(20_000));
    let releaseFirst: (() => void) | null = null;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const statFile = vi.fn(async (path: string) => {
      if (path === firstPath) await firstMayFinish;
      return {
        size: bytes.length,
        mtimeMs: 1,
        dev: 2,
        ino: path === firstPath ? 41 : 42,
        isFile: true,
      };
    });
    const provider = makeCodexRolloutFillProvider({
      maxEntries: 1,
      statFile,
      readFileRange: async (_requestedPath, start, length) =>
        bytes.subarray(start, start + length),
    });

    const first = provider.get(firstPath);
    await flushAsyncWork();
    let secondSettled = false;
    const second = provider.get(secondPath).then((value) => {
      secondSettled = true;
      return value;
    });
    await flushAsyncWork();

    expect(secondSettled).toBe(true);
    await expect(second).resolves.toBeNull();
    expect(statFile).toHaveBeenCalledTimes(1);

    releaseFirst?.();
    await first;
    await expect(provider.get(secondPath)).resolves.toMatchObject({
      token_count: 20_000,
    });
  });

  it("waits for a partial token row to finish before publishing it", async () => {
    const path = "/tmp/rollout-partial.jsonl";
    let now = 0;
    let mtimeMs = 1;
    const line = Buffer.from(tokenCountLine(70_000));
    const split = Math.floor(line.length / 2);
    let bytes = line.subarray(0, split);
    const provider = makeCodexRolloutFillProvider({
      now: () => now,
      statFile: async () => ({
        size: bytes.length,
        mtimeMs,
        dev: 2,
        ino: 10,
        isFile: true,
      }),
      readFileRange: async (_requestedPath, start, length) =>
        bytes.subarray(start, start + length),
    });

    await expect(provider.get(path)).resolves.toBeNull();
    bytes = line;
    mtimeMs = 2;
    now = 1_001;
    await expect(provider.get(path)).resolves.toMatchObject({
      token_count: 70_000,
    });
  });

  it("clears a previous session snapshot when the path is replaced but unreadable", async () => {
    const path = "/tmp/rollout-replaced.jsonl";
    let now = 0;
    let ino = 11;
    let bytes = Buffer.from(tokenCountLine(90_000));
    let failReads = false;
    const provider = makeCodexRolloutFillProvider({
      now: () => now,
      statFile: async () => ({
        size: bytes.length,
        mtimeMs: now + 1,
        dev: 2,
        ino,
        isFile: true,
      }),
      readFileRange: async (_requestedPath, start, length) =>
        failReads ? null : bytes.subarray(start, start + length),
    });

    await expect(provider.get(path)).resolves.toMatchObject({
      token_count: 90_000,
    });
    ino = 12;
    bytes = Buffer.from('{"type":"event_msg"}\n');
    failReads = true;
    now = 1_001;
    await provider.get(path);
    await flushAsyncWork();
    await expect(provider.get(path)).resolves.toBeNull();
  });

  it("publishes only the replacement session after inode rotation", async () => {
    const path = "/tmp/rollout-rotated.jsonl";
    let now = 0;
    let ino = 32;
    let bytes = Buffer.from(tokenCountLine(90_000));
    const provider = makeCodexRolloutFillProvider({
      now: () => now,
      statFile: async () => ({
        size: bytes.length,
        mtimeMs: now + 1,
        dev: 2,
        ino,
        isFile: true,
      }),
      readFileRange: async (_requestedPath, start, length) =>
        bytes.subarray(start, start + length),
    });

    await provider.get(path);
    ino = 33;
    bytes = Buffer.from(tokenCountLine(30_000));
    now = 1_001;
    await provider.get(path);
    await flushAsyncWork();

    await expect(provider.get(path)).resolves.toMatchObject({
      token_count: 30_000,
    });
  });

  it("clears the old snapshot after truncate/rewrite has no valid token row", async () => {
    const path = "/tmp/rollout-truncated.jsonl";
    let now = 0;
    let bytes = Buffer.from(tokenCountLine(90_000).repeat(3));
    let mtimeMs = 1;
    const provider = makeCodexRolloutFillProvider({
      now: () => now,
      statFile: async () => ({
        size: bytes.length,
        mtimeMs,
        dev: 2,
        ino: 34,
        isFile: true,
      }),
      readFileRange: async (_requestedPath, start, length) =>
        bytes.subarray(start, start + length),
    });

    await provider.get(path);
    bytes = Buffer.from('{"type":"event_msg"}\n');
    mtimeMs = 2;
    now = 1_001;
    await provider.get(path);
    await flushAsyncWork();

    await expect(provider.get(path)).resolves.toBeNull();
  });

  it("resets on continuity mismatch before accepting an appended session sample", async () => {
    const path = "/tmp/rollout-continuity.jsonl";
    let now = 0;
    let bytes = Buffer.from(tokenCountLine(90_000));
    let mtimeMs = 1;
    const provider = makeCodexRolloutFillProvider({
      now: () => now,
      statFile: async () => ({
        size: bytes.length,
        mtimeMs,
        dev: 2,
        ino: 35,
        isFile: true,
      }),
      readFileRange: async (_requestedPath, start, length) =>
        bytes.subarray(start, start + length),
    });

    await provider.get(path);
    bytes = Buffer.concat([
      Buffer.from(bytes.toString("utf8").replace("90000", "90001")),
      Buffer.from(tokenCountLine(50_000)),
    ]);
    mtimeMs = 2;
    now = 1_001;
    await provider.get(path);
    await flushAsyncWork();

    await expect(provider.get(path)).resolves.toMatchObject({
      token_count: 50_000,
    });
  });

  it("keeps the last good same-file snapshot across a transient append read error", async () => {
    const path = "/tmp/rollout-transient.jsonl";
    let now = 0;
    let bytes = Buffer.from(tokenCountLine(60_000));
    let failReads = false;
    const provider = makeCodexRolloutFillProvider({
      now: () => now,
      statFile: async () => ({
        size: bytes.length,
        mtimeMs: now + 1,
        dev: 2,
        ino: 13,
        isFile: true,
      }),
      readFileRange: async (_requestedPath, start, length) =>
        failReads ? null : bytes.subarray(start, start + length),
    });

    await provider.get(path);
    bytes = Buffer.concat([bytes, Buffer.from(tokenCountLine(100_000))]);
    failReads = true;
    now = 1_001;
    await provider.get(path);
    await flushAsyncWork();
    await expect(provider.get(path)).resolves.toMatchObject({
      token_count: 60_000,
    });
  });

  it("clears the last snapshot after the rollout file is confirmed absent", async () => {
    const path = "/tmp/rollout-deleted.jsonl";
    const bytes = Buffer.from(tokenCountLine(60_000));
    let now = 0;
    let exists = true;
    const provider = makeCodexRolloutFillProvider({
      now: () => now,
      statFile: async () =>
        exists
          ? {
              size: bytes.length,
              mtimeMs: 1,
              dev: 2,
              ino: 43,
              isFile: true,
            }
          : null,
      readFileRange: async (_requestedPath, start, length) =>
        bytes.subarray(start, start + length),
    });

    await expect(provider.get(path)).resolves.toMatchObject({
      token_count: 60_000,
    });
    exists = false;
    now = 1_001;
    await provider.get(path);
    await flushAsyncWork();

    await expect(provider.get(path)).resolves.toBeNull();
  });

  it("keeps the last snapshot across a transient stat failure", async () => {
    const path = "/tmp/rollout-stat-transient.jsonl";
    const bytes = Buffer.from(tokenCountLine(60_000));
    let now = 0;
    let failStat = false;
    const provider = makeCodexRolloutFillProvider({
      now: () => now,
      statFile: async () => {
        if (failStat) throw new Error("transient stat failure");
        return {
          size: bytes.length,
          mtimeMs: 1,
          dev: 2,
          ino: 44,
          isFile: true,
        };
      },
      readFileRange: async (_requestedPath, start, length) =>
        bytes.subarray(start, start + length),
    });

    await provider.get(path);
    failStat = true;
    now = 1_001;
    await provider.get(path);
    await flushAsyncWork();

    await expect(provider.get(path)).resolves.toMatchObject({
      token_count: 60_000,
    });
  });
});
