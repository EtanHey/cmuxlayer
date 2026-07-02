import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/server.js";
import type { AgentRecord } from "../src/agent-types.js";

const TEST_DIR = join(tmpdir(), "cmux-enter-reliability-test");

function parseResult(result: any): any {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

async function callTool(
  server: any,
  name: string,
  args: Record<string, unknown>,
) {
  const tool = server._registeredTools[name];
  if (!tool) {
    throw new Error(`Tool not found: ${name}`);
  }
  return tool.handler(args, {} as any);
}

function readEventLog(): Array<Record<string, unknown>> {
  const filePath = join(TEST_DIR, "events.jsonl");
  if (!existsSync(filePath)) {
    return [];
  }

  const raw = readFileSync(filePath, "utf-8").trim();
  if (!raw) {
    return [];
  }

  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

class FakeClaudeSurfaceClient {
  readonly workspace = "workspace:1";
  readonly pane = "pane:1";
  readonly surface = "surface:agent";
  readonly title = "brainlayerClaude";
  readonly sendCalls: string[] = [];
  readonly sendKeyCalls: string[] = [];
  readonly renameTabCalls: string[] = [];
  requiredReturns = 2;
  completionMode: "idle" | "working" = "working";
  private pendingText = "";
  private returnCount = 0;
  private mode: "idle" | "working" = "idle";

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

    if (!this.pendingText) {
      this.returnCount = 0;
      this.mode = "idle";
    }

    this.sendCalls.push(text);
    this.pendingText += text;
  }

  async pasteText(surface: string, text: string) {
    await this.send(surface, text);
  }

  async sendKey(surface: string, key: string) {
    if (surface !== this.surface) {
      throw new Error(`Unknown surface: ${surface}`);
    }

    this.sendKeyCalls.push(key);
    if (key !== "return") {
      return;
    }

    if (!this.pendingText) {
      return;
    }

    this.returnCount += 1;
    if (this.returnCount >= this.requiredReturns) {
      this.pendingText = "";
      this.mode = this.completionMode;
      return;
    }

    this.mode = "idle";
  }

  async readScreen(surface: string, opts?: { lines?: number }) {
    if (surface !== this.surface) {
      throw new Error(`Unknown surface: ${surface}`);
    }

    return {
      surface,
      text: this.renderScreen(),
      lines: opts?.lines ?? 30,
      scrollback_used: false,
    };
  }

  async renameTab(_surface: string, title: string) {
    this.renameTabCalls.push(title);
  }

  private renderScreen(): string {
    if (this.mode === "working") {
      return "Claude Code\n✻ Working\n";
    }

    const tail = this.pendingText.slice(-160);
    return `Claude Code\n> ${tail}\nCLAUDE_COUNTER:1\n`;
  }
}

class FakeShellSurfaceClient {
  readonly workspace = "workspace:1";
  readonly pane = "pane:1";
  readonly surface = "surface:shell";
  readonly title = "zsh";
  readonly sendCalls: string[] = [];
  readonly sendKeyCalls: string[] = [];
  readonly renameTabCalls: string[] = [];
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

    this.sendCalls.push(text);
    this.pendingText += text;
  }

  async pasteText(surface: string, text: string) {
    await this.send(surface, text);
  }

  async sendKey(surface: string, key: string) {
    if (surface !== this.surface) {
      throw new Error(`Unknown surface: ${surface}`);
    }

    this.sendKeyCalls.push(key);
    if (key === "return") {
      this.pendingText = "";
    }
  }

  async readScreen(surface: string, opts?: { lines?: number }) {
    if (surface !== this.surface) {
      throw new Error(`Unknown surface: ${surface}`);
    }

    const prompt = this.pendingText ? `$ ${this.pendingText}` : "$";
    return {
      surface,
      text: `${prompt}\n`,
      lines: opts?.lines ?? 30,
      scrollback_used: false,
    };
  }

  async renameTab(_surface: string, title: string) {
    this.renameTabCalls.push(title);
  }
}

function createReliabilityServer(client: FakeClaudeSurfaceClient) {
  return createServer({
    client: client as any,
    stateDir: TEST_DIR,
    disableSpawnPreflight: true,
  });
}

