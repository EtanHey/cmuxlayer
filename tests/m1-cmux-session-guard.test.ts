import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startSoakRuntime, stopOwnedProcess } from "../scripts/soak-runtime.mjs";
import * as runtime from "../scripts/soak-runtime.mjs";
import { options as soakOptions } from "../scripts/soak-live-options.mjs";
import { options as xmacOptions } from "../scripts/xmac/live.mjs";
import * as sessionGuard from "../scripts/cmux-session-guard.mjs";
import { assertM1CmuxMutation, observeCmuxSessions, parseHumanSessionApproval } from "../scripts/cmux-session-guard.mjs";
import { installApp } from "../scripts/xmac/install-app.mjs";
import { launchFailureRows } from "../scripts/xmac/launcher-preflight.mjs";

vi.mock("node:child_process", async original => ({ ...await original(), execFileSync: vi.fn(), spawn: vi.fn() }));
vi.mock("node:os", async original => ({ ...await original(), hostname: vi.fn() }));
vi.mock("../scripts/soak-app-guard.mjs", async original => ({ ...await original(), assertProcessTarget: vi.fn() }));
const start = "Wed Oct  7 14:02:52 2026", executable = "/Applications/cmux.app/Contents/MacOS/cmux";
const saved = `20248 ${start} ${executable}`, approval = `20248:${start}`;
const dirs: string[] = [];
const session = (pid = 20248, start_time = start) => ({ pid, start_time, executable,
  identity: `${pid} ${start_time} ${executable}`, launch_parent: { pid: 1, executable: "/sbin/launchd", source: "live_ppid" } });
const approvedReceipt = () => ({ processes: [], human_session_quit_approval: { value: approval, pid: 20248 } });
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("an identity-matching unowned M1 app is human_session and is never signalled", async () => {
  const signals: string[] = []; let alive = true;
  vi.mocked(execFileSync).mockReturnValue(`20248 1 ${start} ${executable}`);
  await expect(stopOwnedProcess({ pid: 20248, saved, target: "m1-gate", app: true }, [],
    () => alive ? saved : null, (_pid: number, signal: string) => { signals.push(signal); alive = false; }, async () => {}))
    .rejects.toMatchObject({ precondition: { status: "PRECONDITION_ABSENT", kind: "human_cmux_session" } });
  expect(signals).toEqual([]);
});

it("M1 startup retains human PID, start time and launch parent without reaching open/spawn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "human-cmux-test-")); dirs.push(dir);
  const app = join(dir, "cmux.app"); mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
  writeFileSync(join(app, "Contents/MacOS/cmux"), "synthetic");
  vi.mocked(hostname).mockReturnValue("M1.local");
  vi.mocked(execFileSync).mockImplementation(((cmd: string, args: string[]) => {
    if (cmd.endsWith("PlistBuddy")) return args[1].includes("ShortVersion") ? "0.64.22" : "com.cmuxterm.app";
    if (cmd === "ps") return args.includes("pid=,comm=") ? `20248 ${app}/Contents/MacOS/cmux` :
      args.includes("-axo") ? `20248 1 ${start} ${executable}` : saved;
    throw new Error(`unexpected executable: ${cmd}`);
  }) as typeof execFileSync);
  const output = join(dir, "receipts");
  await expect(startSoakRuntime({ app, target: "m1-gate", gateHost: "M1.local", dmg: "/unused" }, output))
    .rejects.toMatchObject({ precondition: { kind: "human_cmux_session", sessions: [
      expect.objectContaining({ pid: 20248, start_time: start, provenance: "human_session", launch_parent: expect.objectContaining({ pid: 1 }) }),
    ] } });
  const receipt = JSON.parse(readFileSync(join(output, readdirSync(output)[0]), "utf8"));
  expect(receipt.precondition.kind).toBe("human_cmux_session");
  expect(receipt.processes).toEqual([]); expect(spawn).not.toHaveBeenCalled();
  expect(vi.mocked(execFileSync).mock.calls.some(([cmd]) => cmd === "/usr/bin/open")).toBe(false);
});

it("both M1 CLIs accept and preserve the exact equals-form per-run approval", () => {
  expect(soakOptions(["--agent-id", "synthetic", "--target", "m1-gate", "--dry-run", "true",
    `--human-session-quit-approved=${approval}`])).toMatchObject({ humanSessionQuitApproved: approval });
  expect(xmacOptions(["--host", "m1", "--cmux", "prod", "--repo", "synthetic", "--dmg", "/synthetic.dmg",
    "--scenario", "synthetic.mjs", "--dry-run", `--human-session-quit-approved=${approval}`]))
    .toMatchObject({ humanSessionQuitApproved: approval });
});

