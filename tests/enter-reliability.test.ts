import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/server.js";
import type { AgentRecord } from "../src/agent-types.js";

const TEST_DIR = join(tmpdir(), "cmux-enter-reliability-test");
const TEST_OBSERVER_OWNER = "cmux:/tmp/cmux-enter-reliability-test.sock";

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
  const resultPromise = tool.handler(args, {} as any);
  await vi.advanceTimersByTimeAsync(10_000);
  return resultPromise;
}

async function callToolInTimerSteps(
  server: any,
  name: string,
  args: Record<string, unknown>,
) {
  const tool = server._registeredTools[name];
  if (!tool) {
    throw new Error(`Tool not found: ${name}`);
  }
  const resultPromise = tool.handler(args, {} as any);
  for (let elapsed = 0; elapsed < 10_000; elapsed += 100) {
    await vi.advanceTimersByTimeAsync(100);
  }
  return resultPromise;
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
  readonly screenReads: string[] = [];
  readonly renameTabCalls: string[] = [];
  requiredReturns = 2;
  completionMode: "idle" | "working" = "working";
  cli: "claude" | "codex" = "claude";
  keepWorkingStatusWhilePending = false;
  queuedCodexReadsAfterReturn = 0;
  failScreenReadsAfterReturn = false;
  private pendingText = "";
  private returnCount = 0;
  private queuedCodexReadsRemaining = 0;
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

    this.queuedCodexReadsRemaining = this.queuedCodexReadsAfterReturn;
    this.mode = this.keepWorkingStatusWhilePending ? "working" : "idle";
  }

  async readScreen(surface: string, opts?: { lines?: number }) {
    if (surface !== this.surface) {
      throw new Error(`Unknown surface: ${surface}`);
    }
    if (this.failScreenReadsAfterReturn && this.returnCount > 0) {
      throw new Error("screen temporarily unavailable");
    }

    const text = this.renderScreen();
    this.screenReads.push(text);
    return {
      surface,
      text,
      lines: opts?.lines ?? 30,
      scrollback_used: false,
    };
  }

  async renameTab(_surface: string, title: string) {
    this.renameTabCalls.push(title);
  }

  private renderScreen(): string {
    const tail = this.pendingText.slice(-160);
    if (this.cli === "codex") {
      const status = this.mode === "working" ? "Working (11s)" : "";
      if (this.pendingText && this.queuedCodexReadsRemaining > 0) {
        this.queuedCodexReadsRemaining -= 1;
        const truncated = `${this.pendingText.slice(0, 42)}…`;
        return `OpenAI Codex\n${status}\n\nMessages to be submitted after next tool call\n  ↳ ${truncated}\n\n› \n\n  gpt-5.6-sol xhigh`;
      }
      return `OpenAI Codex\n${status}\n\n› ${tail}\n\n  gpt-5.6-sol xhigh`;
    }

    if (this.mode === "working") {
      return "Claude Code\n✻ Working\n";
    }

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

class FakeSlowClearingAgentClient extends FakeClaudeSurfaceClient {
  readonly sendKeyCalls: string[] = [];
  clearAfterReads = 22;
  duplicateSubmits = 0;
  cli: "claude" | "cursor" = "claude";
  private pendingText = "";
  private submittedText: string | null = null;
  private readsSinceSubmit = 0;

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
    if (key !== "return" || !this.pendingText) {
      return;
    }

    if (this.submittedText !== null) {
      this.duplicateSubmits += 1;
      return;
    }

    this.submittedText = this.pendingText;
  }

  async readScreen(surface: string, opts?: { lines?: number }) {
    if (surface !== this.surface) {
      throw new Error(`Unknown surface: ${surface}`);
    }

    if (this.submittedText !== null) {
      this.readsSinceSubmit += 1;
      if (this.readsSinceSubmit >= this.clearAfterReads) {
        this.pendingText = "";
      }
    }

    return {
      surface,
      text: this.renderScreen(),
      lines: opts?.lines ?? 30,
      scrollback_used: false,
    };
  }

  private renderScreen(): string {
    const tail = this.pendingText.slice(-160);
    if (this.cli === "cursor") {
      if (!tail && this.submittedText !== null) {
        return "Cursor Agent\nGenerating 1.2k tokens\n";
      }
      return `Cursor Agent\ncursor> ${tail}\nAuto\n`;
    }
    if (!tail && this.submittedText !== null) {
      return "Claude Code\n✻ Working\n";
    }
    return `Claude Code\n> ${tail}\nCLAUDE_COUNTER:1\n`;
  }
}

