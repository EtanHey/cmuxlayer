import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

function nightlyFixture() {
  const f = fixture(), scratch = join(f.home, "work/_temp"), app = join(scratch, "cmux NIGHTLY.app");
  mkdirSync(app, { recursive: true });
  return { ...f, app, env: { ...f.env, HOME: f.home, RUNNER_TEMP: scratch } };
}

describe("NIGHTLY snapshot marker locality", () => {
  const beforeValue = "/synthetic-before.sock\n", afterValue = "/tmp/cmux-nightly.sock\n";
  function linked(kind: string, dangling = false) {
    const f = nightlyFixture(), outside = temporary(), external = join(outside, "nightly-last-socket-path");
    const link = join(f.home, kind === "marker" ? nightlyMarker : ".local/state/cmux");
    if (!dangling) writeFileSync(external, beforeValue);
    rmSync(link, { recursive: true, force: true });
    symlinkSync(dangling ? join(outside, "missing") : kind === "marker" ? external : outside, link);
    return { ...f, outside, external, link, kind };
  }
  function changes(f: ReturnType<typeof nightlyFixture>, before: unknown, after = productionSnapshot(f.home)) {
    const runnerLocal: { path: string }[] = [];
    const violations = productionChanges(before, after, [token], [], [], { capability: true, nightly: true, app: f.app, env: f.env, runnerLocal });
    return { violations, nightlyReceipts: runnerLocal.filter(row => row.path === nightlyMarker) };
  }
  it.each(["marker", "parent"])("retains attribution for an external %s symlink", kind => {
    const f = linked(kind), before = productionSnapshot(f.home);
    writeFileSync(f.external, afterValue);
    expect(changes(f, before)).toEqual({ violations: [nightlyMarker], nightlyReceipts: [] });
  });
  it.each(["marker", "parent"])("uses the captured before location after an external %s link is retargeted inside", kind => {
    const f = linked(kind), before = productionSnapshot(f.home);
    rmSync(f.link); if (kind === "parent") mkdirSync(f.link);
    writeFileSync(join(f.home, nightlyMarker), afterValue);
    const after = productionSnapshot(f.home);
    expect(changes(f, before, after)).toEqual({ violations: [nightlyMarker], nightlyReceipts: [] });
    expect(before.nightly_marker_location.path).toBe(realpathSync(f.external));
    expect(after.nightly_marker_location.path).toBe(realpathSync(join(f.home, nightlyMarker)));
  });
  it.each(["marker", "parent"])("retains attribution when an internal %s path is retargeted outside", kind => {
    const f = nightlyFixture(); writeFileSync(join(f.home, nightlyMarker), beforeValue);
    const before = productionSnapshot(f.home), outside = temporary(), external = join(outside, "nightly-last-socket-path");
    writeFileSync(external, afterValue);
    const link = join(f.home, kind === "marker" ? nightlyMarker : ".local/state/cmux");
    rmSync(link, { recursive: true }); symlinkSync(kind === "marker" ? external : outside, link);
    expect(changes(f, before)).toEqual({ violations: [nightlyMarker], nightlyReceipts: [] });
  });
  it.each(["marker", "parent"])("does not exempt an ambiguous dangling %s link in the before snapshot", kind => {
    const f = linked(kind, true), before = productionSnapshot(f.home);
    rmSync(f.link); if (kind === "parent") mkdirSync(f.link);
    writeFileSync(join(f.home, nightlyMarker), afterValue);
    expect(changes(f, before)).toEqual({ violations: [nightlyMarker], nightlyReceipts: [] });
    expect(before.nightly_marker_location).toMatchObject({ error: "ENOENT" });
  });
  it("captures the existing ancestor when marker and intermediate parent are absent", () => {
    const f = nightlyFixture(); rmSync(join(f.home, ".local/state/cmux"), { recursive: true });
    const before = productionSnapshot(f.home);
    expect(before.nightly_marker_location).toMatchObject({ home: realpathSync(f.home),
      path: join(realpathSync(f.home), nightlyMarker), existing_parent: realpathSync(join(f.home, ".local/state")) });
    mkdirSync(join(f.home, ".local/state/cmux")); writeFileSync(join(f.home, nightlyMarker), afterValue);
    expect(changes(f, before)).toEqual({ violations: [], nightlyReceipts: [{ path: nightlyMarker, before: null, after: afterValue }] });
  });
  it("captures an escaping existing parent even when the marker is absent", () => {
    const f = linked("parent"); rmSync(f.external);
    const before = productionSnapshot(f.home); rmSync(f.link); mkdirSync(f.link);
    writeFileSync(join(f.home, nightlyMarker), afterValue);
    expect(changes(f, before)).toEqual({ violations: [nightlyMarker], nightlyReceipts: [] });
    expect(before.nightly_marker_location).toMatchObject({ path: join(realpathSync(f.outside), "nightly-last-socket-path"), existing_parent: realpathSync(f.outside) });
  });
  it.each(["before", "after"])("requires location evidence from the %s snapshot", side => {
    const f = nightlyFixture(); writeFileSync(join(f.home, nightlyMarker), beforeValue);
    const before = productionSnapshot(f.home); writeFileSync(join(f.home, nightlyMarker), afterValue);
    const after = productionSnapshot(f.home);
    delete (side === "before" ? before : after).nightly_marker_location;
    expect(changes(f, before, after)).toEqual({ violations: [nightlyMarker], nightlyReceipts: [] });
  });
  it("denies the exemption when a captured parent disappears into a dangling link", () => {
    const f = nightlyFixture(); writeFileSync(join(f.home, nightlyMarker), beforeValue);
    const before = productionSnapshot(f.home), parent = join(f.home, ".local/state/cmux");
    rmSync(parent, { recursive: true }); symlinkSync(join(temporary(), "missing"), parent);
    const after = productionSnapshot(f.home);
    expect(after.nightly_marker_location).toMatchObject({ error: "ENOENT" });
    expect(changes(f, before, after).nightlyReceipts).toEqual([]);
  });
  it("fails closed if the marker is retargeted during the snapshot read", async () => {
    const f = nightlyFixture(), outside = temporary(), external = join(outside, "nightly-last-socket-path");
    writeFileSync(join(f.home, nightlyMarker), beforeValue); writeFileSync(external, afterValue);
    const read = 'return readFileSync(join(home, path), "utf8");';
    const source = readFileSync("scripts/ratchet-production-guard.mjs", "utf8");
    expect(source.split(read)).toHaveLength(2);
    // Inject one private filesystem retarget immediately after the real read.
    // Exercise snapshot refusal, without modifying tracked source or launching anything.
    const injected = 'import { rmSync, symlinkSync } from "node:fs";\n' + source
      .replace('"./ratchet-app-guard.mjs"', JSON.stringify(pathToFileURL(resolve("scripts/ratchet-app-guard.mjs")).href))
      .replace(read, `const value = readFileSync(join(home, path), "utf8");
        if (path === pointers[1]) { rmSync(join(home, path)); symlinkSync(${JSON.stringify(external)}, join(home, path)); } return value;`);
    const api = await import(/* @vite-ignore */ "data:text/javascript;base64," + Buffer.from(injected).toString("base64"));
    expect(() => api.productionSnapshot(f.home)).toThrow("NIGHTLY marker location changed during snapshot");
  });
});

