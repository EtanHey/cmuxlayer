/**
 * Lane T1 — registry/state truth.
 *
 * #480: a row whose `surface_observer_id` is null or from a prior observer
 * generation is structurally un-evictable today: `canMutateForObservedAbsence`
 * requires an exact observer match and has no age escape hatch. Measured live
 * on 2026-08-19: four such rows, the oldest 36 days, `list_agents` reporting 17
 * agents against 13 live surfaces.
 *
 * The rule these tests pin: observer ownership protects a row that a LIVE
 * observer claims. It must not protect a row that no live surface bears on its
 * identity key (its UUID when it has one, else its ref) for a bounded,
 * documented window — unless the row still carries a session artifact that
 * resume-by-ID can act on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRegistry,
  SURFACE_EVICTION_CONFIRMATION_MS,
  UNCLAIMED_SURFACE_EVICTION_CONFIRMATION_MS,
} from "../src/agent-registry.js";
import { createServer } from "../src/server.js";
import { StateManager } from "../src/state-manager.js";
import { setResumeArtifactResolver } from "../src/resume-verification.js";
import type { AgentRecord } from "../src/agent-types.js";
import type { CmuxSurface } from "../src/types.js";

const TEST_DIR = join(tmpdir(), "cmux-agents-test-t1-registry-truth");
const OBSERVER = "cmux:/tmp/cmux-t1-live.sock#socket=16777229";
const DEAD_OBSERVER = "cmux:/tmp/cmux-t1-live.sock#socket=16777232";

function makeRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    agent_id: "cmuxlayerClaude-t1",
    surface_id: "surface:42",
    surface_uuid: null,
    surface_observer_id: OBSERVER,
    state: "idle",
    repo: "cmuxlayer",
    model: "claude",
    cli: "claude",
    cli_session_id: null,
    task_summary: "t1",
    pid: null,
    version: 1,
    created_at: "2026-07-14T13:07:16.765Z",
    updated_at: "2026-07-14T13:07:16.765Z",
    error: null,
    parent_agent_id: null,
    spawn_depth: 0,
    role: "orchestrator",
    deletion_intent: false,
    quality: "unknown",
    max_cost_per_agent: null,
    ...overrides,
  } as AgentRecord;
}

function makeSurface(ref: string, id?: string): CmuxSurface {
  return {
    ref,
    title: `Agent on ${ref}`,
    type: "terminal",
    index: 0,
    selected: false,
    ...(id ? { id } : {}),
  } as CmuxSurface;
}

function makeRegistry(
  stateMgr: StateManager,
  surfaces: CmuxSurface[],
): AgentRegistry {
  return new AgentRegistry(stateMgr, async () => surfaces, {
    observerId: OBSERVER,
    observerEpochProvider: () => `${OBSERVER}@epoch-1`,
  });
}

/** Two ticks: the first records the absence, the second clears the window. */
async function evictAcrossWindow(
  registry: AgentRegistry,
  opts: { elapsedMs: number; startedAt?: number } = { elapsedMs: 0 },
): Promise<string[]> {
  const startedAt = opts.startedAt ?? 1_000_000;
  await registry.evictSurfaceless({
    confirmationMs: 5_000,
    now: startedAt,
  });
  return registry.evictSurfaceless({
    confirmationMs: 5_000,
    now: startedAt + opts.elapsedMs,
  });
}

