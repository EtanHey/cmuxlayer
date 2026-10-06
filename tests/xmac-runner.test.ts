import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScenarios, ratchetProof, markdownTable } from "../scripts/xmac/runner.mjs";

const target = { host: "m1", cmux: "prod-0.64.22", cmuxVersion: "0.64.22", cmuxlayerSha: "a".repeat(40), codexWrapper: null };
function driver() { return { target, call: vi.fn(), readScreen: vi.fn(async () => ({ text: "\n• SYNTHETIC_REPLY\n› \n" })), sweepChildren: vi.fn(async () => ({})), verifyClosed: vi.fn(async () => true), close: vi.fn(async () => ({ status: "PASS", violations: [] })) }; }
const scenario = { id: "fixture", targets: ["m1:prod-0.64.22"], bug: { sha: "bug" }, fix: { sha: null }, async run(ctx: any) {
  const screen = await ctx.readScreen("surface:fixture");
  return { status: "PASS", evidence: { receipt: { ok: true }, screenBefore: { text: "" }, screenAfter: screen } };
} };
it("records exact target/SHA and independent screen evidence and always tears down", async () => {
  const root = mkdtempSync(join(tmpdir(), "xmac-runner-test-")), d = driver();
  try {
    const output = await runScenarios({ scenarios: [scenario], driver: d, evidenceDir: root, parseScreen: () => ({}) });
    expect(output.rows[0]).toMatchObject({ status: "PASS", cmuxlayer_sha: target.cmuxlayerSha, cmux_version: "0.64.22" });
    expect(readFileSync(output.rows[0].evidence_path, "utf8")).toContain("SYNTHETIC_REPLY");
    expect(d.sweepChildren).toHaveBeenCalled(); expect(d.close).toHaveBeenCalledOnce();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it("absent preconditions and fabricated passing frames never become green", async () => {
  const root = mkdtempSync(join(tmpdir(), "xmac-runner-test-"));
  try {
    const absent = { ...scenario, id: "absent", run: async () => ({ status: "PRECONDITION_ABSENT", evidence: {}, notes: ["no overlay"] }) };
    const fabricated = { ...scenario, id: "fabricated", run: async () => ({ status: "PASS", evidence: { receipt: {}, screenAfter: { text: "made up" } } }) };
    const output = await runScenarios({ scenarios: [absent, fabricated], driver: driver(), evidenceDir: root, parseScreen: () => ({}) });
    expect(output.status).not.toBe("PASS");
    expect(output.rows.map(row => row.status)).toEqual(["PRECONDITION_ABSENT", "FAIL"]);
    expect(output.rows[1].failure_kind).toBe("infrastructure");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it("cleanup or transport failure invalidates pass and is never a behavior replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "xmac-runner-test-")), d = driver();
  try {
    d.close.mockResolvedValue({ status: "FAIL", violations: ["PID identity changed"] });
    const output = await runScenarios({ scenarios: [scenario], driver: d, evidenceDir: root, parseScreen: () => ({}) });
    expect(output.rows[0]).toMatchObject({ status: "FAIL", failure_kind: "infrastructure" });
    expect(output.status).toBe("FAIL");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it("ratchets require the expected behavior defect, same target/version and fixed PASS", () => {
  const bug = { status: "FAIL", failure_kind: "behavior", expected_defect: true, host: "m1", cmux: "prod-0.64.22", cmux_version: "0.64.22", cmuxlayer_sha: "bug" };
  const fixed = { ...bug, status: "PASS", cmuxlayer_sha: "fix" };
  expect(ratchetProof(bug, fixed)).toBe("PROVEN");
  expect(ratchetProof({ ...bug, failure_kind: "infrastructure" }, fixed)).not.toBe("PROVEN");
  expect(ratchetProof({ ...bug, expected_defect: false }, fixed)).not.toBe("PROVEN");
  expect(ratchetProof(bug, { ...fixed, cmux_version: "different" })).not.toBe("PROVEN");
  expect(ratchetProof(bug, null)).toBe("FIX_PENDING");
  expect(markdownTable([{ ...bug, id: "x|y", evidence_path: "receipt.json" }])).toContain("x/y");
});

it("CLI plan parsing rejects production MBP and requires explicit provenance for installed runs", async () => {
  const { options } = await import("../scripts/xmac/live.mjs");
  expect(() => options(["--host", "mbp", "--cmux", "prod", "--scenario", "fixture.mjs", "--dry-run"])).toThrow("MBP");
  expect(() => options(["--host", "m1", "--cmux", "prod", "--dmg", "/pinned", "--repo", "fixture", "--scenario", "fixture.mjs", "--prepare-driver"])).toThrow("dist-digest");
  expect(options(["--host", "m1", "--cmux", "prod", "--dmg", "/pinned", "--repo", "fixture", "--scenario", "fixture.mjs", "--dry-run"]).dryRun).toBe(true);
});

it("closes the target when evidence directory creation fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "xmac-runner-test-")), d = driver();
  try {
    const blocked = join(root, "blocked"); writeFileSync(blocked, "synthetic");
    await expect(runScenarios({ scenarios: [scenario], driver: d, evidenceDir: blocked, parseScreen: () => ({}) })).rejects.toThrow();
    expect(d.close).toHaveBeenCalledOnce();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
