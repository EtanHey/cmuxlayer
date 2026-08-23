export type ProcessLiveness = "alive" | "gone" | "unknown";

/**
 * Probe a recorded process without signalling it. Only ESRCH proves absence;
 * permission and platform errors are inconclusive and must fail closed for
 * resume/teardown decisions.
 */
export function processLiveness(
  pid: number | null | undefined,
): ProcessLiveness {
  if (!pid) return "gone";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ESRCH"
    ) {
      return "gone";
    }
    return "unknown";
  }
}

export function processMayBeAlive(
  pid: number | null | undefined,
): boolean {
  return Boolean(pid) && processLiveness(pid) !== "gone";
}
