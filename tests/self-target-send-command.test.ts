import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../src/server.js";
import { runWithCallerContext } from "../src/caller-context.js";
import { StateManager } from "../src/state-manager.js";
import type { AgentRecord } from "../src/agent-types.js";
import { TEST_SURFACE_OBSERVER_OWNER } from "./helpers/test-surface-observer.js";

// #805 specimen: orcClaude sent `/mcp reconnect voicelayer` to its OWN live
// surface and got "Stable surface UUID 4779… changed or disappeared during
// send_command; refusing terminal mutation."
const SELF_UUID = "47794976-E567-4358-91CF-D1608A7CA31F";
const OTHER_UUID = "0C1A6B2E-5D4F-4E3A-9B8C-7D6E5F4A3B2C";
const COMMAND = "/mcp reconnect voicelayer";

class SeatClient {
  readonly texts: string[] = [];
  readonly keys: string[] = [];
  private typed = "";
  listPanesCalls = 0;
  /** From this listPanes call on, surface:1 reports a different stable UUID. */
  swapUuidFromCall = Number.POSITIVE_INFINITY;
  private uuid() {
    return this.listPanesCalls >= this.swapUuidFromCall ? OTHER_UUID : SELF_UUID;
  }
  async listWindows() {
    return { windows: [{ ref: "window:1", index: 0, selected: true }] };
  }
  async listWorkspaces() {
    return {
      workspaces: [
        { ref: "workspace:1", title: "Main", index: 0, selected: true, pinned: false },
      ],
    };
  }
  async listPanes() {
    this.listPanesCalls += 1;
    return {
      workspace_ref: "workspace:1",
      window_ref: "window:1",
      panes: [
        {
          ref: "pane:1",
          index: 0,
          focused: true,
          surface_count: 1,
          surface_refs: ["surface:1"],
          surface_ids: [this.uuid()],
          selected_surface_ref: "surface:1",
        },
      ],
    };
  }
  async listPaneSurfaces() {
    return {
      workspace_ref: "workspace:1",
      window_ref: "window:1",
      pane_ref: "pane:1",
      surfaces: [
        { ref: "surface:1", id: this.uuid(), title: "orcClaude", type: "terminal", index: 0, selected: true },
      ],
    };
  }
  async send(_surface: string, text: string) {
    this.texts.push(text);
    this.typed += text;
  }
  async sendKey(_surface: string, key: string) {
    this.keys.push(key);
  }
  // The seat is mid-turn (blocked in this very tool call): Claude keeps the
  // input in its composer/queue, so no submit evidence ever appears.
  async readScreen(surface: string, opts?: { lines?: number }) {
    return {
      surface,
      text: `Claude Code\n✻ Working… (esc to interrupt)\n❯ ${this.typed}\n`,
      lines: opts?.lines ?? 30,
      scrollback_used: false,
    };
  }
  async renameTab() {}
}

function seatRecord(): AgentRecord {
  const now = "2026-09-25T04:35:00.000Z";
  return {
    agent_id: "orcClaude",
    surface_id: "surface:1",
    surface_uuid: SELF_UUID,
    workspace_id: "workspace:1",
    state: "idle",
    repo: "orchestrator",
    model: "claude-opus-5-5",
    cli: "claude",
    cli_session_id: null,
    task_summary: "orc seat",
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
  } as AgentRecord;
}

function parse(result: any): Record<string, any> {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

describe("send_command to the caller's own surface (#805)", () => {
  let stateDir = "";
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "cmuxlayer-self-target-"));
    new StateManager(stateDir).writeState(seatRecord());
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function server(epochFor: (client: SeatClient) => string | null = () => `${TEST_SURFACE_OBSERVER_OWNER}@test`) {
    const client = new SeatClient();
    const mcp = createServer({
      client: client as any,
      stateDir,
      skipAgentLifecycle: true,
      surfaceObserverOwnerIdProvider: () => TEST_SURFACE_OBSERVER_OWNER,
      surfaceObserverEpochProvider: () => epochFor(client),
    });
    return { client, sendCommand: (mcp as any)._registeredTools["send_command"] };
  }

  it("types and submits the command once, and reports self_target instead of an unverifiable submit", async () => {
    vi.useFakeTimers();
    const { client, sendCommand } = server();
    const pending = runWithCallerContext(
      { surfaceId: SELF_UUID, workspaceId: "workspace:1" },
      () => sendCommand.handler({ surface: "surface:1", command: COMMAND }, {}),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;
    const parsed = parse(result);

    expect(result.isError).toBeFalsy();
    expect(parsed.ok).toBe(true);
    expect(parsed.self_target).toBe(true);
    expect(parsed.delivery_state).toBe("typed");
    expect(parsed.submitted).toBe(false);
    expect(parsed.submit_verified).toBeNull();
    expect(parsed.self_target_note).toBe(
      "Typed into the caller's own surface: the caller's turn is blocked in this call, so the command is expected to run when that turn ends; submit is not verifiable from inside it.",
    );
    expect(client.texts.join("")).toBe(COMMAND);
    expect(client.keys.filter((key) => key === "return" || key === "enter")).toHaveLength(1);
  });


  it("does not treat a ref-shaped caller id as the self target of a UUID-bound route", async () => {
    vi.useFakeTimers();
    const { sendCommand } = server();
    const pending = runWithCallerContext(
      { surfaceId: "surface:1", workspaceId: "workspace:1" },
      () => sendCommand.handler({ surface: "surface:1", command: COMMAND }, {}),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const parsed = parse(await pending);

    expect(parsed.self_target).toBeUndefined();
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/Enter submit could not be verified/);
  });

  it("still refuses real UUID drift with the changed-or-disappeared message", async () => {
    const { client, sendCommand } = server();
    // The route binds SELF_UUID; by the pre-mutation re-read surface:1 is a
    // different surface.
    client.swapUuidFromCall = 2;
    const parsed = parse(
      await runWithCallerContext(
        { surfaceId: SELF_UUID, workspaceId: "workspace:1" },
        () => sendCommand.handler({ surface: "surface:1", command: COMMAND }, {}),
      ),
    );

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe(
      `Stable surface UUID ${SELF_UUID} changed or disappeared during send_command; refusing terminal mutation.`,
    );
    expect(client.texts).toEqual([]);
  });

  it("names a failed topology re-read as such, not as UUID drift", async () => {
    // The route's topology read completes; the observer goes away during
    // the pre-mutation re-read (the second listPanes), so that read is null.
    const { client, sendCommand } = server((c) =>
      c.listPanesCalls >= 2 ? null : `${TEST_SURFACE_OBSERVER_OWNER}@test`,
    );
    const parsed = parse(
      await sendCommand.handler({ surface: "surface:1", command: "echo hi" }, {}),
    );

    expect(client.listPanesCalls).toBe(2);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/could not re-read surface topology/i);
    expect(parsed.error).not.toMatch(/changed or disappeared/);
    expect(client.texts).toEqual([]);
  });
});
