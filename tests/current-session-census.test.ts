import { describe, expect, it, vi } from "vitest";
import { collectCurrentSessionCensus, type CensusReads, type KernelObservation } from "../src/current-session-census.js";

const graph = { windows: [{ id: "w", workspaces: [{ id: "ws", panes: [{ id: "p", surface_ids: ["s"], surfaces: [{ id: "s", type: "terminal" }] }] }] }] };
const process = (pid = 42, usec = "1") => {
  const identity = { pid, ppid: 1, uid: 501, startSeconds: "123", startMicroseconds: usec, cwd: "/synthetic" };
  return { ...identity, identityAfter: identity, sessionId: null, errors: [], failures: [] };
};
const kernel = (): KernelObservation => ({ before: [42], after: [42], processes: [process()], reason: null });
function reads(kernels = [kernel()]): CensusReads {
  return {
    native: vi.fn(async (method) => ({ generation: "0:1", value: ({
      "system.capabilities": { methods: ["system.tree", "system.top", "debug.terminals", "window.list", "workspace.list", "pane.list", "surface.list"] },
      "system.tree": graph, "system.top": graph,
      "window.list": { windows: [{ id: "w" }] }, "workspace.list": { workspaces: [{ id: "ws" }] },
      "pane.list": { panes: [{ id: "p", surface_ids: ["s"] }] }, "surface.list": { surfaces: [{ id: "s" }] },
      "debug.terminals": { count: 1, terminals: [{ surface_id: "s", mapped: true, runtime_surface_ready: true }] },
    } as Record<string, unknown>)[method] })),
    kernel: vi.fn(async () => kernels.shift() ?? kernel()),
  };
}
describe("evidence-only current census", () => {
  it("always blocks removal, preserves shell nulls and unavailable registrations", async () => {
    const result = await collectCurrentSessionCensus(reads(), 501);
    expect(result.status).toBe("INCOMPLETE");
    expect(result.finalMembership).toEqual([process()]);
    expect(result.registrations).toBeNull();
    expect(result.blockers).toContain("registration coverage unavailable");
  });
  it("retains the 27th unmapped terminal and detached owner PID without leaking native text", async () => {
    const r = reads([{ ...kernel(), before: [42, 99], after: [42, 99], processes: [process(), process(99)] }]);
    const original = r.native;
    r.native = async (method, params) => method === "debug.terminals" ? { generation: "0:1", value: {
      count: 27, terminals: Array.from({ length: 27 }, (_, n) => ({ surface_id: n === 0 ? "s" : `s${n}`, mapped: n < 26, initial_command: "SECRET", current_directory: "/private" })),
    } } : original(method, params);
    const result = await collectCurrentSessionCensus(r, 501);
    expect(result.attempts[0].before.diagnostics.find(o => o.method === "debug.terminals")?.objects).toHaveLength(27);
    expect(result.finalMembership?.map(p => p.pid)).toEqual([42, 99]);
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain("/private");
  });
  it.each(["window.list", "workspace.list", "pane.list", "surface.list"])("detects omitted %s members", async method => {
    const r = reads(); const original = r.native;
    r.native = async (m, p) => m === method ? { generation: "0:1", value: { [method.split(".")[0] + "s"]: [] } } : original(m, p);
    expect((await collectCurrentSessionCensus(r, 501)).blockers).toContain("native membership mismatch");
  });
  it.each(["EPERM", "unreadable UID", "unreadable start", "unreadable cwd"])("retains %s and never resolves it by disappearance", async error => {
    const p = { ...process(), errors: [error] };
    const result = await collectCurrentSessionCensus(reads([{ ...kernel(), processes: [p] }]), 501);
    expect(result.observations[0].errors).toContain(error);
    expect(result.blockers).toContain("kernel evidence unresolved");
  });
  it("reconciles disappearance but preserves failed observation and unknown history", async () => {
    const gone = { ...process(), startSeconds: null, startMicroseconds: null, cwd: null, identityAfter: null, errors: ["ESRCH"], failures: [{ operation: "identity-before", errno: 3, identity: null }] };
    const result = await collectCurrentSessionCensus(reads([
      { before: [42], after: [], processes: [gone], reason: null },
      { before: [], after: [], processes: [], reason: null },
    ]), 501);
    expect(result.observations).toContainEqual(gone);
    expect(result.finalMembership).toEqual([]);
    expect(result.resolutions[0]).toMatchObject({ pid: 42, disposition: "disappeared", historicalIdentityKnown: false });
    expect(result.attempts).toHaveLength(2);
  });
  it("accounts for reused PID with same second and distinct microsecond", async () => {
    const old = { ...process(), errors: ["ESRCH"], failures: [{ operation: "cwd-after", errno: 3, identity: process().identityAfter }] };
    const replacement = process(42, "2");
    const result = await collectCurrentSessionCensus(reads([{ ...kernel(), processes: [old] }, { ...kernel(), processes: [replacement] }]), 501);
    expect(result.observations).toEqual([old, replacement]);
    expect(result.finalMembership).toEqual([replacement]);
    expect(result.resolutions[0]).toMatchObject({ disposition: "reused", historicalIdentityKnown: true });
  });
  it("leaves ESRCH unresolved when the failed launch still appears", async () => {
    const old = { ...process(), errors: ["ESRCH"], failures: [{ operation: "cwd-after", errno: 3, identity: process().identityAfter }] };
    const result = await collectCurrentSessionCensus(reads([{ ...kernel(), processes: [old] }, kernel()]), 501);
    expect(result.resolutions[0].disposition).toBe("unresolved");
  });
  it("stops persistent churn at two attempts with null final membership", async () => {
    const r = reads(Array.from({ length: 2 }, () => ({ ...kernel(), after: [42, 99] })));
    const result = await collectCurrentSessionCensus(r, 501);
    expect(r.kernel).toHaveBeenCalledTimes(2);
    expect(result.finalMembership).toBeNull();
    expect(result.blockers).toContain("bounded rebracket exhausted");
  });
  it("rejects a omitted owner PID rather than accepting matching enumeration endpoints", async () => {
    const result = await collectCurrentSessionCensus(reads(Array.from({ length: 2 }, () => ({ ...kernel(), before: [42, 99], after: [42, 99] }))), 501);
    expect(result.finalMembership).toBeNull();
    expect(result.blockers).toContain("kernel membership mismatch");
  });
  it.each(["python missing", "libproc missing", "short output", "truncated JSON"])("records missing helper evidence: %s", async error => {
    const r = reads(); r.kernel = async () => { throw new Error(error); };
    const result = await collectCurrentSessionCensus(r, 501);
    expect(result.attempts[0].kernel.before).toBeNull();
    expect(result.finalMembership).toBeNull();
  });
  it("records capability absence, malformed diagnostics and reconnect", async () => {
    const r = reads(); const original = r.native;
    r.native = async (m, p) => m === "system.capabilities" ? { generation: "0:1", value: { methods: [] } }
      : m === "debug.terminals" ? { generation: "0:2", value: { count: 2, terminals: [{}] } } : original(m, p);
    const result = await collectCurrentSessionCensus(r, 501);
    expect(result.blockers).toContain("native capability missing");
    expect(result.blockers).toContain("native malformed or truncated");
    expect(result.blockers).toContain("native reconnect");
  });
  it("preserves unresolved and malformed registration references verbatim", async () => {
    const r = reads(); r.registrations = async () => [{ reference: "row:1834", digest: "sha256:fixture", disposition: "unresolved", sessionId: null }, { reference: "row:2", digest: null, disposition: "malformed", sessionId: null }];
    expect((await collectCurrentSessionCensus(r, 501)).registrations).toEqual(await r.registrations());
  });
  it("detects missing diagnostic terminals and malformed kernel output", async () => {
    const r = reads(); const original = r.native;
    r.native = async (m, p) => m === "debug.terminals" ? { generation: "0:1", value: { count: 0, terminals: [] } } : original(m, p);
    r.kernel = async () => ({ before: [], after: [] } as any);
    const result = await collectCurrentSessionCensus(r, 501);
    expect(result.blockers).toContain("diagnostic terminal membership missing");
    expect(result.finalMembership).toBeNull();
  });
  it("keeps unavailable native membership null, with a reason", async () => {
    const r = reads(); const original = r.native;
    r.native = async (m, p) => m === "window.list" ? { generation: "0:1", value: {} } : original(m, p);
    const result = await collectCurrentSessionCensus(r, 501);
    const diagnostic = result.attempts[0].before.diagnostics.find(d => d.method === "window.list")!;
    expect(diagnostic.objects).toBeNull();
    expect(diagnostic.reason).toBe("malformed or truncated");
  });
  it.each(["uid", "startSeconds", "cwd"])("blocks an unreadable %s without depending on helper errors", async field => {
    const p = { ...process(), [field]: null };
    const result = await collectCurrentSessionCensus(reads(Array.from({ length: 2 }, () => ({ ...kernel(), processes: [p] }))), 501);
    expect(result.finalMembership).toBeNull();
    expect(result.blockers).toContain("kernel evidence unresolved");
  });
  it("requires identity rechecks and catches microsecond reuse during the PID probe", async () => {
    const p = { ...process(), identityAfter: process(42, "2") };
    const result = await collectCurrentSessionCensus(reads(Array.from({ length: 2 }, () => ({ ...kernel(), processes: [p] }))), 501);
    expect(result.finalMembership).toBeNull();
    expect(result.observations[0].identityAfter?.startMicroseconds).toBe("2");
  });
  it("bounds native topology churn and retains all before/after observations", async () => {
    const r = reads(); const original = r.native; let calls = 0;
    r.native = async (m, p) => m === "system.tree" && ++calls % 2 === 0 ? { generation: "0:1", value: { windows: [] } } : original(m, p);
    const result = await collectCurrentSessionCensus(r, 501);
    expect(result.attempts).toHaveLength(2);
    expect(result.finalMembership).toBeNull();
  });
  it.each([null, { ...process(), failures: [{ operation: "cwd-before", errno: "EPERM", identity: process().identityAfter }] }])("conserves valid membership and rows beside malformed kernel evidence %#", async malformed => {
    const raw = { before: [42, 99], after: [42, 99], processes: [process(99), malformed], reason: null };
    const result = await collectCurrentSessionCensus(reads([raw as unknown as KernelObservation, raw as unknown as KernelObservation]), 501);
    expect(result.finalMembership).toBeNull(); expect(result.attempts[0].kernel.before).toEqual([42, 99]);
    expect(result.attempts[0].kernel.after).toEqual([42, 99]); expect(result.observations).toContainEqual(process(99));
    expect(result.attempts[0].kernel.invalidRows[0].index).toBe(1); expect(result.blockers).toContain("kernel output malformed");
    if (malformed) expect(result.attempts[0].kernel.invalidRows[0].evidence.failures).toEqual([{ operation: "cwd-before", errno: "EPERM", identity: process().identityAfter }]);
  });
  it("retains independently available partial launch fields without requiring a tuple", async () => {
    const partial = { pid: 42, uid: 501, startSeconds: "123", startMicroseconds: null, cwd: "/partial", failures: [{ operation: "identity-after", errno: 1, identity: { pid: 42, uid: 501 } }], secret: "PRIVATE" };
    const raw = { before: [42], after: [42], processes: [partial, { uid: 501, startMicroseconds: "4", cwd: "/no-pid" }], reason: null };
    const result = await collectCurrentSessionCensus(reads([raw as unknown as KernelObservation, raw as unknown as KernelObservation]), 501);
    expect(result.observations[0]).toMatchObject({ pid: 42, uid: 501, startSeconds: "123", startMicroseconds: null, cwd: "/partial" });
    expect(result.observations[0].failures[0]).toMatchObject({ operation: "identity-after", errno: 1, identity: { pid: 42, uid: 501 } });
    expect(result.attempts[0].kernel.invalidRows[1].evidence.identity).toEqual({ uid: 501, startMicroseconds: "4", cwd: "/no-pid" });
    expect(result.finalMembership).toBeNull(); expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it("conserves registration references while marking null and missing-field rows malformed", async () => {
    const r = reads(), valid = { reference: "row:1834", digest: null, disposition: "unresolved", sessionId: null };
    r.registrations = async () => [valid, null, {}, { reference: "row:9", digest: null, sessionId: null, secret: "PRIVATE" }] as unknown as Awaited<ReturnType<NonNullable<CensusReads["registrations"]>>>;
    const result = await collectCurrentSessionCensus(r, 501);
    expect(result.registrations?.[0]).toEqual(valid);
    expect(result.registrations?.slice(1).map(p => [p.reference, p.disposition])).toEqual([[null, "malformed"], [null, "malformed"], ["row:9", "malformed"]]);
    expect(result.invalidRegistrations.map(r => r.index)).toEqual([1, 2, 3]);
    expect(result.blockers).toContain("registration row malformed or unavailable"); expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it("retains duplicate mapped terminal rows as explicit identity ambiguity", async () => {
    const r = reads(), native = r.native, terminal = { surface_id: "s", mapped: true, runtime_surface_ready: true };
    r.native = async (m, p) => m === "debug.terminals" ? { generation: "0:1", value: { count: 2, terminals: [terminal, { ...terminal }] } } : native(m, p);
    const result = await collectCurrentSessionCensus(r, 501);
    const diagnostic = result.attempts[0].before.diagnostics.find(d => d.method === "debug.terminals")!;
    expect(diagnostic.objects).toHaveLength(2); expect(diagnostic.reason).toBe("malformed or truncated");
    expect(result.blockers).toContain("native malformed or truncated"); expect(result.finalMembership).toBeNull();
  });
  it.each([{ pid: -1 }, { cwd: "relative" }, { startSeconds: "0" }, { startMicroseconds: "1000000" }, { uid: 502 }])("never resolves invalid captured historical evidence %j", async change => {
    const identity = { ...process().identityAfter, ...change };
    const gone = { ...process(identity.pid), identityAfter: null, errors: ["ESRCH"], failures: [{ operation: "cwd-after", errno: 3, identity }] };
    const result = await collectCurrentSessionCensus(reads([{ before: [42], after: [], processes: [gone], reason: null }, { before: [], after: [], processes: [], reason: null }]), 501);
    expect(result.observations[0].failures[0].identity).toEqual(identity);
    expect(result.resolutions[0].disposition).toBe("unresolved"); expect(result.blockers).toContain("historical launch or path unknown");
    if (change.cwd === undefined) expect(result.resolutions[0].historicalIdentityKnown).toBe(false);
  });
  it("requires native reconciliation to qualify the final bracket and ESRCH resolution", async () => {
    const gone = { ...process(), identityAfter: null, errors: ["ESRCH"], failures: [{ operation: "cwd-after", errno: 3, identity: process().identityAfter }] };
    const r = reads([{ before: [42], after: [], processes: [gone], reason: null }, { before: [], after: [], processes: [], reason: null }]), native = r.native;
    r.native = async (m, p) => m === "surface.list" ? { generation: "0:1", value: { surfaces: [] } } : native(m, p);
    const result = await collectCurrentSessionCensus(r, 501);
    expect(result.attempts[1].kernel.after).toEqual([]); expect(result.attempts[1].before.reconciled).toBe(false);
    expect(result.finalMembership).toBeNull(); expect(result.resolutions[0].disposition).toBe("unresolved");
    expect(result.blockers).toContain("native membership mismatch");
  });
});
