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
import { AgentRegistry } from "../src/agent-registry.js";
import { StateManager } from "../src/state-manager.js";
import { defaultDeliveryTicketDir } from "../src/delivery-failure-tickets.js";
import {
  AgentEngine,
  DELIVERY_TARGET_GONE_CONFIRM_MISSES,
} from "../src/agent-engine.js";

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
  readScreenCalls = 0;
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

  sendGate: Promise<void> | null = null;

  async send(surface: string, text: string) {
    if (surface !== this.surface) {
      throw new Error(`Unknown surface: ${surface}`);
    }
    if (this.sendGate) {
      await this.sendGate;
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
    this.readScreenCalls += 1;
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

  it("registers the delivery before typing so concurrent identical sends return duplicate_of", async () => {
    const client = new FakeAgentSurfaceClient();
    let releaseSend!: () => void;
    client.sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    server = createVerifyServer(client);
    registerAgent(server);

    const args = {
      agent_id: "agent-1",
      text: "race me once",
      press_enter: true,
    };
    const firstPromise = server._registeredTools.send_to.handler(
      args,
      {} as any,
    );
    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
    }
    const engine = server._registeredTools.interact._engine;
    const inFlight = engine.listDeliveryReceipts();
    expect(inFlight).toEqual([
      expect.objectContaining({
        text: "race me once",
        delivery_state: "pending_verify",
        terminal: false,
      }),
    ]);
    expect(client.sendCalls).toEqual([]);

    const second = parseResult(
      await server._registeredTools.send_to.handler(args, {} as any),
    );
    releaseSend();
    for (let elapsed = 0; elapsed < 10_000; elapsed += 100) {
      await vi.advanceTimersByTimeAsync(100);
    }
    const first = parseResult(await firstPromise);

    expect(second.duplicate_of).toBe(inFlight[0].delivery_id);
    expect(second.delivery_id).toBe(first.delivery_id);
    expect(client.sendCalls).toEqual(["race me once"]);
  });

  it("stores sanitized text on the delivery receipt so verify matches the typed payload", async () => {
    const client = new FakeAgentSurfaceClient();
    server = createVerifyServer(client);
    registerAgent(server);
    const raw = "hello\x07\x1b[31mworld";
    const sanitized = "helloworld";

    const sent = parseResult(
      await callTool(server, "send_to", {
        agent_id: "agent-1",
        text: raw,
        press_enter: true,
      }),
    );

    const engine = server._registeredTools.interact._engine;
    expect(engine.getDeliveryReceipt(sent.delivery_id)).toMatchObject({
      text: sanitized,
    });
    expect(client.sendCalls.join("")).toBe(sanitized);
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

  it("suppresses an identical send while screen-ready delivery verification is pending", async () => {
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
    expect(first.delivery_state).toBe("pending_verify");

    const second = parseResult(
      await callTool(server, "send_to", {
        agent_id: "agent-1",
        text: "queued once",
        press_enter: true,
      }),
    );

    expect(second.delivery_id).toBe(first.delivery_id);
    expect(second.duplicate_of).toBe(first.delivery_id);
    expect(client.sendCalls).toEqual(["queued once"]);
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
    // T2 #471: the local evidence ticket stays; escalating a deadline the
    // ENGINE ran out of to the issue tracker does not.
    expect(filed).toHaveLength(0);
  });

  it("does not escalate a verify_deadline_elapsed failure to a GitHub issue (#471)", async () => {
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
        text: "engine stopped looking",
        press_enter: true,
      }),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    const engine = server._registeredTools.interact._engine;
    await engine.verifyPendingDeliveries();

    const receipt = engine.getDeliveryReceipt(sent.delivery_id);
    expect(receipt).toMatchObject({
      delivery_state: "failed_confirmed",
      terminal: true,
      error: "verify_deadline_elapsed",
    });
    // Local forensics are still written -- the verdict must cite its evidence.
    expect(readdirSync(ticketDir).length).toBeGreaterThan(0);
    // ...but the tracker does not get an issue for the engine giving up.
    expect(filed).toHaveLength(0);
    expect(receipt.ticket_escalated).toBe(false);
    expect(receipt.ticket_escalation_declined_reason).toMatch(
      /no evidence the message was lost/i,
    );
  });

  it("does not escalate a target_gone failure to a GitHub issue (#443)", async () => {
    const ticketDir = join(TEST_DIR, "tickets");
    const filed: unknown[] = [];
    const client = new FakeAgentSurfaceClient();
    server = createVerifyServer(client, {
      deliveryTicketDir: ticketDir,
      deliveryIssueFiler: async (ticket) => {
        filed.push(ticket);
      },
    });
    registerAgent(server);

    const sent = parseResult(
      await callTool(server, "send_to", {
        agent_id: "agent-1",
        text: "target vanished",
        press_enter: true,
      }),
    );

    const engine = server._registeredTools.interact._engine;
    engine.getRegistry().remove("agent-1");
    for (let miss = 0; miss < DELIVERY_TARGET_GONE_CONFIRM_MISSES; miss += 1) {
      await engine.verifyPendingDeliveries();
    }

    const receipt = engine.getDeliveryReceipt(sent.delivery_id);
    expect(receipt).toMatchObject({
      delivery_state: "failed_confirmed",
      terminal: true,
      error: "target_gone",
      ticket_escalated: false,
    });
    expect(readdirSync(ticketDir).length).toBeGreaterThan(0);
    expect(filed).toHaveLength(0);
  });

  it("still escalates a failure the verifier positively observed", async () => {
    const ticketDir = join(TEST_DIR, "tickets");
    const filed: unknown[] = [];
    const client = new FakeAgentSurfaceClient();
    server = createVerifyServer(client, {
      deliveryTicketDir: ticketDir,
      deliveryIssueFiler: async (ticket) => {
        filed.push(ticket);
      },
    });
    registerAgent(server);

    const sent = parseResult(
      await callTool(server, "send_to", {
        agent_id: "agent-1",
        text: "observed lost",
        press_enter: true,
      }),
    );

    const engine = server._registeredTools.interact._engine;
    engine.setDeliveryVerifier(async () => ({
      outcome: "failed_confirmed" as const,
      reason: "composer_rejected_input",
    }));
    await engine.verifyPendingDeliveries();

    expect(engine.getDeliveryReceipt(sent.delivery_id)).toMatchObject({
      delivery_state: "failed_confirmed",
      terminal: true,
      error: "composer_rejected_input",
      ticket_escalated: true,
    });
    expect(filed).toHaveLength(1);
  });

  it("bounds a wedged snapshot read so the verifier cannot stall forever (#450)", async () => {
    let reads = 0;
    const client = new FakeAgentSurfaceClient();
    const stateMgr = new StateManager(TEST_DIR);
    const engine = new AgentEngine(
      stateMgr,
      new AgentRegistry(stateMgr, async () => []),
      client as any,
      {
        deliveryVerifyTimeoutMs: 50,
        // Mirrors the production verifier: no snapshot, no evidence.
        deliveryVerifier: async (_receipt, snapshot) =>
          snapshot?.text
            ? { outcome: "delivered" as const, submit_verified: true }
            : {
                outcome: "pending" as const,
                reason: "surface_read_unavailable",
              },
        // The CLI-fallback surface read has no subprocess timeout of its own;
        // model a wedged `cmux` on the first pass.
        deliverySnapshotReader: async () => {
          reads += 1;
          if (reads === 1) {
            return new Promise(() => {}) as never;
          }
          return { text: "Claude Code\n> \n" };
        },
      },
    );
    try {
      engine.acceptPendingVerify({
        delivery_id: "wedged-read-1",
        agent_id: "agent-1",
        text: "snapshot read wedges",
        press_enter: true,
        source_event: "send_to",
        retry_count: 0,
      });

      let settled = false;
      const first = engine.verifyPendingDeliveries().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(50);
      await first;

      expect(settled).toBe(true);
      expect(engine.getDeliveryReceipt("wedged-read-1")).toMatchObject({
        delivery_state: "pending_verify",
        terminal: false,
      });

      // The latch was released, so a later sweep still resolves the receipt.
      await vi.advanceTimersByTimeAsync(30_000);
      await engine.verifyPendingDeliveries();
      expect(reads).toBe(2);
      expect(engine.getDeliveryReceipt("wedged-read-1")).toMatchObject({
        delivery_state: "submitted",
        terminal: true,
      });
    } finally {
      engine.dispose();
    }
  });

  it("does not claim escalation when the ticket was deduped, the filer is absent, or the filer threw (B2)", async () => {
    const observedFailure = async () => ({
      outcome: "failed_confirmed" as const,
      reason: "composer_rejected_input",
    });

    const sendAndVerify = async (extras: Record<string, unknown>) => {
      const client = new FakeAgentSurfaceClient();
      const local = createVerifyServer(client, extras as any);
      registerAgent(local);
      const sent = parseResult(
        await callTool(local, "send_to", {
          agent_id: "agent-1",
          text: `escalation exit ${JSON.stringify(extras).length}`,
          press_enter: true,
        }),
      );
      const engine = local._registeredTools.interact._engine;
      engine.setDeliveryVerifier(observedFailure);
      await engine.verifyPendingDeliveries();
      const receipt = engine.getDeliveryReceipt(sent.delivery_id);
      await local.close();
      return receipt;
    };

    // (1) no filer configured -- nothing can be escalated.
    expect(
      await sendAndVerify({ deliveryTicketDir: join(TEST_DIR, "t-nofiler") }),
    ).toMatchObject({ ticket_filed: true, ticket_escalated: false });

    // (2) the filer threw -- the issue was not filed.
    expect(
      await sendAndVerify({
        deliveryTicketDir: join(TEST_DIR, "t-throws"),
        deliveryIssueFiler: async () => {
          throw new Error("gh unavailable");
        },
      }),
    ).toMatchObject({ ticket_filed: true, ticket_escalated: false });
  });

  it("does not claim escalation for a deduped signature (B2)", async () => {
    const ticketDir = join(TEST_DIR, "tickets-dedupe-escalation");
    const filed: unknown[] = [];
    const client = new FakeAgentSurfaceClient();
    server = createVerifyServer(client, {
      deliveryTicketDir: ticketDir,
      deliveryIssueFiler: async (ticket) => {
        filed.push(ticket);
      },
    });
    registerAgent(server);
    const engine = server._registeredTools.interact._engine;
    engine.setDeliveryVerifier(async () => ({
      outcome: "failed_confirmed" as const,
      reason: "composer_rejected_input",
    }));

    const first = parseResult(
      await callTool(server, "send_to", {
        agent_id: "agent-1",
        text: "first observed loss",
        press_enter: true,
      }),
    );
    await engine.verifyPendingDeliveries();
    client.resetTypedInput();
    const second = parseResult(
      await callTool(server, "send_to", {
        agent_id: "agent-1",
        text: "second observed loss",
        press_enter: true,
      }),
    );
    engine.setDeliveryVerifier(async () => ({
      outcome: "failed_confirmed" as const,
      reason: "composer_rejected_input",
    }));
    await engine.verifyPendingDeliveries();

    // Same signature: exactly one escalation reached the tracker, and the
    // receipt that did NOT reach it says so, with a reason.
    expect(filed).toHaveLength(1);
    const deduped = engine.getDeliveryReceipt(second.delivery_id);
    expect(deduped).toMatchObject({
      ticket_filed: true,
      ticket_escalated: false,
    });
    expect(deduped.ticket_escalation_declined_reason).toMatch(
      /already filed/i,
    );
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
    // T2 #471: deadline-elapsed verdicts are never escalated, deduped or not.
    expect(filed).toHaveLength(0);
  });

  it("returns a nonterminal wait_for delivery receipt with timed_out instead of rejecting", async () => {
    const client = new FakeAgentSurfaceClient();
    server = createVerifyServer(client);
    registerAgent(server);

    const sent = parseResult(
      await callTool(server, "send_to", {
        agent_id: "agent-1",
        text: "still waiting",
        press_enter: true,
      }),
    );
    expect(sent.delivery_state).toBe("pending_verify");

    const waitPromise = server._registeredTools.wait_for.handler(
      { delivery_id: sent.delivery_id, timeout_ms: 200 },
      {} as any,
    );
    await vi.advanceTimersByTimeAsync(300);
    const waited = await waitPromise;
    const parsed = parseResult(waited);

    expect(waited.isError).not.toBe(true);
    expect(parsed).toMatchObject({
      ok: true,
      delivery_id: sent.delivery_id,
      delivery_state: "pending_verify",
      terminal: false,
      timed_out: true,
    });
    expect(
      server._registeredTools.interact._engine.getDeliveryReceipt(
        sent.delivery_id,
      ),
    ).toMatchObject({
      delivery_state: "pending_verify",
      terminal: false,
    });
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

  it("does not advance or deadline-fail watched receipts when deliveryVerifier is null", async () => {
    const ticketDir = join(TEST_DIR, "tickets");
    const filed: unknown[] = [];
    writeFileSync(
      join(TEST_DIR, "delivery-receipts.json"),
      `${JSON.stringify([
        {
          delivery_id: "orphan-1",
          agent_id: "agent-1",
          text: "app-server has no verifier",
          press_enter: true,
          source_event: "send_to",
          delivery_state: "pending_verify",
          terminal: false,
          created_at: "2026-08-17T19:00:00.000Z",
          resolved_at: null,
          retry_count: 0,
          submit_verified: null,
          error: null,
          verify_deadline_at: "2026-08-17T19:50:00.000Z",
        },
      ])}\n`,
    );
    const client = new FakeAgentSurfaceClient();
    const stateMgr = new StateManager(TEST_DIR);
    const engine = new AgentEngine(
      stateMgr,
      new AgentRegistry(stateMgr, async () => []),
      client as any,
      {
        deliveryTicketDir: ticketDir,
        deliveryIssueFiler: async (ticket) => {
          filed.push(ticket);
        },
      },
    );
    try {
      expect(engine.getDeliveryReceipt("orphan-1")).toMatchObject({
        delivery_state: "pending_verify",
        terminal: false,
        verify_deadline_at: "2026-08-17T19:50:00.000Z",
      });

      await engine.verifyPendingDeliveries();

      expect(engine.getDeliveryReceipt("orphan-1")).toMatchObject({
        delivery_id: "orphan-1",
        delivery_state: "pending_verify",
        terminal: false,
        error: null,
      });
      expect(existsSync(ticketDir)).toBe(false);
      expect(filed).toHaveLength(0);
    } finally {
      engine.dispose();
    }
  });

  it("dedupes surface snapshots across pending deliveries in one verify sweep", async () => {
    const client = new FakeAgentSurfaceClient();
    server = createVerifyServer(client);
    registerAgent(server);

    parseResult(
      await callTool(server, "send_to", {
        agent_id: "agent-1",
        text: "first pending",
        press_enter: true,
      }),
    );
    parseResult(
      await callTool(server, "send_to", {
        agent_id: "agent-1",
        text: "second pending",
        press_enter: true,
      }),
    );

    const engine = server._registeredTools.interact._engine;
    expect(engine.listDeliveryReceipts()).toHaveLength(2);
    client.readScreenCalls = 0;
    await engine.verifyPendingDeliveries();
    expect(client.readScreenCalls).toBe(1);
  });

  it("backs off verify reads as the deadline recedes", async () => {
    let reads = 0;
    const client = new FakeAgentSurfaceClient();
    const stateMgr = new StateManager(TEST_DIR);
    const engine = new AgentEngine(
      stateMgr,
      new AgentRegistry(stateMgr, async () => []),
      client as any,
      {
        deliveryVerifyDeadlineMs: 10_000,
        deliverySnapshotReader: async () => {
          reads += 1;
          return { text: "Claude Code\n> leftover\n" };
        },
        deliveryVerifier: async () => ({ outcome: "pending" }),
      },
    );
    try {
      engine.acceptPendingVerify({
        delivery_id: "backoff-1",
        agent_id: "agent-1",
        text: "backoff pending",
        press_enter: true,
        source_event: "send_to",
        retry_count: 0,
      });

      await engine.verifyPendingDeliveries();
      expect(reads).toBe(1);

      await vi.advanceTimersByTimeAsync(6_000);
      await engine.verifyPendingDeliveries();
      expect(reads).toBe(1);
    } finally {
      engine.dispose();
    }
  });

  it("times out a hung delivery verifier so later sweeps can still run", async () => {
    let calls = 0;
    const client = new FakeAgentSurfaceClient();
    const stateMgr = new StateManager(TEST_DIR);
    const engine = new AgentEngine(
      stateMgr,
      new AgentRegistry(stateMgr, async () => []),
      client as any,
      {
        deliveryVerifyTimeoutMs: 50,
        deliveryVerifier: async () => {
          calls += 1;
          if (calls === 1) {
            return new Promise(() => {});
          }
          return { outcome: "delivered", submit_verified: true };
        },
      },
    );
    try {
      engine.acceptPendingVerify({
        delivery_id: "hung-1",
        agent_id: "agent-1",
        text: "hangs the verifier",
        press_enter: true,
        source_event: "send_to",
        retry_count: 0,
      });

      let settled = false;
      const first = engine.verifyPendingDeliveries().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(50);
      await first;
      expect(settled).toBe(true);
      expect(engine.getDeliveryReceipt("hung-1")).toMatchObject({
        delivery_state: "pending_verify",
        terminal: false,
      });

      await engine.verifyPendingDeliveries();
      expect(calls).toBe(2);
      expect(engine.getDeliveryReceipt("hung-1")).toMatchObject({
        delivery_id: "hung-1",
        delivery_state: "submitted",
        terminal: true,
        submit_verified: true,
      });
    } finally {
      engine.dispose();
    }
  });
});
