#!/usr/bin/env node
// Live, destructive only to the exact agents this run creates. Never use in CI.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  checkClose, checkControlHealthSample, checkParsedReadAgreement, checkPlacement, checkReceipt, checkSoakSession, checkStateAgreement,
  checkToolFailure, hasReplyMarker, healthSampleEntry, nextSoakDelayMs, shouldContinueSoak,
} from "./soak-live-checks.mjs";
import { closeSpawnedAgent } from "./soak-live-cleanup.mjs";

const WORKSPACE = "workspace:1";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const object = (value) => value && typeof value === "object" ? value : {};

function options(argv) {
  const opts = { cycles: 40, concurrency: 2, timeoutMs: 90_000, durationMinutes: 60,
    agentId: process.env.GOLEM_SEAT || "", leadAgentId: "", entry: process.env.CMUXLAYER_SOAK_ENTRY || "cmuxlayer" };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!["--cycles", "--concurrency", "--timeout-ms", "--duration-minutes", "--agent-id", "--lead-agent-id", "--entry"].includes(key)
      || !argv[i + 1]) throw new Error(`unknown or incomplete argument: ${key}`);
    const field = { "--cycles": "cycles", "--concurrency": "concurrency",
      "--timeout-ms": "timeoutMs", "--duration-minutes": "durationMinutes",
      "--agent-id": "agentId", "--lead-agent-id": "leadAgentId", "--entry": "entry" }[key];
    opts[field] = ["cycles", "concurrency", "timeoutMs", "durationMinutes"].includes(field)
      ? Number(argv[i + 1]) : argv[i + 1];
  }
  if (!/^[A-Za-z0-9_-]+$/.test(opts.agentId)) throw new Error("--agent-id is required");
  if (!Number.isInteger(opts.cycles) || opts.cycles < 1 || opts.cycles > 40) throw new Error("cycles must be 1..40");
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1 || opts.concurrency > 2) throw new Error("concurrency must be 1..2");
  if (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs < 1000 || opts.timeoutMs > 300_000) {
    throw new Error("timeout-ms must be 1000..300000");
  }
  if (!Number.isInteger(opts.durationMinutes) || opts.durationMinutes < 0 || opts.durationMinutes > 360) {
    throw new Error("duration-minutes must be 0..360");
  }
  return opts;
}

function payload(result) {
  const structured = result?.structuredContent;
  if (structured && typeof structured === "object") return { ...structured, isError: result.isError === true };
  const text = result?.content?.find((item) => item.type === "text")?.text;
  try { return { ...JSON.parse(text), isError: result?.isError === true }; }
  catch { return { ok: false, error: text || "MCP tool returned no payload", isError: true }; }
}

function percentile(values, pct) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((pct / 100) * sorted.length) - 1];
}

function serverRssKb(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const value = Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)],
      { encoding: "utf8", timeout: 5000 }).trim());
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch { return null; }
}

