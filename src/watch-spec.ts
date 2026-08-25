import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { httpDeliver } from "./outbox-drainer.js";

export type WatchState = "armed" | "firing" | "fired" | "failed";
export type WatchObservedSource = "process" | "screen";
export const WATCH_AGENT_PREDICATES = [
  "thinking",
  "working",
  "idle",
  "done",
  "error",
] as const;
export type WatchAgentPredicate = (typeof WATCH_AGENT_PREDICATES)[number];

export interface WatchObserved<T> {
  value: T;
  source: WatchObservedSource;
  observed_at_ms: number;
}

export interface WatchSpec {
  owner: string;
  target: string;
  predicate?: WatchAgentPredicate;
  marker?: string;
  /** Persistently notify after each distinct file-content revision. */
  change?: "content";
  watermark?: number;
  /** Absolute Unix timestamp in milliseconds. */
  deadline: number;
}

export interface WatchRecord extends WatchSpec {
  watch_id: string;
  target_kind: "file" | "agent";
  watermark?: number;
  fingerprint?: string;
  armed_at_ms: number;
  last_heartbeat_at_ms: number;
  liveness_source: string;
  liveness: WatchObserved<boolean>;
  state: WatchState;
  terminal_reason?: WatchNotificationReason;
  terminal_at_ms?: number;
  observed_value?: number | string;
  notification_pending?: boolean;
  notification_attempts?: number;
  notification_next_attempt_at_ms?: number;
  notification_delivered_at_ms?: number;
}

export interface WatchRegistryFile {
  version: 1;
  watches: WatchRecord[];
}

export type WatchNotificationReason =
  | "predicate_matched"
  | "target_changed"
  | "consumer_died"
  | "target_missing"
  | "deadline_elapsed";

export interface WatchNotification {
  watch_id: string;
  owner: string;
  target: string;
  target_kind: "file" | "agent";
  reason: WatchNotificationReason;
  observed_at_ms: number;
  watermark?: number;
  observed_value?: number | string;
}

export type WatchNotify = (
  event: WatchNotification,
) => Promise<unknown> | unknown;

export interface WatchAgentObservation {
  exists: boolean;
  state: string | null;
  source: string;
  /**
   * AIDEV-NOTE (F1b, #472): what the observer actually saw, in the observer's
   * own words ("registry hit, screen unparseable"). The arm refusal quotes it
   * instead of asserting the agent "does not exist" -- a claim the observer
   * cannot make from a failed screen read, and one that was demonstrably false
   * for agents `send_to` was delivering to in the same second.
   */
  detail?: string;
}

export interface WatchRegistryOptions {
  registryPath?: string;
  now?: () => number;
  agentObservation?: (
    agentId: string,
  ) => Promise<WatchAgentObservation> | WatchAgentObservation;
}

export interface WatchSweepOptions extends WatchRegistryOptions {
  notify?: WatchNotify;
}

export interface WatchSweepResult {
  fired: string[];
  failed: string[];
  armed: string[];
}

export type WatchArmErrorCode =
  "invalid_watch_spec" | "watch_target_missing" | "watch_deadline_elapsed";

export class WatchArmError extends Error {
  readonly code: WatchArmErrorCode;
  readonly target: string;

  constructor(code: WatchArmErrorCode, target: string, message: string) {
    super(message);
    this.name = "WatchArmError";
    this.code = code;
    this.target = target;
  }
}

const STATE_VERSION = 1 as const;
const DEFAULT_NOTIFY_URL = "http://127.0.0.1:3847/notify";
const WRITE_LOCK_TIMEOUT_MS = 5_000;
const WRITE_LOCK_STALE_MS = 30_000;
const WRITE_LOCK_RETRY_MS = 5;
const NOTIFY_RETRY_BASE_MS = 1_000;
const NOTIFY_RETRY_MAX_MS = 60_000;

interface WatchRegistryState {
  version: unknown;
  rows: unknown[];
  watches: WatchRecord[];
}