describe("T1 #480 — unclaimed rows are evictable within a bounded window", () => {
  let stateMgr: StateManager;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    stateMgr = new StateManager(TEST_DIR);
  });

  afterEach(() => {
    // Restore the suite-wide stub from tests/vitest.setup.ts.
    setResumeArtifactResolver(() => "unverifiable");
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("evicts a null-observer legacy row whose ref no live surface bears", async () => {
    // The exact shape measured on 2026-08-19: auto-claude-surface-603, no
    // surface_uuid, no surface_observer_id, ref absent from a UUID-bearing
    // topology. Immortal today on two counts (absence not "authoritative" for
    // a UUID-less row, and the observer gate).
    stateMgr.writeState(
      makeRecord({
        agent_id: "auto-claude-surface-603",
        surface_id: "surface:603",
        surface_uuid: null,
        surface_observer_id: null,
      }),
    );
    const registry = makeRegistry(stateMgr, [
      makeSurface("surface:700", "AAAA-live-uuid"),
    ]);
    await registry.reconstitute();

    await expect(
      evictAcrossWindow(registry, {
        elapsedMs: UNCLAIMED_SURFACE_EVICTION_CONFIRMATION_MS + 1,
      }),
    ).resolves.toEqual(["auto-claude-surface-603"]);
    expect(registry.get("auto-claude-surface-603")).toBeNull();
    expect(stateMgr.readState("auto-claude-surface-603")).toBeNull();
  });

  it("evicts a prior-generation observer row that is still `working`", async () => {
    // orcClaude: state `working`, observer from a dead socket generation. It
    // cannot be evicted, cannot be crash-marked, and therefore cannot be
    // resumed either (resumeAgent requires a terminal state).
    stateMgr.writeState(
      makeRecord({
        agent_id: "orcClaude",
        surface_id: "surface:478",
        surface_uuid: "F317D8AB-ED5E-426D-9CE7-1D846666E532",
        surface_observer_id: DEAD_OBSERVER,
        state: "working",
        seat_id: "orcClaude",
      }),
    );
    const registry = makeRegistry(stateMgr, [
      makeSurface("surface:700", "AAAA-live-uuid"),
    ]);
    await registry.reconstitute();

    await expect(
      evictAcrossWindow(registry, {
        elapsedMs: UNCLAIMED_SURFACE_EVICTION_CONFIRMATION_MS + 1,
      }),
    ).resolves.toEqual(["orcClaude"]);
  });

  it("does not evict an unclaimed row before the window closes", async () => {
    stateMgr.writeState(
      makeRecord({
        agent_id: "auto-claude-surface-606",
        surface_id: "surface:606",
        surface_observer_id: null,
      }),
    );
    const registry = makeRegistry(stateMgr, [
      makeSurface("surface:700", "AAAA-live-uuid"),
    ]);
    await registry.reconstitute();

    await expect(
      evictAcrossWindow(registry, {
        elapsedMs: UNCLAIMED_SURFACE_EVICTION_CONFIRMATION_MS - 1,
      }),
    ).resolves.toEqual([]);
    expect(registry.get("auto-claude-surface-606")).not.toBeNull();
  });

  it("keeps an unclaimed row whose ref is still live (recycled or not)", async () => {
    // The ownership gate's real job: a foreign/legacy row on a ref a live
    // surface still bears must never be evicted by this observer. Eviction is
    // for rows NO live surface bears.
    //
    // Belt-and-braces on purpose: the property is upheld UPSTREAM of the code
    // this lane added — `matchingLiveSurface` catches the row at the top of
    // the loop, and `clearSurfacelessObservationsForLiveSurfaces` wipes its
    // absence clock every tick. This case therefore passes against `main`
    // too. It is here because "never evict a live row" is the property most
    // worth pinning, not because it isolates the new branch.
    stateMgr.writeState(
      makeRecord({
        agent_id: "legacy-on-live-ref",
        surface_id: "surface:603",
        surface_observer_id: null,
      }),
    );
    const registry = makeRegistry(stateMgr, [
      makeSurface("surface:603", "BBBB-live-uuid"),
    ]);
    await registry.reconstitute();

    await expect(
      evictAcrossWindow(registry, {
        elapsedMs: UNCLAIMED_SURFACE_EVICTION_CONFIRMATION_MS * 10,
      }),
    ).resolves.toEqual([]);
    expect(registry.get("legacy-on-live-ref")).not.toBeNull();
  });

  it("restarts the window when the row is observed live again", async () => {
    stateMgr.writeState(
      makeRecord({
        agent_id: "auto-claude-surface-618",
        surface_id: "surface:618",
        surface_observer_id: null,
      }),
    );
    let surfaces: CmuxSurface[] = [
      makeSurface("surface:700", "AAAA-live-uuid"),
    ];
    const registry = new AgentRegistry(stateMgr, async () => surfaces, {
      observerId: OBSERVER,
      observerEpochProvider: () => `${OBSERVER}@epoch-1`,
    });
    await registry.reconstitute();

    await registry.evictSurfaceless({ confirmationMs: 5_000, now: 1_000_000 });
    // The pane comes back mid-window: the absence clock must reset, not carry.
    surfaces = [
      makeSurface("surface:700", "AAAA-live-uuid"),
      makeSurface("surface:618", "CCCC-live-uuid"),
    ];
    await registry.evictSurfaceless({ confirmationMs: 5_000, now: 1_010_000 });
    surfaces = [makeSurface("surface:700", "AAAA-live-uuid")];
    await expect(
      registry.evictSurfaceless({
        confirmationMs: 5_000,
        now: 1_010_000 + UNCLAIMED_SURFACE_EVICTION_CONFIRMATION_MS,
      }),
    ).resolves.toEqual([]);
    expect(registry.get("auto-claude-surface-618")).not.toBeNull();
  });

  it("keeps an unclaimed row whose captured session is still on disk", async () => {
    // The row is the ONLY agent_id -> cli_session_id mapping, and
    // `resumeAgent` has no ownership gate: an unclaimed row with a live
    // session artifact is the one thing resume-by-ID can still act on
    // (AGENTS.md: "a worker got killed because its pane broke"). Evicting it
    // would delete the mapping and strand the transcript. Retention here is
    // not the old immortality: the row is retained because it is usable, and
    // a successful resume re-stamps it with the current observer.
    setResumeArtifactResolver(() => "present");
    stateMgr.writeState(
      makeRecord({
        agent_id: "killed-but-resumable",
        surface_id: "surface:gone",
        surface_uuid: "GONE-UUID",
        surface_observer_id: DEAD_OBSERVER,
        state: "done",
        cli_session_id: "5f1d0c6a-1f2b-4a3c-8d4e-9f0a1b2c3d4e",
      }),
    );
    const registry = makeRegistry(stateMgr, [
      makeSurface("surface:700", "AAAA-live-uuid"),
    ]);
    await registry.reconstitute();

    await expect(
      evictAcrossWindow(registry, {
        elapsedMs: UNCLAIMED_SURFACE_EVICTION_CONFIRMATION_MS * 10,
      }),
    ).resolves.toEqual([]);
    expect(registry.get("killed-but-resumable")).not.toBeNull();
  });

  it("evicts an unclaimed row whose captured session is gone from disk", async () => {
    // The counter-case: a session id that resolves to nothing restores
    // nothing, so the row protects no capability and #480 still closes.
    setResumeArtifactResolver(() => "missing");
    stateMgr.writeState(
      makeRecord({
        agent_id: "killed-and-unrecoverable",
        surface_id: "surface:gone",
        surface_uuid: "GONE-UUID",
        surface_observer_id: DEAD_OBSERVER,
        state: "done",
        cli_session_id: "5f1d0c6a-1f2b-4a3c-8d4e-9f0a1b2c3d4e",
      }),
    );
    const registry = makeRegistry(stateMgr, [
      makeSurface("surface:700", "AAAA-live-uuid"),
    ]);
    await registry.reconstitute();

    await expect(
      evictAcrossWindow(registry, {
        elapsedMs: UNCLAIMED_SURFACE_EVICTION_CONFIRMATION_MS + 1,
      }),
    ).resolves.toEqual(["killed-and-unrecoverable"]);
  });

  it("leaves rows this observer owns on the existing 5s confirmation path", async () => {
    // The owned path must not silently inherit the longer unclaimed window.
    stateMgr.writeState(
      makeRecord({
        agent_id: "owned-ghost",
        surface_id: "surface:owned",
        surface_uuid: "DDDD-owned-uuid",
        surface_observer_id: OBSERVER,
      }),
    );
    const registry = makeRegistry(stateMgr, [
      makeSurface("surface:700", "AAAA-live-uuid"),
    ]);
    await registry.reconstitute();

    await expect(
      evictAcrossWindow(registry, { elapsedMs: 5_001 }),
    ).resolves.toEqual(["owned-ghost"]);
  });
});

