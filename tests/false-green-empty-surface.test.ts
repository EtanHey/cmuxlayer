import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../src/server.js";
import type { ExecFn } from "../src/cmux-client.js";

const TEST_DIR = join(tmpdir(), "cmuxlayer-false-green-empty-surface");

function parseToolResult(result: any): Record<string, any> {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

describe("false-green empty surface protection", () => {
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("does not deliver a Gemini boot prompt to a bare shell prompt", async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const promptPath = join(TEST_DIR, "boot.md");
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

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
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

  it("does not verify a cleared long command on a non-agent shell prompt", async () => {
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

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const tool = (server as any)._registeredTools["send_command"];

    const result = await tool.handler(
      { surface: "surface:2", command: longCommand },
      {} as any,
    );

    const parsed = parseToolResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Enter submit could not be verified");
  });
});