class FakeTransientVerificationReadClient extends FakeClaudeSurfaceClient {
  verificationReadAttempts = 0;

  async readScreen(surface: string, opts?: { lines?: number }) {
    if (this.sendCalls.length > 0) {
      this.verificationReadAttempts += 1;
      if (this.verificationReadAttempts === 1) {
        throw new Error("EAGAIN: transient cmux read failure");
      }
    }
    return super.readScreen(surface, opts);
  }
}

class FakeUnavailableVerificationScreenClient extends FakeClaudeSurfaceClient {
  verificationReadAttempts = 0;

  constructor(private readonly unavailableMode: "throw" | "blank") {
    super();
  }

  async readScreen(surface: string, opts?: { lines?: number }) {
    if (this.sendCalls.length === 0) {
      return super.readScreen(surface, opts);
    }
    this.verificationReadAttempts += 1;
    if (this.unavailableMode === "throw") {
      throw new Error("EAGAIN: cmux read unavailable");
    }
    return {
      surface,
      text: "",
      lines: opts?.lines ?? 30,
      scrollback_used: false,
    };
  }
}

function createReliabilityServer(client: FakeClaudeSurfaceClient) {
  const server = createServer({
    client: client as any,
    stateDir: TEST_DIR,
    disableSpawnPreflight: true,
    surfaceObserverOwnerIdProvider: () => TEST_OBSERVER_OWNER,
    surfaceObserverEpochProvider: () => `${TEST_OBSERVER_OWNER}@test`,
  });
  // These tests exercise registry routing and submit verification, not the
  // periodic reconciliation loop. Stop its wall-clock sweep so it cannot race
  // the five-second submit deadline or add unrelated work under parallel load.
  disposeServer(server);
  return server;
}

