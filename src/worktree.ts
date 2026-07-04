import { execFile } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { sanitizeRepoName, shellQuote } from "./agent-command.js";

const execFileAsync = promisify(execFile);

export type WorktreeExec = (
  cmd: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

export type McpProfile =
  | "inherit"
  | "sterile"
  | "skill_eval"
  | {
      include?: string[];
      exclude?: string[];
    };

export interface WorktreeRequest {
  create?: boolean;
  reuse?: boolean;
  name?: string;
  path?: string;
  branch?: string;
  base?: string;
}

export interface PrepareWorktreeInput {
  repo: string;
  repoRoot?: string;
  homeGitsDir?: string;
  worktree?: boolean | WorktreeRequest;
  exec?: WorktreeExec;
}

export interface PreparedWorktree {
  path: string;
  name: string;
  branch: string;
  base: string;
  created: boolean;
  reused: boolean;
  node_modules_linked: boolean;
  mcp_json_copied: boolean;
}

function defaultExec(cmd: string, args: string[]) {
  return execFileAsync(cmd, args);
}

function safeName(input: string): string {
  const normalized = input
    .trim()
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[-/.]+|[-/.]+$/g, "");
  if (!normalized || normalized.includes("..")) {
    throw new Error(`Invalid worktree name: "${input}"`);
  }
  return normalized;
}

function assertInside(root: string, path: string): void {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const rel = relative(resolvedRoot, resolvedPath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Worktree path ${path} must be inside ${root}`);
  }
}

function normalizeWorktreeRequest(
  repo: string,
  request: boolean | WorktreeRequest | undefined,
): Required<Pick<WorktreeRequest, "create" | "reuse" | "base">> &
  Omit<WorktreeRequest, "create" | "reuse" | "base"> & { name: string } {
  const spec: WorktreeRequest =
    request === true || request === false || request === undefined ? {} : request;
  const shortId = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  const name = safeName(spec.name ?? `${repo}-worker-${shortId}`);
  return {
    create: spec.create ?? true,
    reuse: spec.reuse ?? true,
    base: spec.base ?? "HEAD",
    name,
    ...(spec.path ? { path: spec.path } : {}),
    ...(spec.branch ? { branch: spec.branch } : {}),
  };
}

function validateMcpList(values: string[] | undefined, field: string): string[] {
  if (!values) return [];
  return values.map((value) => {
    if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
      throw new Error(`Invalid MCP ${field} entry: "${value}"`);
    }
    return value;
  });
}

export function formatMcpProfileEnv(profile?: McpProfile): string {
  if (!profile || profile === "inherit") {
    return "CMUXLAYER_MCP_PROFILE=inherit";
  }
  if (profile === "sterile" || profile === "skill_eval") {
    return `CMUXLAYER_MCP_PROFILE=${profile}`;
  }

  const include = validateMcpList(profile.include, "include");
  const exclude = validateMcpList(profile.exclude, "exclude");
  const env = ["CMUXLAYER_MCP_PROFILE=custom"];
  if (include.length > 0) {
    env.push(`CMUXLAYER_MCP_INCLUDE=${include.join(",")}`);
  }
  if (exclude.length > 0) {
    env.push(`CMUXLAYER_MCP_EXCLUDE=${exclude.join(",")}`);
  }
  return env.join(" ");
}

function linkNodeModules(repoRoot: string, worktreePath: string): boolean {
  const source = join(repoRoot, "node_modules");
  const target = join(worktreePath, "node_modules");
  if (!existsSync(source) || existsSync(target)) {
    return false;
  }
  symlinkSync(source, target, "dir");
  return true;
}

function copyMcpJson(repoRoot: string, worktreePath: string): boolean {
  const source = join(repoRoot, ".mcp.json");
  const target = join(worktreePath, ".mcp.json");
  if (!existsSync(source) || existsSync(target)) {
    return false;
  }
  copyFileSync(source, target);
  return true;
}

function parseWorktreeListPaths(stdout: string): string[] {
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

async function assertExistingWorktree(
  path: string,
  repoRoot: string,
  exec: WorktreeExec,
) {
  const result = await exec("git", [
    "-C",
    path,
    "rev-parse",
    "--is-inside-work-tree",
  ]);
  if (result.stdout.trim() !== "true") {
    throw new Error(`Existing path is not a git worktree: ${path}`);
  }
  const worktreeList = await exec("git", [
    "-C",
    repoRoot,
    "worktree",
    "list",
    "--porcelain",
  ]);
  const expectedPath = resolve(path);
  const belongsToRepo = parseWorktreeListPaths(worktreeList.stdout).some(
    (worktreePath) => resolve(worktreePath) === expectedPath,
  );
  if (!belongsToRepo) {
    throw new Error(`Existing path is not a worktree of ${repoRoot}: ${path}`);
  }
}

export async function prepareWorktree(
  input: PrepareWorktreeInput,
): Promise<PreparedWorktree> {
  const repo = sanitizeRepoName(input.repo);
  const homeGitsDir = resolve(input.homeGitsDir ?? join(homedir(), "Gits"));
  const repoRoot = resolve(input.repoRoot ?? join(homeGitsDir, repo));
  assertInside(homeGitsDir, repoRoot);

  const spec = normalizeWorktreeRequest(repo, input.worktree);
  const worktreePath = spec.path
    ? resolve(spec.path)
    : join(homeGitsDir, `${repo}.wt`, spec.name);
  assertInside(homeGitsDir, worktreePath);

  const exec = input.exec ?? defaultExec;
  if (existsSync(worktreePath)) {
    if (!spec.reuse) {
      throw new Error(`Worktree already exists: ${worktreePath}`);
    }
    const stat = lstatSync(worktreePath);
    if (!stat.isDirectory()) {
      throw new Error(`Worktree path exists but is not a directory: ${worktreePath}`);
    }
    await assertExistingWorktree(worktreePath, repoRoot, exec);
    return {
      path: worktreePath,
      name: basename(worktreePath),
      branch: spec.branch ?? `cmuxlayer/${spec.name}`,
      base: spec.base,
      created: false,
      reused: true,
      node_modules_linked: linkNodeModules(repoRoot, worktreePath),
      mcp_json_copied: copyMcpJson(repoRoot, worktreePath),
    };
  }

  if (!spec.create) {
    throw new Error(`Worktree does not exist: ${worktreePath}`);
  }

  mkdirSync(dirname(worktreePath), { recursive: true });
  const branch = spec.branch ?? `cmuxlayer/${spec.name}`;
  await exec("git", [
    "-C",
    repoRoot,
    "worktree",
    "add",
    "-b",
    branch,
    worktreePath,
    spec.base,
  ]);

  return {
    path: worktreePath,
    name: basename(worktreePath),
    branch,
    base: spec.base,
    created: true,
    reused: false,
    node_modules_linked: linkNodeModules(repoRoot, worktreePath),
    mcp_json_copied: copyMcpJson(repoRoot, worktreePath),
  };
}
