import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { armWatch, readWatchRegistry, sweepWatches, updateWatchDeadline, releaseWatchWaiter } from "../src/watch-spec.js";
import { observeWatchOwner } from "../src/engine/sweep.js";
import { StateManager } from "../src/state-manager.js";

const DAY = 86_400_000;
describe("watch registry retention", () => {
  let dir: string, registryPath: string, target: string;
  let now: number;
  const opts = () => ({ registryPath, now: () => now });
  const arm = (deadline = Number.MAX_SAFE_INTEGER) => armWatch({ owner: "lead", target, marker: "DONE", deadline }, opts());
  const store = (watches: unknown[]) => writeFileSync(registryPath, JSON.stringify({ version: 1, watches }));
  const disk = () => JSON.parse(readFileSync(registryPath, "utf8")).watches;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "watch-gc-"));
    registryPath = join(dir, "watches.json");
    target = join(dir, "report.md");
    writeFileSync(target, "");
    now = 1_000;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.each([Number.MAX_SAFE_INTEGER, Infinity, NaN])("caps arm and update deadlines (%s)", async (deadline) => {
    const row = await arm(deadline);
    expect(row.deadline).toBe(now + 7 * DAY);
    now += 100;
    await updateWatchDeadline(row.watch_id, deadline, opts());
    expect(disk()[0]).toMatchObject({ armed_at_ms: now, deadline: now + 7 * DAY });
  });

  it("keeps shorter deadlines and rejects elapsed updates", async () => {
    const row = await arm(now + 100);
    expect(row.deadline).toBe(now + 100);
    await expect(updateWatchDeadline(row.watch_id, now, opts())).rejects.toMatchObject({ code: "watch_deadline_elapsed" });
    expect(disk()[0].deadline).toBe(now + 100);
  });

  it.each(["fired", "failed"])("prunes %s at the terminal TTL, including pending retries, silently", async (state) => {
    const row = await arm();
    store([{ ...row, state, terminal_at_ms: now, terminal_reason: "deadline_elapsed", notification_pending: true },
      { ...row, watch_id: "recent", state, terminal_at_ms: now + 1, terminal_reason: "predicate_matched" },
      { future_row: true }]);
    now += DAY;
    expect(readWatchRegistry(opts()).watches.map(r => r.watch_id)).toEqual(["recent"]);
    const notify = vi.fn(), onNotificationExhausted = vi.fn();
    await sweepWatches({ ...opts(), notify, onNotificationExhausted });
    expect(disk().map((r: any) => r.watch_id)).toEqual(["recent", undefined]);
    expect(notify).not.toHaveBeenCalled();
    expect(onNotificationExhausted).not.toHaveBeenCalled();
  });

  it("uses the last heartbeat for legacy terminals without terminal_at_ms", async () => {
    const row = await arm();
    store([{ ...row, state: "fired", terminal_reason: "predicate_matched" }]);
    now += DAY;
    await sweepWatches(opts());
    expect(disk()).toEqual([]);
  });

  it.each([Number.MAX_SAFE_INTEGER, null])("clamps legacy deadlines (%s) and expires past the cap on load without delivery", async (deadline) => {
    const row = await arm();
    store([{ ...row, deadline }]);
    expect(readWatchRegistry(opts()).watches[0].deadline).toBe(row.armed_at_ms + 7 * DAY);
    now += 7 * DAY + 1;
    expect(readWatchRegistry(opts()).watches[0]).toMatchObject({ state: "failed", terminal_reason: "deadline_elapsed", notification_pending: false });
    const notify = vi.fn();
    await sweepWatches({ ...opts(), notify });
    expect(disk()[0]).toMatchObject({ state: "failed", deadline: row.armed_at_ms + 7 * DAY });
    await sweepWatches({ ...opts(), notify });
    expect(notify).not.toHaveBeenCalled();
  });

  it("expires only confirmed absent owners after the grace; retains live and uncertain owners", async () => {
    const row = await arm();
    store(["gone", "live", "uncertain", "probe-error"].map(owner => ({ ...row, owner, watch_id: owner })));
    const ownerObservation = vi.fn(async (owner: string) => {
      if (owner === "probe-error") throw new Error("transport down");
      return owner === "gone" ? false : owner === "live" ? true : null;
    });
    const notify = vi.fn();
    now += DAY - 1;
    await sweepWatches({ ...opts(), ownerObservation, notify });
    expect(ownerObservation).not.toHaveBeenCalled();
    now += 1;
    await sweepWatches({ ...opts(), ownerObservation, notify });
    expect(disk().find((r: any) => r.owner === "gone")).toMatchObject({ state: "armed", owner_missing_since_at_ms: now });
    now += 5 * 60_000 - 1;
    await sweepWatches({ ...opts(), ownerObservation, notify });
    expect(disk().find((r: any) => r.owner === "gone").state).toBe("armed");
    now += 1;
    await sweepWatches({ ...opts(), ownerObservation, notify });
    expect(disk().find((r: any) => r.owner === "gone")).toMatchObject({ state: "failed", terminal_reason: "owner_gone", terminal_at_ms: now, notification_pending: false });
    expect(disk().filter((r: any) => r.state === "armed").map((r: any) => r.owner)).toEqual(["live", "uncertain", "probe-error"]);
    expect(notify).not.toHaveBeenCalled();
    now += DAY;
    await sweepWatches({ ...opts(), ownerObservation, notify });
    expect(disk().some((r: any) => r.owner === "gone")).toBe(false);
  });

  // Reviewer P1: the caller supplies an owner absent from cmux state, but is still waiting here.
  it("retains a live blocked public wait_for waiter at 25h", async () => {
    const host = { registry: { list: () => [] }, stateMgr: new StateManager(join(dir, "states")),
      watchAgentObservation: vi.fn(async () => ({ exists: false })) };
    const ownerObservation = (owner: string) => observeWatchOwner.call(host as any, owner);
    expect(await ownerObservation("maintenanceClaude")).toBe(false);
    const row = await armWatch({ owner: "maintenanceClaude", target, marker: "DONE",
      deadline: now + 3 * DAY, provenance: "public" },
      { ...opts(), waiterExpiresAtMs: now + 3 * DAY + 60_000 });
    now += 25 * 3_600_000;
    const notify = vi.fn();
    for (let sweep = 0; sweep < 2; sweep++, now += 5 * 60_000) {
      await sweepWatches({ ...opts(), ownerObservation, notify });
      expect(readWatchRegistry(opts()).watches.find(w => w.watch_id === row.watch_id)?.state).toBe("armed");
      expect(disk()[0]).not.toHaveProperty("owner_missing_since_at_ms");
    }
    expect(notify).not.toHaveBeenCalled();
    await releaseWatchWaiter(row.watch_id, opts());
    await sweepWatches({ ...opts(), ownerObservation, notify });
    expect(disk()[0]).toMatchObject({ state: "armed", owner_missing_since_at_ms: now });
    now += 5 * 60_000;
    await sweepWatches({ ...opts(), ownerObservation, notify });
    expect(disk()[0]).toMatchObject({ state: "failed", terminal_reason: "owner_gone" });
  });

  it.each(["live", "unknown", "error", "unobserved", "renewed"])("restarts absent-owner confirmation after %s evidence", async (evidence) => {
    const row = await arm(); now += DAY;
    await sweepWatches({ ...opts(), ownerObservation: () => false });
    expect(disk()[0]).toMatchObject({ state: "armed", owner_missing_since_at_ms: now });
    now += 5 * 60_000;
    if (evidence === "renewed") await updateWatchDeadline(row.watch_id, now + 2 * DAY, opts());
    await sweepWatches({ ...opts(), ownerObservation: evidence === "unobserved" ? undefined : () => {
      if (evidence === "error") throw new Error("transport down");
      return evidence === "live" ? true : evidence === "renewed" ? false : null;
    } });
    expect(disk()[0].state).toBe("armed");
    expect(disk()[0]).not.toHaveProperty("owner_missing_since_at_ms");
    if (evidence === "renewed") now += DAY;
    await sweepWatches({ ...opts(), ownerObservation: () => false });
    expect(disk()[0]).toMatchObject({ state: "armed", owner_missing_since_at_ms: now });
    now += 5 * 60_000;
    await sweepWatches({ ...opts(), ownerObservation: () => false });
    expect(disk()[0]).toMatchObject({ state: "failed", terminal_reason: "owner_gone" });
  });

  it("does not expire a watch re-armed during an owner probe", async () => {
    const row = await arm();
    now += DAY;
    await sweepWatches({ ...opts(), ownerObservation: () => false });
    now += 5 * 60_000;
    await sweepWatches({ ...opts(), ownerObservation: async () => {
      await updateWatchDeadline(row.watch_id, now + DAY, opts());
      return false;
    } });
    expect(disk()[0]).toMatchObject({ state: "armed", armed_at_ms: now });
    expect(disk()[0]).not.toHaveProperty("owner_missing_since_at_ms");
  });

  it("resolves exact, seat and ambiguous prefix owners across registry and persisted states", async () => {
    const host = {
      registry: { list: () => [{ agent_id: "lead-a", seat_id: "seat" }] },
      stateMgr: { listStates: () => [{ agent_id: "lead-b" }] },
      watchAgentObservation: vi.fn(async (id: string) => ({ exists: id === "lead-b" })),
    };
    const observe = (owner: string) => observeWatchOwner.call(host as any, owner);
    expect(await observe("absent")).toBe(false);
    expect(await observe("lead-a")).toBe(false);
    expect(await observe("seat")).toBe(false);
    expect(await observe("lead")).toBe(true);
    expect(await observe("lead-b")).toBe(true);
    host.watchAgentObservation.mockResolvedValue({ exists: true });
    expect(await observe("seat")).toBe(true);
  });

  it.each(["malformed", "unreadable", "null-record", "incomplete-record"])("retains an aged watch when real owner state is %s", async (failure) => {
    const stateDir = join(dir, "states");
    const stateFile = join(stateDir, "lead", "state.json");
    mkdirSync(join(stateDir, "lead"), { recursive: true });
    if (failure === "malformed") writeFileSync(stateFile, "{invalid-json");
    else if (failure === "null-record") writeFileSync(stateFile, "null");
    else if (failure === "incomplete-record") writeFileSync(stateFile, '{"agent_id":"lead"}');
    else mkdirSync(stateFile); // EISDIR is portable even with elevated permissions.
    const host = {
      registry: { list: () => [] }, stateMgr: new StateManager(stateDir),
      watchAgentObservation: vi.fn(async () => ({ exists: true })),
    };
    await arm();
    now += DAY;
    const ownerObservation = (owner: string) => observeWatchOwner.call(host as any, owner);
    expect(await ownerObservation("lead")).toBeNull();
    const notify = vi.fn();
    await sweepWatches({ ...opts(), ownerObservation, notify });
    expect(disk()[0]).toMatchObject({ state: "armed" });
    expect(disk()[0]).not.toHaveProperty("terminal_reason");
    expect(notify).not.toHaveBeenCalled();
  });
});