export function defaultWatchRegistryPath(): string {
  return join(homedir(), ".golems-zikaron", "watch-specs.json");
}

function registryPathFor(opts: WatchRegistryOptions): string {
  return opts.registryPath ?? defaultWatchRegistryPath();
}

function nowMs(opts: WatchRegistryOptions): number {
  return (opts.now ?? Date.now)();
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned.length > 0 ? cleaned : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWatchAgentPredicate(value: unknown): value is WatchAgentPredicate {
  return WATCH_AGENT_PREDICATES.some((predicate) => predicate === value);
}

function isWatchState(value: unknown): value is WatchState {
  return (
    value === "armed" ||
    value === "firing" ||
    value === "fired" ||
    value === "failed"
  );
}

function isWatchNotificationReason(
  value: unknown,
): value is WatchNotificationReason {
  return (
    value === "predicate_matched" ||
    value === "target_changed" ||
    value === "consumer_died" ||
    value === "target_missing" ||
    value === "deadline_elapsed"
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isWatchRecord(value: unknown): value is WatchRecord {
  if (!isRecord(value) || !isRecord(value.liveness)) return false;
  if (
    !cleanString(value.watch_id) ||
    !cleanString(value.owner) ||
    !cleanString(value.target) ||
    !cleanString(value.liveness_source) ||
    !isFiniteNumber(value.deadline) ||
    !isFiniteNumber(value.armed_at_ms) ||
    !isFiniteNumber(value.last_heartbeat_at_ms) ||
    !isWatchState(value.state) ||
    typeof value.liveness.value !== "boolean" ||
    (value.liveness.source !== "process" && value.liveness.source !== "screen") ||
    !isFiniteNumber(value.liveness.observed_at_ms)
  ) {
    return false;
  }
  if (value.fingerprint !== undefined && typeof value.fingerprint !== "string") {
    return false;
  }
  if (
    value.watermark !== undefined &&
    (!Number.isInteger(value.watermark) || (value.watermark as number) < 0)
  ) {
    return false;
  }
  if (
    value.observed_value !== undefined &&
    typeof value.observed_value !== "number" &&
    typeof value.observed_value !== "string"
  ) {
    return false;
  }
  if (
    value.terminal_at_ms !== undefined &&
    !isFiniteNumber(value.terminal_at_ms)
  ) {
    return false;
  }
  if (
    value.notification_pending !== undefined &&
    typeof value.notification_pending !== "boolean"
  ) {
    return false;
  }
  if (
    value.notification_attempts !== undefined &&
    (!Number.isInteger(value.notification_attempts) ||
      (value.notification_attempts as number) < 0)
  ) {
    return false;
  }
  if (
    value.notification_next_attempt_at_ms !== undefined &&
    !isFiniteNumber(value.notification_next_attempt_at_ms)
  ) {
    return false;
  }
  if (
    value.notification_delivered_at_ms !== undefined &&
    !isFiniteNumber(value.notification_delivered_at_ms)
  ) {
    return false;
  }
  if (
    value.terminal_reason !== undefined &&
    !isWatchNotificationReason(value.terminal_reason)
  ) {
    return false;
  }
  if (
    value.state !== "armed" &&
    !isWatchNotificationReason(value.terminal_reason)
  ) {
    return false;
  }
  if (value.target_kind === "file") {
    const hasMarker = Boolean(cleanString(value.marker));
    const hasChange = value.change === "content";
    return hasMarker !== hasChange && value.predicate === undefined;
  }
  if (value.target_kind === "agent") {
    return (
      isWatchAgentPredicate(value.predicate) &&
      value.marker === undefined &&
      value.change === undefined
    );
  }
  return false;
}

function emptyRegistryState(): WatchRegistryState {
  return { version: STATE_VERSION, rows: [], watches: [] };
}

function readRegistryState(path: string): WatchRegistryState {
  if (!existsSync(path)) return emptyRegistryState();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (isRecord(parsed) && Array.isArray(parsed.watches)) {
      const rows = parsed.watches;
      return {
        version: parsed.version ?? STATE_VERSION,
        rows,
        watches: rows.filter(isWatchRecord),
      };
    }
  } catch {
    // A corrupt registry is treated as empty at the read boundary. Arm writes a
    // fresh canonical file; sweep stays fail-closed by having nothing to judge.
  }
  return emptyRegistryState();
}

function readRegistry(path: string): WatchRegistryFile {
  return {
    version: STATE_VERSION,
    watches: readRegistryState(path).watches,
  };
}

function writeRegistry(
  path: string,
  version: unknown,
  rows: readonly unknown[],
): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(
    temporary,
    `${JSON.stringify({ version, watches: rows }, null, 2)}\n`,
    "utf8",
  );
  renameSync(temporary, path);
}

async function withWriteLock<T>(
  path: string,
  operation: () => T,
): Promise<T> {
  const lockPath = `${path}.lock`;
  const lockOwnerPath = join(
    lockPath,
    `.owner.${process.pid}.${Date.now()}.${randomUUID()}`,
  );
  const startedAt = Date.now();
  mkdirSync(dirname(path), { recursive: true });
  while (true) {
    try {
      mkdirSync(lockPath);
      writeFileSync(lockOwnerPath, "", "utf8");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs >= WRITE_LOCK_STALE_MS) {
          const stalePath =
            `${lockPath}.stale.${process.pid}.${Date.now()}.` + randomUUID();
          renameSync(lockPath, stalePath);
          rmSync(stalePath, { recursive: true, force: true });
        }
      } catch {
        // Another process released, acquired, or quarantined the lock first.
      }
      if (Date.now() - startedAt >= WRITE_LOCK_TIMEOUT_MS) {
        throw new Error(
          `Timed out waiting for WatchSpec registry lock: ${lockPath}`,
        );
      }
      await new Promise<void>((resolveWait) => {
        setTimeout(resolveWait, WRITE_LOCK_RETRY_MS);
      });
    }
  }
  try {
    return operation();
  } finally {
    let ownsLock = true;
    try {
      rmSync(lockOwnerPath);
    } catch {
      // A stale-lock takeover moved our ownership marker with the old lock.
      ownsLock = false;
    }
    if (ownsLock) {
      try {
        rmdirSync(lockPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
      }
    }
  }
}

