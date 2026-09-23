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

export function checkToolFailure(result) {
  const value = record(result);
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

export function hasReplyMarker(screen, marker) {
  if (typeof marker !== "string" || !marker.trim()) return false;
  const value = record(screen);
  const response = record(value.parsed).response;
  const replyLine = (line) => line.trim().replace(/^[⏺•]\s*/, "") === marker;
  if (typeof response === "string" && response.split("\n").some(replyLine)) return true;
  return [value.screen_preview, value.content].some((text) =>
    typeof text === "string" && text.split("\n").some(replyLine));
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
    !Number.isFinite(elapsedMs) || elapsedMs < 0) {
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
    !Array.isArray(value.healthSamples)) failures.push("malformed_session");
  if (!Number.isInteger(value.startPid) || value.startPid <= 0 ||
    value.endPid !== value.startPid) failures.push("server_pid_changed");
  if (value.cyclesCompleted < value.minCycles) failures.push("cycles_short");
  if (value.elapsedMs < value.minDurationMs) failures.push("duration_short");
  const samples = Array.isArray(value.healthSamples) ? value.healthSamples : [];
  // Initial and final samples cover the endpoints; each elapsed full minute
  // still needs a sample in the same uninterrupted session.
  if (Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0 &&
    samples.length < Math.ceil(value.elapsedMs / 60_000) + 1) {
    failures.push("missing_control_samples");
  }
  if (Array.from(samples).some((healthy) => healthy !== true)) failures.push("unhealthy_control_sample");
  if (!Number.isFinite(value.rssStartKb) || value.rssStartKb <= 0 ||
    !Number.isFinite(value.rssEndKb) || value.rssEndKb <= 0) failures.push("server_rss_unavailable");
  else if (value.rssEndKb > value.rssStartKb * 2) failures.push("server_rss_over_2x");
  return failures;
}
