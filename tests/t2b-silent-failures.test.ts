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
 *
 * Every test here fails against the pre-fix tree; see the PR body for the
 * red run.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../src/server.js";
import type { ExecFn } from "../src/cmux-client.js";
import type { AgentRecord } from "../src/agent-types.js";
import {
  getEngine,
  getTool,
  type ToolCallResult,
} from "./helpers/mcp-tool-harness.js";

/**
 * Both defects are about what a FAILING receipt says, so these tests read the
 * payload of ok and errored results alike — `parseToolResult` throws on the
 * error results half of this suite exists to inspect.
 */
function payload(result: ToolCallResult): Record<string, unknown> {
  return (result.structuredContent ??
    JSON.parse(result.content[0]?.text ?? "{}")) as Record<string, unknown>;
}

const SURFACE = "surface:89";
const SURFACE_UUID = "80A5FA59-16D7-41A0-93D4-596423BFB3E3";
const WITNESS_SURFACE = "surface:witness";
const WITNESS_UUID = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";

const IDLE_CLAUDE_SCREEN = "Claude Code\nWhat can I help you with?\n> ";
const POPULATED_CLAUDE_SCREEN =
  "Claude Code\nWhat can I help you with?\n> lead: please pick up lane T4";
const WORKING_CLAUDE_SCREEN = "Claude Code\n✻ Working (3s · esc to interrupt)";
// Working, with the composer visibly empty: the submit was taken up.
const WORKING_AND_CLEARED_CLAUDE_SCREEN =
  "Claude Code\n✻ Working (3s · esc to interrupt)\n> ";
// The reported scenario, and the fixture the first round of this lane missed:
// the recipient is busy on its previous turn WHILE the relayed message sits
// unsent in its composer. Status and composer disagree, and the composer wins.
const WORKING_AND_POPULATED_CLAUDE_SCREEN =
  "Claude Code\n✻ Working (3s · esc to interrupt)\n> lead: please pick up lane T4";
const CODEX_PERMISSION_PROMPT_SCREEN = [
  ">_ OpenAI Codex",
  "Do you want to allow this command?",
  "[y/n]",
  "gpt-5.6-sol high · ~/Gits/cmuxlayer",
].join("\n");
const CODEX_BUSY_AFTER_PERMISSION_SCREEN = [
  ">_ OpenAI Codex",
  "Working (3s • esc to interrupt)",
  "› Review this repository",
  "gpt-5.6-sol high · ~/Gits/cmuxlayer",
].join("\n");

/**
 * Minimal cmux CLI mock. `screen` is a live box so a test can change what the
 * pane shows after the key is dispatched, which is the whole point of a
 * submit-verification test. Closing a surface removes it from the topology, so
 * a test can assert the pane is really gone rather than only that a command ran.
 */
