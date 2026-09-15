import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as benchmark from "../scripts/bench-daemon.mjs";
import { buildDaemonBenchmarkEnv } from "../scripts/bench-daemon.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("#641 confines actual child state writes to the benchmark root despite inherited production paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "bench-isolation-")); roots.push(root);
  const parentHome = join(root, "parent-home"); mkdirSync(parentHome);
  const tempRoot = join(root, "run"); mkdirSync(tempRoot);
  const env = buildDaemonBenchmarkEnv({
    ...process.env, VITEST: undefined, HOME: parentHome,
    CODEX_HOME: join(parentHome, ".codex"),
    CMUXLAYER_INBOX_BASE_DIR: join(parentHome, "inbox"),
    CMUXLAYER_HARNESS_HOME: parentHome,
    CMUXLAYER_SEAT_REGISTRY_PATH: join(parentHome, "seats.json"),
    CMUXLAYER_SESSION_REGISTRY: join(parentHome, "sessions.jsonl"),
    CMUXLAYER_FLEET_SIDEBAR_OUTPUT_PATH: join(parentHome, "sidebar.swift"),
    CMUXLAYER_DAEMON_PID_RECEIPT: join(parentHome, "pids.txt"),
    GH_TOKEN: "seeded-fake-token", GITHUB_TOKEN: "seeded-fake-token", GH_CONFIG_DIR: join(parentHome, "gh"),
    CMUX_BUNDLED_CLI_PATH: "/production/cmux", NODE_OPTIONS: "--stack-trace-limit=50",
  }, { tempRoot, binDir: join(tempRoot, "bin"), missingCmuxSocket: join(root, "fake.sock"), fakeCmuxState: join(tempRoot, "fake.json"), surfaceCount: 10 });
  expect(env.GH_TOKEN).toBeUndefined();
  expect(env.GITHUB_TOKEN).toBeUndefined();
  expect(env.GH_CONFIG_DIR.startsWith(tempRoot + "/")).toBe(true);
  expect(typeof benchmark.writeBenchmarkCommandStubs).toBe("function");
  mkdirSync(join(tempRoot, "bin"), { recursive: true });
  await benchmark.writeBenchmarkCommandStubs(join(tempRoot, "bin"));
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { createServerContext } from './src/server.ts';
    import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
    import { StateManager } from './src/state-manager.ts';
    import { dispatch, inboxPath } from './src/inbox.ts';
    import { writeDeliveryFailureTicket, fileDeliveryFailureGithubIssue } from './src/delivery-failure-tickets.ts';
    import { join } from 'node:path';
    const ctx = createServerContext({ skipAgentLifecycle: true });
    const paths = [ctx.stateDir, process.env.CMUXLAYER_INBOX_BASE_DIR, process.env.CODEX_HOME,
      process.env.CMUXLAYER_HARNESS_HOME];
    for (const dir of paths) { mkdirSync(dir, {recursive:true}); writeFileSync(join(dir, 'bench-canary'), 'owned'); }
    const state = new StateManager(ctx.stateDir);
    state.writeState({ agent_id: 'isolation-canary', surface_id: 'surface:fake', state: 'working', repo: 'fixture', cli: 'codex', cli_session_id: null, pid: null });
    dispatch('isolation-canary', { from: 'fixture', task: 'isolation-canary' });
    const ticket = { signature: 'isolation-canary', delivery_id: 'fixture', agent_id: 'fixture', reason: 'fixture', what_happened: 'fixture', what_fixed_it: 'fixture', evidence: {}, observed_at: new Date().toISOString() };
    const written = writeDeliveryFailureTicket(ticket);
    const github = await fileDeliveryFailureGithubIssue(ticket);
    paths.push(state.stateFilePath('isolation-canary'), inboxPath('isolation-canary'), written.path, process.env.CMUXLAYER_BENCH_GH_RECEIPT);
    if (github !== null || !paths.every(existsSync)) throw new Error('missing contained writer artifact');
    const ghCalls = readFileSync(process.env.CMUXLAYER_BENCH_GH_RECEIPT, 'utf8');
    if (!ghCalls.includes('issue') || !ghCalls.includes('list')) throw new Error('missing fake gh receipt');
    process.stdout.write(JSON.stringify(paths));
  `], { cwd: join(__dirname, ".."), env, encoding: "utf8", timeout: 20_000 });
  expect(child.status, child.stderr).toBe(0);
  for (const path of JSON.parse(child.stdout)) expect(path.startsWith(tempRoot + "/")).toBe(true);
  for (const name of ["CMUXLAYER_SEAT_REGISTRY_PATH", "CMUXLAYER_SESSION_REGISTRY", "CMUXLAYER_FLEET_SIDEBAR_OUTPUT_PATH", "CMUXLAYER_DAEMON_PID_RECEIPT"])
    expect(env[name].startsWith(tempRoot + "/"), name).toBe(true);
  expect(env.HOME).toBe(join(tempRoot, "home"));
  expect(env.CMUX_BUNDLED_CLI_PATH).toBeUndefined();
  expect(env.NODE_OPTIONS).toBeUndefined();
  expect(readdirSync(parentHome)).toEqual([]);
}, 25_000);