async function main() {
  const opts = options(process.argv.slice(2));
  const root = join(homedir(), ".cmux", "agents", opts.agentId, "soak");
  mkdirSync(root, { recursive: true });
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const eventsPath = join(root, `${runId}.jsonl`);
  const summaryPath = join(root, `${runId}.summary.json`);
  const summary = { run_id: runId, started_at: new Date().toISOString(),
    mcp_entry: opts.entry, candidate_head: process.env.CMUXLAYER_SOAK_CANDIDATE_HEAD || null,
    workspace: WORKSPACE, cycles_requested: opts.cycles, duration_floor_minutes: opts.durationMinutes,
    concurrency: opts.concurrency, cycles_completed: 0, cli_counts: { claude: 0, codex: 0 },
    invariants: {}, tools: {}, violations: [] };
  const active = new Map();
  const spawnedIds = new Set();
  const stateDir = process.env.CMUXLAYER_STATE_DIR || join(homedir(), ".local", "state", "cmux-agents");
  const leadInbox = opts.leadAgentId
    ? join(homedir(), ".cmux", "agents", opts.leadAgentId, "inbox.jsonl") : null;
  let inboxOffset = 0;
  if (leadInbox) {
    try { inboxOffset = readFileSync(leadInbox).length; }
    catch { throw new Error(`lead inbox unreadable: ${leadInbox}`); }
  }
  const log = (entry) => appendFileSync(eventsPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  const check = (name, failures, context) => {
    const counter = summary.invariants[name] ??= { pass: 0, fail: 0 };
    counter[failures.length ? "fail" : "pass"] += 1;
    for (const code of failures) {
      const violation = { code, invariant: name, ...context };
      summary.violations.push(violation);
      log({ kind: "violation", ...violation });
    }
  };
  const client = new Client({ name: "cmuxlayer-soak-live", version: "1" });
  // This is an external stdio client, not a child turn of the worker running it.
  // An inherited pane identity would add two ancestors and hit the depth gate.
  const serverEnv = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === "string"));
  delete serverEnv.CMUX_SURFACE_ID;
  delete serverEnv.CMUX_WORKSPACE_ID;
  delete serverEnv.CMUX_TAB_ID;
  const transport = new StdioClientTransport({ command: opts.entry, args: [],
    env: serverEnv,
    stderr: "inherit" });
  const healthSamples = [];
  let healthTimer;
  let healthInFlight = null;
  let startedAtMs = 0;
  let startPid = null;
  let rssStartKb = null;
  let connected = false;
  const call = async (name, args, cycle) => {
    const start = performance.now();
    let result;
    try {
      result = payload(await client.callTool({ name, arguments: args }, undefined,
        { timeout: Math.max(opts.timeoutMs + 15_000, 120_000) }));
    } catch (error) {
      result = { ok: false, isError: true, error: String(error) };
    }
    const ms = Math.round(performance.now() - start);
    (summary.tools[name] ??= []).push(ms);
    log({ kind: "call", cycle, tool: name, arguments: args, ms, ok: result.ok === true && !result.isError,
      agent_id: result.agent_id, surface_id: result.surface_id ?? result.surface,
      state: result.state ?? result.spawn_state, delivery_state: result.delivery_state,
      matched: result.matched,
      submit_verified: result.submit_verified ?? result.boot_prompt_submit_verified,
      boot_prompt_receipt: result.boot_prompt_receipt,
      parsed: name === "read_screen" ? result.parsed : undefined,
      screen_preview: name === "read_screen" ? result.screen_preview : undefined,
      warning: result.WARNING, error: result.error, error_code: result.error_code });
    check("tool_refusal", checkToolFailure(result), { cycle, tool: name });
    return result;
  };
  const sampleHealth = async (label) => {
    if (healthInFlight) {
      healthSamples.push(false);
      log({ kind: "health", label, healthy: false, control_health: null,
        reason: "previous_sample_in_flight" });
      return;
    }
    const pending = (async () => {
      const result = await call("control_health", { detail: "full" }, `health:${label}`);
      const failures = checkControlHealthSample(result, transport.pid, startPid);
      const healthy = failures.length === 0;
      healthSamples.push(healthy);
      check("control_health", failures, { label });
      log(healthSampleEntry(label, result, transport.pid, failures));
    })();
    healthInFlight = pending;
    try { await pending; } finally { healthInFlight = null; }
  };
  const indexEntry = (agentId) => {
    const path = join(stateDir, "surface-session-index.json");
    const index = JSON.parse(readFileSync(path, "utf8"));
    return object(index.by_agent_id)[agentId] ?? null;
  };
  const inboxCheck = (cycle) => {
    if (!leadInbox) return;
    const bytes = readFileSync(leadInbox);
    const fresh = bytes.subarray(inboxOffset).toString("utf8");
    inboxOffset = bytes.length;
    const hits = fresh.split("\n").filter((line) =>
      /agent_halt_wedged/.test(line) && [...spawnedIds].some((id) => line.includes(id)));
    check("lead_inbox", hits.length ? ["false_agent_halt_wedged"] : [], { cycle });
  };
  const observe = async (cycle, agentId, surface) => {
    const listed = await call("list_agents", { agent_ids: [agentId], max_age_ms: 0 }, cycle);
    const row = object(listed.agents?.find((item) => item.agent_id === agentId));
    const sweepStartedAt = Date.now();
    const screen = await call("read_screen", { surface, workspace: WORKSPACE, lines: 100 }, cycle);
    const parsedOnly = await call("read_screen", { surface, workspace: WORKSPACE,
      lines: 100, parsed_only: true }, cycle);
    check("parsed_read_agreement", checkParsedReadAgreement(screen, parsedOnly, Date.now() - sweepStartedAt),
      { cycle, agent_id: agentId, surface });
    if (listed.ok && screen.ok) {
      check("registry_presence", row.agent_id === agentId ? [] : ["agent_missing_from_registry"],
        { cycle, agent_id: agentId });
      check("state_agreement", checkStateAgreement(row, screen.parsed), { cycle, agent_id: agentId });
      check("placement", checkPlacement(screen), { cycle, agent_id: agentId });
    } else check("observation", ["observation_failed"], { cycle, agent_id: agentId });
    inboxCheck(cycle);
    return screen;
  };
  const readReply = async (cycle, agentId, surface, marker) => {
    let screen;
    const deadline = Date.now() + opts.timeoutMs;
    do {
      screen = await observe(cycle, agentId, surface);
      if (hasReplyMarker(screen, marker)) {
        check("reply_visible", [], { cycle, agent_id: agentId, marker });
        return true;
      }
      const raw = await call("read_screen", { surface, workspace: WORKSPACE,
        raw: true, scrollback: true, lines: 100 }, cycle);
      if (hasReplyMarker(raw, marker)) {
        check("reply_visible", ["reply_missing_from_parsed_or_preview"],
          { cycle, agent_id: agentId, marker });
        return true;
      }
      await sleep(1000);
    } while (Date.now() < deadline);
    check("reply_visible", ["missing_reply_marker"], { cycle, agent_id: agentId, marker });
    return false;
  };
  const closeOwned = async (cycle, agentId, surface, surfaceUuid) => {
    const { close, leaked } = await closeSpawnedAgent({ call, check, cycle, agentId, surface, surfaceUuid });
    if (leaked) return false;
    if (agentId) {
      let listed, explicit, surfaces;
      let index = null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        listed = await call("list_agents", { max_age_ms: 0 }, cycle);
        explicit = await call("list_agents", { agent_ids: [agentId], max_age_ms: 0 }, cycle);
        surfaces = await call("list_surfaces", { workspace: WORKSPACE }, cycle);
        try { index = indexEntry(agentId); }
        catch { check("index_read", ["index_unreadable"], { cycle, agent_id: agentId }); break; }
        const visible = listed.agents?.some((item) => item.agent_id === agentId);
        const liveRefs = surfaces.surfaces?.map((item) => item.ref ?? item.id) ?? [];
        if (!visible && !liveRefs.includes(surface) && !liveRefs.includes(index?.surface_id)) break;
        await sleep(200);
      }
      const failures = checkClose(close,
        listed.agents?.some((item) => item.agent_id === agentId),
        explicit.agents?.find((item) => item.agent_id === agentId), index, surface, surfaces.surfaces);
      check("cleanup", failures, { cycle, agent_id: agentId });
      inboxCheck(cycle);
      return !listed.agents?.some((item) => item.agent_id === agentId) &&
        !surfaces.surfaces?.some((item) => [surface, index?.surface_id].includes(item.ref ?? item.id));
    } else if (surface) {
      check("cleanup", close?.surface_closed === true ? [] : ["surface_close_unverified"], { cycle, surface });
    }
    inboxCheck(cycle);
    return close?.surface_closed === true;
  };
  const runCycle = async (cycle) => {
    const cli = cycle % 2 === 0 ? "codex" : "claude";
    summary.cli_counts[cli] += 1;
    let agentId, surface, surfaceUuid;
    try {
      const first = `SOAK_OK_${cycle}`;
      const second = `SOAK2_${cycle}`;
      const spawn = await call("spawn_agent", { repo: "cmuxlayer", workspace: WORKSPACE,
        cli, ...(cli === "codex" ? { model: "gpt-6-sol", effort: "low" } : {}),
        role: "worker", authority: "worker", placement: "right", force_new: true,
        mcp_profile: "sterile", prompt: `Reply exactly ${first} then stop.` }, cycle);
      agentId = spawn.agent_id;
      surface = spawn.surface_id ?? spawn.surface;
      surfaceUuid = spawn.surface_uuid ?? null;
      if (agentId) { active.set(agentId, { surface, surfaceUuid }); spawnedIds.add(agentId); }
      check("spawn_receipt", checkReceipt(spawn.boot_prompt_receipt ?? {
        submit_verified: spawn.boot_prompt_submit_verified,
        delivery_state: spawn.boot_prompt_receipt?.delivery_state,
      }), { cycle, agent_id: agentId });
      if (!agentId || !surface || !spawn.ok) {
        check("spawn_identity", ["spawn_missing_identity"], { cycle, cli });
        return;
      }
      await observe(cycle, agentId, surface);
      const firstWait = await call("wait_for", { agent_id: agentId,
        target_state: "idle", timeout_ms: opts.timeoutMs }, cycle);
      check("wait_for", firstWait.ok && firstWait.matched === true
        ? [] : ["wait_failed"], { cycle, agent_id: agentId });
      const firstLanded = await readReply(cycle, agentId, surface, first);
      check("spawn_receipt_after_reply", checkReceipt(spawn.boot_prompt_receipt ?? {
        submit_verified: spawn.boot_prompt_submit_verified }, firstLanded), { cycle, agent_id: agentId });
      const send = await call("send_to", { mode: "agent", agent_id: agentId,
        text: `Reply exactly ${second} then stop.`, verbose: true }, cycle);
      check("send_receipt", checkReceipt(send), { cycle, agent_id: agentId });
      await observe(cycle, agentId, surface);
      const secondWait = await call("wait_for", { agent_id: agentId,
        target_state: "idle", timeout_ms: opts.timeoutMs }, cycle);
      check("wait_for", secondWait.ok && secondWait.matched === true
        ? [] : ["wait_failed"], { cycle, agent_id: agentId });
      const secondLanded = await readReply(cycle, agentId, surface, second);
      check("send_receipt_after_reply", checkReceipt(send, secondLanded), { cycle, agent_id: agentId });
    } catch (error) {
      check("cycle_exception", ["cycle_exception"], { cycle, error: String(error) });
    } finally {
      try {
        if (agentId || surface) {
          await closeOwned(cycle, agentId, surface, surfaceUuid);
          if (agentId) active.delete(agentId); // A recorded leak is left for human cleanup.
        }
      }
      catch (error) { check("cleanup", ["cleanup_exception"], { cycle, error: String(error) }); }
      summary.cycles_completed += 1;
      log({ kind: "cycle_done", cycle, cli });
    }
  };
  try {
    await client.connect(transport);
    connected = true;
    startedAtMs = Date.now();
    startPid = transport.pid;
    rssStartKb = serverRssKb(startPid);
    log({ kind: "start", options: opts });
    await sampleHealth("start");
    healthTimer = setInterval(() => { void sampleHealth("minute").catch((error) =>
      check("health", ["health_sample_exception"], { error: String(error) })); }, 60_000);
    while (shouldContinueSoak(summary.cycles_completed, opts.cycles,
      Date.now() - startedAtMs, opts.durationMinutes * 60_000)) {
      if (transport.pid !== startPid) break;
      const delayMs = nextSoakDelayMs(summary.cycles_completed, opts.cycles,
        Date.now() - startedAtMs, opts.durationMinutes * 60_000);
      if (delayMs > 0) { await sleep(delayMs); continue; }
      const first = summary.cycles_completed;
      const batchSize = Math.min(opts.concurrency, opts.cycles - first);
      await Promise.all(Array.from({ length: batchSize },
        (_, offset) => runCycle(first + offset + 1)));
    }
  } catch (error) {
    check("harness", ["harness_exception"], { error: String(error) });
  } finally {
    for (const [agentId, { surface, surfaceUuid }] of active) {
      try { await closeOwned("final", agentId, surface, surfaceUuid); }
      catch (error) { check("cleanup", ["cleanup_exception"], { agent_id: agentId, error: String(error) }); }
    }
    try { inboxCheck("final"); }
    catch (error) { check("lead_inbox", ["inbox_unreadable"], { error: String(error) }); }
    if (healthTimer) clearInterval(healthTimer);
    if (healthInFlight) await healthInFlight.catch(() => {});
    if (connected) await sampleHealth("end").catch((error) =>
      check("health", ["health_sample_exception"], { error: String(error) }));
    const endPid = transport.pid;
    const rssEndKb = serverRssKb(endPid);
    const elapsedMs = startedAtMs ? Date.now() - startedAtMs : 0;
    summary.session = { duration_ms: elapsedMs, server_pid_start: startPid,
      server_pid_end: endPid, server_pid_unchanged: startPid === endPid,
      health_samples_ok: healthSamples.filter(Boolean).length,
      health_samples_total: healthSamples.length, rss_start_kb: rssStartKb, rss_end_kb: rssEndKb };
    check("soak_session", checkSoakSession({ startPid, endPid, elapsedMs,
      minDurationMs: opts.durationMinutes * 60_000, minCycles: opts.cycles,
      cyclesCompleted: summary.cycles_completed, healthSamples, rssStartKb, rssEndKb }),
    { session: summary.session });
    await client.close().catch(() => {});
    summary.finished_at = new Date().toISOString();
    summary.tools = Object.fromEntries(Object.entries(summary.tools).map(([name, values]) =>
      [name, { calls: values.length, p50_ms: percentile(values, 50), p95_ms: percentile(values, 95) }]));
    summary.ok = summary.violations.length === 0 && summary.cycles_completed >= opts.cycles;
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    process.stdout.write(`${summary.ok ? "SOAK_PASS" : "SOAK_FAIL"} ${summaryPath} ${eventsPath}\n`);
    if (!summary.ok) process.exitCode = 1;
  }
}

main().catch((error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });
