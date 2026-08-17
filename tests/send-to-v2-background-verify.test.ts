import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/server.js";
import type { AgentRecord } from "../src/agent-types.js";
import { defaultDeliveryTicketDir } from "../src/delivery-failure-tickets.js";
import { DELIVERY_TARGET_GONE_CONFIRM_MISSES } from "../src/agent-engine.js";

const TEST_DIR = join(tmpdir(), "cmux-send-to-v2-verify-test");
const TEST_OBSERVER_OWNER = "cmux:/tmp/cmux-send-to-v2-verify-test.sock";

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
  for (let elapsed = 0; elapsed < 10_000; elapsed += 100) {
    await vi.advanceTimersByTimeAsync(100);
  }
  return resultPromise;
}

class FakeAgentSurfaceClient {
  readonly workspace = "workspace:1";
  readonly pane = "pane:1";
  readonly surface = "surface:agent";
  title = "brainlayerClaude";
  readonly sendCalls: string[] = [];
  readonly sendKeyCalls: string[] = [];
  cli: "claude" | "cursor" = "claude";
  requiredReturns = 99;
  /** Model Cursor's follow-ups box that needs a second Return ("enter send now"). */
  cursorFollowUpBox = false;
  screenOverride: string | null = null;
  private pendingText = "";
  private returnCount = 0;
  private transcriptTail: string | null = null;
  private followUps: string[] = [];
  private followUpNeedsEnter = false;

  async log() {}
  async setStatus() {}
  async setStatuses() {
    return true;
  }
  async clearStatus() {}
  async listSurfaces() {
    return {
      surfaces: [
        {
          ref: this.surface,
          title: this.title,
          type: "terminal",
          workspace_ref: this.workspace,
        },
      ],
    };
  }

  clearComposer(transcriptText?: string): void {
    this.pendingText = "";
    this.followUpNeedsEnter = false;
    if (this.followUps.length > 0) {
      this.transcriptTail = this.followUps.join("\n");
      this.followUps = [];
    }
    this.transcriptTail = transcriptText ?? this.transcriptTail;
  }

  resetTypedInput(): void {
    this.pendingText = "";
    this.returnCount = 0;
    this.transcriptTail = null;
    this.followUps = [];
    this.followUpNeedsEnter = false;
  }

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
    if (key !== "return" || !this.pendingText) {
      return;
    }
    this.returnCount += 1;
    if (this.cursorFollowUpBox && this.cli === "cursor") {
      if (this.returnCount === 1) {
        this.followUpNeedsEnter = true;
        return;
      }
      this.followUps.push(this.pendingText);
      this.pendingText = "";
      this.followUpNeedsEnter = false;
      return;
    }
    if (this.returnCount >= this.requiredReturns) {
      this.transcriptTail = this.pendingText;
      this.pendingText = "";
    }
  }

  async readScreen(surface: string, opts?: { lines?: number }) {
    if (surface !== this.surface) {
      throw new Error(`Unknown surface: ${surface}`);
    }
    const tail = this.pendingText.slice(-160);
    const text =
      this.screenOverride ??
      (this.cli === "cursor"
        ? [
            "Cursor Agent",
            this.followUpNeedsEnter || this.followUps.length > 0
              ? "Working"
              : "Auto",
            "~/Gits/cmuxlayer · main",
            this.transcriptTail ? `  ${this.transcriptTail}` : "",
            ...this.followUps.map((item) => `  ${item}`),
            this.followUpNeedsEnter ? "follow-ups · enter send now" : "",
            this.pendingText
              ? `→ ${tail}`
              : this.followUps.length > 0 || this.followUpNeedsEnter
                ? "→ Add a follow-up"
                : `→ ${tail}`,
            this.followUps.length > 0 || this.followUpNeedsEnter
              ? "ctrl+c to stop"
              : "",
          ]
            .filter((line) => line !== "")
            .join("\n")
        : `Claude Code\n> ${tail}\nCLAUDE_COUNTER:1\n`);
    return {
      surface,
      text,
      lines: opts?.lines ?? 30,
      scrollback_used: false,
    };
  }

  async renameTab(_surface: string, _title: string) {}
}

function createVerifyServer(
  client: FakeAgentSurfaceClient,
  extras?: {
    deliveryVerifyDeadlineMs?: number;
    deliveryTicketDir?: string;
    deliveryIssueFiler?: (ticket: unknown) => Promise<void>;
  },
) {
  const server = createServer({
    client: client as any,
    stateDir: TEST_DIR,
    disableSpawnPreflight: true,
    surfaceObserverOwnerIdProvider: () => TEST_OBSERVER_OWNER,
    surfaceObserverEpochProvider: () => `${TEST_OBSERVER_OWNER}@test`,
    ...extras,
  });
  const engine = (server as any)._registeredTools.interact._engine;
  engine.dispose();
  return server;
}