function countMarker(path: string, marker: string): number {
  const text = readFileSync(path, "utf8");
  let count = 0;
  let from = 0;
  while (from <= text.length - marker.length) {
    const match = text.indexOf(marker, from);
    if (match < 0) break;
    count += 1;
    from = match + marker.length;
  }
  return count;
}

function contentFingerprint(path: string): string {
  const stat = statSync(path, { bigint: true });
  const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
  return [digest, stat.mtimeNs, stat.ctimeNs, stat.ino].join(":");
}

function assertSpec(
  spec: WatchSpec,
  opts: WatchRegistryOptions,
): {
  owner: string;
  target: string;
  targetKind: "file" | "agent";
  predicate?: WatchAgentPredicate;
  marker?: string;
  change?: "content";
} {
  const owner = cleanString(spec.owner);
  const target = cleanString(spec.target);
  const predicate = cleanString(spec.predicate);
  const marker = cleanString(spec.marker);
  const change = spec.change === "content" ? "content" : null;
  const selectorCount = Number(predicate !== null) + Number(marker !== null) + Number(change !== null);
  if (!owner || !target || selectorCount !== 1) {
    throw new WatchArmError(
      "invalid_watch_spec",
      target ?? "",
      "WatchSpec requires owner, target, and exactly one of predicate, marker, or change",
    );
  }
  const now = nowMs(opts);
  if (!Number.isFinite(spec.deadline) || spec.deadline <= now) {
    throw new WatchArmError(
      "watch_deadline_elapsed",
      target,
      "WatchSpec deadline must be a future Unix timestamp in milliseconds",
    );
  }
  if (
    spec.watermark !== undefined &&
    (!Number.isInteger(spec.watermark) || spec.watermark < 0)
  ) {
    throw new WatchArmError(
      "invalid_watch_spec",
      target,
      "WatchSpec watermark must be a non-negative integer",
    );
  }

  const targetKind = isAbsolute(target) ? "file" : "agent";
  if (targetKind === "file") {
    if ((!marker && !change) || predicate || Boolean(marker) === Boolean(change)) {
      throw new WatchArmError(
        "invalid_watch_spec",
        target,
        "File WatchSpec targets require exactly one of marker or change and do not accept predicate",
      );
    }
    if (!existsSync(target)) {
      throw new WatchArmError(
        "watch_target_missing",
        target,
        `Watch target does not exist: ${target}`,
      );
    }
  } else {
    if (!isWatchAgentPredicate(predicate) || marker || change) {
      throw new WatchArmError(
        "invalid_watch_spec",
        target,
        `Agent WatchSpec targets require one of ${WATCH_AGENT_PREDICATES.join(
          ", ",
        )} and do not accept marker`,
      );
    }
    if (!opts.agentObservation) {
      throw new WatchArmError(
        "invalid_watch_spec",
        target,
        "Agent WatchSpec targets require an independent observation provider",
      );
    }
  }
  return {
    owner,
    target,
    targetKind,
    ...(isWatchAgentPredicate(predicate) ? { predicate } : {}),
    ...(marker ? { marker } : {}),
    ...(change ? { change } : {}),
  };
}

