import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { shellStartup } from "../scripts/soak-runtime.mjs";
import { checkLauncherArgv } from "../scripts/xmac/argv-preflight.mjs";
import { classifyLaunchOverlay } from "../scripts/xmac/launch-overlay.mjs";
import { launchFailureRows } from "../scripts/xmac/launcher-preflight.mjs";
import { replaySamples } from "../scripts/xmac/live.mjs";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "xmac-cwd-test-"))), home = join(root, "home"), zdot = join(root, "zdot");
  const config = join(home, ".config/ralphtools"), cwd = join(home, "fixed repo's path");
  for (const path of [config, zdot, cwd]) mkdirSync(path, { recursive: true });
  const body = `fixtureCodex() { local dest=${JSON.stringify(root)} model; while (( $# )); do case "$1" in -w|--worktree) dest="$2"; shift 2;; -m) model="$2"; shift 2;; *) shift;; esac; done; cd "$dest" || return; codex --model "$model"; }\n`;
  writeFileSync(join(config, "golem-dispatch.zsh"), body);
  const registry = join(config, "launchers.zsh"); writeFileSync(registry, "fixtureCodex() { codex '--model broken'; }\n");
  const env = { HOME: home, PATH: "/usr/bin:/bin", ZDOTDIR: zdot, CODEX_HOME: join(home, ".codex"), CMUXLAYER_LAUNCHER_REGISTRY_PATH: registry };
  const opts = { target: "m1-gate", launcherMode: true, launcherClis: ["codex"], launchCwd: cwd, launchReceipt: join(root, "launches.jsonl"), launchers: { codex: "fixtureCodex" } };
  writeFileSync(join(zdot, ".zshenv"), shellStartup(env, opts));
  return { root, env, opts, body };
}
it("private shell forwards fixed -w after dispatcher-last and preserves explicit -w, once across repeated startup", () => {
  const f = fixture();
  try {
    const command = `source "$ZDOTDIR/.zshenv"; codex() { print -r -- "$PWD"; }; fixtureCodex -m gpt-6-luna; fixtureCodex -w '${f.root}' -m gpt-6-luna; fixtureCodex -w '${f.root}' --worktree '${f.env.HOME}' -m gpt-6-luna`;
    expect(execFileSync("/bin/zsh", ["-lic", command], { env: f.env, encoding: "utf8" }).trim().split("\n")).toEqual([f.opts.launchCwd, f.root, f.env.HOME]);
    const rows = readFileSync(f.opts.launchReceipt, "utf8").trim().split("\n").map(JSON.parse);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ launcher: "fixtureCodex", launch_cwd: f.opts.launchCwd, effective_argv: ["-w", f.opts.launchCwd, "-m", "gpt-6-luna"] });
    expect(rows[1].effective_argv).toEqual(["-w", f.root, "-m", "gpt-6-luna"]);
    expect(rows[2].launch_cwd).toBe(f.env.HOME);
    expect(rows[0].actual_launch_command).toContain("fixtureCodex");
    const roundtrip = execFileSync("/bin/zsh", ["-fc", `fixtureCodex() { printf '%s\\n' "$@"; }; ${rows[0].actual_launch_command}`], { encoding: "utf8" });
    expect(roundtrip.trim().split("\n")).toEqual(rows[0].effective_argv);
    expect(readFileSync(join(f.env.HOME, ".config/ralphtools/golem-dispatch.zsh"), "utf8")).toBe(f.body);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
it("wraps both scenario launchers, preserves malformed explicit -w failure, and leaves NIGHTLY startup alone", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.env.HOME, ".config/ralphtools/golem-dispatch.zsh"), f.body + f.body.replaceAll("fixtureCodex", "fixtureClaude"));
    const both = { ...f.opts, launcherClis: ["codex", "claude"], launchers: { codex: "fixtureCodex", claude: "fixtureClaude" } };
    writeFileSync(join(f.env.ZDOTDIR, ".zshenv"), shellStartup(f.env, both));
    const command = `codex() { print -r -- "$PWD"; }; fixtureClaude -m haiku; fixtureCodex -w; print -r -- "exit:$?"`;
    expect(execFileSync("/bin/zsh", ["-lic", command], { env: f.env, encoding: "utf8" }).trim().split("\n")).toEqual([f.opts.launchCwd, "exit:2"]);
    expect(shellStartup(f.env, { ...both, target: "nightly" })).not.toContain("_xmac_original_");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
it("stops before fix and remaining scenarios when launch cwd is unproven", async () => {
  const precondition = { status: "PRECONDITION_ABSENT", kind: "launch_cwd", observed: "/wrong", expected: "/fixed" };
  let calls = 0;
  const scenario = { id: "first", bug: { sha: "bug" }, fix: { sha: "fix" } };
  const rows = await replaySamples([scenario, { ...scenario, id: "next" }], async () => { calls++; return { rows: [{ status: "PRECONDITION_ABSENT", precondition }] }; });
  expect(calls).toBe(1);
  expect(rows).toMatchObject([{ status: "UNPROVEN", candidate: "not run: launch_cwd" }]);
});
it("model-free preflight observes actual CLI cwd and fails closed when a launcher ignores -w", () => {
  const f = fixture();
  try {
    const row = checkLauncherArgv(f.env, f.opts, f.opts.launchers);
    expect(row).toMatchObject({ status: "PASS", launch_cwd: { status: "PASS", observed: f.opts.launchCwd, expected: f.opts.launchCwd } });
    writeFileSync(join(f.env.ZDOTDIR, ".zshenv"), shellStartup(f.env, f.opts) + `fixtureCodex() { cd '${f.root}'; codex --model gpt-6-luna; }\n`);
    let error: any; try { checkLauncherArgv(f.env, f.opts, f.opts.launchers); } catch (caught) { error = caught; }
    expect(error?.precondition).toMatchObject({ status: "PRECONDITION_ABSENT", kind: "launch_cwd", observed: f.root, expected: f.opts.launchCwd });
    expect(launchFailureRows([{ id: "stray_newline" }], { host: "m1", cmux: "prod" }, "a".repeat(40), "bug", "receipt", error)[0]).toMatchObject({ status: "PRECONDITION_ABSENT", expected_defect: false });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
it("trust overlay retains the folder header above the explanatory paragraphs", () => {
  const text = "Codex\nFolder: /synthetic/untrusted/repo\n\nDo you trust the contents of this directory?\n\nTools may execute here.\nOnly proceed if you trust this folder.\n\n› 1. Trust and continue\n  2. Quit\n";
  expect(classifyLaunchOverlay(text)).toMatchObject({ overlay: "trust", first_lines: expect.arrayContaining(["Folder: /synthetic/untrusted/repo"]) });
});
