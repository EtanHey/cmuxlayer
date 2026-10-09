import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error Plain-JS runner helper.
import { productionSnapshot, productionChanges } from "../scripts/ratchet-production-guard.mjs";

const roots: string[] = [];
const temporary = () => { const root = mkdtempSync(join(tmpdir(), "hosted-capability-test-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const marker = ".local/state/cmux/last-socket-path";
const nightlyMarker = ".local/state/cmux/nightly-last-socket-path";
const token = "PRIVATE_SYNTHETIC_CAPABILITY_RUN";

function fixture() {
  const root = temporary(), home = join(root, "home"), app = join(root, "cmux.app");
  for (const dir of [".local/state/cmux", ".local/state/cmuxlayer", ".cmux/agents"]) mkdirSync(join(home, dir), { recursive: true });
  mkdirSync(app);
  const log = join(home, ".local/state/cmuxlayer/daemon.log"); writeFileSync(log, "old bytes\n");
  const before = productionSnapshot(home);
  writeFileSync(join(home, marker), "/tmp/cmux-nightly.sock");
  const env = { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", RUNNER_OS: "macOS", RUNNER_TEMP: root };
  return { root, home, app, log, before, env };
}

describe("hosted capability marker attribution", () => {
  it("records the runner-local marker before/after without mutating either snapshot", () => {
    const f = fixture(), after = productionSnapshot(f.home), runnerLocal: unknown[] = [];
    expect(productionChanges(f.before, after, [token], [], [], { capability: true, app: f.app, env: f.env, runnerLocal })).toEqual([]);
    expect(runnerLocal).toEqual([{ path: marker, before: null, after: "/tmp/cmux-nightly.sock" }]);
    expect(f.before.socket_pointers[marker]).toBeNull(); expect(after.socket_pointers[marker]).toBe("/tmp/cmux-nightly.sock");
    const unchanged: unknown[] = [];
    productionChanges(after, after, [token], [], [], { capability: true, app: f.app, env: f.env, runnerLocal: unchanged });
    expect(unchanged).toEqual([{ path: marker, before: "/tmp/cmux-nightly.sock", after: "/tmp/cmux-nightly.sock" }]);
  });
  it("keeps logs, agents and the NIGHTLY marker attributed on the hosted runner", () => {
    const f = fixture();
    appendFileSync(f.log, token); mkdirSync(join(f.home, ".cmux/agents/ratchet-private"));
    writeFileSync(join(f.home, nightlyMarker), "/tmp/cmux-nightly.sock");
    expect(productionChanges(f.before, productionSnapshot(f.home), [token], [], [], { capability: true, app: f.app, env: f.env, runnerLocal: [] }))
      .toEqual([".cmux/agents/ratchet-private", ".local/state/cmuxlayer/daemon.log", nightlyMarker].sort());
  });
  it("leaves local, M1, self-hosted, non-capability and outside-scratch calls strict", () => {
    const f = fixture(), after = productionSnapshot(f.home), outside = temporary();
    const escaped = join(f.root, "escape.app"); symlinkSync(outside, escaped);
    const contexts = [
      { capability: true, app: f.app, env: {} },
      { capability: false, app: f.app, env: f.env },
      { capability: true, app: f.app, env: { ...f.env, GITHUB_ACTIONS: "false" } },
      { capability: true, app: f.app, env: { ...f.env, RUNNER_ENVIRONMENT: "self-hosted" } },
      { capability: true, app: f.app, env: { ...f.env, RUNNER_OS: "Linux" } },
      { capability: true, app: f.app, env: { ...f.env, RUNNER_TEMP: "" } },
      { capability: true, app: f.app, env: { ...f.env, RUNNER_TEMP: outside } },
      { capability: true, app: escaped, env: f.env },
    ];
    expect(productionChanges(f.before, after, [token], [])).toEqual([marker]);
    for (const context of contexts) {
      const runnerLocal: unknown[] = [];
      expect(productionChanges(f.before, after, [token], [], [], { ...context, runnerLocal })).toEqual([marker]);
      expect(runnerLocal).toEqual([]);
    }
  });
  it("keeps unreadable or oversized marker snapshots fail-closed", () => {
    const f = fixture(); writeFileSync(join(f.home, marker), "x".repeat(8193));
    expect(() => productionSnapshot(f.home)).toThrow("socket pointer exceeds guard limit");
  });
  it.each([true, false])("the runner receipts marker attribution in hosted=%s capability mode", (hosted) => {
    const f = fixture(), output = join(f.root, "receipt.json");
    mkdirSync(join(f.app, "Contents/MacOS"), { recursive: true });
    writeFileSync(join(f.app, "Contents/MacOS/cmux"), "synthetic; never execute");
    const id = hosted ? "com.cmuxterm.app" : "com.cmuxterm.app.nightly";
    writeFileSync(join(f.app, "Contents/Info.plist"), `<plist><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleShortVersionString</key><string>0.64.22</string></dict></plist>`);
    const plist = join(f.root, "plist.mjs");
    writeFileSync(plist, `#!${process.execPath}\nimport { readFileSync } from "node:fs";\nconst key = process.argv[3].split(":")[1];\nconsole.log(readFileSync(process.argv[4], "utf8").match(new RegExp("<key>" + key + "</key><string>([^<]+)</string>"))[1]);\n`, { mode: 0o700 });
    let source = readFileSync("scripts/ratchet-live.mjs", "utf8");
    const launch = source.split("\n").find(line => line.includes('run("/usr/bin/open",'));
    const processes = source.split("\n").find(line => line.startsWith("function processes()"));
    expect(launch).toBeTruthy(); expect(processes).toBeTruthy();
    // Stop at the launch boundary: this fixture has no app launch, real process
    // enumeration, daemon, pane, model or signal. Only its private marker writes.
    source = source.replace(processes!, "function processes() { return []; }")
      .replace(launch!, `writeFileSync(join(productionHome, ${JSON.stringify(marker)}), cmuxSocket); throw new Error("synthetic launch boundary");`);
    for (const helper of ["ratchet-production-guard.mjs", "ratchet-app-guard.mjs"]) {
      writeFileSync(join(f.root, helper), readFileSync(join("scripts", helper), "utf8").replace('"/usr/libexec/PlistBuddy"', JSON.stringify(plist)));
    }
    // Make this run change the marker, rather than inheriting fixture()'s value.
    writeFileSync(join(f.home, marker), "/synthetic-before.sock");
    const runner = join(f.root, "runner.mjs"); writeFileSync(runner, source);
    const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CMUX|GITHUB_|RUNNER_)/.test(key)));
    const result = spawnSync(process.execPath, [runner, "--capability", ...(hosted ? ["--hosted-release"] : []), "--app", f.app, "--output", output],
      { encoding: "utf8", env: { ...clean, ...(hosted ? f.env : {}), HOME: f.home, TMPDIR: f.root } });
    expect(result.status).toBe(1); // Deliberate synthetic launch refusal, never live-green.
    const receipt = JSON.parse(readFileSync(output, "utf8"));
    expect(receipt.processes).toEqual([]);
    expect(receipt.production_guard).toMatchObject(hosted ? { status: "PASS", violations: [], runner_local_state: [
      { path: marker, before: "/synthetic-before.sock", after: "/tmp/cmux-nightly.sock" },
    ] } : { status: "FAIL", violations: [marker], runner_local_state: [] });
  });
});

function verify(overrides: Record<string, string> = {}) {
  const root = temporary(), bin = join(root, "bin"); mkdirSync(bin);
  const commands = join(root, "commands"), assessment = join(root, "assessment.txt"), app = join(root, "synthetic.app"); mkdirSync(app);
  for (const [name, code] of Object.entries({
    codesign: 'exit "${TEST_SIGNATURE_STATUS:-0}"',
    xcrun: 'echo "synthetic staple status=${TEST_STAPLE_STATUS:-65}"; exit "${TEST_STAPLE_STATUS:-65}"',
    spctl: 'printf "%s\\n" "${TEST_ASSESSMENT:-source=Notarized Developer ID}" >&2; exit "${TEST_GATEKEEPER_STATUS:-0}"',
  })) writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' '${name}' >> "$TEST_COMMANDS"\n${code}\n`, { mode: 0o700 });
  const script = resolve("scripts/verify-cmux-capability-app.sh");
  // Exercise the previous real workflow boundary for RED; after the fix, run
  // the same verification program that the hosted job invokes.
  const inline = readFileSync(".github/workflows/ratchet-capability.yml", "utf8").split("\n")
    .filter(line => /xcrun stapler validate|spctl -a --type execute/.test(line)).map(line => line.trim()).join("\n");
  const args = existsSync(script) ? [script, app, assessment] : ["-c", "set -euo pipefail\n" + inline];
  const result = spawnSync("bash", args, { encoding: "utf8", env: { ...process.env, PATH: bin + ":" + process.env.PATH,
    RUNNER_TEMP: root, CAPABILITY_APP: "synthetic.app", TEST_COMMANDS: commands, ...overrides } });
  return { ...result, commands: readFileSync(commands, "utf8").trim().split("\n"), assessment: existsSync(assessment) ? readFileSync(assessment, "utf8") : null };
}

describe("capability signature and Gatekeeper prerequisite", () => {
  it("accepts unstapled notarized code only after signature and Gatekeeper checks", () => {
    const result = verify();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.commands).toEqual(["codesign", "xcrun", "spctl"]);
    expect(result.stdout).toContain("::notice::"); expect(result.stdout).toContain("65");
    expect(result.assessment).toContain("source=Notarized Developer ID");
  });
  it("still checks Gatekeeper when a valid staple exists", () => {
    const result = verify({ TEST_STAPLE_STATUS: "0" });
    expect(result.status).toBe(0); expect(result.commands).toEqual(["codesign", "xcrun", "spctl"]);
  });
  it("refuses an invalid signature before consulting the staple or Gatekeeper", () => {
    const result = verify({ TEST_SIGNATURE_STATUS: "1", TEST_STAPLE_STATUS: "0" });
    expect(result.status).toBe(1); expect(result.commands).toEqual(["codesign"]);
  });
  it("refuses rejected or accepted-but-unnotarized code", () => {
    for (const overrides of [{ TEST_GATEKEEPER_STATUS: "3" }, { TEST_ASSESSMENT: "source=Unnotarized Developer ID" },
      { TEST_ASSESSMENT: "path/source=Notarized Developer ID" }]) {
      const result = verify(overrides);
      expect(result.status).not.toBe(0); expect(result.commands).toEqual(["codesign", "xcrun", "spctl"]);
    }
  });
});
