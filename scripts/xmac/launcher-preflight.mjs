import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function scenarioLaunchers(scenario) {
  const codex = ["spawn_boot_false_unsubmitted", "send_under_codex_overlays", "submit_unverified_on_landed", "stray_newline",
    "resume_stale_done", "resume_focus", "resume_keeps_worker_role", "busy_codex_steer_vs_queue", "codex_launch_under_cmux_wrapper"];
  const clis = scenario.launcherClis ?? (codex.includes(scenario.id) ? ["codex"] :
    scenario.id === "send_idle_claude_deadlock" ? ["claude"] : scenario.id === "lead_spawn_role_worker" ? ["claude", "codex"] : null);
  return validateClis(clis);
}
function validateClis(clis) {
  if (!Array.isArray(clis) || !clis.length || clis.some(cli => !["codex", "claude"].includes(cli))) throw new Error("scenario must declare valid launcherClis");
  return [...new Set(clis)];
}
export async function checkLauncherRoots(repo, clis, { sourcePath = join(homedir(), ".config/ralphtools/launchers.zsh"), registry } = {}) {
  clis = validateClis(clis);
  const { loadLauncherRegistrySnapshot, resolveLauncherNameFromRegistry, resolveRepoRootFromLauncherRegistry } = registry ?? await import("../../dist/launcher-registry.js");
  const snapshot = loadLauncherRegistrySnapshot({ sourcePath });
  if (!snapshot.available) throw new Error(`target launcher registry unavailable: ${sourcePath}: ${snapshot.unavailable_reason}`);
  const options = { sourcePath, entries: snapshot.entries }, launchers = [], missing = [];
  for (const cli of clis) {
    const launcher = resolveLauncherNameFromRegistry(repo, cli, options), path = resolveRepoRootFromLauncherRegistry(repo, options);
    const entry = { cli, launcher, path }; launchers.push(entry);
    try { if (!statSync(path).isDirectory()) missing.push({ ...entry, reason: "not a directory" }); }
    catch (error) { missing.push({ ...entry, reason: error.code ?? String(error) }); }
  }
  const result = { status: missing.length ? "PRECONDITION_ABSENT" : "PASS", kind: "launcher_root", sourcePath, launchers, missing };
  if (missing.length) { const error = new Error(`PRECONDITION_ABSENT: ${JSON.stringify(result)}`); error.precondition = result; throw error; }
  return result;
}
export function launchFailureRows(selected, opts, sha, phase, evidencePath, error) {
  const absent = error.precondition?.status === "PRECONDITION_ABSENT" && ["launcher_root", "launcher_argv", "launch_cwd", "launch_overlay", "human_cmux_session"].includes(error.precondition.kind);
  return selected.map(scenario => ({ id: scenario.id, host: opts.host, cmux: opts.cmux === "prod" ? "prod-0.64.22" : "nightly", cmux_version: null,
    cmuxlayer_sha: sha, phase, status: absent ? "PRECONDITION_ABSENT" : "FAIL", failure_kind: "infrastructure", expected_defect: false,
    notes: [String(error)], precondition: absent ? error.precondition : null, evidence_path: evidencePath }));
}