export function readWatchRegistry(
  opts: WatchRegistryOptions = {},
): WatchRegistryFile {
  return readRegistry(registryPathFor(opts));
}

export async function armWatch(
  spec: WatchSpec,
  opts: WatchRegistryOptions = {},
): Promise<WatchRecord> {
  const checked = assertSpec(spec, opts);
  const observedAt = nowMs(opts);
  const target =
    checked.targetKind === "file" ? resolve(checked.target) : checked.target;
  const watermark = checked.marker
    ? (spec.watermark ?? countMarker(target, checked.marker))
    : spec.watermark;
  const fingerprint = checked.change ? contentFingerprint(target) : undefined;
  const agentObservation =
    checked.targetKind === "agent"
      ? await opts.agentObservation?.(target)
      : undefined;
  if (checked.targetKind === "agent" && !agentObservation?.exists) {
    throw new WatchArmError(
      "watch_target_missing",
      target,
      `Watch target agent is not observable: ${target} (${
        agentObservation?.detail ?? "no observation was returned"
      })`,
    );
  }
  const source: WatchObservedSource =
    checked.targetKind === "file" ? "process" : "screen";
  const record: WatchRecord = {
    watch_id: randomUUID(),
    owner: checked.owner,
    target,
    ...(checked.predicate ? { predicate: checked.predicate } : {}),
    ...(checked.marker ? { marker: checked.marker } : {}),
    ...(checked.change ? { change: checked.change } : {}),
    ...(watermark !== undefined ? { watermark } : {}),
    ...(fingerprint !== undefined ? { fingerprint } : {}),
    deadline: spec.deadline,
    target_kind: checked.targetKind,
    armed_at_ms: observedAt,
    last_heartbeat_at_ms: observedAt,
    liveness_source: agentObservation?.source ?? target,
    liveness: { value: true, source, observed_at_ms: observedAt },
    state: "armed",
  };

  const path = registryPathFor(opts);
  await withWriteLock(path, () => {
    const registry = readRegistryState(path);
    writeRegistry(path, registry.version, [...registry.rows, record]);
  });
  return record;
}

function notificationFor(
  record: WatchRecord,
  reason: WatchNotificationReason,
  observedAt: number,
  observedValue?: number | string,
): WatchNotification {
  return {
    watch_id: record.watch_id,
    owner: record.owner,
    target: record.target,
    target_kind: record.target_kind,
    reason,
    observed_at_ms: observedAt,
    ...(record.watermark !== undefined ? { watermark: record.watermark } : {}),
    ...(observedValue !== undefined ? { observed_value: observedValue } : {}),
  };
}

