import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  formatMcpProfileEnv,
  prepareWorktree,
} from "../src/worktree.js";

const TEST_ROOT = join(tmpdir(), "cmuxlayer-worktree-test");

describe("worktree helpers", () => {
  beforeEach(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
    mkdirSync(TEST_ROOT, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
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
      path: join(TEST_ROOT, "cmuxlayer.wt", "skill-eval"),
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
      join(TEST_ROOT, "cmuxlayer.wt", "skill-eval"),
      "origin/main",
    ]);
  });

  it("reuses an existing worktree when reuse is enabled", async () => {
    const repoRoot = join(TEST_ROOT, "repo");
    const worktreePath = join(TEST_ROOT, "cmuxlayer.wt", "existing");
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(worktreePath, { recursive: true });
    const exec = vi.fn().mockResolvedValue({ stdout: "true\n", stderr: "" });

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

  it("symlinks node_modules from the main checkout when present", async () => {
    const repoRoot = join(TEST_ROOT, "repo");
    mkdirSync(join(repoRoot, "node_modules"), { recursive: true });
    const exec = vi.fn().mockImplementation(async () => {
      const worktreePath = join(TEST_ROOT, "cmuxlayer.wt", "deps");
      mkdirSync(worktreePath, { recursive: true });
      return { stdout: "", stderr: "" };
    });

    const result = await prepareWorktree({
      repo: "cmuxlayer",
      repoRoot,
      homeGitsDir: TEST_ROOT,
      worktree: { name: "deps" },
      exec,
    });

    expect(result.node_modules_linked).toBe(true);
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

  it("resolves the repo root from the workspace cwd via git top-level", async () => {
    const repoRoot = join(TEST_ROOT, "dev", "esalon-admin");
    mkdirSync(repoRoot, { recursive: true });
    const exec = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes("--show-toplevel")) {
        return { stdout: `${repoRoot}\n`, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const result = await prepareWorktree({
      repo: "esalon-admin",
      workspaceCwd: join(repoRoot, "src"),
      worktree: { name: "feature" },
      exec,
    });

    expect(result.path).toBe(join(TEST_ROOT, "dev", "esalon-admin.wt", "feature"));
    expect(result.created).toBe(true);
    expect(exec).toHaveBeenCalledWith("git", [
      "-C",
      join(repoRoot, "src"),
      "rev-parse",
      "--show-toplevel",
    ]);
    expect(exec).toHaveBeenCalledWith("git", [
      "-C",
      repoRoot,
      "worktree",
      "add",
      "-b",
      "cmuxlayer/feature",
      join(TEST_ROOT, "dev", "esalon-admin.wt", "feature"),
      "HEAD",
    ]);
  });

  it("resolves the repo root from a configured search root outside ~/Gits", async () => {
    const root = join(TEST_ROOT, "code");
    const repoRoot = join(root, "myrepo");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

    const result = await prepareWorktree({
      repo: "myrepo",
      repoRoots: [join(TEST_ROOT, "does-not-exist"), root],
      worktree: { name: "x" },
      exec,
    });

    expect(result.path).toBe(join(root, "myrepo.wt", "x"));
    expect(exec).toHaveBeenCalledWith("git", [
      "-C",
      repoRoot,
      "worktree",
      "add",
      "-b",
      "cmuxlayer/x",
      join(root, "myrepo.wt", "x"),
      "HEAD",
    ]);
  });

  it("honors an explicit repoRoot and places the worktree beside it", async () => {
    const repoRoot = join(TEST_ROOT, "anywhere", "proj");
    mkdirSync(repoRoot, { recursive: true });
    const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

    const result = await prepareWorktree({
      repo: "proj",
      repoRoot,
      worktree: { name: "w" },
      exec,
    });

    expect(result.path).toBe(join(TEST_ROOT, "anywhere", "proj.wt", "w"));
  });

  it("falls back to repoRoots when the workspace cwd is not a git work tree", async () => {
    const root = join(TEST_ROOT, "roots");
    const repoRoot = join(root, "fallrepo");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    const exec = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes("--show-toplevel")) {
        throw new Error("fatal: not a work tree");
      }
      return { stdout: "", stderr: "" };
    });

    const result = await prepareWorktree({
      repo: "fallrepo",
      workspaceCwd: "/tmp/not-a-repo",
      repoRoots: [root],
      worktree: { name: "x" },
      exec,
    });

    expect(result.path).toBe(join(root, "fallrepo.wt", "x"));
  });

  it("throws an actionable error when the repo cannot be resolved", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    await expect(
      prepareWorktree({
        repo: "ghost",
        repoRoots: [join(TEST_ROOT, "empty")],
        worktree: { name: "x" },
        exec,
      }),
    ).rejects.toThrow(/Could not resolve a git repository/);
  });

  it("formats MCP profile env hints without raw config passing", () => {
    expect(formatMcpProfileEnv(undefined)).toBe(
      "CMUXLAYER_MCP_PROFILE=inherit",
    );
    expect(formatMcpProfileEnv("sterile")).toBe(
      "CMUXLAYER_MCP_PROFILE=sterile",
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
