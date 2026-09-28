/**
 * #911 — inbox tailers are owned and reaped when their agent is gone.
 *
 * Measured 2026-09-27: 93 `tail -n0 -F .../inbox.jsonl` processes, 11 for live
 * agents. Only stop_agent ever reaped one. These tests run the real detached
 * supervisor from the boot contract against the real `ps`, in a scratch inbox
 * dir, and a FRESH engine per test — which is what a restarted daemon is.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEngine } from "../src/agent-engine.js";
import { AgentRegistry } from "../src/agent-registry.js";
import { UNBOUND_SURFACE_REF, type AgentRecord } from "../src/agent-types.js";
import { inboxPath } from "../src/inbox.js";
import {
  type InboxTailer,
  observeInboxTailers,
  probeProcess,
  reapObservedTailer,
  snapshotProcessRows,
  sweepInboxTailers,
} from "../src/inbox-tail-reaper.js";
import { StateManager } from "../src/state-manager.js";
import { hasInboxTailRecordAuthority } from "../src/mcp/context.js";
import { alive, armTailer as armRealTailer, waitGone } from "./helpers/inbox-tailer.js";

const cleanups: Array<() => void> = [];
const armTailer = (agentId: string, inboxOpts: { baseDir: string }) =>
  armRealTailer(agentId, inboxOpts, cleanups);
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "cmux-911-"));
  const inboxOpts = { baseDir: join(root, "agents") };
  const stateMgr = new StateManager(join(root, "state"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return { inboxOpts, stateMgr };
}

/** A PID that belonged to a process which has exited. */
function deadPid(): number {
  const child = spawnSync("/bin/sh", ["-c", "echo $$"], { encoding: "utf8" });
  const pid = Number(child.stdout.trim());
  expect(alive(pid)).toBe(false);
  return pid;
}

function record(agentId: string, overrides: Partial<AgentRecord>): AgentRecord {
  const now = new Date().toISOString();
  return {
    agent_id: agentId,
    surface_id: "surface:911",
    state: "working",
    repo: "cmuxlayer",
    model: "opus",
    cli: "claude",
    cli_session_id: null,
    task_summary: "911",
    pid: null,
    version: 0,
    created_at: now,
    updated_at: now,
    error: null,
    parent_agent_id: null,
    spawn_depth: 0,
    role: "worker",
    quality: "unknown",
    user_killed: false,
    ...overrides,
  } as AgentRecord;
}

/** What a daemon (re)start builds: a new engine over the persisted registry. */
async function freshEngine(
  stateMgr: StateManager,
  inboxOpts: { baseDir: string },
  opts: { authority?: boolean } = {},
) {
  const registry = new AgentRegistry(stateMgr, async () => []);
  await registry.reconstitute().catch(() => undefined);
  const log = vi.fn(async () => true);
  const engine = new AgentEngine(stateMgr, registry, { log } as never, {
    spawnPreflight: async () => {},
    sessionIdentityResolver: () => null,
    inboxOpts,
    inboxTailReaper: { recordAuthority: opts.authority ?? true },
  });
  cleanups.push(() => engine.dispose());
  return { engine, log, registry };
}

async function restartedDaemonSweep(
  stateMgr: StateManager,
  inboxOpts: { baseDir: string },
  opts: { authority?: boolean } = {},
) {
  const built = await freshEngine(stateMgr, inboxOpts, opts);
  await (built.engine as unknown as { reapInboxTailsBestEffort(): Promise<void> }).reapInboxTailsBestEffort();
  return built;
}

/** Classify and "reap" against a fake signal sink: never a real kill. */
async function classifyWithSink(
  engine: AgentEngine,
  inboxOpts: { baseDir: string },
  rows: Awaited<ReturnType<typeof snapshotProcessRows>>,
) {
  const processes = new Map(rows.map((row) => [row.pid, row]));
  const kill = vi.fn();
  const result = await sweepInboxTailers({
    rows,
    inboxOpts,
    ownerState: (agentId) => engine.inboxTailOwnerState(agentId, processes),
    reap: true,
    deps: { kill },
  });
  return { kill, result, processes };
}

