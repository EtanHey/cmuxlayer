import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "..");
const receiptCli = join(repoRoot, "scripts", "release-receipt.mjs");

const tmpRoots: string[] = [];

afterEach(() => {
  while (tmpRoots.length > 0) {
    const root = tmpRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(root);
  return root;
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function runReceipt(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [receiptCli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

type Fixture = {
  root: string;
  repoDir: string;
  tapDir: string;
  brewRepo: string;
  brewTapClone: string;
  receiptsDir: string;
  stubLog: string;
  env: NodeJS.ProcessEnv;
};

/**
 * Builds a sandbox with stubbed `git`/`brew`/`bun`/`curl`/`shasum` so the real
 * release scripts can be executed end-to-end without touching the network, the
 * live tap, or Homebrew.
 */
function makeReleaseFixture(
  opts: {
    installedVersion?: string | null;
    contractOutput?: string;
    withBrew?: boolean;
    withBrewTapClone?: boolean;
    withNode?: boolean;
    /** What the stubbed `gh` reports for the released commit; "" = no gh. */
    ciConclusion?: string;
  } = {},
): Fixture {
  const {
    installedVersion = "0.4.1",
    contractOutput = "[contract] PASS real-cmux contract lane",
    withBrew = true,
    withBrewTapClone = true,
    withNode = true,
    ciConclusion = "success",
  } = opts;

  const root = makeRoot("cmuxlayer-release-receipts-");
  const repoDir = join(root, "repo");
  const scriptsDir = join(repoDir, "scripts");
  const binDir = join(root, "bin");
  const tapDir = join(root, "tap");
  const brewRepo = join(root, "brew-repo");
  const brewTapClone = join(
    brewRepo,
    "Library",
    "Taps",
    "etanhey",
    "homebrew-layers",
  );
  const receiptsDir = join(root, "receipts");
  const stubLog = join(root, "stub.log");

  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(tapDir, "Formula"), { recursive: true });
  if (withBrewTapClone)
    mkdirSync(join(brewTapClone, ".git"), { recursive: true });

  for (const script of [
    "release.sh",
    "release-verify.sh",
    "release-receipt.mjs",
    "post-release-reconnect-sweep.sh",
  ]) {
    const source = join(repoRoot, "scripts", script);
    if (existsSync(source)) {
      copyFileSync(source, join(scriptsDir, script));
      chmodSync(join(scriptsDir, script), 0o755);
    }
  }

  writeFileSync(
    join(repoDir, "package.json"),
    `{\n  "version": "0.4.0",\n  "name": "cmuxlayer"\n}\n`,
  );
  writeFileSync(
    join(tapDir, "Formula", "cmuxlayer.rb"),
    [
      "class Cmuxlayer < Formula",
      '  url "https://github.com/EtanHey/cmuxlayer/archive/refs/tags/v0.4.0.tar.gz"',
      `  sha256 "${"0".repeat(64)}"`,
      "end",
      "",
    ].join("\n"),
  );

  writeExecutable(
    join(binDir, "git"),
    `#!/usr/bin/env bash
printf 'git %s\\n' "$*" >>"$STUB_LOG"
args=("$@")
if [ "\${args[0]:-}" = "-C" ]; then args=("\${args[@]:2}"); fi
case "\${args[0]:-}" in
  branch) echo main ;;
  diff) exit 0 ;;
  fetch) exit 0 ;;
  rev-parse)
    case "\${args[1]:-}" in
      v*) exit 1 ;;
      *) echo "1111111111111111111111111111111111111111" ;;
    esac ;;
  rev-list) echo "\${STUB_BEHIND:-0}" ;;
  *) exit 0 ;;
esac
`,
  );

  writeExecutable(
    join(binDir, "bun"),
    `#!/usr/bin/env bash
printf 'bun %s\\n' "$*" >>"$STUB_LOG"
if [ "\${2:-}" = "test:contract" ]; then
  printf '%s\\n' "$STUB_CONTRACT_OUTPUT"
  exit "\${STUB_CONTRACT_EXIT:-0}"
fi
exit 0
`,
  );

  writeExecutable(
    join(binDir, "curl"),
    `#!/usr/bin/env bash
printf 'curl %s\\n' "$*" >>"$STUB_LOG"
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done
[ -n "$out" ] && printf 'tarball\\n' >"$out"
exit 0
`,
  );

  writeExecutable(
    join(binDir, "shasum"),
    `#!/usr/bin/env bash
printf 'shasum %s\\n' "$*" >>"$STUB_LOG"
printf '%s  -\\n' "${"a".repeat(64)}"
exit 0
`,
  );

  if (withBrew) {
    writeExecutable(
      join(binDir, "brew"),
      `#!/usr/bin/env bash
printf 'brew %s\\n' "$*" >>"$STUB_LOG"
case "\${1:-}" in
  --repository) printf '%s\\n' "$STUB_BREW_REPO" ;;
  list)
    # real brew exits 1 when the formula is not installed
    [ -z "$STUB_INSTALLED_VERSION" ] && exit 1
    printf 'cmuxlayer %s\\n' "$STUB_INSTALLED_VERSION" ;;
  *) : ;;
esac
exit 0
`,
    );
  }

  writeExecutable(
    join(binDir, "gh"),
    `#!/usr/bin/env bash
printf 'gh %s\\n' "$*" >>"$STUB_LOG"
# An unusable gh (absent, unauthenticated, offline) must read as "unknown",
# never as "clean" -- so this stub fails the way the real one does.
[ -n "$STUB_CI_CONCLUSION" ] || exit 1
printf '%s\\n' "$STUB_CI_CONCLUSION"
`,
  );

  if (!withNode) {
    writeExecutable(
      join(binDir, "node"),
      `#!/usr/bin/env bash
printf 'node %s\\n' "$*" >>"$STUB_LOG"
echo "bash: node: command not found" >&2
exit 127
`,
    );
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    HOME: root,
    STUB_LOG: stubLog,
    STUB_BREW_REPO: brewRepo,
    STUB_INSTALLED_VERSION: installedVersion ?? "",
    STUB_CONTRACT_OUTPUT: contractOutput,
    STUB_CI_CONCLUSION: ciConclusion,
    CMUXLAYER_TAP_DIR: tapDir,
    CMUXLAYER_RELEASE_RECEIPTS_DIR: receiptsDir,
    CMUXLAYER_RECEIPT_HOST: "test-mac",
  };

  return {
    root,
    repoDir,
    tapDir,
    brewRepo,
    brewTapClone,
    receiptsDir,
    stubLog,
    env,
  };
}

function runScript(
  fixture: Fixture,
  script: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
) {
  const result = spawnSync(
    "bash",
    [join(fixture.repoDir, "scripts", script), ...args],
    {
      cwd: fixture.repoDir,
      encoding: "utf8",
      env: { ...fixture.env, ...extraEnv },
    },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    log: existsSync(fixture.stubLog)
      ? readFileSync(fixture.stubLog, "utf8")
      : "",
  };
}

function readReceipt(fixture: Fixture, version: string): any {
  const path = join(fixture.receiptsDir, `release-${version}.json`);
  expect(existsSync(path), `expected receipt at ${path}`).toBe(true);
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("release receipt ledger CLI", () => {
  it("initialises a receipt carrying version, tag, commit and timestamp", () => {
    const dir = makeRoot("cmuxlayer-receipt-cli-");
    const init = runReceipt(
      ["init", "0.9.1", "--commit", "abc1234", "--host", "test-mac"],
      { CMUXLAYER_RELEASE_RECEIPTS_DIR: dir },
    );

    expect(init.stderr).toBe("");
    expect(init.status).toBe(0);

    const receipt = JSON.parse(
      readFileSync(join(dir, "release-0.9.1.json"), "utf8"),
    );
    expect(receipt.version).toBe("0.9.1");
    expect(receipt.tag).toBe("v0.9.1");
    expect(receipt.commit).toBe("abc1234");
    expect(receipt.host).toBe("test-mac");
    expect(receipt.created_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    );
    expect(receipt.installs).toEqual([]);
  });

  it("records nested keys and keeps an append-only event trail", () => {
    const dir = makeRoot("cmuxlayer-receipt-cli-");
    const env = { CMUXLAYER_RELEASE_RECEIPTS_DIR: dir };
    runReceipt(["init", "0.9.1"], env);
    runReceipt(["record", "0.9.1", "gates.contract", "pass"], env);
    runReceipt(["record", "0.9.1", "artifact.sha256", "deadbeef"], env);

    const receipt = JSON.parse(
      readFileSync(join(dir, "release-0.9.1.json"), "utf8"),
    );
    expect(receipt.gates.contract).toBe("pass");
    expect(receipt.artifact.sha256).toBe("deadbeef");
    expect(
      receipt.events
        .filter((e: any) => e.event === "record")
        .map((e: any) => e.key),
    ).toEqual([
      "gates.contract",
      "artifact.sha256",
    ]);
  });

  it("appends per-Mac install evidence without dropping other Macs", () => {
    const dir = makeRoot("cmuxlayer-receipt-cli-");
    const env = { CMUXLAYER_RELEASE_RECEIPTS_DIR: dir };
    runReceipt(["init", "0.9.1"], env);
    runReceipt(
      [
        "install",
        "0.9.1",
        "--host",
        "m1",
        "--result",
        "pass",
        "--installed",
        "cmuxlayer 0.9.1",
        "--mode",
        "upgrade",
      ],
      env,
    );
    runReceipt(
      [
        "install",
        "0.9.1",
        "--host",
        "m4",
        "--result",
        "fail",
        "--installed",
        "cmuxlayer 0.9.0",
        "--mode",
        "verify-only",
      ],
      env,
    );

    const receipt = JSON.parse(
      readFileSync(join(dir, "release-0.9.1.json"), "utf8"),
    );
    expect(receipt.installs).toHaveLength(2);
    expect(receipt.installs[0]).toMatchObject({
      host: "m1",
      result: "pass",
      mode: "upgrade",
    });
    expect(receipt.installs[1]).toMatchObject({
      host: "m4",
      result: "fail",
      mode: "verify-only",
    });
    expect(receipt.installs[1].at).toMatch(/Z$/);
  });

  it("re-initialising an existing receipt preserves prior install evidence", () => {
    const dir = makeRoot("cmuxlayer-receipt-cli-");
    const env = { CMUXLAYER_RELEASE_RECEIPTS_DIR: dir };
    runReceipt(["init", "0.9.1"], env);
    runReceipt(
      [
        "install",
        "0.9.1",
        "--host",
        "m1",
        "--result",
        "pass",
        "--installed",
        "cmuxlayer 0.9.1",
      ],
      env,
    );
    runReceipt(["init", "0.9.1"], env);

    const receipt = JSON.parse(
      readFileSync(join(dir, "release-0.9.1.json"), "utf8"),
    );
    expect(receipt.installs).toHaveLength(1);
  });

  it("prints the receipt path so shell callers never guess it", () => {
    const dir = makeRoot("cmuxlayer-receipt-cli-");
    const result = runReceipt(["path", "0.9.1"], {
      CMUXLAYER_RELEASE_RECEIPTS_DIR: dir,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(join(dir, "release-0.9.1.json"));
  });
});

// These run the real release scripts end to end through stubbed binaries, so
// vitest's 5s default is the wrong budget and flakes under full-suite load.
describe("release.sh receipts", { timeout: 30_000 }, () => {
  it("writes a release receipt with version, sha256, commit and gate results", () => {
    const fixture = makeReleaseFixture();
    const result = runScript(fixture, "release.sh", ["0.4.1", "--yes"]);

    expect(result.stderr).not.toMatch(/release: /);
    expect(result.status).toBe(0);

    const receipt = readReceipt(fixture, "0.4.1");
    expect(receipt.version).toBe("0.4.1");
    expect(receipt.tag).toBe("v0.4.1");
    expect(receipt.commit).toBe("1".repeat(40));
    expect(receipt.created_at).toMatch(/Z$/);
    expect(receipt.artifact.sha256).toBe("a".repeat(64));
    expect(receipt.artifact.url).toContain("v0.4.1.tar.gz");
    expect(receipt.gates.typecheck).toBe("pass");
    expect(receipt.gates.tests).toBe("pass");
    expect(receipt.gates.contract).toBe("pass");
    expect(receipt.installs).toEqual([
      expect.objectContaining({
        host: "test-mac",
        result: "pass",
        installed: "cmuxlayer 0.4.1",
        mode: "upgrade",
      }),
    ]);
    expect(result.stdout).toContain(
      join(fixture.receiptsDir, "release-0.4.1.json"),
    );
  });

  // #490: publish.yml failed on 105 consecutive runs and cmuxlayer never reached
  // npm, because a release's own receipt said nothing about CI. It does now.
  it("records the CI verdict for the commit being released", () => {
    const fixture = makeReleaseFixture();
    const result = runScript(fixture, "release.sh", ["0.4.1", "--yes"]);

    expect(result.status).toBe(0);
    const receipt = readReceipt(fixture, "0.4.1");
    expect(receipt.gates.ci).toBe("success");
    // The verdict names the commit it is ABOUT. The read happens before the
    // version bump, so it is the commit the release was cut from, not the tag's.
    expect(receipt.gates.ci_commit).toBe("1".repeat(40));
    // `gh run list --commit` matches nothing on an abbreviated sha, so a short
    // one would silently read as "unknown". Keep the full form.
    expect(result.log).toContain(`gh run list --commit ${"1".repeat(40)}`);
    expect(result.stdout).toContain(
      `CI: success (ci.yml on ${"1".repeat(40)} — the commit this release was cut from)`,
    );
  });

  it("bumps package.json without changing its file mode", () => {
    const fixture = makeReleaseFixture();
    const manifest = join(fixture.repoDir, "package.json");
    chmodSync(manifest, 0o640);

    const result = runScript(fixture, "release.sh", ["0.4.1", "--yes"]);

    expect(result.status).toBe(0);
    expect(statSync(manifest).mode & 0o777).toBe(0o640);
  });

  it("never lets a release read as clean while its CI is red", () => {
    const fixture = makeReleaseFixture({ ciConclusion: "failure" });
    const result = runScript(fixture, "release.sh", ["0.4.1", "--yes"]);

    expect(result.status).toBe(0);
    expect(readReceipt(fixture, "0.4.1").gates.ci).toBe("failure");
    expect(result.stdout).toContain("WARNING");
    expect(result.stdout).toContain("CI: failure");
  });

  it("records an unusable gh as unknown rather than as a pass", () => {
    const fixture = makeReleaseFixture({ ciConclusion: "" });
    const result = runScript(fixture, "release.sh", ["0.4.1", "--yes"]);

    expect(result.status).toBe(0);
    expect(readReceipt(fixture, "0.4.1").gates.ci).toBe("unknown");
    expect(result.stdout).toContain("WARNING");
  });

  it("refuses to release on a non-green CI under --require-ci", () => {
    const fixture = makeReleaseFixture({ ciConclusion: "failure" });
    const result = runScript(fixture, "release.sh", [
      "0.4.1",
      "--yes",
      "--require-ci",
    ]);

    expect(result.status).not.toBe(0);
    // The die message, not `unknown flag: --require-ci`.
    expect(result.stderr).toContain("release: --require-ci");
    expect(result.log).not.toContain("git push origin main");
  });

  it("preserves the happy-path release commands (receipts stay additive)", () => {
    const fixture = makeReleaseFixture();
    const result = runScript(fixture, "release.sh", ["0.4.1", "--yes"]);

    expect(result.status).toBe(0);
    expect(result.log).toContain("git commit -aqm chore: release v0.4.1");
    expect(result.log).toContain("git push origin main");
    expect(result.log).toContain("git tag -a v0.4.1 -m cmuxlayer v0.4.1");
    expect(result.log).toContain("git push origin v0.4.1");
    expect(result.log).toContain("brew audit etanhey/layers/cmuxlayer");
    expect(
      readFileSync(join(fixture.repoDir, "package.json"), "utf8"),
    ).toContain('"version": "0.4.1"');
    const formula = readFileSync(
      join(fixture.tapDir, "Formula", "cmuxlayer.rb"),
      "utf8",
    );
    expect(formula).toContain("v0.4.1.tar.gz");
    expect(formula).toContain(`sha256 "${"a".repeat(64)}"`);
  });

  it("records a skipped contract gate instead of losing it to scrollback", () => {
    const fixture = makeReleaseFixture({
      contractOutput:
        "[contract] SKIP: CMUX_SOCKET_PATH is not set to a live cmux socket",
    });
    const result = runScript(fixture, "release.sh", ["0.4.1", "--yes"]);

    expect(result.status).toBe(0);
    const receipt = readReceipt(fixture, "0.4.1");
    expect(receipt.gates.contract).toBe("skip");
    expect(receipt.gates.contract_reason).toContain("CMUX_SOCKET_PATH");
  });

  it("classifies a PASS that is followed by cleanup output on stderr", () => {
    // The runner's finally block prints "[contract] cleanup warning …" AFTER
    // its PASS marker, so the lane's verdict is never reliably the last line.
    const fixture = makeReleaseFixture({
      contractOutput: [
        "[contract] PASS real-cmux contract lane",
        "[contract] cleanup warning for pid 4242: kill ESRCH",
      ].join("\n"),
    });
    const result = runScript(fixture, "release.sh", ["0.4.1", "--yes"]);

    expect(result.status).toBe(0);
    expect(readReceipt(fixture, "0.4.1").gates.contract).toBe("pass");
    expect(result.log).toContain("git push origin main");
  });

  it("classifies a SKIP that is followed by cleanup output", () => {
    const fixture = makeReleaseFixture({
      contractOutput: [
        "[contract] SKIP: refusing production cmux socket /x.sock",
        "[contract] cleanup warning reading daemon pid receipt: EACCES",
      ].join("\n"),
    });
    const result = runScript(fixture, "release.sh", ["0.4.1", "--yes"]);

    expect(result.status).toBe(0);
    const receipt = readReceipt(fixture, "0.4.1");
    expect(receipt.gates.contract).toBe("skip");
    expect(receipt.gates.contract_reason).toContain("production cmux socket");
  });

  it("warns and records — never aborts — on an unrecognised zero-exit lane", () => {
    const fixture = makeReleaseFixture({
      contractOutput: "some unrecognised runner chatter",
    });
    const result = runScript(fixture, "release.sh", ["0.4.1", "--yes"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("WARNING");
    expect(readReceipt(fixture, "0.4.1").gates.contract).toBe("unknown");
    expect(result.log).toContain("git push origin main");
  });

  it("still aborts when the contract lane exits non-zero", () => {
    const fixture = makeReleaseFixture({
      contractOutput: "[contract] FAIL: doctor --json unhealthy",
    });
    const result = runScript(fixture, "release.sh", ["0.4.1", "--yes"], {
      STUB_CONTRACT_EXIT: "1",
    });

    expect(result.status).not.toBe(0);
    expect(result.log).not.toContain("git push origin main");
  });

  it("refuses an unrecognised lane under --require-contract", () => {
    const fixture = makeReleaseFixture({ contractOutput: "chatter only" });
    const result = runScript(fixture, "release.sh", [
      "0.4.1",
      "--yes",
      "--require-contract",
    ]);

    expect(result.status).not.toBe(0);
    expect(result.log).not.toContain("git push origin main");
  });

  it("never claims a dry-run in the banner when the receipt could not be written", () => {
    const fixture = makeReleaseFixture({ withNode: false });
    const result = runScript(fixture, "release.sh", ["0.4.1", "--yes"]);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("dry-run");
    expect(result.stdout).toContain("receipt unavailable");
  });

  it("refuses to release on a skipped contract gate under --require-contract", () => {
    const fixture = makeReleaseFixture({
      contractOutput: "[contract] SKIP: no live cmux socket",
    });
    const result = runScript(fixture, "release.sh", [
      "0.4.1",
      "--yes",
      "--require-contract",
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("contract");
    expect(result.log).not.toContain("git push origin main");
  });

  it("syncs the tap clone Homebrew actually reads and records the receipt", () => {
    const fixture = makeReleaseFixture();
    const result = runScript(fixture, "release.sh", ["0.4.1", "--yes"]);

    expect(result.status).toBe(0);
    expect(result.log).toContain(`git -C ${fixture.brewTapClone} fetch origin`);
    expect(result.log).toContain(
      `git -C ${fixture.brewTapClone} reset --hard origin/main`,
    );

    const receipt = readReceipt(fixture, "0.4.1");
    expect(receipt.tap.clone_path).toBe(fixture.brewTapClone);
    expect(receipt.tap.clone_sync).toBe("synced");
    expect(receipt.tap.clone_after).toBe("1".repeat(40));
    expect(receipt.tap.pushed).toBe(true);
  });

  it("records a skipped tap-clone sync when Homebrew's clone is absent", () => {
    const fixture = makeReleaseFixture({ withBrewTapClone: false });
    const result = runScript(fixture, "release.sh", ["0.4.1", "--yes"]);

    expect(result.status).toBe(0);
    const receipt = readReceipt(fixture, "0.4.1");
    expect(receipt.tap.clone_sync).toBe("skipped");
    expect(receipt.tap.clone_reason).toBeTruthy();
  });

  it("writes no receipt in --dry-run", () => {
    const fixture = makeReleaseFixture();
    const result = runScript(fixture, "release.sh", ["0.4.1", "--dry-run"]);

    expect(result.status).toBe(0);
    expect(existsSync(join(fixture.receiptsDir, "release-0.4.1.json"))).toBe(
      false,
    );
  });
});

describe("release-verify.sh", { timeout: 30_000 }, () => {
  it("verify-only never upgrades and never resets Homebrew's tap clone", () => {
    const fixture = makeReleaseFixture({ installedVersion: "0.4.1" });
    const result = runScript(fixture, "release-verify.sh", [
      "0.4.1",
      "--verify-only",
    ]);

    expect(result.status).toBe(0);
    expect(result.log).not.toContain("brew upgrade");
    expect(result.log).not.toContain("reset --hard");
    expect(result.log).toContain("brew list --versions cmuxlayer");
  });

  it("accepts --no-upgrade as the ledger-10.5 alias for verify-only", () => {
    const fixture = makeReleaseFixture({ installedVersion: "0.4.1" });
    const result = runScript(fixture, "release-verify.sh", [
      "0.4.1",
      "--no-upgrade",
    ]);

    expect(result.status).toBe(0);
    expect(result.log).not.toContain("brew upgrade");
  });

  it("records per-Mac install evidence into the release receipt", () => {
    const fixture = makeReleaseFixture({ installedVersion: "0.4.1" });
    const result = runScript(fixture, "release-verify.sh", [
      "0.4.1",
      "--verify-only",
    ]);

    expect(result.status).toBe(0);
    const receipt = readReceipt(fixture, "0.4.1");
    expect(receipt.verify.result).toBe("pass");
    expect(receipt.verify.mode).toBe("verify-only");
    expect(receipt.installs).toHaveLength(1);
    expect(receipt.installs[0]).toMatchObject({
      host: "test-mac",
      result: "pass",
      installed: "cmuxlayer 0.4.1",
      mode: "verify-only",
    });
    expect(receipt.verify.reconnect_sweep).toBe("ran");
    expect(result.stdout).toContain(
      "agents with NO cmuxlayer child",
    );
  });

  it("still upgrades in the default mode", () => {
    const fixture = makeReleaseFixture({ installedVersion: "0.4.1" });
    const result = runScript(fixture, "release-verify.sh", ["0.4.1"]);

    expect(result.status).toBe(0);
    expect(result.log).toContain("brew upgrade etanhey/layers/cmuxlayer");
    expect(result.log).toContain("reset --hard origin/main");
    const receipt = readReceipt(fixture, "0.4.1");
    expect(receipt.installs[0].mode).toBe("upgrade");
  });

  it("records failing install evidence when the wrong version is installed", () => {
    const fixture = makeReleaseFixture({ installedVersion: "0.4.0" });
    const result = runScript(fixture, "release-verify.sh", [
      "0.4.1",
      "--verify-only",
    ]);

    expect(result.status).not.toBe(0);
    const receipt = readReceipt(fixture, "0.4.1");
    expect(receipt.verify.result).toBe("fail");
    expect(receipt.installs[0]).toMatchObject({
      result: "fail",
      installed: "cmuxlayer 0.4.0",
    });
  });

  it("records evidence when cmuxlayer is not installed on this Mac at all", () => {
    const fixture = makeReleaseFixture({ installedVersion: null });
    const result = runScript(fixture, "release-verify.sh", [
      "0.4.1",
      "--verify-only",
    ]);

    expect(result.status).not.toBe(0);
    const receipt = readReceipt(fixture, "0.4.1");
    expect(receipt.verify.result).toBe("fail");
    expect(receipt.installs[0]).toMatchObject({
      result: "fail",
      installed: "not installed",
    });
  });

  it("measures how far brew's clone was behind instead of asserting zero", () => {
    const fixture = makeReleaseFixture({ installedVersion: "0.4.1" });
    const result = runScript(fixture, "release-verify.sh", ["0.4.1"], {
      STUB_BEHIND: "3",
    });

    expect(result.status).toBe(0);
    // measured after the reset, so the stub's post-sync answer wins
    expect(readReceipt(fixture, "0.4.1").verify.tap_clone_behind).toBe("3");
  });
});

describe("release receipt ledger hardening", () => {
  it("refuses prototype-polluting and structural keys", () => {
    const dir = makeRoot("cmuxlayer-receipt-cli-");
    const env = { CMUXLAYER_RELEASE_RECEIPTS_DIR: dir };
    runReceipt(["init", "0.9.1"], env);

    for (const key of ["__proto__.polluted", "installs", "events", "version"]) {
      const result = runReceipt(["record", "0.9.1", key, "x"], env);
      expect(result.status, `expected ${key} to be refused`).not.toBe(0);
    }

    const receipt = JSON.parse(
      readFileSync(join(dir, "release-0.9.1.json"), "utf8"),
    );
    expect(Array.isArray(receipt.installs)).toBe(true);
    expect(receipt.version).toBe("0.9.1");
    expect(({} as any).polluted).toBeUndefined();
  });

  it("keeps a recorded value that starts with dashes", () => {
    const dir = makeRoot("cmuxlayer-receipt-cli-");
    const env = { CMUXLAYER_RELEASE_RECEIPTS_DIR: dir };
    runReceipt(["init", "0.9.1"], env);
    runReceipt(
      ["record", "0.9.1", "gates.contract_reason", "--require-contract said no"],
      env,
    );

    const receipt = JSON.parse(
      readFileSync(join(dir, "release-0.9.1.json"), "utf8"),
    );
    expect(receipt.gates.contract_reason).toBe("--require-contract said no");
  });
});

describe("docs/releases-and-brew.md tracks the shipped release path", () => {
  const doc = () =>
    readFileSync(join(repoRoot, "docs", "releases-and-brew.md"), "utf8");

  it("documents the receipts ledger and where it lands", () => {
    expect(doc()).toContain("release receipt");
    expect(doc()).toContain("CMUXLAYER_RELEASE_RECEIPTS_DIR");
    expect(doc()).toContain("scripts/release-receipt.mjs");
  });

  it("documents verify-only and the release-side tap-clone sync", () => {
    expect(doc()).toContain("--verify-only");
    expect(doc()).toContain("Library/Taps/etanhey/homebrew-layers");
  });

  it("tells the truth about the per-Mac ledger and how to aggregate it", () => {
    expect(doc()).toContain("per-Mac");
    expect(doc()).not.toContain("so the fleet-wide picture is one file");
    expect(doc()).toContain("shared");
  });

  it("documents the contract gate's require mode", () => {
    expect(doc()).toContain("--require-contract");
    expect(doc()).toContain("CMUX_CONTRACT_REQUIRE_LIVE");
  });
});
