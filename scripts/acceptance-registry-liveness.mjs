#!/usr/bin/env node
// §7 live acceptance for the registry-liveness fix (RC1–RC6).
//
// Drives the FIXED cmuxlayer MCP (dist/index.js) against a REAL cmux instance:
//   1. spawn N claude agents into a scoped throwaway workspace
//   2. wait for each to reach an interactive (ready/idle) state
//   3. RC3  — broadcast(role:"all") MUST deliver to all N (0 skipped "dead:error")
//   4. RC4  — resync_agents() MUST NOT evict/orphan any of the N live surfaces
//   5. RC4  — send_to(agent_id) MUST deliver to each (still registry-addressable)
//   6. §b   — kill one CLI child while its pane persists, force registry error,
//              then reject silent delivered:true shell/void writes and require
//              convergence to delivered:false/dead:* within three sends
//   7. cleanup: force-close the N surfaces
//
// Must run from a PANE-DESCENDED shell (cmux ancestry access-control denies
// non-pane-descended peers). Opt in with CMUX_LIVE_HARNESS=1.
//
// Usage:
//   CMUX_LIVE_HARNESS=1 node scripts/acceptance-registry-liveness.mjs \
//     --server node --server-arg /abs/path/to/dist/index.js \
//     [--count 3] [--repo cmuxlayer] [--workspace <ref>] [--wait-timeout-ms 180000]
//
// Exit 0 + both "GREEN_DEADCHILD" and "GREEN_REGISTRY_LIVENESS" on pass.
// If process discovery/state forcing is unavailable, the probe prints an
// explicit MANUAL_DEADCHILD instruction and fails rather than silently skipping.

import { execFile, spawn } from "node:child_process";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEAD_CHILD_SEND_ATTEMPTS = 3;

function parseArgs(argv) {
  const o = {
    server: "node",
    serverArgs: [],
    count: 3,
    repo: "cmuxlayer",
    cli: "claude",
    workspace: "",
    waitTimeoutMs: 180_000,
    selfTestDeadChild: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[(i += 1)];
    if (a === "--server") o.server = next();
    else if (a === "--server-arg") o.serverArgs.push(next());
    else if (a === "--count") o.count = Number(next());
    else if (a === "--repo") o.repo = next();
    else if (a === "--cli") o.cli = next();
    else if (a === "--workspace") o.workspace = next();
    else if (a === "--wait-timeout-ms") o.waitTimeoutMs = Number(next());
    else if (a === "--self-test-dead-child") o.selfTestDeadChild = true;
    else if (a === "--help" || a === "-h") {
      process.stdout.write("see header of this file for usage\n");
      process.exit(0);
    }
  }
  return o;
}

function terminalNegativeReceipt(receipt) {
  return (
    receipt?.delivered === false ||
    (typeof receipt?.skipped === "string" &&
      receipt.skipped.startsWith("dead:"))
  );
}

