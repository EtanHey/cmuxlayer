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

/**
 * #817 rows 2-3: a busy Mac (load 16-55) and the hosted runner both stall for
 * over a second, long enough to cover three spaced trials, so neither
 * best-of-3 nor the pause alone tells a held loop from a stalled machine.
 * Each attempt therefore idles TRIAL_PAUSE_MS first and measures loop delay
 * during that idle window as a control. A held loop shows delay only while
 * sweeps run; a stalled runner shows it while idle too, and that attempt is
 * void. The guard needs 3 valid trials within MAX_ATTEMPTS attempts. It fails
 * only if all 3 exceed the budget, and it skips (never fails) when the runner
 * never goes quiet long enough.
 */
const TRIAL_PAUSE_MS = 250;
const MAX_ATTEMPTS = 6;

interface ControlledAttempt {
  controlMs: number;
  trialMs: number;
  valid: boolean;
}

async function runControlledTrials(input: {
  needed: number;
  maxAttempts: number;
  pauseMs: number;
  budgetMs: number;
  /** Idle for `ms` and return the loop delay observed while idle. */
  pause: (ms: number) => Promise<number>;
  runTrial: (attempt: number) => Promise<number>;
}): Promise<{
  verdict: "pass" | "fail" | "skip";
  attempts: ControlledAttempt[];
  reason?: string;
}> {
  const attempts: ControlledAttempt[] = [];
  const valid = () => attempts.filter((attempt) => attempt.valid);
  while (valid().length < input.needed && attempts.length < input.maxAttempts) {
    const controlMs = await input.pause(input.pauseMs);
    const trialMs = await input.runTrial(attempts.length);
    attempts.push({ controlMs, trialMs, valid: controlMs <= input.budgetMs });
  }
  const validTrials = valid().map((attempt) => attempt.trialMs);
  if (validTrials.length < input.needed) {
    return {
      verdict: "skip",
      attempts,
      reason:
        `runner stalled: only ${validTrials.length}/${input.needed} attempts ` +
        `had a quiet ${input.pauseMs} ms control in ${input.maxAttempts}`,
    };
  }
  return {
    verdict: loopHeldInEveryTrial(validTrials, input.budgetMs) ? "fail" : "pass",
    attempts,
  };
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

describe("runControlledTrials (#817: a stalled runner is not a held loop)", () => {
  // Fake clock. Every attempt idles TRIAL_PAUSE_MS (the control window), then
  // runs a 300 ms trial. `stall(from, to)` says whether the machine was
  // stalled over that span: 120 ms of delay if so, 12 ms if not.
  const simulate = async (model: {
    control: (from: number, to: number) => number;
    trial: (from: number, to: number) => number;
  }) => {
    let clock = 0;
    const pauses: number[] = [];
    const result = await runControlledTrials({
      needed: TRIALS,
      maxAttempts: MAX_ATTEMPTS,
      pauseMs: TRIAL_PAUSE_MS,
      budgetMs: BUDGET_MS,
      pause: async (ms) => {
        pauses.push(ms);
        const from = clock;
        clock += ms;
        return model.control(from, clock);
      },
      runTrial: async () => {
        const from = clock;
        clock += 300;
        return model.trial(from, clock);
      },
    });
    return { ...result, pauses };
  };
  const always = (ms: number) => () => ms;

  it("skips, never fails, when the runner stalls in the idle control too", async () => {
    const result = await simulate({ control: always(120), trial: always(120) });
    expect(result.verdict).toBe("skip");
    expect(result.attempts).toHaveLength(MAX_ATTEMPTS);
    expect(result.attempts.every((attempt) => !attempt.valid)).toBe(true);
    expect(result.reason).toMatch(/stalled/);
  });

  it("fails a held loop: quiet controls, every valid trial over budget", async () => {
    const result = await simulate({ control: always(12), trial: always(120) });
    expect(result.verdict).toBe("fail");
    expect(result.attempts).toHaveLength(TRIALS);
  });

  it("passes a clean run in exactly three attempts", async () => {
    const result = await simulate({ control: always(12), trial: always(12) });
    expect(result.verdict).toBe("pass");
    expect(result.attempts).toHaveLength(TRIALS);
    expect(result.pauses).toEqual(Array(TRIALS).fill(TRIAL_PAUSE_MS));
  });

  it("voids attempts inside a 600 ms burst and judges the clean ones", async () => {
    const overlaps = (from: number, to: number) => from < 700 && to > 100;
    const result = await simulate({
      control: (from, to) => (overlaps(from, to) ? 120 : 12),
      trial: (from, to) => (overlaps(from, to) ? 120 : 12),
    });
    expect(result.attempts.filter((attempt) => !attempt.valid)).toHaveLength(2);
    expect(result.verdict).toBe("pass");
  });

  it("idles at least 250 ms before every attempt, capped at six attempts", () => {
    expect(TRIAL_PAUSE_MS).toBeGreaterThanOrEqual(250);
    expect(MAX_ATTEMPTS).toBe(6);
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

  it(`a ${AGENTS}-agent sweep never holds the loop for ${BUDGET_MS} ms`, async (ctx) => {
    await engine.getRegistry().reconstitute();
    await engine.runSweep(); // warm module and JIT state; measure steady state
    const readScreen = client.readScreen as ReturnType<typeof vi.fn>;
    const result = await runControlledTrials({
      needed: TRIALS,
      maxAttempts: MAX_ATTEMPTS,
      pauseMs: TRIAL_PAUSE_MS,
      budgetMs: BUDGET_MS,
      pause: async (ms) => {
        const idle = monitorEventLoopDelay({ resolution: 1 });
        idle.enable();
        await new Promise((resolve) => setTimeout(resolve, ms));
        idle.disable();
        return idle.max / 1e6;
      },
      runTrial: async () => {
        const readsBefore = readScreen.mock.calls.length;
        const delay = monitorEventLoopDelay({ resolution: 1 });
        delay.enable();
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
        return delay.max / 1e6;
      },
    });
    result.attempts.forEach((attempt, index) => {
      process.stderr.write(`[#810] attempt ${index + 1}: control ${attempt.controlMs.toFixed(1)} ms, trial event_loop_delay_max ${attempt.trialMs.toFixed(1)} ms${attempt.valid ? "" : " (void: runner stalled while idle)"}\n`);
    });
    if (result.verdict === "skip") {
      process.stderr.write(`[#810] SKIP: ${result.reason}\n`);
      ctx.skip(result.reason);
      return;
    }
    expect(
      result.verdict,
      `every valid trial exceeded ${BUDGET_MS} ms with a quiet control`,
    ).toBe("pass");
  }, 30_000);
});
