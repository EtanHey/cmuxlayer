/**
 * T2b — silent failure with a success receipt.
 *
 * Two live-reproduced defects, both the same disease: a tool returns ok:true
 * for an action it did not perform, or performed only half of.
 *
 * - #484 send_to(mode:"key") returns ok:true with submit_attempted:false and no
 *   evidence that anything reached the pane. The documented type -> Return
 *   recovery therefore reports success for a no-op and the message is lost.
 * - #485 close_surface(scope:"agent") delegates to stop_agent and returns
 *   ok:true state:"done" while the pane stays open.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../src/server.js";
import type { ExecFn } from "../src/cmux-client.js";
import type { AgentRecord } from "../src/agent-types.js";

type ToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: Array<{ text: string }>;
};

function payload(result: ToolResult): Record<string, unknown> {
  return (
    result.structuredContent ??
    (JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>)
  );
}

function tool(server: unknown, name: string) {
  const registered = (
    server as { _registeredTools: Record<string, { handler: Function }> }
  )._registeredTools[name];
  if (!registered) throw new Error(`Tool not found: ${name}`);
  return registered;
}

const SURFACE = "surface:89";

/**
 * Minimal cmux CLI mock. `screen` is a live box so a test can change what the
 * pane shows after the key is dispatched, which is the whole point of a
 * submit-verification test.
 */