function screenHasLiveAgentContext(screenText, sentinel) {
  if (typeof screenText !== "string" || screenText.trim().length === 0) {
    return false;
  }
  const tail = screenText.split("\n").slice(-20);
  const tailText = tail.join("\n");
  if (/\[Process completed\]|process exited|command not found/i.test(tailText)) {
    return false;
  }
  const sentinelAtShellPrompt = tail.some((line) => {
    const sentinelIndex = line.indexOf(sentinel);
    return (
      sentinelIndex >= 0 &&
      /[$#%]\s*$/.test(line.slice(0, sentinelIndex))
    );
  });
  if (sentinelAtShellPrompt) return false;
  return /Claude Code|OpenAI Codex|Cursor Agent|Gemini CLI|\bKiro\b/i.test(
    tailText,
  );
}

export function classifyDeadChildAttempt({ receipt, screenText, sentinel }) {
  if (terminalNegativeReceipt(receipt)) {
    return { acceptable: true, terminalNegative: true, falseGreen: false };
  }

  const liveAgentEcho =
    receipt?.delivered === true &&
    typeof screenText === "string" &&
    screenText.includes(sentinel) &&
    screenHasLiveAgentContext(screenText, sentinel);
  return {
    acceptable: liveAgentEcho,
    terminalNegative: false,
    falseGreen: receipt?.delivered === true && !liveAgentEcho,
  };
}

export function deadChildAttemptsConverged(attempts) {
  return (
    attempts.length === DEAD_CHILD_SEND_ATTEMPTS &&
    attempts.every((attempt) => attempt.acceptable) &&
    attempts.at(-1)?.terminalNegative === true
  );
}

function runDeadChildSelfTest() {
  const sentinel = "DEAD_CHILD_SELFTEST_SENTINEL";
  const deliveredFalse = classifyDeadChildAttempt({
    receipt: { delivered: false },
    screenText: "",
    sentinel,
  });
  const deadErrorSkip = classifyDeadChildAttempt({
    receipt: { delivered: false, skipped: "dead:error" },
    screenText: "",
    sentinel,
  });
  const liveAgentEcho = classifyDeadChildAttempt({
    receipt: { delivered: true },
    screenText: `Claude Code\n❯ ${sentinel}`,
    sentinel,
  });
  const shellFalseGreen = classifyDeadChildAttempt({
    receipt: { delivered: true },
    screenText: `$ ${sentinel}`,
    sentinel,
  });
  const staleIdentityShellFalseGreen = classifyDeadChildAttempt({
    receipt: { delivered: true },
    screenText: `Claude Code\nTask finished\n$ ${sentinel}`,
    sentinel,
  });
  const converged = deadChildAttemptsConverged([
    liveAgentEcho,
    deliveredFalse,
    deadErrorSkip,
  ]);
  const checks = {
    delivered_false:
      deliveredFalse.acceptable && deliveredFalse.terminalNegative,
    dead_error_skip:
      deadErrorSkip.acceptable && deadErrorSkip.terminalNegative,
    live_agent_echo:
      liveAgentEcho.acceptable && !liveAgentEcho.falseGreen,
    shell_false_green:
      !shellFalseGreen.acceptable && shellFalseGreen.falseGreen,
    stale_identity_shell_false_green:
      !staleIdentityShellFalseGreen.acceptable &&
      staleIdentityShellFalseGreen.falseGreen,
    three_attempt_convergence: converged,
  };
  for (const [name, passed] of Object.entries(checks)) {
    process.stdout.write(`${name}=${passed ? "PASS" : "FAIL"}\n`);
  }
  const green = Object.values(checks).every(Boolean);
  process.stdout.write(
    `${green ? "GREEN_DEADCHILD_SELFTEST" : "RED_DEADCHILD_SELFTEST"}\n`,
  );
  return green;
}

function parseSurfaceProcesses(topOutput, surfaceId) {
  return topOutput
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(
      (columns) =>
        columns.length >= 7 &&
        columns[3] === "process" &&
        columns[5] === surfaceId &&
        /^\d+$/.test(columns[4] ?? ""),
    )
    .map((columns) => ({
      pid: Number(columns[4]),
      rss: Number(columns[1]) || 0,
      command: columns.slice(6).join("\t").trim(),
    }));
}

async function findBackingAgentProcess(surfaceId, workspaceId) {
  const args = [
    "top",
    ...(workspaceId ? ["--workspace", workspaceId] : ["--all"]),
    "--processes",
    "--flat",
    "--format",
    "tsv",
  ];
  const { stdout } = await execFileAsync("cmux", args, {
    maxBuffer: 4 * 1024 * 1024,
  });
  const infrastructure = /^(?:shellbook(?:\.real)?|fswatch|tail|caffeinate|zsh|bash|fish|sh)(?:\s|$)/i;
  return parseSurfaceProcesses(stdout, surfaceId)
    .filter((entry) => !infrastructure.test(entry.command))
    .sort((left, right) => right.rss - left.rss)[0] ?? null;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function killBackingProcess(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }
  await delay(1_000);
  if (processAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      return false;
    }
    await delay(500);
  }
  return !processAlive(pid);
}

