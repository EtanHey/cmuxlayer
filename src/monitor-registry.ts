import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { httpDeliver } from "./outbox-drainer.js";

export type MonitorMechanism = "event" | "offset-poll";
export type MonitorDedupe = "offset" | "seen-set" | "header-keyed";
export type MonitorState = "alive" | "firing" | "deadman-fired" | "dead";
export type MonitorRegistryGate = "gate-9" | "gate-10";
export type MonitorRegistryLiveness =
  | "alive"
  | "lapsed"
  | "firing"
  | "deadman-fired"
  | "dead"
  | "invalid";

export interface MonitorRegistryRecord {
  monitor_id: string;
  owner_seat: string;
  watch_targets: string[];
  mechanism: MonitorMechanism;
  pattern?: string;
  watermark_key?: string;
  dedupe?: MonitorDedupe;
  addressee?: string;
  deadman_timeout_s: number;
  armed_at: string;
  last_signal_at: string;
  state: MonitorState;
  firing_claimed_by_agent_id?: string;
  firing_claimed_at?: string;
}

export interface MonitorRegistryFile {
  version: 1;
  monitors: MonitorRegistryRecord[];
}

export interface RegisterMonitorInput {
  monitor_id: string;
  owner_seat: string;
  watch_targets: string[];
  mechanism: MonitorMechanism;
  pattern?: string;
  watermark_key?: string;
  dedupe?: MonitorDedupe;
  addressee?: string;
  deadman_timeout_s: number;
}

export interface MonitorRegistryOptions {
  registryPath?: string;
  now?: () => number;
}

export interface MonitorDeadmanEvent {
  monitor_id: string;
  owner_seat: string;
  watch_targets: string[];
  mechanism: MonitorMechanism;
  pattern?: string;
  watermark_key?: string;
  dedupe?: MonitorDedupe;
  addressee?: string;
  deadman_timeout_s: number;
  armed_at: string;
  last_signal_at: string;
  fired_at: string;
  fired_by_agent_id: string;
  elapsed_s: number;
}

export interface InvalidMonitorRegistryRecord {
  monitor_id: string;
  reason: string;
}

export interface MonitorRegistrySweepResult {
  fired: MonitorDeadmanEvent[];
  invalid: InvalidMonitorRegistryRecord[];
  alive: string[];
}

export type MonitorDeadmanNotify = (
  event: MonitorDeadmanEvent,
) => Promise<unknown> | unknown;

export interface MonitorRegistrySweepOptions extends MonitorRegistryOptions {
  notify?: MonitorDeadmanNotify;
  sweeperAgentId?: string;
}

export interface MonitorRegistryGateViolation {
  gate: MonitorRegistryGate;
  monitor_id: string;
  reason: string;
}

export interface MonitorRegistryGateRecord {
  monitor_id: string;
  owner_seat?: string;
  watch_targets: string[];
  mechanism?: MonitorMechanism;
  pattern?: string;
  watermark_key?: string;
  dedupe?: MonitorDedupe;
  addressee?: string;
  deadman_timeout_s?: number;
  armed_at?: string;
  last_signal_at?: string;
  state?: MonitorState;
  liveness: MonitorRegistryLiveness;
}

export interface MonitorRegistryGateQueryOptions extends MonitorRegistryOptions {
  claimedMonitorIds?: readonly string[];
}

export interface MonitorRegistryGateQuery {
  version: 1;
  queried_at: string;
  latency_ms: number;
  monitors: MonitorRegistryGateRecord[];
  violations: MonitorRegistryGateViolation[];
}

type RawMonitorRecord = Record<string, unknown>;

const STATE_VERSION = 1;
const DEFAULT_NOTIFY_URL = "http://127.0.0.1:3847/notify";
const DEFAULT_NOTIFY_SOURCE = "cmuxlayer-monitor-registry";
const DEFAULT_SWEEPER_ID = "agent-engine";

export function defaultMonitorRegistryPath(): string {
  return join(homedir(), ".golems-zikaron", "monitor-registry.json");
}

function nowIso(now?: () => number): string {
  return new Date((now ?? Date.now)()).toISOString();
}

