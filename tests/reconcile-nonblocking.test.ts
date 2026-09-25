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
const HOSTED = Boolean(process.env.CI) && process.env.CI !== "false";

/**
 * #817 (#883 @96766a23): on a hosted runner the idle control can read quiet and every
 * trial still go over, while the same head passes locally. The runner was
 * descheduled mid-sweep, and delay alone reads the same as a held loop. So a
 * hosted fail also needs a second, independent signal: the CPU this process
 * burned inside the trial's longest loop gap. A held loop is this process
 * running JS, so it burns about as much CPU as the gap lasts; a descheduled
 * process burns next to none. A trial confirms a held loop when that CPU
 * exceeds the budget AND covers at least half the gap. (The sweep's own
 * `loop_stall_max_ms` is the same wall-clock gap as the delay histogram, so it
 * cannot tell the two apart.) Locally (no `CI`) delay alone still fails hard.
 */
interface TrialReading {
  delayMs: number;
  /** Longest wall-clock gap between 1 ms probe ticks during the trial. */
  gapMs?: number;
  /** CPU ms this process burned inside that gap (all threads). */
  gapCpuMs?: number;
}

interface ControlledAttempt extends Omit<TrialReading, "delayMs"> {
  controlMs: number;
  trialMs: number;
  valid: boolean;
}

function confirmsHeldLoop(attempt: ControlledAttempt, budgetMs: number): boolean {
  if (attempt.gapMs === undefined || attempt.gapCpuMs === undefined) return false;
  return attempt.gapCpuMs > budgetMs && attempt.gapCpuMs >= attempt.gapMs / 2;
}

async function runControlledTrials(input: {
  needed: number;
  maxAttempts: number;
  pauseMs: number;
  budgetMs: number;
  /** Hosted CI runner: a delay-only fail is inconclusive without CPU proof. */
  hosted: boolean;
  /** Idle for `ms` and return the loop delay observed while idle. */
  pause: (ms: number) => Promise<number>;
  runTrial: (attempt: number) => Promise<number | TrialReading>;
}): Promise<{
  verdict: "pass" | "fail" | "skip";
  attempts: ControlledAttempt[];
  reason?: string;
}> {
  const attempts: ControlledAttempt[] = [];
  const valid = () => attempts.filter((attempt) => attempt.valid);
  while (valid().length < input.needed && attempts.length < input.maxAttempts) {
    const controlMs = await input.pause(input.pauseMs);
    const reading = await input.runTrial(attempts.length);
    const { delayMs, ...gap } = typeof reading === "number" ? { delayMs: reading } : reading;
    attempts.push({ controlMs, trialMs: delayMs, ...gap, valid: controlMs <= input.budgetMs });
  }
  const validAttempts = valid();
  const validTrials = validAttempts.map((attempt) => attempt.trialMs);
  if (validTrials.length < input.needed) {
    return {
      verdict: "skip",
      attempts,
      reason:
        `runner stalled: only ${validTrials.length}/${input.needed} attempts ` +
        `had a quiet ${input.pauseMs} ms control in ${input.maxAttempts}`,
    };
  }
  if (!loopHeldInEveryTrial(validTrials, input.budgetMs)) {
    return { verdict: "pass", attempts };
  }
  const confirmed = validAttempts.every((attempt) => confirmsHeldLoop(attempt, input.budgetMs));
  if (input.hosted && !confirmed) {
    const fmt = (values: Array<number | undefined>) =>
      values.map((value) => (value === undefined ? "n/a" : value.toFixed(1))).join(", ");
    return {
      verdict: "skip",
      attempts,
      reason:
        `inconclusive on a hosted runner: quiet controls ` +
        `(${fmt(validAttempts.map((attempt) => attempt.controlMs))} ms) but every trial over ` +
        `${input.budgetMs} ms (${fmt(validTrials)} ms), and CPU in the longest gap ` +
        `(${fmt(validAttempts.map((attempt) => attempt.gapCpuMs))} ms of ` +
        `${fmt(validAttempts.map((attempt) => attempt.gapMs))} ms) does not confirm a held loop`,
    };
  }
  return { verdict: "fail", attempts };
}

/**
 * Tick every 1 ms and remember the CPU this process burned across the longest
 * wall-clock gap between ticks: the second signal for a hosted fail.
 */
