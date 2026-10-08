import type { KernelObservation } from "./current-session-census.js";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { z } from "zod";
export interface ProbeRun { stdout: string; code: number; failure: string | null }
export type ProbeRunner = (python: string, helper: string, uid: number) => Promise<ProbeRun>;
const integer = z.number().int().safe();
const pid = integer.positive();
const code = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);
const identity = z.object({ pid: integer.nonnegative(), ppid: integer.nonnegative().nullable(), uid: integer.nonnegative().nullable(),
  startSeconds: decimal.nullable(), startMicroseconds: decimal.nullable(), cwd: z.string().startsWith("/").nullable() });
const process = identity.extend({ pid, identityAfter: identity.nullable(), sessionId: z.null(), errors: z.array(code),
  failures: z.array(z.object({ operation: z.enum(["identity-before", "identity-after", "cwd-before", "cwd-after", "membership-after"]),
    errno: integer.nonnegative().nullable(), identity: identity.nullable(), reason: code, bytes: integer.nullable(), expectedBytes: integer.nonnegative().nullable() })) });
const membership = z.object({ operation: z.enum(["membership-before", "membership-after"]), observedPids: z.array(pid),
  membership: z.array(pid).nullable(), queryBytes: integer, bytes: integer.nullable(), capacityBytes: integer.positive().nullable(), errno: integer.nonnegative(), reason: code.nullable() });
const output = z.object({ before: z.array(pid).nullable(), after: z.array(pid).nullable(), processes: z.array(process), reason: code.nullable(), membershipReads: z.array(membership) })
  .refine(v => v.reason !== null || ["before", "after"].every(endpoint => {
    const ids = endpoint === "before" ? v.before : v.after;
    const read = v.membershipReads.find(r => r.operation === `membership-${endpoint}`);
    return ids !== null && read?.reason === null && read.errno === 0 && read.membership !== null && read.bytes !== null && read.capacityBytes !== null &&
      read.bytes > 0 && read.bytes % 4 === 0 && read.bytes < read.capacityBytes && JSON.stringify(ids) === JSON.stringify(read.membership) && JSON.stringify(ids) === JSON.stringify(read.observedPids);
  }), "membership evidence required");
export type ProcessProbeObservation = KernelObservation & {
  membershipReads: z.infer<typeof membership>[]; helperOutputDigest: string | null; helperExitCode: number | null;
  rejectedRows: { index: number; pid: number | null; digest: string }[];
};
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
// Explicit helper path: source-tree scripts are not assumed to exist in an installed package.
const systemRunner: ProbeRunner = async (python, helper, uid) => {
  try { await access(helper, constants.R_OK); } catch { return { stdout: "", code: 1, failure: "HELPER_UNAVAILABLE" }; }
  return new Promise(resolve => execFile(python, [helper, String(uid)], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
    const failure = !error ? null : error.code === "ENOENT" ? "PYTHON_UNAVAILABLE" : error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "OUTPUT_LIMIT" : "HELPER_EXIT_NONZERO";
    resolve({ stdout, code: typeof error?.code === "number" ? error.code : error ? 1 : 0, failure });
  }));
};
export function createKernelProcessProbe(helper: string, runner: ProbeRunner = systemRunner): (uid: number) => Promise<ProcessProbeObservation> {
  return async uid => {
    let stdout = ""; let helperExitCode: number | null = null;
    const unavailable = (reason: string, raw?: unknown): ProcessProbeObservation => {
      const rows = raw && typeof raw === "object" && "processes" in raw && Array.isArray(raw.processes) ? raw.processes : [];
      const parsed = rows.map(row => process.safeParse(row));
      const reads = raw && typeof raw === "object" && "membershipReads" in raw && Array.isArray(raw.membershipReads) ? raw.membershipReads : [];
      return { before: null, after: null, processes: parsed.flatMap(r => r.success ? [r.data] : []), reason,
        membershipReads: reads.flatMap(r => { const parsed = membership.safeParse(r); return parsed.success ? [parsed.data] : []; }),
        helperOutputDigest: stdout ? digest(stdout) : null, helperExitCode,
        rejectedRows: rows.flatMap((row, index) => parsed[index].success ? [] : [{ index,
          pid: row && typeof row === "object" && "pid" in row && pid.safeParse(row.pid).success ? Number(row.pid) : null, digest: digest(JSON.stringify(row)) }]) };
    };
    if (!Number.isSafeInteger(uid) || uid < 0 || uid > 0xffffffff) return unavailable("OWNER_UID_INVALID");
    let result: ProbeRun;
    try { result = await runner("python3", helper, uid); stdout = result.stdout; helperExitCode = result.code; }
    catch { return unavailable("RUNNER_UNAVAILABLE"); }
    let raw: unknown;
    try { raw = JSON.parse(stdout); } catch { return unavailable(result.failure && code.safeParse(result.failure).success ? result.failure : result.code !== 0 ? "HELPER_EXIT_NONZERO" : stdout ? "MALFORMED_OUTPUT" : "EMPTY_OUTPUT"); }
    const parsed = output.safeParse(raw);
    if (!parsed.success) return unavailable("MALFORMED_OUTPUT", raw);
    const observation: ProcessProbeObservation = { ...parsed.data, helperOutputDigest: digest(stdout), helperExitCode, rejectedRows: [] };
    if (result.code !== 0 || result.failure) {
      observation.before = observation.after = null;
      observation.reason = result.failure && code.safeParse(result.failure).success ? result.failure : "HELPER_EXIT_NONZERO";
    }
    return observation;
  };
}
