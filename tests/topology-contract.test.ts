import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentEngine } from "../src/agent-engine.js";
import {
  AgentRegistry,
  SURFACE_EVICTION_CONFIRMATION_MS,
} from "../src/agent-registry.js";
import type { AgentRecord } from "../src/agent-types.js";
import type { CmuxClient } from "../src/cmux-client.js";
import { StateManager } from "../src/state-manager.js";
import type {
  CmuxNewSplitResult,
  CmuxSurface,
} from "../src/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function record(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    agent_id: "agent-cmuxlayer",
    surface_id: "surface:agent",
    state: "working",
    repo: "cmuxlayer",
    model: "codex",
    cli: "codex",
    cli_session_id: null,
    task_summary: "",
    pid: null,
    version: 1,
    created_at: "2026-07-14T08:00:00.000Z",
    updated_at: "2026-07-14T09:00:00.000Z",
    error: null,
    parent_agent_id: null,
    spawn_depth: 0,
    deletion_intent: false,
    quality: "unknown",
    max_cost_per_agent: null,
    crash_recover: false,
    ...overrides,
  };
}

function surface(
  ref: string,
  title = `cmuxlayerCodex [${ref}]`,
  id?: string,
): CmuxSurface {
  return {
    ...(id ? { id } : {}),
    ref,
    title,
    type: "terminal",
    index: 0,
    selected: false,
    workspace_ref: "workspace:fleet",
  };
}

type MockClient = CmuxClient & {
  setStatus: ReturnType<typeof vi.fn>;
  setStatuses: ReturnType<typeof vi.fn>;
  readScreen: ReturnType<typeof vi.fn>;
};

function engineFixture(): {
  engine: AgentEngine;
  stateManager: StateManager;
  client: MockClient;
  setTopology: (surfaces: CmuxSurface[]) => void;
  getTopology: () => CmuxSurface[];
} {
  const root = mkdtempSync(join(tmpdir(), "cmuxlayer-topology-engine-"));
  tempDirs.push(root);
  const stateManager = new StateManager(root);
  let liveSurfaces: CmuxSurface[] = [];
  const client = {
    getTransportHealth: () => ({ mode: "socket", degraded: false }),
    newSplit: vi.fn().mockResolvedValue({
      workspace: "workspace:fleet",
      surface: "surface:new",
      pane: "pane:fleet",
      title: "",
      type: "terminal",
    } satisfies CmuxNewSplitResult),
    send: vi.fn().mockResolvedValue(undefined),
    sendKey: vi.fn().mockResolvedValue(undefined),
    readScreen: vi.fn().mockImplementation(async (surfaceRef: string) => ({
      surface: surfaceRef,
      text: "$ ",
      lines: 20,
      scrollback_used: false,
    })),
    renameTab: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn().mockResolvedValue(undefined),
    setStatuses: vi.fn().mockResolvedValue(undefined),
    closeSurface: vi.fn().mockResolvedValue(undefined),
    listWorkspaces: vi.fn().mockImplementation(async () => ({
      workspaces:
        liveSurfaces.length === 0
          ? []
          : [
              {
                ref: "workspace:fleet",
                title: "fleet",
                index: 0,
                selected: true,
                pinned: false,
              },
            ],
    })),
    listPanes: vi.fn().mockImplementation(async () => {
      const surfaceIds = liveSurfaces
        .map((entry) => entry.id)
        .filter((id): id is string => Boolean(id));
      return {
        workspace_ref: "workspace:fleet",
        window_ref: "window:fleet",
        panes:
          liveSurfaces.length === 0
            ? []
            : [
                {
                  ref: "pane:fleet",
                  index: 0,
                  focused: true,
                  surface_count: liveSurfaces.length,
                  surface_refs: liveSurfaces.map((entry) => entry.ref),
                  ...(surfaceIds.length === liveSurfaces.length
                    ? { surface_ids: surfaceIds }
                    : {}),
                },
              ],
      };
    }),
    listPaneSurfaces: vi.fn().mockImplementation(async () => ({
      workspace_ref: "workspace:fleet",
      window_ref: "window:fleet",
      pane_ref: "pane:fleet",
      surfaces: liveSurfaces,
    })),
    clearStatus: vi.fn().mockResolvedValue(undefined),
    setProgress: vi.fn().mockResolvedValue(undefined),
    clearProgress: vi.fn().mockResolvedValue(undefined),
    identify: vi.fn().mockResolvedValue({}),
    browser: vi.fn().mockResolvedValue({}),
    log: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn().mockResolvedValue(undefined),
    notifyLifecycleEvent: vi.fn().mockResolvedValue(undefined),
  } as unknown as MockClient;
  const registry = new AgentRegistry(stateManager, async () => liveSurfaces);
  const engine = new AgentEngine(stateManager, registry, client, {
    spawnPreflight: async () => {},
    sessionIdentityResolver: () => null,
  });

  return {
    engine,
    stateManager,
    client,
    setTopology: (next) => {
      liveSurfaces = next;
    },
    getTopology: () => liveSurfaces,
  };
}

describe("topology contract: authoritative ghost eviction", () => {
  it("requires two authoritative misses across the confirmation window and resets on a live observation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T09:00:00.000Z"));
    const fixture = engineFixture();
    fixture.stateManager.writeState(
      record({
        agent_id: "ghost-agent",
        surface_id: "surface:ghost",
        workspace_id: "workspace:fleet",
      }),
    );

    fixture.setTopology([
      surface("surface:ghost"),
      surface("surface:notes", "notes"),
    ]);
    const registry = fixture.engine.getRegistry();
    await registry.reconstitute();
    const runRegistrySweep = async () => {
      const confirmation = {
        confirmationMs: SURFACE_EVICTION_CONFIRMATION_MS,
        now: Date.now(),
      };
      await registry.reconcile(confirmation);
      await registry.evictSurfaceless(confirmation);
    };

    vi.setSystemTime(new Date("2026-07-14T09:00:01.000Z"));
    fixture.setTopology([]);
    await runRegistrySweep();
    expect(fixture.engine.getAgentState("ghost-agent")).toMatchObject({
      state: "working",
      surface_id: "surface:ghost",
    });

    vi.setSystemTime(
      new Date(
        Date.parse("2026-07-14T09:00:01.000Z") +
          SURFACE_EVICTION_CONFIRMATION_MS +
          1,
      ),
    );
    fixture.setTopology([surface("surface:notes", "notes")]);
    await runRegistrySweep();
    expect(fixture.engine.getAgentState("ghost-agent")).toMatchObject({
      state: "working",
      error: null,
    });

    vi.setSystemTime(new Date("2026-07-14T09:00:07.000Z"));
    fixture.setTopology([
      surface("surface:ghost"),
      surface("surface:notes", "notes"),
    ]);
    await runRegistrySweep();
    expect(fixture.engine.getAgentState("ghost-agent")).not.toBeNull();

    vi.setSystemTime(new Date("2026-07-14T09:00:12.000Z"));
    fixture.setTopology([surface("surface:notes", "notes")]);
    await runRegistrySweep();
    expect(fixture.engine.getAgentState("ghost-agent")).toMatchObject({
      state: "working",
      error: null,
    });

    vi.setSystemTime(
      new Date(
        Date.parse("2026-07-14T09:00:12.000Z") +
          SURFACE_EVICTION_CONFIRMATION_MS +
          1,
      ),
    );
    await runRegistrySweep();
    expect(fixture.engine.getAgentState("ghost-agent")).toBeNull();
  });
});
