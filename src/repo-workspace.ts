export function pathBaseName(path: string): string {
  const normalized = path.trim().replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function repoIdentityToken(input: string): string {
  const normalized = input.trim().replace(/\/+$/, "");
  if (!normalized) return "";
  const segments = normalized.split("/").filter(Boolean);
  const worktreeSegment = segments.find((segment) =>
    segment.toLowerCase().endsWith(".wt"),
  );
  if (worktreeSegment) return worktreeSegment.slice(0, -3);
  const worktreesIndex = segments.findIndex(
    (segment) => segment.toLowerCase() === ".worktrees",
  );
  if (worktreesIndex > 0) return segments[worktreesIndex - 1] ?? "";
  const baseName = pathBaseName(normalized);
  return baseName.toLowerCase().endsWith(".wt")
    ? baseName.slice(0, -3)
    : baseName;
}

function tokenMatchesRepo(token: string, repo: string): boolean {
  const normalizedRepo = repoIdentityToken(repo).toLowerCase();
  const normalizedRepoNoHyphen = normalizedRepo.replace(/-/g, "");
  const normalizedToken = repoIdentityToken(token).toLowerCase();
  return (
    normalizedToken === normalizedRepo ||
    normalizedToken.replace(/-/g, "") === normalizedRepoNoHyphen
  );
}

/**
 * True when two repo labels denote the same repo. Case- and hyphen-insensitive,
 * matching the directory-matching semantics above so "cmux-layer" and
 * "cmuxlayer" (or differing case) are treated as one repo everywhere.
 */
export function reposEquivalent(a: string, b: string): boolean {
  return tokenMatchesRepo(a, b);
}

/**
 * How strongly a workspace's current_directory belongs to `repo`:
 *   2 = exact basename match — the canonical repo root, e.g. ~/Gits/<repo>
 *   1 = a worktree of the repo. Anchored to the worktree SHAPE, not any
 *       ancestor segment:
 *         ~/Gits/<repo>.wt/<name>      (a "<repo>.wt" segment)
 *         ~/Gits/<repo>/.worktrees/x   (a "<repo>" segment immediately
 *                                       followed by a ".worktrees" marker)
 *   0 = no match
 * A bare "<repo>" segment elsewhere in the path is intentionally NOT matched,
 * so a repo whose name coincides with an ancestor directory (an org folder,
 * the username, "Gits") never routes a launch into an unrelated workspace.
 * Matching is anchored on real path boundaries (no substring/prefix test) so
 * `cmuxlayer` never matches `cmuxlayer-fork`, and the home dir is never
 * hardcoded. A higher score always wins, so a worktree workspace can never
 * shadow the repo root when both are open.
 */
export function workspaceDirectoryRepoMatchScore(
  repo: string,
  cwd: string,
): number {
  if (tokenMatchesRepo(pathBaseName(cwd), repo)) return 2;
  const segments = cwd.split("/").filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (
      segment.toLowerCase().endsWith(".wt") &&
      tokenMatchesRepo(segment.slice(0, -3), repo)
    ) {
      return 1;
    }
    if (
      tokenMatchesRepo(segment, repo) &&
      segments[i + 1]?.toLowerCase() === ".worktrees"
    ) {
      return 1;
    }
  }
  return 0;
}

export function repoNameMatchesWorkspaceDirectory(
  repo: string,
  cwd: string,
): boolean {
  return workspaceDirectoryRepoMatchScore(repo, cwd) > 0;
}

export interface FindWorkspaceForRepoOptions {
  /**
   * A workspace ref to favour among equally-good repo matches — typically the
   * parent agent's workspace, so co-working agents converge on one workspace
   * even when several same-repo workspaces are open across windows.
   */
  preferredRef?: string | null;
}

interface WorkspaceCandidate {
  ref: string;
  current_directory?: string | null;
  selected?: boolean | null;
}

function rankCandidate(
  candidate: WorkspaceCandidate,
  repo: string,
  preferredRef: string | null | undefined,
): number {
  const directory =
    typeof candidate.current_directory === "string"
      ? candidate.current_directory
      : "";
  const score = workspaceDirectoryRepoMatchScore(repo, directory);
  if (score === 0) return 0;
  // preferred ref dominates, then exact-basename over worktree-segment, then
  // the currently-selected workspace, as a fully deterministic tie-break that
  // no longer depends on cmux's workspace.list ordering (the old first-match).
  const preferred = preferredRef != null && candidate.ref === preferredRef;
  const selected = candidate.selected === true;
  return (preferred ? 1000 : 0) + score * 10 + (selected ? 1 : 0);
}

export function findWorkspaceRefForRepo(
  workspaces: Iterable<WorkspaceCandidate>,
  repo: string | null | undefined,
  opts: FindWorkspaceForRepoOptions = {},
): string | undefined {
  if (!repo) return undefined;
  let bestRef: string | undefined;
  let bestRank = 0;
  for (const workspace of workspaces) {
    const rank = rankCandidate(workspace, repo, opts.preferredRef);
    if (rank <= 0) continue;
    // Higher rank wins; among equal nonzero ranks pick the lexicographically
    // smallest ref so the choice is stable regardless of cmux's workspace.list
    // ordering. preferredRef and `selected` produce a strictly higher rank, so
    // this only decides genuine ties (e.g. two worktrees of one repo, none
    // selected, no preferred ref).
    if (
      rank > bestRank ||
      (rank === bestRank && (bestRef === undefined || workspace.ref < bestRef))
    ) {
      bestRank = rank;
      bestRef = workspace.ref;
    }
  }
  return bestRef;
}

export async function resolveWorkspaceRefForRepo(
  repo: string | null | undefined,
  listWorkspaces: () => Promise<{
    workspaces: Array<WorkspaceCandidate>;
  }>,
  opts: FindWorkspaceForRepoOptions = {},
): Promise<string | undefined> {
  if (!repo) return undefined;
  try {
    const { workspaces } = await listWorkspaces();
    return findWorkspaceRefForRepo(workspaces, repo, opts);
  } catch {
    return undefined;
  }
}
