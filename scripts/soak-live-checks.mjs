const record = (value) => value && typeof value === "object" ? value : {};
const agentStates = new Set(["creating", "booting", "ready", "working", "idle", "done", "error"]);
const screenStatuses = new Set(["frozen", "thinking", "working", "draft_pending", "idle", "done"]);
const controlStates = new Set(["shell", "agent_booting", "ready", "busy", "interactive_overlay",
  "permission_prompt", "composer_dirty", "dead", "stale_surface", "poisoned_registry"]);
const validProgress = (cycles, minimum, elapsed, duration) =>
  Number.isInteger(cycles) && cycles >= 0 && Number.isInteger(minimum) && minimum > 0 &&
  Number.isFinite(elapsed) && elapsed >= 0 &&
  Number.isFinite(duration) && duration >= 0;

export function checkReceipt(receipt, landed = false) {
  const value = record(receipt);
  const failures = [];
  if (value.submit_verified !== true) failures.push("unverified_receipt");
  if (typeof landed !== "boolean") failures.push("malformed_receipt");
  if (landed && value.submit_verified !== true) {
    failures.push("landed_with_unverified_receipt");
  }
  // Boot receipts may omit delivery_state; a present value must be submitted.
  if (value.delivery_state !== undefined && value.delivery_state !== "submitted") {
    failures.push("nonterminal_or_failed_receipt");
  }
  return failures;
}

export function checkSpawnIdentity(spawn) {
  const value = record(spawn);
  if (!value.agent_id || !(value.surface_id ?? value.surface)) return ["spawn_missing_identity"];
  return value.ok === true ? [] : ["spawn_failed"];
}

export function checkStateAgreement(agent, screen) {
  const registry = record(agent).state;
  const parsed = record(screen);
  if (!agentStates.has(registry) || !screenStatuses.has(parsed.status) ||
    !controlStates.has(parsed.control_state)) {
    return ["state_unavailable"];
  }
  const screenBusy = ["working", "thinking"].includes(parsed.status)
    || parsed.control_state === "busy"
    || parsed.control_state === "composer_dirty";
  return (screenBusy && registry !== "working") ||
    (["idle", "done"].includes(parsed.status) && registry === "working")
    ? ["stale_registry_state"] : [];
}

export function isExpectedStopCompletion(result) {
  const value = record(result);
  return value.ok === true && value.isError === false && value.matched === false &&
    value.state === "done" && (value.error == null ||
      value.error === "Agent entered terminal state: done" ||
      (value.error === "Agent has already completed" && value.source === "immediate"));
}

export function checkStopWait(result) {
  const value = record(result);
  return (value.ok === true && value.isError === false && value.matched === true) ||
    isExpectedStopCompletion(value) ? [] : ["wait_failed"];
}

export function checkPrematureIdle(waitResult, nextScreen, replyEvidence) {
  const wait = record(waitResult);
  const parsed = record(record(nextScreen).parsed);
  const busy = ["working", "thinking", "draft_pending"].includes(parsed.status) ||
    ["busy", "composer_dirty"].includes(parsed.control_state);
  return wait.matched === true && ["idle", "ready"].includes(wait.state) &&
    busy && record(replyEvidence).found !== true ? ["premature_idle"] : [];
}

export function checkToolFailure(result, opts = {}) {
  const value = record(result);
  if (opts.acceptTerminalDone === true && isExpectedStopCompletion(value)) return [];
  const message = `${value.error ?? ""} ${value.error_code ?? ""} ${value.text ?? ""}`;
  const failures = [];
  if (/too many in.flight/i.test(message)) failures.push("too_many_in_flight");
  if (/topology.incomplete|surface enumeration failed|incomplete all.window/i.test(message)) {
    failures.push("topology_incomplete_refusal");
  }
  if (/route changed/i.test(message)) failures.push("route_changed");
  if (value.ok !== true || value.isError !== false ||
    value.error != null || value.error_code != null) failures.push("tool_error");
  return failures;
}

export function checkPlacement(screen) {
  const { column, column_count: count } = record(screen);
  return Number.isInteger(column) && Number.isInteger(count)
    && count === 2 && column === 1 ? [] : ["wrong_column"];
}

