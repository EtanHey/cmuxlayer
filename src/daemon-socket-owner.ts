/**
 * Daemon socket owner receipts — the sidecar that says WHICH process owns the
 * socket path, and whether it is still that process.
 *
 * Split out of `daemon.ts` so the thin entry path can read it without pulling in
 * the whole heavy daemon/server graph (#530). `entry.ts` needs this as
 * OUT-OF-BAND evidence that a refusal came from a live owner, because a
 * spawned daemon's stderr is not guaranteed to be drained when its `exit`
 * fires.
 */
import { readFileSync } from "node:fs";
import { processLiveness, processStartedAtMs } from "./process-liveness.js";

export interface DaemonSocketOwnerReceipt {
  pid: number;
  /**
   * Process start time, so a pid recycled across a reboot cannot masquerade as
   * the original owner. Null for receipts written by an older build.
   */
  startedAtMs: number | null;
}

/** Sidecar receipt naming the process that currently owns the daemon socket. */
export function daemonSocketOwnerPath(socketPath: string): string {
  return `${socketPath}.owner`;
}

/** `<pid> <startedAtMs>` — the second field is omitted when unavailable. */
export function daemonSocketOwnerReceiptText(
  pid: number = process.pid,
): string {
  const startedAtMs = processStartedAtMs(pid);
  return startedAtMs === null ? `${pid}\n` : `${pid} ${startedAtMs}\n`;
}

export function parseDaemonSocketOwnerReceipt(
  raw: string,
): DaemonSocketOwnerReceipt | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const [pidText, startedText] = trimmed.split(/\s+/);
  const pid = Number.parseInt(pidText ?? "", 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const startedAtMs = Number.parseInt(startedText ?? "", 10);
  return {
    pid,
    startedAtMs: Number.isInteger(startedAtMs) ? startedAtMs : null,
  };
}

export function readDaemonSocketOwnerReceiptAt(
  receiptPath: string,
): DaemonSocketOwnerReceipt | null {
  try {
    return parseDaemonSocketOwnerReceipt(readFileSync(receiptPath, "utf8"));
  } catch {
    return null;
  }
}

export function readDaemonSocketOwnerReceipt(
  socketPath: string,
): DaemonSocketOwnerReceipt | null {
  return readDaemonSocketOwnerReceiptAt(daemonSocketOwnerPath(socketPath));
}

export function readDaemonSocketOwnerPid(socketPath: string): number | null {
  return readDaemonSocketOwnerReceipt(socketPath)?.pid ?? null;
}

/** `ps lstart` has whole-second precision, so allow a one-second skew. */
const OWNER_START_SKEW_MS = 1_000;

/**
 * Is the recorded owner still the SAME live process? A bare-pid receipt (older
 * build) cannot rule out pid reuse, so it is trusted only while the pid is
 * live — which keeps #529's reboot fix working: a rebooted machine's leftover
 * receipt names a pid that is either gone or demonstrably a different process.
 */
export function daemonSocketOwnerAlive(
  receipt: DaemonSocketOwnerReceipt,
): boolean {
  if (processLiveness(receipt.pid) === "gone") {
    return false;
  }
  if (receipt.startedAtMs !== null) {
    const current = processStartedAtMs(receipt.pid);
    if (
      current !== null &&
      Math.abs(current - receipt.startedAtMs) > OWNER_START_SKEW_MS
    ) {
      // The pid is live, but it is a DIFFERENT process wearing a recycled pid.
      return false;
    }
  }
  return true;
}

/** Does a LIVE owner currently claim this socket path? */
export function daemonSocketHasLiveOwner(socketPath: string): boolean {
  const receipt = readDaemonSocketOwnerReceipt(socketPath);
  return receipt !== null && daemonSocketOwnerAlive(receipt);
}
