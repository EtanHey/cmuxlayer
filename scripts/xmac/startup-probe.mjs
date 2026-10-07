import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { hostname } from "node:os";
import { normalizeProcessIdentity } from "../cmux-session-guard.mjs";
import { rpc } from "../soak-runtime.mjs";
import { shellQuote } from "./target.mjs";

const DIAGNOSTIC_LIMITS = Object.freeze({ max_attempts: 100, text_per_attempt_bytes: 2048,
  text_total_bytes: 16384, success_text_bytes: 2048, health_field_bytes: 64, error_bytes: 512 });
// Decode a complete UTF-8 prefix; never trim prompt framing or split a code point.
function boundedText(value, limit) {
  const bytes = Buffer.from(value, "utf8");
  const text = new TextDecoder().decode(bytes.subarray(0, limit), { stream: true });
  const stored = Buffer.byteLength(text);
  return { value: text, original_bytes: bytes.length, stored_bytes: stored, truncated: stored < bytes.length };
}
function diagnosticError(error) {
  try { return boundedText(String(error), DIAGNOSTIC_LIMITS.error_bytes); }
  catch { return { value: "error description unavailable", unavailable: true }; }
}
function healthEvidence(health, probe, window, uuid) {
  const row = Array.isArray(health?.surfaces) ? health.surfaces.find(item => item?.id === probe.surface_id) : null;
  const truncated = [], field = key => {
    if (typeof row?.[key] !== "string") return null;
    const value = boundedText(row[key], DIAGNOSTIC_LIMITS.health_field_bytes);
    if (value.truncated) truncated.push(key);
    return value.value;
  };
  return { workspace_id: health?.workspace_id === probe.workspace_id ? probe.workspace_id : null,
    window_id: health?.window_id === window ? window : null,
    window_match: uuid(health?.window_id) ? health.window_id === window : null,
    surface_count: Array.isArray(health?.surfaces) ? health.surfaces.length : null,
    surface: row ? { id: probe.surface_id, socket_binding: field("socket_binding"),
      render_health: field("render_health"), in_window: typeof row.in_window === "boolean" ? row.in_window : null } : null,
    truncated_fields: truncated };
}

