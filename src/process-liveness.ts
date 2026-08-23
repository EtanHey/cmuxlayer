import { execFileSync } from "node:child_process";
import type { AgentRecord } from "./agent-types.js";

export type ProcessLiveness = "alive" | "gone" | "unknown";

const PROCESS_START_SKEW_MS = 5_000;

type AgentProcessRecord = Pick<
  AgentRecord,
  "pid" | "created_at" | "pid_registered_at"
>;

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

/** Read the fixed process start timestamp used to distinguish PID reuse. */
export function processStartedAtMs(pid: number): number | null {
  try {
    const output = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!output) return null;
    const parsed = Date.parse(output);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Qualify a live numeric PID against the launch-to-registration window that
 * production persisted. A process outside that window is a recycled PID, so
 * the recorded agent process is gone even though the number is live again.
 */
export function qualifyAgentProcessLiveness(
  agent: AgentProcessRecord,
  observed: ProcessLiveness,
  startedAtMs: number | null,
): ProcessLiveness {
  if (observed !== "alive") return observed;
  const createdAtMs = Date.parse(agent.created_at);
  const registeredAtMs = Date.parse(agent.pid_registered_at ?? "");
  if (
    !Number.isFinite(createdAtMs) ||
    !Number.isFinite(registeredAtMs) ||
    startedAtMs === null
  ) {
    return "unknown";
  }
  if (
    startedAtMs < createdAtMs - PROCESS_START_SKEW_MS ||
    startedAtMs > registeredAtMs
  ) {
    return "gone";
  }
  return "alive";
}

export function agentProcessLiveness(
  agent: AgentProcessRecord,
): ProcessLiveness {
  const observed = processLiveness(agent.pid);
  if (observed !== "alive" || !agent.pid) return observed;
  return qualifyAgentProcessLiveness(
    agent,
    observed,
    processStartedAtMs(agent.pid),
  );
}

export function agentProcessMayBeAlive(agent: AgentProcessRecord): boolean {
  return Boolean(agent.pid) && agentProcessLiveness(agent) !== "gone";
}