function registerAgent(server: any, overrides?: Partial<AgentRecord>): AgentRecord {
  const engine = server._registeredTools["interact"]._engine;
  const stateMgr = engine["stateMgr"];
  const registry = engine.getRegistry();

  const now = "2026-04-24T12:00:00Z";
  const record: AgentRecord = {
    agent_id: "agent-1",
    surface_id: "surface:agent",
    workspace_id: "workspace:1",
    state: "ready",
    repo: "brainlayer",
    model: "sonnet",
    cli: "claude",
    cli_session_id: null,
    task_summary: "enter reliability test",
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
    ...overrides,
  };

  stateMgr.writeState(record);
  registry.set(record.agent_id, record);
  return record;
}

function disposeServer(server: any) {
  const engine = server?._registeredTools?.interact?._engine;
  if (engine && typeof engine.dispose === "function") {
    engine.dispose();
  }
}

describe("enter reliability", () => {
  let server: any;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    server = null;
  });

  afterEach(() => {
    disposeServer(server);
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("rejects string booleans on raw send_to handler calls", async () => {
    const client = new FakeClaudeSurfaceClient();
    server = createReliabilityServer(client);
    registerAgent(server);

    const result = await callTool(server, "send_to", {
      agent_id: "agent-1",
      text: "wake up",
      press_enter: "true",
      allow_busy: "false",
    });
    const parsed = parseResult(result);

    expect(result.isError).toBe(true);
    expect(parsed.error).toMatch(/press_enter|allow_busy|boolean/i);
  });

  it("retries Enter for send_to when the first submit leaves Claude idle", async () => {
    const client = new FakeClaudeSurfaceClient();
    server = createReliabilityServer(client);
    registerAgent(server);

    const result = await callTool(server, "send_to", {
      agent_id: "agent-1",
      text: "x".repeat(2000),
      press_enter: true,
      allow_long_inline: true,
    });
    const parsed = parseResult(result);
    const events = readEventLog();

    expect(parsed.ok).toBe(true);
    expect(client.sendCalls.join("")).toHaveLength(2000);
    expect(client.sendKeyCalls.filter((key) => key === "return")).toHaveLength(
      2,
    );
    expect(
      events.some(
        (event) =>
          event.event_type === "send_to" &&
          event.submit_verified === true &&
          event.retry_count === 1,
      ),
    ).toBe(true);
    expect(
      events.some((event) => event.event_type === "press_enter"),
    ).toBe(true);
  });

  it("verifies short send_to submissions once the input clears", async () => {
    const client = new FakeClaudeSurfaceClient();
    client.requiredReturns = 1;
    client.completionMode = "idle";
    server = createReliabilityServer(client);
    registerAgent(server);

    const result = await callTool(server, "send_to", {
      agent_id: "agent-1",
      text: "ping",
      press_enter: true,
    });
    const parsed = parseResult(result);
    const events = readEventLog().filter((event) => event.event_type === "send_to");

    expect(parsed.ok).toBe(true);
    expect(client.sendKeyCalls.filter((key) => key === "return")).toHaveLength(1);
    expect(events).toHaveLength(1);
    // A short relay is now verified: the input cleared from the prompt, so the
    // submit landed even though Claude settled straight back to idle.
    expect(events[0]?.submit_verified).toBe(true);
    expect(events[0]?.retry_count).toBe(0);
  });

  it("retries Enter for send_command on a Claude surface", async () => {
    const client = new FakeClaudeSurfaceClient();
    server = createReliabilityServer(client);
    registerAgent(server);

    const result = await callTool(server, "send_command", {
      surface: client.surface,
      command: "y".repeat(2000),
      allow_long_inline: true,
    });
    const parsed = parseResult(result);
    const events = readEventLog();

    expect(parsed.ok).toBe(true);
    expect(client.sendKeyCalls.filter((key) => key === "return")).toHaveLength(
      2,
    );
    expect(
      events.some(
        (event) =>
          event.event_type === "send_command" &&
          event.submit_verified === true &&
          event.retry_count === 1,
      ),
    ).toBe(true);
  });

  it("reports a failed short send_command submit after retry leaves Claude idle", async () => {
    const client = new FakeClaudeSurfaceClient();
    client.requiredReturns = 99;
    server = createReliabilityServer(client);
    registerAgent(server);

    const result = await callTool(server, "send_command", {
      surface: client.surface,
      command: "ping",
    });
    const parsed = parseResult(result);
    const events = readEventLog();

    expect(result.isError).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.submit_verified).toBe(false);
    expect(parsed.retry_count).toBe(1);
    expect(client.sendKeyCalls.filter((key) => key === "return")).toHaveLength(
      2,
    );
    expect(
      events.some(
        (event) =>
          event.event_type === "send_command" &&
          event.submit_verified === false &&
          event.retry_count === 1,
      ),
    ).toBe(true);
  });

  it("reports a failed short send_input submit after retry leaves Claude idle", async () => {
    const client = new FakeClaudeSurfaceClient();
    client.requiredReturns = 99;
    server = createReliabilityServer(client);
    registerAgent(server);

    const result = await callTool(server, "send_input", {
      surface: client.surface,
      text: "ping",
      press_enter: true,
    });
    const parsed = parseResult(result);
    const events = readEventLog();

    expect(result.isError).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.submit_verified).toBe(false);
    expect(parsed.retry_count).toBe(1);
    expect(client.sendKeyCalls.filter((key) => key === "return")).toHaveLength(
      2,
    );
    expect(
      events.some(
        (event) =>
          event.event_type === "send_input" &&
          event.submit_verified === false &&
          event.retry_count === 1,
      ),
    ).toBe(true);
  });

  it("does not false-fail send_input to a busy cached agent surface", async () => {
    const client = new FakeClaudeSurfaceClient();
    client.requiredReturns = 99;
    server = createReliabilityServer(client);
    registerAgent(server, { state: "working" });

    const result = await callTool(server, "send_input", {
      surface: client.surface,
      text: "interrupt",
      press_enter: true,
    });
    const parsed = parseResult(result);
    const events = readEventLog().filter(
      (event) => event.event_type === "send_input",
    );

    expect(parsed.ok).toBe(true);
    expect(parsed.submit_verified).toBeNull();
    expect(parsed.retry_count).toBe(0);
    expect(client.sendKeyCalls.filter((key) => key === "return")).toHaveLength(
      1,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.submit_verified).toBeNull();
  });

  it("verifies send_input to an uncached shell when the prompt clears", async () => {
    const client = new FakeShellSurfaceClient();
    server = createReliabilityServer(client as any);

    const result = await callTool(server, "send_input", {
      surface: client.surface,
      text: "printf ok",
      press_enter: true,
    });
    const parsed = parseResult(result);
    const events = readEventLog().filter(
      (event) => event.event_type === "send_input",
    );

    expect(parsed.ok).toBe(true);
    expect(parsed.submit_verified).toBe(true);
    expect(parsed.retry_count).toBe(0);
    expect(client.sendKeyCalls.filter((key) => key === "return")).toHaveLength(
      1,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.submit_verified).toBe(true);
  });

  it("uses the verified send path for interact(action=send)", async () => {
    const client = new FakeClaudeSurfaceClient();
    server = createReliabilityServer(client);
    registerAgent(server);

    const result = await callTool(server, "interact", {
      agent: "agent-1",
      action: "send",
      text: "z".repeat(2000),
    });
    const parsed = parseResult(result);
    const events = readEventLog();

    expect(parsed.ok).toBe(true);
    expect(client.sendKeyCalls.filter((key) => key === "return")).toHaveLength(
      2,
    );
    expect(
      events.some(
        (event) =>
          event.event_type === "interact" &&
          event.submit_verified === true &&
          event.retry_count === 1,
      ),
    ).toBe(true);
  });

  it("verifies each back-to-back send_to instead of assuming the previous submit pattern holds", async () => {
    const client = new FakeClaudeSurfaceClient();
    server = createReliabilityServer(client);
    registerAgent(server);

    await callTool(server, "send_to", {
      agent_id: "agent-1",
      text: "first\n".repeat(300),
      press_enter: true,
      allow_long_inline: true,
    });
    await callTool(server, "send_to", {
      agent_id: "agent-1",
      text: "second\n".repeat(300),
      press_enter: true,
      allow_long_inline: true,
    });

    const events = readEventLog().filter(
      (event) => event.event_type === "send_to",
    );
    expect(client.sendKeyCalls.filter((key) => key === "return")).toHaveLength(
      4,
    );
    expect(events).toHaveLength(2);
    expect(
      events.every(
        (event) =>
          event.submit_verified === true && event.retry_count === 1,
      ),
    ).toBe(true);
  });

  it("records UTF-8 byte counts in delivery telemetry", async () => {
    const client = new FakeClaudeSurfaceClient();
    client.requiredReturns = 1;
    server = createReliabilityServer(client);

    const command = "🙂".repeat(200);
    const result = await callTool(server, "send_command", {
      surface: client.surface,
      command,
    });
    const parsed = parseResult(result);
    const event = readEventLog().find(
      (entry) => entry.event_type === "send_command",
    );

    expect(parsed.ok).toBe(true);
    expect(event?.bytes).toBe(Buffer.byteLength(command, "utf-8"));
  });
});