async function forceAgentErrorState(agentId) {
  const stateRoot =
    process.env.CMUXLAYER_ACCEPTANCE_STATE_DIR ??
    join(homedir(), ".local", "state", "cmux-agents");
  for (const entry of await readdir(stateRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const statePath = join(stateRoot, entry.name, "state.json");
    let record;
    try {
      record = JSON.parse(await readFile(statePath, "utf8"));
    } catch {
      continue;
    }
    if (record.agent_id !== agentId) continue;
    const updated = {
      ...record,
      state: "error",
      error: "Acceptance dead-child probe forced terminal registry state",
      version: (record.version ?? 0) + 1,
      updated_at: new Date().toISOString(),
    };
    const nextPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(nextPath, JSON.stringify(updated, null, 2), "utf8");
      await rename(nextPath, statePath);
    } finally {
      await rm(nextPath, { force: true });
    }
    return true;
  }
  return false;
}

class Mcp {
  constructor(command, args) {
    this.id = 1;
    this.pending = new Map();
    this.buf = "";
    this.stderr = "";
    this.child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (c) => this.onOut(c));
    this.child.stderr.on("data", (c) => (this.stderr += c));
    this.child.on("error", (error) => {
      for (const [, pending] of this.pending) pending.reject(error);
      this.pending.clear();
    });
    this.child.on("close", () => {
      for (const [, p] of this.pending) p.reject(new Error("MCP server exited"));
      this.pending.clear();
    });
  }
  onOut(chunk) {
    this.buf += chunk;
    let nl = this.buf.indexOf("\n");
    while (nl >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) {
        try {
          this.onMsg(JSON.parse(line));
        } catch {
          /* non-JSON log line from the server */
        }
      }
      nl = this.buf.indexOf("\n");
    }
  }
  onMsg(m) {
    if (typeof m.id !== "number") return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message ?? JSON.stringify(m.error)));
    else p.resolve(m.result ?? {});
  }
  req(method, params, timeoutMs = 200_000) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout ${method} after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(t), resolve(v)),
        reject: (e) => (clearTimeout(t), reject(e)),
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  async init() {
    await this.req("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "registry-liveness-acceptance", version: "1.0.0" },
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  }
  async call(name, args, timeoutMs) {
    const res = await this.req("tools/call", { name, arguments: args }, timeoutMs);
    // cmuxlayer tools return structuredContent (the ok(data) payload) + text content.
    if (res.structuredContent) return res.structuredContent;
    const text = res.content?.find?.((c) => c.type === "text")?.text;
    if (text) {
      try {
        return JSON.parse(text);
      } catch {
        return { _text: text };
      }
    }
    return res;
  }
  close() {
    try {
      this.child.stdin.end();
      this.child.kill("SIGTERM");
    } catch {
      /* best effort */
    }
  }
}

const failures = [];
function check(cond, msg) {
  if (!cond) failures.push(msg);
  process.stdout.write(`  [${cond ? "PASS" : "FAIL"}] ${msg}\n`);
}

