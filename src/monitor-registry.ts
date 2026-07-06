// Monitor registry — the minimal cross-agent deadman core (LANE-MONITOR-REGISTRY-CORE).
//
// WHY THIS EXISTS: a lead's collab-monitor (or its whole session) dying silently is
// the fleet's monitor-death class. Detecting that CANNOT live in the owner's own
// process — a per-agent stdio MCP dies WITH the owner and can never observe its own
// death. So this is ONE canonical shared JSON file (`~/.golems-zikaron/
// monitor-registry.json`) that ANY live agent's agent-engine sweep scans: a monitor
// whose `last_signal_at` lapsed past its `deadman_timeout_s` is flipped to
// `deadman-fired` by whichever live agent gets there first (idempotent, first-to-fire
// wins) and a wake is emitted on the notify path. This survives the owner's own death,
// which is the whole point. The launchd caffeinate guard (docs/sleep-survival.md) is
// the always-on backstop that keeps SOME agent sweeping across sleep.
//
// WHY ONE JSON FILE (not a per-monitor append dir): the deadman sweep must read ALL
// monitors and mutate state (alive → deadman-fired) in place; a single JSON document
// is the simplest shared cross-agent state and mirrors the outbox drainer's sidecar
// pattern already living in `~/.golems-zikaron/`. Writes are low-frequency (arm /
// signal / one flip per death), so a whole-file rewrite is fine. Cross-process
// exactly-once is best-effort (a rare read-before-write race between two sweeping
// agents could double-emit one wake) — matching the outbox drainer's documented stance.
//
// FAIL-CLOSED-ON-ATTRIBUTION (skillcreatorLead, BINDING): a record whose `owner_seat`
// is missing or "unknown" is an INVALID flag for its lane — surfaced as invalid, and
// NEVER a deadman-fire/reap target. The sweeper acts only on records with a resolvable
// owner_seat. This clears the fleet-wrap false-positive lesson: no ownerless inference.
//
// NO NETWORK IN TESTS: the wake transport (`deliver`) defaults to a NO-OP. Only the
// real MCP entrypoints inject `httpDeliver` (reused from the outbox drainer), so the
// suite — and any caller that forgets to wire a transport — never posts to 127.0.0.1:3847.
// A real-default once fired ~20 live notifications during `bun run test`; do not regress.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { httpDeliver, type NotifyPayload } from "./outbox-drainer.js";

export type { NotifyPayload };

/** How the watcher observes its targets (gate #10 shape metadata rides the reset). */
export type MonitorMechanism = "event" | "offset-poll";

/**
 * Monitor lifecycle:
 * - `alive`         — last_signal_at within deadman_timeout_s.
 * - `deadman-fired` — the timeout lapsed with no signal; a wake was emitted.
 * - `dead`          — intentionally deregistered (a stop, not a death).
 */
export type MonitorState = "alive" | "deadman-fired" | "dead";

export interface MonitorRecord {
  monitor_id: string;
  /** null / "unknown" ⇒ INVALID (fail-closed): surfaced, never fired/reaped. */
  owner_seat: string | null;
  watch_targets: string[];
  mechanism: MonitorMechanism;
  /** REQUIRED, positive. No default-none — every monitor carries a deadman. */
  deadman_timeout_s: number;
  armed_at: string; // ISO
  last_signal_at: string; // ISO — last event received OR last completed poll cycle.
  state: MonitorState;
}

export interface RegisterMonitorInput {
  monitor_id: string;
  owner_seat: string | null;
  watch_targets?: string[];
  mechanism: MonitorMechanism;
  deadman_timeout_s: number;
}

export interface MonitorRegistryOptions {
  /** Path to the shared registry file. Defaults to the canonical zikaron path. */
  registryPath?: string;
  /** Clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Notify listener URL. Defaults to `http://127.0.0.1:3847/notify`. */
  notifyUrl?: string;
  /**
   * Wake transport. Returns true on success. Defaults to a NO-OP so tests never
   * hit the network; the real MCP entrypoints inject `httpDeliver`.
   */
  deliver?: (payload: NotifyPayload, url: string) => Promise<boolean>;
}

