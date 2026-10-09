import { describe, expect, it } from "vitest";
import { collectCurrentSessionCensus, type CensusReads, type KernelObservation } from "../src/current-session-census.js";
import { readFileSync } from "node:fs";

const identity = { pid: 42, ppid: 7, uid: 501, startSeconds: "123", startMicroseconds: "10", cwd: "/synthetic" };
const graph = { windows: [{ id: "w", workspaces: [{ id: "ws", panes: [{ id: "p", surface_ids: ["s"], surfaces: [{ id: "s", type: "terminal" }] }] }] }] };
const native: CensusReads["native"] = async method => ({ generation: "validation:1", value: ({
  "system.capabilities": { methods: ["system.tree", "system.top", "debug.terminals", "window.list", "workspace.list", "pane.list", "surface.list"] },
  "system.tree": graph, "system.top": graph, "window.list": { windows: [{ id: "w" }] },
  "workspace.list": { workspaces: [{ id: "ws" }] }, "pane.list": { panes: [{ id: "p", surface_ids: ["s"] }] },
  "surface.list": { surfaces: [{ id: "s" }] }, "debug.terminals": { count: 1, terminals: [{ surface_id: "s", mapped: true, runtime_surface_ready: true }] },
} as Record<string, unknown>)[method] });
async function healthy() {
  return JSON.parse(readFileSync(new URL("./fixtures/census-healthy-observation.json", import.meta.url), "utf8"));
}
function inject(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { value.forEach(inject); return; }
  Object.values(value).forEach(inject);
  Object.assign(value, { argv: "PRIVATE_CANARY", environment: { secret: "PRIVATE_CANARY" }, unknownScalar: "PRIVATE_CANARY" });
}
async function check(diagnostics: Record<string, unknown>, malformed: boolean) {
  const value = await healthy(), expected = structuredClone(value);
  Object.assign(value, structuredClone(diagnostics)); inject(value);
  const census = await collectCurrentSessionCensus({ native, kernel: async () => value as KernelObservation }, 501);
  expect(census.status).toBe("INCOMPLETE");
  expect(census.attempts[0].kernel.processes).toEqual(expected.processes);
  expect(census.attempts[0].kernel.membershipReads).toEqual(expected.membershipReads);
  expect(census.attempts[0].kernel.helperOutputDigest).toBe(expected.helperOutputDigest);
  expect(JSON.stringify(census)).not.toContain("PRIVATE_CANARY");
  expect(census.attempts[0].kernel.reason).toBe(malformed ? "kernel helper invalid output" : null);
  if (malformed) expect(census.finalMembership).toBeNull();
  else expect(census.finalMembership).toHaveLength(1);
  return census.attempts[0].kernel;
}
const rejected = (digest: string, evidence: Record<string, unknown>) => ({ rejectedRows: [{ index: 0, pid: 42, digest, evidence }] });
describe("rejection diagnostic validation and conservation", () => {
  it.each(["not-a-digest", "A".repeat(64), "d".repeat(63), "d".repeat(65)])("retains and blocks malformed SHA256 digest: %s", async digest => {
    const kernel = await check(rejected(digest, { before: { pid: 42 }, after: {}, failures: [] }), true);
    expect(kernel.rejectedRows).toEqual([{ index: 0, pid: 42, digest, evidence: { before: { pid: 42 }, after: {}, failures: [] } }]);
  });
  it("retains an existing lowercase SHA256 digest without replacing it", async () => {
    const digest = "a1".repeat(32), kernel = await check(rejected(digest, { before: {}, after: {}, failures: [] }), false);
    expect(kernel.rejectedRows?.[0].digest).toBe(digest);
  });
  for (const side of ["before", "after"] as const) {
    it.each(["absent", "null", "empty", "partial"])(`distinguishes ${side} rejection witness: %s`, async state => {
      const neighbor = side === "before" ? "after" : "before";
      const evidence: Record<string, unknown> = { [neighbor]: { uid: 501, cwd: "/independent" }, failures: [] };
      if (state !== "absent") evidence[side] = state === "null" ? null : state === "empty" ? {} : { pid: 42, startSeconds: "123" };
      const kernel = await check(rejected("d".repeat(64), evidence), state === "absent" || state === "null");
      const captured = kernel.rejectedRows?.[0].evidence;
      expect(Object.hasOwn(captured!, side)).toBe(state !== "absent");
      expect(captured?.[side]).toEqual(state === "absent" ? undefined : state === "null" ? null : state === "empty" ? {} : { pid: 42, startSeconds: "123" });
      expect(captured?.[neighbor]).toEqual({ uid: 501, cwd: "/independent" });
    });
  }
  for (const field of ["observedPids", "membership"] as const) {
    it.each([false, -9, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, "42"])(`retains and blocks invalid ${field} reference: %s`, async invalid => {
      const refs = [42, invalid], evidence = { bytes: 4, queryBytes: 4, invalidEntries: [], observedPids: [42], membership: [42], [field]: refs };
      const kernel = await check({ rejectedMembershipReads: [{ index: 0, evidence }] }, true);
      expect(kernel.rejectedMembershipReads).toEqual([{ index: 0, evidence }]);
    });
  }
  it("preserves the exact mixed invalid reference counterexample", async () => {
    const evidence = { bytes: 4, invalidEntries: [], observedPids: [false, -9], membership: [false] };
    const kernel = await check({ rejectedMembershipReads: [{ index: 0, evidence }] }, true);
    expect(kernel.rejectedMembershipReads).toEqual([{ index: 0, evidence }]);
  });
  it.each([{ name: "unobserved", membership: null }, { name: "observed-empty", membership: [] }, { name: "observed", membership: [42] }])("preserves rejected membership: $name", async ({ membership }) => {
    const evidence = { bytes: 4, invalidEntries: [], observedPids: [42], membership };
    const kernel = await check({ rejectedMembershipReads: [{ index: 0, evidence }] }, false);
    expect(kernel.rejectedMembershipReads).toEqual([{ index: 0, evidence }]);
  });
});
