import type { KernelObservation } from "./current-session-census.js";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { z } from "zod";
export interface ProbeRun { stdout: string; code: number | null; failure: string | null; stderr?: string; errorCode?: string | number | null; signal?: string | null; callbackSettled?: boolean }
/** Optional controls belong to this invocation's task, never a shared PID/runner. */
export type ProbeTask = Promise<ProbeRun> & { cancel?: () => void; snapshot?: () => ProbeRun };
export type ProbeRunner = (python: string, helper: string, uid: number) => ProbeTask;
export interface ProbeOptions { deadlineMs?: number }
const integer = z.number().int().safe(), pid = integer.positive();
const code = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);
const identity = z.object({ pid: integer.nonnegative(), ppid: integer.nonnegative().nullable(), uid: integer.nonnegative().nullable(),
  startSeconds: decimal.nullable(), startMicroseconds: decimal.nullable(), cwd: z.string().startsWith("/").nullable() });
const failure = z.object({ operation: z.enum(["identity-before", "identity-after", "cwd-before", "cwd-after", "membership-after", "unavailable"]),
  errno: integer.nonnegative().nullable(), identity: identity.nullable(), reason: code, bytes: integer.nullable(), expectedBytes: integer.nonnegative().nullable() });
const process = identity.extend({ pid, identityAfter: identity.nullable(), sessionId: z.null(), errors: z.array(code), failures: z.array(failure) });
const invalidEntry = z.object({ index: integer.nonnegative(), value: z.union([z.number().finite(), z.string(), z.boolean(), z.null()]), field: z.string().optional() });
const membership = z.object({ operation: z.enum(["membership-before", "membership-after", "unavailable"]), observedPids: z.array(pid),
  membership: z.array(pid).nullable(), queryBytes: integer.nullable(), bytes: integer.nullable(), capacityBytes: integer.positive().nullable(), errno: integer.nonnegative().nullable(), reason: code.nullable(), invalidEntries: z.array(invalidEntry).optional() });
const output = z.object({ before: z.array(pid).nullable(), after: z.array(pid).nullable(), processes: z.array(process), reason: code.nullable(), membershipReads: z.array(membership) })
  .refine(v => v.reason !== null || ["before", "after"].every(endpoint => {
    const ids = endpoint === "before" ? v.before : v.after, read = v.membershipReads.find(r => r.operation === `membership-${endpoint}`);
    return ids !== null && read?.reason === null && read.errno === 0 && !read.invalidEntries?.length && read.membership !== null && read.bytes !== null && read.capacityBytes !== null &&
      read.queryBytes !== null && read.queryBytes > 0 && read.bytes > 0 && read.bytes % 4 === 0 && read.bytes < read.capacityBytes && JSON.stringify(ids) === JSON.stringify(read.membership) && JSON.stringify(ids) === JSON.stringify(read.observedPids);
  }), "membership evidence required");
