import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExecFn } from "../src/cmux-client.js";

const previousMaxInlineChars = process.env.CMUXLAYER_MAX_INLINE_CHARS;
let testDir = "";

async function loadServerModule() {
  vi.resetModules();
  return import("../src/server.js");
}

function parseToolResult(result: any) {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

function getLifecycleEngine(server: any) {
  return server._registeredTools.interact._engine;
}

async function spawnReadyAgent(server: any) {
  const spawn = server._registeredTools["spawn_agent"];
  const spawnResult = await spawn.handler(
    {
      repo: "brainlayer",
      model: "sonnet",
      cli: "claude",
    },
    {} as any,
  );
  const agentId = parseToolResult(spawnResult).agent_id;
  const engine = getLifecycleEngine(server);
  const registry = engine.getRegistry();
  const agent = registry.get(agentId);
  registry.set(agentId, { ...agent, state: "ready" });
  return agentId;
}

const readPainpointFixture = (name: string) =>
  readFileSync(new URL(`./fixtures/painpoints/${name}`, import.meta.url), "utf8");

function makeLifecycleExec(initialReadyText: string | (() => string) = "codex> "): ExecFn {
  // Function mode is caller-driven and intentionally bypasses the internal
  // promptPending -> readyText simulation used by static string mode.
  let readyText =
    typeof initialReadyText === "function" ? initialReadyText() : initialReadyText;
  let promptPending = false;

  return vi.fn().mockImplementation(async (_cmd, args: string[]) => {
    if (args.includes("send-key") && args.includes("return")) {
      if (promptPending) {
        readyText =
          "gpt-5.5 xhigh - 99% left - ~/Gits/cmuxlayer\nWorking (1s - esc to interrupt)";
        promptPending = false;
      }
      return { stdout: "{}", stderr: "" };
    }

    if (args.includes("send")) {
      const text = String(args.at(-1) ?? "");
      if (text.trim() && !/Codex\b/.test(text)) {
        promptPending = true;
      }
      return { stdout: "{}", stderr: "" };
    }

    if (args.includes("read-screen")) {
      return {
        stdout: JSON.stringify({
          surface: "surface:new",
          text:
            typeof initialReadyText === "function"
              ? initialReadyText()
              : readyText,
          lines: 20,
          scrollback_used: false,
        }),
        stderr: "",
      };
    }

    if (args.includes("list-workspaces")) {
      return {
        stdout: JSON.stringify({
          workspaces: [
            {
              ref: "workspace:1",
              title: "Main",
              index: 0,
              selected: true,
              pinned: false,
            },
          ],
        }),
        stderr: "",
      };
    }

    if (args.includes("list-panes")) {
      return {
        stdout: JSON.stringify({
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          panes: [
            {
              ref: "pane:1",
              index: 0,
              focused: true,
              surface_count: 1,
              surface_refs: ["surface:new"],
              selected_surface_ref: "surface:new",
            },
          ],
        }),
        stderr: "",
      };
    }

    if (args.includes("list-pane-surfaces")) {
      return {
        stdout: JSON.stringify({
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          pane_ref: "pane:1",
          surfaces: [
            {
              ref: "surface:new",
              title: "agent-pane",
              type: "terminal",
              index: 0,
              selected: true,
            },
          ],
        }),
        stderr: "",
      };
    }

    return {
      stdout: JSON.stringify({
        workspace: "workspace:1",
        surface: "surface:new",
        pane: "pane:1",
        title: "",
        type: "terminal",
      }),
      stderr: "",
    };
  });
}

function makeStaticScreenExec(text: string): ExecFn {
  return vi.fn().mockImplementation(async (_cmd, args: string[]) => {
    if (args.includes("read-screen")) {
      return {
        stdout: JSON.stringify({
          surface: "surface:1",
          text,
          lines: 20,
          scrollback_used: false,
        }),
        stderr: "",
      };
    }
    return { stdout: "{}", stderr: "" };
  });
}

describe("pane input pointer discipline", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cmuxlayer-pointer-discipline-"));
    delete process.env.CMUXLAYER_MAX_INLINE_CHARS;
  });

  afterEach(() => {
    if (previousMaxInlineChars === undefined) {
      delete process.env.CMUXLAYER_MAX_INLINE_CHARS;
    } else {
      process.env.CMUXLAYER_MAX_INLINE_CHARS = previousMaxInlineChars;
    }
    rmSync(testDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("send_input refuses over-threshold text with file-pointer guidance and opt-out naming", async () => {
    process.env.CMUXLAYER_MAX_INLINE_CHARS = "600";
    const { createServer } = await loadServerModule();
    const mockExec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" });
    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const tool = (server as any)._registeredTools["send_input"];

    const result = await tool.handler(
      { surface: "surface:1", text: "x".repeat(601) },
      {} as any,
    );

    const parsed = parseToolResult(result);
    expect(result.isError).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("send_input.text");
    expect(parsed.error).toContain("allow_long_inline");
    expect(parsed.error).toContain("CMUXLAYER_MAX_INLINE_CHARS");
    expect(parsed.error).toContain("Read and follow <path>");
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("send_input allow_long_inline preserves chunked delivery", async () => {
    process.env.CMUXLAYER_MAX_INLINE_CHARS = "600";
    const { createServer } = await loadServerModule();
    const mockExec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" });
    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const tool = (server as any)._registeredTools["send_input"];
    expect(tool.inputSchema.shape.allow_long_inline).toBeDefined();

    const result = await tool.handler(
      {
        surface: "surface:1",
        text: "x".repeat(2_000),
        chunk_size: 120,
        allow_long_inline: true,
      },
      {} as any,
    );

    const parsed = parseToolResult(result);
    const setBufferCalls = mockExec.mock.calls.filter(([, args]) =>
      args.includes("set-buffer"),
    );
    expect(parsed.ok).toBe(true);
    expect(setBufferCalls.length).toBeGreaterThan(1);
  });

  it("CMUXLAYER_MAX_INLINE_CHARS changes the cap and invalid values fall back to the default", async () => {
    process.env.CMUXLAYER_MAX_INLINE_CHARS = "700";
    let module = await loadServerModule();
    let mockExec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" });
    let server = module.createServer({
      exec: mockExec,
      skipAgentLifecycle: true,
    });
    let tool = (server as any)._registeredTools["send_input"];

    let result = await tool.handler(
      { surface: "surface:1", text: "x".repeat(701) },
      {} as any,
    );

    let parsed = parseToolResult(result);
    expect(parsed.ok).toBe(false);
    expect(mockExec).not.toHaveBeenCalled();

    process.env.CMUXLAYER_MAX_INLINE_CHARS = "not-a-number";
    module = await loadServerModule();
    mockExec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" });
    server = module.createServer({ exec: mockExec, skipAgentLifecycle: true });
    tool = (server as any)._registeredTools["send_input"];

    result = await tool.handler(
      { surface: "surface:1", text: "x".repeat(1_700) },
      {} as any,
    );

    parsed = parseToolResult(result);
    expect(parsed.ok).toBe(true);
    expect(mockExec).toHaveBeenCalled();
  });

  it("short send_input text stays allowed", async () => {
    process.env.CMUXLAYER_MAX_INLINE_CHARS = "600";
    const { createServer } = await loadServerModule();
    const mockExec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" });
    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const tool = (server as any)._registeredTools["send_input"];

    const result = await tool.handler(
      { surface: "surface:1", text: "x".repeat(600) },
      {} as any,
    );

    const parsed = parseToolResult(result);
    expect(parsed.ok).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["send", "--surface", "surface:1"]),
    );
  });

  it("send_input refuses while a Claude AskUserQuestion overlay is active", async () => {
    const overlayText = readPainpointFixture("claude-ask-user-question-overlay.txt");
    const { createServer } = await loadServerModule();
    const mockExec = makeStaticScreenExec(overlayText);
    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const tool = (server as any)._registeredTools["send_input"];

    const result = await tool.handler(
      { surface: "surface:1", text: "new task", press_enter: true },
      {} as any,
    );

    const parsed = parseToolResult(result);
    expect(result.isError).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.error_code).toBe("blocked_by_interactive_prompt");
    expect(parsed.submit_verified).toBe(false);
    expect(parsed.screen).toMatchObject({
      control_state: "interactive_overlay",
      errors: expect.arrayContaining(["interactive_prompt"]),
    });
    expect(
      mockExec.mock.calls.some(([, args]) => args.includes("send")),
    ).toBe(false);
    expect(
      mockExec.mock.calls.some(([, args]) => args.includes("send-key")),
    ).toBe(false);
  });

  it("send_input allows prose that only mentions AskUserQuestion", async () => {
    const proseText = [
      "Claude Code",
      "",
      "Reviewer note: AskUserQuestion is a tool name mentioned in this plan.",
      "There is no modal overlay, selected response line, or numbered choice box.",
      "",
      "❯ ",
    ].join("\n");
    const { createServer } = await loadServerModule();
    const mockExec = makeStaticScreenExec(proseText);
    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const tool = (server as any)._registeredTools["send_input"];

    const result = await tool.handler(
      { surface: "surface:1", text: "new task", press_enter: false },
      {} as any,
    );

    const parsed = parseToolResult(result);
    expect(parsed.ok).toBe(true);
    expect(result.isError).toBeUndefined();
    expect(
      mockExec.mock.calls.some(([, args]) => args.includes("send")),
    ).toBe(true);
  });

  it("send_to refuses while a Claude permission prompt is active", async () => {
    const permissionText = readPainpointFixture("claude-permission-confirmation.txt");
    const { createServer, createServerContext } = await loadServerModule();
    let screenText = "codex> ";
    const mockExec = makeLifecycleExec(() => screenText);
    const context = createServerContext({
      exec: mockExec,
      stateDir: testDir,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
    });
    const server = createServer({ context });
    const agentId = await spawnReadyAgent(server);
    const tool = (server as any)._registeredTools["send_to"];
    screenText = permissionText;
    mockExec.mockClear();

    const result = await tool.handler(
      { agent_id: agentId, text: "continue", press_enter: true },
      {} as any,
    );

    const parsed = parseToolResult(result);
    expect(result.isError).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.error_code).toBe("blocked_by_permission_prompt");
    expect(parsed.submit_verified).toBe(false);
    expect(parsed.screen).toMatchObject({
      control_state: "permission_prompt",
      errors: expect.arrayContaining(["permission_prompt"]),
    });
    expect(
      mockExec.mock.calls.some(([, args]) => args.includes("send")),
    ).toBe(false);
    expect(
      mockExec.mock.calls.some(([, args]) => args.includes("paste-buffer")),
    ).toBe(false);
    expect(
      mockExec.mock.calls.some(([, args]) => args.includes("send-key")),
    ).toBe(false);
    context.dispose();
  });

  it("send_command refuses while a Claude permission prompt is active", async () => {
    const permissionText = readPainpointFixture("claude-permission-confirmation.txt");
    const { createServer } = await loadServerModule();
    const mockExec = makeStaticScreenExec(permissionText);
    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const tool = (server as any)._registeredTools["send_command"];

    const result = await tool.handler(
      { surface: "surface:1", command: "codex resume 123" },
      {} as any,
    );

    const parsed = parseToolResult(result);
    expect(result.isError).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.error_code).toBe("blocked_by_permission_prompt");
    expect(parsed.submit_verified).toBe(false);
    expect(parsed.screen).toMatchObject({
      control_state: "permission_prompt",
      errors: expect.arrayContaining(["permission_prompt"]),
    });
    expect(
      mockExec.mock.calls.some(([, args]) => args.includes("send")),
    ).toBe(false);
    expect(
      mockExec.mock.calls.some(([, args]) => args.includes("send-key")),
    ).toBe(false);
  });

  it("send_command refuses over-threshold command text unless explicitly opted out", async () => {
    process.env.CMUXLAYER_MAX_INLINE_CHARS = "600";
    const { createServer } = await loadServerModule();
    const mockExec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" });
    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const tool = (server as any)._registeredTools["send_command"];
    expect(tool.inputSchema.shape.allow_long_inline).toBeDefined();

    let result = await tool.handler(
      { surface: "surface:1", command: "x".repeat(601) },
      {} as any,
    );

    let parsed = parseToolResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("send_command.command");
    expect(parsed.error).toContain("boot_prompt_path");
    expect(mockExec).not.toHaveBeenCalled();

    result = await tool.handler(
      {
        surface: "surface:1",
        command: "x".repeat(601),
        allow_long_inline: true,
      },
      {} as any,
    );

    parsed = parseToolResult(result);
    expect(parsed.ok).toBe(true);
    expect(
      mockExec.mock.calls.filter(([, args]) => args.includes("paste-buffer"))
        .length,
    ).toBeGreaterThan(0);
    expect(
      mockExec.mock.calls.filter(([, args]) => args.includes("send-key"))
        .length,
    ).toBe(1);
  });

  it("spawn_agent refuses an over-threshold inline prompt and points to boot_prompt_path", async () => {
    process.env.CMUXLAYER_MAX_INLINE_CHARS = "600";
    const { createServer, createServerContext } = await loadServerModule();
    const mockExec = makeLifecycleExec();
    const context = createServerContext({
      exec: mockExec,
      stateDir: testDir,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
    });
    const server = createServer({ context });
    const tool = (server as any)._registeredTools["spawn_agent"];
    mockExec.mockClear();

    const result = await tool.handler(
      {
        repo: "brainlayer",
        model: "codex",
        cli: "codex",
        prompt: "x".repeat(601),
      },
      {} as any,
    );

    const parsed = parseToolResult(result);
    expect(result.isError).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("spawn_agent.prompt");
    expect(parsed.error).toContain("boot_prompt_path");
    expect(parsed.error).toContain("allow_long_inline");
    expect(mockExec).not.toHaveBeenCalled();
    context.dispose();
  });

  it("spawn_agent allow_long_inline bypasses the inline prompt cap", async () => {
    process.env.CMUXLAYER_MAX_INLINE_CHARS = "600";
    const { createServer, createServerContext } = await loadServerModule();
    const mockExec = makeLifecycleExec();
    const context = createServerContext({
      exec: mockExec,
      stateDir: testDir,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
    });
    const server = createServer({ context });
    const tool = (server as any)._registeredTools["spawn_agent"];
    expect(tool.inputSchema.shape.allow_long_inline).toBeDefined();

    const result = await tool.handler(
      {
        repo: "brainlayer",
        model: "codex",
        cli: "codex",
        prompt: "x".repeat(2_000),
        allow_long_inline: true,
      },
      {} as any,
    );

    const parsed = parseToolResult(result);
    expect(parsed.ok).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["set-buffer"]),
    );
    context.dispose();
  });

  it("spawn_agent keeps boot_prompt_path allowed regardless of prompt file size", async () => {
    process.env.CMUXLAYER_MAX_INLINE_CHARS = "600";
    const promptPath = join(testDir, "large-boot-prompt.md");
    writeFileSync(promptPath, "x".repeat(2_400), "utf8");
    const { createServer, createServerContext } = await loadServerModule();
    const mockExec = makeLifecycleExec();
    const context = createServerContext({
      exec: mockExec,
      stateDir: testDir,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
    });
    const server = createServer({ context });
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "brainlayer",
        model: "codex",
        cli: "codex",
        boot_prompt_path: promptPath,
      },
      {} as any,
    );

    const parsed = parseToolResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.boot_prompt_delivered).toBe(true);
    context.dispose();
  });

  it("send_to refuses over-threshold text with file-pointer guidance and opt-out naming", async () => {
    process.env.CMUXLAYER_MAX_INLINE_CHARS = "600";
    const { createServer, createServerContext } = await loadServerModule();
    const mockExec = makeLifecycleExec();
    const context = createServerContext({
      exec: mockExec,
      stateDir: testDir,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
    });
    const server = createServer({ context });
    const agentId = await spawnReadyAgent(server);
    const sendTo = (server as any)._registeredTools["send_to"];
    mockExec.mockClear();

    const result = await sendTo.handler(
      {
        agent_id: agentId,
        text: "x".repeat(601),
        press_enter: true,
      },
      {} as any,
    );

    const parsed = parseToolResult(result);
    expect(result.isError).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("send_to.text");
    expect(parsed.error).toContain("allow_long_inline");
    expect(parsed.error).toContain("CMUXLAYER_MAX_INLINE_CHARS");
    expect(parsed.error).toContain("Read and follow <path>");
    expect(mockExec).not.toHaveBeenCalled();
    context.dispose();
  });

  it("send_to allow_long_inline bypasses the inline text cap", async () => {
    process.env.CMUXLAYER_MAX_INLINE_CHARS = "600";
    const { createServer, createServerContext } = await loadServerModule();
    const mockExec = makeLifecycleExec();
    const context = createServerContext({
      exec: mockExec,
      stateDir: testDir,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
    });
    const server = createServer({ context });
    const agentId = await spawnReadyAgent(server);
    const sendTo = (server as any)._registeredTools["send_to"];
    expect(sendTo.inputSchema.shape.allow_long_inline).toBeDefined();
    mockExec.mockClear();

    const result = await sendTo.handler(
      {
        agent_id: agentId,
        text: "x".repeat(2_000),
        press_enter: true,
        allow_long_inline: true,
      },
      {} as any,
    );

    const parsed = parseToolResult(result);
    const setBufferCalls = mockExec.mock.calls.filter(([, args]) =>
      args.includes("set-buffer"),
    );
    expect(parsed.ok).toBe(true);
    expect(setBufferCalls.length).toBeGreaterThan(1);
    context.dispose();
  });

  it("short send_to text stays allowed at the configured cap", async () => {
    process.env.CMUXLAYER_MAX_INLINE_CHARS = "600";
    const { createServer, createServerContext } = await loadServerModule();
    const mockExec = makeLifecycleExec();
    const context = createServerContext({
      exec: mockExec,
      stateDir: testDir,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
    });
    const server = createServer({ context });
    const agentId = await spawnReadyAgent(server);
    const sendTo = (server as any)._registeredTools["send_to"];
    mockExec.mockClear();

    const result = await sendTo.handler(
      {
        agent_id: agentId,
        text: "x".repeat(600),
        press_enter: true,
      },
      {} as any,
    );

    const parsed = parseToolResult(result);
    expect(parsed.ok).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["send-key", "--surface", "surface:new"]),
    );
    context.dispose();
  });

  it("send_to_agent refuses over-threshold text unless explicitly opted out", async () => {
    process.env.CMUXLAYER_MAX_INLINE_CHARS = "600";
    const { createServer, createServerContext } = await loadServerModule();
    const mockExec = makeLifecycleExec();
    const context = createServerContext({
      exec: mockExec,
      stateDir: testDir,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
    });
    const server = createServer({ context });
    const agentId = await spawnReadyAgent(server);
    const sendToAgent = (server as any)._registeredTools["send_to_agent"];
    expect(sendToAgent.inputSchema.shape.allow_long_inline).toBeDefined();
    mockExec.mockClear();

    let result = await sendToAgent.handler(
      {
        agent_id: agentId,
        text: "x".repeat(601),
        press_enter: true,
      },
      {} as any,
    );

    let parsed = parseToolResult(result);
    expect(result.isError).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("send_to_agent.text");
    expect(parsed.error).toContain("allow_long_inline");
    expect(mockExec).not.toHaveBeenCalled();

    result = await sendToAgent.handler(
      {
        agent_id: agentId,
        text: "x".repeat(2_000),
        press_enter: true,
        allow_long_inline: true,
      },
      {} as any,
    );

    parsed = parseToolResult(result);
    expect(parsed.ok).toBe(true);
    expect(
      mockExec.mock.calls.filter(([, args]) => args.includes("set-buffer"))
        .length,
    ).toBeGreaterThan(1);
    context.dispose();
  });

  it("CMUXLAYER_MAX_INLINE_CHARS changes the send_to cap", async () => {
    process.env.CMUXLAYER_MAX_INLINE_CHARS = "700";
    const { createServer, createServerContext } = await loadServerModule();
    const mockExec = makeLifecycleExec();
    const context = createServerContext({
      exec: mockExec,
      stateDir: testDir,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
    });
    const server = createServer({ context });
    const agentId = await spawnReadyAgent(server);
    const sendTo = (server as any)._registeredTools["send_to"];
    mockExec.mockClear();

    const result = await sendTo.handler(
      {
        agent_id: agentId,
        text: "x".repeat(701),
        press_enter: true,
      },
      {} as any,
    );

    const parsed = parseToolResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("CMUXLAYER_MAX_INLINE_CHARS=700");
    expect(mockExec).not.toHaveBeenCalled();
    context.dispose();
  });
});
