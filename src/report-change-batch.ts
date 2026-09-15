import { createHash } from "node:crypto";
const QUIET_DEBOUNCE_MS = 60_000;
const MAX_BATCH_LATENCY_MS = 120_000;
const MIN_DELIVERY_INTERVAL_MS = 60_000;
const MAX_SEEN_HEADERS = 4_096;
const MAX_RECENT_HEADER_LINES = 256;
interface RememberedHeader {
  hash: string;
  line: string;
}
export interface ReportChangeBatchState {
  contentFingerprint: string;
  seenHeaderHashes: string[];
  currentHeaderHashes: string[];
  recentHeaders: RememberedHeader[];
  pendingHeaders: string[];
  pendingHeaderHashes: string[];
  pendingStartedAtMs?: number;
  pendingLastChangedAtMs?: number;
  lastDeliveredAtMs?: number;
}
export type ReportChangeBatchAction =
  | { kind: "none" }
  | { kind: "passthrough" }
  | { kind: "defer"; retryAtMs: number }
  | { kind: "deliver"; headers: string[] }
  | { kind: "lost"; count: number; headers: string[] };
export function isReportChangeBatchState(
  value: unknown,
): value is ReportChangeBatchState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const state = value as Partial<ReportChangeBatchState>;
  const stringArray = (candidate: unknown): candidate is string[] =>
    Array.isArray(candidate) &&
    candidate.every((entry) => typeof entry === "string");
  const optionalNumber = (candidate: unknown): boolean =>
    candidate === undefined ||
    (typeof candidate === "number" && Number.isFinite(candidate));
  return (
    typeof state.contentFingerprint === "string" &&
    stringArray(state.seenHeaderHashes) &&
    state.seenHeaderHashes.length <= MAX_SEEN_HEADERS &&
    stringArray(state.currentHeaderHashes) &&
    state.currentHeaderHashes.length <= MAX_SEEN_HEADERS &&
    Array.isArray(state.recentHeaders) &&
    state.recentHeaders.length <= MAX_RECENT_HEADER_LINES &&
    state.recentHeaders.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as RememberedHeader).hash === "string" &&
        typeof (entry as RememberedHeader).line === "string",
    ) &&
    stringArray(state.pendingHeaders) &&
    state.pendingHeaders.length <= MAX_SEEN_HEADERS &&
    stringArray(state.pendingHeaderHashes) &&
    state.pendingHeaderHashes.length <= MAX_SEEN_HEADERS &&
    state.pendingHeaders.length === state.pendingHeaderHashes.length &&
    (state.pendingStartedAtMs === undefined) ===
      (state.pendingLastChangedAtMs === undefined) &&
    (state.pendingHeaders.length === 0) ===
      (state.pendingStartedAtMs === undefined) &&
    optionalNumber(state.pendingStartedAtMs) &&
    optionalNumber(state.pendingLastChangedAtMs) &&
    optionalNumber(state.lastDeliveredAtMs)
  );
}
function fingerprint(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
function headerHash(line: string): string {
  return createHash("sha256").update(line).digest("hex");
}
function reportHeaders(content: string): RememberedHeader[] {
  const headers: RememberedHeader[] = [];
  let fence: "```" | "~~~" | null = null;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const structural = line.trimStart();
    const fenceMatch = structural.match(/^(```|~~~)/);
    if (fenceMatch) {
      const marker = fenceMatch[1] as "```" | "~~~";
      fence = fence === null ? marker : fence === marker ? null : fence;
      continue;
    }
    if (fence !== null || !/^###\s+\S/.test(structural)) continue;
    headers.push({ hash: headerHash(line), line });
  }
  return headers;
}
function uniqueHeaders(headers: RememberedHeader[]): RememberedHeader[] {
  const seen = new Set<string>();
  return headers.filter((header) => {
    if (seen.has(header.hash)) return false;
    seen.add(header.hash);
    return true;
  });
}
function boundedTail<T>(values: T[], limit: number): T[] {
  return values.length <= limit ? values : values.slice(values.length - limit);
}
function mergeUniqueHashes(
  previous: string[],
  additions: string[],
): string[] {
  const merged = [...previous];
  const known = new Set(previous);
  for (const hash of additions) {
    if (known.has(hash)) continue;
    known.add(hash);
    merged.push(hash);
  }
  return boundedTail(merged, MAX_SEEN_HEADERS);
}
function mergeRecentHeaders(
  previous: RememberedHeader[],
  current: RememberedHeader[],
): RememberedHeader[] {
  const merged = [...previous];
  const positions = new Map(
    merged.map((header, index) => [header.hash, index] as const),
  );
  for (const header of current) {
    const position = positions.get(header.hash);
    if (position === undefined) {
      positions.set(header.hash, merged.length);
      merged.push(header);
    } else {
      merged[position] = header;
    }
  }
  return boundedTail(merged, MAX_RECENT_HEADER_LINES);
}
function authorContainsOwnerToken(header: string, owner: string): boolean {
  const arrow = header.indexOf("→");
  if (arrow < 0) return false;
  const author = header.slice(0, arrow).replace(/^\s*###\s*/, "");
  const tokens = author.split(/[^\p{L}\p{N}_-]+/u).filter(Boolean);
  return tokens.includes(owner);
}
export function createReportChangeBatchState(
  content: string | Buffer,
): ReportChangeBatchState {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const headers = boundedTail(
    uniqueHeaders(reportHeaders(bytes.toString("utf8"))),
    MAX_SEEN_HEADERS,
  );
  return {
    contentFingerprint: fingerprint(bytes),
    seenHeaderHashes: headers.map((header) => header.hash),
    currentHeaderHashes: headers.map((header) => header.hash),
    recentHeaders: boundedTail(headers, MAX_RECENT_HEADER_LINES),
    pendingHeaders: [],
    pendingHeaderHashes: [],
  };
}
export function advanceReportChangeBatch(
  previous: ReportChangeBatchState,
  input: { content: string | Buffer; owner: string; observedAtMs: number },
): { state: ReportChangeBatchState; action: ReportChangeBatchAction } {
  const bytes = Buffer.isBuffer(input.content)
    ? input.content
    : Buffer.from(input.content);
  const nextFingerprint = fingerprint(bytes);
  const contentChanged = nextFingerprint !== previous.contentFingerprint;
  const currentHeaders = boundedTail(
    uniqueHeaders(reportHeaders(bytes.toString("utf8"))),
    MAX_SEEN_HEADERS,
  );
  const currentHashes = currentHeaders.map((header) => header.hash);
  const currentHashSet = new Set(currentHashes);
  const previousCurrentSet = new Set(previous.currentHeaderHashes);
  const seenSet = new Set(previous.seenHeaderHashes);
  const newHeaders = contentChanged
    ? currentHeaders.filter((header) => !seenSet.has(header.hash))
    : [];
  // Once both snapshots hit the cap, set eviction is indistinguishable from
  // deletion. Prefer a missed lost-entry alert over a false destructive alert.
  const lostHashes =
    contentChanged &&
    (previous.currentHeaderHashes.length < MAX_SEEN_HEADERS ||
      currentHashes.length < MAX_SEEN_HEADERS)
      ? previous.currentHeaderHashes.filter((hash) => !currentHashSet.has(hash))
      : [];
  const recentByHash = new Map(
    previous.recentHeaders.map((header) => [header.hash, header.line] as const),
  );
  const retainedNewHeaders = newHeaders.filter(
    (header) => !authorContainsOwnerToken(header.line, input.owner),
  );
  const pendingHeaders = [...previous.pendingHeaders];
  const pendingHashes = new Set(previous.pendingHeaderHashes);
  for (const header of retainedNewHeaders) {
    if (pendingHashes.has(header.hash)) continue;
    pendingHashes.add(header.hash);
    pendingHeaders.push(header.line);
  }
  const addedPending = retainedNewHeaders.some(
    (header) => !previous.pendingHeaderHashes.includes(header.hash),
  );
  const pendingStartedAtMs =
    pendingHeaders.length > 0
      ? (previous.pendingStartedAtMs ?? input.observedAtMs)
      : undefined;
  const pendingLastChangedAtMs = addedPending
    ? input.observedAtMs
    : previous.pendingLastChangedAtMs;
  const boundedPendingHeaders = boundedTail(pendingHeaders, MAX_SEEN_HEADERS);
  const boundedPendingHashes = boundedTail(
    [...pendingHashes],
    MAX_SEEN_HEADERS,
  );
  const state: ReportChangeBatchState = {
    ...previous,
    contentFingerprint: nextFingerprint,
    seenHeaderHashes: mergeUniqueHashes(
      previous.seenHeaderHashes,
      newHeaders.map((header) => header.hash),
    ),
    currentHeaderHashes: currentHashes,
    recentHeaders: mergeRecentHeaders(previous.recentHeaders, currentHeaders),
    pendingHeaders: boundedPendingHeaders,
    pendingHeaderHashes: boundedPendingHashes,
    ...(pendingStartedAtMs === undefined ? {} : { pendingStartedAtMs }),
    ...(pendingLastChangedAtMs === undefined
      ? {}
      : { pendingLastChangedAtMs }),
  };
  if (lostHashes.length > 0) {
    return {
      state,
      action: {
        kind: "lost",
        count: lostHashes.length,
        headers: lostHashes
          .map((hash) => recentByHash.get(hash))
          .filter((line): line is string => line !== undefined),
      },
    };
  }
  if (
    state.pendingHeaders.length === 0 ||
    state.pendingStartedAtMs === undefined ||
    state.pendingLastChangedAtMs === undefined
  ) {
    const hadOrHasHeaders =
      previousCurrentSet.size > 0 || currentHashSet.size > 0;
    return {
      state,
      action:
        contentChanged && !hadOrHasHeaders
          ? { kind: "passthrough" }
          : { kind: "none" },
    };
  }
  const quietDueAt = state.pendingLastChangedAtMs + QUIET_DEBOUNCE_MS;
  const starvationDueAt = state.pendingStartedAtMs + MAX_BATCH_LATENCY_MS;
  const spacingDueAt =
    (state.lastDeliveredAtMs ?? Number.NEGATIVE_INFINITY) +
    MIN_DELIVERY_INTERVAL_MS;
  const retryAtMs = Math.max(
    Math.min(quietDueAt, starvationDueAt),
    spacingDueAt,
  );
  return {
    state,
    action:
      input.observedAtMs >= retryAtMs
        ? { kind: "deliver", headers: [...state.pendingHeaders] }
        : { kind: "defer", retryAtMs },
  };
}
export function settleReportChangeBatch(
  state: ReportChangeBatchState,
  deliveredAtMs: number,
): ReportChangeBatchState {
  const {
    pendingStartedAtMs: _pendingStarted,
    pendingLastChangedAtMs: _pendingChanged,
    ...settled
  } = state;
  return {
    ...settled,
    pendingHeaders: [],
    pendingHeaderHashes: [],
    lastDeliveredAtMs: deliveredAtMs,
  };
}