export async function sweepWatches(
  opts: WatchSweepOptions = {},
): Promise<WatchSweepResult> {
  const path = registryPathFor(opts);
  const observedAt = nowMs(opts);
  const notifications: WatchNotification[] = [];
  const result: WatchSweepResult = { fired: [], failed: [], armed: [] };

  const snapshot = readRegistryState(path);
  const agentObservations = new Map<string, WatchAgentObservation>();
  for (const record of snapshot.watches) {
    if (record.state !== "armed" || record.target_kind !== "agent") continue;
    if (!opts.agentObservation) {
      throw new Error(
        "Agent WatchSpec sweep requires an independent observation provider",
      );
    }
    agentObservations.set(
      record.target,
      await opts.agentObservation(record.target),
    );
  }

  await withWriteLock(path, () => {
    const registry = readRegistryState(path);
    const watches = registry.rows.map((row) => {
      if (!isWatchRecord(row)) return row;
      const record = row;
      if (record.state === "firing" && record.terminal_reason) {
        const migrated: WatchRecord = {
          ...record,
          state:
            record.terminal_reason === "predicate_matched" ? "fired" : "failed",
          notification_pending: true,
          notification_attempts: record.notification_attempts ?? 0,
          notification_next_attempt_at_ms:
            record.notification_next_attempt_at_ms ?? observedAt,
        };
        if (migrated.notification_next_attempt_at_ms! <= observedAt) {
          notifications.push(
            notificationFor(
              migrated,
              migrated.terminal_reason!,
              migrated.terminal_at_ms ?? observedAt,
              migrated.observed_value,
            ),
          );
        }
        return migrated;
      }
      if (record.state !== "armed") {
        if (
          record.notification_pending &&
          record.terminal_reason &&
          (record.notification_next_attempt_at_ms ?? 0) <= observedAt
        ) {
          notifications.push(
            notificationFor(
              record,
              record.terminal_reason,
              record.terminal_at_ms ?? observedAt,
              record.observed_value,
            ),
          );
        }
        return record;
      }
      const agentObservation = agentObservations.get(record.target);
      if (record.target_kind === "agent" && !agentObservation) {
        result.armed.push(record.watch_id);
        return record;
      }
      const source: WatchObservedSource =
        record.target_kind === "file" ? "process" : "screen";
      const exists =
        record.target_kind === "file"
          ? existsSync(record.target)
          : (agentObservation?.exists ?? false);
      const heartbeat = {
        last_heartbeat_at_ms: observedAt,
        liveness_source:
          record.target_kind === "agent"
            ? (agentObservation?.source ?? record.liveness_source)
            : record.liveness_source,
        liveness: { value: exists, source, observed_at_ms: observedAt },
      } satisfies Pick<
        WatchRecord,
        "last_heartbeat_at_ms" | "liveness_source" | "liveness"
      >;

      if (!exists) {
        const reason: WatchNotificationReason =
          record.target_kind === "agent" ? "consumer_died" : "target_missing";
        const notification = notificationFor(record, reason, observedAt);
        notifications.push(notification);
        result.failed.push(record.watch_id);
        return {
          ...record,
          ...heartbeat,
          state: "failed" as const,
          terminal_reason: reason,
          terminal_at_ms: observedAt,
          notification_pending: true,
          notification_attempts: 0,
          notification_next_attempt_at_ms: observedAt,
        };
      }

      if (observedAt >= record.deadline) {
        const notification = notificationFor(
          record,
          "deadline_elapsed",
          observedAt,
        );
        notifications.push(notification);
        result.failed.push(record.watch_id);
        return {
          ...record,
          ...heartbeat,
          state: "failed" as const,
          terminal_reason: "deadline_elapsed" as const,
          terminal_at_ms: observedAt,
          notification_pending: true,
          notification_attempts: 0,
          notification_next_attempt_at_ms: observedAt,
        };
      }

      const observedValue =
        record.target_kind === "file"
          ? record.change === "content"
            ? contentFingerprint(record.target)
            : countMarker(record.target, record.marker!)
          : (agentObservation?.state ?? "unknown");
      const matched =
        record.target_kind === "file"
          ? record.change === "content"
            ? typeof observedValue === "string" &&
              observedValue !== record.fingerprint
            : typeof observedValue === "number" &&
              observedValue > (record.watermark ?? 0)
          : observedValue === record.predicate;
      if (matched) {
        const reason: WatchNotificationReason =
          record.change === "content" ? "target_changed" : "predicate_matched";
        const notification = notificationFor(
          record,
          reason,
          observedAt,
          observedValue,
        );
        notifications.push(notification);
        result.fired.push(record.watch_id);
        return {
          ...record,
          ...heartbeat,
          state: "fired" as const,
          terminal_reason: reason,
          terminal_at_ms: observedAt,
          observed_value: observedValue,
          notification_pending: true,
          notification_attempts: 0,
          notification_next_attempt_at_ms: observedAt,
        };
      }

      if (
        record.target_kind === "agent" &&
        (observedValue === "error" || observedValue === "done")
      ) {
        const notification = notificationFor(
          record,
          "consumer_died",
          observedAt,
          observedValue,
        );
        notifications.push(notification);
        result.failed.push(record.watch_id);
        return {
          ...record,
          ...heartbeat,
          state: "failed" as const,
          terminal_reason: "consumer_died" as const,
          terminal_at_ms: observedAt,
          observed_value: observedValue,
          notification_pending: true,
          notification_attempts: 0,
          notification_next_attempt_at_ms: observedAt,
        };
      }

      result.armed.push(record.watch_id);
      return { ...record, ...heartbeat, observed_value: observedValue };
    });
    if (registry.watches.length > 0) {
      writeRegistry(path, registry.version, watches);
    }
  });

  for (const notification of notifications) {
    let delivered = false;
    try {
      delivered = (await opts.notify?.(notification)) !== false;
    } catch {
      delivered = false;
    }
    await withWriteLock(path, () => {
      const registry = readRegistryState(path);
      const watches = registry.rows.map((row) => {
        if (!isWatchRecord(row)) return row;
        const record = row;
        if (
          record.watch_id !== notification.watch_id ||
          !record.notification_pending
        ) {
          return record;
        }
        if (delivered) {
          if (
            record.change === "content" &&
            typeof notification.observed_value === "string"
          ) {
            const {
              terminal_reason: _terminalReason,
              terminal_at_ms: _terminalAt,
              notification_next_attempt_at_ms: _nextAttempt,
              notification_delivered_at_ms: _previousDelivery,
              ...persistent
            } = record;
            return {
              ...persistent,
              state: "armed" as const,
              fingerprint: notification.observed_value,
              observed_value: notification.observed_value,
              notification_pending: false,
              notification_attempts: 0,
              notification_delivered_at_ms: observedAt,
            };
          }
          return {
            ...record,
            notification_pending: false,
            notification_delivered_at_ms: observedAt,
          };
        }
        const attempts = (record.notification_attempts ?? 0) + 1;
        const retryDelay = Math.min(
          NOTIFY_RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 16),
          NOTIFY_RETRY_MAX_MS,
        );
        return {
          ...record,
          notification_attempts: attempts,
          notification_next_attempt_at_ms: observedAt + retryDelay,
        };
      });
      writeRegistry(path, registry.version, watches);
    });
  }
  return result;
}

export async function httpNotifyWatch(
  event: WatchNotification,
  notifyUrl = DEFAULT_NOTIFY_URL,
): Promise<boolean> {
  return httpDeliver(
    {
      title: "Declared watch changed",
      body: `Watch ${event.watch_id} for ${event.owner}: ${event.reason}; target=${event.target}`,
      source: "cmuxlayer-watch-spec",
      priority:
        event.reason === "predicate_matched" || event.reason === "target_changed"
          ? "normal"
          : "high",
      dedupe_key: `${event.watch_id}:${event.reason}:${event.observed_value ?? ""}`,
    },
    notifyUrl,
  );
}