function makeExec(opts?: {
  screen?: () => string;
  onSendKey?: (key: string) => void;
  closeSurfaceFails?: boolean;
  /** Model a cmux that accepts close-surface but keeps listing the pane. */
  closeLeavesSurfaceListed?: boolean;
  /** Keep a second surface so absence of the target is authoritative. */
  witnessSurface?: boolean;
  /** Model transient topology failure while verifying agent-scope closure. */
  surfaceEnumerationFails?: boolean;
}): ExecFn & { calls: string[][] } {
  const calls: string[][] = [];
  let surfaceLive = true;
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
      if (opts?.surfaceEnumerationFails) {
        throw new Error("cmux list-panes: transient enumeration failure");
      }
      const surfaceRefs = [
        ...(surfaceLive ? [SURFACE] : []),
        ...(opts?.witnessSurface ? [WITNESS_SURFACE] : []),
      ];
      const surfaceIds = [
        ...(surfaceLive ? [SURFACE_UUID] : []),
        ...(opts?.witnessSurface ? [WITNESS_UUID] : []),
      ];
      return {
        stdout: JSON.stringify({
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          panes: [
            {
              ref: "pane:1",
              workspace: "workspace:1",
              focused: true,
              surface_count: surfaceRefs.length,
              surface_refs: surfaceRefs,
              ...(opts?.witnessSurface ? { surface_ids: surfaceIds } : {}),
            },
          ],
        }),
        stderr: "",
      };
    }
    if (args.includes("list-pane-surfaces")) {
      return {
        stdout: JSON.stringify({
          pane_ref: "pane:1",
          workspace_ref: "workspace:1",
          surfaces: [
            ...(surfaceLive
              ? [
                  {
                    ...(opts?.witnessSurface ? { id: SURFACE_UUID } : {}),
                    ref: SURFACE,
                    pane: "pane:1",
                    workspace: "workspace:1",
                    title: "golemsClaude",
                    type: "terminal",
                    selected: true,
                  },
                ]
              : []),
            ...(opts?.witnessSurface
              ? [
                  {
                    id: WITNESS_UUID,
                    ref: WITNESS_SURFACE,
                    pane: "pane:1",
                    workspace: "workspace:1",
                    title: "witness shell",
                    type: "terminal",
                    selected: !surfaceLive,
                  },
                ]
              : []),
          ],
        }),
        stderr: "",
      };
    }
    if (args.includes("read-screen")) {
      return {
        stdout: JSON.stringify({
          surface: SURFACE,
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
    if (args.includes("close-surface")) {
      if (opts?.closeSurfaceFails) {
        throw new Error("cmux close-surface: pane is not closable");
      }
      if (!opts?.closeLeavesSurfaceListed) {
        surfaceLive = false;
      }
      return { stdout: "{}", stderr: "" };
    }
    return { stdout: "{}", stderr: "" };
  }) as ExecFn & { calls: string[][] };
  exec.calls = calls;
  return exec;
}

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
    selfRegistrationSessionResolver: (agent) =>
      agent.cli_session_id
        ? {
            session_id: agent.cli_session_id,
            path: agent.cli_session_path ?? null,
            pid: process.pid,
            pid_registered_at: new Date().toISOString(),
          }
        : null,
    // Model CI/fresh-clone CLI mode explicitly. Ambient access to a developer's
    // real cmux socket must not decide whether teardown receipts are truthful.
    surfaceObserverOwnerIdProvider: () => null,
    surfaceObserverEpochProvider: () => null,
  }) as unknown;
}

async function sendKey(server: unknown, key: string): Promise<ToolCallResult> {
  return (await getTool(server, "send_to").handler(
    { mode: "key", target: SURFACE, key },
    {},
  )) as ToolCallResult;
}

