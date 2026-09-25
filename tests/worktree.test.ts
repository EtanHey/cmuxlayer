import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BOOTSTRAP_TIMEOUT_MS,
  formatMcpProfileEnv,
  prepareWorktree,
  rollbackPreparedWorktree,
  runBootstrap,
} from "../src/worktree.js";

const TEST_ROOT = join(tmpdir(), "cmuxlayer-worktree-test");

function worktreeListOutput(paths: string[]): string {
  return paths.map((path) => `worktree ${path}\n`).join("");
}

describe("worktree helpers", () => {
  beforeEach(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
    mkdirSync(TEST_ROOT, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("generates distinct parseable default worker names for the same repo", async () => {
    const repoRoot = join(TEST_ROOT, "repo");
    mkdirSync(repoRoot, { recursive: true });
    vi.spyOn(Date, "now").mockReturnValue(1783204101457);
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0.123456789)
      .mockReturnValueOnce(0.987654321);
    const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

    const first = await prepareWorktree({
      repo: "cmuxlayer",
      repoRoot,
      homeGitsDir: TEST_ROOT,
      worktree: true,
      exec,
    });
    const second = await prepareWorktree({
      repo: "cmuxlayer",
      repoRoot,
      homeGitsDir: TEST_ROOT,
      worktree: true,
      exec,
    });

    expect(first.name).toMatch(/^cmuxlayer-worker-[a-z0-9]{6}$/);
    expect(second.name).toMatch(/^cmuxlayer-worker-[a-z0-9]{6}$/);
    expect(first.name).not.toBe(second.name);
    expect(first.name).not.toContain("1783204101457");
    expect(first.path).toBe(join(repoRoot, ".worktrees", first.name));
    expect(second.path).toBe(join(repoRoot, ".worktrees", second.name));
  });

  it("retries generated default names instead of reusing a colliding worktree", async () => {
    const repoRoot = join(TEST_ROOT, "repo");
    const firstId = (0.5).toString(36).slice(2, 8).padEnd(6, "0");
    const secondId = (0.25).toString(36).slice(2, 8).padEnd(6, "0");
    const collidingName = `cmuxlayer-worker-${firstId}`;
    const nextName = `cmuxlayer-worker-${secondId}`;
    const collidingPath = join(repoRoot, ".worktrees", collidingName);
    const nextPath = join(repoRoot, ".worktrees", nextName);
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(collidingPath, { recursive: true });
    vi.spyOn(Math, "random").mockReturnValueOnce(0.5).mockReturnValueOnce(0.25);
    const exec = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes("branch") && args.includes("--list")) {
        return { stdout: "", stderr: "" };
      }
      if (args.includes("worktree") && args.includes("list")) {
        return {
          stdout: worktreeListOutput([repoRoot, collidingPath]),
          stderr: "",
        };
      }
      if (args.includes("worktree") && args.includes("add")) {
        mkdirSync(nextPath, { recursive: true });
        return { stdout: "", stderr: "" };
      }
      return { stdout: "true\n", stderr: "" };
    });

    const result = await prepareWorktree({
      repo: "cmuxlayer",
      repoRoot,
      homeGitsDir: TEST_ROOT,
      worktree: true,
      exec,
    });

    expect(result).toMatchObject({
      path: nextPath,
      name: nextName,
      created: true,
      reused: false,
    });
    expect(exec).toHaveBeenCalledWith("git", [
      "-C",
      repoRoot,
      "worktree",
      "add",
      "-b",
      `wt/${nextName}`,
      nextPath,
      "HEAD",
    ]);
  });

  it("retries generated default names when the generated branch already exists", async () => {
    const repoRoot = join(TEST_ROOT, "repo");
    const firstId = (0.5).toString(36).slice(2, 8).padEnd(6, "0");
    const secondId = (0.25).toString(36).slice(2, 8).padEnd(6, "0");
    const collidingName = `cmuxlayer-worker-${firstId}`;
    const nextName = `cmuxlayer-worker-${secondId}`;
    const collidingBranch = `wt/${collidingName}`;
    const nextPath = join(repoRoot, ".worktrees", nextName);
    mkdirSync(repoRoot, { recursive: true });
    vi.spyOn(Math, "random").mockReturnValueOnce(0.5).mockReturnValueOnce(0.25);
    const exec = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes("branch") && args.includes("--list")) {
        const branch = args.at(-1);
        return {
          stdout: branch === collidingBranch ? `  ${collidingBranch}\n` : "",
          stderr: "",
        };
      }
      if (args.includes("worktree") && args.includes("add")) {
        if (args.includes(collidingBranch)) {
          throw new Error("fatal: a branch named already exists");
        }
        mkdirSync(nextPath, { recursive: true });
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const result = await prepareWorktree({
      repo: "cmuxlayer",
      repoRoot,
      homeGitsDir: TEST_ROOT,
      worktree: true,
      exec,
    });

    expect(result).toMatchObject({
      path: nextPath,
      name: nextName,
      branch: `wt/${nextName}`,
      created: true,
      reused: false,
    });
  });

  it("creates a named git worktree with a deterministic default path", async () => {
    const repoRoot = join(TEST_ROOT, "repo");
    mkdirSync(repoRoot, { recursive: true });
    const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

    const result = await prepareWorktree({
      repo: "cmuxlayer",
      repoRoot,
      homeGitsDir: TEST_ROOT,
      worktree: {
        name: "skill eval",
        branch: "fix/skill-eval",
        base: "origin/main",
      },
      exec,
    });

    expect(result).toMatchObject({
      path: join(repoRoot, ".worktrees", "skill-eval"),
      branch: "fix/skill-eval",
      base: "origin/main",
      created: true,
      reused: false,
    });
    expect(exec).toHaveBeenCalledWith("git", [
      "-C",
      repoRoot,
      "worktree",
      "add",
      "-b",
      "fix/skill-eval",
      join(repoRoot, ".worktrees", "skill-eval"),
      "origin/main",
    ]);
  });

  it("accepts a worktree name string as shorthand for a named request", async () => {
    const repoRoot = join(TEST_ROOT, "repo");
    mkdirSync(repoRoot, { recursive: true });
    const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

    const result = await prepareWorktree({
      repo: "cmuxlayer",
      repoRoot,
      homeGitsDir: TEST_ROOT,
      worktree: "tool usage",
      exec,
    });

    expect(result).toMatchObject({
      path: join(repoRoot, ".worktrees", "tool-usage"),
      name: "tool-usage",
      branch: "wt/tool-usage",
    });
  });

  it("rejects an empty explicit worktree name", async () => {
    await expect(
      prepareWorktree({
        repo: "cmuxlayer",
        repoRoot: join(TEST_ROOT, "repo"),
        homeGitsDir: TEST_ROOT,
        worktree: { name: "" },
        exec: vi.fn(),
      }),
    ).rejects.toThrow(/Invalid worktree name/);
  });

  it("reuses an existing worktree when reuse is enabled", async () => {
    const repoRoot = join(TEST_ROOT, "repo");
    const worktreePath = join(TEST_ROOT, "cmuxlayer.wt", "existing");
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(worktreePath, { recursive: true });
    const exec = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes("worktree") && args.includes("list")) {
        return {
          stdout: worktreeListOutput([repoRoot, worktreePath]),
          stderr: "",
        };
      }
      return { stdout: "true\n", stderr: "" };
    });

    const result = await prepareWorktree({
      repo: "cmuxlayer",
      repoRoot,
      homeGitsDir: TEST_ROOT,
      worktree: { name: "existing", reuse: true },
      exec,
    });

    expect(result).toMatchObject({
      path: worktreePath,
      created: false,
      reused: true,
    });
    expect(exec).toHaveBeenCalledWith("git", [
      "-C",
      worktreePath,
      "rev-parse",
      "--is-inside-work-tree",
    ]);
    expect(exec).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["worktree", "add"]),
    );
  });

  it("reuses a legacy sibling worktree during the migration window", async () => {
    const repoRoot = join(TEST_ROOT, "repo");
    const legacyPath = join(TEST_ROOT, "cmuxlayer.wt", "legacy");
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(legacyPath, { recursive: true });
    const exec = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes("worktree") && args.includes("list")) {
        return { stdout: worktreeListOutput([repoRoot, legacyPath]), stderr: "" };
      }
      return { stdout: "true\n", stderr: "" };
    });

    const result = await prepareWorktree({
      repo: "cmuxlayer",
      repoRoot,
      homeGitsDir: TEST_ROOT,
      worktree: { name: "legacy", reuse: true },
      exec,
    });

    expect(result).toMatchObject({ path: legacyPath, reused: true, created: false });
    expect(exec).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["worktree", "add"]),
    );
  });

  it("warns when the target repo does not ignore the in-repo worktree directory", async () => {
    const repoRoot = join(TEST_ROOT, "repo");
    const worktreePath = join(repoRoot, ".worktrees", "unignored");
    mkdirSync(repoRoot, { recursive: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const exec = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes("check-ignore")) throw new Error("not ignored");
      if (args.includes("worktree") && args.includes("add")) {
        mkdirSync(worktreePath, { recursive: true });
      }
      return { stdout: "", stderr: "" };
    });

    await prepareWorktree({
      repo: "cmuxlayer",
      repoRoot,
      homeGitsDir: TEST_ROOT,
      worktree: { name: "unignored" },
      exec,
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("does not ignore .worktrees/"));
  });

  it("reuses a repo worktree when git reports canonical paths through a symlink", async () => {
    const actualGitsDir = join(TEST_ROOT, "actual-gits");
    const linkedGitsDir = join(TEST_ROOT, "linked-gits");
    const repoRoot = join(linkedGitsDir, "repo");
    const worktreePath = join(linkedGitsDir, "cmuxlayer.wt", "linked");
    const actualRepoRoot = join(actualGitsDir, "repo");
    const actualWorktreePath = join(actualGitsDir, "cmuxlayer.wt", "linked");
    mkdirSync(actualRepoRoot, { recursive: true });
    mkdirSync(actualWorktreePath, { recursive: true });
    symlinkSync(actualGitsDir, linkedGitsDir, "dir");
    const exec = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes("worktree") && args.includes("list")) {
        return {
          stdout: worktreeListOutput([actualRepoRoot, actualWorktreePath]),
          stderr: "",
        };
      }
      return { stdout: "true\n", stderr: "" };
    });

    const result = await prepareWorktree({
      repo: "cmuxlayer",
      repoRoot,
      homeGitsDir: linkedGitsDir,
      worktree: { name: "linked", reuse: true },
      exec,
    });

    expect(result).toMatchObject({
      path: worktreePath,
      created: false,
      reused: true,
    });
  });

  describe("node_modules bootstrap (#807)", () => {
    const createdWorktree = (repoRoot: string, name: string) =>
      vi.fn().mockImplementation(async () => {
        mkdirSync(join(repoRoot, ".worktrees", name), { recursive: true });
        return { stdout: "", stderr: "" };
      });

    it("runs the bootstrap script with the worktree path when it exists", async () => {
      const repoRoot = join(TEST_ROOT, "repo");
      const script = join(TEST_ROOT, "worktree-bootstrap.sh");
      mkdirSync(TEST_ROOT, { recursive: true });
      writeFileSync(script, "#!/bin/sh\n", { mode: 0o755 });
      const bootstrapExec = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

      const result = await prepareWorktree({
        repo: "cmuxlayer",
        repoRoot,
        homeGitsDir: TEST_ROOT,
        worktree: { name: "deps-script" },
        exec: createdWorktree(repoRoot, "deps-script"),
        bootstrapScript: script,
        bootstrapExec,
      });

      expect(bootstrapExec).toHaveBeenCalledWith(script, [result.path]);
      expect(result.node_modules_bootstrapped).toBe("script");
    });

    it("falls back to a frozen bun install when there is no script but a bun lockfile", async () => {
      const repoRoot = join(TEST_ROOT, "repo");
      const exec = vi.fn().mockImplementation(async () => {
        const path = join(repoRoot, ".worktrees", "deps-inline");
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, "bun.lock"), "{}\n");
        return { stdout: "", stderr: "" };
      });
      const bootstrapExec = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

      const result = await prepareWorktree({
        repo: "cmuxlayer",
        repoRoot,
        homeGitsDir: TEST_ROOT,
        worktree: { name: "deps-inline" },
        exec,
        bootstrapScript: null,
        bootstrapExec,
      });

      expect(bootstrapExec).toHaveBeenCalledWith("bun", [
        "install",
        "--frozen-lockfile",
        "--cwd",
        result.path,
      ]);
      expect(result.node_modules_bootstrapped).toBe("inline");
    });

    it("skips when there is neither a script nor a bun lockfile, and never symlinks", async () => {
      const repoRoot = join(TEST_ROOT, "repo");
      mkdirSync(join(repoRoot, "node_modules"), { recursive: true });
      const bootstrapExec = vi.fn();

      const result = await prepareWorktree({
        repo: "cmuxlayer",
        repoRoot,
        homeGitsDir: TEST_ROOT,
        worktree: { name: "deps-none" },
        exec: createdWorktree(repoRoot, "deps-none"),
        bootstrapScript: null,
        bootstrapExec,
      });

      expect(bootstrapExec).not.toHaveBeenCalled();
      expect(result.node_modules_bootstrapped).toBe("skipped");
      expect(existsSync(join(result.path, "node_modules"))).toBe(false);
      expect(result).not.toHaveProperty("node_modules_linked");
      expect(result).not.toHaveProperty("node_modules_bootstrap_reason");
    });

    it.each([
      ["missing", false],
      ["not executable", true],
    ])("skips a configured script that is %s with reason script_missing, even with a bun lockfile", async (_label, create) => {
      const repoRoot = join(TEST_ROOT, "repo");
      const script = join(TEST_ROOT, "worktree-bootstrap.sh");
      if (create) writeFileSync(script, "#!/bin/sh\n", { mode: 0o644 });
      const exec = vi.fn().mockImplementation(async () => {
        const path = join(repoRoot, ".worktrees", "deps-script-missing");
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, "bun.lock"), "{}\n");
        return { stdout: "", stderr: "" };
      });
      const bootstrapExec = vi.fn();

      const result = await prepareWorktree({
        repo: "cmuxlayer",
        repoRoot,
        homeGitsDir: TEST_ROOT,
        worktree: { name: "deps-script-missing" },
        exec,
        bootstrapScript: script,
        bootstrapExec,
      });

      expect(bootstrapExec).not.toHaveBeenCalled();
      expect(result.node_modules_bootstrapped).toBe("skipped");
      expect(result.node_modules_bootstrap_reason).toBe("script_missing");
    });

    it("runs no script by default: without a fleet worktreeBootstrap only the bun lockfile path applies", async () => {
      const repoRoot = join(TEST_ROOT, "repo");
      const exec = vi.fn().mockImplementation(async () => {
        const path = join(repoRoot, ".worktrees", "deps-default");
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, "bun.lock"), "{}\n");
        return { stdout: "", stderr: "" };
      });
      const bootstrapExec = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

      // No bootstrapScript: the (test-pinned, empty) fleet config supplies none.
      const result = await prepareWorktree({
        repo: "cmuxlayer",
        repoRoot,
        homeGitsDir: TEST_ROOT,
        worktree: { name: "deps-default" },
        exec,
        bootstrapExec,
      });

      expect(bootstrapExec).toHaveBeenCalledTimes(1);
      expect(bootstrapExec.mock.calls[0]?.[0]).toBe("bun");
      expect(result.node_modules_bootstrapped).toBe("inline");
    });

    it("reports a failed bootstrap and keeps the worktree (fail-soft)", async () => {
      const repoRoot = join(TEST_ROOT, "repo");
      const script = join(TEST_ROOT, "worktree-bootstrap.sh");
      mkdirSync(TEST_ROOT, { recursive: true });
      writeFileSync(script, "#!/bin/sh\n", { mode: 0o755 });
      const exec = createdWorktree(repoRoot, "deps-failed");
      const bootstrapExec = vi.fn().mockRejectedValue(new Error("frozen lockfile mismatch"));

      const result = await prepareWorktree({
        repo: "cmuxlayer",
        repoRoot,
        homeGitsDir: TEST_ROOT,
        worktree: { name: "deps-failed" },
        exec,
        bootstrapScript: script,
        bootstrapExec,
      });

      expect(result.node_modules_bootstrapped).toBe("failed");
      expect(result.node_modules_bootstrap_error).toContain("frozen lockfile mismatch");
      expect(existsSync(result.path)).toBe(true);
      expect(exec).not.toHaveBeenCalledWith("git", expect.arrayContaining(["remove"]));
    });

    it.each([
      ["script", "script", false],
      ["inline", null, true],
      ["skipped", null, false],
    ] as const)("unlinks a stale node_modules symlink (not its target) on reuse before the %s path", async (outcome, scriptName, bunLock) => {
      const repoRoot = join(TEST_ROOT, "repo");
      const sibling = join(repoRoot, "node_modules");
      mkdirSync(join(sibling, "keep-me"), { recursive: true });
      const worktreePath = join(repoRoot, ".worktrees", "deps-reuse");
      mkdirSync(worktreePath, { recursive: true });
      if (bunLock) writeFileSync(join(worktreePath, "bun.lock"), "{}\n");
      const link = join(worktreePath, "node_modules");
      symlinkSync(sibling, link, "dir");
      let script: string | null = null;
      if (scriptName) {
        script = join(TEST_ROOT, "worktree-bootstrap.sh");
        writeFileSync(script, "#!/bin/sh\n", { mode: 0o755 });
      }
      const exec = vi.fn().mockImplementation(async (_cmd: string, args: string[]) =>
        args.includes("list")
          ? { stdout: worktreeListOutput([repoRoot, worktreePath]), stderr: "" }
          : { stdout: "true\n", stderr: "" });
      // The link must already be gone when the install runs: an install
      // through it would write into the sibling's node_modules.
      const linkAtInstall: boolean[] = [];
      const bootstrapExec = vi.fn().mockImplementation(async () => {
        linkAtInstall.push(lstatSync(link, { throwIfNoEntry: false }) !== undefined);
        return { stdout: "", stderr: "" };
      });

      const result = await prepareWorktree({
        repo: "cmuxlayer",
        repoRoot,
        homeGitsDir: TEST_ROOT,
        worktree: { name: "deps-reuse", reuse: true },
        exec,
        bootstrapScript: script,
        bootstrapExec,
      });

      expect(result.node_modules_bootstrapped).toBe(outcome);
      expect(linkAtInstall).toEqual(outcome === "skipped" ? [] : [false]);
      expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();
      expect(existsSync(join(sibling, "keep-me"))).toBe(true);
    });
    it("reports failed instead of throwing when the stale link cannot be unlinked", async () => {
      const repoRoot = join(TEST_ROOT, "repo");
      const sibling = join(repoRoot, "node_modules");
      mkdirSync(join(sibling, "keep-me"), { recursive: true });
      const worktreePath = join(repoRoot, ".worktrees", "deps-readonly");
      mkdirSync(worktreePath, { recursive: true });
      writeFileSync(join(worktreePath, "bun.lock"), "{}\n");
      const link = join(worktreePath, "node_modules");
      symlinkSync(sibling, link, "dir");
      const exec = vi.fn().mockImplementation(async (_cmd: string, args: string[]) =>
        args.includes("list")
          ? { stdout: worktreeListOutput([repoRoot, worktreePath]), stderr: "" }
          : { stdout: "true\n", stderr: "" });
      const bootstrapExec = vi.fn();
      // A read-only checkout: the link's directory refuses the unlink (EACCES).
      chmodSync(worktreePath, 0o555);
      try {
        const result = await prepareWorktree({
          repo: "cmuxlayer",
          repoRoot,
          homeGitsDir: TEST_ROOT,
          worktree: { name: "deps-readonly", reuse: true },
          exec,
          bootstrapScript: null,
          bootstrapExec,
        });

        expect(result.node_modules_bootstrapped).toBe("failed");
        expect(result.node_modules_bootstrap_error).toMatch(/EACCES|EPERM/);
        expect(bootstrapExec).not.toHaveBeenCalled();
        expect(existsSync(join(sibling, "keep-me"))).toBe(true);
      } finally {
        chmodSync(worktreePath, 0o755);
      }
    });
  });

  describe("runBootstrap (#807)", () => {
    it("is bounded at 180 s", () => {
      expect(BOOTSTRAP_TIMEOUT_MS).toBe(180_000);
    });

    it("kills the whole process group on timeout, not just the script", async () => {
      const pidFile = join(TEST_ROOT, "grandchild.pid");
      // /bin/sh -c, not a freshly written script: macOS can take >500 ms to
      // scan a new executable on first exec, and a kill landing before the
      // pid is written made this test flake (w40, #857).
      await expect(
        runBootstrap(
          "/bin/sh",
          ["-c", `sleep 30 & echo $! > "${pidFile}"; wait`],
          2_000,
        ),
      ).rejects.toThrow("timed out after 2000 ms");

      const grandchild = Number(readFileSync(pidFile, "utf8").trim());
      expect(grandchild).toBeGreaterThan(0);
      const alive = () => {
        try {
          process.kill(grandchild, 0);
          return true;
        } catch {
          return false;
        }
      };
      await vi.waitFor(() => expect(alive()).toBe(false), { timeout: 2_000 });
    }, 10_000);

    it("rejects with the exit code and stderr when the command fails", async () => {
      const script = join(TEST_ROOT, "failing-bootstrap.sh");
      writeFileSync(script, "#!/bin/sh\necho lockfile mismatch >&2\nexit 3\n", {
        mode: 0o755,
      });

      await expect(runBootstrap(script, [], 5_000)).rejects.toThrow(
        /exited with code 3: lockfile mismatch/,
      );
    });

    it("resolves with stdout when the command succeeds", async () => {
      await expect(runBootstrap("/bin/echo", ["ok"], 5_000)).resolves.toMatchObject({
        stdout: "ok\n",
      });
    });
  });

  it("copies .mcp.json byte-for-byte into a newly created worktree", async () => {
    const repoRoot = join(TEST_ROOT, "repo");
    const worktreePath = join(repoRoot, ".worktrees", "with-mcp");
    const mcpConfig = '{\n  "mcpServers": {\n    "cmuxlayer": {}\n  }\n}\n';
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(join(repoRoot, ".mcp.json"), mcpConfig);
    const exec = vi.fn().mockImplementation(async () => {
      mkdirSync(worktreePath, { recursive: true });
      return { stdout: "", stderr: "" };
    });

    const result = await prepareWorktree({
      repo: "cmuxlayer",
      repoRoot,
      homeGitsDir: TEST_ROOT,
      worktree: { name: "with-mcp" },
      exec,
    });

    expect(result.mcp_json_copied).toBe(true);
    expect(readFileSync(join(worktreePath, ".mcp.json"), "utf8")).toBe(
      mcpConfig,
    );
  });

  it("rolls back a newly created worktree when post-add setup fails", async () => {
    const repoRoot = join(TEST_ROOT, "repo");
    const worktreePath = join(repoRoot, ".worktrees", "setup-failure");
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(join(repoRoot, ".mcp.json"));
    const exec = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes("worktree") && args.includes("add")) {
        mkdirSync(worktreePath, { recursive: true });
      }
      if (args.includes("worktree") && args.includes("remove")) {
        rmSync(worktreePath, { recursive: true, force: true });
      }
      return { stdout: "", stderr: "" };
    });

    await expect(
      prepareWorktree({
        repo: "cmuxlayer",
        repoRoot,
        homeGitsDir: TEST_ROOT,
        worktree: {
          name: "setup-failure",
          branch: "wt/setup-failure",
        },
        exec,
      }),
    ).rejects.toThrow();

    expect(exec).toHaveBeenCalledWith("git", [
      "-C",
      repoRoot,
      "worktree",
      "remove",
      "--force",
      worktreePath,
    ]);
    expect(exec).toHaveBeenCalledWith("git", [
      "-C",
      repoRoot,
      "branch",
      "-D",
      "wt/setup-failure",
    ]);
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("never rolls back a reused worktree", async () => {
    const exec = vi.fn();

    await rollbackPreparedWorktree(
      join(TEST_ROOT, "repo"),
      {
        path: join(TEST_ROOT, "repo", ".worktrees", "existing"),
        name: "existing",
        branch: "wt/existing",
        base: "HEAD",
        created: false,
        reused: true,
        node_modules_bootstrapped: "skipped",
        mcp_json_copied: false,
      },
      exec,
    );

    expect(exec).not.toHaveBeenCalled();
  });

  it("copies .mcp.json when reusing an existing worktree", async () => {
    const repoRoot = join(TEST_ROOT, "repo");
    const worktreePath = join(TEST_ROOT, "cmuxlayer.wt", "existing-mcp");
    const mcpConfig = '{\n  "mcpServers": {\n    "brainlayer": {}\n  }\n}\n';
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(repoRoot, ".mcp.json"), mcpConfig);
    const exec = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes("worktree") && args.includes("list")) {
        return {
          stdout: worktreeListOutput([repoRoot, worktreePath]),
          stderr: "",
        };
      }
      return { stdout: "true\n", stderr: "" };
    });

    const result = await prepareWorktree({
      repo: "cmuxlayer",
      repoRoot,
      homeGitsDir: TEST_ROOT,
      worktree: { name: "existing-mcp", reuse: true },
      exec,
    });

    expect(result.mcp_json_copied).toBe(true);
    expect(readFileSync(join(worktreePath, ".mcp.json"), "utf8")).toBe(
      mcpConfig,
    );
  });

  it("does not overwrite an existing worktree .mcp.json", async () => {
    const repoRoot = join(TEST_ROOT, "repo");
    const worktreePath = join(TEST_ROOT, "cmuxlayer.wt", "keeps-mcp");
    const sourceConfig = '{"mcpServers":{"cmuxlayer":{}}}\n';
    const existingConfig = '{"mcpServers":{"local":{}}}\n';
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(repoRoot, ".mcp.json"), sourceConfig);
    writeFileSync(join(worktreePath, ".mcp.json"), existingConfig);
    const exec = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes("worktree") && args.includes("list")) {
        return {
          stdout: worktreeListOutput([repoRoot, worktreePath]),
          stderr: "",
        };
      }
      return { stdout: "true\n", stderr: "" };
    });

    const result = await prepareWorktree({
      repo: "cmuxlayer",
      repoRoot,
      homeGitsDir: TEST_ROOT,
      worktree: { name: "keeps-mcp", reuse: true },
      exec,
    });

    expect(result.mcp_json_copied).toBe(false);
    expect(readFileSync(join(worktreePath, ".mcp.json"), "utf8")).toBe(
      existingConfig,
    );
  });

  it("rejects reuse when an existing git worktree does not belong to the repo root", async () => {
    const repoRoot = join(TEST_ROOT, "repo");
    const worktreePath = join(TEST_ROOT, "other.wt", "foreign");
    const foreignRepoRoot = join(TEST_ROOT, "foreign-repo");
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(repoRoot, ".mcp.json"), '{"mcpServers":{"cmux":{}}}\n');
    const exec = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes("worktree") && args.includes("list")) {
        return {
          stdout: worktreeListOutput([repoRoot, foreignRepoRoot]),
          stderr: "",
        };
      }
      return { stdout: "true\n", stderr: "" };
    });

    await expect(
      prepareWorktree({
        repo: "cmuxlayer",
        repoRoot,
        homeGitsDir: TEST_ROOT,
        worktree: { path: worktreePath, reuse: true },
        exec,
      }),
    ).rejects.toThrow(/not a worktree of/);

    expect(existsSync(join(worktreePath, ".mcp.json"))).toBe(false);
  });

  it("skips .mcp.json copy when the source file is missing", async () => {
    const repoRoot = join(TEST_ROOT, "repo");
    const worktreePath = join(TEST_ROOT, "cmuxlayer.wt", "missing-mcp");
    mkdirSync(repoRoot, { recursive: true });
    const exec = vi.fn().mockImplementation(async () => {
      mkdirSync(worktreePath, { recursive: true });
      return { stdout: "", stderr: "" };
    });

    const result = await prepareWorktree({
      repo: "cmuxlayer",
      repoRoot,
      homeGitsDir: TEST_ROOT,
      worktree: { name: "missing-mcp" },
      exec,
    });

    expect(result.mcp_json_copied).toBe(false);
    expect(existsSync(join(worktreePath, ".mcp.json"))).toBe(false);
  });

  it("rejects a path outside the allowed Gits root", async () => {
    await expect(
      prepareWorktree({
        repo: "cmuxlayer",
        repoRoot: join(TEST_ROOT, "repo"),
        homeGitsDir: TEST_ROOT,
        worktree: { path: "/tmp/outside" },
        exec: vi.fn(),
      }),
    ).rejects.toThrow(/must be inside/);
  });

  it("formats MCP profile env hints without raw config passing", () => {
    expect(formatMcpProfileEnv(undefined)).toBe("");
    expect(formatMcpProfileEnv("inherit")).toBe("");
    expect(formatMcpProfileEnv("sterile")).toBe(
      "CMUXLAYER_MCP_PROFILE=sterile",
    );
    expect(formatMcpProfileEnv("skill_eval")).toBe(
      "CMUXLAYER_MCP_PROFILE=skill_eval",
    );
    expect(
      formatMcpProfileEnv({
        include: ["cmux", "brainlayer"],
        exclude: ["exa"],
      }),
    ).toBe(
      "CMUXLAYER_MCP_PROFILE=custom CMUXLAYER_MCP_INCLUDE=cmux,brainlayer CMUXLAYER_MCP_EXCLUDE=exa",
    );
  });
});
