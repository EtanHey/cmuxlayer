/**
 * Security hardening tests — ToolAnnotations + control sequence sanitization.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../src/server.js";
import type { ExecFn } from "../src/cmux-client.js";

const TEST_DIR = join(tmpdir(), "cmux-security-hardening-test");

function makeMockExec(): ExecFn {
  return vi.fn().mockResolvedValue({
    stdout: JSON.stringify({
      workspaces: [{ ref: "ws:1", title: "main" }],
      surfaces: [
        {
          ref: "surface:1",
          title: "test",
          type: "terminal",
          index: 0,
          selected: true,
          workspace_ref: "ws:1",
        },
      ],
    }),
    stderr: "",
  });
}

describe("B1: ToolAnnotations on all tools", () => {
  const READONLY_TOOLS = [
    "list_surfaces",
    "read_screen",
    "get_agent_state",
    "list_agents",
    "my_agents",
    "read_agent_output",
  ];

  const DESTRUCTIVE_TOOLS = ["kill", "close_surface", "stop_agent"];

  const MUTATING_TOOLS = [
    "new_split",
    "send_input",
    "send_key",
    "rename_tab",
    "notify",
    "set_status",
    "set_progress",
    "browser_surface",
    "spawn_agent",
    "send_to_agent",
    "wait_for",
    "wait_for_all",
    "interact",
  ];

  let tools: Record<string, { annotations?: Record<string, unknown> }>;

  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    const server = createServer({
      exec: makeMockExec(),
      stateDir: TEST_DIR,
    });
    tools = (server as any)._registeredTools;
  });

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("all 22 tools have annotations", () => {
    const toolNames = Object.keys(tools);
    expect(toolNames.length).toBe(22);
    for (const name of toolNames) {
      expect(
        tools[name].annotations,
        `${name} missing annotations`,
      ).toBeDefined();
    }
  });

  it("read-only tools have readOnlyHint=true", () => {
    for (const name of READONLY_TOOLS) {
      const ann = tools[name]?.annotations;
      expect(ann?.readOnlyHint, `${name} should be readOnly`).toBe(true);
      expect(ann?.destructiveHint, `${name} should not be destructive`).toBe(
        false,
      );
    }
  });

  it("destructive tools have destructiveHint=true", () => {
    for (const name of DESTRUCTIVE_TOOLS) {
      const ann = tools[name]?.annotations;
      expect(ann?.readOnlyHint, `${name} should not be readOnly`).toBe(false);
      expect(ann?.destructiveHint, `${name} should be destructive`).toBe(true);
    }
  });

  it("mutating tools have readOnlyHint=false", () => {
    for (const name of MUTATING_TOOLS) {
      const ann = tools[name]?.annotations;
      expect(ann?.readOnlyHint, `${name} should not be readOnly`).toBe(false);
    }
  });
});

describe("B3: sanitizeTerminalInput", () => {
  // Import the sanitizer directly
  let sanitizeTerminalInput: (text: string) => string;

  beforeAll(async () => {
    const mod = await import("../src/server.js");
    sanitizeTerminalInput = mod.sanitizeTerminalInput;
  });

  it("strips ANSI color sequences", () => {
    expect(sanitizeTerminalInput("hello\x1b[31mred\x1b[0m world")).toBe(
      "hellored world",
    );
  });

  it("strips cursor movement sequences", () => {
    expect(sanitizeTerminalInput("test\x1b[2Amove")).toBe("testmove");
  });

  it("strips BEL character (0x07)", () => {
    expect(sanitizeTerminalInput("test\x07bell")).toBe("testbell");
  });

  it("strips null bytes", () => {
    expect(sanitizeTerminalInput("a\x00b")).toBe("ab");
  });

  it("strips C0 control chars except HT, LF, CR", () => {
    // 0x01 (SOH), 0x02 (STX), 0x03 (ETX) should be stripped
    expect(sanitizeTerminalInput("a\x01\x02\x03b")).toBe("ab");
    // 0x0b (VT), 0x0c (FF) should be stripped
    expect(sanitizeTerminalInput("a\x0b\x0cb")).toBe("ab");
  });

  it("preserves newline (0x0a)", () => {
    expect(sanitizeTerminalInput("line1\nline2")).toBe("line1\nline2");
  });

  it("preserves tab (0x09)", () => {
    expect(sanitizeTerminalInput("col1\tcol2")).toBe("col1\tcol2");
  });

  it("preserves carriage return (0x0d)", () => {
    expect(sanitizeTerminalInput("line1\rline2")).toBe("line1\rline2");
  });

  it("strips OSC sequences (ESC ] ... BEL)", () => {
    const result = sanitizeTerminalInput("pre\x1b]0;title\x07post");
    expect(result).not.toContain("\x1b");
    expect(result).not.toContain("\x07");
    expect(result).toContain("pre");
    expect(result).toContain("post");
  });

  it("strips DEL character (0x7f)", () => {
    expect(sanitizeTerminalInput("ab\x7fc")).toBe("abc");
  });

  it("handles empty string", () => {
    expect(sanitizeTerminalInput("")).toBe("");
  });

  it("handles string with no control chars", () => {
    expect(sanitizeTerminalInput("normal text 123!@#")).toBe(
      "normal text 123!@#",
    );
  });
});