function registerAgent(server: any, overrides?: Partial<AgentRecord>): AgentRecord {
  const engine = server._registeredTools["interact"]._engine;
  const stateMgr = engine["stateMgr"];
  const registry = engine.getRegistry();

  const now = "2026-04-24T12:00:00Z";
  const record: AgentRecord = {
    agent_id: "agent-1",
    surface_id: "surface:agent",
    surface_observer_id: TEST_OBSERVER_OWNER,
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
    vi.useFakeTimers({ now: new Date("2026-07-11T12:00:00.000Z") });
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    server = null;
  });

  afterEach(async () => {
    await server?.close();
    vi.clearAllTimers();
    vi.useRealTimers();
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

  it("does not retry Enter for send_to when the agent composer remains ambiguously pending", async () => {
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

    expect(result.isError).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.submit_verified).toBe(false);
    expect(parsed.submit_verification_reason).toBe("input_still_pending");
    expect(parsed.retry_safe).toBe(false);
    expect(parsed.retry_count).toBe(0);
    expect(client.sendCalls.join("")).toHaveLength(2000);
    expect(client.sendKeyCalls.filter((key) => key === "return")).toHaveLength(
      1,
    );
    expect(
      events.some(
        (event) =>
          event.event_type === "send_to" &&
          event.submit_verified === false &&
          event.retry_count === 0,
      ),
    ).toBe(true);
    expect(
      events.some((event) => event.event_type === "press_enter"),
    ).toBe(true);
  }, 10_000);

  it("verifies a cleared idle composer without waiting for working status", async () => {
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
    expect(parsed.submit_verified).toBe(true);
    expect(parsed.retry_count).toBe(0);
    expect(client.sendKeyCalls.filter((key) => key === "return")).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.submit_verified).toBe(true);
    expect(events[0]?.retry_count).toBe(0);
  });

  it.each([
    ["Cursor queued composer", "cursor"],
    ["generic slow-clearing agent composer", "claude"],
  ] as const)(
    "does not press Enter twice when a submitted %s still shows accepted input",
    async (_name, cli) => {
    const client = new FakeSlowClearingAgentClient();
    client.cli = cli;
    client.clearAfterReads = 35;
    server = createReliabilityServer(client);
    registerAgent(server, { cli });

    const result = await callTool(server, "send_to", {
      agent_id: "agent-1",
      text: "slow first token",
      press_enter: true,
    });
    const parsed = parseResult(result);

    expect(client.sendKeyCalls.filter((key) => key === "return")).toHaveLength(
      1,
    );
    expect(client.duplicateSubmits).toBe(0);
    expect(parsed.ok).toBe(true);
    expect(parsed.submit_verified).toBe(true);
    expect(parsed.retry_count).toBe(0);
    },
  );

  it("reports send_to input as still pending when the composer never clears", async () => {
    const client = new FakeClaudeSurfaceClient();
    client.requiredReturns = 99;
    server = createReliabilityServer(client);
    registerAgent(server);

    const result = await callTool(server, "send_to", {
      agent_id: "agent-1",
      text: "still pending",
      press_enter: true,
    });
    const parsed = parseResult(result);
    const events = readEventLog();

    expect(result.isError).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.submit_verified).toBe(false);
    expect(parsed.submit_verification_reason).toBe("input_still_pending");
    expect(parsed.retry_safe).toBe(false);
    expect(parsed.retry_count).toBe(0);
    expect(client.sendKeyCalls.filter((key) => key === "return")).toHaveLength(1);
    expect(
      events.some(
        (event) =>
          event.event_type === "send_to" &&
          event.submit_verified === false &&
          event.retry_count === 0,
      ),
    ).toBe(true);
  }, 10_000);

  it("verifies a mid-session idle send_to when the first Return clears the full composer", async () => {
    const client = new FakeClaudeSurfaceClient();
    client.requiredReturns = 1;
    client.completionMode = "idle";
    server = createReliabilityServer(client);
    registerAgent(server, { state: "idle" });

    const result = await callTool(server, "send_to", {
      agent_id: "agent-1",
      text: "mid-session prompt",
      press_enter: true,
    });
    const parsed = parseResult(result);
    const events = readEventLog();

    expect(parsed.ok).toBe(true);
    expect(parsed.submit_verified).toBe(true);
    expect(parsed.retry_count).toBe(0);
    expect(client.sendKeyCalls.filter((key) => key === "return")).toHaveLength(1);
    expect(
      events.some(
        (event) =>
          event.event_type === "send_to" &&
          event.submit_verified === true &&
          event.retry_count === 0,
      ),
    ).toBe(true);
  });

  it("keeps polling after a transient verification read failure instead of false-failing a landed send", async () => {
    const client = new FakeTransientVerificationReadClient();
    client.requiredReturns = 1;
    server = createReliabilityServer(client);
    registerAgent(server);

    const result = await callTool(server, "send_to", {
      agent_id: "agent-1",
      text: "land once despite EAGAIN",
      press_enter: true,
    });
    const parsed = parseResult(result);

    expect(result.isError).not.toBe(true);
    expect(parsed.ok).toBe(true);
    expect(parsed.submit_verified).toBe(true);
    expect(client.verificationReadAttempts).toBeGreaterThanOrEqual(2);
    expect(client.sendKeyCalls.filter((key) => key === "return")).toHaveLength(
      1,
    );
  });

  it.each([
    ["unavailable reads", "throw", "surface_read_unavailable"],
    ["blank screens", "blank", "surface_screen_empty"],
  ] as const)(
    "fails closed only after a full verification window of %s and returns a non-retry-safe reason",
    async (_name, mode, expectedReason) => {
      const client = new FakeUnavailableVerificationScreenClient(mode);
      client.requiredReturns = 1;
      server = createReliabilityServer(client);
      registerAgent(server);

      const tool = (server as any)._registeredTools["send_to"];
      let settled = false;
      const resultPromise = tool.handler(
        {
          agent_id: "agent-1",
          text: "land once but evidence stays unavailable",
          press_enter: true,
        },
        {} as any,
      );
      void resultPromise.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(4_900);
      expect(settled).toBe(false);
      expect(client.verificationReadAttempts).toBeGreaterThan(1);

      await vi.advanceTimersByTimeAsync(1_000);
      const result = await resultPromise;
      const parsed = parseResult(result);

      expect(result.isError).toBe(true);
      expect(parsed.ok).toBe(false);
      expect(parsed.submit_verified).toBe(false);
      expect(parsed.submit_verification_reason).toBe(expectedReason);
      expect(parsed.retry_safe).toBe(false);
      expect(
        client.sendKeyCalls.filter((key) => key === "return"),
      ).toHaveLength(1);
    },
  );

  it("does not retry Enter for send_command when the agent composer remains ambiguously pending", async () => {
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

    expect(result.isError).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.submit_verified).toBe(false);
    expect(parsed.submit_verification_reason).toBe("input_still_pending");
    expect(parsed.retry_safe).toBe(false);
    expect(parsed.retry_count).toBe(0);
    expect(client.sendKeyCalls.filter((key) => key === "return")).toHaveLength(
      1,
    );
    expect(
      events.some(
        (event) =>
          event.event_type === "send_command" &&
          event.submit_verified === false &&
          event.retry_count === 0,
      ),
    ).toBe(true);
  }, 10_000);

  it("reports short send_command input as still pending when the composer never clears", async () => {
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
    expect(parsed.submit_verification_reason).toBe("input_still_pending");
    expect(parsed.retry_safe).toBe(false);
    expect(parsed.retry_count).toBe(0);
    expect(client.sendKeyCalls.filter((key) => key === "return")).toHaveLength(
      1,
    );
    expect(
      events.some(
        (event) =>
          event.event_type === "send_command" &&
          event.submit_verified === false &&
          event.retry_count === 0,
      ),
    ).toBe(true);
  }, 10_000);

  it("reports short send_input as still pending when the composer never clears", async () => {
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
    expect(parsed.submit_verification_reason).toBe("input_still_pending");
    expect(parsed.retry_safe).toBe(false);
    expect(parsed.retry_count).toBe(0);
    expect(client.sendKeyCalls.filter((key) => key === "return")).toHaveLength(
      1,
    );
    expect(
      events.some(
        (event) =>
          event.event_type === "send_input" &&
          event.submit_verified === false &&
          event.retry_count === 0,
      ),
    ).toBe(true);
  }, 10_000);

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

  it("Probe B: rejects an allow_busy Codex receipt when Return leaves the follow-up in the composer", async () => {
    const client = new FakeClaudeSurfaceClient();
    client.requiredReturns = 99;
    client.cli = "codex";
    client.keepWorkingStatusWhilePending = true;
    server = createReliabilityServer(client);
    registerAgent(server, { state: "working", cli: "codex" });
    const followUp = "Probe B follow-up evidence ".repeat(22).slice(0, 541);

    const result = await callTool(server, "send_to", {
      agent_id: "agent-1",
      text: followUp,
      press_enter: true,
      allow_busy: true,
    });
    const parsed = parseResult(result);
    const events = readEventLog().filter((event) => event.event_type === "send_to");

    expect(followUp).toHaveLength(541);
    expect(result.isError).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.submit_verified).toBe(false);
    expect(parsed.retry_count).toBe(0);
    expect(client.sendKeyCalls.filter((key) => key === "return")).toHaveLength(
      1,
    );
    expect(client.sendCalls.join("")).toBe(followUp);
    expect(events).toHaveLength(1);
    expect(events[0]?.submit_verified).toBe(false);
    expect(events[0]?.retry_count).toBe(0);
  }, 10_000);

  it("Probe E: rejects working status across a truncated Codex queue-to-composer transition", async () => {
    const client = new FakeClaudeSurfaceClient();
    client.requiredReturns = 99;
    client.cli = "codex";
    client.keepWorkingStatusWhilePending = true;
    client.queuedCodexReadsAfterReturn = 1;
    server = createReliabilityServer(client);
    registerAgent(server, { state: "ready", cli: "codex" });
    const followUp = "Probe E queued follow-up evidence ".repeat(20).slice(0, 541);
    const tail = followUp.slice(-80);

    const result = await callToolInTimerSteps(server, "send_to", {
      agent_id: "agent-1",
      text: followUp,
      press_enter: true,
    });
    const parsed = parseResult(result);
    const events = readEventLog().filter((event) => event.event_type === "send_to");
    const queuedScreen = client.screenReads.find((screen) =>
      screen.includes("Messages to be submitted after next tool call"),
    );
    const composerScreen = client.screenReads.find(
      (screen) =>
        !screen.includes("Messages to be submitted after next tool call") &&
        screen.includes("› ") &&
        screen.includes(tail),
    );

    expect(followUp).toHaveLength(541);
    expect(result.isError).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.submit_verified).toBe(false);
    expect(parsed.retry_count).toBe(0);
    expect(queuedScreen).toContain("↳ Probe E queued follow-up evidence");
    expect(queuedScreen).not.toContain(tail);
    expect(composerScreen).toContain("› ");
    expect(composerScreen).toContain(tail);
    expect(client.sendKeyCalls.filter((key) => key === "return")).toHaveLength(
      1,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.submit_verified).toBe(false);
    expect(events[0]?.retry_count).toBe(0);
  }, 10_000);

  it("fails closed when requested agent submission verification cannot read the screen", async () => {
    const client = new FakeClaudeSurfaceClient();
    client.requiredReturns = 1;
    client.failScreenReadsAfterReturn = true;
    server = createReliabilityServer(client);
    registerAgent(server);

    const result = await callTool(server, "send_to", {
      agent_id: "agent-1",
      text: "unavailable verification evidence",
      press_enter: true,
    });
    const parsed = parseResult(result);
    const events = readEventLog().filter((event) => event.event_type === "send_to");

    expect(result.isError).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.submit_verified).toBe(false);
    expect(parsed.retry_count).toBe(0);
    expect(client.sendKeyCalls.filter((key) => key === "return")).toHaveLength(
      1,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.submit_verified).toBe(false);
    expect(events[0]?.retry_count).toBe(0);
  }, 10_000);

  it("does not verify send_input to an uncached shell from prompt clearing", async () => {
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
    expect(parsed.submit_verified).toBeNull();
    expect(parsed.retry_count).toBe(0);
    expect(client.sendKeyCalls.filter((key) => key === "return")).toHaveLength(
      1,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.submit_verified).toBeNull();
  });

  it("uses the verified send path for interact(action=send)", async () => {
    const client = new FakeClaudeSurfaceClient();
    client.requiredReturns = 1;
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
    expect(parsed.submit_verified).toBe(true);
    expect(parsed.retry_count).toBe(0);
    expect(client.sendKeyCalls.filter((key) => key === "return")).toHaveLength(
      1,
    );
    expect(
      events.some(
        (event) =>
          event.event_type === "interact" &&
          event.submit_verified === true &&
          event.retry_count === 0,
      ),
    ).toBe(true);
  });

  it("verifies each back-to-back send_to instead of assuming the previous submit pattern holds", async () => {
    const client = new FakeClaudeSurfaceClient();
    client.requiredReturns = 1;
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
      2,
    );
    expect(events).toHaveLength(2);
    expect(
      events.every(
        (event) =>
          event.submit_verified === true && event.retry_count === 0,
      ),
    ).toBe(true);
  }, 10_000);

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
