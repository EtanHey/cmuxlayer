import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentRecord } from "../src/agent-types.js";

const TEST_DIR = join(tmpdir(), "cmux-submit-verify-timeout-env-test");
const ENV_KEY = "CMUXLAYER_SUBMIT_VERIFY_TIMEOUT_MS";

class StuckAgentClient {
  readonly workspace = "workspace:1";
  readonly pane = "pane:1";
  readonly surface = "surface:agent";
  readonly title = "brainlayerClaude";
  private pendingText = "";

  async listWorkspaces() {
    return {
      workspaces: [
        {
          ref: this.workspace,
          title: "Main",
          index: 0,
          selected: true,
          pinned: false,
        },
      ],
    };
  }

  async listPanes() {
    return {
      workspace_ref: this.workspace,
      window_ref: "window:1",
      panes: [
        {
          ref: this.pane,
          index: 0,
          focused: true,
          surface_count: 1,
          surface_refs: [this.surface],
          selected_surface_ref: this.surface,
        },
      ],
    };
  }

  async listPaneSurfaces() {
    return {
      workspace_ref: this.workspace,
      window_ref: "window:1",
      pane_ref: this.pane,
      surfaces: [
        {
          ref: this.surface,
          title: this.title,
          type: "terminal",
          index: 0,
          selected: true,
        },
      ],
    };
  }

  async send(surface: string, text: string) {
    if (surface !== this.surface) {
      throw new Error(`Unknown surface: ${surface}`);
    }
    this.pendingText += text;
  }

  async pasteText(surface: string, text: string) {
    await this.send(surface, text);
  }

  async sendKey(surface: string, _key: string) {
    if (surface !== this.surface) {
      throw new Error(`Unknown surface: ${surface}`);
    }
  }

  async readScreen(surface: string, opts?: { lines?: number }) {
    if (surface !== this.surface) {
      throw new Error(`Unknown surface: ${surface}`);
    }
    return {
      surface,
      text: `Claude Code\n> ${this.pendingText.slice(-160)}\nCLAUDE_COUNTER:1\n`,
      lines: opts?.lines ?? 30,
      scrollback_used: false,
    };
  }
}

function parseResult(result: any): any {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

function registerReadyAgent(server: any, client: StuckAgentClient): void {
  const engine = server._registeredTools["interact"]._engine;
  const stateMgr = engine["stateMgr"];
  const registry = engine.getRegistry();
  const now = "2026-07-01T00:00:00Z";
  const record: AgentRecord = {
    agent_id: "agent-1",
    surface_id: client.surface,
    workspace_id: client.workspace,
    state: "ready",
    repo: "brainlayer",
    model: "sonnet",
    cli: "claude",
    cli_session_id: null,
    task_summary: "submit timeout env test",
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

  stateMgr.writeState(record);
  registry.set(record.agent_id, record);
}

function disposeServer(server: any) {
  const engine = server?._registeredTools?.interact?._engine;
  if (engine && typeof engine.dispose === "function") {
    engine.dispose();
  }
}

async function runSubmitFailureWithEnv(value: string): Promise<any> {
  const previous = process.env[ENV_KEY];
  process.env[ENV_KEY] = value;
  vi.resetModules();
  const { createServer } = await import("../src/server.js");
  const client = new StuckAgentClient();
  const server = createServer({
    client: client as any,
    stateDir: TEST_DIR,
    disableSpawnPreflight: true,
  });
  registerReadyAgent(server, client);
  const tool = (server as any)._registeredTools["send_command"];

  const resultPromise = tool.handler(
    { surface: client.surface, command: "ping" },
    {} as any,
  );
  await vi.advanceTimersByTimeAsync(2500);
  const result = await resultPromise;
  disposeServer(server);

  if (previous === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = previous;
  }

  return parseResult(result);
}

describe("submit verification timeout env", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("reads a positive CMUXLAYER_SUBMIT_VERIFY_TIMEOUT_MS override once at module load", async () => {
    vi.useFakeTimers();
    mkdirSync(TEST_DIR, { recursive: true });

    const parsed = await runSubmitFailureWithEnv("25");

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("within 25ms");
  });

  it("falls back to 2000ms for an invalid CMUXLAYER_SUBMIT_VERIFY_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    mkdirSync(TEST_DIR, { recursive: true });

    const parsed = await runSubmitFailureWithEnv("not-a-number");

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("within 2000ms");
  });
});
