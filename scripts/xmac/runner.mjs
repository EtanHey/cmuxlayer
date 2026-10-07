import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createContext } from "./ctx.mjs";

const frames = value => Array.isArray(value) ? value.flatMap(frames) : typeof value?.text === "string" ? [value] : [];
const infrastructure = notes => /(?:artifact_failed|cleanup|spawn_failed|spawn_missing_identity|lead_spawn_failed|socket|transport|authentication|not logged|ENOENT|binary missing|launcher gate mismatch)/i.test(JSON.stringify(notes));
const knownDefects = { spawn_boot_false_unsubmitted: "landed_with_unverified_receipt", submit_unverified_on_landed: "landed_with_unverified_receipt" };
export function ratchetProof(bug, fixed) {
  if (!fixed) return "FIX_PENDING";
  if (bug?.status === "FAIL" && bug.failure_kind === "behavior" && bug.expected_defect === true && fixed.status === "PASS" &&
      bug.host === fixed.host && bug.cmux === fixed.cmux && bug.cmux_version === fixed.cmux_version && bug.cmuxlayer_sha !== fixed.cmuxlayer_sha) return "PROVEN";
  return "UNPROVEN";
}
const cell = value => String(value ?? "—").replaceAll("|", "/").replaceAll("\n", " ");
export function markdownTable(rows) {
  return ["| row | target | cmux version | cmuxlayer SHA | status | failure kind | evidence |", "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(row => `| ${cell(row.id)} | ${cell(`${row.host}:${row.cmux}`)} | ${cell(row.cmux_version)} | ${cell(row.cmuxlayer_sha)} | ${cell(row.status)} | ${cell(row.failure_kind)} | ${cell(row.evidence_path)} |`)].join("\n") + "\n";
}
export async function runScenarios({ scenarios, driver, evidenceDir, parseScreen, phase = "installed" }) {
  const rows = [], payloads = new Map(), lifecycleErrors = [];
  let lifecycle;
  try {
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
    for (const scenario of scenarios) {
      if (!/^[a-z0-9_]+$/.test(scenario.id)) throw new Error("unsafe scenario id");
      const dir = join(evidenceDir, scenario.id), observed = [];
      const ctx = createContext({ driver, evidenceDir: dir, parseScreen, onScreen: (_surface, raw) => {
        observed.push(raw.text); if (observed.length > 64) observed.shift();
      } });
      let result, error;
      const supported = scenario.targets.includes(`${driver.target.host}:${driver.target.cmux}`);
      try {
        result = supported ? await scenario.run(ctx) : { status: "PRECONDITION_ABSENT", evidence: {}, notes: ["unsupported target"] };
        if (!["PASS", "FAIL", "PRECONDITION_ABSENT"].includes(result.status)) throw new Error("invalid scenario status");
        if (result.status !== "PRECONDITION_ABSENT" && (!result.evidence?.receipt || !frames(result.evidence.screenAfter).some(frame => frame.text.trim() && observed.includes(frame.text)))) {
          throw new Error("independent receipt/screen evidence missing");
        }
      } catch (caught) { error = String(caught); }
      finally { try { await ctx.dispose(); } catch (caught) { error = `${error ?? ""} cleanup: ${caught}`; } }
      const row = { id: scenario.id, host: driver.target.host, cmux: driver.target.cmux, cmux_version: driver.target.cmuxVersion,
        cmuxlayer_sha: driver.target.cmuxlayerSha, phase, bug: scenario.bug, fix: scenario.fix?.sha ? scenario.fix : { ...scenario.fix, sha: null, status: "pending" },
        status: error ? "FAIL" : result.status, failure_kind: error || infrastructure(result?.notes) ? "infrastructure" : result?.status === "FAIL" ? "behavior" : null,
        notes: [...(result?.notes ?? []), ...(error ? [error] : [])], evidence_path: join(dir, "runner-result.json"),
        authoritative_coverage: scenario.id === "send_under_codex_overlays" ? { row: "send_under_codex_banner", bug: "7f26603f", fix: "64260ba3", hooks_fixture: "codex-hooks-review.txt" } : null };
      const code = scenario.bug?.failure_code ?? knownDefects[scenario.id];
      row.expected_defect = row.failure_kind === "behavior" && !!code && row.notes.some(note => String(note).includes(code));
      payloads.set(row.id, { result, error });
      rows.push(row);
    }
  } catch (error) { lifecycleErrors.push(String(error)); }
  finally {
    try { lifecycle = await driver.close(); if (lifecycle.status !== "PASS") lifecycleErrors.push("target lifecycle failed"); }
    catch (error) { lifecycleErrors.push(String(error)); }
  }
  if (lifecycleErrors.length) for (const row of rows) { row.status = "FAIL"; row.failure_kind = "infrastructure"; row.expected_defect = false; row.notes.push(...lifecycleErrors); }
  for (const row of rows) await writeFile(row.evidence_path, JSON.stringify({ row, ...payloads.get(row.id), lifecycle_errors: lifecycleErrors }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  const result = { status: !lifecycleErrors.length && rows.length === scenarios.length && rows.length && rows.every(row => row.status === "PASS") ? "PASS" : "FAIL",
    scope: "scenarios", release_gate: false, early_warning_only: driver.target.cmux === "nightly", rows, lifecycle, lifecycle_errors: lifecycleErrors };
  await writeFile(join(evidenceDir, "ratchet-table.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await writeFile(join(evidenceDir, "pr-comment.md"), markdownTable(rows), { mode: 0o600, flag: "wx" });
  return result;
}