export interface MonitorSweepResult {
  /** Monitors flipped alive → deadman-fired on THIS sweep. */
  fired: MonitorRecord[];
  /** Records skipped because their owner_seat is missing/unknown (fail-closed). */
  invalid: MonitorRecord[];
  /** Monitors still alive after the sweep. */
  alive: MonitorRecord[];
  /** Total records scanned. */
  total: number;
}

export interface LeadMonitorStatus {
  /** A resolvable-seat monitor owned by the seat is fired (or lapsed as of now). */
  firedNow: boolean;
  /** Earliest ms timestamp an alive monitor for the seat will lapse, else null. */
  dueAtMs: number | null;
}

interface RegistryFile {
  version: number;
  monitors: MonitorRecord[];
}

const DEFAULT_NOTIFY_URL = "http://127.0.0.1:3847/notify";
const REGISTRY_VERSION = 1;
const WAKE_SOURCE = "cmuxlayer-monitor-registry";
const WAKE_PRIORITY = "high";

export function defaultMonitorRegistryPath(): string {
  return join(homedir(), ".golems-zikaron", "monitor-registry.json");
}

/** Default transport: emit nothing. Prevents any accidental network I/O. */
const noopDeliver: NonNullable<MonitorRegistryOptions["deliver"]> = async () =>
  false;

/**
 * A resolvable owner_seat is a non-empty, non-"unknown" string. Everything else
 * (null, undefined, whitespace, the literal "unknown") is unattributed and
 * fail-closed: never a deadman-fire/reap target.
 */
function isResolvableSeat(seat: string | null | undefined): seat is string {
  if (typeof seat !== "string") return false;
  const trimmed = seat.trim();
  return trimmed.length > 0 && trimmed.toLowerCase() !== "unknown";
}

function loadRegistry(registryPath: string): RegistryFile {
  if (!existsSync(registryPath)) {
    return { version: REGISTRY_VERSION, monitors: [] };
  }
  try {
    const parsed = JSON.parse(
      readFileSync(registryPath, "utf8"),
    ) as Partial<RegistryFile>;
    const monitors = Array.isArray(parsed.monitors) ? parsed.monitors : [];
    return { version: REGISTRY_VERSION, monitors };
  } catch {
    // Corrupt registry: treat as empty rather than crash. Worst case is a lost
    // arm (re-armed next cycle), which is safer than throwing and wedging every
    // sweeping agent.
    return { version: REGISTRY_VERSION, monitors: [] };
  }
}

function saveRegistry(registryPath: string, file: RegistryFile): void {
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, `${JSON.stringify(file, null, 2)}\n`);
}

function resolvePath(opts: MonitorRegistryOptions): string {
  return opts.registryPath ?? defaultMonitorRegistryPath();
}

function resolveNow(opts: MonitorRegistryOptions): number {
  return (opts.now ?? Date.now)();
}

/** Whether an alive record has lapsed past its deadman as of `nowMs`. */
function isLapsed(record: MonitorRecord, nowMs: number): boolean {
  const last = Date.parse(record.last_signal_at);
  if (Number.isNaN(last)) return false;
  return nowMs - last > record.deadman_timeout_s * 1000;
}

/** Read all monitor records. Never creates the file. */
export function readMonitorRegistry(
  opts: MonitorRegistryOptions = {},
): MonitorRecord[] {
  return loadRegistry(resolvePath(opts)).monitors;
}

/**
 * Register (arm) a monitor. `deadman_timeout_s` is REQUIRED and must be a
 * positive number — a monitor with no deadman is exactly the shape gate #10
 * fails, so we refuse to persist one. Re-registering an existing monitor_id
 * re-arms it (state → alive, timers reset to now).
 */