function makeExec(opts?: {
  screen?: () => string;
  onSendKey?: (key: string) => void;
  closeSurfaceFails?: boolean;
  surfaceRef?: string;
}): ExecFn & { calls: string[][] } {
  const surfaceRef = opts?.surfaceRef ?? SURFACE;
  const calls: string[][] = [];
  const exec = vi.fn().mockImplementation(async (_cmd, args: string[]) => {
    calls.push(args);
    if (args.includes("list-workspaces")) {
      return {
        stdout: JSON.stringify({
          workspaces: [
            {
              ref: "workspace:1",
              title: "Fleet",
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
          panes: [{ ref: "pane:1", workspace: "workspace:1", focused: true }],
        }),
        stderr: "",
      };
    }
    if (args.includes("list-pane-surfaces")) {
      return {
        stdout: JSON.stringify({
          pane: "pane:1",
          surfaces: [
            {
              ref: surfaceRef,
              pane: "pane:1",
              workspace: "workspace:1",
              title: "golemsClaude",
              type: "terminal",
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
          surface: surfaceRef,
          text: opts?.screen?.() ?? "$ ",
          lines: 30,
          scrollback_used: false,
        }),
        stderr: "",
      };
    }
    if (args.includes("send-key")) {
      opts?.onSendKey?.(String(args[args.length - 1] ?? ""));
      return { stdout: "{}", stderr: "" };
    }
    if (args.includes("close-surface") && opts?.closeSurfaceFails) {
      throw new Error("cmux close-surface: pane is not closable");
    }
    return { stdout: "{}", stderr: "" };
  }) as ExecFn & { calls: string[][] };
  (exec as unknown as { calls: string[][] }).calls = calls;
  return exec;
}

const IDLE_CLAUDE_SCREEN = "Claude Code\nWhat can I help you with?\n> ";
const POPULATED_CLAUDE_SCREEN =
  "Claude Code\nWhat can I help you with?\n> lead: please pick up lane T4";
const WORKING_CLAUDE_SCREEN = "Claude Code\n✻ Working (3s · esc to interrupt)";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "cmux-t2b-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function makeServer(exec: ExecFn) {
  return createServer({
    exec,
    stateDir,
    disableSpawnPreflight: true,
    controlHealthIntervalMs: 0,
    sessionIdentityResolver: () => null,
  }) as unknown;
}

describe("#484 — send_to(mode:key) must not report success for an unattempted submit", () => {
  it.each(["return", "Return", "enter", "Enter", "KPEnter", "\r"])(
    "recognises %j as a submit key so the receipt cannot claim submit_attempted:false",
    async (key) => {
      const exec = makeExec({ screen: () => WORKING_CLAUDE_SCREEN });
      const server = makeServer(exec);

      const result = (await tool(server, "send_to").handler(
        { mode: "key", target: SURFACE, key },
        {},
      )) as ToolResult;

      const data = payload(result);
      expect(result.isError).toBeUndefined();
      expect(data.submit_attempted).toBe(true);
    },
  );

  it("reports the key actually reached the pane instead of an evidence-free ok:true", async () => {
    const exec = makeExec({ screen: () => WORKING_CLAUDE_SCREEN });
    const server = makeServer(exec);

    const result = (await tool(server, "send_to").handler(
      { mode: "key", target: SURFACE, key: "return" },
      {},
    )) as ToolResult;

    const data = payload(result);
    expect(result.isError).toBeUndefined();
    expect(data.key_dispatched).toBe(true);
  });

  it("verifies the submit landed when the composer clears", async () => {
    let pressed = false;
    const exec = makeExec({
      screen: () => (pressed ? WORKING_CLAUDE_SCREEN : POPULATED_CLAUDE_SCREEN),
      onSendKey: () => {
        pressed = true;
      },
    });
    const server = makeServer(exec);

    const result = (await tool(server, "send_to").handler(
      { mode: "key", target: SURFACE, key: "return" },
      {},
    )) as ToolResult;

    const data = payload(result);
    expect(result.isError).toBeUndefined();
    expect(data.submit_verified).toBe(true);
  });

  it("fails instead of returning ok:true when the composer still holds the unsent text", async () => {
    // The exact #484 shape: a lead typed a message, it sat unsent, and the
    // documented mode:"key" recovery reported success while the pane never moved.
    const exec = makeExec({ screen: () => POPULATED_CLAUDE_SCREEN });
    const server = makeServer(exec);

    const result = (await tool(server, "send_to").handler(
      { mode: "key", target: SURFACE, key: "return" },
      {},
    )) as ToolResult;

    const data = payload(result);
    expect(result.isError).toBe(true);
    expect(data.ok).toBe(false);
    expect(data.submit_verified).toBe(false);
    expect(data.submit_verification_reason).toBe("composer_still_populated");
  });

  it("leaves non-submit keys unverified but still states that they were dispatched", async () => {
    const exec = makeExec({ screen: () => POPULATED_CLAUDE_SCREEN });
    const server = makeServer(exec);

    const result = (await tool(server, "send_to").handler(
      { mode: "key", target: SURFACE, key: "escape" },
      {},
    )) as ToolResult;

    const data = payload(result);
    expect(result.isError).toBeUndefined();
    expect(data.submit_attempted).toBe(false);
    expect(data.key_dispatched).toBe(true);
    expect(data.submit_verified).toBeNull();
  });
});

function seedAgent(server: unknown, overrides: Partial<AgentRecord> = {}) {
  const engine = (
    server as { _registeredTools: Record<string, { _engine?: any }> }
  )._registeredTools.interact?._engine;
  if (!engine) throw new Error("Lifecycle engine not registered");
  const record: AgentRecord = {
    agent_id: "golemsClaude-bcc283d3",
    surface_id: SURFACE,
    workspace_id: "workspace:1",
    state: "done",
    repo: "golems",
    model: "claude-opus-5",
    cli: "claude",
    cli_session_id: null,
    cli_session_path: null,
    task_summary: "lane worker",
    pid: null,
    version: 1,
    created_at: "2026-08-19T07:00:00.000Z",
    updated_at: "2026-08-19T07:00:00.000Z",
    error: null,
    parent_agent_id: null,
    spawn_depth: 0,
    role: "worker",
    auto_archive_on_done: false,
    task_done_candidate_at: null,
    task_done_detected_at: "2026-08-19T07:00:00.000Z",
    deletion_intent: false,
    quality: "unknown",
    max_cost_per_agent: null,
    crash_recover: false,
    respawn_attempts: 0,
    user_killed: false,
    boot_prompt_pending: false,
    goal_file: null,
    launch_cwd: null,
    mcp_profile: null,
    worktree_path: null,
    worktree_branch: null,
    ...overrides,
  };
  engine.stateMgr.writeState(record);
  engine.getRegistry().set(record.agent_id, record);
  return record;
}

describe("#485 — close_surface(scope:agent) must close the surface or say it did not", () => {
  it("actually closes the pane instead of only stopping the agent", async () => {
    const exec = makeExec({ screen: () => IDLE_CLAUDE_SCREEN });
    const server = makeServer(exec);
    const record = seedAgent(server);

    const result = (await tool(server, "close_surface").handler(
      { scope: "agent", agent_id: record.agent_id },
      {},
    )) as ToolResult;

    const data = payload(result);
    expect(result.isError).toBeUndefined();
    expect(data.surface_closed).toBe(true);
    expect(data.surface).toBe(SURFACE);
    expect(
      exec.calls.some((args) => args.includes("close-surface")),
    ).toBe(true);
  });

  it("refuses to report success when the agent stopped but the pane survived", async () => {
    const exec = makeExec({
      screen: () => IDLE_CLAUDE_SCREEN,
      closeSurfaceFails: true,
    });
    const server = makeServer(exec);
    const record = seedAgent(server);

    const result = (await tool(server, "close_surface").handler(
      { scope: "agent", agent_id: record.agent_id },
      {},
    )) as ToolResult;

    const data = payload(result);
    expect(result.isError).toBe(true);
    expect(data.ok).toBe(false);
    expect(data.agent_stopped).toBe(true);
    expect(data.surface_closed).toBe(false);
    expect(String(data.error)).toMatch(/surface/i);
  });

  it("cross-checks scope=workspace: the delegate really deletes, and says so", async () => {
    const exec = makeExec({ screen: () => IDLE_CLAUDE_SCREEN });
    const server = makeServer(exec);

    const result = (await tool(server, "close_surface").handler(
      { scope: "workspace", workspace: "workspace:1", force: true },
      {},
    )) as ToolResult;

    const data = payload(result);
    expect(result.isError).toBeUndefined();
    expect(data.workspace_deleted).toBe(true);
    expect(
      exec.calls.some(
        (args) => args.includes("workspace") && args.includes("close"),
      ),
    ).toBe(true);
  });

  it("states plainly that there was no surface to close rather than implying one closed", async () => {
    const exec = makeExec({ screen: () => IDLE_CLAUDE_SCREEN });
    const server = makeServer(exec);
    const record = seedAgent(server, {
      agent_id: "golemsClaude-c7738dab",
      surface_id: "",
    });

    const result = (await tool(server, "close_surface").handler(
      { scope: "agent", agent_id: record.agent_id },
      {},
    )) as ToolResult;

    const data = payload(result);
    expect(result.isError).toBeUndefined();
    expect(data.surface_closed).toBe(false);
    expect(data.surface_close_skipped).toBe("no_surface_bound");
  });
});