describe("hosted capability marker attribution", () => {
  it("records the captured NIGHTLY boundary with raw marker values, keeping other writes attributed", () => {
    const captured = JSON.parse(readFileSync("tests/fixtures/hosted-nightly-marker.json", "utf8"));
    expect(captured).toMatchObject({ status: "FAIL", row_status: "PASS", bundle_id: "com.cmuxterm.app.nightly",
      production_guard: { status: "FAIL", violations: [nightlyMarker] } });
    const f = nightlyFixture(); writeFileSync(join(f.home, nightlyMarker), "/synthetic-before.sock\n");
    const before = productionSnapshot(f.home);
    writeFileSync(join(f.home, nightlyMarker), captured.socket + "\n");
    appendFileSync(f.log, token); mkdirSync(join(f.home, ".cmux/agents/ratchet-private"));
    mkdirSync(join(f.home, ".cmuxlayer/tickets"), { recursive: true });
    writeFileSync(join(f.home, ".cmuxlayer/tickets/private.json"), token);
    const after = productionSnapshot(f.home), snapshots = JSON.stringify([before, after]), runnerLocal: unknown[] = [];
    const context = { capability: true, nightly: true, app: f.app, env: f.env, runnerLocal };
    expect(productionChanges(before, after, [token], [], [], context))
      .toEqual([".cmux/agents/ratchet-private", ".cmuxlayer/tickets/private.json", ".local/state/cmuxlayer/daemon.log"].sort());
    expect(runnerLocal).toContainEqual({ path: nightlyMarker, before: "/synthetic-before.sock\n", after: captured.socket + "\n" });
    expect(JSON.stringify([before, after])).toBe(snapshots);
    const unchanged: unknown[] = [];
    productionChanges(after, after, [token], [], [], { ...context, runnerLocal: unchanged });
    expect(unchanged).toContainEqual({ path: nightlyMarker, before: captured.socket + "\n", after: captured.socket + "\n" });
  });
  it("keeps NIGHTLY strict for local/self-hosted/outside-scratch or ambiguous HOME contexts", () => {
    const f = nightlyFixture(), before = productionSnapshot(f.home), outside = temporary();
    writeFileSync(join(f.home, nightlyMarker), "/tmp/cmux-nightly.sock\n");
    const after = productionSnapshot(f.home), context = { capability: true, nightly: true, app: f.app, env: f.env };
    const escape = join(f.env.RUNNER_TEMP, "escape.app"); symlinkSync(outside, escape);
    const contexts = [ { ...context, nightly: false }, { ...context, nightly: "true" }, { ...context, capability: false },
      ...[{}, { ...f.env, RUNNER_ENVIRONMENT: "self-hosted" }, { ...f.env, RUNNER_OS: "Linux" },
        { ...f.env, GITHUB_ACTIONS: "false" }, { ...f.env, HOME: "" }, { ...f.env, HOME: outside },
        { ...f.env, HOME: "/" }, { ...f.env, RUNNER_TEMP: f.home }].map(env => ({ ...context, env })),
      { ...context, app: f.home }, { ...context, app: escape } ];
    for (const c of contexts) expect(productionChanges(before, after, [token], [], [], { ...c, runnerLocal: [] })).toEqual([nightlyMarker]);
    expect(productionChanges(before, { ...after, home: outside }, [token], [], [], { ...context, runnerLocal: [] })).toEqual([nightlyMarker]);
    expect(productionChanges({ ...before, home: outside }, after, [token], [], [], { ...context, runnerLocal: [] })).toEqual([nightlyMarker]);
    expect(() => productionChanges(before, after, [token], [], [], { ...context, env: { ...f.env, HOME: join(outside, "missing") }, runnerLocal: [] })).toThrow();
  });
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
  it.each([[true, false], [false, true], [true, true]])("the runner receipts markers in hosted=%s NIGHTLY=%s capability mode", (hosted, nightly) => {
    const f = hosted && nightly ? nightlyFixture() : fixture(), output = join(f.root, "receipt.json");
    const activeMarker = nightly ? nightlyMarker : marker;
    mkdirSync(join(f.app, "Contents/MacOS"), { recursive: true });
    writeFileSync(join(f.app, "Contents/MacOS/cmux"), "synthetic; never execute");
    const id = nightly ? "com.cmuxterm.app.nightly" : "com.cmuxterm.app";
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
      .replace(launch!, `writeFileSync(join(productionHome, ${JSON.stringify(activeMarker)}), cmuxSocket); throw new Error("synthetic launch boundary");`);
    for (const helper of ["ratchet-production-guard.mjs", "ratchet-app-guard.mjs"]) {
      writeFileSync(join(f.root, helper), readFileSync(join("scripts", helper), "utf8").replace('"/usr/libexec/PlistBuddy"', JSON.stringify(plist)));
    }
    // Make this run change the marker, rather than inheriting fixture()'s value.
    writeFileSync(join(f.home, activeMarker), "/synthetic-before.sock");
    const runner = join(f.root, "runner.mjs"); writeFileSync(runner, source);
    const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CMUX|GITHUB_|RUNNER_)/.test(key)));
    const result = spawnSync(process.execPath, [runner, "--capability", ...(hosted && !nightly ? ["--hosted-release"] : []), "--app", f.app, "--output", output],
      { encoding: "utf8", env: { ...clean, ...(hosted ? f.env : {}), HOME: f.home, TMPDIR: f.root } });
    expect(result.status).toBe(1); // Deliberate synthetic launch refusal, never live-green.
    const receipt = JSON.parse(readFileSync(output, "utf8"));
    expect(receipt.processes).toEqual([]);
    expect(receipt.production_guard).toMatchObject(hosted ? { status: "PASS", violations: [], runner_local_state: [
      ...(nightly ? [{ path: marker, before: "/tmp/cmux-nightly.sock", after: "/tmp/cmux-nightly.sock" }] : []),
      { path: activeMarker, before: "/synthetic-before.sock", after: "/tmp/cmux-nightly.sock" },
    ] } : { status: "FAIL", violations: [activeMarker], runner_local_state: [] });
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
