// Notify/outbox drainer (LANE-OUTBOX). Nothing drained `~/.golems-zikaron/outbox.md`
// (imp9) — pending operator messages piled up and were never delivered. This is
// cmuxlayer's notify half: read pending outbox entries and POST them to the local
// notify listener (127.0.0.1:3847/notify — the same endpoint the RAM watchdog uses),
// remembering what was delivered so a restart never double-sends.
//
// AIDEV-NOTE: idempotency is by a NON-DESTRUCTIVE sidecar (`.outbox-drained.json`),
// never by mutating outbox.md. Each entry's id is `hash(body)#occurrence` — a
// content hash plus the ordinal of that exact body within the current parse. This
// is ROTATION-SAFE: the id depends only on the message text and how many identical
// bodies precede it, NOT on the entry's byte/line position or on unrelated entries.
// So trimming/rotating the unbounded log (removing earlier, unrelated messages)
// does NOT shift any surviving entry's id -> no mass re-send (the ~20-Telegram-spam
// class). Genuine repeated identical messages still each deliver (occurrence #0, #1,
// ...). On drain, delivered entries are also appended to a durable archive so the
// operator history survives when the live outbox.md is later trimmed.
//
// AIDEV-NOTE: the `deliver` transport defaults to a NO-OP. Only the real MCP
// entrypoints (index.ts / daemon.ts / app-server-runtime.ts) inject `httpDeliver`,
// so the test suite — and any caller that forgets to wire a transport — never posts
// to 127.0.0.1:3847. This is the incident guard: a real-default once fired ~20 live
// notifications during `bun run test`.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Payload shape accepted by the 3847 notify listener (matches the RAM watchdog). */
export interface NotifyPayload {
  title: string;
  body: string;
  source: string;
  priority: string;
  dedupe_key?: string;
}

/** A single pending outbox message. */
export interface OutboxEntry {
  /**
   * Rotation-safe dedup id: `sha256(body)#occurrence`. Depends only on the
   * message text and the ordinal of that exact body within the current parse —
   * never on byte position or unrelated entries — so a rotation/trim of the
   * unbounded log cannot shift it and trigger a re-send.
   */
  id: string;
  /** 0-based position of the entry within the outbox file (diagnostic only). */
  index: number;
  /** The message text (trimmed of surrounding whitespace). */
  body: string;
}

export interface DrainResult {
  /** Entries delivered on this drain. */
  delivered: OutboxEntry[];
  deliveredCount: number;
  /** Entries skipped because they were already drained. */
  skippedCount: number;
  /** Entries whose delivery was attempted but failed (will retry next drain). */
  failedCount: number;
  /** Total entries parsed from the outbox file. */
  totalEntries: number;
  /**
   * True only on a one-time id-scheme/version-bump migration sweep: the legacy
   * (or missing/corrupt) sidecar was QUARANTINED — every currently-present entry
   * was adopted as drained WITHOUT delivering, so the whole pre-existing backlog
   * is not re-sent under the new id scheme (the #240 mass-respam regression).
   * Absent (undefined) on every normal drain.
   */
  migrated?: boolean;
  /**
   * Number of entries adopted-as-drained by the quarantine migration. Populated
   * only when `migrated` is true.
   */
  migratedCount?: number;
}

export interface OutboxDrainerOptions {
  /** Path to the outbox file. Defaults to `~/.golems-zikaron/outbox.md`. */
  outboxPath?: string;
  /** Path to the drained-state sidecar. Defaults next to the outbox file. */
  statePath?: string;
  /**
   * Path to the durable delivered-entry archive. Defaults next to the outbox
   * file (`outbox-archive.md`). Delivered entries are appended here so operator
   * history survives when the live outbox.md is later trimmed/rotated.
   */
  archivePath?: string;
  /** Notify listener URL. Defaults to `http://127.0.0.1:3847/notify`. */
  notifyUrl?: string;
  /** Notification title. */
  title?: string;
  /** Notification source tag. */
  source?: string;
  /** Notification priority. */
  priority?: string;
  /**
   * Delivery transport. Returns true on success (entry gets marked drained),
   * false on failure (entry stays pending for the next drain). Defaults to a
   * NO-OP (delivers nothing) so tests never hit the network; the real MCP
   * entrypoints inject `httpDeliver` to POST to `notifyUrl`.
   */
  deliver?: (payload: NotifyPayload, url: string) => Promise<boolean>;
  /** Clock for the `at` timestamp in persisted state / archive. */
  now?: () => number;
}

