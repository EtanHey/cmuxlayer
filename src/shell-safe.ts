/**
 * Shell-safety primitives shared by command building and path resolution.
 *
 * AIDEV-NOTE: these live in their own module so `repo-root-fallback.ts` can
 * sanitize a repo name without importing `agent-command.ts`, which needs to
 * import IT back for fresh-machine path resolution. Same functions, no cycle.
 */

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function sanitizeRepoName(repo: string): string {
  const safeRepo = repo.replace(/[^a-zA-Z0-9._-]/g, "");
  if (!safeRepo || safeRepo !== repo || safeRepo === "." || safeRepo === "..") {
    throw new Error(
      `Invalid repo name: "${repo}". Only alphanumeric, dots, hyphens, and underscores allowed. "." and ".." are not permitted.`,
    );
  }
  return safeRepo;
}
