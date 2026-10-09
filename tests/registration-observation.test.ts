import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { open, rename, stat, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRegistrationReader } from "../src/registration-observation.js";
import { collectCurrentSessionCensus, type CensusReads } from "../src/current-session-census.js";

type Options = NonNullable<Parameters<typeof createRegistrationReader>[0]>;
const base = join(process.cwd(), "docs.local/gc-registration-observation/fixtures");
mkdirSync(base, { recursive: true, mode: 0o700 });
function fixture(bytes: string | Buffer) {
  const dir = mkdtempSync(join(base, "case-")), path = join(dir, "registry.jsonl");
  writeFileSync(path, bytes, { mode: 0o600 }); return path;
}
const sha = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const identity = { pid: 1834, ppid: 1, uid: 501, startSeconds: "123", startMicroseconds: "1", cwd: "/claimed" };
const graph = { windows: [{ id: "w", workspaces: [{ id: "ws", panes: [{ id: "p", surface_ids: ["s"], surfaces: [{ id: "s" }] }] }] }] };
const native: CensusReads["native"] = async method => ({ generation: "0:1", value: ({
  "system.capabilities": { methods: ["system.tree", "system.top", "debug.terminals", "window.list", "workspace.list", "pane.list", "surface.list"] },
  "system.tree": graph, "system.top": graph, "window.list": { windows: [{ id: "w" }] },
  "workspace.list": { workspaces: [{ id: "ws" }] }, "pane.list": { panes: [{ id: "p", surface_ids: ["s"] }] },
  "surface.list": { surfaces: [{ id: "s" }] }, "debug.terminals": { terminals: [{ surface_id: "s", mapped: true }] },
} as Record<string, unknown>)[method] });
async function collect(reader?: ReturnType<typeof createRegistrationReader>) {
  const result = await collectCurrentSessionCensus({ native, registrationObservation: reader,
    kernel: async () => ({ before: [1834], after: [1834], reason: null, processes: [
      { ...identity, identityAfter: identity, sessionId: null, errors: [], failures: [] },
    ] }) }, 501);
  expect(result.status).toBe("INCOMPLETE"); expect(result.finalRegistrationMembership).toBeNull();
  expect(result.finalRegistrationMembershipReason).toBeTruthy();
  expect(result.blockers).toContain("registration final coverage unknown"); return result;
}
const reader = (path: string, extra: Options = {}) => createRegistrationReader({ env: { CMUXLAYER_SESSION_REGISTRY: path }, ...extra });
function intercepted(action: (path: string, calls: number) => Promise<void>): Options["io"] {
  return { stat, open: async (path, flags) => {
    const h = await open(path, flags); let calls = 0;
    return { stat: h.stat.bind(h), close: h.close.bind(h), read: async (...args: Parameters<typeof h.read>) => {
      await action(path, ++calls); return h.read(...args);
    } };
  } };
}
describe("physical registration bytes through the actual census", () => {
  it.each([
    '{"private":"cwd":"/PRIVATE_CANARY","session_id":"kept","launch_cwd":"/kept"}',
    '{"private" "cwd":"/PRIVATE_CANARY","session_id":"kept","launch_cwd":"/kept"}',
    '{"private":"p\\u0069d":1834,"session_id":"kept","launch_cwd":"/kept"}',
    '{"private":[{"cwd":"/PRIVATE_CANARY"}],"session_id":"kept","launch_cwd":"/kept"}',
    '{"private":{"cwd":"/PRIVATE_CANARY","cwd":"/PRIVATE_CANARY"},"session_id":"kept","launch_cwd":"/kept"}',
  ])("keeps private/value/member contexts separate and retains independent later members: %s", async bytes => {
    const result = await collect(reader(fixture(bytes))), row = result.registrationObservation!.rows[0];
    expect(row.claims.cwd).toBeUndefined(); expect(row.claims.pid).toBeUndefined();
    expect(row.sessionId).toBe("kept"); expect(row.claims.launch_cwd?.[0].value).toBe("/kept");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_CANARY"); expect(row.digest).toBe(sha(bytes));
  });
  it("does not reinterpret a second root object as a registration member", async () => {
    const bytes = '{"session_id":"kept"}{"cwd":"/PRIVATE_CANARY"}';
    const result = await collect(reader(fixture(bytes))), row = result.registrationObservation!.rows[0];
    expect(row.sessionId).toBe("kept"); expect(row.claims.cwd).toBeUndefined();
    expect(row.disposition).toBe("malformed"); expect(JSON.stringify(result)).not.toContain("PRIVATE_CANARY");
  });
  it.each(["byte-limit", "field-prefix", "read-failure", "EOF"])("retains a cut numeric lexeme with unknown value beside independent complete fields: %s", async mode => {
    const prefix = '{"session_id":"kept","cwd":"/kept","pid":12', bytes = prefix + '3456}\n';
    const options: Options = mode === "byte-limit" ? { maxBytes: prefix.length, maxRowBytes: prefix.length }
      : mode === "field-prefix" ? { maxRowBytes: prefix.length } : {};
    if (mode === "read-failure") options.io = { stat, open: async (p, flags) => {
      const h = await open(p, flags); let calls = 0;
      return { stat: h.stat.bind(h), close: h.close.bind(h), read: async (buffer, offset, length, position) => {
        if (++calls > 1) throw new Error("owned injected read failure");
        return h.read(buffer, offset, Math.min(length, prefix.length), position);
      } };
    } };
    const result = await collect(reader(fixture(mode === "EOF" ? prefix : bytes), options)), row = result.registrationObservation!.rows[0];
    expect(row.claims.pid?.[0]).toMatchObject({ kind: "incomplete-number", value: null, usable: false, numberLexeme: "12", numericBoundaryObserved: false });
    expect(row.sessionId).toBe("kept"); expect(row.claims.cwd?.[0].value).toBe("/kept");
    if (mode === "field-prefix") expect(row.digest).toBe(sha(bytes));
    else if (mode === "EOF") expect(row.digest).toBe(sha(prefix));
    else { expect(row.digest).toBeNull(); expect(row.prefixDigest).toBe(sha(prefix)); expect(result.registrationObservation?.unknownRemainder).not.toBeNull(); }
  });
  it.each([",", " ", "\t", "}", "}\r\n"])("retains a completed numeric claim when the actual boundary is observed: %j", async boundary => {
    const bytes = '{"session_id":"kept","ts":1e,"pid":12' + boundary;
    const row = (await collect(reader(fixture(bytes)))).registrationObservation!.rows[0];
    expect(row.claims.pid?.[0]).toMatchObject({ value: 12, usable: true, numberLexeme: "12", numericBoundaryObserved: true });
    expect(row.sessionId).toBe("kept"); expect(row.claims.ts?.[0]).toMatchObject({ kind: "invalid", usable: false, numberLexeme: "1e" });
    expect(row.byteOffset).toBe(0); expect(row.digest).toBe(sha(bytes));
  });
  it("distinguishes identical row bytes and computes UTF-8 offsets without an extra terminal-LF row", async () => {
    const line = '{"session_id":"שלום😀"}\n', rows = (await collect(reader(fixture(line + line)))).registrationObservation!.rows;
    expect(rows).toHaveLength(2); expect(rows[1].byteOffset).toBe(Buffer.byteLength(line));
    expect(rows[0].digest).toBe(rows[1].digest); expect(rows[0].reference).not.toBe(rows[1].reference);
    expect(rows[1].sessionId).toBe("שלום😀");
  });
  it("preserves independently valid claims beside invalid UTF-8 without replacing invalid bytes", async () => {
    const bytes = Buffer.concat([Buffer.from('{"pid":1834,"cwd":"'), Buffer.from([255]), Buffer.from('","session_id":"kept"}\n')]);
    const row = (await collect(reader(fixture(bytes)))).registrationObservation!.rows[0];
    expect(row.digest).toBe(sha(bytes)); expect(row.sessionId).toBe("kept"); expect(row.claims.pid?.[0].value).toBe(1834);
    expect(row.claims.cwd?.[0].usable).toBe(false); expect(row.reasons).toContain("invalid UTF-8");
  });
  it("retains historical and identical-content rows with distinct physical references and exact delimiter hashes", async () => {
    const line = '{"pid":1834,"ts":1,"cwd":"/claimed","session_id":"old","surface_uuid":"s"}';
    const path = fixture(`${line}\r\n${line}\n\n${line}`), result = await collect(reader(path));
    const rows = result.registrationObservation!.rows;
    expect(rows.map(r => r.rowNumber)).toEqual([1, 2, 3, 4]);
    expect(rows.map(r => r.byteOffset)).toEqual([0, Buffer.byteLength(line) + 2, Buffer.byteLength(line) * 2 + 3, Buffer.byteLength(line) * 2 + 4]);
    expect(rows.map(r => r.digest)).toEqual([sha(line + "\r\n"), sha(line + "\n"), sha("\n"), sha(line)]);
    expect(rows.map(r => r.delimiter)).toEqual(["LF", "LF", "LF", "EOF"]);
    expect(new Set(rows.map(r => r.reference)).size).toBe(4);
    expect(result.registrations).toHaveLength(4); expect(rows[0].claims.ts?.[0].value).toBe(1);
  });
  it.each(['{"session_id":"kept","pid":-2,', '{"session_id":"kept","pid":false}',
    '{"pid":broken,"session_id":"kept","cwd":"/kept"}',
    '{"session_id":"kept","cwd":"/kept","secret":{"session_id":"PRIVATE_CANARY"}} junk',
    '{"session_id":"one","session_id":"two","pid":1834,"pid":0}',
    '{"session_id":"kept","x":{"hidden":1,"hidden":2}}']) ("conserves independent fields and malformed/duplicate witnesses: %s", async bytes => {
    const result = await collect(reader(fixture(bytes))), row = result.registrationObservation!.rows[0];
    expect(row.digest).toBe(sha(bytes)); expect(row.disposition).toBe("malformed");
    expect(row.claims.session_id?.map(c => c.value)).toEqual(bytes.includes('"one"') ? ["one", "two"] : ["kept"]);
    if (bytes.includes('"one"')) { expect(row.sessionId).toBeNull(); expect(row.claims.pid?.map(c => c.value)).toEqual([1834, 0]); }
    if (bytes.includes('"hidden"')) expect(row.reasons).toContain("duplicate key");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_CANARY");
  });
  it("preserves malformed numeric lexemes without converting rounded decimal claims into usable integers", async () => {
    const row = (await collect(reader(fixture('{"pid":1.00000000000000000001,"ts":1e,"session_id":"kept"}')))).registrationObservation!.rows[0];
    expect(row.sessionId).toBe("kept"); expect(row.claims.pid?.[0]).toMatchObject({ usable: false, numberLexeme: "1.00000000000000000001" });
    expect(row.claims.ts?.[0]).toMatchObject({ kind: "invalid", usable: false, numberLexeme: "1e" });
  });
  it("retains oversized hashes and available prefix fields, with no discarded following row", async () => {
    const huge = '{"pid":1834,"cwd":"/kept","unknown":"' + "x".repeat(5000) + '"}\n';
    const rows = (await collect(reader(fixture(huge + '{"session_id":"next"}\n'), { maxRowBytes: 40 }))).registrationObservation!.rows;
    expect(rows).toHaveLength(2); expect(rows[0].digest).toBe(sha(huge));
    expect(rows[0].claims.pid?.[0].value).toBe(1834); expect(rows[0].claims.cwd?.[0].value).toBe("/kept");
    expect(rows[0].reasons).toContain("oversized row; fields beyond prefix unknown"); expect(rows[1].sessionId).toBe("next");
  });
  it("preserves invalid allowlisted values and exact numeric lexemes while excluding compound contents", async () => {
    const row = (await collect(reader(fixture('{"pid":9007199254740993,"ts":1e400,"cwd":false,"launcher":{"argv":"PRIVATE_CANARY"},"session_path":""}')))).registrationObservation!.rows[0];
    expect(row.claims.pid?.[0]).toMatchObject({ usable: false, numberLexeme: "9007199254740993" });
    expect(row.claims.ts?.[0]).toMatchObject({ usable: false, value: null, numberLexeme: "1e400" });
    expect(row.claims.cwd?.[0]).toMatchObject({ value: false, usable: false });
    expect(row.claims.launcher?.[0]).toMatchObject({ kind: "object", value: null, usable: false });
    expect(row.claims.session_path?.[0].value).toBe(""); expect(JSON.stringify(row)).not.toContain("PRIVATE_CANARY");
  });
  it("retains matching path/PID/surface/time/session claims without creating kernel identity or a join", async () => {
    const transcript = fixture("PRIVATE_CANARY"), path = fixture(JSON.stringify({ pid: 1834, cwd: "/claimed", surface_uuid: "s", ts: 123,
      session_id: "claimed", worktree_path: "/tree", launch_cwd: "/launch", session_path: transcript, cli: "codex", launcher: "worker", argv: "PRIVATE_CANARY", env: { secret: "PRIVATE_CANARY" } }));
    const result = await collect(reader(path)), row = result.registrationObservation!.rows[0];
    expect(row.sessionId).toBe("claimed"); expect(row.capturedLaunch).toBeNull(); expect(row.harnessProcessRef).toBeNull();
    expect(Object.keys(row.missingEvidence)).toEqual(["host", "boot", "uid", "kernelStart", "harnessProcess", "session"]);
    expect(row.missingEvidence.kernelStart).toBe("parent PID is only a claim");
    expect(row.claims.worktree_path?.[0].value).toBe("/tree"); expect(row.claims.launch_cwd?.[0].value).toBe("/launch");
    expect(row.claims.session_path?.[0].value).toBe(transcript); expect(Object.hasOwn(row, "kernelIdentityObservation")).toBe(false);
    expect(result.observations[0].sessionId).toBeNull(); expect(JSON.stringify(result)).not.toContain("PRIVATE_CANARY");
  });
  it("distinguishes observed empty bytes, unavailable source, read failure and missing injected reader", async () => {
    const path = fixture(""), empty = (await collect(reader(path))).registrationObservation!;
    expect(empty).toMatchObject({ content: "observed", rows: [], unknownRemainder: null, finalCoverage: null });
    expect(empty.readStartedAt).toBeTruthy(); expect(empty.readCompletedAt).toBeTruthy();
    const missing = await collect(reader(path + "-missing")); expect(missing.registrations).toBeNull();
    expect(missing.registrationObservation).toMatchObject({ content: "unavailable", rows: [], unknownRemainder: { byteOffset: 0 } });
    const failed = await collect(reader(path, { io: intercepted(async () => { throw new Error("PRIVATE_CANARY"); }) }));
    expect(failed.registrationObservation?.content).toBe("unavailable"); expect(failed.registrations).toBeNull();
    expect(JSON.stringify(failed)).not.toContain("PRIVATE_CANARY"); expect((await collect()).registrationObservation).toBeNull();
  });
  it("rejects an owned synthetic FIFO promptly without treating it as empty bytes", async () => {
    const path = fixture("") + ".fifo";
    expect(spawnSync("mkfifo", [path]).status).toBe(0);
    const o = (await collect(reader(path))).registrationObservation!;
    expect(o.content).toBe("unavailable"); expect(o.rows).toEqual([]); expect(o.unknownRemainder).not.toBeNull();
  });
  it.each(["read failure", "rotation", "truncation", "stat failure"])("retains known rows and unknown remainder after %s", async mode => {
    const bytes = '{"session_id":"kept"}\n', path = fixture(bytes);
    const io = intercepted(async (p, calls) => {
      if (calls !== 2) return;
      if (mode === "read failure") throw new Error("read failed");
      if (mode === "truncation") await truncate(p, 0);
      if (mode === "rotation") { await rename(p, p + ".old"); await writeFile(p, "", { mode: 0o600 }); }
    });
    if (mode === "stat failure") io!.stat = vi.fn(async () => { throw new Error("stat failed"); }) as typeof stat;
    const observed = (await collect(reader(path, { io }))).registrationObservation!;
    expect(observed.rows).toHaveLength(1); expect(observed.rows[0].digest).toBe(sha(bytes));
    expect(observed.unknownRemainder).not.toBeNull(); expect(observed.content).toBe("observed");
    if (mode === "rotation") expect(observed.reasons).toContain("selected source rotated during read");
    if (mode === "truncation") expect(observed.unknownRemainder?.byteOffset).toBe(0);
  });
  it("retains a read-failure prefix without claiming EOF or fabricating unseen rows", async () => {
    const path = fixture('{"pid":1834,"session_id":"prefix"}');
    const o = (await collect(reader(path, { io: intercepted(async (_, calls) => { if (calls === 2) throw new Error("failed"); }) }))).registrationObservation!;
    expect(o.rows).toHaveLength(1); expect(o.rows[0]).toMatchObject({ delimiter: "UNKNOWN", digest: null, sessionId: "prefix" });
    expect(o.rows[0].prefixDigest).toBe(sha('{"pid":1834,"session_id":"prefix"}'));
  });
  it("records a mutation between final descriptor and selected-path stat without deleting the earlier witness", async () => {
    const bytes = '{"session_id":"kept"}\n', path = fixture(bytes);
    const o = (await collect(reader(path, { io: { open, stat: (async p => {
      await writeFile(path, bytes + '{}\n', { mode: 0o600 }); return stat(p);
    }) as typeof stat } }))).registrationObservation!;
    expect(o.rows).toHaveLength(1); expect(o.rows[0].digest).toBe(sha(bytes));
    expect(o.reasons).toContain("selected source changed after descriptor read"); expect(o.unknownRemainder?.byteOffset).toBe(0);
  });
  it("leaves limits explicit, keeps available prefix fields and never numbers unread rows", async () => {
    const bytes = '{"pid":1834,"session_id":"old"}\n{"pid":2}\n', path = fixture(bytes);
    const bounded = (await collect(reader(path, { maxBytes: 12, maxRowBytes: 12 }))).registrationObservation!;
    expect(bounded.rows).toHaveLength(1); expect(bounded.rows[0]).toMatchObject({ digest: null, delimiter: "UNKNOWN" });
    expect(bounded.rows[0].prefixDigest).toBe(sha(bytes.slice(0, 12))); expect(bounded.rows[0].claims.pid?.[0].value).toBe(1834);
    const limited = (await collect(reader(path, { maxRows: 1 }))).registrationObservation!;
    expect(limited.rows.map(r => r.rowNumber)).toEqual([1]); expect(limited.unknownRemainder?.byteOffset).toBe(bytes.indexOf("\n") + 1);
  });
  it("records default/override selection independently of the distinct Golems override, without eager I/O", async () => {
    const path = fixture('{}\n'), io = { open: vi.fn(open), stat };
    const selected = createRegistrationReader({ env: { CMUXLAYER_SESSION_REGISTRY: path, WORKTREE_GC_CMUX_REGISTRY: "/different" }, io });
    expect(io.open).not.toHaveBeenCalled(); expect((await collect(selected)).registrationObservation?.source).toMatchObject({ path, selection: "CMUXLAYER_SESSION_REGISTRY" });
    const home = mkdtempSync(join(base, "home-")); mkdirSync(join(home, ".cmuxlayer"), { mode: 0o700 });
    writeFileSync(join(home, ".cmuxlayer/session-registry.jsonl"), "", { mode: 0o600 });
    expect((await collect(createRegistrationReader({ env: { WORKTREE_GC_CMUX_REGISTRY: path }, home }))).registrationObservation?.source.selection).toBe("default");
  });
});