describe("#484 — send_to(mode:key) must not report success for an unattempted submit", () => {
  it.each(["return", "Return", "enter", "Enter", "KPEnter", "ctrl-m"])(
    "recognises %j as a submit key and states that it reached the pane",
    async (key) => {
      const exec = makeExec({ screen: () => WORKING_AND_CLEARED_CLAUDE_SCREEN });
      const result = await sendKey(makeServer(exec), key);

      const data = payload(result);
      expect(result.isError).toBeUndefined();
      expect(data.submit_attempted).toBe(true);
      expect(data.key_dispatched).toBe(true);
    },
  );

  it("dispatches the caller's key verbatim rather than rewriting it for cmux", async () => {
    // The receipt is what had to become truthful; the bytes cmux receives are
    // not this lane's to change, and "\n" in particular is shift+enter.
    const exec = makeExec({ screen: () => WORKING_AND_CLEARED_CLAUDE_SCREEN });
    const result = await sendKey(makeServer(exec), "Enter");

    expect(result.isError).toBeUndefined();
    expect(payload(result).key).toBe("Enter");
    expect(
      exec.calls.some(
        (args) => args.includes("send-key") && args.includes("Enter"),
      ),
    ).toBe(true);
  });

  it("verifies the submit landed when the composer clears", async () => {
    let pressed = false;
    const exec = makeExec({
      screen: () =>
        pressed ? WORKING_AND_CLEARED_CLAUDE_SCREEN : POPULATED_CLAUDE_SCREEN,
      onSendKey: () => {
        pressed = true;
      },
    });

    const result = await sendKey(makeServer(exec), "return");

    const data = payload(result);
    expect(result.isError).toBeUndefined();
    expect(data.submit_verified).toBe(true);
    expect(data.submit_verification_reason).toBeNull();
  });

  it("does not verify Return when the composer was already empty", async () => {
    const exec = makeExec({
      screen: () => WORKING_AND_CLEARED_CLAUDE_SCREEN,
    });

    const result = await sendKey(makeServer(exec), "return");

    const data = payload(result);
    expect(result.isError).toBeUndefined();
    expect(data.ok).toBe(true);
    expect(data.key_dispatched).toBe(true);
    expect(data.submit_verified).toBeNull();
    expect(data.submit_verification_reason).toBe("submit_evidence_absent");
    expect(data.WARNING).toMatch(/submit not verified/i);
  });

  it("verifies Return when a Codex permission prompt is dismissed", async () => {
    let approved = false;
    const exec = makeExec({
      screen: () =>
        approved
          ? CODEX_BUSY_AFTER_PERMISSION_SCREEN
          : CODEX_PERMISSION_PROMPT_SCREEN,
      onSendKey: () => {
        approved = true;
      },
    });

    const result = await sendKey(makeServer(exec), "return");

    const data = payload(result);
    expect(result.isError).toBeUndefined();
    expect(data.submit_verified).toBe(true);
    expect(data.submit_verification_reason).toBeNull();
  });

  it("does not infer key failure from a composer that remains populated", async () => {
    // The exact #484 shape: a lead typed a message and it sat unsent. Key mode
    // did not write that payload, so unchanged contents are absence of evidence.
    const exec = makeExec({ screen: () => POPULATED_CLAUDE_SCREEN });

    const result = await sendKey(makeServer(exec), "return");

    const data = payload(result);
    expect(result.isError).toBeUndefined();
    expect(data.ok).toBe(true);
    expect(data.submit_verified).toBeNull();
    expect(data.submit_verification_reason).toBe("submit_evidence_absent");
    expect(data.WARNING).toMatch(/submit not verified/i);
    expect(data.WARNING).toMatch(/do not treat.*submission confirmation/i);
  });

  it("does not treat unchanged working state as submit evidence", async () => {
    // The reported target was BUSY: working on its previous turn while the
    // relayed message sat unsent. Reading "working" as proof of submit reported
    // submit_verified:true for a message still visible on screen — worse than
    // the null it replaced, because null admits ignorance and true asserts an
    // observation the pane contradicts.
    const exec = makeExec({
      screen: () => WORKING_AND_POPULATED_CLAUDE_SCREEN,
    });

    const result = await sendKey(makeServer(exec), "return");

    const data = payload(result);
    expect(result.isError).toBeUndefined();
    expect(data.ok).toBe(true);
    expect(data.submit_verified).toBeNull();
    expect(data.submit_verification_reason).toBe("submit_evidence_absent");
  });

  it("will not treat a working status as proof when the composer cannot be read", async () => {
    // A composer that renders boxed reads as unreadable, and the reported
    // target was ALREADY working — so status cannot tell "my submit started a
    // turn" from "a turn was already running". Unconfirmed says unconfirmed.
    const exec = makeExec({ screen: () => WORKING_CLAUDE_SCREEN });

    const result = await sendKey(makeServer(exec), "return");

    const data = payload(result);
    expect(result.isError).toBeUndefined();
    expect(data.key_dispatched).toBe(true);
    expect(data.submit_verified).toBeNull();
    expect(data.submit_verification_reason).toBe("submit_evidence_absent");
  });

  it("leaves non-submit keys unverified but still states that they were dispatched", async () => {
    const exec = makeExec({ screen: () => POPULATED_CLAUDE_SCREEN });

    const result = await sendKey(makeServer(exec), "escape");

    const data = payload(result);
    expect(result.isError).toBeUndefined();
    expect(data.submit_attempted).toBe(false);
    expect(data.key_dispatched).toBe(true);
    expect(data.submit_verified).toBeNull();
  });
});

