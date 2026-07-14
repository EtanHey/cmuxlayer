import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unwatchFile,
  watchFile,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  DEFAULT_AGENT_HEALTH_ISSUE_SEVERITY,
  type AgentHealthIssueCode,
  type AgentHealthIssueSeverity,
  type AgentHealthStatus,
} from "./agent-health.js";
import type { AgentRole } from "./agent-types.js";
import type { ParsedScreenStatus } from "./types.js";

export type FleetScreenState = "working" | "idle" | "stalled";
export type FleetLaneKey =
  | "orc"
  | "golems"
  | "voicelayer"
  | "skillCreator"
  | "cmuxlayer"
  | "other";

export interface FleetSidebarCandidate {
  agentId: string;
  /** Stable cmux UUID. Absent only for legacy/ref-only compatibility. */
  surfaceUuid?: string;
  surfaceRef: string;
  surfaceTitle: string | null;
  repo: string;
  seatLane: string | null;
  seatId: string | null;
  launcherName: string | null;
  role: AgentRole | null;
  discovered: boolean;
  registryVersion: number;
  registryUpdatedAt: string;
  createdAt: string;
  taskSummary: string | null;
  healthStatus: AgentHealthStatus;
  healthReasons: string[];
  healthIssueCodes: AgentHealthIssueCode[];
  healthIssueSeverities: Partial<
    Record<AgentHealthIssueCode, AgentHealthIssueSeverity>
  >;
  screenCurrentAction: string | null;
  screenStatus: ParsedScreenStatus | null;
}

export interface FleetSidebarSeat {
  agentId: string;
  /** Stable focus and deduplication handle (ref fallback for legacy clients). */
  surfaceUuid: string;
  surfaceRef: string;
  name: string;
  lane: FleetLaneKey;
  role: "lead" | "worker";
  screenState: FleetScreenState;
  status: string;
  statusMissing: boolean;
  healthStatus: AgentHealthStatus;
  healthVisible: boolean;
  health: string;
  createdAtEpoch: number;
}

export interface FleetSidebarLane {
  key: FleetLaneKey;
  label: string;
  liveCount: number;
  activeCount: number;
  collapsed: boolean;
  seats: FleetSidebarSeat[];
}

export interface FleetSidebarSnapshot {
  seatCount: number;
  activeCount: number;
  lanes: FleetSidebarLane[];
}

export type FleetSidebarPublicationState =
  | "discovering"
  | "populated"
  | "empty"
  | "unknown";

export interface FleetSidebarPublication {
  state: FleetSidebarPublicationState;
  snapshot: FleetSidebarSnapshot;
  /** Null means surface enumeration was inconclusive. */
  observedLiveSurfaceRefs: string[] | null;
  /** Stable identities from the same observation; omitted by legacy callers. */
  observedLiveSurfaceUuids?: string[] | null;
}

export type FleetSidebarCollapseState = Partial<
  Record<FleetLaneKey, boolean>
>;

const LANE_ORDER: FleetLaneKey[] = [
  "orc",
  "golems",
  "voicelayer",
  "skillCreator",
  "cmuxlayer",
  "other",
];

const COLLAPSE_LOCK_RETRY_MS = 10;
const COLLAPSE_LOCK_STALE_MS = 2_000;
const COLLAPSE_LOCK_TIMEOUT_MS = 5_000;
const COLLAPSE_LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

const LANE_LABELS: Record<FleetLaneKey, string> = {
  orc: "orc",
  golems: "golems",
  voicelayer: "voicelayer",
  skillCreator: "skillCreator",
  cmuxlayer: "cmuxlayer",
  other: "other",
};

const NON_ACTIONABLE_SIDEBAR_HEALTH_CODES = new Set<AgentHealthIssueCode>([
  "auto_discovered_agent",
  "missing_cli_session_id",
  "non_resumable",
  "inbox_monitor_not_alive",
  "seat_identity_mismatch",
  "non_claude_orchestrator",
  "orchestrator_not_leftmost",
  "worker_in_leftmost_column",
  "registry_surface_workspace_mismatch",
]);

export function toFleetScreenState(
  status: ParsedScreenStatus | null | undefined,
): FleetScreenState {
  if (status === "thinking" || status === "working") return "working";
  if (status === "idle" || status === "done") return "idle";
  return "stalled";
}

