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
