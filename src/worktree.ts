import { execFile } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { sanitizeRepoName, shellQuote } from "./agent-command.js";

const execFileAsync = promisify(execFile);
const DEFAULT_WORKTREE_BRANCH_PREFIX = "wt";

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
  worktree?: boolean | string | WorktreeRequest;
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

function defaultWorkerName(repo: string): string {
  const shortId = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  return safeName(`${repo}-worker-${shortId}`);
}

function defaultWorktreeBranch(name: string): string {
  return `${DEFAULT_WORKTREE_BRANCH_PREFIX}/${name}`;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return !rel.startsWith("..") && !isAbsolute(rel);
}

function assertAllowedWorktreePath(
  repoRoot: string,
  homeGitsDir: string,
  path: string,
): void {
  if (
    isInside(repoRoot, path) ||
    (isInside(homeGitsDir, repoRoot) && isInside(homeGitsDir, path))
  ) {
    return;
  }
  throw new Error(
    `Worktree path ${path} must be inside ${repoRoot} or ${homeGitsDir}`,
  );
}

function normalizeWorktreeRequest(
  repo: string,
  request: boolean | string | WorktreeRequest | undefined,
): Required<Pick<WorktreeRequest, "create" | "reuse" | "base">> &
  Omit<WorktreeRequest, "create" | "reuse" | "base"> & {
    generatedName: boolean;
    name: string;
  } {
  const spec: WorktreeRequest =
    typeof request === "string"
      ? { name: request }
      : request === true || request === false || request === undefined
        ? {}
        : request;
  const generatedName = spec.name === undefined;
  const name = generatedName ? defaultWorkerName(repo) : safeName(spec.name ?? "");
  return {
    create: spec.create ?? true,
    reuse: spec.reuse ?? true,
    base: spec.base ?? "HEAD",
    generatedName,
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
    return "";
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

async function branchExists(
  repoRoot: string,
  branch: string,
  exec: WorktreeExec,
): Promise<boolean> {
  const result = await exec("git", [
    "-C",
    repoRoot,
    "branch",
    "--list",
    branch,
  ]);
  return result.stdout.trim().length > 0;
}

function parseWorktreeListPaths(stdout: string): string[] {
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

async function warnIfWorktreesNotIgnored(repoRoot: string, exec: WorktreeExec): Promise<void> {
  try {
    await exec("git", ["-C", repoRoot, "check-ignore", "-q", "--", ".worktrees"]);
  } catch {
    console.warn(
      `[cmuxlayer] ${repoRoot} does not ignore .worktrees/; add it to .gitignore to keep generated worktrees out of commits`,
    );
  }
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
  const expectedPath = canonicalPath(path);
  const belongsToRepo = parseWorktreeListPaths(worktreeList.stdout).some(
    (worktreePath) => canonicalPath(worktreePath) === expectedPath,
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
  const exec = input.exec ?? defaultExec;

  const spec = normalizeWorktreeRequest(repo, input.worktree);
  const defaultPath = join(repoRoot, ".worktrees", spec.name);
  const legacyPath = join(homeGitsDir, `${repo}.wt`, spec.name);
  let worktreePath = spec.path
    ? resolve(spec.path)
    : defaultPath;
  if (spec.generatedName && !spec.path) {
    for (let attempts = 0; attempts < 10; attempts++) {
      const branch = spec.branch ?? defaultWorktreeBranch(spec.name);
      const pathExists = existsSync(worktreePath);
      const branchTaken = pathExists
        ? false
        : await branchExists(repoRoot, branch, exec);
      if (!pathExists && !branchTaken) {
        break;
      }
      spec.name = defaultWorkerName(repo);
      worktreePath = join(repoRoot, ".worktrees", spec.name);
    }
    const branch = spec.branch ?? defaultWorktreeBranch(spec.name);
    if (
      existsSync(worktreePath) ||
      (await branchExists(repoRoot, branch, exec))
    ) {
      throw new Error(`Unable to generate a unique worktree path for ${repo}`);
    }
  }
  assertAllowedWorktreePath(repoRoot, homeGitsDir, worktreePath);

  // Read the legacy sibling location during migration, but always create new
  // worktrees under <repo>/.worktrees. TODO remove .wt read-path after migration, ~2026-09.
  if (
    !spec.path &&
    !spec.generatedName &&
    isInside(homeGitsDir, repoRoot) &&
    !existsSync(worktreePath) &&
    spec.reuse &&
    existsSync(legacyPath)
  ) {
    worktreePath = legacyPath;
  }

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
      branch: spec.branch ?? defaultWorktreeBranch(spec.name),
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
  await warnIfWorktreesNotIgnored(repoRoot, exec);
  const branch = spec.branch ?? defaultWorktreeBranch(spec.name);
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
  const prepared: PreparedWorktree = {
    path: worktreePath,
    name: basename(worktreePath),
    branch,
    base: spec.base,
    created: true,
    reused: false,
    node_modules_linked: false,
    mcp_json_copied: false,
  };
  try {
    mkdirSync(worktreePath, { recursive: true });
    prepared.node_modules_linked = linkNodeModules(repoRoot, worktreePath);
    prepared.mcp_json_copied = copyMcpJson(repoRoot, worktreePath);
    return prepared;
  } catch (error) {
    try {
      await rollbackPreparedWorktree(repoRoot, prepared, exec);
    } catch (rollbackError) {
      const original = error instanceof Error ? error.message : String(error);
      const rollback =
        rollbackError instanceof Error
          ? rollbackError.message
          : String(rollbackError);
      throw new Error(
        `${original}. Worktree rollback also failed for ${prepared.path} (${prepared.branch}): ${rollback}`,
        { cause: error },
      );
    }
    throw error;
  }
}

export async function rollbackPreparedWorktree(
  repoRoot: string,
  prepared: PreparedWorktree,
  exec: WorktreeExec = defaultExec,
): Promise<void> {
  if (!prepared.created) return;

  const failures: string[] = [];
  try {
    await exec("git", [
      "-C",
      repoRoot,
      "worktree",
      "remove",
      "--force",
      prepared.path,
    ]);
  } catch (error) {
    failures.push(
      `worktree remove failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    await exec("git", ["-C", repoRoot, "branch", "-D", prepared.branch]);
  } catch (error) {
    failures.push(
      `branch delete failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (failures.length > 0) {
    throw new Error(
      `Cleanup required for worktree ${prepared.path} and branch ${prepared.branch}: ${failures.join("; ")}`,
    );
  }
}