function seedAgent(server: unknown, overrides: Partial<AgentRecord> = {}) {
  const engine = getEngine(server) as unknown as {
    stateMgr: { writeState(record: AgentRecord): unknown };
    getRegistry(): { set(id: string, record: AgentRecord): unknown };
  };
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

async function seedProductionLiveProcess(
  server: unknown,
  overrides: Partial<AgentRecord> = {},
): Promise<AgentRecord> {
  const targetState = overrides.state ?? "working";
  const seeded = seedAgent(server, {
    cli_session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
    surface_uuid: SURFACE_UUID,
    surface_provenance: "cmuxlayer_spawn",
    pid: null,
    ...overrides,
    state: "working",
  });
  const engine = getEngine(server) as unknown as {
    captureBootSessionId(id: string): Promise<AgentRecord | null>;
    stateMgr: {
      transition(id: string, state: string): AgentRecord;
    };
    getRegistry(): { set(id: string, record: AgentRecord): unknown };
  };
  const captured = await engine.captureBootSessionId(seeded.agent_id);
  if (!captured?.pid) throw new Error("production PID capture failed");
  if (captured.state === targetState) return captured;
  const transitioned = engine.stateMgr.transition(seeded.agent_id, targetState);
  engine.getRegistry().set(transitioned.agent_id, transitioned);
  return transitioned;
}

async function listSurfaceRefs(server: unknown): Promise<string[]> {
  const result = (await getTool(server, "list_surfaces").handler(
    {},
    {},
  )) as ToolCallResult;
  const text = JSON.stringify(payload(result));
  return text.includes(SURFACE) ? [SURFACE] : [];
}

describe("#485 — close_surface(scope:agent) must close the surface or say it did not", () => {
  it("closes the pane under agent scope — the surface is gone from list_surfaces", async () => {
    // The mechanism (confirmed in source, server.ts:9492-9510 pre-fix):
    // scope:"agent" delegated to stop_agent and NO path in that branch closed
    // the surface, so ok:true/state:"done" was truthful about the agent and
    // silent about the pane. Asserted against list_surfaces, not the receipt.
    const exec = makeExec({ screen: () => IDLE_CLAUDE_SCREEN });
    const server = makeServer(exec);
    const record = seedAgent(server);
    expect(await listSurfaceRefs(server)).toContain(SURFACE);

    const result = (await getTool(server, "close_surface").handler(
      { scope: "agent", agent_id: record.agent_id },
      {},
    )) as ToolCallResult;

    expect(result.isError).toBeUndefined();
    expect(await listSurfaceRefs(server)).not.toContain(SURFACE);
    expect(payload(result).surface_closed).toBe(true);
  });

  it("never reads like a completed close while the pane is still listed", async () => {
    // cmux accepted the command; the pane is still there. The receipt must not
    // claim a closure it can see did not happen.
    const exec = makeExec({
      screen: () => IDLE_CLAUDE_SCREEN,
      closeLeavesSurfaceListed: true,
    });
    const server = makeServer(exec);
    const record = seedAgent(server);

    const result = (await getTool(server, "close_surface").handler(
      { scope: "agent", agent_id: record.agent_id },
      {},
    )) as ToolCallResult;

    const data = payload(result);
    expect(data.surface_closed).toBe(false);
    expect(String(data.WARNING)).toMatch(/still listed|not.*closed/i);
    expect(await listSurfaceRefs(server)).toContain(SURFACE);
  });

  it("stops reporting the agent as working once its close has been acknowledged", async () => {
    // golemsClaude's datum, and the one that stands regardless of latency:
    // list_agents reported an agent "working" AFTER its close was acknowledged.
    // A state claim inside the settle window is still a state claim, and it was
    // wrong, and independent of which scope was used. Driven through
    // scope:"surface" because that is where the record marking lives;
    // scope:"agent" routes into the same code.
    const exec = makeExec({ screen: () => IDLE_CLAUDE_SCREEN });
    const server = makeServer(exec);
    const record = seedAgent(server, { state: "working" });

    const closeRes = (await getTool(server, "close_surface").handler(
      { scope: "surface", surface: SURFACE, force: true },
      {},
    )) as ToolCallResult;
    expect(payload(closeRes).surface_closed).toBe(true);

    const listed = (await getTool(server, "list_agents").handler(
      {},
      {},
    )) as ToolCallResult;
    const agents = (payload(listed).agents ?? []) as Array<{
      agent_id: string;
      state?: { value?: string };
    }>;
    // Whether the closed agent is still listed at all depends on when the
    // lifecycle sweep runs, so do not pin that. The claim under test is the
    // STATE: nothing may report this agent as working once its close was
    // acknowledged. Checked at the record too, so an absent row cannot make
    // this pass vacuously.
    const closed = agents.find((a) => a.agent_id === record.agent_id);
    expect(closed?.state?.value).not.toBe("working");
    const engine = getEngine(server) as unknown as {
      getAgentState(id: string): { state?: string } | null;
    };
    expect(engine.getAgentState(record.agent_id)?.state).not.toBe("working");
  });

  it("refuses to report success when the agent stopped but the pane survived", async () => {
    const exec = makeExec({
      screen: () => IDLE_CLAUDE_SCREEN,
      closeSurfaceFails: true,
    });
    const server = makeServer(exec);
    const record = seedAgent(server);

    const result = (await getTool(server, "close_surface").handler(
      { scope: "agent", agent_id: record.agent_id },
      {},
    )) as ToolCallResult;

    const data = payload(result);
    expect(result.isError).toBe(true);
    expect(data.ok).toBe(false);
    expect(data.agent_stopped).toBe(true);
    expect(data.surface_closed).toBe(false);
    expect(String(data.error)).toMatch(/surface/i);
    expect(await listSurfaceRefs(server)).toContain(SURFACE);
  });

  it("does not report a surface closed when topology enumeration failed", async () => {
    const exec = makeExec({
      screen: () => IDLE_CLAUDE_SCREEN,
      surfaceEnumerationFails: true,
    });
    const server = makeServer(exec);
    const record = seedAgent(server);

    const result = (await getTool(server, "close_surface").handler(
      { scope: "agent", agent_id: record.agent_id },
      {},
    )) as ToolCallResult;

    const data = payload(result);
    expect(result.isError).toBe(true);
    expect(data.agent_stopped).toBe(true);
    expect(data.surface_closed).toBe(false);
    expect(String(data.error)).toMatch(/enumerat|verify.*surface/i);
    expect(exec.calls.some((args) => args.includes("close-surface"))).toBe(false);
  });

  it("states plainly that there was no surface to close rather than implying one closed", async () => {
    const exec = makeExec({ screen: () => IDLE_CLAUDE_SCREEN });
    const server = makeServer(exec);
    const record = seedAgent(server, {
      agent_id: "golemsClaude-c7738dab",
      surface_id: "",
    });

    const result = (await getTool(server, "close_surface").handler(
      { scope: "agent", agent_id: record.agent_id },
      {},
    )) as ToolCallResult;

    const data = payload(result);
    expect(result.isError).toBeUndefined();
    expect(data.surface_closed).toBe(false);
    expect(data.surface_close_skipped).toBe("no_surface_bound");
  });

  it("does not escalate to a forced close: an unforced call leaves a live agent's pane alone", async () => {
    // Reviewer catch: stop_agent has no liveness refusal of its own, so forcing
    // the inner close unconditionally would let an UNFORCED close_surface tear
    // down a still-live agent's pane through a guard that could never fire for
    // this scope. The caller's own force is passed through instead.
    const exec = makeExec({ screen: () => WORKING_CLAUDE_SCREEN });
    const server = makeServer(exec);
    const record = seedAgent(server, { state: "working" });

    const result = (await getTool(server, "close_surface").handler(
      { scope: "agent", agent_id: record.agent_id },
      {},
    )) as ToolCallResult;

    const data = payload(result);
    expect(data.surface_closed).toBe(false);
    expect(await listSurfaceRefs(server)).toContain(SURFACE);
  });

  it("P0 D4a an unforced agent close leaves both the live agent and its pane alone", async () => {
    // The agent-scope liveness check and the surface-scope cross-record check
    // remain independent; neither escalates an unforced request.
    const exec = makeExec({
      screen: () => WORKING_CLAUDE_SCREEN,
      witnessSurface: true,
    });
    const server = makeServer(exec);
    const record = await seedProductionLiveProcess(server);

    expect(() => process.kill(process.pid, 0)).not.toThrow();

    const result = (await getTool(server, "close_surface").handler(
      { scope: "agent", agent_id: record.agent_id },
      {},
    )) as ToolCallResult;

    const data = payload(result);
    expect(result.isError).toBe(true);
    expect(data.ok).toBe(false);
    expect(data.agent_stopped).toBe(false);
    expect(data.surface_closed).toBe(false);
    expect(await listSurfaceRefs(server)).toContain(SURFACE);
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });

  it("harvests a terminal agent pane without signalling its intentionally live process", async () => {
    const exec = makeExec({
      screen: () => IDLE_CLAUDE_SCREEN,
      witnessSurface: true,
    });
    const server = makeServer(exec);
    const productionRecord = await seedProductionLiveProcess(server, {
      state: "done",
    });
    const engine = getEngine(server) as unknown as {
      stateMgr: {
        updateRecord(id: string, patch: Partial<AgentRecord>): AgentRecord;
      };
      getRegistry(): { set(id: string, record: AgentRecord): unknown };
    };
    const record = engine.stateMgr.updateRecord(productionRecord.agent_id, {
      surface_uuid: null,
    });
    engine.getRegistry().set(record.agent_id, record);

    expect(record).toMatchObject({ state: "done", pid: process.pid });
    const result = (await getTool(server, "close_surface").handler(
      { scope: "agent", agent_id: record.agent_id },
      {},
    )) as ToolCallResult;

    expect(result.isError).toBeUndefined();
    expect(payload(result)).toMatchObject({
      agent_stopped: true,
      surface_closed: true,
    });
    expect(await listSurfaceRefs(server)).not.toContain(SURFACE);
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });

  it("does not let agent scope bypass a different live record backing the surface", async () => {
    const exec = makeExec({ screen: () => WORKING_CLAUDE_SCREEN });
    const server = makeServer(exec);
    const target = seedAgent(server, {
      agent_id: "golemsClaude-terminal-target",
      state: "done",
      surface_uuid: null,
    });
    seedAgent(server, {
      agent_id: "golemsClaude-live-backing-record",
      state: "working",
      surface_uuid: null,
    });

    const result = (await getTool(server, "close_surface").handler(
      { scope: "agent", agent_id: target.agent_id },
      {},
    )) as ToolCallResult;

    expect(result.isError).toBe(true);
    expect(String(payload(result).error)).toContain(
      "golemsClaude-live-backing-record",
    );
    expect(await listSurfaceRefs(server)).toContain(SURFACE);
  });

  it("P0 D4b does not call a just-observed stable UUID stale after stopping the agent", async () => {
    const exec = makeExec({
      screen: () => WORKING_CLAUDE_SCREEN,
      witnessSurface: true,
    });
    const server = makeServer(exec);
    const record = seedAgent(server, {
      state: "working",
      surface_uuid: SURFACE_UUID,
    });

    const result = (await getTool(server, "close_surface").handler(
      { scope: "agent", agent_id: record.agent_id },
      {},
    )) as ToolCallResult;
    const data = payload(result);

    expect(String(data.error ?? data.surface_close_error ?? "")).not.toMatch(
      /stable surface UUID.*(?:not live|no longer live)/i,
    );
  });

  it("P0 D4c reports the surface closed when an immediate listing proves it is gone", async () => {
    const exec = makeExec({
      screen: () => WORKING_CLAUDE_SCREEN,
      witnessSurface: true,
    });
    const server = makeServer(exec);
    const record = seedAgent(server, {
      state: "working",
      surface_uuid: SURFACE_UUID,
    });

    const result = (await getTool(server, "close_surface").handler(
      { scope: "agent", agent_id: record.agent_id },
      {},
    )) as ToolCallResult;
    const data = payload(result);

    expect(await listSurfaceRefs(server)).not.toContain(SURFACE);
    expect(data.surface_closed).toBe(true);
  });

  it("refuses socketless teardown of a surface owned by a different observer", async () => {
    const exec = makeExec({
      screen: () => WORKING_CLAUDE_SCREEN,
      witnessSurface: true,
    });
    const server = makeServer(exec);
    const record = seedAgent(server, {
      state: "working",
      surface_uuid: SURFACE_UUID,
      surface_observer_id: "cmux:/tmp/observer-b.sock",
    });

    const result = (await getTool(server, "close_surface").handler(
      { scope: "agent", agent_id: record.agent_id },
      {},
    )) as ToolCallResult;

    expect(result.isError).toBe(true);
    expect(String(payload(result).error)).toMatch(/observer|ownership/i);
    expect(await listSurfaceRefs(server)).toContain(SURFACE);
    expect(exec.calls.some((args) => args.includes("close-surface"))).toBe(false);
  });

  it("cross-checks scope=workspace: the delegate really deletes, and says so", async () => {
    const exec = makeExec({ screen: () => IDLE_CLAUDE_SCREEN });
    const server = makeServer(exec);

    const result = (await getTool(server, "close_surface").handler(
      { scope: "workspace", workspace: "workspace:1", force: true },
      {},
    )) as ToolCallResult;

    const data = payload(result);
    expect(result.isError).toBeUndefined();
    expect(data.workspace_deleted).toBe(true);
    expect(
      exec.calls.some(
        (args) => args.includes("workspace") && args.includes("close"),
      ),
    ).toBe(true);
  });
});