function normalizedIdentity(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function inferLane(candidate: FleetSidebarCandidate): FleetLaneKey {
  const identities = [
    candidate.seatLane,
    candidate.repo,
    candidate.seatId,
    candidate.launcherName,
    candidate.agentId,
    candidate.surfaceTitle,
  ].map(normalizedIdentity);

  for (const value of identities) {
    if (value.includes("golems")) return "golems";
    if (value.includes("voicelayer")) return "voicelayer";
    if (value.includes("skillcreator")) return "skillCreator";
    if (value.includes("cmuxlayer")) return "cmuxlayer";
    if (value === "orc" || value.startsWith("orc")) return "orc";
  }
  return "other";
}

function candidateRank(candidate: FleetSidebarCandidate): [number, number, number] {
  const updatedAt = Date.parse(candidate.registryUpdatedAt);
  return [
    candidate.discovered ? 0 : 1,
    candidate.registryVersion,
    Number.isFinite(updatedAt) ? updatedAt : 0,
  ];
}

function preferCandidate(
  current: FleetSidebarCandidate,
  next: FleetSidebarCandidate,
): FleetSidebarCandidate {
  const currentRank = candidateRank(current);
  const nextRank = candidateRank(next);
  for (let index = 0; index < currentRank.length; index += 1) {
    if (nextRank[index]! > currentRank[index]!) return next;
    if (nextRank[index]! < currentRank[index]!) return current;
  }
  return next.agentId.localeCompare(current.agentId) < 0 ? next : current;
}

function statusFor(candidate: FleetSidebarCandidate): {
  status: string;
  statusMissing: boolean;
} {
  const value = candidate.taskSummary?.trim() ?? "";
  const missing =
    value.length === 0 ||
    /^\((?:resync-repaired|auto-discovered|unknown)\)$/i.test(value);
  if (!missing) {
    return { status: value, statusMissing: false };
  }
  const currentAction = candidate.screenCurrentAction?.trim() ?? "";
  if (currentAction) {
    return { status: currentAction, statusMissing: false };
  }
  return {
    status: "— no status",
    statusMissing: true,
  };
}

function actionableHealthReasons(
  candidate: FleetSidebarCandidate,
): string[] {
  return candidate.healthIssueCodes.flatMap((code, index) => {
    if (NON_ACTIONABLE_SIDEBAR_HEALTH_CODES.has(code)) return [];
    const severity =
      candidate.healthIssueSeverities[code] ??
      DEFAULT_AGENT_HEALTH_ISSUE_SEVERITY[code];
    const reason = candidate.healthReasons[index]?.trim();
    return severity === "info" || !reason ? [] : [reason];
  });
}

function candidateName(candidate: FleetSidebarCandidate): string {
  return (
    candidate.surfaceTitle?.trim() ||
    candidate.seatId?.trim() ||
    candidate.launcherName?.trim() ||
    candidate.agentId
  );
}

function seatFor(candidate: FleetSidebarCandidate): FleetSidebarSeat {
  const { status, statusMissing } = statusFor(candidate);
  const createdAt = Date.parse(candidate.createdAt);
  const name = candidateName(candidate);
  const healthReasons = actionableHealthReasons(candidate);
  const role =
    candidate.role === "orchestrator" || /\b(?:lead|orchestrator)\b/i.test(name)
      ? "lead"
      : "worker";
  return {
    agentId: candidate.agentId,
    surfaceUuid: candidate.surfaceUuid ?? candidate.surfaceRef,
    surfaceRef: candidate.surfaceRef,
    name,
    lane: inferLane(candidate),
    role,
    screenState: toFleetScreenState(candidate.screenStatus),
    status,
    statusMissing,
    healthStatus: candidate.healthStatus,
    healthVisible: healthReasons.length > 0,
    health: healthReasons.join(" · "),
    createdAtEpoch: Number.isFinite(createdAt)
      ? Math.floor(createdAt / 1_000)
      : 0,
  };
}

function compareSeats(left: FleetSidebarSeat, right: FleetSidebarSeat): number {
  if (left.role !== right.role) return left.role === "lead" ? -1 : 1;
  const byName = left.name.localeCompare(right.name, undefined, {
    sensitivity: "base",
  });
  return byName || left.surfaceRef.localeCompare(right.surfaceRef);
}

export function buildFleetSidebarSnapshot(
  candidates: FleetSidebarCandidate[],
  opts: {
    liveSurfaceRefs: ReadonlySet<string>;
    liveSurfaceUuids?: ReadonlySet<string>;
  },
): FleetSidebarSnapshot {
  const candidateBySurface = new Map<string, FleetSidebarCandidate>();
  for (const candidate of candidates) {
    if (!opts.liveSurfaceRefs.has(candidate.surfaceRef)) continue;
    if (
      candidate.surfaceUuid &&
      opts.liveSurfaceUuids &&
      !opts.liveSurfaceUuids.has(candidate.surfaceUuid)
    ) {
      continue;
    }
    const bindingKey = candidate.surfaceUuid ?? candidate.surfaceRef;
    const existing = candidateBySurface.get(bindingKey);
    candidateBySurface.set(
      bindingKey,
      existing ? preferCandidate(existing, candidate) : candidate,
    );
  }

  const seats = [...candidateBySurface.values()].map(seatFor);
  const lanes = LANE_ORDER.flatMap((key): FleetSidebarLane[] => {
    const laneSeats = seats
      .filter((seat) => seat.lane === key)
      .sort(compareSeats);
    if (laneSeats.length === 0) return [];
    const activeCount = laneSeats.filter(
      (seat) => seat.screenState !== "idle",
    ).length;
    return [
      {
        key,
        label: LANE_LABELS[key],
        liveCount: laneSeats.length,
        activeCount,
        collapsed: activeCount === 0,
        seats: laneSeats,
      },
    ];
  });

  return {
    seatCount: seats.length,
    activeCount: seats.filter((seat) => seat.screenState !== "idle").length,
    lanes,
  };
}

function swiftString(value: string): string {
  return JSON.stringify(value);
}

function renderSeat(seat: FleetSidebarSeat): string {
  return `    [
      "agentId": ${swiftString(seat.agentId)},
      "surfaceUuid": ${swiftString(seat.surfaceUuid)},
      "surfaceRef": ${swiftString(seat.surfaceRef)},
      "name": ${swiftString(seat.name)},
      "role": ${swiftString(seat.role)},
      "screenState": ${swiftString(seat.screenState)},
      "status": ${swiftString(seat.status)},
      "statusMissing": ${seat.statusMissing},
      "healthStatus": ${swiftString(seat.healthStatus)},
      "healthVisible": ${seat.healthVisible},
      "health": ${swiftString(seat.health)},
      "createdAtEpoch": ${seat.createdAtEpoch}
    ]`;
}

function renderLeadSummary(lane: FleetSidebarLane): string {
  const lead = lane.seats.find((seat) => seat.role === "lead");
  return `[
      "present": ${lead !== undefined},
      "name": ${swiftString(lead?.name ?? "No lead assigned")},
      "screenState": ${swiftString(lead?.screenState ?? "idle")},
      "status": ${swiftString(lead?.status ?? "— no lead status")},
      "statusMissing": ${lead?.statusMissing ?? true}
    ]`;
}

export function applyFleetSidebarCollapseState(
  snapshot: FleetSidebarSnapshot,
  state: Readonly<FleetSidebarCollapseState>,
): FleetSidebarSnapshot {
  return {
    ...snapshot,
    lanes: snapshot.lanes.map((lane) => ({
      ...lane,
      collapsed: state[lane.key] ?? lane.collapsed,
    })),
  };
}

const FLEET_SWIFT_HELPERS = `func fleetSeatAge(_ createdAtEpoch, _ nowEpoch) -> String {
  let age = max(0, nowEpoch - createdAtEpoch)
  if age < 60 { return "seat <1m" }
  if age < 3600 { return "seat \\(age / 60)m" }
  if age < 86400 { return "seat \\(age / 3600)h" }
  return "seat \\(age / 86400)d"
}

func fleetState(_ state) -> some View {
  HStack(spacing: 4) {
    if state == "working" {
      Text("●").foregroundColor("#3B82F6")
      Text("working").foregroundColor("#3B82F6")
    } else {
      if state == "idle" {
        Text("●").foregroundColor("#6B7280")
        Text("idle").foregroundColor("#6B7280")
      } else {
        Text("●").foregroundColor("#EF4444")
        Text("stalled").foregroundColor("#EF4444")
      }
    }
  }
  .font(.system(size: 9, design: .monospaced))
}

func fleetRow(_ seat) -> some View {
  Button(action: { cmux("surface.focus", surface_id: seat.surfaceUuid) }) {
    VStack(alignment: .leading, spacing: 3) {
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        fleetState(seat.screenState)
        Text(seat.name).font(.system(size: 12)).fontWeight(seat.role == "lead" ? .semibold : .regular)
        Spacer()
        Text(fleetSeatAge(seat.createdAtEpoch, clock.epoch))
          .font(.system(size: 9, design: .monospaced))
          .foregroundColor(.tertiary)
      }
      Text(seat.status)
        .font(.system(size: 10))
        .foregroundColor(seat.statusMissing ? .tertiary : .secondary)
        .lineLimit(1)
        .truncationMode(.tail)
      if seat.healthVisible {
        Text("health: \\(seat.health)")
          .font(.system(size: 9))
          .foregroundColor(seat.healthStatus == "unhealthy" ? "#EF4444" : "#F59E0B")
      }
    }
    .padding(6)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background {
      RoundedRectangle(cornerRadius: 6)
        .foregroundColor(seat.role == "lead" ? "#3B82F6" : "#6B7280")
        .opacity(seat.role == "lead" ? 0.10 : 0.05)
    }
  }
}

func fleetLeadSummary(_ lead) -> some View {
  HStack(spacing: 4) {
    if lead.present {
      if lead.screenState == "working" {
        Text("●").foregroundColor("#3B82F6")
      } else {
        if lead.screenState == "idle" {
          Text("●").foregroundColor("#6B7280")
        } else {
          Text("●").foregroundColor("#EF4444")
        }
      }
      Text("LEAD")
        .font(.system(size: 8, design: .monospaced))
        .fontWeight(.semibold)
        .foregroundColor("#3B82F6")
      Text(lead.name)
        .font(.system(size: 9))
        .fontWeight(.semibold)
        .lineLimit(1)
      Text("·").foregroundColor(.tertiary)
      Text(lead.status)
        .font(.system(size: 9))
        .foregroundColor(lead.statusMissing ? .tertiary : .secondary)
        .lineLimit(1)
        .truncationMode(.tail)
      Spacer()
    } else {
      Text("LEAD · not assigned")
        .font(.system(size: 9))
        .foregroundColor(.tertiary)
      Spacer()
    }
  }
  .padding(4)
  .background {
    RoundedRectangle(cornerRadius: 5)
      .foregroundColor("#3B82F6")
      .opacity(0.07)
  }
}

func fleetLaneHeader(_ name, _ liveCount, _ activeCount, _ collapsed) -> some View {
  VStack(alignment: .leading, spacing: 2) {
    HStack(spacing: 6) {
      Text(collapsed ? "collapsed" : "expanded")
        .font(.system(size: 9, design: .monospaced))
        .foregroundColor(.tertiary)
      Text(name).font(.system(size: 11)).fontWeight(.semibold)
      Spacer()
      Text("\\(liveCount) live · \\(activeCount) active")
        .font(.system(size: 9, design: .monospaced))
        .foregroundColor(.secondary)
    }
    Text(collapsed ? "CLI · cmuxlayer fleet-sidebar expand \\(name)" : "CLI · cmuxlayer fleet-sidebar collapse \\(name)")
      .font(.system(size: 8, design: .monospaced))
      .foregroundColor(.tertiary)
      .lineLimit(1)
      .truncationMode(.tail)
  }
  .padding(4)
  .accessibilityLabel(collapsed ? "\\(name) lane collapsed, \\(liveCount) live, \\(activeCount) active" : "\\(name) lane expanded, \\(liveCount) live, \\(activeCount) active")
  .help(collapsed ? "Run cmuxlayer fleet-sidebar expand \\(name)" : "Run cmuxlayer fleet-sidebar collapse \\(name)")
}

func fleetLane(_ name, _ liveCount, _ activeCount, _ collapsed, _ hiddenSeatCount, _ lead, _ seats) -> some View {
  VStack(alignment: .leading, spacing: 3) {
    fleetLaneHeader(name, liveCount, activeCount, collapsed)
    if collapsed {
      Text("\\(hiddenSeatCount) seats hidden")
        .font(.system(size: 9))
        .foregroundColor(.tertiary)
        .padding(2)
      fleetLeadSummary(lead)
    } else {
      ForEach(seats) { seat in
        fleetRow(seat)
      }
    }
  }
}`;

export function renderFleetSidebar(
  snapshot: FleetSidebarSnapshot,
  opts: {
    state?: FleetSidebarPublicationState;
    observedLiveSurfaceCount?: number | null;
  } = {},
): string {
  const state =
    opts.state ?? (snapshot.seatCount > 0 ? "populated" : "discovering");
  const laneCalls = snapshot.lanes
    .map((lane) => {
      const seats = lane.collapsed
        ? ""
        : lane.seats.map(renderSeat).join(",\n");
      const hiddenSeatCount = lane.collapsed ? lane.liveCount : 0;
      return `  fleetLane(${swiftString(lane.label)}, ${lane.liveCount}, ${lane.activeCount}, ${lane.collapsed}, ${hiddenSeatCount}, ${renderLeadSummary(lane)}, [\n${seats}\n  ])`;
    })
    .join("\n  Divider()\n");

  const emptyContent =
    state === "empty"
      ? `  Text("No live fleet seats")
    .font(.system(size: 11))
    .foregroundColor(.secondary)
    .padding(6)`
      : state === "unknown"
        ? `  VStack(alignment: .leading, spacing: 2) {
    Text("Fleet topology unavailable")
      .font(.system(size: 11))
      .foregroundColor(.secondary)
    Text("Keeping the last populated fleet until discovery recovers.")
      .font(.system(size: 9))
      .foregroundColor(.tertiary)
  }
    .padding(6)`
        : `  VStack(alignment: .leading, spacing: 2) {
    Text("Discovering fleet seats…")
      .font(.system(size: 11))
      .foregroundColor(.secondary)
    Text("Reconnect discovery populates this view automatically.")
      .font(.system(size: 9))
      .foregroundColor(.tertiary)
  }
    .padding(6)`;

  const content = snapshot.lanes.length === 0 ? emptyContent : laneCalls;
  const observed = opts.observedLiveSurfaceCount;
  const observedMetadata =
    observed === null ||
    (observed === undefined &&
      (state === "discovering" || state === "unknown"))
      ? "unknown"
      : (observed ?? snapshot.seatCount);
  const renderedSurfaceRefs = snapshot.lanes.flatMap((lane) =>
    lane.seats.map((seat) => seat.surfaceRef),
  );
  const renderedSurfaceUuids = snapshot.lanes.flatMap((lane) =>
    lane.seats.map((seat) => seat.surfaceUuid),
  );

  return `// cmuxlayer-fleet-state: ${state} rendered=${snapshot.seatCount} observed=${observedMetadata} surfaces=${JSON.stringify(renderedSurfaceRefs)} surfaceIds=${JSON.stringify(renderedSurfaceUuids)}
${FLEET_SWIFT_HELPERS}

ScrollView {
VStack(alignment: .leading, spacing: 6) {
  HStack {
    Text("Fleet").font(.system(size: 13)).bold()
    Spacer()
    Text("${snapshot.seatCount} live seats · ${snapshot.activeCount} active")
      .font(.system(size: 9, design: .monospaced))
      .foregroundColor(.secondary)
  }
  .padding(4)
  Divider()
${content}
  Spacer()
}
}
`;
}

export function defaultFleetSidebarPath(home = homedir()): string {
  return join(home, ".config", "cmux", "sidebars", "fleet.swift");
}

export function defaultFleetSidebarDevPath(home = homedir()): string {
  return join(home, ".config", "cmux", "sidebars", "fleet-dev.swift");
}

export function defaultFleetSidebarCollapseStatePath(home = homedir()): string {
  return join(
    home,
    ".local",
    "state",
    "cmuxlayer",
    "fleet-sidebar-collapse.json",
  );
}

export interface FleetSidebarCollapseStoreOptions {
  statePath?: string;
}

export class FleetSidebarCollapseStore {
  private readonly statePath: string;

  constructor(opts: FleetSidebarCollapseStoreOptions = {}) {
    this.statePath =
      opts.statePath ?? defaultFleetSidebarCollapseStatePath();
  }

  getStatePath(): string {
    return this.statePath;
  }

  read(): FleetSidebarCollapseState {
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as {
        version?: unknown;
        lanes?: unknown;
      };
      if (parsed.version !== 1 || !isRecord(parsed.lanes)) return {};
      const state: FleetSidebarCollapseState = {};
      for (const key of LANE_ORDER) {
        const value = parsed.lanes[key];
        if (typeof value === "boolean") state[key] = value;
      }
      return state;
    } catch {
      return {};
    }
  }

  setLaneCollapsed(key: FleetLaneKey, collapsed: boolean): void {
    this.withMutationLock(() => {
      this.write({ ...this.read(), [key]: collapsed });
    });
  }

  toggleLane(key: FleetLaneKey, currentCollapsed?: boolean): boolean {
    return this.withMutationLock(() => {
      const state = this.read();
      const collapsed = !(state[key] ?? currentCollapsed ?? false);
      this.write({ ...state, [key]: collapsed });
      return collapsed;
    });
  }

  private withMutationLock<T>(mutate: () => T): T {
    const lockPath = `${this.statePath}.lock`;
    const lockOwnerPath = join(
      lockPath,
      `.owner.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`,
    );
    const startedAt = Date.now();
    mkdirSync(dirname(this.statePath), { recursive: true });
    while (true) {
      try {
        mkdirSync(lockPath);
        writeFileSync(lockOwnerPath, "", "utf8");
        break;
      } catch (error) {
        if (!isFileExistsError(error)) throw error;
        this.clearStaleMutationLock(lockPath);
        if (Date.now() - startedAt >= COLLAPSE_LOCK_TIMEOUT_MS) {
          throw new Error(
            `Timed out waiting for Fleet collapse state lock: ${lockPath}`,
          );
        }
        Atomics.wait(
          COLLAPSE_LOCK_SLEEP,
          0,
          0,
          COLLAPSE_LOCK_RETRY_MS,
        );
      }
    }

    try {
      return mutate();
    } finally {
      this.releaseMutationLock(lockPath, lockOwnerPath);
    }
  }

  private releaseMutationLock(lockPath: string, lockOwnerPath: string): void {
    try {
      rmSync(lockOwnerPath);
    } catch {
      // The owned lock was quarantined; do not touch a replacement lock.
      return;
    }
    try {
      rmdirSync(lockPath);
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT", "ENOTEMPTY")) throw error;
      // A stale-lock takeover raced cleanup and now owns this path.
    }
  }

  private clearStaleMutationLock(lockPath: string): void {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs < COLLAPSE_LOCK_STALE_MS) {
        return;
      }
      const stalePath =
        `${lockPath}.stale.${process.pid}.${Date.now()}.` +
        Math.random().toString(16).slice(2);
      renameSync(lockPath, stalePath);
      rmSync(stalePath, { recursive: true, force: true });
    } catch {
      // Another process released, acquired, or quarantined the lock first.
    }
  }

  private write(state: FleetSidebarCollapseState): void {
    const outputDir = dirname(this.statePath);
    const temporaryPath = join(
      outputDir,
      `.${basename(this.statePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    mkdirSync(outputDir, { recursive: true });
    try {
      writeFileSync(
        temporaryPath,
        `${JSON.stringify({ version: 1, lanes: state }, null, 2)}\n`,
        "utf8",
      );
      renameSync(temporaryPath, this.statePath);
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      throw error;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileExistsError(error: unknown): error is NodeJS.ErrnoException {
  return isFileSystemError(error, "EEXIST");
}

function isFileSystemError(
  error: unknown,
  ...codes: string[]
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    codes.includes((error as NodeJS.ErrnoException).code ?? "")
  );
}

export interface FleetSidebarPublisherLike {
  publish(publication: FleetSidebarPublication | FleetSidebarSnapshot): void;
  dispose(): void;
}

export interface FleetSidebarPublisherOptions {
  outputPath?: string;
  minWriteIntervalMs?: number;
  collapseStore?: FleetSidebarCollapseStore;
}

export class FleetSidebarPublisher implements FleetSidebarPublisherLike {
  private readonly outputPath: string;
  private readonly minWriteIntervalMs: number;
  private readonly collapseStore: FleetSidebarCollapseStore;
  private pendingSource: string | null = null;
  private pendingPublication: FleetSidebarPublication | null = null;
  private pendingBaselineSource: string | null = null;
  private lastPublishedPublication: FleetSidebarPublication | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly collapseStateListener = () => {
    const publication =
      this.pendingPublication ?? this.lastPublishedPublication;
    if (publication !== null) this.publish(publication);
  };

  constructor(opts: FleetSidebarPublisherOptions = {}) {
    const canonicalOutputPath = defaultFleetSidebarPath();
    this.outputPath =
      opts.outputPath ??
      process.env.CMUXLAYER_FLEET_SIDEBAR_OUTPUT_PATH ??
      canonicalOutputPath;
    if (process.env.VITEST === "true" && opts.outputPath === undefined) {
      throw new Error(
        "FleetSidebarPublisher tests must inject an explicit outputPath",
      );
    }
    if (
      process.env.VITEST === "true" &&
      this.outputPath === canonicalOutputPath
    ) {
      throw new Error(
        "FleetSidebarPublisher tests must inject a non-production outputPath",
      );
    }
    this.collapseStore =
      opts.collapseStore ??
      new FleetSidebarCollapseStore(
        this.outputPath === canonicalOutputPath
          ? {}
          : { statePath: `${this.outputPath}.collapse.json` },
      );
    this.minWriteIntervalMs = Math.max(
      500,
      opts.minWriteIntervalMs ?? 500,
    );
    watchFile(
      this.collapseStore.getStatePath(),
      { persistent: false, interval: 100 },
      this.collapseStateListener,
    );
  }

  publish(input: FleetSidebarPublication | FleetSidebarSnapshot): void {
    if (this.disposed) return;
    const publication = this.normalizePublication(input);
    const currentSource = this.readCurrentSource();
    if (
      this.pendingSource !== null &&
      !this.shouldPublish(publication, this.pendingBaselineSource)
    ) {
      if (this.pendingIsInvalidatedByObservation(publication)) {
        this.clearPending();
        this.clearTimer();
      }
      return;
    }
    const previousSource = this.pendingSource ?? currentSource;
    if (!this.shouldPublish(publication, previousSource)) return;
    if (
      this.pendingSource !== null &&
      currentSource !== this.pendingBaselineSource &&
      !this.shouldPublishOverNewerSource(publication, currentSource)
    ) {
      return;
    }

    const source = renderFleetSidebar(
      applyFleetSidebarCollapseState(
        publication.snapshot,
        this.collapseStore.read(),
      ),
      {
        state: publication.state,
        observedLiveSurfaceCount:
          publication.observedLiveSurfaceRefs?.length ?? null,
      },
    );
    if (currentSource === source) {
      this.lastPublishedPublication = publication;
      this.clearPending();
      this.clearTimer();
      return;
    }

    this.pendingSource = source;
    this.pendingPublication = publication;
    this.pendingBaselineSource = currentSource;
    this.flushOrSchedule();
  }

  dispose(): void {
    this.disposed = true;
    this.clearPending();
    this.lastPublishedPublication = null;
    unwatchFile(
      this.collapseStore.getStatePath(),
      this.collapseStateListener,
    );
    this.clearTimer();
  }

  private flushOrSchedule(): void {
    if (
      this.disposed ||
      this.pendingSource === null ||
      this.pendingPublication === null
    ) {
      return;
    }
    const waitMs = this.remainingWriteDelay();
    if (waitMs > 0) {
      if (this.timer === null) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.flushOrSchedule();
        }, waitMs);
        this.timer.unref?.();
      }
      return;
    }

    const source = this.pendingSource;
    const publication = this.pendingPublication;
    const baselineSource = this.pendingBaselineSource;
    this.clearPending();
    const currentSource = this.readCurrentSource();
    if (currentSource === source) {
      this.lastPublishedPublication = publication;
      return;
    }
    if (
      currentSource !== baselineSource &&
      !this.shouldPublishOverNewerSource(publication, currentSource)
    ) {
      return;
    }
    this.atomicWrite(source);
    this.lastPublishedPublication = publication;
  }

  private remainingWriteDelay(): number {
    try {
      const elapsedMs = Date.now() - statSync(this.outputPath).mtimeMs;
      return Math.max(0, Math.ceil(this.minWriteIntervalMs - elapsedMs));
    } catch {
      return 0;
    }
  }

  private readCurrentSource(): string | null {
    try {
      return readFileSync(this.outputPath, "utf8");
    } catch {
      return null;
    }
  }

  private normalizePublication(
    input: FleetSidebarPublication | FleetSidebarSnapshot,
  ): FleetSidebarPublication {
    if ("snapshot" in input) return input;
    const surfaceRefs = input.lanes.flatMap((lane) =>
      lane.seats.map((seat) => seat.surfaceRef),
    );
    return {
      state: input.seatCount > 0 ? "populated" : "empty",
      snapshot: input,
      observedLiveSurfaceRefs: surfaceRefs,
      observedLiveSurfaceUuids: input.lanes.flatMap((lane) =>
        lane.seats.map((seat) => seat.surfaceUuid),
      ),
    };
  }

  private observedBindingKeys(
    publication: FleetSidebarPublication,
  ): Set<string> | null {
    if (publication.observedLiveSurfaceUuids === null) return null;
    if (publication.observedLiveSurfaceUuids !== undefined) {
      const surfaceUuids = new Set(publication.observedLiveSurfaceUuids);
      const surfaceRefs = publication.observedLiveSurfaceRefs;
      if (
        surfaceRefs === null ||
        surfaceUuids.size !== new Set(surfaceRefs).size
      ) {
        return null;
      }
      return surfaceUuids;
    }
    return publication.observedLiveSurfaceRefs === null
      ? null
      : new Set(publication.observedLiveSurfaceRefs);
  }

  private snapshotBindingKeys(snapshot: FleetSidebarSnapshot): Set<string> {
    return new Set(
      snapshot.lanes.flatMap((lane) =>
        lane.seats.map((seat) => seat.surfaceUuid || seat.surfaceRef),
      ),
    );
  }

  private shouldPublish(
    publication: FleetSidebarPublication,
    previousSource: string | null,
  ): boolean {
    const previous = inspectFleetSidebarSource(previousSource);
    if (
      previous.state === "populated" &&
      (publication.state === "discovering" || publication.state === "unknown")
    ) {
      return false;
    }
    if (
      previous.state === "populated" &&
      this.observedBindingKeys(publication) === null
    ) {
      return false;
    }

    if (publication.state === "empty") {
      const observedBindingKeys = this.observedBindingKeys(publication);
      if (observedBindingKeys === null) return false;
      if (previous.state !== "populated") return true;
      const previousBindingKeys =
        previous.surfaceUuids.size > 0
          ? previous.surfaceUuids
          : previous.surfaceRefs;
      if (previousBindingKeys.size === 0) {
        return observedBindingKeys.size === 0;
      }
      for (const previousBindingKey of previousBindingKeys) {
        if (observedBindingKeys.has(previousBindingKey)) return false;
      }
      return true;
    }

    if (
      previous.state === "populated" &&
      publication.state === "populated" &&
      this.observedBindingKeys(publication) !== null
    ) {
      const nextBindingKeys = this.snapshotBindingKeys(publication.snapshot);
      const observedBindingKeys = this.observedBindingKeys(publication)!;
      const previousBindingKeys =
        previous.surfaceUuids.size > 0
          ? previous.surfaceUuids
          : previous.surfaceRefs;
      for (const previousBindingKey of previousBindingKeys) {
        if (
          !nextBindingKeys.has(previousBindingKey) &&
          observedBindingKeys.has(previousBindingKey)
        ) {
          return false;
        }
      }
    }

    return true;
  }

  private shouldPublishOverNewerSource(
    publication: FleetSidebarPublication,
    newerSource: string | null,
  ): boolean {
    const newer = inspectFleetSidebarSource(newerSource);
    if (newer.state === "populated") {
      if (publication.state !== "populated") return false;
      const nextBindingKeys = this.snapshotBindingKeys(publication.snapshot);
      const newerBindingKeys =
        newer.surfaceUuids.size > 0 ? newer.surfaceUuids : newer.surfaceRefs;
      for (const newerBindingKey of newerBindingKeys) {
        if (!nextBindingKeys.has(newerBindingKey)) return false;
      }
    }
    return this.shouldPublish(publication, newerSource);
  }

  private pendingIsInvalidatedByObservation(
    publication: FleetSidebarPublication,
  ): boolean {
    if (
      this.pendingPublication === null ||
      this.observedBindingKeys(publication) === null
    ) {
      return false;
    }
    const baseline = inspectFleetSidebarSource(this.pendingBaselineSource);
    if (baseline.state !== "populated") return false;

    const pendingBindingKeys = this.snapshotBindingKeys(
      this.pendingPublication.snapshot,
    );
    const observedBindingKeys = this.observedBindingKeys(publication)!;
    const baselineBindingKeys =
      baseline.surfaceUuids.size > 0
        ? baseline.surfaceUuids
        : baseline.surfaceRefs;
    if (baselineBindingKeys.size === 0) {
      return (
        this.pendingPublication.state === "empty" &&
        observedBindingKeys.size > 0
      );
    }
    for (const baselineBindingKey of baselineBindingKeys) {
      if (
        !pendingBindingKeys.has(baselineBindingKey) &&
        observedBindingKeys.has(baselineBindingKey)
      ) {
        return true;
      }
    }
    return false;
  }

  private atomicWrite(source: string): void {
    const outputDir = dirname(this.outputPath);
    const temporaryPath = join(
      outputDir,
      `.${basename(this.outputPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    try {
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(temporaryPath, source, "utf8");
      renameSync(temporaryPath, this.outputPath);
    } catch {
      try {
        rmSync(temporaryPath, { force: true });
      } catch {
        // Best effort: sidebar publication must never interrupt reconciliation.
      }
    }
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private clearPending(): void {
    this.pendingSource = null;
    this.pendingPublication = null;
    this.pendingBaselineSource = null;
  }
}

function inspectFleetSidebarSource(source: string | null): {
  state: FleetSidebarPublicationState | null;
  surfaceRefs: Set<string>;
  surfaceUuids: Set<string>;
} {
  if (!source) {
    return { state: null, surfaceRefs: new Set(), surfaceUuids: new Set() };
  }

  const surfaceRefs = new Set<string>();
  const surfaceUuids = new Set<string>();
  const surfaceRefPattern = /"surfaceRef":\s*("(?:\\.|[^"\\])*")/g;
  for (const match of source.matchAll(surfaceRefPattern)) {
    try {
      surfaceRefs.add(JSON.parse(match[1]!) as string);
    } catch {
      // Ignore malformed legacy rows; the rendered count remains a fallback.
    }
  }
  const surfaceUuidPattern = /"surfaceUuid":\s*("(?:\\.|[^"\\])*")/g;
  for (const match of source.matchAll(surfaceUuidPattern)) {
    try {
      surfaceUuids.add(JSON.parse(match[1]!) as string);
    } catch {
      // Ignore malformed rows and retain ref compatibility.
    }
  }
  const topologyMetadata = source.match(
    /^\/\/ cmuxlayer-fleet-state:[^\n]* surfaces=(\[[^\n]*?\])(?:\s|$)/,
  );
  if (topologyMetadata) {
    try {
      const metadataSurfaceRefs = JSON.parse(topologyMetadata[1]!) as unknown;
      if (Array.isArray(metadataSurfaceRefs)) {
        for (const surfaceRef of metadataSurfaceRefs) {
          if (typeof surfaceRef === "string") surfaceRefs.add(surfaceRef);
        }
      }
    } catch {
      // Ignore malformed metadata and retain the rendered-row fallback.
    }
  }
  const topologyIdMetadata = source.match(/\bsurfaceIds=(\[[^\n]*\])/);
  if (topologyIdMetadata) {
    try {
      const metadataSurfaceIds = JSON.parse(topologyIdMetadata[1]!) as unknown;
      if (Array.isArray(metadataSurfaceIds)) {
        for (const surfaceId of metadataSurfaceIds) {
          if (typeof surfaceId === "string") surfaceUuids.add(surfaceId);
        }
      }
    } catch {
      // Ignore malformed metadata and retain the rendered-row fallback.
    }
  }

  const metadata = source.match(
    /^\/\/ cmuxlayer-fleet-state: (discovering|populated|empty|unknown)\b/,
  );
  if (metadata) {
    return {
      state: metadata[1] as FleetSidebarPublicationState,
      surfaceRefs,
      surfaceUuids,
    };
  }

  const legacyCount = source.match(/Text\("(\d+) live seats ·/);
  return {
    state:
      surfaceRefs.size > 0 || Number(legacyCount?.[1] ?? 0) > 0
        ? "populated"
        : null,
    surfaceRefs,
    surfaceUuids,
  };
}
