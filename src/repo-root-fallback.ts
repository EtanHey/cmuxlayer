import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { sanitizeRepoName } from "./shell-safe.js";
import { normalizeRepoKey } from "./launcher-registry.js";

/**
 * Where a repo lives when there is NO repoGolem launcher registry.
 *
 * AIDEV-NOTE: AGENTS.md law — "someone installing this fresh has none of my
 * skills or launchers". The registry is an optional enhancement, so spawn and
 * resume must still resolve a working directory from the `repo` param alone.
 * The search is deterministic and fully enumerable so a miss can explain
 * itself instead of silently launching in the wrong tree.
 */
export const REPO_HOME_ENV = "CMUXLAYER_REPO_HOME";

export interface RepoRootFallbackOptions {
  /** Working directory of the running cmuxlayer process. */
  cwd?: string;
  homeDir?: string;
  env?: Record<string, string | undefined>;
  /** Injected for tests; defaults to a real filesystem directory probe. */
  isDirectory?: (path: string) => boolean;
  /** Extra context (e.g. why the registry did not answer) for the miss error. */
  registryHint?: string;
}

function isRealDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The first configured checkout root, or null when none is set. Used by the
 * few places that need a *default* directory for a repo (a kiro `cd`, a
 * transcript probe) rather than a resolved one — so those defaults follow the
 * machine's configuration before falling back to a historical path.
 */
export function firstRepoHomeRoot(
  env: Record<string, string | undefined> = process.env,
): string | null {
  return envRoots(env)[0] ?? null;
}

/**
 * A default checkout path for `repo`: `<first configured root>/<repo>` when
 * `CMUXLAYER_REPO_HOME` is set, else the historical `~/Gits/<repo>`. This is a
 * guess, not a resolution — callers that must not launch in the wrong tree use
 * `resolveRepoRootWithoutRegistry`, which errors instead of guessing.
 */
export function defaultRepoCheckoutPath(
  repo: string,
  options?: { env?: Record<string, string | undefined>; homeDir?: string },
): string {
  const safeRepo = sanitizeRepoName(repo);
  const root = firstRepoHomeRoot(options?.env ?? process.env);
  if (root) return join(root, safeRepo);
  return join(options?.homeDir ?? homedir(), "Gits", safeRepo);
}

function envRoots(env: Record<string, string | undefined>): string[] {
  return (env[REPO_HOME_ENV] ?? "")
    .split(":")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && isAbsolute(part));
}

/**
 * The full, ordered candidate list for `repo` — highest confidence first:
 *   1. every absolute root in `CMUXLAYER_REPO_HOME` (colon separated)
 *   2. the running checkout itself, when its basename IS the repo
 *   3. a sibling of the running checkout
 *   4. `~/Gits/<repo>` (the historical default this repo was built against)
 *   5. `~/<repo>`
 * Exported so the miss error can print exactly what was searched.
 */
export function repoRootSearchCandidates(
  repo: string,
  options?: RepoRootFallbackOptions,
): string[] {
  const safeRepo = sanitizeRepoName(repo);
  const cwd = options?.cwd ?? process.cwd();
  const home = options?.homeDir ?? homedir();
  const env = options?.env ?? process.env;

  const candidates = [
    ...envRoots(env).map((root) => join(root, safeRepo)),
    // The running checkout only counts when it IS this repo; otherwise the
    // sibling form below is the right guess.
    ...(normalizeRepoKey(basename(cwd)) === normalizeRepoKey(safeRepo)
      ? [cwd]
      : [join(dirname(cwd), safeRepo)]),
    join(home, "Gits", safeRepo),
    join(home, safeRepo),
  ];
  return [...new Set(candidates)];
}

/**
 * Resolve a launch/resume cwd for `repo` without consulting the launcher
 * registry. Throws a self-answering error naming every path it searched.
 */
export function resolveRepoRootWithoutRegistry(
  repo: string,
  options?: RepoRootFallbackOptions,
): string {
  const candidates = repoRootSearchCandidates(repo, options);
  const isDirectory = options?.isDirectory ?? isRealDirectory;
  const hit = candidates.find((candidate) => isDirectory(candidate));
  if (hit) return hit;

  const hint = options?.registryHint ? `${options.registryHint} ` : "";
  throw new Error(
    `Cannot resolve a working directory for repo "${repo}". ${hint}` +
      `Searched: ${candidates.join(", ")}. ` +
      `Set ${REPO_HOME_ENV} to a colon-separated list of directories that ` +
      `contain your checkouts, or pass an explicit cwd.`,
  );
}
