import { execFile } from "node:child_process";
import {
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

// cmux validates the launch `-w` value (the worktree path cmuxLayer passes) as a
// worktree name and rejects anything longer than this.
const MAX_WORKTREE_ARG_LENGTH = 64;

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
  /** Explicit source repo checkout to create the worktree from (overrides resolution). */
  repoRoot?: string;
}

export interface PrepareWorktreeInput {
  repo: string;
  /** Explicit source repo root. Highest priority; overrides all resolution. */
  repoRoot?: string;
  /**
   * Legacy/explicit base directory. When set, repos and worktrees are anchored
   * under it exactly as before (used by embedders and tests).
   */
  homeGitsDir?: string;
  /**
   * Ordered directories to search for `<root>/<repo>` when no explicit root and
   * no workspace cwd resolves. Defaults to [`~/Gits`] for backward compatibility.
   * `~` is expanded.
   */
  repoRoots?: string[];
  /**
   * The target workspace's current directory. If it is inside a git work tree,
   * its top-level (`git rev-parse --show-toplevel`) is the authoritative repo
   * root — this is preferred over `repoRoots`.
   */
  workspaceCwd?: string;
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

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function isGitRepo(dir: string): boolean {
  // A normal clone has a `.git` directory; a linked worktree has a `.git` file.
  return existsSync(join(dir, ".git"));
}

/**
 * Resolve the source repo root and the base directory worktrees live under.
 * Precedence:
 *   1. explicit `homeGitsDir` (legacy/embedder/test) — exact prior behavior.
 *   2. explicit `repoRoot` — worktrees placed beside it.
 *   3. `workspaceCwd` git top-level — authoritative (the repo the user is in).
 *   4. configurable `repoRoots` search (default `~/Gits`).
 *   5. otherwise throw with an actionable message.
 */
async function resolveRepoRoot(
  input: PrepareWorktreeInput,
  repo: string,
  exec: WorktreeExec,
): Promise<{ repoRoot: string; worktreeBase: string }> {
  if (input.homeGitsDir !== undefined) {
    const homeGitsDir = resolve(input.homeGitsDir);
    const repoRoot = resolve(input.repoRoot ?? join(homeGitsDir, repo));
    assertInside(homeGitsDir, repoRoot);
    return { repoRoot, worktreeBase: homeGitsDir };
  }

  if (input.repoRoot !== undefined) {
    const repoRoot = resolve(input.repoRoot);
    return { repoRoot, worktreeBase: dirname(repoRoot) };
  }

  if (input.workspaceCwd) {
    try {
      const { stdout } = await exec("git", [
        "-C",
        input.workspaceCwd,
        "rev-parse",
        "--show-toplevel",
      ]);
      const top = stdout.trim();
      if (top) {
        const repoRoot = resolve(top);
        return { repoRoot, worktreeBase: dirname(repoRoot) };
      }
    } catch {
      // Not a git work tree (or git unavailable) — fall back to search roots.
    }
  }

  const roots = (
    input.repoRoots && input.repoRoots.length > 0
      ? input.repoRoots
      : [join(homedir(), "Gits")]
  ).map((root) => resolve(expandHome(root)));
  for (const root of roots) {
    const candidate = join(root, repo);
    if (isGitRepo(candidate)) {
      return { repoRoot: candidate, worktreeBase: root };
    }
  }

  throw new Error(
    `Could not resolve a git repository for "${repo}". ` +
      (input.workspaceCwd
        ? `Workspace directory "${input.workspaceCwd}" is not inside a git work tree, and `
        : "") +
      `none of the configured repo roots [${roots.join(", ")}] contain it. ` +
      `Pass worktree.repoRoot, set CMUXLAYER_WORKTREE_REPO_ROOTS, or spawn into the repo's workspace.`,
  );
}

function normalizeWorktreeRequest(
  repo: string,
  request: boolean | WorktreeRequest | undefined,
): Required<Pick<WorktreeRequest, "create" | "reuse" | "base">> &
  Omit<WorktreeRequest, "create" | "reuse" | "base"> & { name: string } {
  const spec: WorktreeRequest =
    request === true || request === false || request === undefined ? {} : request;
  // Default name is intentionally compact: no redundant `<repo>-` prefix (the
  // worktree already lives under `<repo>.wt/`) and a base36 timestamp instead of
  // 13 decimal digits. This keeps the full worktree path — which cmux validates
  // as the `-w` worktree-name argument (≤ 64 chars) — well within budget.
  const name = safeName(spec.name ?? `worker-${Date.now().toString(36)}`);
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

async function assertExistingWorktree(path: string, exec: WorktreeExec) {
  const result = await exec("git", [
    "-C",
    path,
    "rev-parse",
    "--is-inside-work-tree",
  ]);
  if (result.stdout.trim() !== "true") {
    throw new Error(`Existing path is not a git worktree: ${path}`);
  }
}

export async function prepareWorktree(
  input: PrepareWorktreeInput,
): Promise<PreparedWorktree> {
  const repo = sanitizeRepoName(input.repo);
  const exec = input.exec ?? defaultExec;
  const { repoRoot, worktreeBase } = await resolveRepoRoot(input, repo, exec);

  const spec = normalizeWorktreeRequest(repo, input.worktree);
  const worktreePath = spec.path
    ? resolve(spec.path)
    : join(worktreeBase, `${repo}.wt`, spec.name);
  assertInside(worktreeBase, worktreePath);

  // The worktree path becomes cmux's `-w` argument, which it caps at
  // MAX_WORKTREE_ARG_LENGTH. cmuxLayer picks the location in production (homeGitsDir
  // unset via workspace/repoRoots resolution), so fail clearly here instead of at
  // launch. The legacy homeGitsDir branch (embedders/tests) opts out of the cap.
  if (
    input.homeGitsDir === undefined &&
    worktreePath.length > MAX_WORKTREE_ARG_LENGTH
  ) {
    const prefixLen = worktreePath.length - spec.name.length;
    throw new Error(
      `Worktree path is ${worktreePath.length} characters but cmux limits the launch ` +
        `worktree argument (-w) to ${MAX_WORKTREE_ARG_LENGTH}: ${worktreePath}. ` +
        (spec.path
          ? `Choose a shorter worktree.path.`
          : `Use a shorter worktree name (current "${spec.name}" = ${spec.name.length} chars; ` +
            `budget for this location is ${Math.max(0, MAX_WORKTREE_ARG_LENGTH - prefixLen)}).`),
    );
  }

  if (existsSync(worktreePath)) {
    if (!spec.reuse) {
      throw new Error(`Worktree already exists: ${worktreePath}`);
    }
    const stat = lstatSync(worktreePath);
    if (!stat.isDirectory()) {
      throw new Error(`Worktree path exists but is not a directory: ${worktreePath}`);
    }
    await assertExistingWorktree(worktreePath, exec);
    return {
      path: worktreePath,
      name: basename(worktreePath),
      branch: spec.branch ?? `cmuxlayer/${spec.name}`,
      base: spec.base,
      created: false,
      reused: true,
      node_modules_linked: linkNodeModules(repoRoot, worktreePath),
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
  };
}
