/**
 * #791: the benchmark's warm send waits for the held sweep's "complete" state.
 * "complete" must mean the sweep body has run, or every warm sample overlaps
 * a live sweep and inherits its event-loop stalls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentEngine } from "../src/agent-engine.js";
import { StateManager } from "../src/state-manager.js";
import { AgentRegistry } from "../src/agent-registry.js";
import type { CmuxClient } from "../src/cmux-client.js";

function makeMockClient(): CmuxClient {
  return {
    listWorkspaces: vi.fn().mockResolvedValue({ workspaces: [] }),
    listPanes: vi.fn().mockResolvedValue({ panes: [] }),
    listPaneSurfaces: vi.fn().mockResolvedValue({ surfaces: [] }),
    setStatus: vi.fn().mockResolvedValue(undefined),
    clearStatus: vi.fn().mockResolvedValue(undefined),
    setProgress: vi.fn().mockResolvedValue(undefined),
    clearProgress: vi.fn().mockResolvedValue(undefined),
    log: vi.fn().mockResolvedValue(undefined),
  } as unknown as CmuxClient;
}

async function waitForHoldState(path: string, expected: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      if (JSON.parse(readFileSync(path, "utf8")).state === expected) return;
    } catch {
      // The engine may be between writes.
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`hold state never reached ${expected}`);
}

describe("benchmark sweep hold", () => {
  let root: string;
  let holdPath: string;
  let engine: AgentEngine;
  let statesDuringSweepBody: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cmux-bench-sweep-hold-"));
    mkdirSync(join(root, "state"), { recursive: true });
    holdPath = join(root, "sweep-hold-state.json");
    vi.stubEnv("CMUXLAYER_BENCH_SWEEP_HOLD_STATE", holdPath);
    statesDuringSweepBody = [];
    const stateMgr = new StateManager(join(root, "state"));
    const registry = new AgentRegistry(stateMgr, async () => []);
    engine = new AgentEngine(stateMgr, registry, makeMockClient(), {
      spawnPreflight: async () => {},
      // The outbox drain is the sweep body's last phase.
      outboxDrain: async () => {
        statesDuringSweepBody.push(JSON.parse(readFileSync(holdPath, "utf8")).state);
      },
    });
  });

  afterEach(() => {
    engine.dispose();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("reports complete only after the released sweep body has run", async () => {
    writeFileSync(holdPath, JSON.stringify({ token: "t1", state: "armed" }));
    const sweep = engine.runSweep();
    await waitForHoldState(holdPath, "held");
    writeFileSync(holdPath, JSON.stringify({ token: "t1", state: "release" }));
    await sweep;

    expect(statesDuringSweepBody).toEqual(["release"]);
    expect(JSON.parse(readFileSync(holdPath, "utf8"))).toEqual({ token: "t1", state: "complete" });
  });

  it("still reports complete when the sweep body fails", async () => {
    const failing = engine as unknown as { runSweepOnce: () => Promise<void> };
    failing.runSweepOnce = async () => {
      throw new Error("sweep body failed");
    };
    writeFileSync(holdPath, JSON.stringify({ token: "t2", state: "armed" }));
    const sweep = engine.runSweep();
    await waitForHoldState(holdPath, "held");
    writeFileSync(holdPath, JSON.stringify({ token: "t2", state: "release" }));

    await expect(sweep).rejects.toThrow("sweep body failed");
    expect(JSON.parse(readFileSync(holdPath, "utf8"))).toEqual({ token: "t2", state: "complete" });
  });

  it("leaves an unarmed hold file untouched", async () => {
    writeFileSync(holdPath, JSON.stringify({ token: "t3", state: "complete" }));
    await engine.runSweep();
    expect(statesDuringSweepBody).toEqual(["complete"]);
    expect(JSON.parse(readFileSync(holdPath, "utf8"))).toEqual({ token: "t3", state: "complete" });
  });
});