it("app replacement refuses an unapproved human instance before calling the filesystem mutation", async () => {
  vi.mocked(hostname).mockReturnValue("M1.local");
  vi.mocked(execFileSync).mockReturnValue(`20248 1 ${start} ${executable}`);
  const replace = vi.fn(); const receipt = { processes: [] };
  await expect((runtime as any).guardedM1AppReplacement({ gateHost: "M1.local" }, receipt, replace))
    .rejects.toMatchObject({ precondition: { kind: "human_cmux_session" } });
  expect(replace).not.toHaveBeenCalled();
});

it("owns only the exact app recorded by this run; launch ancestry alone proves nothing", () => {
  const row = session(), receipt = { launch_token: "synthetic-run", app_process: {
    pid: row.pid, start_time: start, saved: row.identity, launch_token: "synthetic-run" } };
  expect(assertM1CmuxMutation([row], receipt)[0].provenance).toBe("harness_owned");
  for (const record of [{}, { ...receipt.app_process, launch_token: "foreign" }, { ...receipt.app_process, start_time: "changed" }]) {
    expect(() => assertM1CmuxMutation([row], { ...receipt, app_process: record })).toThrow(/human_cmux_session/);
  }
  expect(() => assertM1CmuxMutation([row, session(25089)], receipt)).toThrow(/human_cmux_session/);
});

it("approval matches PID and exact start only, never a second instance or replacement under a live app", () => {
  expect(assertM1CmuxMutation([session()], approvedReceipt())[0].quit_approved).toBe(true);
  for (const rows of [[session(25089)], [session(20248, "Wed Oct  7 14:15:07 2026")], [session(), session(25089)]]) {
    expect(() => assertM1CmuxMutation(rows, approvedReceipt())).toThrow(/human_cmux_session/);
  }
  expect(() => assertM1CmuxMutation([session()], approvedReceipt(), "replace")).toThrow(/human_cmux_session/);
});

it.each(["approved", "owned", "reused", "revoked"])("checks provenance again before each teardown signal (%s)", async mode => {
  vi.mocked(hostname).mockReturnValue("M1.local");
  let rows = [session()]; const signals: string[] = []; const receipt: any = approvedReceipt();
  receipt.host = "M1.local";
  if (mode === "owned" || mode === "revoked") Object.assign(receipt, { human_session_quit_approval: undefined, launch_token: "run",
    app_process: { pid: 20248, start_time: start, saved, launch_token: "run" } });
  const stopped = stopOwnedProcess({ pid: 20248, saved, target: "m1-gate", app: true, runReceipt: receipt }, receipt.processes,
    () => rows[0]?.identity ?? null, (_pid: number, signal: string) => {
      signals.push(signal);
      if (mode === "reused") rows = [session(20248, "Wed Oct  7 14:15:07 2026")];
      else if (mode === "revoked") receipt.app_process = undefined;
      else rows = [];
    }, async () => {}, () => rows);
  if (mode === "reused" || mode === "revoked") await expect(stopped).rejects.toMatchObject({ precondition: { kind: "human_cmux_session" } });
  else await stopped;
  expect(signals).toEqual(["SIGTERM"]);
});

it("replacement waits for the approved quit, records consent, and refuses a newly arrived human", async () => {
  vi.mocked(hostname).mockReturnValue("M1.local");
  for (const race of [false, true]) {
    let rows = [session()], observations = 0; const receipt: any = { processes: [] }, replace = vi.fn();
    const list = () => { observations++; return race && observations === 3 ? [session(25089)] : rows; };
    const stop = vi.fn(async (record: any) => { expect(record.pid).toBe(20248); rows = []; });
    const work = runtime.guardedM1AppReplacement({ gateHost: "M1.local", humanSessionQuitApproved: approval }, receipt, replace, list, stop);
    if (race) await expect(work).rejects.toMatchObject({ precondition: { kind: "human_cmux_session" } });
    else await work;
    expect(stop).toHaveBeenCalledTimes(1); expect(replace).toHaveBeenCalledTimes(race ? 0 : 1);
    expect(receipt.human_session_quit_approval).toMatchObject({ value: approval, pid: 20248, start_time: start, consumed: true });
    expect(() => assertM1CmuxMutation([session()], receipt)).toThrow(/human_cmux_session/);
  }
});

it("the concrete installer records refusal without copy, rename or signal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "human-cmux-install-")); dirs.push(dir);
  vi.mocked(hostname).mockReturnValue("M1.local"); vi.mocked(execFileSync).mockReturnValue(`20248 1 ${start} ${executable}`);
  const receipt = join(dir, "receipt.json");
  await expect(installApp({ gateHost: "M1.local", source: "/synthetic/source.app", backup: "/synthetic/backup.app", receipt }))
    .rejects.toMatchObject({ precondition: { kind: "human_cmux_session" } });
  expect(JSON.parse(readFileSync(receipt, "utf8"))).toMatchObject({ status: "FAIL", processes: [], precondition: { kind: "human_cmux_session" } });
  expect(vi.mocked(execFileSync).mock.calls.every(([cmd]) => cmd === "ps")).toBe(true);
});