/**
 * #481: `createLiveSeatDiscoveryProof` had exactly one call site in the repo —
 * inside the removed `resync_agents` tool's unreachable body. Without a proof
 * `hasLiveManagedSeatSibling` returns false unconditionally, so every
 * crash-recovery-eligible ghost is retained forever, including the case the
 * guard exists for: a live replacement already holding that row's seat.
 *
 * It also pins the other half of the recon finding: `list_agents` was the only
 * caller that never evicted anything, which is why it reported 17 agents while
 * `list_surfaces` reported 13.
 */
const SEAT_REGISTRY = {
  cmuxlayerClaude: {
    repo: "cmuxlayer",
    launchers: { claude: "cmuxlayerClaude" },
    lane: "cmuxlayer",
    role: "lead",
  },
} as const;

const SERVER_DIR = join(tmpdir(), "cmux-t1-list-agents-eviction");
const SERVER_OBSERVER = "cmux:/tmp/cmux-t1-list-agents.sock";

const CLAUDE_SCREEN = [
  "✻ Welcome to Claude Code",
  "bypass permissions on",
  "> ",
].join("\n");

class TwoSurfaceClient {
  readonly workspace = "workspace:1";
  readonly title: string;
  readonly screens: Record<string, string>;

  constructor(opts: { title?: string; screen?: string } = {}) {
    this.title = opts.title ?? "cmuxlayerCodex-lead";
    this.screens = {
      "surface:lead":
        opts.screen ?? "gpt-5.5 xhigh · 99% left · ~/Gits/cmuxlayer\ncodex>",
    };
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
          ref: "pane:1",
          index: 0,
          focused: true,
          surface_count: 1,
          surface_refs: ["surface:lead"],
          selected_surface_ref: "surface:lead",
        },
      ],
    };
  }

  async listPaneSurfaces() {
    return {
      workspace_ref: this.workspace,
      window_ref: "window:1",
      pane_ref: "pane:1",
      surfaces: [
        {
          ref: "surface:lead",
          id: "LEAD-UUID",
          title: this.title,
          type: "terminal",
          index: 0,
          selected: true,
        },
      ],
    };
  }

  async readScreen(surface: string, opts?: { lines?: number }) {
    const text = this.screens[surface];
    if (text == null) throw new Error(`Unknown surface: ${surface}`);
    return { surface, text, lines: opts?.lines ?? 30, scrollback_used: false };
  }

  async send() {}
  async sendKey() {}
  async renameTab() {}
}

