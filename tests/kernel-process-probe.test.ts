import { describe, expect, it } from "vitest";
import { createKernelProcessProbe } from "../src/kernel-process-probe.js";

const identity = { pid: 42, ppid: 7, uid: 501, startSeconds: "123", startMicroseconds: "10", cwd: "/synthetic" };
const value = { before: [42], after: [42], processes: [{ ...identity, identityAfter: identity, sessionId: null, errors: [], failures: [] }], reason: null,
  membershipReads: ["membership-before", "membership-after"].map(operation => ({ operation, observedPids: [42], membership: [42], queryBytes: 4, bytes: 4, capacityBytes: 1028, errno: 0, reason: null })) };
const run = (stdout = JSON.stringify(value), code = 0, failure: string | null = null) => async () => ({ stdout, code, failure });
describe("read-only kernel provider boundary", () => {
  it("retains kernel values and rejects private unknown helper fields", async () => {
    const observation = await createKernelProcessProbe("/synthetic-helper", run(JSON.stringify({ ...value, argv: "PRIVATE", processes: [{ ...value.processes[0], environment: "PRIVATE" }] })))(501);
    expect(observation.processes[0].identityAfter?.startMicroseconds).toBe("10");
    expect(JSON.stringify(observation)).not.toContain("PRIVATE");
    expect(observation.helperOutputDigest).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each(["", "{\"before\":", "{}"])("keeps unavailable membership null for invalid output %j", async stdout => {
    const observation = await createKernelProcessProbe("/synthetic-helper", run(stdout))(501);
    expect(observation.before).toBeNull(); expect(observation.after).toBeNull(); expect(observation.reason).not.toBeNull();
  });
  it.each(["PYTHON_UNAVAILABLE", "OUTPUT_LIMIT", "HELPER_TIMEOUT"])("records runner failure %s with partial observations", async failure => {
    const observation = await createKernelProcessProbe("/synthetic-helper", run(JSON.stringify(value), 1, failure))(501);
    expect(observation.processes[0].pid).toBe(42); expect(observation.before).toBeNull(); expect(observation.reason).toBe(failure);
  });
  it("preserves rejected row references when valid JSON contains a malformed process", async () => {
    const observation = await createKernelProcessProbe("/synthetic-helper", run(JSON.stringify({ ...value, processes: [{ pid: 99 }] })))(501);
    expect(observation.before).toBeNull(); expect(observation.rejectedRows[0].pid).toBe(99);
  });
  it("preserves unsupported-libproc reason and refuses invalid owner UID without running", async () => {
    const observation = await createKernelProcessProbe("/synthetic-helper", run(JSON.stringify({ before: null, after: null, processes: [], reason: "LIBPROC_UNAVAILABLE", membershipReads: [] })))(501);
    expect(observation.reason).toBe("LIBPROC_UNAVAILABLE");
    expect((await createKernelProcessProbe("/synthetic-helper", async () => { throw new Error("must not run"); })(-1)).reason).toBe("OWNER_UID_INVALID");
  });
  it("requires enumeration provenance and records exact nonzero exit without discarding observations", async () => {
    const invalid = await createKernelProcessProbe("/synthetic-helper", run(JSON.stringify({ ...value, membershipReads: [] })))(501);
    expect(invalid.before).toBeNull(); expect(invalid.processes[0].pid).toBe(42);
    const nonzero = await createKernelProcessProbe("/synthetic-helper", run(JSON.stringify(value), 7))(501);
    expect(nonzero.reason).toBe("HELPER_EXIT_NONZERO"); expect(nonzero.helperExitCode).toBe(7);
    expect(nonzero.membershipReads[0].observedPids).toEqual([42]);
  });
});
