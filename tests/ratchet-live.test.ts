import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, appendFileSync, renameSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
// The runner uses Apple's binary/XML plist reader. Unit fixtures use only this
// XML subset so the safety checks also run in the Linux PR test job.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: (cmd: string, args: string[], options: object) => {
    if (cmd !== "/usr/libexec/PlistBuddy") return actual.execFileSync(cmd, args, options);
    const key = args[1]!.split(":")[1]!;
    const value = readFileSync(args[2]!, "utf8").match(new RegExp(`<key>${key}</key><string>([^<]+)</string>`))?.[1];
    if (!value) throw new Error("missing synthetic plist key");
    return value;
  } };
});
// @ts-expect-error The runner's plain-JS helper has no declaration file.
import { productionSnapshot, productionChanges, privateWrites } from "../scripts/ratchet-production-guard.mjs";
// @ts-expect-error The runner's plain-JS helper has no declaration file.
import { assertAppTarget, assertProcessTarget } from "../scripts/ratchet-app-guard.mjs";

describe("ratchet app/process identity guard", () => {
  function bundle(id: string, version = "0.64.22") {
    const root = mkdtempSync(join(tmpdir(), "ratchet-app-")), app = join(root, "renamed.app");
    mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
    const executable = join(app, "Contents/MacOS/cmux");
    writeFileSync(executable, "synthetic; never execute");
    writeFileSync(join(app, "Contents/Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
    return { root, app, executable };
  }
  const hostedEnv = (root: string) => ({ GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", RUNNER_OS: "macOS", RUNNER_TEMP: root });
  it("allows NIGHTLY by identity and refuses renamed production apps and process targets", () => {
    const nightly = bundle("com.cmuxterm.app.nightly"), stable = bundle("com.cmuxterm.app");
    expect(assertAppTarget(nightly.app, { env: {} }).bundleId).toBe("com.cmuxterm.app.nightly");
    expect(() => assertAppTarget(stable.app, { env: {} })).toThrow("production bundle refused");
    expect(() => assertProcessTarget(stable.executable)).toThrow("production process target refused");
    expect(() => assertProcessTarget(nightly.executable)).not.toThrow();
  });
  it("refuses NIGHTLY metadata whose executable resolves into production", () => {
    const nightly = bundle("com.cmuxterm.app.nightly"), stable = bundle("com.cmuxterm.app");
    renameSync(nightly.executable, nightly.executable + ".unused");
    symlinkSync(stable.executable, nightly.executable);
    expect(() => assertAppTarget(nightly.app, { env: {} })).toThrow("production bundle refused");
    expect(() => assertProcessTarget(nightly.executable)).toThrow("production process target refused");
  });
  it("permits exactly 0.64.22 only in hosted scratch capability mode", () => {
    const stable = bundle("com.cmuxterm.app"), env = hostedEnv(stable.root);
    expect(assertAppTarget(stable.app, { hostedRelease: true, capability: true, env }).hostedRelease).toBe(true);
    for (const options of [
      { hostedRelease: true, capability: false, env },
      { hostedRelease: false, capability: true, env },
      { hostedRelease: true, capability: true, env: { ...env, RUNNER_ENVIRONMENT: "self-hosted" } },
      { hostedRelease: true, capability: true, env: { ...env, GITHUB_ACTIONS: "false" } },
      { hostedRelease: true, capability: true, env: { ...env, RUNNER_OS: "Linux" } },
      { hostedRelease: true, capability: true, env: { ...env, RUNNER_TEMP: mkdtempSync(join(tmpdir(), "other-runner-")) } },
    ]) expect(() => assertAppTarget(stable.app, options)).toThrow("production bundle refused");
    const wrong = bundle("com.cmuxterm.app", "0.64.23");
    expect(() => assertAppTarget(wrong.app, { hostedRelease: true, capability: true, env: hostedEnv(wrong.root) })).toThrow("version mismatch");
  });
});

describe("production attribution guard", () => {
  const token = "RATCHET_SYNTHETIC_UNIQUE_RUN";
  function fixture() {
    const home = mkdtempSync(join(tmpdir(), "ratchet-guard-"));
    for (const dir of [".local/state/cmuxlayer", ".local/state/cmux", ".cmuxlayer/tickets", ".cmux/agents"]) mkdirSync(join(home, dir), { recursive: true });
    const log = join(home, ".local/state/cmuxlayer/daemon.log");
    writeFileSync(log, token + "\n");
    return { home, log };
  }
  it("allows unrelated live writes and excludes pre-existing token bytes", () => {
    const { home, log } = fixture();
    writeFileSync(join(home, ".local/state/cmux/nightly-last-socket-path"), "/tmp/cmux-nightly.sock");
    const before = productionSnapshot(home);
    appendFileSync(log, "unrelated production append\n");
    writeFileSync(join(home, ".local/state/cmux/last-socket-path"), "/unrelated.sock");
    expect(productionChanges(before, productionSnapshot(home), [token], [])).toEqual([]);
  });
  it("requires a private daemon write and fails closed on lost appended ranges", () => {
    const { home, log } = fixture(), before = productionSnapshot(home);
    expect(privateWrites(home).status).toBe("PASS");
    writeFileSync(log, ""); expect(privateWrites(home).status).toBe("FAIL");
    expect(() => productionChanges(before, productionSnapshot(home), [token], [])).toThrow("truncated");
    renameSync(log, join(home, "outside.log"));
    expect(() => productionChanges(before, productionSnapshot(home), [token], [])).toThrow("disappeared");
  });
  it("attributes new agents and changed pointers to this run", () => {
    const { home } = fixture(), before = productionSnapshot(home);
    mkdirSync(join(home, ".cmux/agents/returned-agent"));
    mkdirSync(join(home, ".cmux/agents/ratchet-synthetic"));
    writeFileSync(join(home, ".local/state/cmux/nightly-last-socket-path"), "/tmp/cmux-nightly.sock");
    const changed = productionChanges(before, productionSnapshot(home), [token], ["returned-agent"]);
    expect(changed).toContain(".cmux/agents/returned-agent");
    expect(changed).toContain(".cmux/agents/ratchet-synthetic");
    expect(changed).toContain(".local/state/cmux/nightly-last-socket-path");
  });
  it("finds tokens across read chunks and in new/rotated logs and tickets", () => {
    const { home, log } = fixture(), before = productionSnapshot(home);
    appendFileSync(log, "x".repeat(65530) + token);
    writeFileSync(join(home, ".cmuxlayer/tickets/new.json"), JSON.stringify({ token }));
    writeFileSync(join(home, ".local/state/cmux/cmuxlayer-daemon-fixture.log"), token);
    let changed = productionChanges(before, productionSnapshot(home), [token], []);
    expect(changed).toContain(".local/state/cmuxlayer/daemon.log");
    expect(changed).toContain(".cmuxlayer/tickets/new.json");
    expect(changed).toContain(".local/state/cmux/cmuxlayer-daemon-fixture.log");
    const rotation = productionSnapshot(home);
    renameSync(log, log + ".1"); writeFileSync(log, token);
    changed = productionChanges(rotation, productionSnapshot(home), [token], []);
    expect(changed).toEqual([".local/state/cmuxlayer/daemon.log"]);
  });
});

describe("live ratchet fail-closed CLI", () => {
  it.each(["bundle", "process"])("refuses a production %s before the launch boundary", (target) => {
    const home = mkdtempSync(join(tmpdir(), "ratchet-bundle-"));
    const app = join(home, "cmux NIGHTLY.app");
    mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
    const plist = (id: string) => `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string></dict></plist>`;
    writeFileSync(join(app, "Contents/Info.plist"), plist(target === "bundle" ? "com.cmuxterm.app" : "com.cmuxterm.app.nightly"));
    if (target === "process") {
      const stable = join(home, "production.app");
      mkdirSync(join(stable, "Contents/MacOS"), { recursive: true });
      writeFileSync(join(stable, "Contents/Info.plist"), plist("com.cmuxterm.app"));
      writeFileSync(join(stable, "Contents/MacOS/cmux"), "synthetic; never execute");
      symlinkSync(join(stable, "Contents/MacOS/cmux"), join(app, "Contents/MacOS/cmux"));
    } else writeFileSync(join(app, "Contents/MacOS/cmux"), "synthetic; never execute");
    // Intercept open even if the guard is removed: a regression must never launch a real app in this test.
    const source = readFileSync("scripts/ratchet-live.mjs", "utf8");
    const launch = source.split("\n").find(line => line.includes('run("/usr/bin/open",'))!;
    expect(launch).toBeTruthy();
    const marker = join(home, "launch-attempted"), runner = join(home, "runner.mjs");
    writeFileSync(runner, source.replace(launch, `writeFileSync(${JSON.stringify(marker)}, "intercepted"); throw new Error("synthetic launch intercepted");`));
    const plistBuddy = join(home, "plist-buddy.mjs");
    writeFileSync(plistBuddy, `#!${process.execPath}\nimport { readFileSync } from "node:fs";\nconst key = process.argv[3].split(":")[1];\nconst value = readFileSync(process.argv[4], "utf8").match(new RegExp("<key>" + key + "</key><string>([^<]+)</string>"))?.[1];\nif (!value) process.exit(1);\nconsole.log(value);\n`, { mode: 0o700 });
    for (const helper of ["ratchet-production-guard.mjs", "ratchet-app-guard.mjs"]) writeFileSync(join(home, helper), readFileSync(join("scripts", helper), "utf8").replace('"/usr/libexec/PlistBuddy"', JSON.stringify(plistBuddy)));
    const out = join(home, "receipt.json");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CMUX|GITHUB_|RUNNER_)/.test(key)));
    const result = spawnSync(process.execPath, [runner, "--capability", "--app", app, "--output", out], { encoding: "utf8", env: { ...env, HOME: home, TMPDIR: home } });
    expect(result.status).toBe(1);
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({ status: "FAIL", error: expect.stringContaining("production bundle refused") });
    expect(JSON.parse(readFileSync(out, "utf8")).processes).toEqual([]);
    expect(() => readFileSync(marker)).toThrow();
  });
  it("writes FAIL receipts and exits 1 when NIGHTLY is missing", () => {
    const out = join(mkdtempSync(join(tmpdir(), "ratchet-red-")), "receipt.json");
    const result = spawnSync(process.execPath, ["scripts/ratchet-live.mjs", "--capability",
      "--app", "/nonexistent/cmux NIGHTLY.app", "--output", out], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("| FAIL |");
    expect(result.stdout).not.toContain("SKIP");
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({ status: "FAIL" });
  });
});
