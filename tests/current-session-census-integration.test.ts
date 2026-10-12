import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { collectCurrentSessionCensus, type CensusReads } from "../src/current-session-census.js";
import { createKernelProcessProbe, type ProbeRun, type ProbeRunner, type ProbeTask, type ProcessProbeObservation } from "../src/kernel-process-probe.js";

// The approved Python fixture supplies ctypes buffers; collect_owner is the actual
// helper. Supplying Fake prevents any libproc loading or host PID enumeration.
const pythonFixture = String.raw`
import ctypes as C, importlib.util, json, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("fixture", Path("tests/census_process_probe_test.py"))
f = importlib.util.module_from_spec(spec); spec.loader.exec_module(f)
scenario, uid = sys.argv[1], int(sys.argv[2]); assert uid == 501
lib = f.Fake()
if scenario == "partial":
    lib.reads[3][0] = (f.bsd(), 128, 0)
    lib.reads[9][0] = (f.cwd(), 1176, 0)
if scenario in ("identity-errno", "cwd-errno"):
    flavor = 3 if scenario == "identity-errno" else 9
    value, count, _ = lib.reads[flavor][0]; lib.reads[flavor][0] = (value, count, 1)
if scenario == "esrch": lib.reads[3][1] = (f.bsd(), 0, 3)
if scenario == "reuse": lib.reads[3] = [(f.bsd(usec=11), 136, 0)] * 2
if scenario == "unavailable": lib.enums = ["EPERM", "EPERM"]
if scenario in ("invalid-membership", "new-pid"):
    original = lib.proc_listpids
    def listpids(kind, owner, buffer, size):
        if scenario == "invalid-membership" and buffer is None: C.set_errno(0); return 8
        count = original(kind, owner, buffer, size)
        if buffer is not None:
            values = (C.c_int * 2)(42, -7) if scenario == "invalid-membership" else C.c_int(99)
            count = C.sizeof(values); C.memmove(buffer, C.byref(values), count)
        return count
    lib.proc_listpids = listpids
if scenario == "new-pid":
    lib.reads[3] = [(f.bsd(pid=99, usec=99), 136, 0)] * 2
    original_info = lib.proc_pidinfo
    def pidinfo(pid, flavor, arg, buffer, size):
        assert pid == 99
        return original_info(42, flavor, arg, buffer, size)
    lib.proc_pidinfo = pidinfo
value = f.p.collect_owner(uid, lib, actual_uid=501)
# These faults occur at serialization, after real helper collection.
if scenario == "malformed-row":
    value["processes"][0]["identityAfter"]["uid"] = "invalid"
    value["processes"][0]["argv"] = "PRIVATE_SENTINEL"
if scenario == "malformed-read":
    value["membershipReads"][0].update(observedPids=[42, -7], membership=None, errno=1, bytes=8, reason="ENUMERATION_READ_INVALID")
    value.update(before=None, reason="MEMBERSHIP_UNOBSERVED")
stdout = json.dumps(value, ensure_ascii=True)
print(stdout[:20] if scenario == "truncated" else stdout)
`;