describe("T1 #481 — the seat proof reaches a path callers actually use", () => {
  let server: any;

  beforeEach(() => {
    rmSync(SERVER_DIR, { recursive: true, force: true });
    mkdirSync(SERVER_DIR, { recursive: true });
    server = createServer({
      client: new TwoSurfaceClient() as any,
      stateDir: SERVER_DIR,
      disableSpawnPreflight: true,
      surfaceObserverOwnerIdProvider: () => SERVER_OBSERVER,
      surfaceObserverEpochProvider: () => `${SERVER_OBSERVER}@test`,
    } as any);
  });

  afterEach(() => {
    const engine = server?._registeredTools?.interact?._engine;
    if (engine && typeof engine.dispose === "function") engine.dispose();
    rmSync(SERVER_DIR, { recursive: true, force: true });
  });

  it("list_agents evicts a crash-recovery ghost whose seat a live pane holds", async () => {
    // Outcome, not wiring: `hasLiveManagedSeatSibling` returns false for every
    // row unless it is handed a proof built from THIS cycle's scan, so a
    // crash-recovery-eligible ghost is retained forever without one. Asserting
    // the ghost is gone fails both ways a regression can happen -- the call
    // removed, and a proof built from the wrong (or empty) scan.
    server = createServer({
      client: new TwoSurfaceClient({
        title: "cmuxlayerClaude",
        screen: CLAUDE_SCREEN,
      }) as any,
      stateDir: SERVER_DIR,
      disableSpawnPreflight: true,
      seatRegistry: SEAT_REGISTRY,
      surfaceObserverOwnerIdProvider: () => SERVER_OBSERVER,
      surfaceObserverEpochProvider: () => `${SERVER_OBSERVER}@test`,
    } as any);
    const engine = server._registeredTools["interact"]._engine;
    const seatFields = {
      repo: "cmuxlayer",
      cli: "claude",
      launcher_name: "cmuxlayerClaude",
      seat_id: "cmuxlayerClaude",
      role: "orchestrator",
      surface_observer_id: SERVER_OBSERVER,
      workspace_id: "workspace:1",
    };
    for (const record of [
      makeRecord({
        ...seatFields,
        agent_id: "cmuxlayerClaude-live",
        state: "working",
        surface_id: "surface:lead",
        surface_uuid: "LEAD-UUID",
      }),
      makeRecord({
        ...seatFields,
        agent_id: "cmuxlayerClaude-ghost",
        state: "error",
        surface_id: "surface:gone",
        surface_uuid: "GONE-UUID",
        crash_recover: true,
        cli_session_id: "5f1d0c6a-1f2b-4a3c-8d4e-9f0a1b2c3d4e",
        error: "Surface surface:gone disappeared",
      }),
    ]) {
      engine.stateMgr.writeState(record);
      engine.getRegistry().set(record.agent_id, record);
    }

    const nowSpy = vi.spyOn(Date, "now");
    try {
      // First call observes the absence; the 5 s confirmation window is the
      // owned path's, unchanged by this lane.
      nowSpy.mockReturnValue(1_000_000);
      await server._registeredTools["list_agents"].handler({}, {} as any);
      nowSpy.mockReturnValue(1_006_000);
      await server._registeredTools["list_agents"].handler({}, {} as any);
    } finally {
      nowSpy.mockRestore();
    }

    const registry = engine.getRegistry();
    expect(registry.get("cmuxlayerClaude-ghost")).toBeNull();
    expect(engine.stateMgr.readState("cmuxlayerClaude-ghost")).toBeNull();
    // The live seat itself must survive: the proof identifies it, it is not a ghost.
    expect(registry.get("cmuxlayerClaude-live")).not.toBeNull();
  });
});

