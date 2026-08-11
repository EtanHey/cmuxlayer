import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../src/server.js";
import type { ExecFn } from "../src/cmux-client.js";

const TEST_DIR = join(tmpdir(), "cmuxlayer-watch-spec-mcp-test");

function makeNoopExec(): ExecFn {
  return async () => ({ stdout: "{}", stderr: "" });
}

function createWatchServer() {
  return createServer({
    exec: makeNoopExec(),
    stateDir: join(TEST_DIR, "state"),
    disableSpawnPreflight: true,
    sessionIdentityResolver: () => null,
    watchRegistryPath: join(TEST_DIR, "watches.json"),
    watchRegistryNow: () => Date.now(),
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
        state: "armed",
        liveness_source: target,
        liveness: { value: true, source: "process" },
      },
    });
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
        state: "fired",
        watermark: 1,
        observed_value: 2,
      },
    });
  });
});
