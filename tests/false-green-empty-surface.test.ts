import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../src/server.js";
import type { ExecFn } from "../src/cmux-client.js";
import { StateManager } from "../src/state-manager.js";
import type { AgentRecord } from "../src/agent-types.js";

let testDir = "";

function parseToolResult(result: any): Record<string, any> {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

describe("false-green empty surface protection", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cmuxlayer-false-green-empty-surface-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("does not deliver a Gemini boot prompt to a bare shell prompt", async () => {
    const promptPath = join(testDir, "boot.md");
    writeFileSync(promptPath, "boot prompt", "utf8");

    const mockExec: ExecFn = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("read-screen")) {
        return {
          stdout: JSON.stringify({
            surface: "surface:1",
            text: "\n>\n",
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    });

    const server = createServer({
      exec: mockExec,
      skipAgentLifecycle: true,
      stateDir: testDir,
    });
    const tool = (server as any)._registeredTools["send_command"];

    const result = await tool.handler(
      {
        surface: "surface:1",
        command: "brainlayerGemini -s",
        boot_prompt_path: promptPath,
        boot_prompt_timeout_ms: 300,
      },
      {} as any,
    );

    const parsed = parseToolResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Timed out");
    expect(mockExec).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["send", "--surface", "surface:1", "boot prompt"]),
    );
  });

  it("does not deliver a Gemini boot prompt to a different agent prompt", async () => {
    const promptPath = join(testDir, "boot.md");
    writeFileSync(promptPath, "boot prompt", "utf8");

    const mockExec: ExecFn = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("read-screen")) {
        return {
          stdout: JSON.stringify({
            surface: "surface:1",
            text: "Claude Code\n>",
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    });

    const server = createServer({
      exec: mockExec,
      skipAgentLifecycle: true,
      stateDir: testDir,
    });
    const tool = (server as any)._registeredTools["send_command"];

    const result = await tool.handler(
      {
        surface: "surface:1",
        command: "brainlayerGemini -s",
        boot_prompt_path: promptPath,
        boot_prompt_timeout_ms: 300,
      },
      {} as any,
    );

    const parsed = parseToolResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Timed out");
    expect(mockExec).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["send", "--surface", "surface:1", "boot prompt"]),
    );
  });

  it("skips submit verification for a cleared long command when isolated state has no agent record", async () => {
    const longCommand = `echo ${"x".repeat(520)}`;
    const mockExec: ExecFn = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("read-screen")) {
        return {
          stdout: JSON.stringify({
            surface: "surface:2",
            text: "\n$\n",
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    });

    const server = createServer({
      exec: mockExec,
      skipAgentLifecycle: true,
      stateDir: testDir,
    });
    const tool = (server as any)._registeredTools["send_command"];

    const result = await tool.handler(
      { surface: "surface:2", command: longCommand },
      {} as any,
    );

    const parsed = parseToolResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.submit_verified).toBeNull();
  });

  it("runs submit verification when isolated state has an interactive record for the surface", async () => {
    vi.useFakeTimers();
    const now = "2026-07-01T20:56:00.000Z";
    const record: AgentRecord = {
      agent_id: "auto-claude-surface-2",
      surface_id: "surface:2",
      workspace_id: "workspace:1",
      state: "idle",
      repo: "cmuxlayer",
      model: "claude-sonnet-4",
      cli: "claude",
      cli_session_id: null,
      task_summary: "Live-looking isolated record",
      pid: null,
      version: 1,
      created_at: now,
      updated_at: now,
      error: null,
      parent_agent_id: null,
      spawn_depth: 0,
      deletion_intent: false,
      quality: "unknown",
      max_cost_per_agent: null,
      crash_recover: false,
      respawn_attempts: 0,
      user_killed: false,
    };
    new StateManager(testDir).writeState(record);

    const longCommand = `echo ${"x".repeat(520)}`;
    const mockExec: ExecFn = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("read-screen")) {
        return {
          stdout: JSON.stringify({
            surface: "surface:2",
            text: "\n$\n",
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    });

    const server = createServer({
      exec: mockExec,
      skipAgentLifecycle: true,
      stateDir: testDir,
    });
    const tool = (server as any)._registeredTools["send_command"];

    const resultPromise = tool.handler(
      { surface: "surface:2", command: longCommand },
      {} as any,
    );
    await vi.advanceTimersByTimeAsync(2500);
    const result = await resultPromise;

    const parsed = parseToolResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.submit_verified).toBeNull();
    expect(
      (mockExec as any).mock.calls.some(([, args]: [string, string[]]) =>
        args.includes("read-screen"),
      ),
    ).toBe(true);
  });
});