const helper = resolve("scripts/census-process-probe.py");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const extra = (value: unknown) => value as Record<string, unknown>;
function fixture(scenario: string, uid: number): Promise<ProbeRun> {
  return new Promise((resolveRun, reject) => {
    execFile("python3", ["-c", pythonFixture, scenario, String(uid)], {
      encoding: "utf8", timeout: 2_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    }, (error, stdout, stderr) => {
      if (error) reject(error); // A fixture/setup failure must not masquerade as helper evidence.
      else resolveRun({ stdout, stderr, code: 0, failure: null, callbackSettled: true });
    });
  });
}
const nativeValues: Record<string, unknown> = {
  "system.capabilities": { methods: ["system.tree", "system.top", "debug.terminals", "window.list", "workspace.list", "pane.list", "surface.list"] },
  "window.list": { windows: [{ id: "w" }] }, "workspace.list": { workspaces: [{ id: "ws" }] },
  "pane.list": { panes: [{ id: "p", surface_ids: ["s"] }] }, "surface.list": { surfaces: [{ id: "s" }] },
  "debug.terminals": { count: 1, terminals: [{ surface_id: "s", mapped: true, runtime_surface_ready: true }] },
};
const graph = { windows: [{ id: "w", workspaces: [{ id: "ws", panes: [{ id: "p", surface_ids: ["s"], surfaces: [{ id: "s", type: "terminal" }] }] }] }] };
nativeValues["system.tree"] = graph; nativeValues["system.top"] = graph;
async function pipeline(scenarios: string[], mismatch = false, fault?: "OUTPUT_LIMIT" | "deadline") {
  const runs: ProbeRun[] = [], provider: ProcessProbeObservation[] = [];
  let index = 0, cancellationRequests = 0;
  const runner: ProbeRunner = (python, path, uid) => {
    expect([python, path, uid]).toEqual(["python3", helper, 501]);
    return fixture(scenarios[Math.min(index++, scenarios.length - 1)], uid).then(run => {
      runs.push(run);
      return fault === "OUTPUT_LIMIT" ? { ...run, code: null, failure: "OUTPUT_LIMIT", errorCode: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" } : run;
    });
  };
  // This deadline control uses completed fixture bytes and a deliberately pending
  // injected task; cancellation is a mock request, never a termination witness.
  let selected = runner;
  if (fault === "deadline") {
    const run = await fixture(scenarios[0], 501); runs.push(run);
    selected = () => {
      const task: ProbeTask = new Promise<ProbeRun>(() => {});
      task.cancel = () => { cancellationRequests++; };
      task.snapshot = () => ({ ...run, callbackSettled: false });
      return task;
    };
  }
  const probe = createKernelProcessProbe(helper, selected, { deadlineMs: fault === "deadline" ? 10 : 5_000 });
  const reads: CensusReads = {
    native: async method => ({ generation: "0:1", value: mismatch && method === "surface.list" ? { surfaces: [] } : nativeValues[method] }),
    kernel: async uid => { const value = await probe(uid); provider.push(value); return value; },
  };
  const census = await collectCurrentSessionCensus(reads, 501);
  const receiptDir = process.env.CMUX_CENSUS_INTEGRATION_RECEIPTS;
  if (receiptDir) await writeFile(join(receiptDir, `${scenarios.join("-")}-${mismatch}-${fault ?? "none"}.json`),
    JSON.stringify({ coverage: "actual Python/fake ABI, real provider/collector, synthetic native; simulated runner faults", runs, provider, census, cancellationRequests }, null, 2) + "\n", { mode: 0o600 });
  expect(census.status).toBe("INCOMPLETE");
  expect(census.witness).toContain("no removal authority");
  expect(JSON.stringify(census)).not.toContain("PRIVATE_SENTINEL");
  return { runs, provider, census, cancellationRequests };
}

describe("actual fake-ABI helper → provider → collector integration", () => {
  it("retains verified launch fields and null session without granting completeness", async () => {
    const { census, runs } = await pipeline(["valid"]);
    expect(runs).toHaveLength(1);
    expect(census.finalMembership).toMatchObject([{ pid: 42, ppid: 7, uid: 501, startSeconds: "123", startMicroseconds: "10", cwd: "/synthetic", sessionId: null }]);
  });
  it("retains partial fields AND exact short-read operation/count/context", async () => {
    const { provider, census } = await pipeline(["partial"]);
    expect(census.finalMembership).toBeNull();
    expect(census.observations[0]).toMatchObject({ pid: 42, uid: 501, startSeconds: "123", startMicroseconds: null, cwd: "/synthetic" });
    expect(provider[0].processes[0].failures).toMatchObject([
      { operation: "identity-before", errno: 0, reason: "SHORT_READ", bytes: 128, expectedBytes: 136, identity: { pid: 42, startSeconds: "123", startMicroseconds: null } },
      { operation: "cwd-before", errno: 0, reason: "SHORT_READ", bytes: 1176, expectedBytes: 2352 },
    ]);
    expect(census.observations[0].failures).toEqual(provider[0].processes[0].failures);
  });
  it.each(["identity-errno", "cwd-errno"])("preserves full byte counts with observed errno independently: %s", async scenario => {
    const { provider, census } = await pipeline([scenario]);
    const bytes = scenario === "identity-errno" ? 136 : 2352;
    expect(provider[0].processes[0].failures[0]).toMatchObject({ errno: 1, reason: "OBSERVED_ERRNO", bytes, expectedBytes: bytes });
    expect(census.observations[0]).toMatchObject({ uid: 501, startSeconds: "123", cwd: "/synthetic" });
    expect(census.finalMembership).toBeNull();
    expect(census.observations[0].failures).toEqual(provider[0].processes[0].failures);
  });
  it("preserves invalid membership value/index and exact enumeration byte counts", async () => {
    const { provider, census } = await pipeline(["invalid-membership"]);
    expect(census.attempts[0].kernel.before).toBeNull(); expect(census.finalMembership).toBeNull();
    expect(provider[0].membershipReads[0]).toMatchObject({ queryBytes: 8, bytes: 8, errno: 0, observedPids: [42], invalidEntries: [{ index: 1, value: -7 }] });
    expect(extra(census.attempts[0].kernel).membershipReads).toEqual(provider[0].membershipReads);
  });
  it("retains malformed after-row rejection while conserving independently valid before fields", async () => {
    const { provider, census } = await pipeline(["malformed-row"]);
    expect(census.observations[0]).toMatchObject({ pid: 42, uid: 501, startSeconds: "123", identityAfter: { uid: null } });
    expect(census.finalMembership).toBeNull();
    expect(provider[0].rejectedRows[0]).toMatchObject({ index: 0, pid: 42, evidence: { after: { uid: "invalid" } } });
    expect(extra(census.attempts[0].kernel).rejectedRows).toEqual(provider[0].rejectedRows);
  });
  it("retains serialized membership-rejection count/errno/value evidence", async () => {
    const { provider, census } = await pipeline(["malformed-read"]);
    expect(provider[0].rejectedMembershipReads[0]).toMatchObject({ index: 0, evidence: { bytes: 8, errno: 1, invalidEntries: [{ field: "observedPids", index: 1, value: -7 }] } });
    expect(census.finalMembership).toBeNull();
    expect(extra(census.attempts[0].kernel).rejectedMembershipReads).toEqual(provider[0].rejectedMembershipReads);
  });
  it("keeps unavailable membership null with its explicit helper reason", async () => {
    const { census } = await pipeline(["unavailable"]);
    expect(census.attempts[0].kernel).toMatchObject({ before: null, after: null, reason: "MEMBERSHIP_UNOBSERVED" });
    expect(census.finalMembership).toBeNull();
  });
  it("retains truncated serialization provenance while refusing empty-success substitution", async () => {
    const { runs, provider, census } = await pipeline(["truncated"]);
    expect(provider[0].helperOutputDigest).toBe(sha(runs[0].stdout));
    expect(census.attempts[0].kernel).toMatchObject({ before: null, after: null, reason: "MALFORMED_OUTPUT" });
    expect(census.finalMembership).toBeNull();
    expect(extra(census.attempts[0].kernel).helperOutputDigest).toBe(provider[0].helperOutputDigest);
  });
  it.each(["OUTPUT_LIMIT", "deadline"] as const)("retains bounded runner fault/cancellation provenance: %s", async fault => {
    const { provider, census, cancellationRequests } = await pipeline(["valid"], false, fault);
    expect(provider[0]).toMatchObject({ before: null, after: null, reason: fault === "deadline" ? "HELPER_TIMEOUT" : fault });
    expect(census.observations[0]).toMatchObject({ pid: 42, uid: 501, startMicroseconds: "10" });
    expect(census.finalMembership).toBeNull();
    if (fault === "deadline") { expect(cancellationRequests).toBe(2); expect(provider[0].runnerProvenance).toMatchObject({ deadlineMs: 10, cancellation: "requested", callbackSettled: false }); }
    expect(extra(census.attempts[0].kernel).runnerProvenance).toEqual(provider[0].runnerProvenance);
    expect(extra(census.attempts[0].kernel).helperExitCode).toBe(provider[0].helperExitCode);
  });
  it.each(["reuse", "new-pid"])("separates historical union from final scoped set: %s", async scenario => {
    const { census } = await pipeline(["esrch", scenario]);
    expect(census.attempts).toHaveLength(2);
    expect(census.observations.map(p => [p.pid, p.startMicroseconds])).toEqual([[42, "10"], scenario === "reuse" ? [42, "11"] : [99, "99"]]);
    expect(census.finalMembership?.map(p => [p.pid, p.startMicroseconds])).toEqual([scenario === "reuse" ? [42, "11"] : [99, "99"]]);
    expect(census.resolutions[0]).toMatchObject({ pid: 42, historicalIdentityKnown: true, disposition: scenario === "reuse" ? "reused" : "disappeared" });
  });
  it("does not qualify disappearance through mismatched synthetic native brackets", async () => {
    const { census } = await pipeline(["esrch", "new-pid"], true);
    expect(census.finalMembership).toBeNull();
    expect(census.attempts[1].kernel.after).toEqual([99]);
    expect(census.resolutions[0].disposition).toBe("unresolved");
    expect(census.blockers).toContain("native membership mismatch");
  });
});