describe("T1 #481 — parsed_cli_mismatch reaches a reader again", () => {
  let server: any;

  beforeEach(() => {
    rmSync(SERVER_DIR, { recursive: true, force: true });
    mkdirSync(SERVER_DIR, { recursive: true });
  });

  afterEach(() => {
    const engine = server?._registeredTools?.interact?._engine;
    if (engine && typeof engine.dispose === "function") engine.dispose();
    rmSync(SERVER_DIR, { recursive: true, force: true });
  });

  it("reports a record whose live pane runs a different CLI, and stays silent otherwise", async () => {
    // `parsed_cli_mismatch` was computed on every listMerged and read by
    // exactly one call site: the removed resync tool's dead body. A pane whose
    // observed CLI disagrees with its record was silently un-surfaced.
    const client = new TwoSurfaceClient();
    client.screens["surface:lead"] = [
      "✻ Welcome to Claude Code",
      "bypass permissions on",
      "> ",
    ].join("\n");
    server = createServer({
      client: client as any,
      stateDir: SERVER_DIR,
      disableSpawnPreflight: true,
      surfaceObserverOwnerIdProvider: () => SERVER_OBSERVER,
      surfaceObserverEpochProvider: () => `${SERVER_OBSERVER}@test`,
    } as any);
    const engine = server._registeredTools["interact"]._engine;
    const record = {
      agent_id: "cmuxlayerCodex-lead",
      surface_id: "surface:lead",
      surface_uuid: "LEAD-UUID",
      surface_observer_id: SERVER_OBSERVER,
      workspace_id: "workspace:1",
      state: "idle",
      repo: "cmuxlayer",
      model: "gpt-5.5",
      cli: "codex",
      cli_session_id: null,
      task_summary: "mismatch fixture",
      pid: null,
      version: 1,
      created_at: "2026-08-19T10:00:00.000Z",
      updated_at: "2026-08-19T10:00:00.000Z",
      error: null,
      parent_agent_id: null,
      spawn_depth: 0,
      role: "orchestrator",
      deletion_intent: false,
      quality: "unknown",
      max_cost_per_agent: null,
    } as unknown as AgentRecord;
    engine.stateMgr.writeState(record);
    engine.getRegistry().set(record.agent_id, record);

    const result = await server._registeredTools["list_agents"].handler(
      {},
      {} as any,
    );
    const parsed = result.structuredContent ?? JSON.parse(result.content[0].text);
    const row = parsed.agents.find(
      (agent: any) => agent.agent_id === "cmuxlayerCodex-lead",
    );
    expect(row, JSON.stringify(parsed)).toBeTruthy();
    expect(row.parsed_cli_mismatch).toBe(true);
    // Agreement costs no payload: the field is absent, not `false`.
    for (const other of parsed.agents) {
      if (other.agent_id === "cmuxlayerCodex-lead") continue;
      expect(other).not.toHaveProperty("parsed_cli_mismatch");
    }
  });
});

/**
 * #481/#477 class: a removal that leaves its instructions behind is not a
 * removal. `resync_agents` errors unconditionally, so any surface that still
 * tells a caller to run it hands them a second error.
 */
describe("T1 #481 — nothing still instructs callers to run resync_agents", () => {
  const read = (relative: string) =>
    readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

  it("keeps the removed tool out of runtime guidance and the README", () => {
    expect(read("src/server.ts")).not.toContain("Run resync_agents");
    expect(read("README.md")).not.toContain("resync_agents");
  });
});
