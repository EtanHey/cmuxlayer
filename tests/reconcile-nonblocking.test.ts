/**
 * #810 / CX-3 E5: a reconciler sweep must not hold the event loop.
 * The daemon serves every socket request on this loop, so one sweep that
 * blocks for hundreds of milliseconds delays every concurrent send.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { AgentEngine } from "../src/agent-engine.js";
import { AgentRegistry } from "../src/agent-registry.js";
import { StateManager } from "../src/state-manager.js";
import type { AgentRecord } from "../src/agent-types.js";
import type { CmuxClient } from "../src/cmux-client.js";
import type { CmuxSurface } from "../src/types.js";

const TEST_DIR = join(tmpdir(), `cmux-reconcile-nonblocking-${process.pid}`);
const AGENTS = 10;
const BUDGET_MS = 50;
const TRIALS = 3;

/**
 * #817: on a saturated machine the OS can deschedule this process, and that
 * shows up as event-loop delay no matter what the reconciler does. A reconciler
 * that really holds the loop does so in every trial; a scheduler spike hits one.
 * So the budget fails only when every independent trial exceeds it.
 */
function loopHeldInEveryTrial(trialMaxMs: number[], budgetMs: number): boolean {
  if (trialMaxMs.length === 0) throw new Error("no trials to judge");
  return trialMaxMs.every((maxMs) => maxMs > budgetMs);
}

// A full-height Claude Code pane: enough text that parsing is real work.
const SCREEN = [
  ...Array.from({ length: 180 }, (_, i) =>
    i % 3 === 0
      ? `⏺ Bash(bun run test -- tests/file-${i}.test.ts) … ${"x".repeat(80)}`
      : `  ⎿  line ${i}: ${"lorem ipsum dolor sit amet ".repeat(4)}`,
  ),
  "✻ Working… (1m 02s · ↓ 3.2k tokens · esc to interrupt)",
  "╭────────────────────────────────────────────────────────╮",
  "│ >                                                      │",
  "╰────────────────────────────────────────────────────────╯",
  "  ⏵⏵ bypass permissions on · 42% context left",
].join("\n");

function record(index: number): AgentRecord {
  return {
    agent_id: `claude-cmuxlayer-${index}`,
    surface_id: `surface:${index}`,
    workspace_id: "workspace:test",
    state: "working",
    repo: "cmuxlayer",
    model: "opus",
    cli: "claude",
    cli_session_id: null,
    task_summary: `task ${index}`,
    pid: null,
    version: 1,
    created_at: "2026-09-26T00:00:00Z",
    updated_at: "2026-09-26T00:00:00Z",
    error: null,
    parent_agent_id: null,
    spawn_depth: 1,
    role: "worker",
    deletion_intent: false,
    quality: "unknown",
    max_cost_per_agent: null,
  };
}

describe("loopHeldInEveryTrial (#817: one scheduler spike is not a held loop)", () => {
  it("passes when only one trial spikes over the budget", () => {
    expect(loopHeldInEveryTrial([79.6, 11.0, 12.3], BUDGET_MS)).toBe(false);
  });

  it("passes when two of three trials spike", () => {
    expect(loopHeldInEveryTrial([79.6, 64.0, 12.3], BUDGET_MS)).toBe(false);
  });

  it("fails when every trial exceeds the budget", () => {
    expect(loopHeldInEveryTrial([79.6, 64.0, 51.0], BUDGET_MS)).toBe(true);
  });

  it("treats a trial exactly at the budget as within it", () => {
    expect(loopHeldInEveryTrial([50, 50, 50], BUDGET_MS)).toBe(false);
  });

  it("refuses to judge zero trials", () => {
    expect(() => loopHeldInEveryTrial([], BUDGET_MS)).toThrow();
  });
});

describe("reconciler sweep keeps the event loop responsive (#810)", () => {
  let stateMgr: StateManager;
  let engine: AgentEngine;
  let client: CmuxClient;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    stateMgr = new StateManager(TEST_DIR);
    const surfaces: CmuxSurface[] = [];
    for (let index = 0; index < AGENTS; index += 1) {
      stateMgr.writeState(record(index));
      surfaces.push({ ref: `surface:${index}`, title: "", type: "terminal", index, selected: false });
    }
    client = {
      listWorkspaces: vi.fn(async () => ({
        workspaces: [{ ref: "workspace:test", title: "t", index: 0, selected: true, pinned: false }],
      })),
      listPanes: vi.fn(async () => ({
        workspace_ref: "workspace:test",
        window_ref: "window:1",
        panes: [{
          ref: "pane:1", index: 0, focused: true,
          surface_count: surfaces.length,
          surface_refs: surfaces.map((s) => s.ref),
          selected_surface_ref: surfaces[0]!.ref,
        }],
      })),
      listPaneSurfaces: vi.fn(async () => ({
        workspace_ref: "workspace:test", window_ref: "window:1", pane_ref: "pane:1", surfaces,
      })),
      readScreen: vi.fn(async (surface: string) => ({
        surface, text: SCREEN, lines: 200, scrollback_used: false,
      })),
      setStatus: vi.fn(async () => undefined),
      setStatuses: vi.fn(async () => undefined),
      clearStatus: vi.fn(async () => undefined),
      log: vi.fn(async () => undefined),
      notify: vi.fn(async () => undefined),
      notifyLifecycleEvent: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
      sendKey: vi.fn(async () => undefined),
      identify: vi.fn(async () => ({})),
      getTransportHealth: () => ({ mode: "socket", degraded: false }),
    } as unknown as CmuxClient;
    const registry = new AgentRegistry(stateMgr, async () => surfaces);
    engine = new AgentEngine(stateMgr, registry, client, {
      spawnPreflight: async () => {},
      sessionIdentityResolver: () => null,
      sweepDebugLog: () => {},
      inboxOpts: { baseDir: join(TEST_DIR, "inbox") },
    });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it(`a ${AGENTS}-agent sweep never holds the loop for ${BUDGET_MS} ms`, async () => {
    await engine.getRegistry().reconstitute();
    await engine.runSweep(); // warm module and JIT state; measure steady state
    const readScreen = client.readScreen as ReturnType<typeof vi.fn>;
    const trialMaxMs: number[] = [];
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const readsBefore = readScreen.mock.calls.length;
      const delay = monitorEventLoopDelay({ resolution: 1 });
      delay.enable();
      const startedAt = performance.now();
      try {
        await engine.runSweep();
        await engine.runSweep();
        await engine.runSweep();
      } finally {
        delay.disable();
      }
      // Proof of work: every sweep read every agent's screen (not a no-op sweep).
      expect(readScreen.mock.calls.length - readsBefore).toBeGreaterThanOrEqual(
        AGENTS * 3,
      );
      const maxMs = delay.max / 1e6;
      trialMaxMs.push(maxMs);
      const sweepMs = (performance.now() - startedAt) / 3;
      process.stderr.write(`[#810] trial ${trial + 1}/${TRIALS}: sweep ${sweepMs.toFixed(1)} ms avg, event_loop_delay_max ${maxMs.toFixed(1)} ms\n`);
    }
    expect(
      loopHeldInEveryTrial(trialMaxMs, BUDGET_MS),
      `every trial exceeded ${BUDGET_MS} ms: ${trialMaxMs.map((ms) => ms.toFixed(1)).join(", ")}`,
    ).toBe(false);
  }, 30_000);
});