export type ProcessProbeObservation = KernelObservation & {
  membershipReads: z.infer<typeof membership>[]; helperOutputDigest: string | null; helperExitCode: number | null;
  rejectedRows: { index: number; pid: number | null; digest: string; evidence: unknown }[];
  rejectedMembershipReads: { index: number; evidence: unknown }[];
  runnerProvenance: { deadlineMs: number; cancellation: string; callbackSettled: boolean; stderrDigest: string | null; errorCode: string | number | null; signal: string | null };
};
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const scalar = (v: unknown) => v === null || ["string", "boolean"].includes(typeof v) || (typeof v === "number" && Number.isFinite(v));
const fields = (shape: Record<string, z.ZodType>, raw: unknown) => Object.fromEntries(Object.entries(shape).flatMap(([k, schema]) => {
  const parsed = schema.safeParse(record(raw)[k]); return parsed.success ? [[k, parsed.data]] : [];
}));
const witness = (raw: unknown, keys: string[]) => Object.fromEntries(keys.flatMap(k => scalar(record(raw)[k]) ? [[k, record(raw)[k]]] : []));
const identityWitness = (raw: unknown) => witness(raw, Object.keys(identity.shape));
const projectedIdentity = (raw: unknown) => {
  const r = fields(identity.shape, raw);
  return typeof r.pid !== "number" ? null : identity.parse({ ppid: null, uid: null, startSeconds: null, startMicroseconds: null, cwd: null, ...r });
};
// Explicit helper path; deadline is workload policy, never a freshness witness.
function systemRunner(deadlineMs: number): ProbeRunner {
  return (python, helper, uid) => {
    const controller = new AbortController(); let latest: ProbeRun = { stdout: "", stderr: "", code: null, failure: null, callbackSettled: false };
    let finish!: (value: ProbeRun) => void;
    const task: ProbeTask = new Promise(resolve => { finish = resolve; });
    task.snapshot = () => latest; task.cancel = () => controller.abort();
    void access(helper, constants.R_OK).then(() => {
      if (controller.signal.aborted) return;
      const child = execFile(python, [helper, String(uid)], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: deadlineMs, signal: controller.signal }, (error, stdout, stderr) => {
        const failure = !error ? null : error.code === "ENOENT" ? "PYTHON_UNAVAILABLE" : error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "OUTPUT_LIMIT" : controller.signal.aborted || error.killed ? "HELPER_TIMEOUT" : "HELPER_EXIT_NONZERO";
        latest = { stdout, stderr, code: typeof error?.code === "number" ? error.code : error ? null : 0, failure,
          errorCode: error?.code ?? null, signal: error?.signal ?? null, callbackSettled: true }; finish(latest);
      });
      // Capture bounded available output even if the callback has not settled.
      child.stdout?.on("data", chunk => { latest.stdout = (latest.stdout + String(chunk)).slice(0, 16 * 1024 * 1024); });
      child.stderr?.on("data", chunk => { latest.stderr = ((latest.stderr ?? "") + String(chunk)).slice(0, 16 * 1024 * 1024); });
    }).catch(() => { latest = { ...latest, failure: controller.signal.aborted ? "HELPER_TIMEOUT" : "HELPER_UNAVAILABLE" }; finish(latest); });
    return task;
  };
}
export function createKernelProcessProbe(helper: string, runner?: ProbeRunner, options: ProbeOptions = {}): (uid: number) => Promise<ProcessProbeObservation> {
  const deadlineMs = options.deadlineMs ?? 10_000;
  return async uid => {
    let result: ProbeRun = { stdout: "", code: null, failure: null }, cancellation = "not-requested";
    let raw: unknown;
    const decode = (reason: string | null): ProcessProbeObservation => {
      const source = record(raw), rows = Array.isArray(source.processes) ? source.processes : [], rejectedRows: ProcessProbeObservation["rejectedRows"] = [];
      const processes = rows.flatMap((rawRow, index) => {
        const row = record(rawRow), before = projectedIdentity(row), after = projectedIdentity(row.identityAfter), parsed = process.safeParse(row);
        if (!parsed.success) rejectedRows.push({ index, pid: pid.safeParse(row.pid).success ? Number(row.pid) : null, digest: digest(JSON.stringify(rawRow)),
          evidence: { before: identityWitness(row), after: identityWitness(row.identityAfter), failures: (Array.isArray(row.failures) ? row.failures : []).map(f => ({ ...witness(f, ["operation", "errno", "reason", "bytes", "expectedBytes"]), identity: identityWitness(record(f).identity) })) } });
        if (!before || !pid.safeParse(before.pid).success) return [];
        const errors = Array.isArray(row.errors) ? row.errors.filter((e): e is string => code.safeParse(e).success) : [];
        if (!parsed.success) errors.push("MALFORMED_PROCESS_ROW");
        for (const p of [before, after]) if (p) {
          if (p.uid !== null && p.uid !== uid) errors.push("UID_MISMATCH");
          if (p.startMicroseconds !== null && Number(p.startMicroseconds) >= 1_000_000) errors.push("INVALID_START");
          if (p.cwd?.includes("\0")) errors.push("INVALID_CWD");
        }
        return [{ ...before, identityAfter: after, sessionId: null, errors, failures: (Array.isArray(row.failures) ? row.failures : []).map(f => failure.parse({ operation: "unavailable", errno: null, reason: "MALFORMED_FAILURE", bytes: null, expectedBytes: null,
          ...fields(failure.shape, f), identity: projectedIdentity(record(f).identity) })) }];
      });
      const rejectedMembershipReads: ProcessProbeObservation["rejectedMembershipReads"] = [];
      const membershipReads = (Array.isArray(source.membershipReads) ? source.membershipReads : []).map((rawRead, index) => {
        const row = record(rawRead), parsed = membership.safeParse(row), invalidEntries: z.infer<typeof invalidEntry>[] = [];
        for (const field of ["observedPids", "membership"]) if (Array.isArray(row[field])) row[field].forEach((v, index) => { if (!pid.safeParse(v).success && scalar(v)) invalidEntries.push({ field, index, value: v }); });
        if (!parsed.success) rejectedMembershipReads.push({ index, evidence: { ...witness(row, ["operation", "queryBytes", "bytes", "capacityBytes", "errno", "reason"]), invalidEntries } });
        return membership.parse({ operation: "unavailable", membership: null, queryBytes: null, bytes: null, capacityBytes: null, errno: null, reason: "MALFORMED_MEMBERSHIP_READ",
          ...fields(membership.shape, row), observedPids: Array.isArray(row.observedPids) ? row.observedPids.filter(v => pid.safeParse(v).success) : [],
          invalidEntries: [...(parsed.success ? parsed.data.invalidEntries ?? [] : []), ...invalidEntries] });
      });
      if (rejectedRows.length || rejectedMembershipReads.length) reason ??= "MALFORMED_OUTPUT";
      if (processes.some(p => p.errors.some(e => ["UID_MISMATCH", "INVALID_START", "INVALID_CWD"].includes(e)))) reason ??= "INVALID_PROCESS_EVIDENCE";
      const parsed = output.safeParse(raw); if (!parsed.success) reason ??= "MALFORMED_OUTPUT";
      return { before: reason === null && parsed.success ? parsed.data.before : null, after: reason === null && parsed.success ? parsed.data.after : null, processes, reason, membershipReads, rejectedRows, rejectedMembershipReads,
        helperOutputDigest: result.stdout ? digest(result.stdout) : null, helperExitCode: result.code,
        runnerProvenance: { deadlineMs, cancellation, callbackSettled: result.callbackSettled === true, stderrDigest: result.stderr ? digest(result.stderr) : null, errorCode: result.errorCode ?? null, signal: result.signal ?? null } };
    };
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 2_147_483_647) return decode("DEADLINE_INVALID");
    if (!Number.isSafeInteger(uid) || uid < 0 || uid > 0xffffffff) return decode("OWNER_UID_INVALID");
    try {
      const task = (runner ?? systemRunner(deadlineMs))("python3", helper, uid);
      result = await new Promise<ProbeRun>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          settled = true; cancellation = task.cancel ? "requested" : "unavailable";
          try { task.cancel?.(); } catch { cancellation = "failed"; }
          let partial: ProbeRun | undefined; try { partial = task.snapshot?.(); } catch { /* unavailable snapshot */ }
          resolve({ stdout: "", code: null, ...partial, failure: "HELPER_TIMEOUT" });
        }, deadlineMs);
        task.then(value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } }, error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
      });
    } catch { return decode("RUNNER_UNAVAILABLE"); }
    const failureReason = result.failure && code.safeParse(result.failure).success ? result.failure : result.code !== 0 ? "HELPER_EXIT_NONZERO" : null;
    try { raw = JSON.parse(result.stdout); } catch { return decode(failureReason ?? (result.stdout ? "MALFORMED_OUTPUT" : "EMPTY_OUTPUT")); }
    const reportedReason = record(raw).reason;
    return decode(failureReason ?? (code.safeParse(reportedReason).success ? String(reportedReason) : null));
  };
}
