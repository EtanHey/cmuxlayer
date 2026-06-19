/**
 * Integration tests for the agent lifecycle MCP tools registered in server.ts.
 * Tests tool registration and handler dispatch with mocked cmux client.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../src/server.js";
import type { ExecFn } from "../src/cmux-client.js";
import { generateAgentId, type AgentRecord } from "../src/agent-types.js";

const TEST_DIR = join(tmpdir(), "cmux-agents-test-server-tools");

const AGENT_TOOLS = [
  "spawn_agent",
  "new_worktree_split",
  "spawn_in_workspace",
  "resync_agents",
  "send_to",
  "wait_for",
  "wait_for_all",
  "get_agent_state",
  "list_agents",
  "stop_agent",
  "send_to_agent",
  "read_agent_output",
  "my_agents",
] as const;

function makeLifecycleExec(): ExecFn {
  let readyText = "What can I help you with?\n>";
  return vi.fn().mockImplementation(async (_cmd, args) => {
    if (args.includes("send")) {
      const text = String(args[args.length - 1] ?? "");
      if (text.includes("Codex")) readyText = "codex> ";
      if (text.includes("Claude")) readyText = "What can I help you with?\n>";
      if (text.includes("Cursor")) readyText = "cursor> ";
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

    if (args.includes("read-screen")) {
      return {
        stdout: JSON.stringify({
          surface: "surface:new",
          text: readyText,
          lines: 20,
          scrollback_used: false,
        }),
        stderr: "",
      };
    }

    return {
      stdout: JSON.stringify({
        workspace: "ws:1",
        surface: "surface:new",
        pane: "pane:1",
        title: "",
        type: "terminal",
      }),
      stderr: "",
    };
  });
}

function createLifecycleServer(exec: ExecFn) {
  return createServer({
    exec,
    stateDir: TEST_DIR,
    disableSpawnPreflight: true,
    sessionIdentityResolver: () => null,
  });
}

function moveOnlyAgentStateDir(prefix: string) {
  const entries = readdirSync(TEST_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name !== "events");
  expect(entries).toHaveLength(1);
  renameSync(
    join(TEST_DIR, entries[0]),
    join(TEST_DIR, `${prefix}-${entries[0]}`),
  );
}

function renameOnlyAgentStateToSession(sessionId: string): string {
  const entries = readdirSync(TEST_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name !== "events");
  expect(entries).toHaveLength(1);

  const statePath = join(TEST_DIR, entries[0], "state.json");
  const current = JSON.parse(readFileSync(statePath, "utf8")) as AgentRecord;
  const finalAgentId = generateAgentId(current.cli, current.repo, sessionId);
  const updated: AgentRecord = {
    ...current,
    agent_id: finalAgentId,
    cli_session_id: sessionId,
    version: current.version + 1,
    updated_at: new Date().toISOString(),
  };

  const finalDir = join(TEST_DIR, finalAgentId);
  mkdirSync(finalDir, { recursive: true });
  writeFileSync(join(finalDir, "state.json"), JSON.stringify(updated, null, 2));
  rmSync(join(TEST_DIR, entries[0]), { recursive: true, force: true });
  return finalAgentId;
}

describe("agent lifecycle tool registration", () => {
  it("registers all 13 agent lifecycle tools when lifecycle is enabled", () => {
    const mockExec = makeLifecycleExec();
    const server = createLifecycleServer(mockExec);
    const registeredTools = (server as any)._registeredTools;
    const toolNames = Object.keys(registeredTools);

    for (const expected of AGENT_TOOLS) {
      expect(toolNames, `Missing tool: ${expected}`).toContain(expected);
    }
  });

  it("does NOT register agent tools when skipAgentLifecycle is true", () => {
    const mockExec: ExecFn = vi.fn().mockResolvedValue({
      stdout: "{}",
      stderr: "",
    });
    const server = createServer({
      exec: mockExec,
      skipAgentLifecycle: true,
    });
    const registeredTools = (server as any)._registeredTools;
    const toolNames = Object.keys(registeredTools);

    for (const tool of AGENT_TOOLS) {
      expect(toolNames).not.toContain(tool);
    }
  });

  it("total tool count is 35 (20 low-level + 13 agent lifecycle + 2 v2)", () => {
    const mockExec = makeLifecycleExec();
    const server = createLifecycleServer(mockExec);
    const registeredTools = (server as any)._registeredTools;
    expect(Object.keys(registeredTools)).toHaveLength(35);
  });
});

describe("agent lifecycle tool handlers", () => {
  let mockExec: ExecFn;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    mockExec = makeLifecycleExec();
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("spawn_agent returns agent_id and surface_id", async () => {
    const server = createLifecycleServer(mockExec);
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "fix gap F",
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.agent_id).toMatch(/^brainlayerClaude-pending-\d+-[a-z0-9]+$/);
    expect(parsed.surface_id).toBe("surface:new");
    expect(parsed.state).toBe("ready");

    const stateTool = (server as any)._registeredTools["get_agent_state"];
    const stateResult = await stateTool.handler(
      { agent_id: parsed.agent_id },
      {} as any,
    );
    const persisted =
      stateResult.structuredContent ?? JSON.parse(stateResult.content[0].text);
    expect(persisted.auto_archive_on_done).toBe(true);
  });

  it("spawn_agent accepts an omitted model and resolves the CLI default", async () => {
    const server = createLifecycleServer(mockExec);
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "brainlayer",
        cli: "claude",
        prompt: "fix gap F",
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.model).toBe("opus-4-8[1m]");
    expect(parsed.requested_model).toBe("");
    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["send", "brainlayerClaude -s"]),
    );

    const stateTool = (server as any)._registeredTools["get_agent_state"];
    const stateResult = await stateTool.handler(
      { agent_id: parsed.agent_id },
      {} as any,
    );
    const persisted =
      stateResult.structuredContent ?? JSON.parse(stateResult.content[0].text);
    expect(persisted.model).toBe("opus-4-8[1m]");
  });

  it("spawn_agent accepts explicit role and returns persisted role", async () => {
    const server = createLifecycleServer(mockExec);
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        role: "ic",
        prompt: "coordinate task",
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.role).toBe("ic");

    const stateTool = (server as any)._registeredTools["get_agent_state"];
    const stateResult = await stateTool.handler(
      { agent_id: parsed.agent_id },
      {} as any,
    );
    const persisted =
      stateResult.structuredContent ?? JSON.parse(stateResult.content[0].text);
    expect(persisted.role).toBe("ic");
  });

  it("spawn_agent sends inline prompt after the agent is ready", async () => {
    const server = createLifecycleServer(mockExec);
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "brainlayer",
        model: "codex",
        cli: "codex",
        prompt: "fix prompt delivery",
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["send", "--surface", "surface:new"]),
    );
    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "send",
        "--surface",
        "surface:new",
        "fix prompt delivery",
      ]),
    );
    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "send-key",
        "--surface",
        "surface:new",
        "return",
      ]),
    );
  });

  it("spawn_agent canonicalizes the agent id after session capture renames pending state", async () => {
    const sessionId = "019ec0e6-1111-2222-3333-444455556666";
    let finalAgentId: string | null = null;
    let renamed = false;
    const baseExec = makeLifecycleExec();
    mockExec = vi.fn().mockImplementation(async (cmd, args) => {
      if (
        !renamed &&
        args.includes("send") &&
        String(args.at(-1) ?? "") === "probe renamed state"
      ) {
        renamed = true;
        finalAgentId = renameOnlyAgentStateToSession(sessionId);
      }
      return baseExec(cmd, args);
    });
    const server = createLifecycleServer(mockExec);
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "cmuxlayer",
        model: "codex",
        cli: "codex",
        prompt: "probe renamed state",
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.agent_id).toBe(finalAgentId);
    expect(parsed.agent_id).toBe("cmuxlayerCodex-019ec0e6");
    expect(parsed.boot_prompt_delivered).toBe(true);

    const stateTool = (server as any)._registeredTools["get_agent_state"];
    const stateResult = await stateTool.handler(
      { agent_id: parsed.agent_id },
      {} as any,
    );
    const persisted =
      stateResult.structuredContent ?? JSON.parse(stateResult.content[0].text);
    expect(persisted.boot_prompt_pending).toBe(false);
    expect(persisted.task_summary).toBe("probe renamed state");
  });

  it("spawn_agent with worktree launches from the worktree and inherits MCPs by default", async () => {
    const gitsDir = join(TEST_DIR, "Gits");
    const repoRoot = join(gitsDir, "cmuxlayer");
    mkdirSync(repoRoot, { recursive: true });
    const worktreeExec = vi.fn().mockImplementation(async () => {
      mkdirSync(join(gitsDir, "cmuxlayer.wt", "skill-eval"), {
        recursive: true,
      });
      return { stdout: "", stderr: "" };
    });
    const server = createServer({
      exec: mockExec,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
      worktreeHomeDir: gitsDir,
      worktreeExec,
    });
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "cmuxlayer",
        model: "codex",
        cli: "codex",
        role: "worker",
        worktree: {
          name: "skill eval",
          branch: "fix/skill-eval",
          base: "origin/main",
        },
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    const worktreePath = join(gitsDir, "cmuxlayer.wt", "skill-eval");
    expect(parsed.ok).toBe(true);
    expect(parsed.worktree).toMatchObject({
      path: worktreePath,
      branch: "fix/skill-eval",
      created: true,
      reused: false,
    });
    expect(parsed.mcp_profile).toBe("inherit");
    expect(worktreeExec).toHaveBeenCalledWith("git", [
      "-C",
      repoRoot,
      "worktree",
      "add",
      "-b",
      "fix/skill-eval",
      worktreePath,
      "origin/main",
    ]);
    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "send",
        "--surface",
        "surface:new",
        `CMUXLAYER_MCP_PROFILE=inherit cmuxlayerCodex -s -w '${worktreePath}'`,
      ]),
    );
  });

  it("new_worktree_split launches a worker with the requested MCP profile", async () => {
    const gitsDir = join(TEST_DIR, "Gits");
    const repoRoot = join(gitsDir, "cmuxlayer");
    mkdirSync(repoRoot, { recursive: true });
    const worktreeExec = vi.fn().mockImplementation(async () => {
      mkdirSync(join(gitsDir, "cmuxlayer.wt", "sterile-worker"), {
        recursive: true,
      });
      return { stdout: "", stderr: "" };
    });
    const server = createServer({
      exec: mockExec,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
      worktreeHomeDir: gitsDir,
      worktreeExec,
    });
    const tool = (server as any)._registeredTools["new_worktree_split"];

    const result = await tool.handler(
      {
        repo: "cmuxlayer",
        model: "codex",
        cli: "codex",
        worktree: { name: "sterile worker" },
        mcp_profile: "sterile",
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    const worktreePath = join(gitsDir, "cmuxlayer.wt", "sterile-worker");
    expect(parsed.ok).toBe(true);
    expect(parsed.role).toBe("worker");
    expect(parsed.mcp_profile).toBe("sterile");
    expect(parsed.worktree.path).toBe(worktreePath);
    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "send",
        "--surface",
        "surface:new",
        `CMUXLAYER_MCP_PROFILE=sterile cmuxlayerCodex -s -w '${worktreePath}'`,
      ]),
    );
  });

  it("spawn_agent finalizes a pending Cursor prompt when the state directory is noncanonical", async () => {
    let movedStateDir = false;
    const baseExec = makeLifecycleExec();
    mockExec = vi.fn().mockImplementation(async (cmd, args) => {
      if (
        !movedStateDir &&
        args.includes("send") &&
        String(args.at(-1) ?? "") === "cmuxlayerCursor -s"
      ) {
        movedStateDir = true;
        moveOnlyAgentStateDir("legacy");
      }
      return baseExec(cmd, args);
    });
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const stop = (server as any)._registeredTools["stop_agent"];

    const result = await spawn.handler(
      {
        repo: "cmuxlayer",
        model: "",
        cli: "cursor",
        prompt: "Say VERIFY_OK and stop.",
      },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(true);
    expect(parsed.agent_id).toMatch(/^cmuxlayerCursor-pending-\d+-[a-z0-9]+$/);
    expect(parsed.state).toBe("ready");
    expect(parsed.boot_prompt_delivered).toBe(true);

    const stopResult = await stop.handler(
      { agent_id: parsed.agent_id },
      {} as any,
    );
    const stopped =
      stopResult.structuredContent ?? JSON.parse(stopResult.content[0].text);
    expect(stopped.ok).toBe(true);
    expect(stopped.state).toBe("done");
  });

  it("spawn_agent sends boot_prompt_path contents after readiness", async () => {
    const promptPath = join(TEST_DIR, "mandate.md");
    writeFileSync(promptPath, "file prompt body", "utf8");
    const server = createLifecycleServer(mockExec);
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

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "send",
        "--surface",
        "surface:new",
        "file prompt body",
      ]),
    );
  });

  it("read_agent_output scans bounded tail lines by default", async () => {
    const server = createLifecycleServer(mockExec);
    const tool = (server as any)._registeredTools["read_agent_output"];

    const result = await tool.handler(
      { surface: "surface:new", tag: "OUTPUT", lines: 80 },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.found).toBe(false);
    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "read-screen",
        "--surface",
        "surface:new",
        "--lines",
        "80",
      ]),
    );
    const readCalls = (mockExec as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([, args]) => Array.isArray(args) && args.includes("read-screen"),
    );
    expect(readCalls.at(-1)?.[1]).not.toContain("--scrollback");
  });

  it("read_agent_output can opt into full scrollback", async () => {
    const server = createLifecycleServer(mockExec);
    const tool = (server as any)._registeredTools["read_agent_output"];

    await tool.handler(
      { surface: "surface:new", tag: "OUTPUT", lines: 80, scrollback: true },
      {} as any,
    );

    const readCalls = (mockExec as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([, args]) => Array.isArray(args) && args.includes("read-screen"),
    );
    expect(readCalls.at(-1)?.[1]).toContain("--scrollback");
  });

  it("spawn_agent retries Enter when the launcher command remains pending at the shell", async () => {
    const promptPath = join(TEST_DIR, "mandate.md");
    writeFileSync(promptPath, "file prompt body", "utf8");
    let launcherReturnCount = 0;
    let promptDelivered = false;
    let lastSentText = "";
    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("list-workspaces")) {
        return {
          stdout: JSON.stringify({
            workspaces: [
              {
                ref: "workspace:voice",
                title: "VoiceLayer",
                current_directory: "/Users/etanheyman/Gits/voicelayer",
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args.includes("list-panes")) {
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:voice",
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
            workspace_ref: "workspace:voice",
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
      if (args.includes("send")) {
        lastSentText = String(args.at(-1) ?? "");
        if (lastSentText === "file prompt body") {
          promptDelivered = true;
        }
        return { stdout: JSON.stringify({ ok: true }), stderr: "" };
      }
      if (args.includes("send-key")) {
        if (lastSentText === "voicelayerCodex -s") {
          launcherReturnCount += 1;
        }
        return { stdout: JSON.stringify({ ok: true }), stderr: "" };
      }
      if (args.includes("read-screen")) {
        return {
          stdout: JSON.stringify({
            surface: "surface:new",
            text:
              lastSentText === ""
                ? "$ "
                : launcherReturnCount < 2
                  ? "$ voicelayerCodex -s"
                  : "codex> ",
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return {
        stdout: JSON.stringify({
          workspace: "workspace:voice",
          surface: "surface:new",
          pane: "pane:1",
          title: "",
          type: "terminal",
        }),
        stderr: "",
      };
    });
    const server = createLifecycleServer(mockExec);
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "voicelayer",
        model: "codex",
        cli: "codex",
        boot_prompt_path: promptPath,
        boot_prompt_timeout_ms: 1_000,
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.workspace_id).toBe("workspace:voice");
    expect(launcherReturnCount).toBe(2);
    expect(promptDelivered).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "read-screen",
        "--workspace",
        "workspace:voice",
        "--surface",
        "surface:new",
      ]),
    );
    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "send",
        "--workspace",
        "workspace:voice",
        "--surface",
        "surface:new",
        "file prompt body",
      ]),
    );
  });

  it("spawn_agent treats launch submit verification as advisory when readiness appears with shell history", async () => {
    const promptPath = join(TEST_DIR, "mandate.md");
    writeFileSync(promptPath, "file prompt body", "utf8");
    let launcherReturnCount = 0;
    let promptDelivered = false;
    let lastSentText = "";
    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("list-workspaces")) {
        return {
          stdout: JSON.stringify({
            workspaces: [
              {
                ref: "workspace:voice",
                title: "VoiceLayer",
                current_directory: "/Users/etanheyman/Gits/voicelayer",
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args.includes("list-panes")) {
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:voice",
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
            workspace_ref: "workspace:voice",
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
      if (args.includes("send")) {
        lastSentText = String(args.at(-1) ?? "");
        if (lastSentText === "file prompt body") {
          promptDelivered = true;
        }
        return { stdout: JSON.stringify({ ok: true }), stderr: "" };
      }
      if (args.includes("send-key")) {
        if (lastSentText === "voicelayerCodex -s") {
          launcherReturnCount += 1;
        }
        return { stdout: JSON.stringify({ ok: true }), stderr: "" };
      }
      if (args.includes("read-screen")) {
        return {
          stdout: JSON.stringify({
            surface: "surface:new",
            text: lastSentText === "" ? "$ " : "$ voicelayerCodex -s\ncodex> ",
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return {
        stdout: JSON.stringify({
          workspace: "workspace:voice",
          surface: "surface:new",
          pane: "pane:1",
          title: "",
          type: "terminal",
        }),
        stderr: "",
      };
    });
    const server = createLifecycleServer(mockExec);
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "voicelayer",
        model: "codex",
        cli: "codex",
        boot_prompt_path: promptPath,
        boot_prompt_timeout_ms: 1_000,
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(launcherReturnCount).toBeGreaterThanOrEqual(2);
    expect(promptDelivered).toBe(true);
  });

  it("spawn_agent stores boot_prompt_path contents as task_summary after delivery", async () => {
    const promptPath = join(TEST_DIR, "mandate.md");
    writeFileSync(promptPath, "file prompt body", "utf8");
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const getState = (server as any)._registeredTools["get_agent_state"];

    const spawnResult = await spawn.handler(
      {
        repo: "brainlayer",
        model: "codex",
        cli: "codex",
        boot_prompt_path: promptPath,
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;

    const stateResult = await getState.handler(
      { agent_id: agentId },
      {} as any,
    );
    const state =
      stateResult.structuredContent ?? JSON.parse(stateResult.content[0].text);
    expect(state.task_summary).toBe("file prompt body");
  });

  it("spawn_agent rejects prompt and boot_prompt_path together", async () => {
    const promptPath = join(TEST_DIR, "mandate.md");
    writeFileSync(promptPath, "file prompt body", "utf8");
    const server = createLifecycleServer(mockExec);
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "brainlayer",
        model: "codex",
        cli: "codex",
        prompt: "inline",
        boot_prompt_path: promptPath,
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("mutually exclusive");
  });

  it("spawn_agent rejects missing boot_prompt_path before creating a surface", async () => {
    const server = createLifecycleServer(mockExec);
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "brainlayer",
        model: "codex",
        cli: "codex",
        boot_prompt_path: join(TEST_DIR, "missing.md"),
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("ENOENT");
    expect(mockExec).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["new-split"]),
    );
  });

  it("spawn_agent reports readiness timeout without poisoning agent state", async () => {
    const promptPath = join(TEST_DIR, "mandate.md");
    writeFileSync(promptPath, "file prompt body", "utf8");
    let launchSent = false;
    let readCountAfterLaunch = 0;
    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("send")) {
        launchSent = true;
      }
      if (args.includes("list-workspaces")) {
        return { stdout: JSON.stringify({ workspaces: [] }), stderr: "" };
      }
      if (args.includes("list-panes")) {
        return { stdout: JSON.stringify({ panes: [] }), stderr: "" };
      }
      if (args.includes("read-screen")) {
        if (launchSent) {
          readCountAfterLaunch += 1;
        }
        return {
          stdout: JSON.stringify({
            surface: "surface:new",
            text:
              !launchSent || readCountAfterLaunch === 1
                ? "$ "
                : readCountAfterLaunch === 2
                  ? "codex> "
                  : "$ waiting",
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return {
        stdout: JSON.stringify({
          workspace: "ws:1",
          surface: "surface:new",
          pane: "pane:1",
          title: "",
          type: "terminal",
        }),
        stderr: "",
      };
    });
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const getState = (server as any)._registeredTools["get_agent_state"];

    const spawnResult = await spawn.handler(
      {
        repo: "brainlayer",
        model: "codex",
        cli: "codex",
        boot_prompt_path: promptPath,
        boot_prompt_timeout_ms: 20,
      },
      {} as any,
    );
    const parsed =
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.agent_id).toBeDefined();
    expect(parsed.surface_id).toBe("surface:new");
    expect(parsed.last_10_lines).toContain("$ waiting");

    const stateResult = await getState.handler(
      { agent_id: parsed.agent_id },
      {} as any,
    );
    const state =
      stateResult.structuredContent ?? JSON.parse(stateResult.content[0].text);
    expect(state.state).toBe("booting");
    expect(state.boot_prompt_pending).toBe(false);
    expect(state.error).toBeNull();
    expect(mockExec).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "send",
        "--surface",
        "surface:new",
        "file prompt body",
      ]),
    );
  });

  it("spawn_agent persists crash_recover=true in agent state", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const getState = (server as any)._registeredTools["get_agent_state"];

    const spawnResult = await spawn.handler(
      {
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "fix gap F",
        crash_recover: true,
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;

    const stateResult = await getState.handler(
      { agent_id: agentId },
      {} as any,
    );
    const state =
      stateResult.structuredContent ?? JSON.parse(stateResult.content[0].text);

    expect(state.crash_recover).toBe(true);
  });

  it("spawn_agent defaults crash_recover to false", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const getState = (server as any)._registeredTools["get_agent_state"];

    const spawnResult = await spawn.handler(
      {
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "fix gap F",
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;

    const stateResult = await getState.handler(
      { agent_id: agentId },
      {} as any,
    );
    const state =
      stateResult.structuredContent ?? JSON.parse(stateResult.content[0].text);

    expect(state.crash_recover).toBe(false);
  });

  it("list_agents returns agents after spawn", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const list = (server as any)._registeredTools["list_agents"];

    await spawn.handler(
      {
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "task 1",
      },
      {} as any,
    );

    const result = await list.handler({}, {} as any);
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(1);
    expect(parsed.agents[0].repo).toBe("brainlayer");
    expect(parsed.agents[0].session_id).toBeNull();
    expect(parsed.agents[0].resume_command).toBeUndefined();
    expect(parsed.agents[0].surface_id).toBeUndefined();
  });

  it("list_agents includes resume_command when a session id is captured", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const list = (server as any)._registeredTools["list_agents"];
    const engine = (server as any)._registeredTools["interact"]._engine;

    const spawnResult = await spawn.handler(
      {
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "task 1",
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;
    const stateMgr = engine["stateMgr"];
    const updated = stateMgr.updateRecord(agentId, {
      cli_session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
    });
    engine.getRegistry().set(agentId, updated);

    const result = await list.handler({}, {} as any);
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.agents[0]).toMatchObject({
      session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
      resume_command:
        "brainlayerClaude -s --resume 019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
    });
  });

  it("get_agent_state returns full record", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const getState = (server as any)._registeredTools["get_agent_state"];

    const spawnResult = await spawn.handler(
      {
        repo: "golems",
        model: "codex",
        cli: "codex",
        prompt: "prune skills",
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;

    const result = await getState.handler({ agent_id: agentId }, {} as any);
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.agent_id).toBe(agentId);
    expect(parsed.cli).toBe("codex");
    expect(parsed.resume_command).toBeUndefined();
  });

  it("get_agent_state includes resume_command when a session id is captured", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const getState = (server as any)._registeredTools["get_agent_state"];
    const engine = (server as any)._registeredTools["interact"]._engine;

    const spawnResult = await spawn.handler(
      {
        repo: "golems",
        model: "codex",
        cli: "codex",
        prompt: "prune skills",
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;
    const stateMgr = engine["stateMgr"];
    const updated = stateMgr.updateRecord(agentId, {
      cli_session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
    });
    engine.getRegistry().set(agentId, updated);

    const result = await getState.handler({ agent_id: agentId }, {} as any);
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.resume_command).toBe(
      "golemsCodex --dangerously-bypass-approvals-and-sandbox resume 019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
    );
  });

  it("get_agent_state returns error for unknown agent", async () => {
    const server = createLifecycleServer(mockExec);
    const getState = (server as any)._registeredTools["get_agent_state"];

    const result = await getState.handler(
      { agent_id: "nonexistent" },
      {} as any,
    );
    expect(result.isError).toBe(true);
  });

  it("send_to_agent rejects agents not in interactive state", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const sendTo = (server as any)._registeredTools["send_to_agent"];

    const spawnResult = await spawn.handler(
      {
        repo: "test",
        model: "sonnet",
        cli: "claude",
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;

    // Agent is in "booting" state — not interactive
    const result = await sendTo.handler(
      { agent_id: agentId, text: "hello", press_enter: true },
      {} as any,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not in an interactive state/);
  });

  it("send_to with allow_busy=true delivers to agents in working state", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const sendTo = (server as any)._registeredTools["send_to"];

    const spawnResult = await spawn.handler(
      {
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "test",
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;

    const engine = (server as any)._registeredTools["interact"]._engine;
    const registry = engine.getRegistry();
    const agent = registry.get(agentId);
    registry.set(agentId, { ...agent, state: "working" });
    mockExec.mockClear();

    const result = await sendTo.handler(
      {
        agent_id: agentId,
        text: "interject while working",
        press_enter: true,
        allow_busy: true,
      },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    const sendCalls = mockExec.mock.calls.filter(
      ([, args]) => Array.isArray(args) && args.includes("send"),
    );
    const deliveredText = sendCalls.map(([, args]) => args.at(-1)).join("");

    expect(result.isError).toBeFalsy();
    expect(parsed.ok).toBe(true);
    expect(parsed.agent_id).toBe(agentId);
    expect(deliveredText).toBe("interject while working");
    expect(sendCalls[0]?.[1]).toEqual(
      expect.arrayContaining(["--workspace", "ws:1"]),
    );
  });

  it("send_to without allow_busy still rejects working agents (backwards compat)", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const sendTo = (server as any)._registeredTools["send_to"];

    const spawnResult = await spawn.handler(
      {
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "test",
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;

    const engine = (server as any)._registeredTools["interact"]._engine;
    const registry = engine.getRegistry();
    const agent = registry.get(agentId);
    registry.set(agentId, { ...agent, state: "working" });

    const result = await sendTo.handler(
      { agent_id: agentId, text: "hello", press_enter: true },
      {} as any,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not in an interactive state/);
  });

  it("send_to_agent with allow_busy=true delivers to agents in working state", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const sendTo = (server as any)._registeredTools["send_to_agent"];

    const spawnResult = await spawn.handler(
      {
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "test",
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;

    const engine = (server as any)._registeredTools["interact"]._engine;
    const registry = engine.getRegistry();
    const agent = registry.get(agentId);
    registry.set(agentId, { ...agent, state: "working" });
    mockExec.mockClear();

    const result = await sendTo.handler(
      {
        agent_id: agentId,
        text: "force deliver",
        press_enter: true,
        allow_busy: true,
      },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(result.isError).toBeFalsy();
    expect(parsed.ok).toBe(true);
    expect(parsed.agent_id).toBe(agentId);
  });

  it("send_to sanitizes and chunks delivery through the agent surface", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const sendTo = (server as any)._registeredTools["send_to"];

    const spawnResult = await spawn.handler(
      {
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "test",
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;

    const engine = (server as any)._registeredTools["interact"]._engine;
    const registry = engine.getRegistry();
    const agent = registry.get(agentId);
    registry.set(agentId, { ...agent, state: "ready" });
    mockExec.mockClear();

    const rawText = `${"a".repeat(510)}\x1b[31mHELLO\x1b[0m\x07${"b".repeat(10)}`;
    const sanitizedText = `${"a".repeat(510)}HELLO${"b".repeat(10)}`;

    const result = await sendTo.handler(
      { agent_id: agentId, text: rawText, press_enter: true },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    const setBufferCalls = mockExec.mock.calls.filter(
      ([, args]) => Array.isArray(args) && args.includes("set-buffer"),
    );
    const pasteBufferCalls = mockExec.mock.calls.filter(
      ([, args]) => Array.isArray(args) && args.includes("paste-buffer"),
    );
    const sendKeyCalls = mockExec.mock.calls.filter(
      ([, args]) => Array.isArray(args) && args.includes("send-key"),
    );
    const deliveredText = setBufferCalls
      .map(([, args]) => args.at(-1))
      .join("");

    expect(parsed.ok).toBe(true);
    expect(parsed.agent_id).toBe(agentId);
    expect(setBufferCalls).toHaveLength(2);
    expect(pasteBufferCalls).toHaveLength(2);
    expect(sendKeyCalls).toHaveLength(1);
    expect(deliveredText).toBe(sanitizedText);
    expect(deliveredText).not.toContain("\x1b");
    expect(deliveredText).not.toContain("\x07");
  });

  it("send_to submits chunked multiline text as one receiver message", async () => {
    const baseExec = makeLifecycleExec();
    const buffers = new Map<string, string>();
    let composer = "";
    let collectReceiverInput = false;
    const submittedMessages: string[] = [];
    const submitComposer = () => {
      submittedMessages.push(composer);
      composer = "";
    };
    const typeCmuxSendText = (text: string) => {
      for (const char of text) {
        if (char === "\n" || char === "\r") {
          submitComposer();
        } else {
          composer += char;
        }
      }
    };
    mockExec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
      if (!collectReceiverInput) {
        return baseExec(cmd, args);
      }
      if (args.includes("set-buffer")) {
        const nameIndex = args.indexOf("--name");
        const name = nameIndex >= 0 ? args[nameIndex + 1] : "default";
        buffers.set(name, args[args.length - 1]);
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("paste-buffer")) {
        const nameIndex = args.indexOf("--name");
        const name = nameIndex >= 0 ? args[nameIndex + 1] : "default";
        composer += buffers.get(name) ?? "";
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("send-key")) {
        const key = args[args.length - 1];
        if (key === "return" || key === "enter") {
          submitComposer();
        }
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("send")) {
        typeCmuxSendText(args[args.length - 1]);
        return { stdout: "{}", stderr: "" };
      }
      return baseExec(cmd, args);
    });

    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const sendTo = (server as any)._registeredTools["send_to"];

    const spawnResult = await spawn.handler(
      {
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "test",
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;

    const engine = (server as any)._registeredTools["interact"]._engine;
    const registry = engine.getRegistry();
    const agent = registry.get(agentId);
    registry.set(agentId, { ...agent, state: "ready" });
    collectReceiverInput = true;
    mockExec.mockClear();

    const longText = [
      "alpha ".repeat(24),
      "bravo ".repeat(24),
      "charlie ".repeat(24),
      "delta ".repeat(24),
      "echo ".repeat(24),
    ].join("\n");

    const result = await sendTo.handler(
      { agent_id: agentId, text: longText, press_enter: true },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(true);
    expect(submittedMessages).toEqual([longText]);
  });

  it("send_to returns an error for an unknown agent_id", async () => {
    const server = createLifecycleServer(mockExec);
    const sendTo = (server as any)._registeredTools["send_to"];

    const result = await sendTo.handler(
      { agent_id: "missing-agent", text: "hello facade", press_enter: true },
      {} as any,
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error).toMatch(/Agent not found/);
  });

  it("wait_for defaults to done when target_state is omitted", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const waitFor = (server as any)._registeredTools["wait_for"];

    const spawnResult = await spawn.handler(
      {
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;

    const engine = (server as any)._registeredTools["interact"]._engine;
    const stateMgr = engine["stateMgr"];

    if (stateMgr.readState(agentId)?.state === "booting") {
      stateMgr.transition(agentId, "ready");
    }
    stateMgr.transition(agentId, "done");
    const doneState = stateMgr.updateRecord(agentId, {
      task_done_detected_at: "2026-06-05T17:20:00.000Z",
    });
    if (!doneState) {
      throw new Error("Expected done state to exist");
    }
    engine.getRegistry().set(agentId, doneState);

    const result = await waitFor.handler(
      { agent_id: agentId, timeout_ms: 5000 },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(true);
    expect(parsed.agent_id).toBe(agentId);
    expect(parsed.state).toBe("done");
    expect(parsed.agent.session_id).toBeNull();
  }, 10_000);

  it("wait_for returns the engine snapshot without a second public-agent read", async () => {
    const server = createLifecycleServer(mockExec);
    const waitFor = (server as any)._registeredTools["wait_for"];
    const engine = (server as any)._registeredTools["interact"]._engine;

    vi.spyOn(engine, "waitFor").mockResolvedValue({
      matched: true,
      state: "done",
      elapsed: 12,
      source: "sweep",
      agent: {
        agent_id: "agent-1",
        repo: "brainlayer",
        model: "sonnet",
        state: "done",
        session_id: "sess-1",
      },
    } as any);
    const getPublicAgentSpy = vi
      .spyOn(engine, "getPublicAgent")
      .mockImplementation(() => {
        throw new Error("unexpected second public-agent read");
      });

    const result = await waitFor.handler(
      { agent_id: "agent-1", timeout_ms: 5000 },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(result.isError).not.toBe(true);
    expect(parsed.ok).toBe(true);
    expect(parsed.agent).toEqual({
      agent_id: "agent-1",
      repo: "brainlayer",
      model: "sonnet",
      state: "done",
      session_id: "sess-1",
    });
    expect(getPublicAgentSpy).not.toHaveBeenCalled();
  });

  it("wait_for returns an error for an unknown agent_id", async () => {
    const server = createLifecycleServer(mockExec);
    const waitFor = (server as any)._registeredTools["wait_for"];

    const result = await waitFor.handler(
      { agent_id: "missing-agent", timeout_ms: 5000 },
      {} as any,
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error).toMatch(/Agent not found/);
  });

  it("my_agents returns root agents when no parent_agent_id", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const myAgents = (server as any)._registeredTools["my_agents"];

    await spawn.handler(
      { repo: "voicelayer", model: "opus", cli: "claude", prompt: "fix tts" },
      {} as any,
    );
    await spawn.handler(
      {
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "opt search",
      },
      {} as any,
    );

    const result = await myAgents.handler({}, {} as any);
    const data = result.structuredContent;
    expect(data.count).toBe(2);
    expect(data.agents).toHaveLength(2);
    expect(data.agents[0].repo).toBeDefined();
    expect(data.agents[0].state).toBeDefined();
    expect(data.agents[0].task_summary).toBeDefined();
    expect(data.parent_agent_id).toBeNull();
  });

  it("my_agents returns children of a specific parent", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const myAgents = (server as any)._registeredTools["my_agents"];

    const parentResult = await spawn.handler(
      {
        repo: "orchestrator",
        model: "opus",
        cli: "claude",
        prompt: "orchestrate",
      },
      {} as any,
    );
    const parentId = parentResult.structuredContent.agent_id;

    await spawn.handler(
      {
        repo: "voicelayer",
        model: "sonnet",
        cli: "claude",
        prompt: "fix",
        parent_agent_id: parentId,
      },
      {} as any,
    );

    const result = await myAgents.handler(
      { parent_agent_id: parentId },
      {} as any,
    );
    const data = result.structuredContent;
    expect(data.count).toBe(1);
    expect(data.agents[0].repo).toBe("voicelayer");
    expect(data.parent_agent_id).toBe(parentId);
  });

  it("my_agents resolves finalized parents through their pending aliases", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const myAgents = (server as any)._registeredTools["my_agents"];
    const engine = (server as any)._registeredTools["interact"]._engine;

    const parentResult = await spawn.handler(
      {
        repo: "orchestrator",
        model: "opus",
        cli: "claude",
        prompt: "orchestrate",
      },
      {} as any,
    );
    const pendingParentId = parentResult.structuredContent.agent_id;
    const finalParentId = "orchestratorClaude-session1";
    const renamed = engine.stateMgr.renameState(pendingParentId, finalParentId);
    engine.getRegistry().rename(pendingParentId, finalParentId, renamed);

    await spawn.handler(
      {
        repo: "voicelayer",
        model: "sonnet",
        cli: "claude",
        prompt: "fix",
        parent_agent_id: pendingParentId,
      },
      {} as any,
    );

    const result = await myAgents.handler(
      { parent_agent_id: pendingParentId },
      {} as any,
    );
    const data = result.structuredContent;
    expect(data.count).toBe(1);
    expect(data.agents[0].repo).toBe("voicelayer");
    expect(data.parent_agent_id).toBe(pendingParentId);
  });

  it("my_agents returns empty array for nonexistent parent (orphan-safe)", async () => {
    const server = createLifecycleServer(mockExec);
    const myAgents = (server as any)._registeredTools["my_agents"];

    const result = await myAgents.handler(
      { parent_agent_id: "nonexistent-id" },
      {} as any,
    );
    const data = result.structuredContent;
    expect(data.count).toBe(0);
    expect(data.agents).toHaveLength(0);
  });

  it("my_agents includes screen data fields (null when no real screen)", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const myAgents = (server as any)._registeredTools["my_agents"];

    await spawn.handler(
      { repo: "golems", model: "opus", cli: "claude", prompt: "audit" },
      {} as any,
    );

    const result = await myAgents.handler({}, {} as any);
    const agent = result.structuredContent.agents[0];
    expect(agent).toHaveProperty("token_count");
    expect(agent).toHaveProperty("context_pct");
    expect(agent).toHaveProperty("cost");
    expect(agent).toHaveProperty("spawn_depth");
    expect(agent).toHaveProperty("created_at");
    expect(agent).toHaveProperty("quality");
  });

  it("my_agents includes resume_command when a session id is captured", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const myAgents = (server as any)._registeredTools["my_agents"];
    const engine = (server as any)._registeredTools["interact"]._engine;

    const spawnResult = await spawn.handler(
      { repo: "voicelayer", model: "opus", cli: "claude", prompt: "fix tts" },
      {} as any,
    );
    const agentId = spawnResult.structuredContent.agent_id;
    const stateMgr = engine["stateMgr"];
    const updated = stateMgr.updateRecord(agentId, {
      cli_session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
    });
    engine.getRegistry().set(agentId, updated);

    const result = await myAgents.handler({}, {} as any);
    const agent = result.structuredContent.agents[0];

    expect(agent).toMatchObject({
      session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
      resume_command:
        "voicelayerClaude -s --resume 019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
    });
  });
});

describe("auto-focus discipline (focus target before split, restore after render)", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // Builds an exec mock that records every call, reports `selectedWorkspace` as
  // the focused one, and returns a non-ready screen for the first `notReadyFor`
  // read-screen polls before reporting ready.
  function makeFocusExec(opts: {
    selectedWorkspace: string;
    notReadyFor?: number;
  }): { exec: ExecFn; calls: string[][]; readScreenCount: () => number } {
    const calls: string[][] = [];
    let readScreens = 0;
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      calls.push(args);
      if (args.includes("list-workspaces")) {
        return {
          stdout: JSON.stringify({
            workspaces: [
              {
                ref: "workspace:1",
                title: "One",
                index: 0,
                selected: opts.selectedWorkspace === "workspace:1",
                pinned: false,
              },
              {
                ref: "workspace:2",
                title: "Two",
                index: 1,
                selected: opts.selectedWorkspace === "workspace:2",
                pinned: false,
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args.includes("read-screen")) {
        readScreens++;
        const notReady = (opts.notReadyFor ?? 0) >= readScreens;
        return {
          stdout: JSON.stringify({
            surface: "surface:new",
            text: notReady
              ? "still booting up please wait"
              : "What can I help you with?\n>",
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      // Default: split/surface creation result.
      return {
        stdout: JSON.stringify({
          workspace: "workspace:2",
          surface: "surface:new",
          pane: "pane:1",
          title: "",
          type: "terminal",
        }),
        stderr: "",
      };
    }) as unknown as ExecFn;
    return { exec, calls, readScreenCount: () => readScreens };
  }

  const selectIdx = (calls: string[][], ws: string) =>
    calls.findIndex((a) => a.includes("select-workspace") && a.includes(ws));
  const firstReadScreenIdx = (calls: string[][]) =>
    calls.findIndex((a) => a.includes("read-screen"));
  const lastReadScreenIdx = (calls: string[][]) =>
    calls.reduce((last, a, i) => (a.includes("read-screen") ? i : last), -1);

  it("new_split focuses the target workspace before the split and restores prior focus after readiness when a jump is needed", async () => {
    const { exec, calls } = makeFocusExec({ selectedWorkspace: "workspace:1" });
    const server = createLifecycleServer(exec);
    const tool = (server as any)._registeredTools["new_split"];

    const result = await tool.handler(
      { direction: "right", workspace: "workspace:2", type: "terminal" },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.surface).toBe("surface:new");

    const focusTarget = selectIdx(calls, "workspace:2");
    const restorePrior = selectIdx(calls, "workspace:1");
    const readScreen = firstReadScreenIdx(calls);

    // Target was focused BEFORE the prior focus was restored.
    expect(focusTarget).toBeGreaterThanOrEqual(0);
    expect(restorePrior).toBeGreaterThan(focusTarget);
    // Readiness was awaited between the split and the focus-back.
    expect(readScreen).toBeGreaterThan(focusTarget);
    expect(readScreen).toBeLessThan(restorePrior);
  });

  it("new_split does NOT touch focus when the target is already the focused workspace", async () => {
    const { exec, calls } = makeFocusExec({ selectedWorkspace: "workspace:2" });
    const server = createLifecycleServer(exec);
    const tool = (server as any)._registeredTools["new_split"];

    await tool.handler(
      { direction: "right", workspace: "workspace:2", type: "terminal" },
      {} as any,
    );

    const selectCalls = calls.filter((a) => a.includes("select-workspace"));
    expect(selectCalls).toHaveLength(0);
  });

  it("new_split waits for the new terminal to render before restoring focus", async () => {
    const { exec, calls, readScreenCount } = makeFocusExec({
      selectedWorkspace: "workspace:1",
      notReadyFor: 2,
    });
    const server = createLifecycleServer(exec);
    const tool = (server as any)._registeredTools["new_split"];

    await tool.handler(
      { direction: "right", workspace: "workspace:2", type: "terminal" },
      {} as any,
    );

    // Polled until ready (2 not-ready + 1 ready) and only then restored focus.
    expect(readScreenCount()).toBeGreaterThanOrEqual(3);
    const restorePrior = selectIdx(calls, "workspace:1");
    expect(restorePrior).toBeGreaterThan(lastReadScreenIdx(calls));
  });
});