describe("#911 inbox tailer reaping", () => {
  it("a restarted daemon stops the tailer of an agent whose record was purged", async () => {
    const { inboxOpts, stateMgr } = scratch();
    const { wrapper, tail } = armTailer("fleetWorker-closed01", inboxOpts);

    await restartedDaemonSweep(stateMgr, inboxOpts);

    expect(await waitGone(tail)).toBe(true);
    expect(await waitGone(wrapper)).toBe(true);
  });

  it("a restarted daemon stops the tailer of a closed agent whose process is gone", async () => {
    const { inboxOpts, stateMgr } = scratch();
    const agentId = "fleetWorker-closed02";
    stateMgr.writeState(record(agentId, { state: "done", pid: deadPid() }));
    const { wrapper, tail } = armTailer(agentId, inboxOpts);

    await restartedDaemonSweep(stateMgr, inboxOpts);

    expect(await waitGone(tail)).toBe(true);
    expect(await waitGone(wrapper)).toBe(true);
  });

  it("a pane closed outside close_surface (record still working, process gone) is reaped by the sweep", async () => {
    const { inboxOpts, stateMgr } = scratch();
    const agentId = "fleetWorker-rawclose";
    stateMgr.writeState(record(agentId, { state: "working", pid: deadPid() }));
    const { tail } = armTailer(agentId, inboxOpts);

    await restartedDaemonSweep(stateMgr, inboxOpts);

    expect(await waitGone(tail)).toBe(true);
  });

  it("never touches a live agent's tailer — including a lead that already wrote DONE", async () => {
    const { inboxOpts, stateMgr } = scratch();
    const seat = spawn("sleep", ["30"], { stdio: "ignore" });
    cleanups.push(() => seat.kill());
    stateMgr.writeState(record("fleetLead-done0001", { state: "done", pid: seat.pid! }));
    stateMgr.writeState(record("fleetWorker-live0001", { state: "working", pid: seat.pid! }));
    const lead = armTailer("fleetLead-done0001", inboxOpts);
    const worker = armTailer("fleetWorker-live0001", inboxOpts);

    const { engine } = await restartedDaemonSweep(stateMgr, inboxOpts);
    await new Promise((resolve) => setTimeout(resolve, 200));

    for (const pid of [lead.wrapper, lead.tail, worker.wrapper, worker.tail]) {
      expect(alive(pid)).toBe(true);
    }
    // Adopted: the ownership is persisted on the registry record.
    expect(engine.getAgentState("fleetWorker-live0001")?.inbox_tail).toMatchObject({
      wrapper_pid: worker.wrapper,
      tail_pid: worker.tail,
      inbox_path: inboxPath("fleetWorker-live0001", inboxOpts),
    });
  });

  it("without registry authority over the inbox dir, a record-less tailer is left alone", async () => {
    const { inboxOpts, stateMgr } = scratch();
    const { tail } = armTailer("fleetWorker-foreign1", inboxOpts);

    await restartedDaemonSweep(stateMgr, inboxOpts, { authority: false });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(alive(tail)).toBe(true);
  });

  // Round 2 (Codex review of #922): the reaper signals only on positive proof
  // of death. Each case below classified a live owner "gone" at the prior head.
  it("an agent that resumed after the ps snapshot is never classified gone, and nothing is signalled", async () => {
    const { inboxOpts, stateMgr } = scratch();
    const agentId = "fleetWorker-resume01";
    armTailer(agentId, inboxOpts);
    const olderSnapshot = await snapshotProcessRows();
    // The owner resumes AFTER the snapshot: its new pid is not in it.
    const seat = spawn("sleep", ["30"], { stdio: "ignore" });
    cleanups.push(() => seat.kill());
    stateMgr.writeState(record(agentId, { state: "working", pid: seat.pid! }));
    const { engine } = await freshEngine(stateMgr, inboxOpts);

    const { kill, result, processes } = await classifyWithSink(engine, inboxOpts, olderSnapshot);

    expect(await engine.inboxTailOwnerState(agentId, processes)).not.toBe("gone");
    expect(result.orphaned).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
  });

  it("an agent that resumes while its old pid is being probed is never classified gone", async () => {
    const { inboxOpts, stateMgr } = scratch();
    const agentId = "fleetWorker-resume02";
    armTailer(agentId, inboxOpts);
    stateMgr.writeState(record(agentId, { state: "working", pid: deadPid() }));
    const { engine, registry } = await freshEngine(stateMgr, inboxOpts);
    const seat = spawn("sleep", ["30"], { stdio: "ignore" });
    cleanups.push(() => seat.kill());
    // The old pid really is dead, but the owner resumes with a new one while
    // that probe is in flight.
    const probe = vi.fn(async () => {
      const resumed = record(agentId, { state: "working", pid: seat.pid! });
      stateMgr.writeState(resumed);
      registry.set(agentId, resumed);
      return null;
    });
    const kill = vi.fn();

    const result = await sweepInboxTailers({
      rows: await snapshotProcessRows(),
      inboxOpts,
      ownerState: (id) => engine.inboxTailOwnerState(id, new Map(), probe),
      reap: true,
      deps: { kill },
    });

    expect(probe).toHaveBeenCalled();
    expect(result.orphaned).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
  });

  it("#926: a retained unbound done row is judged by pid and state, never by its missing surface", async () => {
    const { inboxOpts, stateMgr } = scratch();
    const seat = spawn("sleep", ["30"], { stdio: "ignore" });
    cleanups.push(() => seat.kill());
    // What a cmux restart leaves behind: done, session kept, surface unbound.
    const unbound = { state: "done", surface_id: UNBOUND_SURFACE_REF, surface_uuid: null } as const;
    stateMgr.writeState(
      record("fleetLead-unbound1", { ...unbound, cli_session_id: "sess-926-a", pid: null }),
    );
    stateMgr.writeState(
      record("fleetLead-unbound2", { ...unbound, cli_session_id: "sess-926-b", pid: seat.pid! }),
    );
    const { engine } = await freshEngine(stateMgr, inboxOpts);
    const processes = new Map((await snapshotProcessRows()).map((row) => [row.pid, row]));

    // An idle lead that wrote DONE keeps its mailbox; unbinding is not death.
    expect(await engine.inboxTailOwnerState("fleetLead-unbound1", processes)).toBe("live");
    expect(await engine.inboxTailOwnerState("fleetLead-unbound2", processes)).toBe("live");
  });

  it("an unreadable state.json is not proof of death: unknown, nothing signalled", async () => {
    const { inboxOpts, stateMgr } = scratch();
    const agentId = "fleetWorker-corrupt1";
    armTailer(agentId, inboxOpts);
    mkdirSync(join(stateMgr.getBaseDir(), agentId), { recursive: true });
    writeFileSync(join(stateMgr.getBaseDir(), agentId, "state.json"), "{ not json");
    const { engine } = await freshEngine(stateMgr, inboxOpts);

    const { kill, result, processes } = await classifyWithSink(engine, inboxOpts, await snapshotProcessRows());

    expect(await engine.inboxTailOwnerState(agentId, processes)).toBe("unknown");
    expect(result.orphaned).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
  });

  it("record authority is the verified production pair by filesystem identity, never an alias", () => {
    const root = mkdtempSync(join(tmpdir(), "cmux-911-authority-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const production = { stateDir: join(root, "prod-state"), inboxBaseDir: join(root, "prod-inbox") };
    for (const dir of [production.stateDir, production.inboxBaseDir, join(root, "scratch-state"), join(root, "scratch-inbox")]) {
      mkdirSync(dir);
    }
    const alias = join(root, "alias-to-prod-inbox");
    symlinkSync(production.inboxBaseDir, alias);
    const authority = (state: string, inbox: string | undefined) =>
      hasInboxTailRecordAuthority(state, inbox, production);

    expect(authority(production.stateDir, undefined)).toBe(true);
    expect(authority(`${production.stateDir}/`, production.inboxBaseDir)).toBe(true);
    expect(authority(production.stateDir, alias)).toBe(true); // same directory
    // A scratch daemon beside a symlink to the real fleet inbox: never.
    expect(authority(join(root, "scratch-state"), alias)).toBe(false);
    expect(authority(join(root, "scratch-state"), undefined)).toBe(false);
    expect(authority(join(root, "scratch-state"), join(root, "scratch-inbox"))).toBe(false);
    expect(authority(production.stateDir, join(root, "scratch-inbox"))).toBe(false);
    expect(authority(join(root, "missing"), join(root, "missing"))).toBe(false);
  });

  it("a recorded PID now running something else is never signalled (pid_reused)", async () => {
    const tailer: InboxTailer = {
      agent_id: "fleetWorker-reused01",
      inbox_path: "/x/agents/fleetWorker-reused01/inbox.jsonl",
      wrapper_pid: 4242,
      wrapper_started_at: "Mon Sep 28 10:00:00 2026",
      wrapper_token: "0123456789abcdef",
      tail_pid: 4243,
      tail_started_at: "Mon Sep 28 10:00:00 2026",
      recorded: true,
    };
    const kill = vi.fn();
    const outcome = await reapObservedTailer(tailer, {
      kill,
      probe: async (pid) =>
        pid === 4243
          ? // Same number, later start: the tail died and the PID was recycled.
            { pid, ppid: 1, started_at: "Mon Sep 28 11:00:00 2026", command: `tail -n0 -F ${tailer.inbox_path}` }
          : // Same number and start, different program.
            { pid, ppid: 1, started_at: "Mon Sep 28 10:00:00 2026", command: "/usr/bin/some-other-daemon" },
    });

    expect(outcome).toBe("pid_reused");
    expect(kill).not.toHaveBeenCalled();
  });

  it("classifies tailers for control_health without signalling anything", async () => {
    const { inboxOpts } = scratch();
    const live = armTailer("fleetWorker-count001", inboxOpts);
    // A resumed id may carry characters outside [A-Za-z0-9._-].
    const orphan = armTailer("fleetWorker+count002", inboxOpts);

    const result = await sweepInboxTailers({
      rows: await snapshotProcessRows(),
      inboxOpts,
      ownerState: (agentId) => (agentId.endsWith("001") ? "live" : "gone"),
    });

    expect(result.live.map((tailer) => tailer.agent_id)).toEqual(["fleetWorker-count001"]);
    expect(result.orphaned.map((tailer) => tailer.agent_id)).toEqual(["fleetWorker+count002"]);
    expect(result.orphaned[0]).toMatchObject({ recorded: true, wrapper_pid: orphan.wrapper, tail_pid: orphan.tail });
    expect(alive(live.tail) && alive(orphan.tail)).toBe(true);
  });

  // #922 follow-up (Codex r2 review): the owner was judged once, then the
  // tailer identity probe awaited and the signal went out unchecked.
  it("an owner that resumes during the tailer identity probe keeps its tailer: nothing is signalled", async () => {
    const { inboxOpts, stateMgr } = scratch();
    const agentId = "fleetWorker-resume03";
    const tailer = armTailer(agentId, inboxOpts);
    stateMgr.writeState(record(agentId, { state: "working", pid: deadPid() }));
    const { engine, registry } = await freshEngine(stateMgr, inboxOpts);
    const seat = spawn("sleep", ["30"], { stdio: "ignore" });
    cleanups.push(() => seat.kill());
    const judge = engine.inboxTailOwnerJudge(new Map());
    const probe = vi.fn(async (pid: number) => {
      // The owner resumes with a new, live pid while its old tailer is probed.
      const resumed = record(agentId, { state: "working", pid: seat.pid!, version: 1 });
      stateMgr.writeState(resumed);
      registry.set(agentId, resumed);
      return probeProcess(pid);
    });
    const kill = vi.fn();

    const result = await sweepInboxTailers({
      rows: await snapshotProcessRows(),
      inboxOpts,
      ...judge,
      reap: true,
      deps: { probe, kill },
    });

    expect(result.orphaned.map((t) => t.agent_id)).toEqual([agentId]);
    expect(probe).toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(result.reaped).toEqual([{ agent_id: agentId, outcome: "owner_changed" }]);
    expect(alive(tailer.tail)).toBe(true);
  });

  // #930 round 2 (Codex): another runtime (the daemon beside an in-process
  // MCP runtime) persists the resume; this runtime's registry is stale.
  it("an owner resumed by ANOTHER runtime during the tailer probe keeps its tailer", async () => {
    const { inboxOpts, stateMgr } = scratch();
    const agentId = "fleetWorker-resume04";
    const tailer = armTailer(agentId, inboxOpts);
    stateMgr.writeState(record(agentId, { state: "working", pid: deadPid(), version: 1 }));
    const { engine } = await freshEngine(stateMgr, inboxOpts);
    const otherRuntime = new StateManager(stateMgr.getBaseDir());
    const seat = spawn("sleep", ["30"], { stdio: "ignore" });
    cleanups.push(() => seat.kill());
    const probe = vi.fn(async (pid: number) => {
      otherRuntime.writeState(record(agentId, { state: "working", pid: seat.pid!, version: 2 }));
      return probeProcess(pid);
    });
    const kill = vi.fn();

    const result = await sweepInboxTailers({
      rows: await snapshotProcessRows(),
      inboxOpts,
      ...engine.inboxTailOwnerJudge(new Map()),
      reap: true,
      deps: { probe, kill },
    });

    expect(probe).toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(result.reaped).toEqual([{ agent_id: agentId, outcome: "owner_changed" }]);
    expect(alive(tailer.tail)).toBe(true);
  });

  it("an owner another runtime already resumed is not judged gone from a stale registry", async () => {
    const { inboxOpts, stateMgr } = scratch();
    const agentId = "fleetWorker-resume05";
    armTailer(agentId, inboxOpts);
    stateMgr.writeState(record(agentId, { state: "working", pid: deadPid(), version: 1 }));
    const { engine } = await freshEngine(stateMgr, inboxOpts);
    const seat = spawn("sleep", ["30"], { stdio: "ignore" });
    cleanups.push(() => seat.kill());
    new StateManager(stateMgr.getBaseDir()).writeState(
      record(agentId, { state: "working", pid: seat.pid!, version: 2 }),
    );
    const kill = vi.fn();

    const result = await sweepInboxTailers({
      rows: await snapshotProcessRows(),
      inboxOpts,
      ...engine.inboxTailOwnerJudge(new Map()),
      reap: true,
      deps: { kill },
    });

    expect(result.orphaned).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
  });

  it("a gone owner that stays gone is still reaped through the recheck", async () => {
    const { inboxOpts, stateMgr } = scratch();
    const agentId = "fleetWorker-staygone";
    const tailer = armTailer(agentId, inboxOpts);
    stateMgr.writeState(record(agentId, { state: "working", pid: deadPid() }));
    const { engine } = await freshEngine(stateMgr, inboxOpts);
    const kill = vi.fn();

    const result = await sweepInboxTailers({
      rows: await snapshotProcessRows(),
      inboxOpts,
      ...engine.inboxTailOwnerJudge(new Map()),
      reap: true,
      deps: { kill },
    });

    expect(result.reaped).toEqual([{ agent_id: agentId, outcome: "reaped" }]);
    expect(kill).toHaveBeenCalledWith(tailer.tail, "SIGTERM");
  });

  // #922 Macroscope (Medium): `inboxPath` normalizes through `join`, so a
  // configured base dir with a trailing slash hid every tailer.
  it("a trailing slash on the inbox base dir does not hide tailers", async () => {
    const { inboxOpts } = scratch();
    const armed = armTailer("fleetWorker-slash001", inboxOpts);
    const rows = await snapshotProcessRows();

    const seen = observeInboxTailers(rows, { baseDir: `${inboxOpts.baseDir}/` });

    expect(seen.map((t) => [t.agent_id, t.tail_pid])).toEqual([["fleetWorker-slash001", armed.tail]]);
  });
});
