import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..");

function packageScripts(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  return pkg.scripts;
}

describe("pre-PR script ladder", () => {
  it("keeps the default pre-pr gate deterministic and usage-free", () => {
    const scripts = packageScripts();

    expect(scripts["pre-pr"]).toContain("bun run typecheck");
    expect(scripts["pre-pr"]).toContain("bun run pre-pr:harness");
    expect(scripts["pre-pr"]).toContain("bun run bench:daemon:check:fast");
    expect(scripts["pre-pr"]).not.toContain("live:harness");
    expect(scripts["pre-pr"]).not.toContain("pre-pr:live");
  });

  it("exposes full, fast, and refresh daemon budget commands", () => {
    const scripts = packageScripts();

    expect(scripts["bench:daemon:check"]).toContain(
      "scripts/check-daemon-benchmark.mjs",
    );
    expect(scripts["bench:daemon:check:fast"]).toContain(
      "CMUXLAYER_BENCH_ROUNDS=3",
    );
    expect(scripts["bench:daemon:refresh"]).toContain(
      "scripts/refresh-daemon-baseline.mjs",
    );
  });

  it("includes the production-shaped replay coverage in the deterministic harness tier", () => {
    const scripts = packageScripts();

    expect(scripts["pre-pr:harness"]).toContain(
      "tests/live-agent-harness-replay.test.ts",
    );
  });

  it("exposes an explicit live pre-pr tier through the live harness", () => {
    const scripts = packageScripts();

    expect(scripts["pre-pr:live"]).toBe("bun run live:harness");
  });

  it("exposes the real-cmux contract lane without adding it to default tests", () => {
    const scripts = packageScripts();

    expect(scripts["test:contract"]).toBe(
      "bun run build && tsx scripts/run-real-cmux-contract.ts",
    );
    expect(scripts.test).toBe("vitest run");
    expect(scripts.test).not.toContain("contract");
  });

  it("runs the opt-in contract lane from the release preflight", () => {
    const release = readFileSync(join(repoRoot, "scripts", "release.sh"), "utf8");
    const hermeticGate = release.indexOf(
      'run "env -u CMUX_SOCKET_PATH -u CMUX_DAEMON_SOCKET bun run test"',
    );
    const contractGate = release.indexOf('bun run test:contract 2>&1 | tee');

    expect(hermeticGate).toBeGreaterThan(-1);
    expect(contractGate).toBeGreaterThan(hermeticGate);
    // The lane's outcome is classified into the receipt instead of scrolling by (#370).
    expect(release).toContain('receipt_record "gates.contract"');
    expect(release).toContain("--require-contract");
  });

  it("removes ambient cmux socket pins from the pre-push regression gate", () => {
    const hook = readFileSync(
      join(repoRoot, ".githooks", "pre-push"),
      "utf8",
    );

    expect(hook).toContain(
      "env -u CMUX_SOCKET_PATH -u CMUX_DAEMON_SOCKET bash scripts/run_tests.sh",
    );
  });

  it("syncs the brew tap clone and verifies the installed release version", () => {
    const verify = readFileSync(
      join(repoRoot, "scripts", "release-verify.sh"),
      "utf8",
    );
    const release = readFileSync(join(repoRoot, "scripts", "release.sh"), "utf8");

    expect(verify).toContain(
      'BREW_TAP_DIR="$(brew --repository)/Library/Taps/etanhey/homebrew-layers"',
    );
    expect(verify).toContain('git -C "$BREW_TAP_DIR" fetch origin');
    expect(verify).toContain('git -C "$BREW_TAP_DIR" reset --hard origin/main');
    expect(verify).toContain("brew upgrade etanhey/layers/cmuxlayer");
    expect(verify).toContain("brew list --versions cmuxlayer");
    expect(release).toContain('scripts/release-verify.sh "$VERSION"');
  });

  it("refuses the live harness unless CMUX_LIVE_HARNESS=1 is set", () => {
    const result = spawnSync(
      process.execPath,
      [join(repoRoot, "scripts", "run-live-agent-harness.mjs"), "--help"],
      {
        cwd: repoRoot,
        env: { ...process.env, CMUX_LIVE_HARNESS: "" },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CMUX_LIVE_HARNESS=1");
  });

  it("defaults the live harness to one sterile Cursor worker", () => {
    const script = readFileSync(
      join(repoRoot, "scripts", "run-live-agent-harness.mjs"),
      "utf8",
    );

    expect(script).toContain('cli: "cursor"');
    expect(script).toContain("count: 1");
    expect(script).toContain('mcpProfile: "sterile"');
    expect(script).not.toContain("count: 8");
  });

  it("keeps the hook installer explicit and transparent", () => {
    const script = readFileSync(
      join(repoRoot, "scripts", "install-hooks.mjs"),
      "utf8",
    );

    expect(script).toContain(".git");
    expect(script).toContain("pre-push");
    expect(script).toContain("exec bun run pre-pr");
  });
});

describe("release scripts run where CI runs", () => {
  // `sed -i ''` is BSD-only. GNU sed reads the '' as the script and the real
  // expression as a filename, exits 2, and takes release.sh down with it — the
  // reason every Linux run of the release-receipt tests failed while the same
  // tests passed on the maintainer's Mac.
  it("keeps release scripts free of the BSD-only in-place sed form", () => {
    for (const script of ["release.sh", "release-verify.sh"]) {
      const code = readFileSync(join(repoRoot, "scripts", script), "utf8")
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n");

      expect(code, `${script} uses BSD-only sed -i ''`).not.toMatch(
        /sed\s+-i\s+(''|"")/,
      );
    }
  });
});