export function checkClose(close, defaultListed, explicitRow, indexEntry, surface, liveSurfaces) {
  const value = record(close);
  const failures = [];
  if (value.agent_stopped !== true || value.surface_closed !== true) {
    failures.push("close_unverified");
  }
  const surfacesKnown = Array.isArray(liveSurfaces) && Array.from(liveSurfaces).every((row) =>
    row && typeof row === "object" && [row.ref, row.id, row.surface_id]
      .some((id) => typeof id === "string" && id.length > 0));
  if (typeof defaultListed !== "boolean" || typeof surface !== "string" || !surface ||
    !surfacesKnown || (record(indexEntry).cli_session_id &&
      typeof indexEntry.surface_id !== "string")) failures.push("close_observation_unavailable");
  const isLive = (ref) => surfacesKnown && liveSurfaces.some((row) =>
    row.ref === ref || row.id === ref || row.surface_id === ref);
  if (defaultListed) failures.push("agent_ghost");
  if (explicitRow && !["done", "error"].includes(explicitRow.state)) failures.push("nonterminal_tombstone");
  if (isLive(surface)) failures.push("surface_still_live");
  if (record(indexEntry).cli_session_id && isLive(indexEntry.surface_id)) failures.push("live_index_ghost");
  return failures;
}

const boundedLine = (line) => line.slice(0, 160);

export function replyMarkerEvidence(screen, marker) {
  if (typeof marker !== "string" || !marker.trim()) {
    return { found: false, origin: "none", source: null, line: null, context: [] };
  }
  const value = record(screen);
  const response = record(value.parsed).response;
  const exactReplyLine = (line) => line.trim().replace(/^[⏺•]\s*/, "") === marker;
  let firstRejected = null;
  for (const source of ["parsed_response", "screen_preview", "content"]) {
    const content = source === "parsed_response" ? response : value[source];
    if (typeof content !== "string") continue;
    const lines = content.split("\n");
    let inPrompt = false;
    let inToolOutput = false;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const trimmed = line.trim();
      // Empty lines can occur inside a wrapped prompt or tool result. Only a
      // positive boundary below can change their provenance.
      if (!trimmed) continue;
      if (/^\s*[❯›>]\s*\S/.test(line)) {
        inPrompt = true;
        inToolOutput = false;
      } else if (/^\s*(?:⎿|Result:|Output:)/.test(line)) {
        inToolOutput = true;
        inPrompt = false;
      } else if (/^\s*[⏺•]\s+(?:mcp__\S+|[A-Z]\w*\()/.test(line)) {
        inToolOutput = true;
        inPrompt = false;
      } else if (/^[⏺•]\s+/.test(line)) {
        inPrompt = false;
        inToolOutput = false;
      }
      if (!line.includes(marker)) continue;
      const authoredLine = exactReplyLine(line) && (source === "parsed_response" ||
        /^[⏺•]\s+/.test(line));
      const origin = inPrompt ? "echoed_prompt" :
        (inToolOutput || (source !== "parsed_response" && /^\s{2,}/.test(line)))
        ? "tool_output" : authoredLine ? "authored_reply" : "unattributed_raw";
      const evidence = { found: origin === "authored_reply", origin, source,
        line: boundedLine(line),
        context: lines.slice(Math.max(0, index - 1), index + 2).map(boundedLine) };
      if (evidence.found) return evidence;
      firstRejected ??= evidence;
    }
  }
  return firstRejected ?? { found: false, origin: "none", source: null, line: null, context: [] };
}

export function hasReplyMarker(screen, marker) {
  return replyMarkerEvidence(screen, marker).found;
}

export function checkReplyVisibility(screen, marker, evidence = replyMarkerEvidence(screen, marker)) {
  if (!evidence.found) return ["missing_reply_marker"];
  return evidence.source === "content" &&
    !replyMarkerEvidence({ parsed: record(screen).parsed }, marker).found
    ? ["reply_missing_from_parsed_or_preview"] : [];
}

export function shouldContinueSoak(cyclesCompleted, minCycles, elapsedMs, minDurationMs) {
  if (!validProgress(cyclesCompleted, minCycles, elapsedMs, minDurationMs)) {
    throw new TypeError("invalid soak progress");
  }
  return cyclesCompleted < minCycles || elapsedMs < minDurationMs;
}

export function nextSoakDelayMs(cyclesCompleted, minCycles, elapsedMs, minDurationMs) {
  if (!validProgress(cyclesCompleted, minCycles, elapsedMs, minDurationMs)) {
    throw new TypeError("invalid soak progress");
  }
  if (minDurationMs <= 0) return 0;
  const targetMs = minDurationMs * Math.min(cyclesCompleted, minCycles) / minCycles;
  return Math.min(30_000, Math.max(0, Math.ceil(targetMs - elapsedMs)));
}

export function checkControlHealthSample(result, mcpPid, expectedMcpPid) {
  const value = record(result);
  const health = record(value.health);
  const selected = record(health.selected_transport);
  const failures = [];
  if (!Number.isInteger(expectedMcpPid) || expectedMcpPid <= 0 ||
    mcpPid !== expectedMcpPid) failures.push("mcp_pid_changed");
  // control_health.current_process.pid belongs to the control daemon, not
  // the stdio MCP process held by this client transport.
  if (value.ok !== true || value.isError !== false ||
    selected.transport_mode !== "socket" || selected.transport_degraded !== false ||
    (selected.transport_denied !== undefined && selected.transport_denied !== false) ||
    !Array.isArray(health.warnings) ||
    health.warnings.length > 0) failures.push("control_transport_unhealthy");
  return failures;
}