async function runDeadChildProbe(mcp, spawnedAgent) {
  process.stdout.write("\n=== §b dead-child probe ===\n");
  let state;
  try {
    state = await mcp.call(
      "get_agent_state",
      { agent_id: spawnedAgent.agent_id },
      60_000,
    );
  } catch (error) {
    process.stdout.write(`RED_DEADCHILD unable to resolve agent state: ${error.message}\n`);
    return false;
  }
  const target = {
    agent_id: state.agent_id ?? spawnedAgent.agent_id,
    surface_id: state.surface_id ?? spawnedAgent.surface_id,
    workspace_id: state.workspace_id ?? spawnedAgent.workspace_id,
  };
  const processInfo = await findBackingAgentProcess(
    target.surface_id,
    target.workspace_id,
  ).catch(() => null);
  if (!processInfo) {
    process.stdout.write(
      `MANUAL_DEADCHILD: kill the CLI child on ${target.surface_id}, keep the pane open, force ${target.agent_id} to state=error, then rerun the three sentinel sends.\n`,
    );
    process.stdout.write("RED_DEADCHILD backing agent process was not identifiable\n");
    return false;
  }

  process.stdout.write(
    `  killing pid=${processInfo.pid} command=${JSON.stringify(processInfo.command)} on ${target.surface_id}\n`,
  );
  if (!(await killBackingProcess(processInfo.pid))) {
    process.stdout.write(
      `MANUAL_DEADCHILD: kill pid ${processInfo.pid} manually while preserving ${target.surface_id}.\n`,
    );
    process.stdout.write("RED_DEADCHILD backing process remained alive\n");
    return false;
  }

  let deadScreen;
  try {
    await delay(500);
    deadScreen = await mcp.call(
      "read_screen",
      {
        surface: target.surface_id,
        workspace: target.workspace_id || undefined,
        lines: 40,
      },
      30_000,
    );
  } catch (error) {
    process.stdout.write(
      `MANUAL_DEADCHILD: ${target.surface_id} did not persist after the kill (${error.message}); reproduce with a pane that falls back to [Process completed] or a shell.\n`,
    );
    process.stdout.write("RED_DEADCHILD pane did not persist\n");
    return false;
  }
  const initialDeadText = deadScreen.text ?? deadScreen._text ?? "";
  process.stdout.write(
    `  post-kill screen=${JSON.stringify(initialDeadText.slice(-240))}\n`,
  );

  if (!(await forceAgentErrorState(target.agent_id))) {
    process.stdout.write(
      `MANUAL_DEADCHILD: set ${target.agent_id} to state=error in the acceptance server state directory, then repeat the probe.\n`,
    );
    process.stdout.write("RED_DEADCHILD could not force registry error state\n");
    return false;
  }
  await mcp.call("list_agents", {}, 60_000);

  const acceptedIds = new Set([spawnedAgent.agent_id, target.agent_id]);
  const attempts = [];
  for (let attempt = 1; attempt <= DEAD_CHILD_SEND_ATTEMPTS; attempt += 1) {
    const sentinel = `CMUX_DEADCHILD_${Date.now()}_${process.pid}_${attempt}`;
    const broadcast = await mcp.call(
      "broadcast",
      {
        text: sentinel,
        role: "all",
        workspace: target.workspace_id || undefined,
        press_enter: false,
      },
      60_000,
    );
    const receipt = (broadcast.receipts ?? []).find((candidate) =>
      acceptedIds.has(candidate.agent_id),
    );
    const screen = await mcp.call(
      "read_screen",
      {
        surface: target.surface_id,
        workspace: target.workspace_id || undefined,
        lines: 40,
      },
      30_000,
    );
    const screenText = screen.text ?? screen._text ?? "";
    const classified = classifyDeadChildAttempt({
      receipt,
      screenText,
      sentinel,
    });
    attempts.push(classified);
    process.stdout.write(
      `  attempt ${attempt}: receipt=${JSON.stringify(receipt)} ` +
        `terminal_negative=${classified.terminalNegative} ` +
        `false_green=${classified.falseGreen} ` +
        `screen_tail=${JSON.stringify(screenText.slice(-160))}\n`,
    );
  }

  const green = deadChildAttemptsConverged(attempts);
  process.stdout.write(
    `${green ? "GREEN_DEADCHILD" : "RED_DEADCHILD"} ` +
      `attempts=${attempts.length} converged=${green}\n`,
  );
  return green;
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.selfTestDeadChild) {
    process.exit(runDeadChildSelfTest() ? 0 : 1);
  }
  if (process.env.CMUX_LIVE_HARNESS !== "1") {
    process.stderr.write("Refusing: set CMUX_LIVE_HARNESS=1 to opt in (needs a pane-descended shell).\n");
    process.exit(2);
  }
  process.stdout.write(`=== registry-liveness §7 acceptance (N=${opt.count}, cli=${opt.cli}) ===\n`);
  const mcp = new Mcp(opt.server, opt.serverArgs);
  const spawned = [];
  try {
    await mcp.init();

    // 1. spawn N agents into a scoped workspace
    for (let i = 0; i < opt.count; i += 1) {
      const args = { repo: opt.repo, cli: opt.cli };
      if (opt.workspace) args.workspace = opt.workspace;
      const r = await mcp.call("spawn_agent", args, 90_000);
      if (!r.agent_id) throw new Error(`spawn_agent ${i} returned no agent_id: ${JSON.stringify(r)}`);
      spawned.push({ agent_id: r.agent_id, surface_id: r.surface_id, workspace_id: r.workspace_id });
      process.stdout.write(`  spawned ${r.agent_id} (${r.surface_id})\n`);
    }

    // 2. wait for each to reach an interactive state
    for (const a of spawned) {
      try {
        await mcp.call("wait_for", { agent_id: a.agent_id, state: "idle", timeout_ms: opt.waitTimeoutMs }, opt.waitTimeoutMs + 10_000);
      } catch {
        // idle may not be hit if it went ready/error; the broadcast step is the real assertion
      }
    }

    const ids = new Set(spawned.map((a) => a.agent_id));
    const surfs = new Set(spawned.map((a) => a.surface_id));

    // 3. RC3 — broadcast must deliver to all N (no dead:error skip)
    const bc = await mcp.call("broadcast", { text: "§7 acceptance ping", role: "all" }, 120_000);
    const mine = (bc.receipts ?? []).filter((r) => ids.has(r.agent_id));
    const deliveredMine = mine.filter((r) => r.delivered).length;
    const deadSkipped = mine.filter((r) => typeof r.skipped === "string" && r.skipped.startsWith("dead:"));
    check(deliveredMine === opt.count, `broadcast delivered to all ${opt.count} spawned agents (got ${deliveredMine}; receipts=${JSON.stringify(mine)})`);
    check(deadSkipped.length === 0, `broadcast skipped 0 spawned agents as dead:* (got ${deadSkipped.length})`);

    // 4. RC4 — resync must not evict/orphan the live surfaces
    const rs = await mcp.call("resync_agents", {}, 120_000);
    const diff = rs.diff ?? rs;
    const evictedMine = (diff.evicted ?? []).filter((x) => ids.has(x));
    const orphanedMine = (diff.orphaned ?? []).filter((x) => surfs.has(x));
    check(evictedMine.length === 0, `resync evicted 0 spawned seats (got ${JSON.stringify(evictedMine)})`);
    check(orphanedMine.length === 0, `resync orphaned 0 spawned surfaces (got ${JSON.stringify(orphanedMine)})`);

    // 4b. still registered + addressable
    const list = await mcp.call("list_agents", {}, 60_000);
    const stillListed = (list.agents ?? []).filter((a) => ids.has(a.agent_id)).length;
    check(stillListed === opt.count, `all ${opt.count} spawned agents still registered after resync (got ${stillListed})`);

    // 5. RC4 — send_to each must deliver
    let sendOk = 0;
    for (const a of spawned) {
      try {
        const sr = await mcp.call("send_to", { agent_id: a.agent_id, text: "§7 addressability ping", press_enter: false }, 60_000);
        if (sr.delivered !== false && sr.ok !== false) sendOk += 1;
      } catch (e) {
        process.stdout.write(`  send_to ${a.agent_id} threw: ${e.message}\n`);
      }
    }
    check(sendOk === opt.count, `send_to(agent_id) delivered to all ${opt.count} (got ${sendOk})`);

    // 6. §b — freshly dead child on a still-enumerable surface must not remain
    // a persistent delivered:true false-green. Run last because it intentionally
    // destroys one spawned agent before cleanup.
    const deadChildGreen = await runDeadChildProbe(mcp, spawned[0]);
    check(deadChildGreen, "dead-child receipts reject or converge after three sends");
  } catch (e) {
    failures.push(`harness error: ${e.message}`);
    process.stdout.write(`  [ERROR] ${e.message}\n`);
    if (mcp.stderr) process.stdout.write(`  server stderr tail: ${mcp.stderr.slice(-800)}\n`);
  } finally {
    // 7. cleanup — force-close spawned surfaces
    for (const a of spawned) {
      if (!a.surface_id) continue;
      try {
        await mcp.call("close_surface", { surface: a.surface_id, force: true }, 30_000);
      } catch {
        /* best effort */
      }
    }
    mcp.close();
  }

  const green = failures.length === 0 && spawned.length > 0;
  process.stdout.write(`\n=== ${green ? "GREEN_REGISTRY_LIVENESS" : "RED_REGISTRY_LIVENESS"} (${failures.length} failure(s)) ===\n`);
  if (!green) for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(green ? 0 : 1);
}

main().catch((e) => {
  process.stdout.write(`RED_REGISTRY_LIVENESS fatal: ${e.stack ?? e.message}\n`);
  process.exit(1);
});
