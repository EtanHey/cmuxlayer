import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { createKernelProcessProbe } from "../src/kernel-process-probe.js";
const mocks = vi.hoisted(() => ({ execFile: vi.fn(), access: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));
vi.mock("node:fs/promises", () => ({ access: mocks.access }));

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
  it("preserves valid before fields and rejection context beside malformed after fields", async () => {
    const raw = { ...value, processes: [{ ...value.processes[0], identityAfter: { ...identity, uid: "invalid", argv: "PRIVATE" } }] };
    const r = await createKernelProcessProbe("/synthetic", run(JSON.stringify(raw)))(501);
    expect(r.processes[0]).toMatchObject(identity); expect(r.processes[0].identityAfter).toMatchObject({ pid: 42, uid: null, cwd: "/synthetic" });
    expect(r.rejectedRows[0].evidence).toMatchObject({ after: { uid: "invalid" } });
    expect(r.reason).not.toBeNull(); expect(r.before).toBeNull(); expect(JSON.stringify(r)).not.toContain("PRIVATE");
  });
  it("preserves read operation/count/errno and valid PID references beside invalid entries", async () => {
    const raw = { ...value, before: null, reason: "MEMBERSHIP_UNOBSERVED", membershipReads: [{ ...value.membershipReads[0], observedPids: [42, -7], errno: 1 }, value.membershipReads[1]] };
    const r = await createKernelProcessProbe("/synthetic", run(JSON.stringify(raw)))(501);
    expect(r.membershipReads[0]).toMatchObject({ operation: "membership-before", bytes: 4, errno: 1, observedPids: [42], invalidEntries: [{ field: "observedPids", index: 1, value: -7 }] });
    expect(r.processes[0].uid).toBe(501); expect(r.before).toBeNull(); expect(r.rejectedMembershipReads[0].index).toBe(0);
  });
  it.each([{ uid: 502 }, { startMicroseconds: "1000000" }, { cwd: "/bad\0path" }])("blocks semantic-invalid evidence without erasing valid partial fields %j", async change => {
    const row = { ...value.processes[0], ...change, identityAfter: { ...identity, ...change } };
    const r = await createKernelProcessProbe("/synthetic", run(JSON.stringify({ ...value, processes: [row] })))(501);
    expect(r.reason).toBe("INVALID_PROCESS_EVIDENCE"); expect(r.before).toBeNull();
    expect(r.processes[0]).toMatchObject({ pid: 42, startSeconds: "123", ...change }); expect(r.processes[0].errors.length).toBeGreaterThan(0);
  });
  it("bounds an uncancellable injected runner and states that cancellation is unavailable", async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      const pending = createKernelProcessProbe("/synthetic", async () => new Promise<never>(() => {}), { deadlineMs: 50 })(501).then(r => { settled = true; return r; });
      await vi.advanceTimersByTimeAsync(49); expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1); const r = await pending;
      expect(r).toMatchObject({ reason: "HELPER_TIMEOUT", before: null, helperOutputDigest: null, helperExitCode: null, runnerProvenance: { deadlineMs: 50, cancellation: "unavailable", callbackSettled: false } });
    } finally { vi.useRealTimers(); }
  });
  it("aborts only its own execFile child and preserves callback output/error provenance", async () => {
    vi.useFakeTimers(); mocks.access.mockResolvedValue(undefined);
    const calls: { signal: AbortSignal; timeout: number; stdout: EventEmitter; complete: () => void }[] = [];
    mocks.execFile.mockImplementation((_python, args, options, callback) => {
      const stdout = new EventEmitter();
      expect(args).toEqual(["/synthetic", "501"]); expect(options.maxBuffer).toBe(16 * 1024 * 1024);
      const complete = () => callback(null, JSON.stringify(value), "");
      options.signal?.addEventListener("abort", () => callback(Object.assign(new Error("PRIVATE"), { code: "ABORT_ERR", killed: true, signal: "SIGTERM" }), JSON.stringify(value), "PRIVATE STDERR"));
      calls.push({ signal: options.signal, timeout: options.timeout, stdout, complete });
      return { stdout, stderr: new EventEmitter() }; // no real child or signals
    });
    try {
      const first = createKernelProcessProbe("/synthetic", undefined, { deadlineMs: 25 })(501);
      const second = createKernelProcessProbe("/synthetic", undefined, { deadlineMs: 50 })(501);
      await vi.advanceTimersByTimeAsync(0); expect(calls.map(c => c.timeout)).toEqual([25, 50]);
      expect(calls[0].signal).not.toBe(calls[1].signal);
      await vi.advanceTimersByTimeAsync(25); const r = await first;
      expect(calls.map(c => c.signal.aborted)).toEqual([true, false]); expect(r.processes[0].uid).toBe(501);
      expect(r).toMatchObject({ reason: "HELPER_TIMEOUT", before: null, helperExitCode: null, runnerProvenance: { cancellation: "requested", callbackSettled: true, errorCode: "ABORT_ERR", signal: "SIGTERM" } });
      expect(r.runnerProvenance.stderrDigest).toBe(createHash("sha256").update("PRIVATE STDERR").digest("hex"));
      expect(JSON.stringify(r)).not.toContain("PRIVATE"); calls[1].complete(); expect((await second).reason).toBeNull();
      await vi.advanceTimersByTimeAsync(50); expect(calls[1].signal.aborted).toBe(false);
    } finally { mocks.execFile.mockReset(); mocks.access.mockReset(); vi.useRealTimers(); }
  });
  it("retains available streamed output on deadline even without a child callback", async () => {
    vi.useFakeTimers(); mocks.access.mockResolvedValue(undefined);
    const stdout = new EventEmitter(); let signal!: AbortSignal;
    mocks.execFile.mockImplementation((_python, _args, options) => { signal = options.signal; return { stdout, stderr: new EventEmitter() }; });
    try {
      const pending = createKernelProcessProbe("/synthetic", undefined, { deadlineMs: 25 })(501);
      await vi.advanceTimersByTimeAsync(0); stdout.emit("data", JSON.stringify(value));
      await vi.advanceTimersByTimeAsync(25); const r = await pending;
      expect(signal.aborted).toBe(true); expect(r.processes[0].pid).toBe(42); expect(r.helperOutputDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(r.runnerProvenance).toMatchObject({ cancellation: "requested", callbackSettled: false });
    } finally { mocks.execFile.mockReset(); mocks.access.mockReset(); vi.useRealTimers(); }
  });
});
