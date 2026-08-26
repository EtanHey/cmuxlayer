import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function executable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function fixture(installedVersion: string | null = "0.4.1") {
  const root = mkdtempSync(join(tmpdir(), "cmuxlayer-release-verify-"));
  roots.push(root);
  const repo = join(root, "repo");
  const scripts = join(repo, "scripts");
  const bin = join(root, "bin");
  const brewRepo = join(root, "brew");
  const tapClone = join(brewRepo, "Library", "Taps", "etanhey", "homebrew-layers");
  const receipts = join(root, "receipts");
  const log = join(root, "stub.log");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(tapClone, ".git"), { recursive: true });

  for (const name of [
    "release-verify.sh",
    "release-receipt.mjs",
    "post-release-reconnect-sweep.sh",
  ]) {
    copyFileSync(join(repoRoot, "scripts", name), join(scripts, name));
    chmodSync(join(scripts, name), 0o755);
  }

  executable(
    join(bin, "brew"),
    `#!/usr/bin/env bash
printf 'brew %s\\n' "$*" >>"$STUB_LOG"
case "\${1:-}" in
  --repository) printf '%s\\n' "$STUB_BREW_REPO" ;;
  --prefix) exit 0 ;;
  list)
    [ -n "$STUB_INSTALLED_VERSION" ] || exit 1
    printf 'cmuxlayer %s\\n' "$STUB_INSTALLED_VERSION" ;;
esac
`,
  );
  executable(
    join(bin, "git"),
    `#!/usr/bin/env bash
printf 'git %s\\n' "$*" >>"$STUB_LOG"
if [[ " $* " = *" rev-list "* ]]; then printf '%s\\n' "\${STUB_BEHIND:-0}"; fi
`,
  );
  for (const command of ["ps", "lsof"]) {
    executable(
      join(bin, command),
      `#!/usr/bin/env bash
printf '${command} %s\\n' "$*" >>"$STUB_LOG"
exit 0
`,
    );
  }

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    STUB_LOG: log,
    STUB_BREW_REPO: brewRepo,
    STUB_INSTALLED_VERSION: installedVersion ?? "",
    CMUXLAYER_RELEASE_RECEIPTS_DIR: receipts,
    CMUXLAYER_RECEIPT_HOST: "test-mac",
  };
  return { repo, receipts, log, env };
}

function run(
  f: ReturnType<typeof fixture>,
  args: string[],
  env: NodeJS.ProcessEnv = {},
) {
  const result = spawnSync("bash", [join(f.repo, "scripts", "release-verify.sh"), ...args], {
    cwd: f.repo,
    encoding: "utf8",
    env: { ...f.env, ...env },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    log: readFileSync(f.log, "utf8"),
  };
}

function receipt(f: ReturnType<typeof fixture>) {
  return JSON.parse(readFileSync(join(f.receipts, "release-0.4.1.json"), "utf8"));
}

describe("release-verify.sh receipts", { timeout: 30_000 }, () => {
  it("verify-only never upgrades and never resets Homebrew's tap clone", () => {
    const f = fixture();
    const result = run(f, ["0.4.1", "--verify-only"]);
    expect(result.status).toBe(0);
    expect(result.log).not.toContain("brew upgrade");
    expect(result.log).not.toContain("reset --hard");
    expect(result.log).toContain("brew list --versions cmuxlayer");
  });

  it("accepts --no-upgrade as the verify-only alias", () => {
    const f = fixture();
    expect(run(f, ["0.4.1", "--no-upgrade"]).status).toBe(0);
    expect(readFileSync(f.log, "utf8")).not.toContain("brew upgrade");
  });

  it("records per-Mac install and reconnect evidence", () => {
    const f = fixture();
    const result = run(f, ["0.4.1", "--verify-only"]);
    expect(result.status).toBe(0);
    expect(receipt(f).verify).toMatchObject({
      result: "pass",
      mode: "verify-only",
      reconnect_sweep: "ran",
    });
    expect(receipt(f).installs[0]).toMatchObject({
      host: "test-mac",
      result: "pass",
      installed: "cmuxlayer 0.4.1",
      mode: "verify-only",
    });
    expect(result.stdout).toContain("agents with NO cmuxlayer child");
  });

  it("still upgrades and measures divergence in default mode", () => {
    const f = fixture();
    const result = run(f, ["0.4.1"], { STUB_BEHIND: "3" });
    expect(result.status).toBe(0);
    expect(result.log).toContain("brew upgrade etanhey/layers/cmuxlayer");
    expect(result.log).toContain("reset --hard origin/main");
    expect(receipt(f).verify.tap_clone_behind).toBe("3");
    expect(receipt(f).installs[0].mode).toBe("upgrade");
  });

  it.each([
    ["wrong version", "0.4.0", "cmuxlayer 0.4.0"],
    ["not installed", null, "not installed"],
  ])("records failing evidence when %s", (_label, installed, expected) => {
    const f = fixture(installed);
    const result = run(f, ["0.4.1", "--verify-only"]);
    expect(result.status).not.toBe(0);
    expect(receipt(f).verify.result).toBe("fail");
    expect(receipt(f).installs[0]).toMatchObject({ result: "fail", installed: expected });
  });
});
