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
  checkReplyVisibility, checkSpawnIdentity, checkToolFailure, checkStopWait, healthSampleEntry, replyMarkerEvidence,
} from "./soak-live-checks.mjs";
import { closeSpawnedAgent } from "./soak-live-cleanup.mjs";
import { runSoakCycles, soakSessionRecord, startSoakHealthClock, withHealthTimeout } from "./soak-live-timeline.mjs";
import { cycleAssignment, isPoolSeatDead, options } from "./soak-live-options.mjs";

const WORKSPACE = "workspace:1";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const object = (value) => value && typeof value === "object" ? value : {};
const boundedScreenContent = (value) => typeof value === "string"
  ? value.split("\n").slice(-8).map((line) => line.slice(0, 160)).join("\n") : null;

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
    models: { claude: opts.claudeModel ?? "launcher-default", codex: opts.codexModel },
    codex_effort: opts.codexEffort,
    pool: { size: opts.pool, spawned: 0, replacements: 0, blocked_slots: 0, cycles: 0 },
    fresh: { every: opts.freshEvery, cycles: 0 },
    invariants: {}, tools: {}, violations: [] };
  const active = new Map();
  const spawnedIds = new Set();
  const poolSeats = Array(opts.pool).fill(null);
  const blockedPoolSlots = new Set();
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
  let healthClock;
  let startedAtMs = 0;
  let startPid = null;
  let rssStartKb = null;
  let connected = false;
  const call = async (name, args, cycle, timeoutMs = Math.max(opts.timeoutMs + 15_000, 120_000)) => {
    const start = performance.now();
    let result;
    try {
      result = payload(await client.callTool({ name, arguments: args }, undefined,
        { timeout: timeoutMs }));
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
      snapshot_hash: name === "read_screen" ? result.snapshot_hash : undefined,
      column: name === "read_screen" ? result.column : undefined,
      column_count: name === "read_screen" ? result.column_count : undefined,
      warning: result.WARNING, error: result.error, error_code: result.error_code });
    check("tool_refusal", checkToolFailure(result,
      { acceptTerminalDone: name === "wait_for" && args.target_state === "idle" }),
    { cycle, tool: name });
    return result;
  };
  const sampleHealth = async (label, atMs = Date.now()) => {
    const sample = { atMs, label, healthy: false };
    healthSamples.push(sample);
    try {
      let result;
      try {
        result = await withHealthTimeout(() =>
          call("control_health", { detail: "full" }, `health:${label}`, 20_000),
        setTimeout, clearTimeout);
      } catch (error) {
        result = { ok: false, isError: true, error: String(error) };
      }
      const failures = checkControlHealthSample(result, transport.pid, startPid);
      sample.healthy = failures.length === 0;
      check("control_health", failures, { label });
      log({ ...healthSampleEntry(label, result, transport.pid, failures), sample_started_at_ms: atMs });
    } catch (error) {
      check("health", ["health_sample_exception"], { label, error: String(error) });
    }
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
    const screen = await call("read_screen", { surface, workspace: WORKSPACE,
      lines: 100, raw: true }, cycle);
    const parsedOnly = await call("read_screen", { surface, workspace: WORKSPACE,
      lines: 100, parsed_only: true }, cycle);
    const sweepMs = Date.now() - sweepStartedAt;
    const parityFailures = checkParsedReadAgreement(screen, parsedOnly, sweepMs);
    log({ kind: "parsed_snapshot_pair", cycle, agent_id: agentId, surface,
      full_hash: screen.snapshot_hash ?? null, parsed_only_hash: parsedOnly.snapshot_hash ?? null,
      same_snapshot: screen.snapshot_hash != null && screen.snapshot_hash === parsedOnly.snapshot_hash,
      sweep_ms: sweepMs });
    if (parityFailures.length) {
      log({ kind: "parsed_mismatch_evidence", cycle, agent_id: agentId, surface,
        failures: parityFailures, full_hash: screen.snapshot_hash ?? null,
        parsed_only_hash: parsedOnly.snapshot_hash ?? null,
        full_parsed: screen.parsed ?? null, parsed_only_parsed: parsedOnly.parsed ?? null,
        bounded_content: boundedScreenContent(screen.content) });
    }
    check("parsed_read_agreement", parityFailures,
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
      const fullEvidence = replyMarkerEvidence(screen, marker);
      log({ kind: "reply_evidence", cycle, agent_id: agentId, marker, read: "full", ...fullEvidence });
      if (fullEvidence.found) {
        check("reply_visible", checkReplyVisibility(screen, marker, fullEvidence),
        { cycle, agent_id: agentId, marker, origin: fullEvidence.origin });
        return true;
      }
      const raw = await call("read_screen", { surface, workspace: WORKSPACE,
        raw: true, scrollback: true, lines: 100 }, cycle);
      const rawEvidence = replyMarkerEvidence(raw, marker);
      log({ kind: "reply_evidence", cycle, agent_id: agentId, marker, read: "scrollback", ...rawEvidence });
      if (rawEvidence.found) {
        check("reply_visible", checkReplyVisibility(raw, marker, rawEvidence),
        { cycle, agent_id: agentId, marker, origin: rawEvidence.origin });
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
  const spawnSeat = async (cycle, cli, marker) => {
    const spawn = await call("spawn_agent", { repo: "cmuxlayer", workspace: WORKSPACE,
      cli, ...(cli === "codex" ? { model: opts.codexModel, effort: opts.codexEffort }
        : opts.claudeModel ? { model: opts.claudeModel } : {}),
      role: "worker", authority: "worker", placement: "right", force_new: true,
      mcp_profile: "sterile", prompt: `Reply exactly ${marker} then stop.` }, cycle);
    const seat = { agentId: spawn.agent_id, surface: spawn.surface_id ?? spawn.surface,
      surfaceUuid: spawn.surface_uuid ?? null, cli };
    if (seat.agentId) {
      active.set(seat.agentId, { surface: seat.surface, surfaceUuid: seat.surfaceUuid });
      spawnedIds.add(seat.agentId);
    }
    check("spawn_receipt", checkReceipt(spawn.boot_prompt_receipt ?? {
      submit_verified: spawn.boot_prompt_submit_verified,
      delivery_state: spawn.boot_prompt_receipt?.delivery_state,
    }), { cycle, agent_id: seat.agentId });
    const failures = checkSpawnIdentity(spawn);
    if (failures.length) check("spawn_identity", failures, { cycle, cli });
    return { ...seat, spawn, valid: failures.length === 0 };
  };
  const closeSeat = async (cycle, seat) => {
    if (!seat?.agentId && !seat?.surface) return true;
    const closed = await closeOwned(cycle, seat.agentId, seat.surface, seat.surfaceUuid);
    if (closed && seat.agentId) active.delete(seat.agentId);
    return closed;
  };
  const bootPoolSeat = async (slot, cycle) => {
    const cli = slot % 2 === 0 ? "claude" : "codex";
    const marker = `SOAK_POOL_READY_${slot}_${summary.pool.spawned + 1}`;
    const seat = await spawnSeat(cycle, cli, marker);
    if (!seat.valid) {
      if (!await closeSeat(cycle, seat)) blockedPoolSlots.add(slot);
      return null;
    }
    summary.pool.spawned += 1;
    try {
      await observe(cycle, seat.agentId, seat.surface);
      const waited = await call("wait_for", { agent_id: seat.agentId,
        target_state: "idle", timeout_ms: opts.timeoutMs }, cycle);
      const waitFailures = checkStopWait(waited);
      check("wait_for", waitFailures, { cycle, agent_id: seat.agentId });
      const landed = await readReply(cycle, seat.agentId, seat.surface, marker);
      check("spawn_receipt_after_reply", checkReceipt(seat.spawn.boot_prompt_receipt ?? {
        submit_verified: seat.spawn.boot_prompt_submit_verified }, landed), { cycle, agent_id: seat.agentId });
      if (waitFailures.length || !landed) {
        check("pool_seat", ["pool_seat_died"], { cycle, slot, agent_id: seat.agentId });
        if (!await closeSeat(cycle, seat)) blockedPoolSlots.add(slot);
        return null;
      }
      return seat;
    } catch (error) {
      if (!await closeSeat(cycle, seat)) blockedPoolSlots.add(slot);
      throw error;
    }
  };
  const livePoolSeat = async (slot, cycle) => {
    if (blockedPoolSlots.has(slot)) {
      check("pool_seat", ["pool_slot_blocked_by_cleanup_leak"], { cycle, slot });
      return null;
    }
    let seat = poolSeats[slot];
    if (seat) {
      const listed = await call("list_agents", { agent_ids: [seat.agentId], max_age_ms: 0 }, cycle);
      const row = listed.agents?.find((item) => item.agent_id === seat.agentId);
      if (!listed.ok || !isPoolSeatDead(row)) return seat;
      check("pool_seat", ["pool_seat_died"], { cycle, slot, agent_id: seat.agentId,
        state: row?.state ?? null });
      if (!await closeSeat(cycle, seat)) {
        blockedPoolSlots.add(slot);
        return null;
      }
      summary.pool.replacements += 1;
      poolSeats[slot] = null;
    }
    seat = await bootPoolSeat(slot, cycle);
    poolSeats[slot] = seat;
    return seat;
  };
  const runCycle = async (cycle) => {
    const assignment = cycleAssignment(cycle, opts.pool, opts.freshEvery);
    const { cli } = assignment;
    summary.cli_counts[cli] += 1;
    summary[assignment.kind].cycles += 1;
    let seat;
    try {
      const first = `SOAK_OK_${cycle}`;
      const second = `SOAK2_${cycle}`;
      seat = assignment.kind === "pool" ? await livePoolSeat(assignment.slot, cycle)
        : await spawnSeat(cycle, cli, first);
      if (!seat?.valid) return;
      const { agentId, surface } = seat;
      if (assignment.kind === "pool") {
        const send = await call("send_to", { mode: "agent", agent_id: agentId,
          text: `Reply exactly ${first} then stop.`, verbose: true }, cycle);
        check("send_receipt", checkReceipt(send), { cycle, agent_id: agentId });
        await observe(cycle, agentId, surface);
        const waited = await call("wait_for", { agent_id: agentId,
          target_state: "idle", timeout_ms: opts.timeoutMs }, cycle);
        check("wait_for", checkStopWait(waited), { cycle, agent_id: agentId });
        const landed = await readReply(cycle, agentId, surface, first);
        check("send_receipt_after_reply", checkReceipt(send, landed), { cycle, agent_id: agentId });
        if (!send.ok || !landed || checkStopWait(waited).length) {
          check("pool_seat", ["pool_seat_died"], { cycle, slot: assignment.slot, agent_id: agentId });
          if (await closeSeat(cycle, seat)) {
            summary.pool.replacements += 1;
            poolSeats[assignment.slot] = null;
            poolSeats[assignment.slot] = await bootPoolSeat(assignment.slot, cycle);
          } else blockedPoolSlots.add(assignment.slot);
        }
        return;
      }
      await observe(cycle, agentId, surface);
      const firstWait = await call("wait_for", { agent_id: agentId,
        target_state: "idle", timeout_ms: opts.timeoutMs }, cycle);
      check("wait_for", checkStopWait(firstWait), { cycle, agent_id: agentId });
      const firstLanded = await readReply(cycle, agentId, surface, first);
      check("spawn_receipt_after_reply", checkReceipt(seat.spawn.boot_prompt_receipt ?? {
        submit_verified: seat.spawn.boot_prompt_submit_verified }, firstLanded), { cycle, agent_id: agentId });
      const send = await call("send_to", { mode: "agent", agent_id: agentId,
        text: `Reply exactly ${second} then stop.`, verbose: true }, cycle);
      check("send_receipt", checkReceipt(send), { cycle, agent_id: agentId });
      await observe(cycle, agentId, surface);
      const secondWait = await call("wait_for", { agent_id: agentId,
        target_state: "idle", timeout_ms: opts.timeoutMs }, cycle);
      check("wait_for", checkStopWait(secondWait), { cycle, agent_id: agentId });
      const secondLanded = await readReply(cycle, agentId, surface, second);
      check("send_receipt_after_reply", checkReceipt(send, secondLanded), { cycle, agent_id: agentId });
    } catch (error) {
      check("cycle_exception", ["cycle_exception"], { cycle, error: String(error) });
    } finally {
      try {
        if (assignment.kind === "fresh") await closeSeat(cycle, seat);
        else if (seat && poolSeats[assignment.slot] === seat &&
          summary.violations.some((item) => item.cycle === cycle && item.invariant === "cycle_exception")) {
          check("pool_seat", ["pool_seat_died"], { cycle, slot: assignment.slot, agent_id: seat.agentId });
          if (await closeSeat(cycle, seat)) {
            summary.pool.replacements += 1;
            poolSeats[assignment.slot] = null;
            poolSeats[assignment.slot] = await bootPoolSeat(assignment.slot, cycle);
          } else blockedPoolSlots.add(assignment.slot);
        }
      }
      catch (error) { check("cleanup", ["cleanup_exception"], { cycle, error: String(error) }); }
      summary.cycles_completed += 1;
      log({ kind: "cycle_done", cycle, cli, assignment });
    }
  };
  try {
    await client.connect(transport);
    connected = true;
    startPid = transport.pid;
    rssStartKb = serverRssKb(startPid);
    log({ kind: "start", options: opts });
    healthClock = await startSoakHealthClock({ sampleHealth, now: Date.now,
      schedule: setTimeout, cancel: clearTimeout, minDurationMs: opts.durationMinutes * 60_000,
      minimumCyclesComplete: () => summary.cycles_completed >= opts.cycles,
      onError: (error) => check("health", ["health_sample_exception"], { error: String(error) }) });
    startedAtMs = healthClock.startedAtMs;
    for (let slot = 0; slot < opts.pool; slot += 1) {
      try { poolSeats[slot] = await bootPoolSeat(slot, `pool:${slot}`); }
      catch (error) { check("pool_boot", ["pool_boot_exception"], { slot, error: String(error) }); }
    }
    await runSoakCycles({ completed: () => summary.cycles_completed, minCycles: opts.cycles,
      minDurationMs: opts.durationMinutes * 60_000, now: Date.now, startedAtMs, sleep,
      currentPid: () => transport.pid, startPid, runBatch: async () => {
        const first = summary.cycles_completed;
        const batchSize = Math.min(opts.concurrency, opts.cycles - first);
        await Promise.all(Array.from({ length: batchSize },
          (_, offset) => runCycle(first + offset + 1)));
        healthClock.refresh();
      } });
  } catch (error) {
    check("harness", ["harness_exception"], { error: String(error) });
  } finally {
    for (const [agentId, { surface, surfaceUuid }] of active) {
      try { await closeOwned("final", agentId, surface, surfaceUuid); }
      catch (error) { check("cleanup", ["cleanup_exception"], { agent_id: agentId, error: String(error) }); }
    }
    try { inboxCheck("final"); }
    catch (error) { check("lead_inbox", ["inbox_unreadable"], { error: String(error) }); }
    if (healthClock) healthClock.stop();
    const endedAtMs = Date.now();
    if (connected) await sampleHealth("end").catch((error) =>
      check("health", ["health_sample_exception"], { error: String(error) }));
    const endPid = transport.pid;
    const rssEndKb = serverRssKb(endPid);
    const sessionRecord = soakSessionRecord({ startPid, endPid, startedAtMs, endedAtMs,
      minCycles: opts.cycles, minDurationMs: opts.durationMinutes * 60_000,
      cyclesCompleted: summary.cycles_completed, healthSamples, rssStartKb, rssEndKb });
    const elapsedMs = sessionRecord.elapsedMs;
    summary.session = { duration_ms: elapsedMs, server_pid_start: startPid,
      server_pid_end: endPid, server_pid_unchanged: startPid === endPid,
      health_samples_ok: healthSamples.filter((sample) => sample.healthy).length,
      health_samples_total: healthSamples.length, rss_start_kb: rssStartKb, rss_end_kb: rssEndKb };
    check("soak_session", checkSoakSession(sessionRecord), { session: summary.session });
    await client.close().catch(() => {});
    summary.finished_at = new Date().toISOString();
    summary.pool.blocked_slots = blockedPoolSlots.size;
    summary.tools = Object.fromEntries(Object.entries(summary.tools).map(([name, values]) =>
      [name, { calls: values.length, p50_ms: percentile(values, 50), p95_ms: percentile(values, 95) }]));
    summary.ok = summary.violations.length === 0 && summary.cycles_completed >= opts.cycles;
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    process.stdout.write(`${summary.ok ? "SOAK_PASS" : "SOAK_FAIL"} ${summaryPath} ${eventsPath}\n`);
    if (!summary.ok) process.exitCode = 1;
  }
}

main().catch((error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });
