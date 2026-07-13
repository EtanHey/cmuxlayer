import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
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

const LANE_ORDER: FleetLaneKey[] = [
  "orc",
  "golems",
  "voicelayer",
  "skillCreator",
  "cmuxlayer",
  "other",
];

const LANE_LABELS: Record<FleetLaneKey, string> = {
  orc: "orc",
  golems: "golems",
  voicelayer: "voicelayer",
  skillCreator: "skillCreator",
  cmuxlayer: "cmuxlayer",
  other: "other",
};

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
  opts: { liveSurfaceRefs: ReadonlySet<string> },
): FleetSidebarSnapshot {
  const candidateBySurface = new Map<string, FleetSidebarCandidate>();
  for (const candidate of candidates) {
    if (!opts.liveSurfaceRefs.has(candidate.surfaceRef)) continue;
    const existing = candidateBySurface.get(candidate.surfaceRef);
    candidateBySurface.set(
      candidate.surfaceRef,
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
  Button(action: { cmux("surface.focus", surface_id: seat.surfaceRef) }) {
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

func fleetLane(_ name, _ liveCount, _ activeCount, _ collapsed, _ seats) -> some View {
  VStack(alignment: .leading, spacing: 3) {
    HStack(spacing: 6) {
      Text(name).font(.system(size: 11)).fontWeight(.semibold)
      Spacer()
      Text("\\(liveCount) live · \\(activeCount) active")
        .font(.system(size: 9, design: .monospaced))
        .foregroundColor(.secondary)
    }
    .padding(4)
    if collapsed {
      Text("\\(liveCount) idle seats collapsed")
        .font(.system(size: 9))
        .foregroundColor(.tertiary)
        .padding(4)
    } else {
      ForEach(seats) { seat in
        fleetRow(seat)
      }
    }
  }
}`;

export function renderFleetSidebar(snapshot: FleetSidebarSnapshot): string {
  const laneCalls = snapshot.lanes
    .map((lane) => {
      const seats = lane.seats.map(renderSeat).join(",\n");
      return `  fleetLane(${swiftString(lane.label)}, ${lane.liveCount}, ${lane.activeCount}, ${lane.collapsed}, [\n${seats}\n  ])`;
    })
    .join("\n  Divider()\n");

  const content =
    snapshot.lanes.length === 0
      ? `  Text("No live fleet seats")
    .font(.system(size: 11))
    .foregroundColor(.secondary)
    .padding(6)`
      : laneCalls;

  return `${FLEET_SWIFT_HELPERS}

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

export interface FleetSidebarPublisherLike {
  publish(snapshot: FleetSidebarSnapshot): void;
  dispose(): void;
}

export interface FleetSidebarPublisherOptions {
  outputPath?: string;
  minWriteIntervalMs?: number;
}

export class FleetSidebarPublisher implements FleetSidebarPublisherLike {
  private readonly outputPath: string;
  private readonly minWriteIntervalMs: number;
  private pendingSource: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(opts: FleetSidebarPublisherOptions = {}) {
    this.outputPath = opts.outputPath ?? defaultFleetSidebarPath();
    this.minWriteIntervalMs = Math.max(
      500,
      opts.minWriteIntervalMs ?? 500,
    );
  }

  publish(snapshot: FleetSidebarSnapshot): void {
    if (this.disposed) return;
    const source = renderFleetSidebar(snapshot);
    if (this.readCurrentSource() === source) {
      this.pendingSource = null;
      this.clearTimer();
      return;
    }

    this.pendingSource = source;
    this.flushOrSchedule();
  }

  dispose(): void {
    this.disposed = true;
    this.pendingSource = null;
    this.clearTimer();
  }

  private flushOrSchedule(): void {
    if (this.disposed || this.pendingSource === null) return;
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
    this.pendingSource = null;
    if (this.readCurrentSource() === source) return;
    this.atomicWrite(source);
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
}
