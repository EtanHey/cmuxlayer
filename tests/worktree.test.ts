import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
    expect(first.path).toBe(join(TEST_ROOT, "cmuxlayer.wt", first.name));
    expect(second.path).toBe(join(TEST_ROOT, "cmuxlayer.wt", second.name));
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

  it("copies .mcp.json byte-for-byte into a newly created worktree", async () => {
    const repoRoot = join(TEST_ROOT, "repo");
    const worktreePath = join(TEST_ROOT, "cmuxlayer.wt", "with-mcp");
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

  it("copies .mcp.json when reusing an existing worktree", async () => {
    const repoRoot = join(TEST_ROOT, "repo");
    const worktreePath = join(TEST_ROOT, "cmuxlayer.wt", "existing-mcp");
    const mcpConfig = '{\n  "mcpServers": {\n    "brainlayer": {}\n  }\n}\n';
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(repoRoot, ".mcp.json"), mcpConfig);
    const exec = vi.fn().mockResolvedValue({ stdout: "true\n", stderr: "" });

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
    const exec = vi.fn().mockResolvedValue({ stdout: "true\n", stderr: "" });

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