function startGapCpuProbe(): () => { gapMs: number; gapCpuMs: number } {
  let lastWall = performance.now();
  let lastCpu = process.cpuUsage();
  let maxGapMs = -1;
  let gapCpuMs = 0;
  const observe = () => {
    const wall = performance.now();
    const cpu = process.cpuUsage();
    const gapMs = wall - lastWall;
    if (gapMs > maxGapMs) {
      maxGapMs = gapMs;
      gapCpuMs = (cpu.user - lastCpu.user + cpu.system - lastCpu.system) / 1000;
    }
    lastWall = wall;
    lastCpu = cpu;
  };
  const timer = setInterval(observe, 1);
  return () => {
    clearInterval(timer);
    observe();
    return { gapMs: maxGapMs, gapCpuMs };
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
    trial: (from: number, to: number) => number | TrialReading;
    hosted?: boolean;
  }) => {
    let clock = 0;
    const pauses: number[] = [];
    const result = await runControlledTrials({
      needed: TRIALS,
      maxAttempts: MAX_ATTEMPTS,
      pauseMs: TRIAL_PAUSE_MS,
      budgetMs: BUDGET_MS,
      hosted: model.hosted ?? false,
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

  // #817 (#883 @96766a23, job 107991923748): the controls read quiet and every
  // trial still went over on a hosted runner, while the same head passed 3/3
  // locally. Delay alone cannot tell that from a held loop there. Trial delays
  // borrow the hosted stall shape of #845 run 36089255730.
  const residual = [104.5, 248.9, 167.2];
  const residualTrial = (gapCpuMs: number) => {
    let index = 0;
    return () => {
      const delayMs = residual[index++ % residual.length]!;
      return { delayMs, gapMs: delayMs, gapCpuMs };
    };
  };

  it("hosted: quiet controls with every trial over budget are inconclusive, not a fail", async () => {
    let index = 0;
    const result = await simulate({
      control: always(12),
      trial: () => residual[index++]!,
      hosted: true,
    });
    expect(result.verdict).toBe("skip");
    expect(result.reason).toMatch(/inconclusive/);
    expect(result.reason).toContain("104.5, 248.9, 167.2");
  });

  it("hosted: a descheduled gap (CPU under half of it) is inconclusive", async () => {
    const result = await simulate({
      control: always(12),
      trial: residualTrial(40),
      hosted: true,
    });
    expect(result.verdict).toBe("skip");
    expect(result.reason).toContain("40.0, 40.0, 40.0");
  });

  it("hosted: fails when CPU fills every longest gap (a held loop)", async () => {
    const result = await simulate({
      control: always(12),
      trial: () => ({ delayMs: 120, gapMs: 120, gapCpuMs: 118 }),
      hosted: true,
    });
    expect(result.verdict).toBe("fail");
  });

  it("hosted: one unconfirmed trial is enough to call it inconclusive", async () => {
    let index = 0;
    const cpu = [118, 118, 3];
    const result = await simulate({
      control: always(12),
      trial: () => ({ delayMs: 120, gapMs: 120, gapCpuMs: cpu[index++]! }),
      hosted: true,
    });
    expect(result.verdict).toBe("skip");
  });

  it("local: quiet controls with every trial over budget still fail hard", async () => {
    const result = await simulate({
      control: always(12),
      trial: residualTrial(3),
      hosted: false,
    });
    expect(result.verdict).toBe("fail");
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
      hosted: HOSTED,
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
        const stopProbe = startGapCpuProbe();
        let gap: { gapMs: number; gapCpuMs: number };
        try {
          await engine.runSweep();
          await engine.runSweep();
          await engine.runSweep();
        } finally {
          gap = stopProbe();
          delay.disable();
        }
        // Proof of work: every sweep read every agent's screen (not a no-op sweep).
        expect(readScreen.mock.calls.length - readsBefore).toBeGreaterThanOrEqual(
          AGENTS * 3,
        );
        return { delayMs: delay.max / 1e6, ...gap };
      },
    });
    result.attempts.forEach((attempt, index) => {
      process.stderr.write(`[#810] attempt ${index + 1}: control ${attempt.controlMs.toFixed(1)} ms, trial event_loop_delay_max ${attempt.trialMs.toFixed(1)} ms, cpu ${attempt.gapCpuMs?.toFixed(1) ?? "n/a"} ms in longest gap ${attempt.gapMs?.toFixed(1) ?? "n/a"} ms${attempt.valid ? "" : " (void: runner stalled while idle)"}\n`);
    });
    if (result.verdict === "skip") {
      process.stderr.write(`[#810] SKIP: ${result.reason}\n`);
      ctx.skip(result.reason);
      return;
    }
    expect(
      result.verdict,
      `every valid trial exceeded ${BUDGET_MS} ms with a quiet control` +
        (HOSTED ? " and CPU in the longest gap confirming a held loop" : ""),
    ).toBe("pass");
  }, 30_000);
});