interface DrainedRecord {
  id: string;
  at: number;
}

interface DrainState {
  version: number;
  drained: DrainedRecord[];
}

const DEFAULT_NOTIFY_URL = "http://127.0.0.1:3847/notify";
const DEFAULT_TITLE = "golems outbox";
const DEFAULT_SOURCE = "cmuxlayer-outbox";
const DEFAULT_PRIORITY = "default";
// v1 → v2: #240 changed the dedup id from byte-position → `sha256(body)#occurrence`.
// A version bump means prior drained-marks may not map to the current id scheme, so
// `drainOutbox` gates on it to quarantine (not re-deliver) a legacy backlog.
const STATE_VERSION = 2;

export function defaultOutboxPath(): string {
  return join(homedir(), ".golems-zikaron", "outbox.md");
}

export function defaultStatePath(outboxPath: string): string {
  return join(dirname(outboxPath), ".outbox-drained.json");
}

export function defaultArchivePath(outboxPath: string): string {
  return join(dirname(outboxPath), "outbox-archive.md");
}

function contentHash(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 32);
}

/**
 * Split raw outbox text into indexed entries on blank-line boundaries. Empty /
 * whitespace-only blocks are dropped. Each surviving block's id is
 * `sha256(body)#occurrence`, where `occurrence` is the ordinal of that exact
 * body among identical bodies seen so far in this parse. This makes the id
 * rotation-safe (independent of file position and of unrelated entries) while
 * still giving genuine repeats of the same message distinct ids.
 */
export function parseOutboxEntries(raw: string): OutboxEntry[] {
  const entries: OutboxEntry[] = [];
  const occurrences = new Map<string, number>();
  let index = 0;
  for (const block of raw.split(/\n[ \t]*\n/)) {
    const body = block.trim();
    if (body.length === 0) continue;
    const hash = contentHash(body);
    const occurrence = occurrences.get(hash) ?? 0;
    occurrences.set(hash, occurrence + 1);
    entries.push({ id: `${hash}#${occurrence}`, index, body });
    index += 1;
  }
  return entries;
}

function loadState(statePath: string): DrainState {
  // A MISSING sidecar is legacy, not current: default to version 0 so the
  // migration gate quarantines any co-existing backlog instead of re-sending it
  // ("deleted sidecar re-arms full re-send" class). Never seed with STATE_VERSION.
  if (!existsSync(statePath)) {
    return { version: 0, drained: [] };
  }
  try {
    const parsed = JSON.parse(
      readFileSync(statePath, "utf8"),
    ) as Partial<DrainState>;
    const drained = Array.isArray(parsed.drained) ? parsed.drained : [];
    // Preserve the ON-DISK version so `drainOutbox` can detect an id-scheme bump.
    // A missing/NaN version field is treated as legacy (0), NOT current.
    const version = Number(parsed.version);
    return { version: Number.isFinite(version) ? version : 0, drained };
  } catch {
    // Corrupt sidecar: treat as a lost legacy sidecar (version 0, no drained
    // records) so the migration gate quarantines rather than re-sends the whole
    // backlog. Safer than throwing and blocking all future drains.
    return { version: 0, drained: [] };
  }
}

function saveState(statePath: string, state: DrainState): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Stamp the sidecar to the current STATE_VERSION when the version boundary is
 * crossed with NO backlog to quarantine (an empty or absent outbox). Without
 * this, a fresh v2 deploy whose outbox is momentarily empty/absent would
 * early-return before the migration block, the sidecar would never be stamped,
 * and the gate would stay armed — so the FIRST real message to arrive later
 * would be quarantined and dropped. Existing drained records are preserved.
 * Returns true iff it stamped (i.e. a boundary was actually crossed).
 */
function stampVersionBaseline(statePath: string): boolean {
  const state = loadState(statePath);
  if (state.version >= STATE_VERSION) return false;
  state.version = STATE_VERSION;
  saveState(statePath, state);
  return true;
}

/**
 * Append a delivered entry to the durable archive so operator history survives
 * when the live outbox.md is later trimmed/rotated. Best-effort: the caller
 * treats a throw here as non-fatal (the entry is already marked drained).
 */
function appendArchive(
  archivePath: string,
  entry: OutboxEntry,
  at: number,
): void {
  mkdirSync(dirname(archivePath), { recursive: true });
  const stamp = new Date(at).toISOString();
  appendFileSync(
    archivePath,
    `<!-- drained ${stamp} id=${entry.id} -->\n${entry.body}\n\n`,
  );
}

