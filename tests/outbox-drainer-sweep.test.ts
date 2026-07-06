/**
 * Wiring test (LANE-OUTBOX): the agent-engine periodic sweep must invoke the
 * outbox drain, and a delivered entry must not be re-sent on the next sweep.
 * This closes the "exists-but-not-wired" gap — the module alone never drains.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentEngine } from "../src/agent-engine.js";
import { StateManager } from "../src/state-manager.js";
import { AgentRegistry } from "../src/agent-registry.js";
import { drainOutbox, type NotifyPayload } from "../src/outbox-drainer.js";
import type { CmuxClient } from "../src/cmux-client.js";
import type { CmuxSurface } from "../src/types.js";

function makeMockClient(): CmuxClient {
  return {
    newSplit: vi.fn().mockResolvedValue({}),
    send: vi.fn().mockResolvedValue(undefined),
    sendKey: vi.fn().mockResolvedValue(undefined),
    readScreen: vi.fn().mockResolvedValue({
      surface: "s",
      text: "$ ",
      lines: 1,
      scrollback_used: false,
    }),
    renameTab: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn().mockResolvedValue(undefined),
    closeSurface: vi.fn().mockResolvedValue(undefined),
    listWorkspaces: vi.fn().mockResolvedValue({ workspaces: [] }),
    listPanes: vi.fn().mockResolvedValue({ panes: [] }),
    listPaneSurfaces: vi.fn().mockResolvedValue({ surfaces: [] }),
    clearStatus: vi.fn().mockResolvedValue(undefined),
    setProgress: vi.fn().mockResolvedValue(undefined),
    clearProgress: vi.fn().mockResolvedValue(undefined),
    identify: vi.fn().mockResolvedValue({}),
    browser: vi.fn().mockResolvedValue({}),
    log: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn().mockResolvedValue(undefined),
    notifyLifecycleEvent: vi.fn().mockResolvedValue(undefined),
  } as unknown as CmuxClient;
}

describe("agent-engine sweep wires the outbox drainer", () => {
  let root: string;
  let engine: AgentEngine;
  let calls: NotifyPayload[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cmux-outbox-sweep-"));
    mkdirSync(join(root, "state"), { recursive: true });
    const outboxPath = join(root, "outbox.md");
    const statePath = join(root, ".outbox-drained.json");
    writeFileSync(outboxPath, "sweep must deliver this\n");
    // Seed a CURRENT-version (v2) sidecar so the one-time id-scheme quarantine
    // does not fire — this test exercises the delivery + dedup wiring, not the
    // migration path (a missing sidecar would quarantine and deliver nothing).
    writeFileSync(
      statePath,
      `${JSON.stringify({ version: 2, drained: [] }, null, 2)}\n`,
    );

    calls = [];
    // Inject a drain that exercises the REAL drainOutbox against a temp outbox,
    // recording every delivered payload. Idempotency still flows through the
    // real .outbox-drained.json sidecar.
    const outboxDrain = () =>
      drainOutbox({
        outboxPath,
        statePath,
        deliver: async (payload) => {
          calls.push(payload);
          return true;
        },
      });

    const stateMgr = new StateManager(join(root, "state"));
    const liveSurfaces: CmuxSurface[] = [];
    const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
    engine = new AgentEngine(stateMgr, registry, makeMockClient(), {
      spawnPreflight: async () => {},
      outboxDrain,
    });
  });

  afterEach(() => {
    engine.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it("invokes the drain on sweep and does not re-send a delivered entry", async () => {
    await engine.runSweep();
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toBe("sweep must deliver this");

    // Second sweep: the entry is already drained (sidecar) → no double-send.
    await engine.runSweep();
    expect(calls).toHaveLength(1);
  });

  it("a drain that throws never breaks the sweep (best-effort)", async () => {
    const stateMgr = new StateManager(join(root, "state2"));
    const registry = new AgentRegistry(stateMgr, async () => []);
    const throwing = new AgentEngine(stateMgr, registry, makeMockClient(), {
      spawnPreflight: async () => {},
      outboxDrain: async () => {
        throw new Error("notify listener down");
      },
    });
    await expect(throwing.runSweep()).resolves.toBeUndefined();
    throwing.dispose();
  });
});
