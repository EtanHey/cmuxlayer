import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { armWatch, readWatchRegistry, sweepWatches, updateWatchDeadline } from "../src/watch-spec.js";
import { observeWatchOwner } from "../src/engine/sweep.js";

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
    expect(disk().find((r: any) => r.owner === "gone")).toMatchObject({ state: "failed", terminal_reason: "owner_gone", terminal_at_ms: now, notification_pending: false });
    expect(disk().filter((r: any) => r.state === "armed").map((r: any) => r.owner)).toEqual(["live", "uncertain", "probe-error"]);
    expect(notify).not.toHaveBeenCalled();
    now += DAY;
    await sweepWatches({ ...opts(), ownerObservation, notify });
    expect(disk().some((r: any) => r.owner === "gone")).toBe(false);
  });

  it("does not expire a watch re-armed during an owner probe", async () => {
    const row = await arm();
    now += DAY;
    await sweepWatches({ ...opts(), ownerObservation: async () => {
      await updateWatchDeadline(row.watch_id, now + DAY, opts());
      return false;
    } });
    expect(disk()[0]).toMatchObject({ state: "armed", armed_at_ms: now });
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
});
