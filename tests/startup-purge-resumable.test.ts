/**
 * #926: a cmux restart never deletes a resumable agent.
 *
 * `done` does not mean gone. An idle lead or a finished worker reads `done`,
 * still carries its captured CLI session, and is exactly what a lead resumes
 * by id after a crash. The purges may unbind such a row from a stale surface
 * ref, but the row and its id stay until the retention window expires.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRegistry } from "../src/agent-registry.js";
import { StateManager } from "../src/state-manager.js";
import {
  isRetainedResumableSession,
  RESUMABLE_SESSION_CLOCK_SKEW_MS,
  RESUMABLE_SESSION_RETENTION_MS,
  UNBOUND_SURFACE_REF,
  type AgentRecord,
} from "../src/agent-types.js";
import type { CmuxSurface } from "../src/types.js";

const TEST_DIR = join(tmpdir(), "cmux-agents-test-startup-purge-926");
const OBSERVER = "cmux:/tmp/prod.sock";
const SESSION = "019fa926-1111-7222-8333-444455556666";
const OLD_UUID = "aaaaaaaa-1111-4222-8333-444444444444";
const RECYCLED_UUID = "bbbbbbbb-1111-4222-8333-444444444444";

function makeRecord(overrides?: Partial<AgentRecord>): AgentRecord {
  const now = new Date().toISOString();
  return {
    agent_id: "cmuxlayerClaude-2c16c8c8",
    surface_id: "surface:7",
    surface_uuid: OLD_UUID,
    surface_observer_id: OBSERVER,
    workspace_id: "workspace:1",
    state: "done",
    repo: "cmuxlayer",
    model: "opus",
    cli: "claude",
    cli_session_id: SESSION,
    task_summary: "lane work",
    pid: null,
    version: 1,
    created_at: now,
    updated_at: now,
    error: null,
    parent_agent_id: null,
    spawn_depth: 0,
    role: "worker",
    deletion_intent: false,
    quality: "unknown",
    max_cost_per_agent: null,
    user_killed: false,
    ...overrides,
  };
}

function surface(ref: string, id: string): CmuxSurface {
  return { ref, id, title: "", type: "terminal", index: 0, selected: false };
}

describe("resumable agents survive a cmux restart (#926)", () => {
  let stateMgr: StateManager;
  let surfaces: CmuxSurface[];
  let registry: AgentRegistry;

  beforeEach(async () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    stateMgr = new StateManager(TEST_DIR);
    surfaces = [];
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  async function boot(): Promise<void> {
    registry = new AgentRegistry(stateMgr, async () => surfaces, {
      observerId: OBSERVER,
    });
    await registry.reconstitute();
  }

  it("startup purge unbinds a done+session row whose ref was recycled, and keeps it", async () => {
    stateMgr.writeState(makeRecord());
    // After the restart surface:7 is a DIFFERENT pane (different UUID).
    surfaces = [surface("surface:7", RECYCLED_UUID)];
    await boot();

    expect(registry.purgeAllTerminal({ surfaces })).toEqual([]);

    const kept = stateMgr.readState("cmuxlayerClaude-2c16c8c8");
    expect(kept).toMatchObject({
      agent_id: "cmuxlayerClaude-2c16c8c8",
      state: "done",
      cli_session_id: SESSION,
      surface_id: UNBOUND_SURFACE_REF,
      surface_uuid: null,
    });
    expect(registry.get("cmuxlayerClaude-2c16c8c8")?.surface_id).toBe(
      UNBOUND_SURFACE_REF,
    );
  });

  it("startup purge keeps the binding when the fresh topology still carries the row's UUID", async () => {
    stateMgr.writeState(makeRecord());
    // cmux restored the pane: same UUID, new ref.
    surfaces = [surface("surface:3", OLD_UUID)];
    await boot();

    expect(registry.purgeAllTerminal({ surfaces })).toEqual([]);
    expect(stateMgr.readState("cmuxlayerClaude-2c16c8c8")).toMatchObject({
      state: "done",
      surface_uuid: OLD_UUID,
    });
    expect(
      stateMgr.readState("cmuxlayerClaude-2c16c8c8")?.surface_id,
    ).not.toBe(UNBOUND_SURFACE_REF);
  });

  it("startup purge never trusts a bare ref: a UUID-less row is unbound even when its ref is live", async () => {
    stateMgr.writeState(makeRecord({ surface_uuid: null }));
    surfaces = [surface("surface:7", RECYCLED_UUID)];
    await boot();

    expect(registry.purgeAllTerminal({ surfaces })).toEqual([]);
    expect(stateMgr.readState("cmuxlayerClaude-2c16c8c8")?.surface_id).toBe(
      UNBOUND_SURFACE_REF,
    );
  });

  it("unbinding does not refresh the row's age", async () => {
    const updatedAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
    stateMgr.writeState(makeRecord({ updated_at: updatedAt }));
    surfaces = [surface("surface:9", RECYCLED_UUID)];
    await boot();

    registry.purgeAllTerminal({ surfaces });
    expect(stateMgr.readState("cmuxlayerClaude-2c16c8c8")?.updated_at).toBe(
      updatedAt,
    );
  });

  it("startup purge still deletes a done row with no session (nothing to resume)", async () => {
    stateMgr.writeState(makeRecord({ cli_session_id: null }));
    surfaces = [surface("surface:9", RECYCLED_UUID)];
    await boot();

    expect(
      registry.purgeAllTerminal({ surfaces }).map((agent) => agent.agent_id),
    ).toEqual(["cmuxlayerClaude-2c16c8c8"]);
    expect(stateMgr.readState("cmuxlayerClaude-2c16c8c8")).toBeNull();
  });

  it("startup purge deletes a retained session row older than the retention window", async () => {
    stateMgr.writeState(
      makeRecord({
        updated_at: new Date(
          Date.now() - RESUMABLE_SESSION_RETENTION_MS - 60_000,
        ).toISOString(),
      }),
    );
    surfaces = [surface("surface:9", RECYCLED_UUID)];
    await boot();

    expect(
      registry.purgeAllTerminal({ surfaces }).map((agent) => agent.agent_id),
    ).toEqual(["cmuxlayerClaude-2c16c8c8"]);
    expect(stateMgr.readState("cmuxlayerClaude-2c16c8c8")).toBeNull();
    expect(RESUMABLE_SESSION_RETENTION_MS).toBe(14 * 86_400_000);
  });

  it("startup purge still retains a user_killed close tombstone", async () => {
    stateMgr.writeState(
      makeRecord({
        user_killed: true,
        updated_at: new Date(
          Date.now() - RESUMABLE_SESSION_RETENTION_MS - 60_000,
        ).toISOString(),
      }),
    );
    surfaces = [surface("surface:9", RECYCLED_UUID)];
    await boot();

    expect(registry.purgeAllTerminal({ surfaces })).toEqual([]);
    expect(stateMgr.readState("cmuxlayerClaude-2c16c8c8")).not.toBeNull();
  });

  it("the periodic purgeTerminal unbinds a done+session row whose pane died instead of deleting it", async () => {
    stateMgr.writeState(makeRecord());
    surfaces = [surface("surface:7", OLD_UUID)];
    await boot();
    // The pane dies; an unrelated pane keeps the topology non-empty.
    surfaces = [surface("surface:witness", RECYCLED_UUID)];

    await expect(registry.purgeTerminal({ confirmationMs: 0 })).resolves.toBe(0);
    expect(stateMgr.readState("cmuxlayerClaude-2c16c8c8")).toMatchObject({
      state: "done",
      cli_session_id: SESSION,
      surface_id: UNBOUND_SURFACE_REF,
      surface_uuid: null,
    });
    // A second sweep leaves the unbound row alone.
    await expect(registry.purgeTerminal({ confirmationMs: 0 })).resolves.toBe(0);
    expect(stateMgr.readState("cmuxlayerClaude-2c16c8c8")).not.toBeNull();
  });

  it("the periodic purgeTerminal still deletes a done row without a session whose pane died", async () => {
    stateMgr.writeState(makeRecord({ cli_session_id: null }));
    surfaces = [surface("surface:7", OLD_UUID)];
    await boot();
    surfaces = [surface("surface:witness", RECYCLED_UUID)];

    await expect(registry.purgeTerminal({ confirmationMs: 0 })).resolves.toBe(1);
    expect(stateMgr.readState("cmuxlayerClaude-2c16c8c8")).toBeNull();
  });

  it("evictSurfaceless unbinds a done+session row whose pane died instead of evicting it", async () => {
    stateMgr.writeState(makeRecord());
    surfaces = [surface("surface:7", OLD_UUID)];
    await boot();
    surfaces = [surface("surface:witness", RECYCLED_UUID)];

    await expect(
      registry.evictSurfaceless({ confirmationMs: 0 }),
    ).resolves.toEqual([]);
    expect(stateMgr.readState("cmuxlayerClaude-2c16c8c8")).toMatchObject({
      state: "done",
      surface_id: UNBOUND_SURFACE_REF,
    });
    await expect(
      registry.evictSurfaceless({ confirmationMs: 0 }),
    ).resolves.toEqual([]);
    expect(stateMgr.readState("cmuxlayerClaude-2c16c8c8")).not.toBeNull();
  });
  // ---- Round 2 (#928 review) ----

  it("startup unbinding also drops the recorded workspace ref, which recycles like surface refs", async () => {
    stateMgr.writeState(makeRecord({ workspace_id: "workspace:gone" }));
    surfaces = [surface("surface:7", RECYCLED_UUID)];
    await boot();

    registry.purgeAllTerminal({ surfaces });
    expect(
      stateMgr.readState("cmuxlayerClaude-2c16c8c8")?.workspace_id ?? null,
    ).toBeNull();
  });

  it("evictSurfaceless never deletes a recent session row owned by another observer", async () => {
    stateMgr.writeState(
      makeRecord({ surface_observer_id: "cmux:/tmp/previous.sock" }),
    );
    surfaces = [surface("surface:witness", RECYCLED_UUID)];
    await boot();
    const firstObservedAt = Date.now();

    await registry.evictSurfaceless({ confirmationMs: 0, now: firstObservedAt });
    await expect(
      registry.evictSurfaceless({
        confirmationMs: 0,
        now: firstObservedAt + 10 * 60_000,
      }),
    ).resolves.toEqual([]);
    expect(stateMgr.readState("cmuxlayerClaude-2c16c8c8")).toMatchObject({
      state: "done",
      cli_session_id: SESSION,
    });
  });

  it("a ref-only match never keeps a retained session row bound (purgeTerminal)", async () => {
    stateMgr.writeState(makeRecord({ surface_uuid: null }));
    // A cmux build without surface UUIDs: surface:7 may be any pane now.
    surfaces = [{ ref: "surface:7", title: "", type: "terminal", index: 0, selected: false }];
    await boot();

    await expect(registry.purgeTerminal({ confirmationMs: 0 })).resolves.toBe(0);
    expect(stateMgr.readState("cmuxlayerClaude-2c16c8c8")).toMatchObject({
      state: "done",
      surface_id: UNBOUND_SURFACE_REF,
    });
  });

  it("a ref-only match never keeps a retained session row bound (evictSurfaceless)", async () => {
    stateMgr.writeState(makeRecord({ surface_uuid: null }));
    surfaces = [{ ref: "surface:7", title: "", type: "terminal", index: 0, selected: false }];
    await boot();

    await expect(
      registry.evictSurfaceless({ confirmationMs: 0 }),
    ).resolves.toEqual([]);
    expect(stateMgr.readState("cmuxlayerClaude-2c16c8c8")).toMatchObject({
      state: "done",
      surface_id: UNBOUND_SURFACE_REF,
    });
  });

  it("the periodic purgeTerminal deletes an unbound row once it ages past the window", async () => {
    stateMgr.writeState(
      makeRecord({
        surface_id: UNBOUND_SURFACE_REF,
        surface_uuid: null,
        updated_at: new Date(
          Date.now() - RESUMABLE_SESSION_RETENTION_MS - 60_000,
        ).toISOString(),
      }),
    );
    surfaces = [surface("surface:witness", RECYCLED_UUID)];
    await boot();

    await expect(registry.purgeTerminal({ confirmationMs: 0 })).resolves.toBe(1);
    expect(stateMgr.readState("cmuxlayerClaude-2c16c8c8")).toBeNull();
  });

  it("evictSurfaceless deletes an unbound row once it ages past the window", async () => {
    stateMgr.writeState(
      makeRecord({
        surface_id: UNBOUND_SURFACE_REF,
        surface_uuid: null,
        updated_at: new Date(
          Date.now() - RESUMABLE_SESSION_RETENTION_MS - 60_000,
        ).toISOString(),
      }),
    );
    surfaces = [surface("surface:witness", RECYCLED_UUID)];
    await boot();

    await expect(
      registry.evictSurfaceless({ confirmationMs: 0 }),
    ).resolves.toEqual(["cmuxlayerClaude-2c16c8c8"]);
  });
  it("a future-dated updated_at does not extend retention (clock-skew allowance only)", () => {
    const now = Date.now();
    const future = (ms: number) => ({
      state: "done" as const,
      cli_session_id: SESSION,
      deletion_intent: false,
      updated_at: new Date(now + ms).toISOString(),
    });
    expect(isRetainedResumableSession(future(24 * 60 * 60_000), now)).toBe(false);
    expect(
      isRetainedResumableSession(
        future(RESUMABLE_SESSION_CLOCK_SKEW_MS - 1_000),
        now,
      ),
    ).toBe(true);
  });
});