/**
 * Real delivery transport: POST the payload to the notify listener. Exported so
 * only the production MCP entrypoints inject it; the library default stays a
 * no-op so tests never reach the network.
 */
export async function httpDeliver(
  payload: NotifyPayload,
  url: string,
): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Default transport: deliver nothing. Prevents any accidental network I/O. */
const noopDeliver: NonNullable<OutboxDrainerOptions["deliver"]> = async () =>
  false;

/**
 * Drain pending outbox entries to the notify listener exactly once each.
 * Idempotent across restarts via the sidecar state file; a failed delivery is
 * left pending so it retries on the next drain.
 */
export async function drainOutbox(
  opts: OutboxDrainerOptions = {},
): Promise<DrainResult> {
  const outboxPath = opts.outboxPath ?? defaultOutboxPath();
  const statePath = opts.statePath ?? defaultStatePath(outboxPath);
  const archivePath = opts.archivePath ?? defaultArchivePath(outboxPath);
  const notifyUrl = opts.notifyUrl ?? DEFAULT_NOTIFY_URL;
  const title = opts.title ?? DEFAULT_TITLE;
  const source = opts.source ?? DEFAULT_SOURCE;
  const priority = opts.priority ?? DEFAULT_PRIORITY;
  const deliver = opts.deliver ?? noopDeliver;
  const now = opts.now ?? (() => Date.now());

  const result: DrainResult = {
    delivered: [],
    deliveredCount: 0,
    skippedCount: 0,
    failedCount: 0,
    totalEntries: 0,
  };

  if (!existsSync(outboxPath)) {
    // No outbox file, but a version-boundary crossing must still stamp the v2
    // baseline so the gate disarms — otherwise the first real message to arrive
    // later would be quarantined. Nothing to quarantine here, just stamp.
    if (stampVersionBaseline(statePath)) {
      result.migrated = true;
      result.migratedCount = 0;
    }
    return result;
  }

  const entries = parseOutboxEntries(readFileSync(outboxPath, "utf8"));
  result.totalEntries = entries.length;
  if (entries.length === 0) {
    // Empty outbox: same as above — stamp the v2 baseline so a fresh deploy
    // does not leave the gate armed against the first genuine message.
    if (stampVersionBaseline(statePath)) {
      result.migrated = true;
      result.migratedCount = 0;
    }
    return result;
  }

  const state = loadState(statePath);
  const drainedIds = new Set(state.drained.map((r) => r.id));

  // One-time migration on an id-scheme/version bump. A version change means
  // prior drained-marks may not map to the current id scheme, so re-running the
  // delivery loop against a legacy sidecar would re-deliver the whole backlog
  // (the #240 mass-respam regression). We QUARANTINE: adopt every entry
  // currently present as drained WITHOUT delivering, archive them as history,
  // then stamp the sidecar to STATE_VERSION. Genuine new messages appended
  // after migration deliver normally. Also covers a missing/corrupt sidecar
  // (version 0) → never re-arms a full re-send.
  if (state.version < STATE_VERSION) {
    const at = now();
    for (const entry of entries) {
      if (!drainedIds.has(entry.id)) {
        drainedIds.add(entry.id);
        state.drained.push({ id: entry.id, at });
        // best-effort history; must never gate exactly-once
        try {
          appendArchive(archivePath, entry, at);
        } catch {
          // Archive is durable operator history, not the dedup source of truth.
        }
      }
    }
    state.version = STATE_VERSION;
    saveState(statePath, state);
    result.migrated = true;
    result.migratedCount = entries.length;
    // fall through: the delivery loop below now skips every entry (all in
    // drainedIds) → deliveredCount stays 0 on the migration sweep.
  }

  for (const entry of entries) {
    if (drainedIds.has(entry.id)) {
      result.skippedCount += 1;
      continue;
    }

    const ok = await deliver(
      { title, body: entry.body, source, priority },
      notifyUrl,
    );

    if (!ok) {
      result.failedCount += 1;
      continue;
    }

    const at = now();
    drainedIds.add(entry.id);
    state.drained.push({ id: entry.id, at });
    // Persist drained-state after each success so a crash mid-drain never
    // re-sends what already went out. The archive is best-effort history and
    // must never gate the exactly-once guarantee, so a failure to append is
    // swallowed rather than left to re-send the entry.
    saveState(statePath, state);
    try {
      appendArchive(archivePath, entry, at);
    } catch {
      // Archive is durable operator history, not the dedup source of truth.
    }
    result.delivered.push(entry);
    result.deliveredCount += 1;
  }

  return result;
}