export function registerMonitor(
  input: RegisterMonitorInput,
  opts: MonitorRegistryOptions = {},
): MonitorRecord {
  if (
    typeof input.deadman_timeout_s !== "number" ||
    !Number.isFinite(input.deadman_timeout_s) ||
    input.deadman_timeout_s <= 0
  ) {
    throw new Error(
      `monitor ${input.monitor_id}: deadman_timeout_s is REQUIRED and must be a positive number (got ${String(input.deadman_timeout_s)})`,
    );
  }

  const registryPath = resolvePath(opts);
  const nowIso = new Date(resolveNow(opts)).toISOString();
  const file = loadRegistry(registryPath);

  const record: MonitorRecord = {
    monitor_id: input.monitor_id,
    owner_seat: input.owner_seat,
    watch_targets: input.watch_targets ?? [],
    mechanism: input.mechanism,
    deadman_timeout_s: input.deadman_timeout_s,
    armed_at: nowIso,
    last_signal_at: nowIso,
    state: "alive",
  };

  const existingIndex = file.monitors.findIndex(
    (m) => m.monitor_id === input.monitor_id,
  );
  if (existingIndex >= 0) {
    file.monitors[existingIndex] = record;
  } else {
    file.monitors.push(record);
  }
  saveRegistry(registryPath, file);
  return record;
}

/** Deregister (intentional stop): mark the monitor `dead` so no sweep fires it. */
export function deregisterMonitor(
  monitorId: string,
  opts: MonitorRegistryOptions = {},
): void {
  const registryPath = resolvePath(opts);
  const file = loadRegistry(registryPath);
  const record = file.monitors.find((m) => m.monitor_id === monitorId);
  if (!record) return;
  record.state = "dead";
  saveRegistry(registryPath, file);
}

/**
 * Signal liveness: bump `last_signal_at`. A signal on a `deadman-fired` monitor
 * is a recovery — it re-arms back to `alive` (this is what re-arms #237's lead
 * monitor-death alert on recovery). Returns the updated record, or null if the
 * monitor_id is unknown.
 */
export function signalMonitor(
  monitorId: string,
  opts: MonitorRegistryOptions = {},
): MonitorRecord | null {
  const registryPath = resolvePath(opts);
  const file = loadRegistry(registryPath);
  const record = file.monitors.find((m) => m.monitor_id === monitorId);
  if (!record) return null;
  record.last_signal_at = new Date(resolveNow(opts)).toISOString();
  if (record.state !== "dead") {
    record.state = "alive";
  }
  saveRegistry(registryPath, file);
  return record;
}

function buildWakePayload(record: MonitorRecord): NotifyPayload {
  const targets =
    record.watch_targets.length > 0
      ? record.watch_targets.join(", ")
      : "(no targets)";
  return {
    title: "Monitor deadman fired",
    body: `Monitor ${record.monitor_id} (owner ${record.owner_seat ?? "?"}) lapsed: no signal within ${record.deadman_timeout_s}s while watching ${targets}. Owner may be watch-blind.`,
    source: WAKE_SOURCE,
    priority: WAKE_PRIORITY,
  };
}

/**
 * Cross-agent deadman sweep. ANY live agent runs this over the shared registry:
 * every ALIVE record with a RESOLVABLE owner_seat that has lapsed past its
 * deadman is flipped to `deadman-fired` (persisted before the wake so it is
 * idempotent and first-to-fire wins) and a wake is emitted on the notify path.
 * Records with a missing/unknown owner_seat are surfaced as `invalid` and NEVER
 * fired (fail-closed-on-attribution).
 */
