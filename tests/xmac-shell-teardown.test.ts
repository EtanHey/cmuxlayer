import { expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { shellStartup } from "../scripts/soak-runtime.mjs";
import { checkLauncherArgv } from "../scripts/xmac/argv-preflight.mjs";
import { closeOwnedSurfaces } from "../scripts/xmac/surface-cleanup.mjs";
import { launchFailureRows } from "../scripts/xmac/launcher-preflight.mjs";
import { ratchetProof } from "../scripts/xmac/runner.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "xmac-shell-test-")), home = join(root, "home"), zdot = join(root, "zdot");
  const config = join(home, ".config/ralphtools"); mkdirSync(config, { recursive: true }); mkdirSync(zdot);
  const parse = 'local model; while (( $# )); do case "$1" in -m) model="$2"; shift 2;; *) shift;; esac; done;';
  writeFileSync(join(config, "golem-dispatch.zsh"), `repoGolem() { fixtureCodex() { ${parse} codex \${model:+--model "$model"}; }; }\nfixtureCodex() { ${parse} codex --model "$model"; }\n`);
  const registry = join(config, "launchers.zsh"); writeFileSync(registry, "repoGolem fixture /synthetic/repo\n");
  const env = { HOME: home, PATH: "/usr/bin:/bin", ZDOTDIR: zdot, CODEX_HOME: join(home, ".codex"), CMUXLAYER_LAUNCHER_REGISTRY_PATH: registry };
  const opts = { target: "m1-gate", launcherMode: true, launcherClis: ["codex"] };
  writeFileSync(join(zdot, ".zshenv"), shellStartup(env, opts));
  return { root, env, opts };
}
it("harness startup leaves dispatcher thin wrappers last instead of legacy registry definitions", () => {
  const f = fixture(), shim = join(f.root, "codex");
  try {
    writeFileSync(shim, '#!/bin/sh\nprintf "<%s>\\n" "$@"\n', { mode: 0o700 });
    const out = execFileSync("/bin/zsh", ["-lic", `codex() { '${shim}' "$@"; }; fixtureCodex -s --worker -m gpt-6-luna -E low`], { env: f.env, encoding: "utf8" });
    expect(out).toBe("<--model>\n<gpt-6-luna>\n");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
it("argv preflight uses the harness shell and rejects joined model arguments before a seat starts", () => {
  const f = fixture(), seat = vi.fn();
  try {
    writeFileSync(join(f.env.ZDOTDIR, ".zshenv"), shellStartup(f.env, f.opts) + `fixtureCodex() { codex '--model gpt-6-luna'; }\n`);
    let error: any;
    try { checkLauncherArgv(f.env, f.opts, { codex: "fixtureCodex" }); seat(); } catch (caught) { error = caught; }
    expect(error?.precondition).toMatchObject({ status: "PRECONDITION_ABSENT", kind: "launcher_argv", observed_argv: ["--model gpt-6-luna"] });
    const [row] = launchFailureRows([{ id: "stray_newline" }], { host: "m1", cmux: "prod" }, "a".repeat(40), "bug", "receipt.json", error);
    expect(row.status).toBe("PRECONDITION_ABSENT"); expect(row.expected_defect).toBe(false);
    expect(ratchetProof(row, { ...row, status: "PASS" })).toBe("UNPROVEN");
    expect(seat).not.toHaveBeenCalled(); expect(existsSync(f.env.CODEX_HOME)).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
it("argv preflight accepts two elements without touching the authenticated CODEX_HOME", () => {
  const f = fixture();
  try {
    expect(checkLauncherArgv(f.env, f.opts, { codex: "fixtureCodex" })).toMatchObject({ status: "PASS", observed_argv: ["--model", "gpt-6-luna"] });
    expect(existsSync(f.env.CODEX_HOME)).toBe(false);
    // A newline in a prompt cannot impersonate argv elements, and private config
    // content never appears in the receipt.
    writeFileSync(join(f.env.ZDOTDIR, ".zshenv"), shellStartup(f.env, f.opts) + `fixtureCodex() { codex $'--model\\ngpt-6-luna' 'mcp_servers.synthetic.env.TOKEN=private-fixture'; }\n`);
    let error: any; try { checkLauncherArgv(f.env, f.opts, { codex: "fixtureCodex" }); } catch (caught) { error = caught; }
    expect(error?.precondition.observed_argv).toEqual(["[other argument]", "[other argument]"]);
    expect(String(error)).not.toContain("private-fixture");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
it("missing shim capture fails closed and Claude-only runs do not invoke the Codex probe", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.env.ZDOTDIR, ".zshenv"), shellStartup(f.env, f.opts) + "fixtureCodex() { return 0; }\n");
    expect(() => checkLauncherArgv(f.env, f.opts, { codex: "fixtureCodex" })).toThrow("PRECONDITION_ABSENT");
    expect(checkLauncherArgv(f.env, { ...f.opts, launcherClis: ["claude"] }, {})).toBeNull();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
it("teardown closes owned seats and preserves the last anchor plus unrelated surfaces", async () => {
  const rows = [{ id: "anchor", ref: "surface:1" }, { id: "seat", ref: "surface:2" }, { id: "foreign", ref: "surface:3" }];
  const list = vi.fn(async () => [...rows]);
  const close = vi.fn(async (id: string) => { if (rows.length === 1) throw new Error("Cannot close the last surface"); rows.splice(rows.findIndex(row => row.id === id), 1); });
  await closeOwnedSurfaces({ list, close, owned: new Set(["anchor", "seat"]), anchor: new Set(["anchor", "surface:1"]) });
  expect(close.mock.calls).toEqual([["seat"]]); expect(rows.map(row => row.id)).toEqual(["anchor", "foreign"]);
  const onlyAnchor = { list: async () => [{ id: "anchor" }], close: vi.fn(), owned: new Set(["anchor"]), anchor: new Set(["anchor"]) };
  await closeOwnedSurfaces(onlyAnchor); expect(onlyAnchor.close).not.toHaveBeenCalled();
});
it("teardown re-enumerates before closing and retains a last owned seat if the anchor disappeared", async () => {
  const seat = { id: "seat" }, anchor = { id: "anchor" }, close = vi.fn();
  const list = vi.fn().mockResolvedValueOnce([seat, anchor]).mockResolvedValue([seat]);
  const result = await closeOwnedSurfaces({ list, close, owned: new Set(["seat"]), anchor: new Set(["anchor"]) });
  expect(close).not.toHaveBeenCalled(); expect(result.retained).toEqual([seat]);
});
it("teardown does not claim a close when the socket rejects it or the surface remains", async () => {
  const list = async () => [{ id: "seat" }, { id: "anchor" }], owned = new Set(["seat"]);
  await expect(closeOwnedSurfaces({ list, owned, close: async () => { throw new Error("socket rejected"); } })).rejects.toThrow("socket rejected");
  await expect(closeOwnedSurfaces({ list, owned, close: async () => {} })).rejects.toThrow("close unverified");
});