export function healthSampleEntry(label, result, mcpPid, failures) {
  const health = record(record(result).health);
  const selected = record(health.selected_transport);
  return { kind: "health", label, healthy: failures.length === 0,
    control_health: result,
    control_daemon_pid: health.current_process?.pid, mcp_server_pid: mcpPid, failures,
    transport_mode: selected.transport_mode, transport_degraded: selected.transport_degraded,
    warnings: health.warnings, error: record(result).error };
}

export function checkParsedReadAgreement(fullRead, parsedOnlyRead, elapsedMs) {
  const full = record(fullRead);
  const parsedOnly = record(parsedOnlyRead);
  if (full.ok !== true || parsedOnly.ok !== true || full.isError !== false ||
    parsedOnly.isError !== false || !full.parsed || !parsedOnly.parsed ||
    !Number.isFinite(elapsedMs) || elapsedMs < 0 ||
    ![full.snapshot_hash, parsedOnly.snapshot_hash].every((hash) =>
      typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash))) {
    return ["parsed_read_unavailable"];
  }
  const a = record(full.parsed);
  const b = record(parsedOnly.parsed);
  const validTokenCount = (count) => count === null || (Number.isFinite(count) && count >= 0);
  if (![a, b].every((parsed) => screenStatuses.has(parsed.status) &&
    controlStates.has(parsed.control_state) &&
    validTokenCount(parsed.token_count))) {
    return ["parsed_read_unavailable"];
  }
  const failures = [];
  if (elapsedMs > 2_000) failures.push("parsed_sweep_window_exceeded");
  if (full.snapshot_hash !== parsedOnly.snapshot_hash) return failures;
  if (a.status !== b.status) failures.push("parsed_status_mismatch");
  if (a.control_state !== b.control_state) failures.push("parsed_control_state_mismatch");
  const countA = a.token_count;
  const countB = b.token_count;
  if (countA !== null && countB !== null) {
    if (Math.abs(countA - countB) > Math.max(512, Math.max(countA, countB) * 0.02)) {
      failures.push("parsed_token_count_drift");
    }
  } else if (countA !== countB) failures.push("parsed_token_count_drift");
  return failures;
}

export function checkSoakSession(session) {
  const value = record(session);
  const failures = [];
  if (!validProgress(value.cyclesCompleted, value.minCycles, value.elapsedMs, value.minDurationMs) ||
    !Array.isArray(value.healthSamples) || !Number.isFinite(value.startedAtMs) ||
    !Number.isFinite(value.endedAtMs) || value.endedAtMs < value.startedAtMs ||
    value.elapsedMs !== value.endedAtMs - value.startedAtMs) failures.push("malformed_session");
  if (!Number.isInteger(value.startPid) || value.startPid <= 0 ||
    value.endPid !== value.startPid) failures.push("server_pid_changed");
  if (value.cyclesCompleted < value.minCycles) failures.push("cycles_short");
  if (value.elapsedMs < value.minDurationMs) failures.push("duration_short");
  const samples = Array.isArray(value.healthSamples) ? value.healthSamples : [];
  const validSamples = Array.from(samples).every((sample) => sample &&
    Number.isFinite(sample.atMs) && typeof sample.healthy === "boolean" &&
    ["start", "minute", "end"].includes(sample.label));
  if (!validSamples) failures.push("malformed_session");
  if (validSamples && (samples.length < 2 || samples[0].label !== "start" ||
    samples[0].atMs < value.startedAtMs - 5_000 || samples[0].atMs > value.startedAtMs ||
    samples.at(-1).label !== "end" || samples.at(-1).atMs < value.endedAtMs ||
    samples.some((sample, index) => index > 0 &&
      (sample.atMs < samples[index - 1].atMs || sample.atMs - samples[index - 1].atMs > 70_000)))) {
    failures.push("missing_control_samples");
  }
  if (Array.from(samples).some((sample) => sample?.healthy !== true)) failures.push("unhealthy_control_sample");
  if (!Number.isFinite(value.rssStartKb) || value.rssStartKb <= 0 ||
    !Number.isFinite(value.rssEndKb) || value.rssEndKb <= 0) failures.push("server_rss_unavailable");
  else if (value.rssEndKb > value.rssStartKb * 2) failures.push("server_rss_over_2x");
  return failures;
}
