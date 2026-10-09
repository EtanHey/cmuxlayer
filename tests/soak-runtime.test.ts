import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import net from "node:net";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { assertAppTarget } from "../scripts/soak-app-guard.mjs";
import { acquireNightlyLock, releaseNightlyLock, isolatedEnvironment, stopOwnedProcess, startSoakRuntime, socketIsLive, targetEnvironment } from "../scripts/soak-runtime.mjs";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync), spawn: vi.fn(actual.spawn) };
});
vi.mock("node:os", async (original) => {
  const actual = await original<typeof import("node:os")>();
  return { ...actual, hostname: vi.fn(actual.hostname) };
});

const temps: string[] = [];
afterEach(() => { vi.mocked(execFileSync).mockReset(); vi.mocked(hostname).mockReset();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const mockBundle = (bundle = "com.cmuxterm.app.nightly", executableBundle = bundle, version = "0.64.22") => ({
  realpath: (path: string) => path.includes("/MacOS/") ? "/Executable.app/Contents/MacOS/cmux" : "/Wrapper.app",
  readPlist: (app: string, key: string) => key === "CFBundleShortVersionString" ? version : app === "/Executable.app" ? executableBundle : bundle,
});
it("refuses renamed stable apps and a nightly wrapper whose executable is production", () => {
  for (const bundle of [mockBundle("com.cmuxterm.app"), mockBundle("com.cmuxterm.app.nightly", "com.cmuxterm.app")]) {
    expect(() => assertAppTarget("/Misleading NIGHTLY.app", bundle)).toThrow(/identity mismatch/);
  }
});
it("refuses production socket routes before launch", () => {
  expect(() => assertAppTarget("/Nightly.app", { ...mockBundle(), socketPath: "/tmp/cmux.sock" })).toThrow(/socket refused/);
});
it("requires a designated M1, exact stable version, and stable bundle", () => {
  const gate = { target: "m1-gate", gateHost: "M1.local", hostname: "M1.local", socketPath: "/tmp/cmux-soak-stable.sock" };
  expect(assertAppTarget("/cmux.app", { ...mockBundle("com.cmuxterm.app"), ...gate })).toMatchObject({ version: "0.64.22", target: "m1-gate" });
  expect(() => assertAppTarget("/cmux.app", { ...mockBundle("com.cmuxterm.app"), ...gate, hostname: "MacBook-Pro.local" })).toThrow(/M1 host/);
  expect(() => assertAppTarget("/cmux.app", { ...mockBundle("com.cmuxterm.app", "com.cmuxterm.app", "0.64.25"), ...gate })).toThrow(/0.64.22/);
  expect(() => assertAppTarget("/cmux.app", { ...mockBundle(), ...gate })).toThrow(/identity mismatch/);
});
it("uses an exclusive shared lock and cannot release another run's token", () => {
  const dir = mkdtempSync(join(tmpdir(), "soak-test-")); temps.push(dir);
  const path = join(dir, "lock"); acquireNightlyLock(path, "mine");
  expect(() => acquireNightlyLock(path, "other")).toThrow();
  expect(() => releaseNightlyLock(path, "other")).toThrow(/ownership changed/);
  expect(readFileSync(path, "utf8")).toBe("mine");
  releaseNightlyLock(path, "mine");
});
it("clears production routing and harness homes from both daemon and shell environment", () => {
  const env = isolatedEnvironment({ HOME: "/personal", PATH: "/bin", CMUX_SOCKET_PATH: "/tmp/cmux.sock",
    CMUXLAYER_DAEMON_SOCKET: "/tmp/prod.sock", CODEX_HOME: "/personal/.codex", CLAUDE_CONFIG_DIR: "/personal/.claude",
    GOLEM_SEAT: "owner", GIT_DIR: "/repo/.git", XDG_STATE_HOME: "/personal/state" }, "/scratch");
  expect(env).toMatchObject({ HOME: "/scratch/home", CMUX_SOCKET_PATH: "/tmp/cmux-nightly.sock",
    CMUXLAYER_DAEMON_SOCKET: "/scratch/d.sock", CODEX_HOME: "/scratch/home/.codex", CLAUDE_CONFIG_DIR: "/scratch/home/.claude" });
  expect(env.GOLEM_SEAT).toBeUndefined(); expect(env.GIT_DIR).toBeUndefined();
});
it("never signals a reused PID, including reuse between TERM and KILL", async () => {
  const signals: string[] = [];
  await expect(stopOwnedProcess({ pid: 99, saved: "old start" }, [], () => "new start",
    (_pid: number, signal: string) => signals.push(signal), async () => {})).rejects.toThrow(/identity/);
  expect(signals).toEqual([]);
  let observed = "old start";
  await expect(stopOwnedProcess({ pid: 99, saved: observed }, [], () => observed,
    (_pid: number, signal: string) => { signals.push(signal); observed = "new start"; }, async () => {})).rejects.toThrow(/identity/);
  expect(signals).toEqual(["SIGTERM"]);
});

it.each([true, false])("M1 refuses before open/spawn when an unowned stable process exists=%s", async (existing) => {
  const dir = mkdtempSync(join(tmpdir(), "soak-test-")); temps.push(dir);
  const app = join(dir, "Renamed.app"), binary = join(app, "Contents/MacOS/cmux"), dmg = join(dir, "fake.dmg");
  mkdirSync(join(app, "Contents/MacOS"), { recursive: true }); writeFileSync(binary, "synthetic"); writeFileSync(dmg, "wrong digest");
  vi.mocked(hostname).mockReturnValue("M1.local");
  vi.mocked(execFileSync).mockImplementation(((cmd: string, args: string[]) => {
    if (cmd.endsWith("PlistBuddy")) return args[1].includes("ShortVersion") ? "0.64.22" : "com.cmuxterm.app";
    if (cmd === "ps") return args.includes("-axo") ? (existing ? (args.includes("pid=,ppid=,lstart=,comm=") ?
      `77 1 Wed Oct  7 14:02:52 2026 ${binary}` : `77 ${binary}`) : "") : "77 synthetic-start";
    throw new Error(`unexpected executable: ${cmd}`);
  }) as typeof execFileSync);
  await expect(startSoakRuntime({ app, target: "m1-gate", gateHost: "M1.local", dmg }, join(dir, "receipts")))
    .rejects.toThrow(existing ? /existing stable/ : /digest mismatch/);
  expect(vi.mocked(execFileSync).mock.calls.some(([cmd]) => cmd === "/usr/bin/open")).toBe(false);
  expect(spawn).not.toHaveBeenCalled();
});

it("distinguishes absent, live and abandoned sockets without deleting them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "soak-test-")); temps.push(dir);
  const path = join(dir, "s.sock");
  expect(await socketIsLive(path)).toBe(false);
  const server = net.createServer(socket => socket.end());
  await new Promise<void>(resolve => server.listen(path, resolve));
  try { expect(await socketIsLive(path)).toBe(true); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  expect(await socketIsLive(path)).toBe(false);
});

it("M1 uses its real auth HOME while daemon state and inbox stay per-run private", () => {
  const env = targetEnvironment({ HOME: "/home/test-operator", PATH: "/bin", CODEX_HOME: "/unrelated/auth",
    CMUXLAYER_STATE_DIR: "/production/state", CMUXLAYER_INBOX_BASE_DIR: "/production/inbox" },
    "/scratch", { target: "m1-gate", app: "/Applications/cmux.app" }, "/home/test-operator");
  expect(env).toMatchObject({ HOME: "/home/test-operator", CODEX_HOME: "/home/test-operator/.codex",
    CLAUDE_CONFIG_DIR: "/home/test-operator/.claude", CMUXLAYER_HARNESS_HOME: "/home/test-operator",
    CMUXLAYER_DAEMON_SOCKET: "/scratch/d.sock", CMUXLAYER_STATE_DIR: "/scratch/state",
    CMUXLAYER_INBOX_BASE_DIR: "/scratch/inbox", CMUX_SOCKET_PATH: "/tmp/cmux-soak-stable.sock" });
});
it("NIGHTLY does not inherit the operator's real auth HOME", () => {
  expect(targetEnvironment({ HOME: "/home/test-operator", PATH: "/bin" }, "/scratch",
    { target: "nightly", app: "/Applications/cmux NIGHTLY.app" }, "/home/test-operator"))
    .toMatchObject({ HOME: "/scratch/home", CMUXLAYER_STATE_DIR: "/scratch/state", CMUXLAYER_INBOX_BASE_DIR: "/scratch/inbox" });
});
