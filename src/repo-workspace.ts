export function pathBaseName(path: string): string {
  const normalized = path.trim().replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

export function repoNameMatchesWorkspaceDirectory(
  repo: string,
  cwd: string,
): boolean {
  const normalizedRepo = repo.toLowerCase();
  const normalizedRepoNoHyphen = normalizedRepo.replace(/-/g, "");
  const directory = pathBaseName(cwd).toLowerCase();
  return (
    directory === normalizedRepo ||
    directory.replace(/-/g, "") === normalizedRepoNoHyphen
  );
}

export function findWorkspaceRefForRepo(
  workspaces: Iterable<{
    ref: string;
    current_directory?: string | null;
  }>,
  repo: string | null | undefined,
): string | undefined {
  if (!repo) return undefined;
  for (const workspace of workspaces) {
    if (
      typeof workspace.current_directory === "string" &&
      repoNameMatchesWorkspaceDirectory(repo, workspace.current_directory)
    ) {
      return workspace.ref;
    }
  }
  return undefined;
}

export async function resolveWorkspaceRefForRepo(
  repo: string | null | undefined,
  listWorkspaces: () => Promise<{
    workspaces: Array<{
      ref: string;
      current_directory?: string | null;
    }>;
  }>,
): Promise<string | undefined> {
  if (!repo) return undefined;
  try {
    const { workspaces } = await listWorkspaces();
    return findWorkspaceRefForRepo(workspaces, repo);
  } catch {
    return undefined;
  }
}
