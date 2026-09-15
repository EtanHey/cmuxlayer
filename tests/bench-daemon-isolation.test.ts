import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildDaemonBenchmarkEnv } from "../scripts/bench-daemon.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("#641 confines actual child state writes to the benchmark root despite inherited production paths", () => {
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
    CMUX_BUNDLED_CLI_PATH: "/production/cmux", NODE_OPTIONS: "--stack-trace-limit=50",
  }, { tempRoot, binDir: join(tempRoot, "bin"), missingCmuxSocket: join(root, "fake.sock"), fakeCmuxState: join(tempRoot, "fake.json"), surfaceCount: 10 });
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { createServerContext } from './src/server.ts';
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const ctx = createServerContext({ skipAgentLifecycle: true });
    const paths = [ctx.stateDir, process.env.CMUXLAYER_INBOX_BASE_DIR, process.env.CODEX_HOME,
      process.env.CMUXLAYER_HARNESS_HOME];
    for (const dir of paths) { mkdirSync(dir, {recursive:true}); writeFileSync(join(dir, 'bench-canary'), 'owned'); }
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