function registerAgent(
  server: any,
  overrides?: Partial<AgentRecord>,
): AgentRecord {
  const engine = server._registeredTools.interact._engine;
  const now = "2026-08-17T20:00:00Z";
  const record: AgentRecord = {
    agent_id: "agent-1",
    surface_id: "surface:agent",
    surface_observer_id: TEST_OBSERVER_OWNER,
    workspace_id: "workspace:1",
    state: "ready",
    repo: "cmuxlayer",
    model: "sonnet",
    cli: "claude",
    cli_session_id: null,
    task_summary: "send_to v2 verify",
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
  engine.stateMgr.writeState(record);
  engine.getRegistry().set(record.agent_id, record);
  return record;
}

describe("send_to v2 background verify", () => {
  let server: any;

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-08-17T20:00:00.000Z") });
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

  it("returns pending_verify instead of terminal failed when the sync window expires without submit evidence", async () => {
    const client = new FakeAgentSurfaceClient();
    server = createVerifyServer(client);
    registerAgent(server);

    const result = await callTool(server, "send_to", {
      agent_id: "agent-1",
      text: "still pending",
      press_enter: true,
    });
    const parsed = parseResult(result);

    expect(result.isError).not.toBe(true);
    expect(parsed).toMatchObject({
      ok: true,
      delivery_id: expect.any(String),
      delivery_state: "pending_verify",
      delivery: "pending_verify",
      terminal: false,
      delivered: false,
      submit_verified: null,
    });
    const engine = server._registeredTools.interact._engine;
    expect(engine.getDeliveryReceipt(parsed.delivery_id)).toMatchObject({
      delivery_id: parsed.delivery_id,
      delivery_state: "pending_verify",
      terminal: false,
    });
  });

  it("presses Cursor's follow-up Return and receipts queued_followup once the composer is consumed", async () => {
    const client = new FakeAgentSurfaceClient();
    client.cli = "cursor";
    client.title = "cmuxlayerCursor";
    client.cursorFollowUpBox = true;
    server = createVerifyServer(client);
    registerAgent(server, { cli: "cursor" });

    const result = await callTool(server, "send_to", {
      agent_id: "agent-1",
      text: "busy cursor follow-up",
      press_enter: true,
    });
    const parsed = parseResult(result);
    const finalScreen = await client.readScreen(client.surface);

    expect(result.isError).not.toBe(true);
    expect(parsed).toMatchObject({
      ok: true,
      delivery_id: expect.any(String),
      delivery_state: "queued_followup",
      delivery: "queued_followup",
      terminal: false,
      delivered: false,
      submit_verified: null,
    });
    expect(
      client.sendKeyCalls.filter((key) => key === "return").length,
    ).toBeGreaterThanOrEqual(2);
    expect(finalScreen.text).toContain("→ Add a follow-up");
    expect(finalScreen.text).toContain("busy cursor follow-up");
    expect(finalScreen.text).not.toContain("enter send now");
    expect(finalScreen.text).not.toMatch(/^→ busy cursor follow-up$/m);
    const engine = server._registeredTools.interact._engine;
    expect(engine.getDeliveryReceipt(parsed.delivery_id)).toMatchObject({
      delivery_id: parsed.delivery_id,
      delivery_state: "queued_followup",
      terminal: false,
      composer_accepted: true,
    });
  });

  it("returns duplicate_of for an identical send while queued_followup is in flight", async () => {
    const client = new FakeAgentSurfaceClient();
    client.cli = "cursor";
    client.title = "cmuxlayerCursor";
    client.cursorFollowUpBox = true;
    server = createVerifyServer(client);
    registerAgent(server, { cli: "cursor" });

    const first = parseResult(
      await callTool(server, "send_to", {
        agent_id: "agent-1",
        text: "do not double-queue",
        press_enter: true,
      }),
    );
    expect(first.delivery_state).toBe("queued_followup");
    const typedAfterFirst = client.sendCalls.length;
    const returnsAfterFirst = client.sendKeyCalls.filter(
      (key) => key === "return",
    ).length;

    const second = parseResult(
      await callTool(server, "send_to", {
        agent_id: "agent-1",
        text: "do not double-queue",
        press_enter: true,
      }),
    );

    expect(second.delivery_id).toBe(first.delivery_id);
    expect(second.duplicate_of).toBe(first.delivery_id);
    expect(second.delivery_state).toBe("queued_followup");
    expect(client.sendCalls.length).toBe(typedAfterFirst);
    expect(client.sendKeyCalls.filter((key) => key === "return").length).toBe(
      returnsAfterFirst,
    );
  });

  it("promotes queued_followup to submitted when the follow-up flushes at turn end", async () => {
    const client = new FakeAgentSurfaceClient();
    client.cli = "cursor";
    client.title = "cmuxlayerCursor";
    client.cursorFollowUpBox = true;
    server = createVerifyServer(client);
    registerAgent(server, { cli: "cursor" });

    const sent = parseResult(
      await callTool(server, "send_to", {
        agent_id: "agent-1",
        text: "delivers at turn end",
        press_enter: true,
      }),
    );
    expect(sent.delivery_state).toBe("queued_followup");

    const engine = server._registeredTools.interact._engine;
    await engine.verifyPendingDeliveries();
    expect(engine.getDeliveryReceipt(sent.delivery_id)).toMatchObject({
      delivery_state: "queued_followup",
      terminal: false,
    });

    client.clearComposer("delivers at turn end");
    await engine.verifyPendingDeliveries();
    expect(engine.getDeliveryReceipt(sent.delivery_id)).toMatchObject({
      delivery_id: sent.delivery_id,
      delivery_state: "submitted",
      terminal: true,
      submit_verified: true,
    });
  });

  it("promotes a pending_verify delivery to submitted once the composer clears", async () => {
    const client = new FakeAgentSurfaceClient();
    server = createVerifyServer(client);
    registerAgent(server);

    const sent = await callTool(server, "send_to", {
      agent_id: "agent-1",
      text: "lands later",
      press_enter: true,
    });
    const parsed = parseResult(sent);
    expect(parsed.delivery_state).toBe("pending_verify");

    client.clearComposer("lands later");
    const engine = server._registeredTools.interact._engine;
    await engine.verifyPendingDeliveries();

    expect(engine.getDeliveryReceipt(parsed.delivery_id)).toMatchObject({
      delivery_id: parsed.delivery_id,
      delivery_state: "submitted",
      terminal: true,
      submit_verified: true,
    });
  });

  it("returns the existing delivery_id with duplicate_of instead of typing again", async () => {
    const client = new FakeAgentSurfaceClient();
    server = createVerifyServer(client);
    registerAgent(server);

    const first = parseResult(
      await callTool(server, "send_to", {
        agent_id: "agent-1",
        text: "do not double-type",
        press_enter: true,
      }),
    );
    expect(first.delivery_state).toBe("pending_verify");
    const typedAfterFirst = client.sendCalls.length;

    const second = parseResult(
      await callTool(server, "send_to", {
        agent_id: "agent-1",
        text: "do not double-type",
        press_enter: true,
      }),
    );

    expect(second.delivery_id).toBe(first.delivery_id);
    expect(second.duplicate_of).toBe(first.delivery_id);
    expect(second.delivery_state).toBe("pending_verify");
    expect(client.sendCalls.length).toBe(typedAfterFirst);
  });

  it("suppresses an identical send while the engine queue still holds the first delivery", async () => {
    const client = new FakeAgentSurfaceClient();
    server = createVerifyServer(client);
    registerAgent(server, { state: "working" });

    const first = parseResult(
      await callTool(server, "send_to", {
        agent_id: "agent-1",
        text: "queued once",
        press_enter: true,
      }),
    );
    expect(first.delivery_state).toBe("queued");

    const second = parseResult(
      await callTool(server, "send_to", {
        agent_id: "agent-1",
        text: "queued once",
        press_enter: true,
      }),
    );

    expect(second.delivery_id).toBe(first.delivery_id);
    expect(second.duplicate_of).toBe(first.delivery_id);
    expect(client.sendCalls).toEqual([]);
  });

  it("confirms failure after the verify deadline and writes a local evidence ticket", async () => {
    const ticketDir = join(TEST_DIR, "tickets");
    const filed: unknown[] = [];
    const client = new FakeAgentSurfaceClient();
    server = createVerifyServer(client, {
      deliveryVerifyDeadlineMs: 1_000,
      deliveryTicketDir: ticketDir,
      deliveryIssueFiler: async (ticket) => {
        filed.push(ticket);
      },
    });
    registerAgent(server);

    const sent = parseResult(
      await callTool(server, "send_to", {
        agent_id: "agent-1",
        text: "never lands",
        press_enter: true,
      }),
    );
    expect(sent.delivery_state).toBe("pending_verify");

    await vi.advanceTimersByTimeAsync(1_000);
    const engine = server._registeredTools.interact._engine;
    await engine.verifyPendingDeliveries();

    expect(engine.getDeliveryReceipt(sent.delivery_id)).toMatchObject({
      delivery_id: sent.delivery_id,
      delivery_state: "failed_confirmed",
      terminal: true,
    });
    expect(existsSync(ticketDir)).toBe(true);
    expect(readdirSync(ticketDir).length).toBeGreaterThan(0);
    expect(filed).toHaveLength(1);
  });

  it("dedupes evidence tickets by failure signature", async () => {
    const ticketDir = join(TEST_DIR, "tickets");
    const filed: unknown[] = [];
    const client = new FakeAgentSurfaceClient();
    server = createVerifyServer(client, {
      deliveryVerifyDeadlineMs: 1_000,
      deliveryTicketDir: ticketDir,
      deliveryIssueFiler: async (ticket) => {
        filed.push(ticket);
      },
    });
    registerAgent(server);

    parseResult(
      await callTool(server, "send_to", {
        agent_id: "agent-1",
        text: "first miss",
        press_enter: true,
      }),
    );
    client.resetTypedInput();
    parseResult(
      await callTool(server, "send_to", {
        agent_id: "agent-1",
        text: "second miss",
        press_enter: true,
      }),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await server._registeredTools.interact._engine.verifyPendingDeliveries();

    expect(readdirSync(ticketDir)).toHaveLength(1);
    expect(filed).toHaveLength(1);
  });

  it("lets wait_for accept a delivery_id and return the terminal receipt", async () => {
    const client = new FakeAgentSurfaceClient();
    server = createVerifyServer(client);
    registerAgent(server);

    const sent = parseResult(
      await callTool(server, "send_to", {
        agent_id: "agent-1",
        text: "wait for me",
        press_enter: true,
      }),
    );
    client.clearComposer("wait for me");

    const waitPromise = server._registeredTools.wait_for.handler(
      { delivery_id: sent.delivery_id, timeout_ms: 5_000 },
      {} as any,
    );
    const verifyPromise =
      server._registeredTools.interact._engine.verifyPendingDeliveries();
    await vi.advanceTimersByTimeAsync(200);
    await verifyPromise;
    const waited = parseResult(await waitPromise);

    expect(waited).toMatchObject({
      ok: true,
      delivery_id: sent.delivery_id,
      delivery_state: "submitted",
      terminal: true,
    });
  });

  it("exposes deliveries on list_agents detail=full", async () => {
    const client = new FakeAgentSurfaceClient();
    server = createVerifyServer(client);
    registerAgent(server);

    const sent = parseResult(
      await callTool(server, "send_to", {
        agent_id: "agent-1",
        text: "list me",
        press_enter: true,
      }),
    );

    const listed = parseResult(
      await callTool(server, "list_agents", { detail: "full" }),
    );
    expect(listed.deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          delivery_id: sent.delivery_id,
          agent_id: "agent-1",
          delivery_state: "pending_verify",
          terminal: false,
        }),
      ]),
    );
  });

  it("does not fail queued_followup after the verify deadline or file a ticket", async () => {
    const ticketDir = join(TEST_DIR, "tickets");
    const filed: unknown[] = [];
    const client = new FakeAgentSurfaceClient();
    client.cli = "cursor";
    client.title = "cmuxlayerCursor";
    client.cursorFollowUpBox = true;
    server = createVerifyServer(client, {
      deliveryVerifyDeadlineMs: 1_000,
      deliveryTicketDir: ticketDir,
      deliveryIssueFiler: async (ticket) => {
        filed.push(ticket);
      },
    });
    registerAgent(server, { cli: "cursor" });

    const sent = parseResult(
      await callTool(server, "send_to", {
        agent_id: "agent-1",
        text: "composer already consumed",
        press_enter: true,
      }),
    );
    expect(sent.delivery_state).toBe("queued_followup");

    await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
    const engine = server._registeredTools.interact._engine;
    await engine.verifyPendingDeliveries();

    expect(engine.getDeliveryReceipt(sent.delivery_id)).toMatchObject({
      delivery_id: sent.delivery_id,
      delivery_state: "queued_followup",
      terminal: false,
    });
    expect(existsSync(ticketDir)).toBe(false);
    expect(filed).toHaveLength(0);
  });

  it("does not promote pending_verify to submitted on working status without composer or transcript evidence", async () => {
    const client = new FakeAgentSurfaceClient();
    client.cli = "cursor";
    client.title = "cmuxlayerCursor";
    server = createVerifyServer(client);
    registerAgent(server, { cli: "cursor" });

    const sent = parseResult(
      await callTool(server, "send_to", {
        agent_id: "agent-1",
        text: "do not promote on working status",
        press_enter: true,
      }),
    );
    expect(sent.delivery_state).toBe("pending_verify");

    client.screenOverride = [
      "Cursor Agent",
      "⬡ Running...",
      "~/Gits/cmuxlayer · main",
      "→ leftover truncated follow-up",
    ].join("\n");

    const engine = server._registeredTools.interact._engine;
    await engine.verifyPendingDeliveries();

    expect(engine.getDeliveryReceipt(sent.delivery_id)).toMatchObject({
      delivery_id: sent.delivery_id,
      delivery_state: "pending_verify",
      terminal: false,
    });
  });

  it("does not write home tickets or call gh from a bare createServer failure", async () => {
    const homeTickets = defaultDeliveryTicketDir();
    const before = existsSync(homeTickets) ? readdirSync(homeTickets) : null;
    const client = new FakeAgentSurfaceClient();
    server = createVerifyServer(client, {
      deliveryVerifyDeadlineMs: 1_000,
    });
    registerAgent(server);

    const sent = parseResult(
      await callTool(server, "send_to", {
        agent_id: "agent-1",
        text: "no default tickets",
        press_enter: true,
      }),
    );
    expect(sent.delivery_state).toBe("pending_verify");

    await vi.advanceTimersByTimeAsync(1_000);
    const engine = server._registeredTools.interact._engine;
    await engine.verifyPendingDeliveries();

    expect(engine.getDeliveryReceipt(sent.delivery_id)).toMatchObject({
      delivery_state: "failed_confirmed",
      terminal: true,
    });
    const after = existsSync(homeTickets) ? readdirSync(homeTickets) : null;
    expect(after).toEqual(before);
  });

  it("waits for consecutive target_gone misses before failed_confirmed", async () => {
    const ticketDir = join(TEST_DIR, "tickets");
    const client = new FakeAgentSurfaceClient();
    server = createVerifyServer(client, {
      deliveryTicketDir: ticketDir,
      deliveryIssueFiler: async () => {},
    });
    registerAgent(server);

    const sent = parseResult(
      await callTool(server, "send_to", {
        agent_id: "agent-1",
        text: "target may flicker",
        press_enter: true,
      }),
    );
    expect(sent.delivery_state).toBe("pending_verify");

    const engine = server._registeredTools.interact._engine;
    engine.getRegistry().remove("agent-1");

    for (let miss = 1; miss < DELIVERY_TARGET_GONE_CONFIRM_MISSES; miss += 1) {
      await engine.verifyPendingDeliveries();
      expect(engine.getDeliveryReceipt(sent.delivery_id)).toMatchObject({
        delivery_state: "pending_verify",
        terminal: false,
        verify_miss_count: miss,
      });
    }

    await engine.verifyPendingDeliveries();
    expect(engine.getDeliveryReceipt(sent.delivery_id)).toMatchObject({
      delivery_state: "failed_confirmed",
      terminal: true,
      error: "target_gone",
    });
  });

  it("backfills verify_deadline_at from load time so historical queued receipts do not immediately fail", async () => {
    const ticketDir = join(TEST_DIR, "tickets");
    const filed: unknown[] = [];
    writeFileSync(
      join(TEST_DIR, "delivery-receipts.json"),
      `${JSON.stringify([
        {
          delivery_id: "hist-1",
          agent_id: "agent-1",
          text: "historical queued payload",
          press_enter: true,
          source_event: "send_to",
          delivery_state: "queued",
          terminal: false,
          created_at: "2026-08-17T19:00:00.000Z",
          resolved_at: null,
          retry_count: 0,
          submit_verified: null,
          error: null,
          composer_accepted: true,
        },
      ])}\n`,
    );
    const client = new FakeAgentSurfaceClient();
    client.screenOverride = [
      "Claude Code",
      "> leftover that is not the payload",
    ].join("\n");
    server = createVerifyServer(client, {
      deliveryTicketDir: ticketDir,
      deliveryIssueFiler: async (ticket) => {
        filed.push(ticket);
      },
    });
    registerAgent(server);

    const engine = server._registeredTools.interact._engine;
    const loaded = engine.getDeliveryReceipt("hist-1");
    expect(loaded.verify_deadline_at).toBe("2026-08-17T20:10:00.000Z");

    await engine.verifyPendingDeliveries();
    expect(engine.getDeliveryReceipt("hist-1")).toMatchObject({
      delivery_id: "hist-1",
      delivery_state: "queued",
      terminal: false,
    });
    expect(existsSync(ticketDir)).toBe(false);
    expect(filed).toHaveLength(0);
  });
});
