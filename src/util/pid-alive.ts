import { execFile, execFileSync } from "node:child_process";
import type { AgentRecord } from "../agent-types.js";

export type ProcessLiveness = "alive" | "gone" | "unknown";

const PROCESS_START_PROBE_TIMEOUT_MS = 250;

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

/** Read the fixed process start timestamp used to distinguish PID reuse. */
export function processStartedAtMs(pid: number): number | null {
  try {
    const output = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: PROCESS_START_PROBE_TIMEOUT_MS,
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
  if (
    Math.floor(startedAtMs / 1_000) === Math.floor(registeredAtMs / 1_000)
  ) {
    // macOS `ps lstart` has only whole-second precision. A process launched
    // after registration within this same displayed second is indistinguishable
    // from the original process, so retain/refuse fail-closed rather than call
    // either identity proven.
    return "unknown";
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

export interface SessionProcess {
  pid: number;
  command: string;
}

/** Finds live processes whose argv carries a CLI session id, or `null` when unreadable. */
export type SessionProcessScanner = (
  sessionId: string,
) => Promise<SessionProcess[] | null>;

const SESSION_PROCESS_SCAN_TIMEOUT_MS = 2_000;

/**
 * #926: live processes whose argv carries `sessionId` (`claude --resume <id>`,
 * `codex resume <id>`, ...). This process is excluded. `null` means the table
 * could not be read, which is never proof of absence. Async with a timeout:
 * it runs on the resume request path and must not block the event loop.
 * Only a veto -- a live CLI may carry no id in argv at all.
 */
export const scanSessionProcesses: SessionProcessScanner = (sessionId) => {
  const needle = sessionId.trim().toLowerCase();
  if (!needle) return Promise.resolve([]);
  return new Promise((resolveScan) => {
    execFile(
      "ps",
      ["-axww", "-o", "pid=,command="],
      {
        encoding: "utf8",
        timeout: SESSION_PROCESS_SCAN_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error || typeof stdout !== "string") {
          resolveScan(null);
          return;
        }
        const carriers: SessionProcess[] = [];
        for (const line of stdout.split("\n")) {
          const match = /^\s*(\d+)\s+(.*)$/.exec(line);
          if (!match) continue;
          const pid = Number(match[1]);
          if (pid === process.pid || !match[2].toLowerCase().includes(needle)) {
            continue;
          }
          carriers.push({ pid, command: match[2] });
        }
        resolveScan(carriers);
      },
    );
  });
};