export async function sweepMonitorRegistry(
  opts: MonitorRegistryOptions = {},
): Promise<MonitorSweepResult> {
  const registryPath = resolvePath(opts);
  const nowMs = resolveNow(opts);
  const notifyUrl = opts.notifyUrl ?? DEFAULT_NOTIFY_URL;
  const deliver = opts.deliver ?? noopDeliver;

  const file = loadRegistry(registryPath);
  const result: MonitorSweepResult = {
    fired: [],
    invalid: [],
    alive: [],
    total: file.monitors.length,
  };

  let mutated = false;
  const newlyFired: MonitorRecord[] = [];

  for (const record of file.monitors) {
    if (!isResolvableSeat(record.owner_seat)) {
      // Fail-closed: unattributed record. Surface it, but never fire/reap it.
      result.invalid.push(record);
      continue;
    }
    if (record.state === "dead" || record.state === "deadman-fired") {
      // Already terminal for this sweep — never re-fire (first-to-fire wins).
      continue;
    }
    if (isLapsed(record, nowMs)) {
      record.state = "deadman-fired";
      mutated = true;
      result.fired.push(record);
      newlyFired.push(record);
    } else {
      result.alive.push(record);
    }
  }

  // Persist the flip BEFORE emitting so a second sweeping agent sees
  // `deadman-fired` and does not re-fire, even if delivery is slow/fails.
  if (mutated) {
    saveRegistry(registryPath, file);
  }

  for (const record of newlyFired) {
    try {
      await deliver(buildWakePayload(record), notifyUrl);
    } catch {
      // Wake delivery is best-effort; the persisted flip is the source of truth.
    }
  }

  return result;
}

/**
 * #237 consumption helper: liveness of the lead monitor(s) owned by `seat`.
 * Fail-closed — an unresolvable seat is never reported fired.
 * - `firedNow`: any resolvable-seat monitor for this seat is `deadman-fired`, OR
 *   is `alive` but already lapsed as of now (so the alert fires without waiting
 *   for a sweep to flip the record).
 * - `dueAtMs`: the earliest ms timestamp an alive, not-yet-lapsed monitor for the
 *   seat will lapse — for scheduling the wake-on-timeout timer. null if none.
 */
export function leadMonitorStatus(
  seat: string | null | undefined,
  opts: MonitorRegistryOptions = {},
): LeadMonitorStatus {
  if (!isResolvableSeat(seat)) {
    return { firedNow: false, dueAtMs: null };
  }
  const nowMs = resolveNow(opts);
  const monitors = readMonitorRegistry(opts).filter(
    (m) => m.owner_seat === seat,
  );

  let firedNow = false;
  let dueAtMs: number | null = null;
  for (const record of monitors) {
    if (record.state === "dead") continue;
    if (record.state === "deadman-fired") {
      firedNow = true;
      continue;
    }
    // alive:
    if (isLapsed(record, nowMs)) {
      firedNow = true;
      continue;
    }
    const last = Date.parse(record.last_signal_at);
    if (!Number.isNaN(last)) {
      const due = last + record.deadman_timeout_s * 1000;
      dueAtMs = dueAtMs === null ? due : Math.min(dueAtMs, due);
    }
  }
  return { firedNow, dueAtMs };
}

/**
 * Port bound for injection into the agent-engine sweep. `sweep` runs the
 * cross-agent deadman scan; `leadStatus` answers #237's watch-blind question.
 * The engine passes its own clock as `nowMs` per call so tests control time.
 */
export interface MonitorRegistryPort {
  sweep(nowMs: number): Promise<MonitorSweepResult>;
  leadStatus(seat: string | null | undefined, nowMs: number): LeadMonitorStatus;
}

/** File-backed port. Production entrypoints inject `deliver: httpDeliver`. */
export function createFileMonitorRegistryPort(
  opts: MonitorRegistryOptions = {},
): MonitorRegistryPort {
  return {
    sweep: (nowMs) => sweepMonitorRegistry({ ...opts, now: () => nowMs }),
    leadStatus: (seat, nowMs) =>
      leadMonitorStatus(seat, { ...opts, now: () => nowMs }),
  };
}

/**
 * No-op port: the engine's default. Constructing an engine (tests, libraries)
 * must never touch the real registry file or network — production entrypoints
 * inject `createFileMonitorRegistryPort({ deliver: httpDeliver })`.
 */
export const NOOP_MONITOR_REGISTRY_PORT: MonitorRegistryPort = {
  sweep: async () => ({ fired: [], invalid: [], alive: [], total: 0 }),
  leadStatus: () => ({ firedNow: false, dueAtMs: null }),
};

/** Real wake transport (POST to the notify listener), reused from the outbox drainer. */
export { httpDeliver };