function registryPathFor(opts?: MonitorRegistryOptions): string {
  return opts?.registryPath ?? defaultMonitorRegistryPath();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRawRegistry(path: string): {
  version: 1;
  monitors: RawMonitorRecord[];
} {
  if (!existsSync(path)) return { version: STATE_VERSION, monitors: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (Array.isArray(parsed)) {
      return {
        version: STATE_VERSION,
        monitors: parsed.filter(isObject),
      };
    }
    if (isObject(parsed) && Array.isArray(parsed.monitors)) {
      return {
        version: STATE_VERSION,
        monitors: parsed.monitors.filter(isObject),
      };
    }
  } catch {
    return { version: STATE_VERSION, monitors: [] };
  }
  return { version: STATE_VERSION, monitors: [] };
}

function writeRawRegistry(path: string, monitors: readonly unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(
    tmpPath,
    `${JSON.stringify({ version: STATE_VERSION, monitors }, null, 2)}\n`,
    "utf8",
  );
  renameSync(tmpPath, path);
}

function withRegistryWriteLock<T>(path: string, fn: () => T): T {
  const lockDir = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(lockDir);
  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isUnknownOwnerSeat(value: string | null): boolean {
  if (!value) return true;
  return /^(?:unknown|none|null|n\/a)$/i.test(value);
}

function isMechanism(value: unknown): value is MonitorMechanism {
  return value === "event" || value === "offset-poll";
}

function isDedupe(value: unknown): value is MonitorDedupe {
  return value === "offset" || value === "seen-set" || value === "header-keyed";
}

function isState(value: unknown): value is MonitorState {
  return (
    value === "alive" ||
    value === "firing" ||
    value === "deadman-fired" ||
    value === "dead"
  );
}

function parseTimeMs(value: unknown): number | null {
  const text = cleanString(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function validWatchTargets(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const targets = value.map(cleanString);
  if (targets.some((target) => target === null)) return null;
  return targets as string[];
}

function normalizeAddressee(value: unknown): string | null {
  const text = cleanString(value);
  if (!text) return null;
  return text.startsWith("@") ? cleanString(text.slice(1)) : text;
}

function deriveAddressee(record: {
  addressee?: unknown;
  pattern?: unknown;
  watch_targets?: unknown;
}): string | null {
  const explicit = normalizeAddressee(record.addressee);
  if (explicit) return explicit;

  const values: string[] = [];
  const pattern = cleanString(record.pattern);
  if (pattern) values.push(pattern);
  if (Array.isArray(record.watch_targets)) {
    for (const target of record.watch_targets) {
      const text = cleanString(target);
      if (text) values.push(text);
    }
  }

  for (const value of values) {
    const match = value.match(/@([A-Za-z0-9][A-Za-z0-9_.:-]*)/);
    if (match?.[1]) return match[1];
  }
  return null;
}

function hasTailFShape(record: RawMonitorRecord): boolean {
  const values: string[] = [];
  const pattern = cleanString(record.pattern);
  if (pattern) values.push(pattern);
  if (Array.isArray(record.watch_targets)) {
    for (const target of record.watch_targets) {
      const text = cleanString(target);
      if (text) values.push(text);
    }
  }
  return values.some((value) => /\btail\b[^\n\r]*\s-[^\s]*[fF]\b/.test(value));
}

function cleanWatermarkKey(value: unknown): string | null {
  return cleanString(value);
}

function cleanPositiveTimeout(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

function toValidRecord(record: RawMonitorRecord): MonitorRegistryRecord | null {
  const monitorId = cleanString(record.monitor_id);
  const ownerSeat = cleanString(record.owner_seat);
  const watchTargets = validWatchTargets(record.watch_targets);
  const timeout = cleanPositiveTimeout(record.deadman_timeout_s);
  const armedAt = cleanString(record.armed_at);
  const lastSignalAt = cleanString(record.last_signal_at);
  const watermarkKey = cleanWatermarkKey(record.watermark_key);
  const addressee = deriveAddressee(record);
  if (
    !monitorId ||
    !ownerSeat ||
    isUnknownOwnerSeat(ownerSeat) ||
    !watchTargets ||
    !isMechanism(record.mechanism) ||
    timeout === null ||
    !armedAt ||
    !lastSignalAt ||
    !isState(record.state)
  ) {
    return null;
  }
  return {
    monitor_id: monitorId,
    owner_seat: ownerSeat,
    watch_targets: watchTargets,
    mechanism: record.mechanism,
    ...(typeof record.pattern === "string" ? { pattern: record.pattern } : {}),
    ...(watermarkKey ? { watermark_key: watermarkKey } : {}),
    ...(isDedupe(record.dedupe) ? { dedupe: record.dedupe } : {}),
    ...(addressee ? { addressee } : {}),
    deadman_timeout_s: timeout,
    armed_at: armedAt,
    last_signal_at: lastSignalAt,
    state: record.state,
    ...(cleanString(record.firing_claimed_by_agent_id)
      ? {
          firing_claimed_by_agent_id: cleanString(
            record.firing_claimed_by_agent_id,
          )!,
        }
      : {}),
    ...(cleanString(record.firing_claimed_at)
      ? { firing_claimed_at: cleanString(record.firing_claimed_at)! }
      : {}),
  };
}

function invalidReason(record: RawMonitorRecord): string | null {
  if (!cleanString(record.monitor_id)) return "missing-monitor-id";
  if (isUnknownOwnerSeat(cleanString(record.owner_seat))) {
    return "missing-or-unknown-owner-seat";
  }
  if (!validWatchTargets(record.watch_targets)) return "invalid-watch-targets";
  if (!isMechanism(record.mechanism)) return "invalid-mechanism";
  if (cleanPositiveTimeout(record.deadman_timeout_s) === null) {
    return "invalid-deadman-timeout";
  }
  if (parseTimeMs(record.armed_at) === null) return "invalid-armed-at";
  if (parseTimeMs(record.last_signal_at) === null) {
    return "invalid-last-signal-at";
  }
  if (!isState(record.state)) return "invalid-state";
  return null;
}

function monitorIdForInvalid(record: RawMonitorRecord): string {
  return cleanString(record.monitor_id) ?? "<missing-monitor-id>";
}

function assertRegisterInput(input: RegisterMonitorInput): void {
  if (!cleanString(input.monitor_id)) throw new Error("monitor_id is required");
  if (isUnknownOwnerSeat(cleanString(input.owner_seat))) {
    throw new Error("owner_seat is required");
  }
  if (!validWatchTargets(input.watch_targets)) {
    throw new Error("watch_targets must be strings");
  }
  if (!isMechanism(input.mechanism)) throw new Error("mechanism is invalid");
  if (
    input.watermark_key !== undefined &&
    cleanWatermarkKey(input.watermark_key) === null
  ) {
    throw new Error("watermark_key must be a non-empty string when provided");
  }
  if (input.dedupe !== undefined && !isDedupe(input.dedupe)) {
    throw new Error("dedupe is invalid");
  }
  if (
    input.addressee !== undefined &&
    normalizeAddressee(input.addressee) === null
  ) {
    throw new Error("addressee must be a non-empty string when provided");
  }
  if (
    !Number.isFinite(input.deadman_timeout_s) ||
    input.deadman_timeout_s <= 0
  ) {
    throw new Error("deadman_timeout_s must be positive");
  }
}

export function readMonitorRegistry(
  opts: MonitorRegistryOptions = {},
): MonitorRegistryFile {
  const raw = readRawRegistry(registryPathFor(opts));
  return {
    version: STATE_VERSION,
    monitors: raw.monitors
      .map(toValidRecord)
      .filter((record): record is MonitorRegistryRecord => record !== null),
  };
}

function gateRecordLiveness(
  record: RawMonitorRecord,
  nowMs: number,
): MonitorRegistryLiveness {
  const reason = invalidReason(record);
  if (reason !== null) return "invalid";
  const valid = toValidRecord(record)!;
  if (valid.state !== "alive") return valid.state;
  const lastSignalAtMs = parseTimeMs(valid.last_signal_at)!;
  const elapsedMs = nowMs - lastSignalAtMs;
  return elapsedMs > valid.deadman_timeout_s * 1000 ? "lapsed" : "alive";
}

function toGateRecord(
  record: RawMonitorRecord,
  nowMs: number,
): MonitorRegistryGateRecord {
  const watchTargets = validWatchTargets(record.watch_targets) ?? [];
  const ownerSeat = cleanString(record.owner_seat);
  const mechanism = isMechanism(record.mechanism) ? record.mechanism : undefined;
  const watermarkKey = cleanWatermarkKey(record.watermark_key);
  const timeout = cleanPositiveTimeout(record.deadman_timeout_s);
  const armedAt = cleanString(record.armed_at);
  const lastSignalAt = cleanString(record.last_signal_at);
  const addressee = deriveAddressee(record);
  return {
    monitor_id: monitorIdForInvalid(record),
    ...(ownerSeat ? { owner_seat: ownerSeat } : {}),
    watch_targets: watchTargets,
    ...(mechanism ? { mechanism } : {}),
    ...(typeof record.pattern === "string" ? { pattern: record.pattern } : {}),
    ...(watermarkKey ? { watermark_key: watermarkKey } : {}),
    ...(isDedupe(record.dedupe) ? { dedupe: record.dedupe } : {}),
    ...(addressee ? { addressee } : {}),
    ...(timeout !== null ? { deadman_timeout_s: timeout } : {}),
    ...(armedAt ? { armed_at: armedAt } : {}),
    ...(lastSignalAt ? { last_signal_at: lastSignalAt } : {}),
    ...(isState(record.state) ? { state: record.state } : {}),
    liveness: gateRecordLiveness(record, nowMs),
  };
}

function violationKey(violation: MonitorRegistryGateViolation): string {
  return `${violation.gate}:${violation.monitor_id}:${violation.reason}`;
}

function addViolation(
  violations: MonitorRegistryGateViolation[],
  seen: Set<string>,
  violation: MonitorRegistryGateViolation,
): void {
  const key = violationKey(violation);
  if (seen.has(key)) return;
  seen.add(key);
  violations.push(violation);
}

function addGate10Violations(
  record: RawMonitorRecord,
  violations: MonitorRegistryGateViolation[],
  seen: Set<string>,
): void {
  const monitorId = monitorIdForInvalid(record);
  const watermarkKey = cleanWatermarkKey(record.watermark_key);

  if (record.deadman_timeout_s === undefined || record.deadman_timeout_s === null) {
    addViolation(violations, seen, {
      gate: "gate-10",
      monitor_id: monitorId,
      reason: "missing-deadman-timeout",
    });
  } else if (cleanPositiveTimeout(record.deadman_timeout_s) === null) {
    addViolation(violations, seen, {
      gate: "gate-10",
      monitor_id: monitorId,
      reason: "invalid-deadman-timeout",
    });
  }

  if (record.mechanism === "offset-poll") {
    if (!watermarkKey) {
      addViolation(violations, seen, {
        gate: "gate-10",
        monitor_id: monitorId,
        reason: "offset-poll-missing-watermark-key",
      });
    }
    if (!isDedupe(record.dedupe)) {
      addViolation(violations, seen, {
        gate: "gate-10",
        monitor_id: monitorId,
        reason: "offset-poll-missing-dedupe",
      });
    }
  }

  if (hasTailFShape(record) && !watermarkKey) {
    addViolation(violations, seen, {
      gate: "gate-10",
      monitor_id: monitorId,
      reason: "tail-f-without-watermark",
    });
  }
}

export function queryMonitorRegistryForGates(
  opts: MonitorRegistryGateQueryOptions = {},
): MonitorRegistryGateQuery {
  const startedAt = Date.now();
  const nowMs = (opts.now ?? Date.now)();
  const raw = readRawRegistry(registryPathFor(opts));
  const monitors = raw.monitors.map((record) => toGateRecord(record, nowMs));
  const violations: MonitorRegistryGateViolation[] = [];
  const seenViolations = new Set<string>();

  for (const record of raw.monitors) {
    addGate10Violations(record, violations, seenViolations);
    if (gateRecordLiveness(record, nowMs) === "lapsed") {
      addViolation(violations, seenViolations, {
        gate: "gate-9",
        monitor_id: monitorIdForInvalid(record),
        reason: "deadman-timeout-lapsed",
      });
    }
  }

  const byMonitorId = new Map(
    monitors.map((monitor) => [monitor.monitor_id, monitor]),
  );
  for (const claimedMonitorId of opts.claimedMonitorIds ?? []) {
    const claimed = byMonitorId.get(claimedMonitorId);
    if (!claimed) {
      addViolation(violations, seenViolations, {
        gate: "gate-9",
        monitor_id: claimedMonitorId,
        reason: "monitor-id-absent",
      });
      continue;
    }
    if (claimed.liveness === "lapsed") {
      addViolation(violations, seenViolations, {
        gate: "gate-9",
        monitor_id: claimedMonitorId,
        reason: "deadman-timeout-lapsed",
      });
      continue;
    }
    if (claimed.state !== "alive" || claimed.liveness !== "alive") {
      addViolation(violations, seenViolations, {
        gate: "gate-9",
        monitor_id: claimedMonitorId,
        reason: "monitor-not-alive",
      });
    }
  }

  return {
    version: STATE_VERSION,
    queried_at: new Date(nowMs).toISOString(),
    latency_ms: Date.now() - startedAt,
    monitors,
    violations,
  };
}

export async function registerMonitor(
  input: RegisterMonitorInput,
  opts: MonitorRegistryOptions = {},
): Promise<MonitorRegistryRecord> {
  assertRegisterInput(input);
  const path = registryPathFor(opts);
  const stamp = nowIso(opts.now);
  let saved: MonitorRegistryRecord | null = null;

  withRegistryWriteLock(path, () => {
    const registry = readRawRegistry(path);
    const existing = registry.monitors.find(
      (record) => cleanString(record.monitor_id) === input.monitor_id,
    );
    if (existing?.state === "deadman-fired") {
      throw new Error("cannot re-arm a fired monitor_id; use a new id");
    }
    const next: MonitorRegistryRecord = {
      monitor_id: input.monitor_id,
      owner_seat: input.owner_seat,
      watch_targets: [...input.watch_targets],
      mechanism: input.mechanism,
      ...(input.pattern ? { pattern: input.pattern } : {}),
      ...(cleanWatermarkKey(input.watermark_key)
        ? { watermark_key: cleanWatermarkKey(input.watermark_key)! }
        : {}),
      ...(input.dedupe ? { dedupe: input.dedupe } : {}),
      ...(deriveAddressee(input) ? { addressee: deriveAddressee(input)! } : {}),
      deadman_timeout_s: input.deadman_timeout_s,
      armed_at: stamp,
      last_signal_at: stamp,
      state: "alive",
    };
    const monitors: unknown[] = registry.monitors.filter(
      (record) => cleanString(record.monitor_id) !== input.monitor_id,
    );
    monitors.push(next);
    writeRawRegistry(path, monitors);
    saved = next;
  });

  return saved!;
}

export async function deregisterMonitor(
  monitorId: string,
  opts: MonitorRegistryOptions = {},
): Promise<MonitorRegistryRecord | null> {
  const path = registryPathFor(opts);
  let updated: MonitorRegistryRecord | null = null;
  withRegistryWriteLock(path, () => {
    const registry = readRawRegistry(path);
    const monitors = registry.monitors.map((record) => {
      if (cleanString(record.monitor_id) !== monitorId) return record;
      const valid = toValidRecord(record);
      if (!valid) return record;
      updated = { ...valid, state: "dead" };
      return updated;
    });
    writeRawRegistry(path, monitors);
  });
  return updated;
}

export async function signalMonitor(
  monitorId: string,
  opts: MonitorRegistryOptions = {},
): Promise<MonitorRegistryRecord | null> {
  const path = registryPathFor(opts);
  let updated: MonitorRegistryRecord | null = null;
  withRegistryWriteLock(path, () => {
    const registry = readRawRegistry(path);
    const monitors = registry.monitors.map((record) => {
      if (cleanString(record.monitor_id) !== monitorId) return record;
      const valid = toValidRecord(record);
      if (!valid || valid.state !== "alive") return record;
      updated = { ...valid, last_signal_at: nowIso(opts.now) };
      return updated;
    });
    writeRawRegistry(path, monitors);
  });
  return updated;
}

export async function transferMonitorRegistryOwner(
  previousOwnerSeat: string,
  nextOwnerSeat: string,
  opts: MonitorRegistryOptions = {},
): Promise<number> {
  if (previousOwnerSeat === nextOwnerSeat) return 0;
  const path = registryPathFor(opts);
  let changed = 0;
  withRegistryWriteLock(path, () => {
    const registry = readRawRegistry(path);
    const monitors = registry.monitors.map((record) => {
      if (cleanString(record.owner_seat) !== previousOwnerSeat) return record;
      changed += 1;
      return { ...record, owner_seat: nextOwnerSeat };
    });
    if (changed > 0) writeRawRegistry(path, monitors);
  });
  return changed;
}

export function latestMonitorForOwnerSeats(
  ownerSeats: readonly string[],
  opts: MonitorRegistryOptions = {},
): MonitorRegistryRecord | null {
  const owners = new Set(
    ownerSeats
      .map((ownerSeat) => ownerSeat.trim())
      .filter((ownerSeat) => !isUnknownOwnerSeat(ownerSeat)),
  );
  if (owners.size === 0) return null;
  const matches = readMonitorRegistry(opts).monitors.filter((record) =>
    owners.has(record.owner_seat),
  );
  matches.sort((a, b) => {
    const armedDiff = Date.parse(b.armed_at) - Date.parse(a.armed_at);
    if (armedDiff !== 0) return armedDiff;
    return Date.parse(b.last_signal_at) - Date.parse(a.last_signal_at);
  });
  return matches[0] ?? null;
}

const noopNotify: MonitorDeadmanNotify = async () => {};

export async function sweepMonitorRegistry(
  opts: MonitorRegistrySweepOptions = {},
): Promise<MonitorRegistrySweepResult> {
  const path = registryPathFor(opts);
  const nowMs = (opts.now ?? Date.now)();
  const sweeperAgentId = opts.sweeperAgentId ?? DEFAULT_SWEEPER_ID;
  const fired: MonitorDeadmanEvent[] = [];
  const invalid: InvalidMonitorRegistryRecord[] = [];
  const alive: string[] = [];

  withRegistryWriteLock(path, () => {
    const registry = readRawRegistry(path);
    const monitors = registry.monitors.map((record) => {
      const reason = invalidReason(record);
      if (reason !== null) {
        invalid.push({ monitor_id: monitorIdForInvalid(record), reason });
        return record;
      }
      const valid = toValidRecord(record)!;
      if (valid.state !== "alive") return record;
      const lastSignalAtMs = parseTimeMs(valid.last_signal_at)!;
      const elapsedMs = nowMs - lastSignalAtMs;
      if (elapsedMs <= valid.deadman_timeout_s * 1000) {
        alive.push(valid.monitor_id);
        return record;
      }
      const firedAt = new Date(nowMs).toISOString();
      fired.push({
        monitor_id: valid.monitor_id,
        owner_seat: valid.owner_seat,
        watch_targets: valid.watch_targets,
        mechanism: valid.mechanism,
        ...(valid.pattern ? { pattern: valid.pattern } : {}),
        ...(valid.watermark_key ? { watermark_key: valid.watermark_key } : {}),
        ...(valid.dedupe ? { dedupe: valid.dedupe } : {}),
        ...(valid.addressee ? { addressee: valid.addressee } : {}),
        deadman_timeout_s: valid.deadman_timeout_s,
        armed_at: valid.armed_at,
        last_signal_at: valid.last_signal_at,
        fired_at: firedAt,
        fired_by_agent_id: sweeperAgentId,
        elapsed_s: elapsedMs / 1000,
      });
      return {
        ...valid,
        state: "firing",
        firing_claimed_by_agent_id: sweeperAgentId,
        firing_claimed_at: firedAt,
      };
    });
    if (fired.length > 0) writeRawRegistry(path, monitors);
  });

  const notify = opts.notify ?? noopNotify;
  for (const event of fired) {
    try {
      await notify(event);
    } catch {
      // State is canonical; notification delivery is best-effort and injected.
    }
  }

  if (fired.length > 0) {
    const firedIds = new Set(fired.map((event) => event.monitor_id));
    withRegistryWriteLock(path, () => {
      const registry = readRawRegistry(path);
      const monitors = registry.monitors.map((record) => {
        const valid = toValidRecord(record);
        if (
          !valid ||
          valid.state !== "firing" ||
          valid.firing_claimed_by_agent_id !== sweeperAgentId ||
          !firedIds.has(valid.monitor_id)
        ) {
          return record;
        }
        return { ...valid, state: "deadman-fired" };
      });
      writeRawRegistry(path, monitors);
    });
  }

  return { fired, invalid, alive };
}

export async function httpNotifyMonitorDeadman(
  event: MonitorDeadmanEvent,
  notifyUrl = DEFAULT_NOTIFY_URL,
): Promise<boolean> {
  return httpDeliver(
    {
      title: "Monitor deadman fired",
      body: `Monitor ${event.monitor_id} for ${event.owner_seat} missed signals for ${Math.round(
        event.elapsed_s,
      )}s; watch_targets=${event.watch_targets.join(", ")}`,
      source: DEFAULT_NOTIFY_SOURCE,
      priority: "high",
    },
    notifyUrl,
  );
}