// Read-only proof of the app that owns the probe's transport. Never log argv.
export function observeProbeOwner(runtime, { exec = execFileSync, lstat = lstatSync, host = hostname, uid = process.getuid } = {}) {
  const { pid } = runtime.receipt.app_process;
  const read = args => exec("ps", args, { encoding: "utf8", timeout: 5000, env: { ...process.env, LC_ALL: "C" } }).trim();
  const saved = normalizeProcessIdentity(read(["-p", String(pid), "-o", "pid=,lstart=,comm="]));
  const executable = read(["-p", String(pid), "-o", "comm="]);
  const args = read(["-ww", "-p", String(pid), "-o", "args="]).split(/\s+/);
  const index = args.indexOf("--soak-launch-token");
  const token = index >= 0 ? args[index + 1] : null;
  const socket = runtime.env.CMUX_SOCKET_PATH, stat = lstat(socket);
  const files = exec("lsof", ["-n", "-U", "-a", "-p", String(pid), "-Fpn"], { encoding: "utf8", timeout: 5000 }).trim().split("\n");
  return { host: host(), saved, executable, token, socket,
    socketIdentity: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`,
    socketOwned: stat.isSocket() && stat.uid === uid() && files.includes(`p${pid}`) && files.includes(`n${socket}`) };
}

export async function runCodexResolutionProbe(runtime, wrapper = null,
  { rpc: request = rpc, observe = observeProbeOwner, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = {}) {
  const receipt = runtime.receipt, app = receipt.app_process, socket = runtime.env.CMUX_SOCKET_PATH;
  const expected = receipt.fixtures?.row ? receipt.fixtures.binaries.codex : wrapper;
  if (receipt.fixtures?.row && (!expected || wrapper && wrapper !== expected)) throw new Error("run-owned fixture trap required");
  const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
  const expectedSocket = receipt.target === "m1-gate" ? "/tmp/cmux-soak-stable.sock" : receipt.target === "nightly" ? "/tmp/cmux-nightly.sock" : null;
  if (!expectedSocket || socket !== expectedSocket || !uuid(receipt.launch_token) || !app?.saved ||
      !Number.isSafeInteger(app.pid) || app.pid <= 1 || app.launch_token !== receipt.launch_token) throw new Error("startup probe owner receipt missing");
  const owner = { host: receipt.host, saved: app.saved, executable: receipt.app_target?.executable,
    token: receipt.launch_token, socket };
  const diagnostics = { status: "RUNNING", limits: DIAGNOSTIC_LIMITS, attempts: [], total_text_bytes: 0 };
  receipt.startup_probe = { owner: { ...owner }, close: "pending", diagnostics };
  let socketIdentity, ownershipFailed = false;
  const assertOwner = () => {
    try {
      const current = observe(runtime);
      if (!current.socketOwned || !current.socketIdentity || !owner.executable ||
          Object.entries(owner).some(([key, value]) => !value || current[key] !== value) ||
          socketIdentity && current.socketIdentity !== socketIdentity) throw new Error("startup probe app/socket ownership changed");
      socketIdentity ??= current.socketIdentity;
    } catch (error) {
      ownershipFailed = true; diagnostics.ownership_error = diagnosticError(error); throw error;
    }
  };
  // Revalidate after every await, including a rejection. The first RPC error wins.
  const guardedRequest = async (method, params) => {
    assertOwner();
    let value, failed = false, primary;
    try { value = await request(socket, method, params); }
    catch (error) { failed = true; primary = error; }
    try { assertOwner(); } catch (error) { if (!failed) throw error; }
    if (failed) throw primary;
    return value;
  };
  try {
    assertOwner();
    const marker = `XMAC_CODEX_${receipt.launch_token}:`, idle = `XMAC_IDLE_${receipt.launch_token}`;
    // OSC 133 marks an actual interactive shell prompt after exec/init. No busy cat.
    const prompt = `%{\x1b]133;A\x07%}${idle}%{\x1b]133;B\x07%} `;
    const command = `printf '%s%s\\n' ${shellQuote(marker)} "$(command -v codex)"; export PS1=${shellQuote(prompt)}; exec /bin/zsh -dfi`;
    const created = await guardedRequest("workspace.create", { workspace_id: runtime.workspace, cwd: runtime.cwd,
      initial_command: `/bin/zsh -lc ${shellQuote(command)}` });
    const probe = { workspace_id: created.workspace_id, surface_id: created.surface_id }, window = created.window_id;
    if (!uuid(window) || !uuid(probe.workspace_id) || !uuid(probe.surface_id) || probe.workspace_id === receipt.workspace?.workspace_id) throw new Error("startup probe created identity missing or anchor reused");
    Object.assign(receipt.startup_probe, probe, { window_id: window, owner: { ...owner, socketIdentity } });
    let settled = false;
    for (let attempt = 0; attempt < DIAGNOSTIC_LIMITS.max_attempts; attempt++) {
      const evidence = { attempt: attempt + 1, started_at_ms: now(), predicates: {
        marker_present: null, absolute_resolution: null, idle: null, workspace_match: null,
        sole_surface: null, surface_match: null, bound: null, rendering: null, in_window: null, window_match: null } };
      diagnostics.attempts.push(evidence);
      try {
        let text;
        try { text = (await guardedRequest("surface.read_text", probe)).text ?? ""; }
        catch (error) { evidence.read_error = diagnosticError(error); throw error; }
        evidence.text = boundedText(text, Math.min(DIAGNOSTIC_LIMITS.text_per_attempt_bytes,
          DIAGNOSTIC_LIMITS.text_total_bytes - diagnostics.total_text_bytes));
        diagnostics.total_text_bytes += evidence.text.stored_bytes;
        const resolved = text.split("\n").find(line => line.startsWith(marker))?.slice(marker.length).trim();
        const textReady = !!resolved?.startsWith("/") && text.includes(idle);
        Object.assign(evidence.predicates, { marker_present: resolved !== undefined,
          absolute_resolution: !!resolved?.startsWith("/"), idle: text.includes(idle) });
        let health;
        try { health = await guardedRequest("surface.health", { workspace_id: probe.workspace_id }); }
        catch (error) {
          evidence.health_error = diagnosticError(error);
          // This was a required admission read only after the text predicate passed.
          if (textReady || ownershipFailed) throw error;
        }
        if (health) {
          try {
            evidence.health = healthEvidence(health, probe, window, uuid);
            const row = health.surfaces?.[0];
            Object.assign(evidence.predicates, { workspace_match: health.workspace_id === probe.workspace_id,
              sole_surface: health.surfaces?.length === 1, surface_match: row?.id === probe.surface_id,
              bound: row?.socket_binding === "bound", rendering: row?.render_health === "rendering",
              in_window: evidence.health.surface?.in_window ?? null, window_match: evidence.health.window_match });
          } catch (error) { evidence.health_collection_error = diagnosticError(error); }
        }
        // Existing 0.65 read-only interface: query only this run-owned window. Never
        // retain titles, paths, or summaries of another selected workspace.
        try {
          const selection = await guardedRequest("workspace.current", { window_id: window });
          const ownWindow = selection?.window_id === window, selected = selection?.workspace_id;
          evidence.selection = ownWindow && uuid(selected) ? { status: "available", window_id: window,
            selected_workspace_id: [probe.workspace_id, runtime.workspace].includes(selected) ? selected : null,
            selected_workspace_omitted: ![probe.workspace_id, runtime.workspace].includes(selected),
            probe_selected: selected === probe.workspace_id } : { status: "unavailable" };
        } catch (error) {
          evidence.selection = { status: "unavailable", error: diagnosticError(error) };
          if (ownershipFailed) throw error;
        }
        if (textReady) {
          if (health.workspace_id === probe.workspace_id && health.surfaces?.length === 1 &&
              health.surfaces[0].id === probe.surface_id && health.surfaces[0].socket_binding === "bound" &&
              health.surfaces[0].render_health === "rendering") {
            receipt.resolved_codex = resolved;
            const capture = boundedText(text, DIAGNOSTIC_LIMITS.success_text_bytes);
            receipt.codex_probe_screen = capture.value;
            const { value: _text, ...captureFacts } = capture;
            receipt.codex_probe_screen_capture = captureFacts;
            const boundedHealth = evidence.health ?? { workspace_id: probe.workspace_id, window_id: null,
              surface: { id: probe.surface_id, socket_binding: "bound", render_health: "rendering", in_window: null } };
            receipt.startup_probe.settle = { idle, health: { workspace_id: boundedHealth.workspace_id,
              window_id: boundedHealth.window_id, surfaces: [boundedHealth.surface] } };
            settled = true; break;
          }
        }
      } finally { evidence.elapsed_ms = now() - evidence.started_at_ms; }
      await sleep(100);
    }
    if (!settled) throw new Error("startup probe did not reach bound rendering idle prompt");
    if (expected && receipt.resolved_codex !== expected) throw new Error("run-owned Codex resolution mismatch");
    assertOwner();
    const value = await guardedRequest("surface.list", { workspace_id: probe.workspace_id });
    if (value.workspace_id !== probe.workspace_id || !Array.isArray(value.surfaces) || value.surfaces.length !== 1 || value.surfaces[0].id !== probe.surface_id) throw new Error("startup probe surface ownership changed");
    assertOwner();
    // Any confirmation remains a failure; no EOF, force, retry, or preference write.
    await guardedRequest("workspace.close", { workspace_id: probe.workspace_id });
    assertOwner();
    const remaining = await guardedRequest("workspace.list", { window_id: window });
    if (!Array.isArray(remaining.workspaces) || remaining.workspaces.some(row => row.id === probe.workspace_id)) throw new Error("startup probe close unverified");
    receipt.startup_probe.close = "unforced"; receipt.startup_probe.closed = true;
    diagnostics.status = "PASS";
  } catch (error) {
    diagnostics.status = "FAIL"; diagnostics.error = diagnosticError(error);
    throw error;
  }
}
