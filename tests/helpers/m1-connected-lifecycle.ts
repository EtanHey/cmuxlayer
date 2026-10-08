// Exact caller bodies with only OS/filesystem/process/RPC dependencies injected.
import { readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { admitAppStart } from "../../scripts/xmac/app-admission.mjs";
import { rows } from "../../scripts/xmac/m1-ratchet.mjs";
export async function actualLifecycleContexts() {
  const contexts: any[] = [{ phase: "baseline", identifiers: [], agentIds: [] }];
  let token = "", launched = false;
  const scratch = "/synthetic/tmp/cmux-soak-private", socket = "/tmp/cmux-soak-stable.sock", app = "/synthetic/cmux.app";
  const env = { HOME: scratch + "/home", CMUXLAYER_FLEET_CONFIG: scratch + "/fleet.json", CMUXLAYER_DAEMON_SOCKET: scratch + "/d.sock", CMUX_SOCKET_PATH: socket };
  const noop = () => {}, io: any = { join, sep, createHash, randomUUID, admitAppStart,
    NIGHTLY_SOCKET: "/synthetic/nightly.sock", INSTALLED_ENTRY: "/synthetic/entry",
    PINNED_DMG_SHA256: createHash("sha256").update("synthetic dmg").digest("hex"),
    process: { getuid: () => 502, env: {}, once: noop, off: noop, exit: () => { throw Error("LIVE EXIT FORBIDDEN"); } },
    tmpdir: () => "/synthetic/tmp", hostname: () => "Locals-MacBook-Pro.local", production: () => [], identity: () => "synthetic identity",
    mkdirSync: noop, writeFileSync: noop, stopOwnedProcess: async () => { launched = false; }, launchRecords: () => [],
    releaseNightlyLock: noop, acquireNightlyLock: noop, preflightM1Session: noop, socketIsLive: async () => false,
    existsSync: (p: string) => p === env.CMUXLAYER_DAEMON_SOCKET, mkdtempSync: () => scratch,
    launcherEnvironment: (e: any) => e, targetEnvironment: () => env, createScenarioRepo: () => ({ path: "/synthetic/repo", run_dir: "/synthetic/run", close: noop }),
    assertAppTarget: () => ({}), readFileSync: (p: string) => p === "/synthetic/dmg" ? Buffer.from("synthetic dmg") : JSON.stringify({ version: "0.4.101" }),
    privateBuild: () => ({ daemon: "/synthetic/daemon", entry: "/synthetic/entry" }), installFixtureLaunchers: () => ({ launchers: {}, row: "synthetic" }),
    verifyFixtureLaunchers: noop, writeShellStartup: noop, verifyFixtureShell: () => ({}), appLaunchEnvironment: (e: any) => e,
    verifyClosePreferences: () => ({}), prepareM1AppMutation: async () => {}, processes: () => launched ? ["88 " + app + "/Contents/MacOS/cmux"] : [],
    run: (cmd: string, args: string[]) => {
      if (cmd === "/usr/bin/open") { launched = true; token = args[args.indexOf("--soak-launch-token") + 1]; return ""; }
      if (cmd === "lsof") return socket;
      if (cmd === "ps") return args.at(-1) === "args=" ? token : args.at(-1) === "comm=" ? app + "/Contents/MacOS/cmux" : "synthetic start";
      throw Error("UNPLANNED native command " + cmd);
    }, closePreferenceArgs: () => [], assertProcessTarget: noop, pause: async () => {},
    rpc: async (_p: string, method: string) => method === "system.ping" ? {} : method === "workspace.create" ? { workspace_id: "workspace", surface_id: "surface" } : (() => { throw Error("UNPLANNED RPC " + method); })(),
    spawn: () => Object.assign(new EventEmitter(), { pid: 77, exitCode: null }) };
  const source = readFileSync("scripts/soak-runtime.mjs", "utf8"), start = source.indexOf("export async function startSoakRuntime");
  if (start < 0) throw Error("actual runtime body missing");
  const runtime = new Function(...Object.keys(io), source.slice(start).replace("export ", "") + ";return startSoakRuntime;")(...Object.values(io));
  const sample = readFileSync("scripts/xmac/m1-ratchet.mjs", "utf8"), a = sample.indexOf("  const scope =", sample.indexOf("async function sample(")), z = sample.indexOf("  const before =", a);
  if (a < 0 || z < a) throw Error("actual sample scope wrapper missing");
  const openScope = new Function("row", "side", "guard", sample.slice(a, z) + ";return accountGuard;");
  for (const row of rows) for (const side of ["baseline", "candidate"]) {
    const guard = { check: (ctx: any) => contexts.push({ phase: ctx.phase ?? "checkpoint", identifiers: ctx.identifiers ?? [], agentIds: ctx.agentIds ?? [] }), result: () => ({}) };
    const scoped = openScope(row, side, guard);
    const instance = await runtime({ target: "m1-gate", fixtureMode: true, accountContract: "dedicated-test-502-v1",
      assertAccount: (ctx: any) => scoped.check({ ...ctx, identifiers: ["synthetic-token"], agentIds: [] }), app, dmg: "/synthetic/dmg", buildRoot: "/synthetic/product", sha: "b".repeat(40) }, "/synthetic/output");
    await instance.close(); scoped.check({ phase: "sample-final", identifiers: ["synthetic-token"], agentIds: [] });
  }
  contexts.push({ phase: "run-final", identifiers: [], agentIds: [] }); return contexts;
}
