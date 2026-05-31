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
