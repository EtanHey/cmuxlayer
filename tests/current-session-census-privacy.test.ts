import { describe, expect, it } from "vitest";
import { collectCurrentSessionCensus, type CensusReads, type KernelObservation } from "../src/current-session-census.js";
import { readFileSync } from "node:fs";

const identity = { pid: 42, ppid: 7, uid: 501, startSeconds: "123", startMicroseconds: "10", cwd: "/synthetic" };
const graph = { windows: [{ id: "w", workspaces: [{ id: "ws", panes: [{ id: "p", surface_ids: ["s"], surfaces: [{ id: "s", type: "terminal" }] }] }] }] };
const native: CensusReads["native"] = async method => ({ generation: "0:1", value: ({
  "system.capabilities": { methods: ["system.tree", "system.top", "debug.terminals", "window.list", "workspace.list", "pane.list", "surface.list"] },
  "system.tree": graph, "system.top": graph, "window.list": { windows: [{ id: "w" }] },
  "workspace.list": { workspaces: [{ id: "ws" }] }, "pane.list": { panes: [{ id: "p", surface_ids: ["s"] }] },
  "surface.list": { surfaces: [{ id: "s" }] }, "debug.terminals": { count: 1, terminals: [{ surface_id: "s", mapped: true, runtime_surface_ready: true }] },
} as Record<string, unknown>)[method] });
async function provider() {
  return JSON.parse(readFileSync(new URL("./fixtures/census-privacy-observation.json", import.meta.url), "utf8"));
}
async function collect(value: unknown) {
  const result = await collectCurrentSessionCensus({ native, kernel: async () => value as KernelObservation }, 501);
  expect(result.status).toBe("INCOMPLETE"); expect(result.finalMembership).toBeNull();
  return result;
}
const object = (value: unknown) => value as Record<string, unknown>;
function inject(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { value.forEach(inject); return; }
  Object.values(value).forEach(inject);
  Object.assign(value, { privateCanary: "PRIVATE_CANARY", argv: "PRIVATE_CANARY", environment: { secret: "PRIVATE_CANARY" } });
}
describe("collector diagnostic conservation and privacy", () => {
  it("excludes canaries at every nested witness path while retaining typed provider evidence", async () => {
    const value = await provider(), expected = structuredClone(value); inject(value);
    const result = await collect(value), kernel = result.attempts[0].kernel;
    expect(JSON.stringify(result)).not.toContain("PRIVATE_CANARY");
    expect(kernel.processes[0]).toEqual(expected.processes[0]);
    expect(kernel.processes[0].failures[0]).toMatchObject({ reason: "OBSERVED_ERRNO", bytes: 2352, expectedBytes: 2352, errno: 1 });
    for (const field of ["membershipReads", "rejectedRows", "rejectedMembershipReads", "helperOutputDigest", "helperExitCode", "runnerProvenance"]) {
      expect(object(kernel)[field]).toEqual(object(expected)[field]);
    }
    expect(object(kernel).rejectedRows).toMatchObject([{ evidence: { before: { uid: 501 }, after: { uid: "invalid" } } }]);
    expect(object(kernel).rejectedMembershipReads).toMatchObject([{ evidence: { bytes: 8, errno: 1, invalidEntries: [{ index: 1, value: -7 }] } }, {}]);
    expect(kernel.before).toBeNull(); expect(kernel.reason).toBe("HELPER_EXIT_NONZERO");
  });
  it.each([7, null, undefined])("preserves observed exit status without inventing an absent one: %s", async code => {
    const value = object(await provider());
    if (code === undefined) delete value.helperExitCode; else value.helperExitCode = code;
    const kernel = (await collect(value)).attempts[0].kernel;
    expect(object(kernel).helperExitCode).toBe(code);
    expect(Object.hasOwn(kernel, "helperExitCode")).toBe(code !== undefined);
  });
  it("keeps malformed known fields explicit, conserves other counts and blocks qualification", async () => {
    const value = await provider();
    object(value.membershipReads[0]).bytes = "invalid";
    object(value.processes[0].failures[0]).expectedBytes = "invalid";
    object(value.runnerProvenance).signal = { privateCanary: "PRIVATE_CANARY" };
    const result = await collect(value), kernel = result.attempts[0].kernel;
    expect(kernel.reason).toBe("kernel helper invalid output");
    expect(kernel.invalidRows).toHaveLength(1);
    expect(kernel.processes[0].failures[0]).toMatchObject({ bytes: 2352, expectedBytes: "invalid", reason: "OBSERVED_ERRNO" });
    expect(object(kernel).membershipReads).toMatchObject([{ queryBytes: 8, bytes: "invalid", errno: 1 }, {}]);
    expect(kernel.reportedReason).toBe("HELPER_EXIT_NONZERO");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_CANARY");
  });
  it("blocks malformed diagnostics even when the launch and native bracket otherwise qualify", async () => {
    const healthy = { before: [42], after: [42], reason: null, helperExitCode: 0,
      processes: [{ ...identity, identityAfter: identity, sessionId: null, errors: [], failures: [] }] };
    expect((await collectCurrentSessionCensus({ native, kernel: async () => healthy }, 501)).finalMembership).toHaveLength(1);
    const result = await collect({ ...healthy, helperExitCode: { argv: "PRIVATE_CANARY" } });
    expect(result.attempts[0].kernel.reason).toBe("kernel helper invalid output");
    expect(Object.hasOwn(result.attempts[0].kernel, "helperExitCode")).toBe(false);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_CANARY");
  });
});
