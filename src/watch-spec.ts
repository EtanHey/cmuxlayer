import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { httpDeliver } from "./outbox-drainer.js";

export type WatchState = "armed" | "firing" | "fired" | "failed";
export type WatchObservedSource = "process" | "screen";

export interface WatchObserved<T> {
  value: T;
  source: WatchObservedSource;
  observed_at_ms: number;
}

export interface WatchSpec {
  owner: string;
  target: string;
  predicate?: string;
  marker?: string;
  watermark?: number;
  /** Absolute Unix timestamp in milliseconds. */
  deadline: number;
}

export interface WatchRecord extends WatchSpec {
  watch_id: string;
  target_kind: "file" | "agent";
  watermark?: number;
  armed_at_ms: number;
  last_heartbeat_at_ms: number;
  liveness_source: string;
  liveness: WatchObserved<boolean>;
  state: WatchState;
  terminal_reason?: WatchNotificationReason;
  terminal_at_ms?: number;
  observed_value?: number | string;
}

export interface WatchRegistryFile {
  version: 1;
  watches: WatchRecord[];
}

export type WatchNotificationReason =
  "predicate_matched" | "consumer_died" | "target_missing" | "deadline_elapsed";

export interface WatchNotification {
  watch_id: string;
  owner: string;
  target: string;
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

function readRegistry(path: string): WatchRegistryFile {
  if (!existsSync(path)) return { version: STATE_VERSION, watches: [] };
  try {
    const parsed = JSON.parse(
      readFileSync(path, "utf8"),
    ) as Partial<WatchRegistryFile>;
    if (Array.isArray(parsed.watches)) {
      return { version: STATE_VERSION, watches: parsed.watches };
    }
  } catch {
    // A corrupt registry is treated as empty at the read boundary. Arm writes a
    // fresh canonical file; sweep stays fail-closed by having nothing to judge.
  }
  return { version: STATE_VERSION, watches: [] };
}

function writeRegistry(path: string, watches: readonly WatchRecord[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(
    temporary,
    `${JSON.stringify({ version: STATE_VERSION, watches }, null, 2)}\n`,
    "utf8",
  );
  renameSync(temporary, path);
}

function withWriteLock<T>(path: string, operation: () => T): T {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(lockPath);
  try {
    return operation();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
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

function assertSpec(
  spec: WatchSpec,
  opts: WatchRegistryOptions,
): {
  owner: string;
  target: string;
  targetKind: "file" | "agent";
  predicate?: string;
  marker?: string;
} {
  const owner = cleanString(spec.owner);
  const target = cleanString(spec.target);
  const predicate = cleanString(spec.predicate);
  const marker = cleanString(spec.marker);
  if (!owner || !target || (predicate === null) === (marker === null)) {
    throw new WatchArmError(
      "invalid_watch_spec",
      target ?? "",
      "WatchSpec requires owner, target, and exactly one of predicate or marker",
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
    if (!marker || predicate) {
      throw new WatchArmError(
        "invalid_watch_spec",
        target,
        "File WatchSpec targets require marker and do not accept predicate",
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
    if (!predicate || marker) {
      throw new WatchArmError(
        "invalid_watch_spec",
        target,
        "Agent WatchSpec targets require predicate and do not accept marker",
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
    ...(predicate ? { predicate } : {}),
    ...(marker ? { marker } : {}),
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
  const agentObservation =
    checked.targetKind === "agent"
      ? await opts.agentObservation?.(target)
      : undefined;
  if (checked.targetKind === "agent" && !agentObservation?.exists) {
    throw new WatchArmError(
      "watch_target_missing",
      target,
      `Watch target agent does not exist: ${target}`,
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
    ...(watermark !== undefined ? { watermark } : {}),
    deadline: spec.deadline,
    target_kind: checked.targetKind,
    armed_at_ms: observedAt,
    last_heartbeat_at_ms: observedAt,
    liveness_source: agentObservation?.source ?? target,
    liveness: { value: true, source, observed_at_ms: observedAt },
    state: "armed",
  };

  const path = registryPathFor(opts);
  withWriteLock(path, () => {
    const registry = readRegistry(path);
    writeRegistry(path, [...registry.watches, record]);
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

  const snapshot = readRegistry(path);
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

  withWriteLock(path, () => {
    const registry = readRegistry(path);
    const watches = registry.watches.map((record) => {
      if (record.state === "firing" && record.terminal_reason) {
        notifications.push(
          notificationFor(
            record,
            record.terminal_reason,
            record.terminal_at_ms ?? observedAt,
            record.observed_value,
          ),
        );
        return record;
      }
      if (record.state !== "armed") return record;
      const agentObservation = agentObservations.get(record.target);
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
        return {
          ...record,
          ...heartbeat,
          state: "firing" as const,
          terminal_reason: reason,
          terminal_at_ms: observedAt,
        };
      }

      if (observedAt >= record.deadline) {
        const notification = notificationFor(
          record,
          "deadline_elapsed",
          observedAt,
        );
        notifications.push(notification);
        return {
          ...record,
          ...heartbeat,
          state: "firing" as const,
          terminal_reason: "deadline_elapsed" as const,
          terminal_at_ms: observedAt,
        };
      }

      const observedValue =
        record.target_kind === "file"
          ? countMarker(record.target, record.marker!)
          : (agentObservation?.state ?? "unknown");
      const matched =
        record.target_kind === "file"
          ? typeof observedValue === "number" &&
            observedValue > (record.watermark ?? 0)
          : observedValue === record.predicate;
      if (matched) {
        const notification = notificationFor(
          record,
          "predicate_matched",
          observedAt,
          observedValue,
        );
        notifications.push(notification);
        return {
          ...record,
          ...heartbeat,
          state: "firing" as const,
          terminal_reason: "predicate_matched" as const,
          terminal_at_ms: observedAt,
          observed_value: observedValue,
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
        return {
          ...record,
          ...heartbeat,
          state: "firing" as const,
          terminal_reason: "consumer_died" as const,
          terminal_at_ms: observedAt,
          observed_value: observedValue,
        };
      }

      result.armed.push(record.watch_id);
      return { ...record, ...heartbeat, observed_value: observedValue };
    });
    if (watches.length > 0) writeRegistry(path, watches);
  });

  for (const notification of notifications) {
    let delivered = false;
    try {
      delivered = (await opts.notify?.(notification)) !== false;
    } catch {
      delivered = false;
    }
    if (!delivered) continue;
    withWriteLock(path, () => {
      const registry = readRegistry(path);
      const watches = registry.watches.map((record) => {
        if (
          record.watch_id !== notification.watch_id ||
          record.state !== "firing"
        ) {
          return record;
        }
        const terminalState: WatchState =
          record.terminal_reason === "predicate_matched" ? "fired" : "failed";
        if (terminalState === "fired") result.fired.push(record.watch_id);
        else result.failed.push(record.watch_id);
        return { ...record, state: terminalState };
      });
      writeRegistry(path, watches);
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
      priority: event.reason === "predicate_matched" ? "normal" : "high",
      dedupe_key: `${event.watch_id}:${event.reason}`,
    },
    notifyUrl,
  );
}
