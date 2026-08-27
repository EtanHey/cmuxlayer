import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../src/server.js";
import type { ExecFn } from "../src/cmux-client.js";

const TEST_DIR = join(tmpdir(), "cmuxlayer-watch-spec-mcp-test");

function makeNoopExec(): ExecFn {
  return async () => ({ stdout: "{}", stderr: "" });
}

function createWatchServer(watchNotify?: () => Promise<boolean>) {
  return createServer({
    exec: makeNoopExec(),
    stateDir: join(TEST_DIR, "state"),
    disableSpawnPreflight: true,
    sessionIdentityResolver: () => null,
    watchRegistryPath: join(TEST_DIR, "watches.json"),
    watchRegistryNow: () => Date.now(),
    watchNotify,
  });
}

async function callTool(server: any, name: string, args: Record<string, unknown>) {
  const tool = server._registeredTools[name];
  if (!tool) throw new Error(`Tool not found: ${name}`);
  const result = await tool.handler(args, {} as any);
  return {
    raw: result,
    parsed:
      result.structuredContent ?? JSON.parse(result.content[0]?.text ?? "{}"),
  };
}

describe("WatchSpec MCP contract", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("returns a structured immediate error when arm_watch targets a missing file", async () => {
    const server = createWatchServer();
    const target = join(TEST_DIR, "missing.md");

    const { raw, parsed } = await callTool(server, "arm_watch", {
      owner: "lead-a",
      target,
      marker: "DONE",
      deadline: Date.now() + 5_000,
      provenance: "engine",
    });

    expect(raw.isError).toBe(true);
    expect(parsed).toMatchObject({
      error_code: "watch_target_missing",
      target,
    });
  });

  it("returns liveness provenance when arm_watch accepts a declared watch", async () => {
    const server = createWatchServer();
    const target = join(TEST_DIR, "findings.md");
    writeFileSync(target, "# Findings\n", "utf8");

    const { raw, parsed } = await callTool(server, "arm_watch", {
      owner: "lead-a",
      target,
      marker: "DONE",
      deadline: Date.now() + 5_000,
    });

    expect(raw.isError).not.toBe(true);
    expect(parsed).toMatchObject({
      ok: true,
      watch: {
        owner: "lead-a",
        target,
        provenance: "public",
        state: "armed",
        liveness_source: target,
        liveness: { value: true, source: "process" },
      },
    });
  });

  it("enum-constrains agent predicates at both WatchSpec schema boundaries", () => {
    const server = createWatchServer() as any;
    const armSchema = server._registeredTools.arm_watch.inputSchema;
    const waitSchema = server._registeredTools.wait_for.inputSchema;
    const baseWatch = {
      owner: "lead-a",
      target: "worker-a",
      deadline: Date.now() + 5_000,
    };

    for (const predicate of ["thinking", "working", "idle", "done", "error"]) {
      expect(armSchema.safeParse({ ...baseWatch, predicate }).success).toBe(
        true,
      );
      expect(
        waitSchema.safeParse({ watch: { ...baseWatch, predicate } }).success,
      ).toBe(true);
    }
    for (const predicate of ["creating", "booting", "ready", "arbitrary"]) {
      expect(armSchema.safeParse({ ...baseWatch, predicate }).success).toBe(
        false,
      );
      expect(
        waitSchema.safeParse({ watch: { ...baseWatch, predicate } }).success,
      ).toBe(false);
    }
    expect(armSchema.shape.predicate.description).toContain(
      "thinking, working, idle, done, error",
    );
    const fileWatch = { ...baseWatch, target: join(TEST_DIR, "report.md") };
    expect(
      armSchema.safeParse({ ...fileWatch, change: "content" }).success,
    ).toBe(true);
    expect(
      waitSchema.safeParse({
        watch: { ...fileWatch, change: "content" },
      }).success,
    ).toBe(true);
    expect(
      waitSchema.safeParse({
        watch: {
          ...fileWatch,
          marker: "DONE",
          change: "content",
        },
      }).success,
    ).toBe(false);
  });

  it("accepts WatchSpec through wait_for and blocks until marker count increases", async () => {
    const server = createWatchServer();
    const target = join(TEST_DIR, "findings.md");
    writeFileSync(target, "DONE_P1\n", "utf8");
    setTimeout(() => appendFileSync(target, "DONE_P1\n", "utf8"), 30);

    const { raw, parsed } = await callTool(server, "wait_for", {
      watch: {
        owner: "lead-a",
        target,
        marker: "DONE_P1",
        deadline: Date.now() + 1_000,
      },
      timeout_ms: 500,
    });

    expect(raw.isError).not.toBe(true);
    expect(parsed).toMatchObject({
      ok: true,
      matched: true,
      watch: {
        provenance: "engine",
        state: "fired",
        watermark: 1,
        observed_value: 2,
      },
    });
  });

  it("tries external notification before returning owner-not-live exhaustion", async () => {
    const notify = vi.fn().mockResolvedValue(false);
    const server = createWatchServer(notify);
    const target = join(TEST_DIR, "delivery-down.md");
    writeFileSync(target, "", "utf8");
    setTimeout(() => appendFileSync(target, "DONE\n", "utf8"), 30);

    const { raw, parsed } = await callTool(server, "wait_for", {
      watch: {
        owner: "lead-a",
        target,
        marker: "DONE",
        notify: true,
        deadline: Date.now() + 1_000,
      },
      timeout_ms: 500,
    });

    expect(raw.isError).not.toBe(true);
    expect(parsed).toMatchObject({
      ok: true,
      matched: true,
      watch: {
        state: "fired",
        terminal_reason: "predicate_matched",
        notification_pending: false,
        notification_attempts: 0,
        notification_exhausted_reason: "owner_not_live",
      },
    });
    expect(notify).toHaveBeenCalledOnce();
  });

  it("does not invoke an injected external notifier without explicit opt-in", async () => {
    const notify = vi.fn().mockResolvedValue(true);
    const server = createWatchServer(notify);
    const target = join(TEST_DIR, "local-only.md");
    writeFileSync(target, "", "utf8");
    setTimeout(() => appendFileSync(target, "DONE\n", "utf8"), 30);

    const { raw, parsed } = await callTool(server, "wait_for", {
      watch: {
        owner: "lead-a",
        target,
        marker: "DONE",
        deadline: Date.now() + 1_000,
      },
      timeout_ms: 500,
    });

    expect(raw.isError).not.toBe(true);
    expect(parsed).toMatchObject({
      ok: true,
      matched: true,
      watch: {
        state: "fired",
        terminal_reason: "predicate_matched",
        notification_pending: false,
      },
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it("D14 emits MCP progress before a long wait hits the harness silence cutoff", async () => {
    vi.useFakeTimers();
    try {
      const server = createWatchServer() as any;
      const engine = server._registeredTools.interact._engine;
      let resolveWait!: (value: unknown) => void;
      vi.spyOn(engine, "waitForWatch").mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveWait = resolve;
          }),
      );
      const sendNotification = vi.fn().mockResolvedValue(undefined);
      const pending = server._registeredTools.wait_for.handler(
        {
          watch: {
            owner: "lead-a",
            target: join(TEST_DIR, "long-wait.md"),
            marker: "DONE",
            deadline: Date.now() + 300_000,
          },
          timeout_ms: 300_000,
        },
        {
          _meta: { progressToken: "wait-progress-1" },
          sendNotification,
        } as any,
      );

      await vi.advanceTimersByTimeAsync(45_000);
      expect(sendNotification).toHaveBeenCalledWith({
        method: "notifications/progress",
        params: {
          progressToken: "wait-progress-1",
          progress: 1,
          message: "wait_for still waiting",
        },
      });

      resolveWait({
        matched: true,
        elapsed: 45_000,
        watch: { watch_id: "watch-1", state: "fired" },
      });
      await pending;
      const delivered = sendNotification.mock.calls.length;
      await vi.advanceTimersByTimeAsync(90_000);
      expect(sendNotification).toHaveBeenCalledTimes(delivered);
    } finally {
      vi.useRealTimers();
    }
  });
});