it("process enumeration retains exact start and ancestry, and unreadable cmux identities fail closed", () => {
  expect(observeCmuxSessions(() => `1 0 Tue Oct  6 01:00:00 2026 /sbin/launchd\n20248 1 ${start} ${executable}`))
    .toEqual([expect.objectContaining({ pid: 20248, start_time: start, identity: saved, launch_parent: { pid: 1, executable: "/sbin/launchd", source: "live_ppid" } })]);
  expect(() => observeCmuxSessions(() => `20248 ??? ${executable}`)).toThrow(/unreadable/);
  const e: any = new Error("human"); e.precondition = { status: "PRECONDITION_ABSENT", kind: "human_cmux_session" };
  expect(launchFailureRows([{ id: "stray_newline" }], { host: "m1", cmux: "prod" }, "sha", "bug", "/evidence", e)[0])
    .toMatchObject({ status: "PRECONDITION_ABSENT", expected_defect: false, precondition: e.precondition });
});

it("normalizes native ps field padding without changing spaces inside the exact start time", () => {
  expect((sessionGuard as any).normalizeProcessIdentity(` 20248 ${start}     ${executable}\n`)).toBe(saved);
});

it("both CLIs reject malformed, duplicate, and non-M1 approvals", () => {
  for (const parser of [soakOptions, xmacOptions]) {
    for (const flag of ["", "20248", "1:" + start, approval + "\n", "20248:unknown"]) {
      if (flag) expect(() => parseHumanSessionApproval(flag)).toThrow(/approval/);
      expect(() => parser([`--human-session-quit-approved=${flag}`])).toThrow(/approval/);
    }
    expect(() => parser([`--human-session-quit-approved=${approval}`, `--human-session-quit-approved=${approval}`])).toThrow(/duplicate/);
  }
  expect(() => soakOptions(["--agent-id", "synthetic", `--human-session-quit-approved=${approval}`])).toThrow(/M1/);
  expect(() => xmacOptions(["--host", "mbp", "--cmux", "nightly", `--human-session-quit-approved=${approval}`])).toThrow(/M1/);
});

it("replay stops on a human-session refusal without trying a fix or another scenario", async () => {
  const { replaySamples } = await import("../scripts/xmac/live.mjs");
  const sample = vi.fn(async () => ({ rows: [{ status: "PRECONDITION_ABSENT", precondition: { kind: "human_cmux_session" } }] }));
  const scenario = { id: "synthetic", bug: { sha: "bug" }, fix: { sha: "fix" } };
  expect(await replaySamples([scenario, { ...scenario, id: "second" }], sample)).toMatchObject([{ status: "UNPROVEN" }]);
  expect(sample).toHaveBeenCalledTimes(1);
});

it("approved startup quits that exact synthetic PID, then preserves the DMG guard and post-quit baseline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "approved-cmux-test-")); dirs.push(dir);
  const app = join(dir, "cmux.app"), dmg = join(dir, "fake.dmg"), output = join(dir, "receipts");
  mkdirSync(join(app, "Contents/MacOS"), { recursive: true }); writeFileSync(join(app, "Contents/MacOS/cmux"), "synthetic"); writeFileSync(dmg, "wrong");
  let alive = true; vi.mocked(hostname).mockReturnValue("M1.local");
  const kill = vi.spyOn(process, "kill").mockImplementation(() => { alive = false; return true; });
  vi.mocked(execFileSync).mockImplementation(((cmd: string, args: string[]) => {
    if (cmd.endsWith("PlistBuddy")) return args[1].includes("ShortVersion") ? "0.64.22" : "com.cmuxterm.app";
    if (cmd === "ps" && args.includes("-axo")) return alive ? (args.includes("pid=,comm=") ? `20248 ${app}/Contents/MacOS/cmux` : `20248 1 ${start} ${executable}`) : "";
    if (cmd === "ps" && args.includes("11224")) return "unrelated";
    if (cmd === "ps" && alive) return args.includes("comm=") ? executable : `20248 ${start}     ${executable}`;
    throw new Error("synthetic process absent");
  }) as typeof execFileSync);
  await expect(startSoakRuntime({ app, dmg, target: "m1-gate", gateHost: "M1.local", humanSessionQuitApproved: approval }, output)).rejects.toThrow(/digest mismatch/);
  expect(kill).toHaveBeenCalledExactlyOnceWith(20248, "SIGTERM");
  const receipt = JSON.parse(readFileSync(join(output, readdirSync(output)[0]), "utf8"));
  expect(receipt).toMatchObject({ human_session_quit_approval: { value: approval, applied: true, consumed: true }, production_baseline: [], production_end: [], violations: [] });
  expect(receipt.production_start).toHaveLength(1); expect(spawn).not.toHaveBeenCalled();
});
