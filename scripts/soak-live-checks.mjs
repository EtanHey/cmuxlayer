const record = (value) => value && typeof value === "object" ? value : {};

export function checkReceipt(receipt, landed = false) {
  const value = record(receipt);
  const failures = [];
  if (value.submit_verified !== true) failures.push("unverified_receipt");
  if (landed && value.submit_verified !== true) {
    failures.push("landed_with_unverified_receipt");
  }
  if (["pending_verify", "failed", "rescued", "queued", "queued_followup"]
    .includes(value.delivery_state)) failures.push("nonterminal_or_failed_receipt");
  return failures;
}

export function checkStateAgreement(agent, screen) {
  const registry = record(agent).state;
  const parsed = record(screen);
  const screenBusy = ["working", "thinking"].includes(parsed.status)
    || parsed.control_state === "busy"
    || parsed.control_state === "composer_dirty";
  return screenBusy && ["idle", "done"].includes(registry)
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
  if (value.ok === false || value.isError === true) failures.push("tool_error");
  return failures;
}

export function checkPlacement(screen) {
  const { column, column_count: count } = record(screen);
  return Number.isInteger(column) && Number.isInteger(count)
    && count >= 2 && column === count - 1 ? [] : ["wrong_column"];
}

export function checkClose(close, defaultListed, explicitRow, indexEntry, surface, liveSurfaces) {
  const value = record(close);
  const failures = [];
  if (value.agent_stopped !== true || value.surface_closed !== true) {
    failures.push("close_unverified");
  }
  const isLive = (ref) => Array.isArray(liveSurfaces) && liveSurfaces.some((row) =>
    row.ref === ref || row.id === ref || row.surface_id === ref);
  if (defaultListed) failures.push("agent_ghost");
  if (explicitRow && !["done", "error"].includes(explicitRow.state)) failures.push("nonterminal_tombstone");
  if (isLive(surface)) failures.push("surface_still_live");
  if (record(indexEntry).cli_session_id && isLive(indexEntry.surface_id)) failures.push("live_index_ghost");
  return failures;
}

export function hasReplyMarker(screen, marker) {
  const value = record(screen);
  const response = record(value.parsed).response;
  const replyLine = (line) => line.trim().replace(/^[⏺•]\s*/, "") === marker;
  if (typeof response === "string" && response.split("\n").some(replyLine)) return true;
  return [value.screen_preview, value.content].some((text) =>
    typeof text === "string" && text.split("\n").some(replyLine));
}

export function shouldContinueSoak(cyclesCompleted, minCycles, elapsedMs, minDurationMs) {
  return cyclesCompleted < minCycles || elapsedMs < minDurationMs;
}

export function checkSoakSession(session) {
  const value = record(session);
  const failures = [];
  if (!Number.isInteger(value.startPid) || value.startPid <= 0 ||
    value.endPid !== value.startPid) failures.push("server_pid_changed");
  if (value.cyclesCompleted < value.minCycles) failures.push("cycles_short");
  if (value.elapsedMs < value.minDurationMs) failures.push("duration_short");
  const samples = Array.isArray(value.healthSamples) ? value.healthSamples : [];
  // Initial and final samples cover the endpoints; each elapsed full minute
  // still needs a sample in the same uninterrupted session.
  if (samples.length < Math.floor(value.elapsedMs / 60_000) + 1) failures.push("missing_control_samples");
  if (samples.some((healthy) => healthy !== true)) failures.push("unhealthy_control_sample");
  if (!Number.isFinite(value.rssStartKb) || value.rssStartKb <= 0 ||
    !Number.isFinite(value.rssEndKb) || value.rssEndKb <= 0) failures.push("server_rss_unavailable");
  else if (value.rssEndKb > value.rssStartKb * 2) failures.push("server_rss_over_2x");
  return failures;
}
