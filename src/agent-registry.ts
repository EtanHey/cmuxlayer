/**
 * In-memory agent registry.
 * Reconstituted from state files + cmux surface list.
 * Reconciliation sweep detects orphaned/disappeared agents.
 */

import { StateManager } from "./state-manager.js";
import {
  AgentDiscovery,
  discoveredStatusToAgentState,
  inferRepoFromTitle,
  makeAutoAgentId,
  type DiscoveredAgent,
} from "./agent-discovery.js";
import {
  type MergedAgent,
  isCrashRecoveryEligible,
  shouldRetainCrashRecoveryError,
  type AgentRecord,
  type AgentRole,
  type AgentState,
  type CliType,
} from "./agent-types.js";
import type { CmuxSurface } from "./types.js";
import { extractPrefix } from "./naming.js";
import {
  inferAgentRole,
  isAgentRoleInferenceError,
} from "./layout-policy.js";
import {
  assertSeatIdentity,
  type SeatIdentityAssertion,
  type SeatRegistry,
} from "./seat-identity.js";
import { validateSurfaceIdentityBijection } from "./surface-topology.js";
import { deriveCmuxObserverOwnerId } from "./cmux-observer-identity.js";

export type SurfaceProvider = () => Promise<CmuxSurface[]>;

interface SurfaceAbsenceOptions {
  confirmationMs?: number;
  now?: number;
}

export interface LiveSeatDiscoveryProof {
  observer_id: string;
  observer_epoch: string;
  seats: Array<{
    surface_id: string;
    surface_uuid: string | null;
    seat_id: string;
  }>;
}

interface SurfacelessEvictionOptions extends SurfaceAbsenceOptions {
  /**
   * Same-cycle, observer-pinned screen proof for role-classified live seats.
   * Surface enumeration alone proves topology, not that the expected agent
   * still owns the shell, so crash-recovery rows may only yield to this proof.
   */
  liveSeatProof?: LiveSeatDiscoveryProof | null;
}

export interface AgentRegistryOptions {
  /** Static identity for a client that never changes cmux socket topology. */
  observerId?: string | null;
  /**
   * Resolve the identity of the cmux topology currently observed by the client.
   * Socket clients can fail over at runtime, so production callers should use
   * this form rather than capturing currentSocketPath() once at construction.
   */
  observerIdProvider?: () => string | null | undefined;
  /**
   * Transient topology epoch used only to reject observations that cross a
   * reconnect/route replacement. Unlike observerIdProvider, this value is
   * never persisted in agent state.
   */
  observerEpochProvider?: () => string | null | undefined;
  /**
   * Resolve caller-authoritative role metadata retained by the surface creator.
   * Returning null/undefined leaves launcher/CLI inference as the fallback.
   */
  explicitRoleProvider?: (
    discovered: Pick<
      DiscoveredAgent,
      "surface_id" | "surface_uuid" | "workspace_id"
    >,
  ) => AgentRole | null | undefined;
}

interface RegistryObserverSnapshot {
  ownerId: string | null | undefined;
  epoch: string | null | undefined;
}

export function deriveSurfaceObserverId(
  client: unknown,
  fallbackSocketPath: string | null | undefined =
    process.env.CMUX_SOCKET_PATH,
): string | null {
  return deriveCmuxObserverOwnerId(client, fallbackSocketPath);
}

export const SURFACE_EVICTION_CONFIRMATION_MS = 5_000;

export interface AgentFilter {
  state?: AgentState;
  repo?: string;
  model?: string;
}

const TERMINAL_STATES = new Set<AgentState>(["done", "error"]);
const BOOTING_GHOST_TIMEOUT_MS = 30_000;
const PENDING_AGENT_ID_RE = /-pending-\d+-[a-z0-9]+$/i;
const CLI_SUFFIXES: Array<{ suffix: string; cli: CliType }> = [
  { suffix: "Claude", cli: "claude" },
  { suffix: "Codex", cli: "codex" },
  { suffix: "Cursor", cli: "cursor" },
  { suffix: "Gemini", cli: "gemini" },
  { suffix: "Kiro", cli: "kiro" },
];

export interface RegistryRepairEntry {
  surface_id: string;
  surface_uuid?: string | null;
  surface_title: string;
  agent_id: string;
  repo: string;
  cli: CliType;
  role: AgentRole;
  launcher_name: string;
  seat_id: string | null;
  action: "created" | "updated";
}

export interface RegistryRepairSkip {
  surface_id: string;
  surface_uuid?: string | null;
  surface_title: string;
  agent_id: string;
  seat_id: string | null;
  reason: string;
}

export interface RegistryRepairSummary {
  repaired: RegistryRepairEntry[];
  evicted: string[];
  skipped: RegistryRepairSkip[];
}

interface RegistryRepairCandidate {
  repo: string;
  cli: CliType;
  launcherName: string;
  seat: SeatIdentityAssertion;
  role: AgentRole;
  agentId: string;
}

interface LiveRepairCandidate {
  discovered: DiscoveredAgent;
  candidate: RegistryRepairCandidate;
  identityKeys: string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isPendingAgentId(agentId: string): boolean {
  return PENDING_AGENT_ID_RE.test(agentId);
}

function pendingBaseAgentId(agentId: string): string | null {
  if (!isPendingAgentId(agentId)) return null;
  return agentId.replace(PENDING_AGENT_ID_RE, "");
}

function isAutoAgentId(agentId: string): boolean {
  return agentId.startsWith("auto-");
}

function hasLauncherToken(title: string, launcherName: string): boolean {
  return new RegExp(
    `(^|[^a-z0-9])${escapeRegExp(launcherName)}($|[^a-z0-9])`,
    "i",
  ).test(title);
}

function inferLauncherFromSeatRegistry(
  title: string,
  registry?: SeatRegistry | null,
): { repo: string; cli: CliType; launcherName: string } | null {
  for (const [, entry] of Object.entries(registry ?? {})) {
    for (const cli of ["claude", "codex", "cursor", "gemini", "kiro"] as const) {
      const launcherName = entry.launchers[cli];
      if (launcherName && hasLauncherToken(title, launcherName)) {
        return { repo: entry.repo, cli, launcherName };
      }
    }
  }
  return null;
}

function inferOrcDriverLauncher(
  title: string,
  registry?: SeatRegistry | null,
): { repo: string; cli: CliType; launcherName: string } | null {
  if (!/\borc(?:[-_\s]?driver)?\b/i.test(title)) {
    return null;
  }

  const entry =
    (registry?.orcClaude ?? null) ||
    Object.values(registry ?? {}).find(
      (candidate) =>
        candidate.repo.toLowerCase() === "orc" ||
        candidate.role?.toLowerCase() === "orc",
    );
  return {
    repo: entry?.repo ?? "orc",
    cli: "claude",
    launcherName: entry?.launchers.claude ?? "orcClaude",
  };
}

function inferLauncherFromSurfaceTitle(
  title: string,
  registry?: SeatRegistry | null,
): { repo: string; cli: CliType; launcherName: string } | null {
  const prefix = extractPrefix(title).trim();
  const registryMatch = inferLauncherFromSeatRegistry(prefix, registry);
  if (registryMatch) return registryMatch;

  const orcDriver = inferOrcDriverLauncher(prefix, registry);
  if (orcDriver) return orcDriver;

  const launcherTokens = [...prefix.matchAll(/[A-Za-z][A-Za-z0-9_.-]*/g)]
    .map((match) => match[0])
    .reverse();
  for (const token of launcherTokens) {
    for (const { suffix, cli } of CLI_SUFFIXES) {
      if (!new RegExp(`${suffix}$`, "i").test(token)) continue;
      const repoPart = token.slice(0, -suffix.length).trim();
      if (!repoPart || repoPart === "." || repoPart === "..") continue;
      const repo = repoPart.replace(/^[A-Z]/, (match) => match.toLowerCase());
      return {
        repo,
        cli,
        launcherName: `${repo}${suffix}`,
      };
    }
  }

  return null;
}

function suffixForCli(cli: CliType): string {
  return CLI_SUFFIXES.find((entry) => entry.cli === cli)?.suffix ?? "";
}

function repairRepoFromTitle(title: string): string {
  const inferred = inferRepoFromTitle(title);
  const token = inferred.match(/[A-Za-z0-9][A-Za-z0-9_.-]*/)?.[0] ?? "";
  return token.replace(/^[A-Z]/, (match) => match.toLowerCase());
}

function inferRepairLauncher(
  discovered: DiscoveredAgent,
  registry?: SeatRegistry | null,
): { repo: string; cli: CliType; launcherName: string } | null {
  const titleLauncher = inferLauncherFromSurfaceTitle(
    discovered.surface_title,
    registry,
  );
  if (titleLauncher) return titleLauncher;

  if (discovered.cli === "unknown") return null;
  const repo = repairRepoFromTitle(discovered.surface_title);
  const suffix = suffixForCli(discovered.cli);
  if (!repo || !suffix) return null;
  return {
    repo,
    cli: discovered.cli,
    launcherName: `${repo}${suffix}`,
  };
}

function roleFromSeatOrLauncher(input: {
  seat: SeatIdentityAssertion;
  launcherName: string;
  surfaceTitle: string;
  cli: CliType;
}): AgentRole {
  const seatRole = input.seat.seat_role?.trim().toLowerCase();
  if (seatRole === "lead" || seatRole === "orc" || seatRole === "orchestrator") {
    return "orchestrator";
  }
  if (seatRole === "ic") {
    return "ic";
  }
  if (seatRole === "worker") {
    return "worker";
  }

  try {
    return inferAgentRole({
      launcherName: input.launcherName,
      title: input.surfaceTitle,
      cli: input.cli,
    });
  } catch (error) {
    if (isAgentRoleInferenceError(error)) {
      return inferAgentRole({ cli: input.cli });
    }
    throw error;
  }
}

function repairCandidateForSurface(
  discovered: DiscoveredAgent,
  registry?: SeatRegistry | null,
): RegistryRepairCandidate | null {
  const launcher = inferRepairLauncher(discovered, registry);
  if (!launcher) return null;

  const seat = assertSeatIdentity({
    repo: launcher.repo,
    cli: launcher.cli,
    launcherName: launcher.launcherName,
    registry,
  });
  const role = roleFromSeatOrLauncher({
    seat,
    launcherName: launcher.launcherName,
    surfaceTitle: discovered.surface_title,
    cli: launcher.cli,
  });
  return {
    ...launcher,
    seat,
    role,
    agentId: seat.seat_id ?? launcher.launcherName,
  };
}

function recordIdentityKeys(record: AgentRecord): string[] {
  return [
    record.seat_id ? `seat:${record.seat_id}` : null,
    record.launcher_name ? `launcher:${record.launcher_name}` : null,
    pendingBaseAgentId(record.agent_id)
      ? `launcher:${pendingBaseAgentId(record.agent_id)}`
      : null,
  ].filter((key): key is string => Boolean(key));
}

function repairCandidateIdentityKeys(
  candidate: RegistryRepairCandidate,
): string[] {
  return [
    candidate.seat.seat_id ? `seat:${candidate.seat.seat_id}` : null,
    `launcher:${candidate.launcherName}`,
  ].filter((key): key is string => Boolean(key));
}

function identityKeysOverlap(left: readonly string[], right: readonly string[]) {
  return left.some((key) => right.includes(key));
}

function isSelfHealEligibleManagedRecord(record: AgentRecord): boolean {
  if (record.state !== "error") {
    return record.state !== "done";
  }
  return record.error?.startsWith("Surface ") ?? false;
}

function patchForRepairCandidate(
  record: AgentRecord,
  discovered: DiscoveredAgent,
  candidate: RegistryRepairCandidate,
): Partial<AgentRecord> {
  const patch: Partial<AgentRecord> = {};
  const workspaceId = discovered.workspace_id ?? null;
  const model = discovered.model ?? record.model;
  const fields: Partial<AgentRecord> = {
    surface_id: discovered.surface_id,
    surface_uuid:
      discovered.surface_uuid ?? record.surface_uuid ?? null,
    workspace_id: workspaceId,
    repo: candidate.repo,
    model,
    cli: candidate.cli,
    launcher_name: candidate.launcherName,
    seat_id: candidate.seat.seat_id,
    seat_lane: candidate.seat.seat_lane,
    seat_role: candidate.seat.seat_role,
    seat_identity_status: candidate.seat.seat_identity_status,
    seat_identity_error: candidate.seat.seat_identity_error,
    role: candidate.role,
  };

  for (const [key, value] of Object.entries(fields) as Array<
    [keyof AgentRecord, AgentRecord[keyof AgentRecord]]
  >) {
    if ((record[key] ?? null) !== (value ?? null)) {
      (patch as Record<string, unknown>)[key] = value;
    }
  }

  return patch;
}

function surfaceUuidKey(value: string | null | undefined): string | null {
  return value?.trim().toLowerCase() || null;
}

function hasSurfaceUuidConflict(
  record: Pick<AgentRecord, "surface_uuid">,
  discovered: Pick<DiscoveredAgent, "surface_uuid">,
): boolean {
  const persistedUuid = surfaceUuidKey(record.surface_uuid);
  const discoveredUuid = surfaceUuidKey(discovered.surface_uuid);
  return Boolean(
    persistedUuid && discoveredUuid && persistedUuid !== discoveredUuid,
  );
}

/**
 * Absence is authoritative only when one snapshot has a coherent identity
 * regime. Mixed UUID/ref coverage is incomplete even when its observed pairs
 * are bijective, so destructive consumers must fail closed for the whole scan.
 */
function hasCoherentSurfaceIdentity(
  surfaces: readonly CmuxSurface[],
): boolean {
  const validation = validateSurfaceIdentityBijection(
    surfaces.map((surface) => ({
      surfaceRef: surface.ref,
      surfaceId: surface.id,
    })),
  );
  if (!validation.isBijective) return false;

  const identifiedCount = surfaces.filter(
    (surface) => surfaceUuidKey(surface.id) !== null,
  ).length;
  return identifiedCount === 0 || identifiedCount === surfaces.length;
}

function hasBijectiveDiscoveryIdentity(
  discovered: readonly DiscoveredAgent[],
): boolean {
  return validateSurfaceIdentityBijection(
    discovered.map((entry) => ({
      surfaceRef: entry.surface_id,
      surfaceId: entry.surface_uuid,
    })),
  ).isBijective;
}

function hasMixedDiscoveryIdentityCoverage(
  discovered: readonly DiscoveredAgent[],
): boolean {
  const identifiedCount = discovered.filter(
    (entry) => surfaceUuidKey(entry.surface_uuid) !== null,
  ).length;
  return identifiedCount > 0 && identifiedCount < discovered.length;
}

class AgentNotFoundError extends Error {
  readonly code = "AGENT_NOT_FOUND";
  readonly agentId: string;

  constructor(agentId: string) {
    super(`Agent not found: ${agentId}`);
    this.name = "AgentNotFoundError";
    this.agentId = agentId;
  }
}

export class AgentRegistry {
  private agents = new Map<string, AgentRecord>();
  private aliases = new Map<string, string>();
  private surfacelessObservations = new Map<
    string,
    { surfaceId: string; firstObservedAt: number }
  >();
  private stateMgr: StateManager;
  private surfaceProvider: SurfaceProvider;
  private observerId: string | null;
  private observerIdProvider: (() => string | null | undefined) | null;
  private observerEpochProvider: (() => string | null | undefined) | null;
  private explicitRoleProvider: NonNullable<
    AgentRegistryOptions["explicitRoleProvider"]
  > | null;
  private enforceObserverOwnership: boolean;

  constructor(
    stateMgr: StateManager,
    surfaceProvider: SurfaceProvider,
    opts?: AgentRegistryOptions,
  ) {
    this.stateMgr = stateMgr;
    this.surfaceProvider = surfaceProvider;
    this.observerId = opts?.observerId?.trim() || null;
    this.observerIdProvider = opts?.observerIdProvider ?? null;
    this.observerEpochProvider = opts?.observerEpochProvider ?? null;
    this.explicitRoleProvider = opts?.explicitRoleProvider ?? null;
    // Omitted options retain the historical library/test behavior. Production
    // explicitly passes options (including null) so missing instance evidence
    // fails closed instead of treating one topology as globally authoritative.
    this.enforceObserverOwnership = opts !== undefined;
  }

  getObserverId(): string | null {
    if (!this.observerIdProvider) {
      return this.observerId;
    }
    try {
      return this.observerIdProvider()?.trim() || null;
    } catch {
      // Losing observer identity must fail closed. A stale cached identity could
      // otherwise authorize the replacement socket to mutate the old topology.
      return null;
    }
  }

  getObserverEpoch(): string | null {
    const provider = this.observerEpochProvider ?? this.observerIdProvider;
    if (!provider) {
      return this.observerId;
    }
    try {
      return provider()?.trim() || null;
    } catch {
      return null;
    }
  }

  private explicitRoleFor(discovered: DiscoveredAgent): AgentRole | null {
    return this.explicitRoleProvider?.(discovered) ?? null;
  }

  /** Capture persisted owner and transient epoch before an awaited scan. */
  private captureObserverSnapshot(): RegistryObserverSnapshot {
    if (!this.enforceObserverOwnership) {
      return { ownerId: undefined, epoch: undefined };
    }
    return {
      ownerId: this.getObserverId(),
      epoch: this.getObserverEpoch(),
    };
  }

  private isObserverSnapshotCurrent(
    snapshot: RegistryObserverSnapshot,
  ): boolean {
    if (snapshot.ownerId === undefined && snapshot.epoch === undefined) {
      return true;
    }
    return Boolean(
      snapshot.ownerId &&
        snapshot.epoch &&
        this.getObserverId() === snapshot.ownerId &&
        this.getObserverEpoch() === snapshot.epoch,
    );
  }

  isObserverOwnershipEnforced(): boolean {
    return this.enforceObserverOwnership;
  }

  /**
   * Decide whether a live observation is strong enough to bind an existing row.
   * Stable UUID equality can migrate ownership; mutable refs require the row to
   * already belong to this observer.
   */
  canUseObservedBinding(
    agent: Pick<AgentRecord, "surface_uuid" | "surface_observer_id">,
    observedUuid: string | null | undefined,
  ): boolean {
    return this.canUseObservedBindingAtOwner(
      agent,
      observedUuid,
      this.enforceObserverOwnership ? this.getObserverId() : undefined,
    );
  }

  private canUseObservedBindingAtOwner(
    agent: Pick<AgentRecord, "surface_uuid" | "surface_observer_id">,
    observedUuid: string | null | undefined,
    observerOwnerId: string | null | undefined,
  ): boolean {
    const persisted = surfaceUuidKey(agent.surface_uuid);
    const observed = surfaceUuidKey(observedUuid);
    if (this.enforceObserverOwnership && !observerOwnerId) {
      return false;
    }
    if (persisted && observed) {
      return persisted === observed;
    }
    // A mutable ref cannot prove that a UUID-less row belongs to the UUID now
    // occupying it. Keep that row quarantined instead of adopting/backfilling.
    if (!persisted && observed) {
      return false;
    }
    if (!this.enforceObserverOwnership) {
      return true;
    }
    return Boolean(
      observerOwnerId && agent.surface_observer_id === observerOwnerId,
    );
  }

  canControlSurface(
    agent: Pick<AgentRecord, "surface_observer_id">,
  ): boolean {
    if (!this.enforceObserverOwnership) {
      return true;
    }
    const observerId = this.getObserverId();
    return Boolean(observerId && agent.surface_observer_id === observerId);
  }

  /**
   * Load all agent state from disk and cross-check against live surfaces.
   * Call once on startup.
   */
  async reconstitute(opts: SurfaceAbsenceOptions = {}): Promise<Set<string>> {
    this.agents.clear();
    this.aliases.clear();
    this.surfacelessObservations.clear();

    const stateFiles = this.stateMgr.listStates();
    for (const record of stateFiles) {
      this.agents.set(record.agent_id, record);
    }

    return this.reconcileSurfaces(opts);
  }

  /**
   * Periodic reconciliation: cross-check in-memory state against
   * actual cmux surfaces and state files on disk.
   */
  async reconcile(opts: SurfaceAbsenceOptions = {}): Promise<Set<string>> {
    // Pick up new state files created by other processes
    const onDisk = this.stateMgr.listStates();
    for (const record of onDisk) {
      const existing = this.agents.get(record.agent_id);
      if (!existing || existing.version < record.version) {
        this.agents.set(record.agent_id, record);
      }
    }

    return this.reconcileSurfaces(opts);
  }

  private liveSurfaceKeys(surfaces: readonly CmuxSurface[]): Set<string> {
    return new Set(
      surfaces.flatMap((surface) => [
        `ref:${surface.ref}`,
        ...(surface.id ? [`uuid:${surface.id}`] : []),
      ]),
    );
  }

  private agentSurfaceKey(
    agent: Pick<AgentRecord, "surface_id" | "surface_uuid">,
  ): string {
    return agent.surface_uuid
      ? `uuid:${agent.surface_uuid}`
      : `ref:${agent.surface_id}`;
  }

  private matchingLiveSurface(
    agent: Pick<AgentRecord, "surface_id" | "surface_uuid">,
    surfaces: readonly CmuxSurface[],
  ): CmuxSurface | undefined {
    if (agent.surface_uuid) {
      const expectedUuid = surfaceUuidKey(agent.surface_uuid);
      const byUuid = surfaces.find(
        (surface) => surfaceUuidKey(surface.id) === expectedUuid,
      );
      if (byUuid) return byUuid;
      // Older cmux builds expose refs only. Preserve compatibility only when
      // the entire observation lacks stable identity; never fall through to a
      // recycled ref in a UUID-capable snapshot.
      if (surfaces.some((surface) => surface.id)) return undefined;
    }
    return surfaces.find((surface) => surface.ref === agent.surface_id);
  }

  private isSurfaceAbsenceAuthoritative(
    agent: Pick<AgentRecord, "surface_uuid">,
    surfaces: readonly CmuxSurface[],
  ): boolean {
    const identifiedCount = surfaces.filter((surface) => surface.id).length;
    if (!agent.surface_uuid) {
      // A UUID-bearing occupant on the same mutable ref is neither positive nor
      // negative evidence for a UUID-less persisted row. Only the complete
      // all-ref compatibility regime may reconcile that row by ref.
      return identifiedCount === 0;
    }
    // All-UUID observations prove UUID absence. All-ref observations retain
    // compatibility and can prove ref absence. Mixed coverage proves neither:
    // the missing UUID may belong to any identity-free surface in the scan.
    return identifiedCount === 0 || identifiedCount === surfaces.length;
  }

  private async reconcileSurfaces(
    opts: SurfaceAbsenceOptions = {},
  ): Promise<Set<string>> {
    const observerSnapshot = this.captureObserverSnapshot();
    let surfaces: CmuxSurface[];
    try {
      surfaces = await this.surfaceProvider();
    } catch {
      // Treat enumeration failures as "unknown", not "zero surfaces". A transient
      // socket/listing failure must not mark every active agent as disappeared.
      return new Set();
    }
    if (!this.isObserverSnapshotCurrent(observerSnapshot)) {
      return new Set();
    }
    if (surfaces.length === 0) {
      // An empty topology is indistinguishable from a degraded cmux/app-server
      // listing path. Do not mass-mark agents dead until a non-empty scan proves
      // their specific surfaces are absent.
      return new Set();
    }
    if (!hasCoherentSurfaceIdentity(surfaces)) {
      // Incomplete or contradictory identity evidence can prove neither
      // presence nor absence.
      // Reset pending absence timers so a later valid scan starts fresh.
      this.surfacelessObservations.clear();
      return new Set();
    }
    const liveSurfaceKeys = this.liveSurfaceKeys(surfaces);
    this.clearSurfacelessObservationsForLiveSurfaces(liveSurfaceKeys);

    // Phase 1: Mark agents with disappeared surfaces as error
    const crashedIds = new Set<string>();
    for (const [id, originalAgent] of this.agents) {
      let agent = originalAgent;
      const liveSurface = this.matchingLiveSurface(agent, surfaces);
      if (liveSurface) {
        if (
          !this.canUseObservedBindingAtOwner(
            agent,
            liveSurface.id,
            observerSnapshot.ownerId,
          )
        ) {
          // A shared mutable ref cannot establish provenance for a legacy or
          // foreign row. Preserve it without adopting this observer's surface.
          this.surfacelessObservations.delete(agent.agent_id);
          continue;
        }
        const workspaceId = liveSurface.workspace_ref ?? agent.workspace_id ?? null;
        const patch: Partial<AgentRecord> = {};
        if (agent.surface_id !== liveSurface.ref) {
          patch.surface_id = liveSurface.ref;
        }
        if (!agent.surface_uuid && liveSurface.id) {
          patch.surface_uuid = liveSurface.id;
        }
        const observerId = observerSnapshot.ownerId ?? null;
        if (
          observerId &&
          liveSurface.id &&
          agent.surface_observer_id !== observerId
        ) {
          patch.surface_observer_id = observerId;
        }
        if ((agent.workspace_id ?? null) !== workspaceId) {
          patch.workspace_id = workspaceId;
        }
        if (Object.keys(patch).length > 0) {
          try {
            agent = this.stateMgr.updateRecord(id, patch);
            this.agents.set(id, agent);
          } catch (error) {
            if (this.evictMissingStateAgent(id)) {
              continue;
            }
            throw error;
          }
        }
        this.surfacelessObservations.delete(agent.agent_id);
        continue;
      }

      if (!this.isSurfaceAbsenceAuthoritative(agent, surfaces)) {
        this.surfacelessObservations.delete(agent.agent_id);
        continue;
      }

      if (TERMINAL_STATES.has(agent.state)) continue;

      if (
        this.isSurfacelessConfirmed(
          agent,
          liveSurfaceKeys,
          opts,
          observerSnapshot.ownerId,
        )
      ) {
        try {
          const updated = this.stateMgr.transition(id, "error", {
            error: `Surface ${agent.surface_id} disappeared`,
          });
          this.agents.set(id, updated);
          crashedIds.add(id);
        } catch (error) {
          if (this.evictMissingStateAgent(id)) {
            crashedIds.add(id);
            continue;
          }
          throw error;
        }
      }
    }

    // Phase 2: Reparent orphans — children of crashed agents get parent_agent_id=null.
    // Children keep running independently (orphan survival), but are detached from
    // the dead parent so getSubtree on the dead parent no longer includes them.
    if (crashedIds.size > 0) {
      for (const [id, agent] of this.agents) {
        if (
          this.canMutateForObservedAbsence(agent, observerSnapshot.ownerId) &&
          agent.parent_agent_id &&
          crashedIds.has(agent.parent_agent_id)
        ) {
          try {
            const reparented = this.stateMgr.updateRecord(id, {
              parent_agent_id: null,
            });
            this.agents.set(id, reparented);
          } catch (error) {
            if (this.evictMissingStateAgent(id)) {
              continue;
            }
            throw error;
          }
        }
      }
    }
    return crashedIds;
  }

  private resolveAlias(agentId: string): string {
    let current = agentId;
    const seen = new Set<string>();
    while (this.aliases.has(current) && !seen.has(current)) {
      seen.add(current);
      current = this.aliases.get(current)!;
    }
    return current;
  }

  private aliasesResolvingTo(agentId: string): string[] {
    const aliases: string[] = [];
    for (const [alias, target] of this.aliases) {
      if (
        alias === agentId ||
        target === agentId ||
        this.resolveAlias(alias) === agentId
      ) {
        aliases.push(alias);
      }
    }
    return aliases;
  }

  private deleteAgentAndAliases(agentId: string): string {
    const resolved = this.resolveAlias(agentId);
    const aliases = this.aliasesResolvingTo(resolved);
    this.agents.delete(resolved);
    this.surfacelessObservations.delete(resolved);
    this.aliases.delete(agentId);
    this.aliases.delete(resolved);
    for (const alias of aliases) {
      this.aliases.delete(alias);
    }
    return resolved;
  }

  get(agentId: string): AgentRecord | null {
    return this.agents.get(this.resolveAlias(agentId)) ?? null;
  }

  list(filter?: AgentFilter): AgentRecord[] {
    let results = [...this.agents.values()];
    if (filter?.state) {
      results = results.filter((a) => a.state === filter.state);
    }
    if (filter?.repo) {
      results = results.filter((a) => a.repo === filter.repo);
    }
    if (filter?.model) {
      results = results.filter((a) => a.model === filter.model);
    }
    return results;
  }

  async isSurfaceAlive(
    agent: Pick<AgentRecord, "surface_id" | "surface_uuid">,
    opts: { ptyDead?: boolean } = {},
  ): Promise<boolean> {
    if (opts.ptyDead === true) {
      return false;
    }

    const observerSnapshot = this.captureObserverSnapshot();
    let surfaces: CmuxSurface[];
    try {
      surfaces = await this.surfaceProvider();
    } catch {
      // "Live" here means "not proven absent" for liveness guards.
      return true;
    }
    if (!this.isObserverSnapshotCurrent(observerSnapshot)) {
      return true;
    }
    if (surfaces.length === 0) {
      // Empty enumeration is inconclusive until a non-empty scan proves absence.
      return true;
    }
    if (!hasCoherentSurfaceIdentity(surfaces)) {
      return true;
    }
    return (
      this.matchingLiveSurface(agent, surfaces) !== undefined ||
      !this.isSurfaceAbsenceAuthoritative(agent, surfaces)
    );
  }

  async hasLiveSurface(surfaceId: string): Promise<boolean> {
    return this.isSurfaceAlive({ surface_id: surfaceId });
  }

  async listMerged(
    discovery: AgentDiscovery,
    opts?: {
      filter?: AgentFilter;
      force?: boolean;
      discovered?: DiscoveredAgent[];
      nonDestructive?: boolean;
    },
  ): Promise<MergedAgent[]> {
    // Pin both scanned and caller-injected discovery to the observer that was
    // current when this ingestion began. Reconciliation/purge awaits must not
    // let an old snapshot cross a reconnect epoch and mutate the replacement.
    const discoveryObserverSnapshot = this.captureObserverSnapshot();
    if (!opts?.nonDestructive) {
      const surfacelessConfirmation = {
        confirmationMs: SURFACE_EVICTION_CONFIRMATION_MS,
        now: Date.now(),
      };
      await this.reconcile(surfacelessConfirmation);
      await this.purgeTerminal(surfacelessConfirmation);
    }

    const discovered =
      opts?.discovered ?? (await discovery.scan(opts?.force ?? false));
    if (!this.isObserverSnapshotCurrent(discoveryObserverSnapshot)) {
      return this.list(opts?.filter).map((record) => ({
        ...record,
        discovered: record.agent_id.startsWith("auto-"),
        parsed_cli_mismatch: false,
      }));
    }
    const discoveryIsBijective = hasBijectiveDiscoveryIdentity(discovered);
    const discoveryHasMixedIdentity =
      hasMixedDiscoveryIdentityCoverage(discovered);
    if (!discoveryIsBijective || discoveryHasMixedIdentity) {
      // A degraded discovery scan must break any pending negative-evidence
      // streak even when exact UUID matches remain safe for positive sync.
      this.surfacelessObservations.clear();
    }
    if (!discoveryIsBijective) {
      return this.list(opts?.filter).map((record) => ({
        ...record,
        discovered: record.agent_id.startsWith("auto-"),
        parsed_cli_mismatch: false,
      }));
    }
    if (!opts?.nonDestructive && !discoveryHasMixedIdentity) {
      await this.evictBootingGhosts(discovered);
      if (!this.isObserverSnapshotCurrent(discoveryObserverSnapshot)) {
        return this.list(opts?.filter).map((record) => ({
          ...record,
          discovered: record.agent_id.startsWith("auto-"),
          parsed_cli_mismatch: false,
        }));
      }
    }

    const bySurface = new Map(discovered.map((entry) => [entry.surface_id, entry]));
    const bySurfaceUuid = new Map(
      discovered.flatMap((entry) => {
        const uuid = surfaceUuidKey(entry.surface_uuid);
        return uuid ? [[uuid, entry] as const] : [];
      }),
    );
    const observationHasStableIds = bySurfaceUuid.size > 0;
    const repairCandidates = discoveryHasMixedIdentity
      ? []
      : this.liveRepairCandidatesForDiscovery(discovered);
    if (!opts?.nonDestructive && !discoveryHasMixedIdentity) {
      this.selfHealManagedRegistrationsFromDiscovery(repairCandidates, bySurface);
    }
    const suppressedDuplicateSurfaceRefs =
      this.duplicateDiscoverySurfaceRefs(repairCandidates);
    const merged: MergedAgent[] = [];
    const seenSurfaces = new Set<string>();

    for (const record of this.list()) {
      const recordUuid = surfaceUuidKey(record.surface_uuid);
      const observedEntry = recordUuid
        ? bySurfaceUuid.get(recordUuid) ??
          (observationHasStableIds ? undefined : bySurface.get(record.surface_id))
        : discoveryHasMixedIdentity
          ? undefined
          : bySurface.get(record.surface_id);
      const discoveredEntry =
        observedEntry &&
        this.canUseObservedBinding(record, observedEntry.surface_uuid)
          ? observedEntry
          : undefined;
      const isAutoRecord = record.agent_id.startsWith("auto-");

      if (
        !opts?.nonDestructive &&
        !discoveryHasMixedIdentity &&
        isAutoRecord &&
        discoveredEntry &&
        !discoveredEntry.read_error &&
        !discoveredEntry.has_agent &&
        this.canMutateForObservedAbsence(record)
      ) {
        const removedAgentId = this.deleteAgentAndAliases(record.agent_id);
        this.stateMgr.removeState(removedAgentId);
        continue;
      }

      let liveRecord: AgentRecord | null = record;
      if (
        isAutoRecord &&
        discoveredEntry &&
        discoveredEntry.has_agent &&
        !discoveredEntry.read_error
      ) {
        liveRecord = this.syncAutoRecord(record, discoveredEntry);
        if (!liveRecord) {
          continue;
        }
      }
      if (!isAutoRecord && discoveredEntry && !discoveredEntry.read_error) {
        liveRecord = this.syncManagedRecordSurfaceMetadata(
          record,
          discoveredEntry,
        );
        if (!liveRecord) {
          continue;
        }
      }

      const discoveredReplacesStaleManagedRecord =
        opts?.nonDestructive === true &&
        !isAutoRecord &&
        TERMINAL_STATES.has(record.state) &&
        discoveredEntry?.has_agent === true &&
        discoveredEntry.read_error === false;
      if (!discoveredReplacesStaleManagedRecord) {
        if (discoveredEntry) {
          seenSurfaces.add(discoveredEntry.surface_id);
        }
      }
      merged.push({
        ...liveRecord,
        discovered: isAutoRecord,
        parsed_cli_mismatch:
          !isAutoRecord &&
          discoveredEntry !== undefined &&
          discoveredEntry.cli !== "unknown" &&
          discoveredEntry.cli !== record.cli,
      });
    }

    for (const discoveredEntry of discovered) {
      if (
        !discoveredEntry.has_agent ||
        discoveredEntry.cli === "unknown" ||
        discoveredEntry.read_error ||
        (discoveryHasMixedIdentity &&
          surfaceUuidKey(discoveredEntry.surface_uuid) === null)
      ) {
        continue;
      }
      if (suppressedDuplicateSurfaceRefs.has(discoveredEntry.surface_id)) {
        continue;
      }
      if (seenSurfaces.has(discoveredEntry.surface_id)) {
        continue;
      }

      const agentId = makeAutoAgentId(
        discoveredEntry.cli,
        discoveredEntry.surface_uuid ?? discoveredEntry.surface_id,
      );
      const record = this.stateMgr.ensureAutoRecord(
        agentId,
        discoveredEntry,
        this.getObserverId(),
        this.explicitRoleFor(discoveredEntry),
      );
      this.agents.set(agentId, record);
      if (!this.canUseObservedBinding(record, discoveredEntry.surface_uuid)) {
        continue;
      }
      const liveRecord = this.syncAutoRecord(record, discoveredEntry);
      if (!liveRecord) {
        continue;
      }

      merged.push({
        ...liveRecord,
        discovered: true,
        parsed_cli_mismatch: false,
      });
    }

    const filtered = opts?.filter
      ? merged.filter((agent) => {
          if (opts.filter?.state && agent.state !== opts.filter.state) {
            return false;
          }
          if (opts.filter?.repo && agent.repo !== opts.filter.repo) {
            return false;
          }
          if (opts.filter?.model && agent.model !== opts.filter.model) {
            return false;
          }
          return true;
        })
      : merged;

    return filtered;
  }

  async refreshManagedSurfaceMetadata(
    discovery: AgentDiscovery,
    opts?: { agentId?: string; force?: boolean },
  ): Promise<AgentRecord | null> {
    const records = opts?.agentId
      ? [this.get(opts.agentId)].filter(
          (record): record is AgentRecord => record !== null,
        )
      : this.list();
    if (records.length === 0) {
      return null;
    }

    const discoveryObserverSnapshot = this.captureObserverSnapshot();
    const discovered = await discovery.scan(opts?.force ?? false);
    if (!this.isObserverSnapshotCurrent(discoveryObserverSnapshot)) {
      return opts?.agentId ? this.get(opts.agentId) : null;
    }
    const discoveryIsBijective = hasBijectiveDiscoveryIdentity(discovered);
    const discoveryHasMixedIdentity =
      hasMixedDiscoveryIdentityCoverage(discovered);
    if (!discoveryIsBijective || discoveryHasMixedIdentity) {
      this.surfacelessObservations.clear();
    }
    if (!discoveryIsBijective) {
      return opts?.agentId ? this.get(opts.agentId) : null;
    }
    const readableDiscovered = discovered.filter(
      (entry) => !entry.read_error,
    );
    const bySurface = new Map(
      readableDiscovered.map((entry) => [entry.surface_id, entry]),
    );
    const bySurfaceUuid = new Map(
      readableDiscovered.flatMap((entry) => {
        const uuid = surfaceUuidKey(entry.surface_uuid);
        return uuid ? [[uuid, entry] as const] : [];
      }),
    );
    const observationHasStableIds = bySurfaceUuid.size > 0;

    let requested: AgentRecord | null = null;
    for (const record of records) {
      if (record.agent_id.startsWith("auto-")) {
        continue;
      }
      const recordUuid = surfaceUuidKey(record.surface_uuid);
      const discoveredEntry = recordUuid
        ? bySurfaceUuid.get(recordUuid) ??
          (observationHasStableIds
            ? undefined
            : bySurface.get(record.surface_id))
        : discoveryHasMixedIdentity
          ? undefined
          : bySurface.get(record.surface_id);
      if (
        !discoveredEntry ||
        hasSurfaceUuidConflict(record, discoveredEntry) ||
        !this.canUseObservedBinding(record, discoveredEntry.surface_uuid)
      ) {
        continue;
      }
      const updated = this.syncManagedRecordSurfaceMetadata(
        record,
        discoveredEntry,
      );
      if (!updated) {
        continue;
      }
      if (
        !opts?.agentId ||
        updated.agent_id === this.resolveAlias(opts.agentId)
      ) {
        requested = updated;
      }
    }

    return opts?.agentId ? requested ?? this.get(opts.agentId) : null;
  }

  private liveRepairCandidatesForDiscovery(
    discovered: DiscoveredAgent[],
  ): LiveRepairCandidate[] {
    return discovered.flatMap((entry) => {
      if (
        !entry.has_agent ||
        entry.cli === "unknown" ||
        entry.read_error
      ) {
        return [];
      }
      const candidate = this.repairCandidateForDiscovery(entry);
      if (!candidate) return [];
      return [
        {
          discovered: entry,
          candidate,
          identityKeys: repairCandidateIdentityKeys(candidate),
        },
      ];
    });
  }

  private repairCandidateForDiscovery(
    discovered: DiscoveredAgent,
    seatRegistry?: SeatRegistry | null,
  ): RegistryRepairCandidate | null {
    const candidate = repairCandidateForSurface(discovered, seatRegistry);
    if (!candidate) return null;
    const explicitRole = this.explicitRoleFor(discovered);
    return explicitRole ? { ...candidate, role: explicitRole } : candidate;
  }

  private selfHealManagedRegistrationsFromDiscovery(
    candidates: LiveRepairCandidate[],
    bySurface: ReadonlyMap<string, DiscoveredAgent>,
  ): void {
    if (candidates.length === 0) return;

    // Reserve every surface already bound to a managed record before attempting
    // identity-based relocation. Otherwise filesystem/map iteration order lets
    // an absent canonical ghost steal a live drifted record's surface.
    const claimedSurfaceRefs = new Set(
      candidates.flatMap((entry) => {
        const occupied = [...this.agents.values()].some(
          (record) =>
            !isAutoAgentId(record.agent_id) &&
            !isPendingAgentId(record.agent_id) &&
            record.surface_id === entry.discovered.surface_id &&
            !hasSurfaceUuidConflict(record, entry.discovered) &&
            this.canUseObservedBinding(record, entry.discovered.surface_uuid),
        );
        return occupied ? [entry.discovered.surface_id] : [];
      }),
    );
    for (const record of [...this.agents.values()]) {
      if (isAutoAgentId(record.agent_id) || isPendingAgentId(record.agent_id)) {
        continue;
      }
      if (!isSelfHealEligibleManagedRecord(record)) {
        continue;
      }

      const recordKeys = recordIdentityKeys(record);
      if (recordKeys.length === 0) continue;

      const currentLiveCandidate = candidates.find(
        (entry) =>
          entry.discovered.surface_id === record.surface_id &&
          !hasSurfaceUuidConflict(record, entry.discovered) &&
          this.canUseObservedBinding(record, entry.discovered.surface_uuid) &&
          identityKeysOverlap(recordKeys, entry.identityKeys),
      );
      if (currentLiveCandidate) {
        claimedSurfaceRefs.add(currentLiveCandidate.discovered.surface_id);
        continue;
      }

      const currentSurface = bySurface.get(record.surface_id);
      if (
        currentSurface &&
        !hasSurfaceUuidConflict(record, currentSurface) &&
        this.canUseObservedBinding(record, currentSurface.surface_uuid) &&
        (currentSurface.read_error || currentSurface.has_agent)
      ) {
        continue;
      }

      const replacement = candidates.find(
        (entry) =>
          !claimedSurfaceRefs.has(entry.discovered.surface_id) &&
          !hasSurfaceUuidConflict(record, entry.discovered) &&
          this.canUseObservedBinding(record, entry.discovered.surface_uuid) &&
          identityKeysOverlap(recordKeys, entry.identityKeys),
      );
      if (!replacement) continue;

      const moved = this.updateManagedSurfaceRegistration(
        record,
        replacement.discovered,
        replacement.candidate,
      );
      if (!moved) continue;
      const synced = this.syncManagedRecordLifecycleFromDiscovery(
        moved,
        replacement.discovered,
      );
      claimedSurfaceRefs.add(synced.surface_id);
    }
  }

  private duplicateDiscoverySurfaceRefs(
    candidates: LiveRepairCandidate[],
  ): Set<string> {
    const liveManagedIdentityKeys = new Set<string>();
    const liveManagedSurfaceRefs = new Set<string>();

    for (const record of this.agents.values()) {
      if (isAutoAgentId(record.agent_id) || isPendingAgentId(record.agent_id)) {
        continue;
      }
      const recordKeys = recordIdentityKeys(record);
      const matchingLiveCandidate = candidates.find(
        (entry) =>
          entry.discovered.surface_id === record.surface_id &&
          !hasSurfaceUuidConflict(record, entry.discovered) &&
          this.canUseObservedBinding(record, entry.discovered.surface_uuid) &&
          identityKeysOverlap(recordKeys, entry.identityKeys),
      );
      if (!matchingLiveCandidate) continue;

      liveManagedSurfaceRefs.add(record.surface_id);
      for (const key of recordKeys) {
        liveManagedIdentityKeys.add(key);
      }
    }

    const suppressed = new Set<string>();
    for (const entry of candidates) {
      if (liveManagedSurfaceRefs.has(entry.discovered.surface_id)) {
        continue;
      }
      if (
        entry.identityKeys.some((key) => liveManagedIdentityKeys.has(key))
      ) {
        suppressed.add(entry.discovered.surface_id);
      }
    }
    return suppressed;
  }

  /**
   * Sync an auto-discovered record with the latest parsed surface state.
   *
   * Metadata patches go through updateRecord and are treated as hard errors:
   * if they fail for anything other than a missing state file, callers should
   * see the failure rather than silently continuing. Synthetic transitions are
   * best-effort only because parser snapshots can temporarily lag behind the
   * persisted state machine.
   */
  private syncAutoRecord(
    record: AgentRecord,
    discoveredEntry: DiscoveredAgent,
  ): AgentRecord | null {
    if (!this.canUseObservedBinding(record, discoveredEntry.surface_uuid)) {
      return null;
    }
    const agentId = record.agent_id;
    const repo = inferRepoFromTitle(discoveredEntry.surface_title) || record.repo;
    const model = discoveredEntry.model ?? record.model;
    const workspaceId = discoveredEntry.workspace_id ?? null;
    const surfaceUuid = discoveredEntry.surface_uuid ?? null;
    const desiredState = discoveredStatusToAgentState(
      discoveredEntry.parsed_status,
    );
    const explicitRole = this.explicitRoleFor(discoveredEntry);

    const patch: Partial<AgentRecord> = {};
    if (repo !== record.repo) patch.repo = repo;
    if (model !== record.model) patch.model = model;
    if ((record.workspace_id ?? null) !== workspaceId) {
      patch.workspace_id = workspaceId;
    }
    if (surfaceUuid !== null && (record.surface_uuid ?? null) !== surfaceUuid) {
      patch.surface_uuid = surfaceUuid;
    }
    if (explicitRole && record.role !== explicitRole) {
      patch.role = explicitRole;
    }
    const observerId = this.getObserverId();
    if (observerId && record.surface_observer_id !== observerId) {
      patch.surface_observer_id = observerId;
    }
    if (record.error !== null && desiredState !== "error") patch.error = null;
    if (record.error === null && desiredState === "error") {
      patch.error = "Auto-discovered agent reported a frozen state";
    }

    if (Object.keys(patch).length > 0) {
      try {
        record = this.stateMgr.updateRecord(agentId, patch);
        this.agents.set(agentId, record);
      } catch (error) {
        if (this.evictMissingStateAgent(agentId)) {
          return null;
        }
        throw error;
      }
    }

    if (record.state !== desiredState) {
      try {
        record = this.stateMgr.transition(agentId, desiredState, {
          error:
            desiredState === "error"
              ? "Auto-discovered agent reported a frozen state"
              : null,
        });
        this.agents.set(agentId, record);
      } catch (error) {
        if (this.evictMissingStateAgent(agentId)) {
          return null;
        }
        // Best-effort only — invalid synthetic transitions can keep the prior state.
      }
    }

    return record;
  }

  private syncManagedRecordSurfaceMetadata(
    record: AgentRecord,
    discoveredEntry: DiscoveredAgent,
  ): AgentRecord | null {
    if (!this.canUseObservedBinding(record, discoveredEntry.surface_uuid)) {
      return null;
    }
    const patch: Partial<AgentRecord> = {};
    const explicitRole = this.explicitRoleFor(discoveredEntry);
    const persistedUuid = surfaceUuidKey(record.surface_uuid);
    const discoveredUuid = surfaceUuidKey(discoveredEntry.surface_uuid);
    if (
      record.surface_id !== discoveredEntry.surface_id &&
      persistedUuid !== null &&
      discoveredUuid === persistedUuid
    ) {
      patch.surface_id = discoveredEntry.surface_id;
    }
    if (
      discoveredEntry.workspace_id != null &&
      (record.workspace_id ?? null) !== discoveredEntry.workspace_id
    ) {
      patch.workspace_id = discoveredEntry.workspace_id;
    }
    // Discovery may backfill a legacy record, but a same-ref UUID mismatch is
    // evidence of ref recycling and must not overwrite the persisted binding.
    if (
      record.surface_uuid == null &&
      discoveredEntry.surface_uuid != null
    ) {
      patch.surface_uuid = discoveredEntry.surface_uuid;
    }
    if (explicitRole && record.role !== explicitRole) {
      patch.role = explicitRole;
    }
    const observerId = this.getObserverId();
    if (observerId && record.surface_observer_id !== observerId) {
      patch.surface_observer_id = observerId;
    }
    if (Object.keys(patch).length === 0) {
      return record;
    }

    try {
      const updated = this.stateMgr.updateRecord(record.agent_id, patch);
      this.agents.set(record.agent_id, updated);
      return updated;
    } catch (error) {
      if (this.evictMissingStateAgent(record.agent_id)) {
        return null;
      }
      throw error;
    }
  }

  private syncManagedRecordLifecycleFromDiscovery(
    record: AgentRecord,
    discoveredEntry: DiscoveredAgent,
  ): AgentRecord {
    const desiredState = discoveredStatusToAgentState(
      discoveredEntry.parsed_status,
    );
    const desiredError =
      desiredState === "error"
        ? "Repaired agent surface reported a frozen state"
        : null;
    if (record.state === desiredState && record.error === desiredError) {
      return record;
    }

    const updated = this.stateMgr.resetState(
      record.agent_id,
      desiredState,
      { error: desiredError },
      "listMergedSelfHeal",
    );
    this.agents.set(record.agent_id, updated);
    return updated;
  }

  /**
   * Update an agent in the in-memory map. Used by tools that
   * write state through the StateManager and need to sync the registry.
   */
  set(agentId: string, record: AgentRecord): void {
    const resolved = this.resolveAlias(agentId);
    if (resolved !== agentId && record.agent_id === resolved) {
      this.agents.set(resolved, record);
      return;
    }
    if (agentId !== record.agent_id) {
      this.aliases.set(agentId, record.agent_id);
    }
    this.agents.set(record.agent_id, record);
  }

  rename(oldAgentId: string, newAgentId: string, record: AgentRecord): void {
    this.agents.delete(oldAgentId);
    const surfacelessObservation = this.surfacelessObservations.get(oldAgentId);
    this.surfacelessObservations.delete(oldAgentId);
    if (surfacelessObservation?.surfaceId === this.agentSurfaceKey(record)) {
      this.surfacelessObservations.set(newAgentId, surfacelessObservation);
    }
    for (const [alias, target] of this.aliases) {
      if (target === oldAgentId) {
        this.aliases.set(alias, newAgentId);
      }
    }
    for (const [id, agent] of this.agents) {
      if (agent.parent_agent_id === oldAgentId) {
        this.agents.set(id, { ...agent, parent_agent_id: newAgentId });
      }
    }
    this.aliases.set(oldAgentId, newAgentId);
    this.agents.set(newAgentId, record);
  }

  remove(agentId: string): void {
    this.deleteAgentAndAliases(agentId);
  }

  evict(agentId: string): string | null {
    const resolved = this.resolveAlias(agentId);
    const persisted = this.stateMgr.readState(resolved);
    const record = persisted ?? this.agents.get(resolved) ?? null;
    if (!record) {
      return null;
    }
    if (!this.canMutateForObservedAbsence(record)) {
      return null;
    }

    return this.evictUnchecked(agentId);
  }

  /** Explicit user cleanup of a registry row; performs no surface mutation. */
  evictExplicit(agentId: string): string | null {
    const resolved = this.resolveAlias(agentId);
    if (!this.stateMgr.readState(resolved) && !this.agents.has(resolved)) {
      return null;
    }
    return this.evictUnchecked(agentId);
  }

  private evictUnchecked(agentId: string): string {
    const removedAgentId = this.deleteAgentAndAliases(agentId);
    this.stateMgr.removeState(removedAgentId);
    return removedAgentId;
  }

  async evictSurfaceless(
    opts: SurfacelessEvictionOptions = {},
  ): Promise<string[]> {
    const observerSnapshot = this.captureObserverSnapshot();
    let surfaces: CmuxSurface[];
    try {
      surfaces = await this.surfaceProvider();
    } catch {
      return [];
    }
    if (!this.isObserverSnapshotCurrent(observerSnapshot)) {
      return [];
    }
    if (surfaces.length === 0) {
      return [];
    }
    if (!hasCoherentSurfaceIdentity(surfaces)) {
      this.surfacelessObservations.clear();
      return [];
    }

    const liveSurfaceKeys = this.liveSurfaceKeys(surfaces);
    this.clearSurfacelessObservationsForLiveSurfaces(liveSurfaceKeys);
    const evicted: string[] = [];

    for (const [id, agent] of [...this.agents.entries()]) {
      if (this.matchingLiveSurface(agent, surfaces)) {
        this.surfacelessObservations.delete(agent.agent_id);
        continue;
      }
      if (!this.isSurfaceAbsenceAuthoritative(agent, surfaces)) {
        this.surfacelessObservations.delete(agent.agent_id);
        continue;
      }
      if (
        !this.isSurfacelessConfirmed(
          agent,
          liveSurfaceKeys,
          opts,
          observerSnapshot.ownerId,
        )
      ) {
        continue;
      }
      if (
        isCrashRecoveryEligible(agent) &&
        !this.hasLiveManagedSeatSibling(
          agent,
          surfaces,
          opts.liveSeatProof,
          observerSnapshot,
        )
      ) {
        continue;
      }

      if (!this.canMutateForObservedAbsence(agent, observerSnapshot.ownerId)) {
        continue;
      }
      const removedAgentId = this.evictUnchecked(id);
      if (removedAgentId) {
        evicted.push(removedAgentId);
      }
    }

    return evicted;
  }

  private hasLiveManagedSeatSibling(
    agent: AgentRecord,
    surfaces: readonly CmuxSurface[],
    liveSeatProof: LiveSeatDiscoveryProof | null | undefined,
    observerSnapshot: RegistryObserverSnapshot,
  ): boolean {
    const seatId = agent.seat_id?.trim();
    if (!seatId) return false;
    if (
      !liveSeatProof ||
      !observerSnapshot.ownerId ||
      !observerSnapshot.epoch ||
      liveSeatProof.observer_id !== observerSnapshot.ownerId ||
      liveSeatProof.observer_epoch !== observerSnapshot.epoch
    ) {
      return false;
    }

    return [...this.agents.values()].some((candidate) => {
      if (
        candidate.agent_id === agent.agent_id ||
        isAutoAgentId(candidate.agent_id) ||
        isPendingAgentId(candidate.agent_id) ||
        TERMINAL_STATES.has(candidate.state) ||
        candidate.seat_id !== seatId
      ) {
        return false;
      }
      const liveSurface = this.matchingLiveSurface(candidate, surfaces);
      return Boolean(
        liveSurface &&
          this.canUseObservedBinding(candidate, liveSurface.id) &&
          liveSeatProof.seats.some(
            (entry) =>
              entry.seat_id === seatId &&
              entry.surface_id === liveSurface.ref &&
              surfaceUuidKey(entry.surface_uuid) ===
                surfaceUuidKey(liveSurface.id),
          ),
      );
    });
  }

  createLiveSeatDiscoveryProof(
    discovered: readonly DiscoveredAgent[],
    opts: {
      seatRegistry?: SeatRegistry | null;
      expectedObserverId: string | null;
      expectedObserverEpoch: string | null;
    },
  ): LiveSeatDiscoveryProof | null {
    const observerSnapshot = this.captureObserverSnapshot();
    if (
      !observerSnapshot.ownerId ||
      !observerSnapshot.epoch ||
      observerSnapshot.ownerId !== opts.expectedObserverId ||
      observerSnapshot.epoch !== opts.expectedObserverEpoch ||
      !this.isObserverSnapshotCurrent(observerSnapshot) ||
      !hasBijectiveDiscoveryIdentity(discovered) ||
      hasMixedDiscoveryIdentityCoverage(discovered)
    ) {
      return null;
    }

    const seats = discovered.flatMap((entry) => {
      if (!entry.has_agent || entry.read_error) return [];
      const candidate = repairCandidateForSurface(entry, opts.seatRegistry);
      const seatId = candidate?.seat.seat_id?.trim();
      if (
        !seatId ||
        candidate?.cli !== entry.cli ||
        candidate.seat.seat_identity_status !== "ok"
      ) {
        return [];
      }
      return [
        {
          surface_id: entry.surface_id,
          surface_uuid: entry.surface_uuid ?? null,
          seat_id: seatId,
        },
      ];
    });

    return {
      observer_id: observerSnapshot.ownerId,
      observer_epoch: observerSnapshot.epoch,
      seats,
    };
  }

  private isSurfacelessConfirmed(
    agent: AgentRecord,
    liveSurfaceKeys: ReadonlySet<string>,
    opts: { confirmationMs?: number; now?: number },
    observerEpoch?: string | null,
  ): boolean {
    const surfaceKey = this.agentSurfaceKey(agent);
    if (liveSurfaceKeys.has(surfaceKey)) {
      this.surfacelessObservations.delete(agent.agent_id);
      return false;
    }

    if (!this.canMutateForObservedAbsence(agent, observerEpoch)) {
      this.surfacelessObservations.delete(agent.agent_id);
      return false;
    }

    const confirmationMs = Math.max(0, opts.confirmationMs ?? 0);
    if (confirmationMs === 0) {
      return true;
    }

    const now = opts.now ?? Date.now();
    const observation = this.surfacelessObservations.get(agent.agent_id);
    if (!observation || observation.surfaceId !== surfaceKey) {
      this.surfacelessObservations.set(agent.agent_id, {
        surfaceId: surfaceKey,
        firstObservedAt: now,
      });
      return false;
    }

    return now - observation.firstObservedAt >= confirmationMs;
  }

  private canMutateForObservedAbsence(
    agent: AgentRecord,
    observerEpoch?: string | null,
  ): boolean {
    if (!this.enforceObserverOwnership) {
      return true;
    }
    const observerId =
      observerEpoch === undefined ? this.getObserverId() : observerEpoch;
    return Boolean(observerId && agent.surface_observer_id === observerId);
  }

  private canPurgeAtStartup(agent: AgentRecord): boolean {
    if (!this.enforceObserverOwnership) {
      return true;
    }
    const owner = agent.surface_observer_id?.trim();
    const observerId = this.getObserverId();
    return !owner || Boolean(observerId && owner === observerId);
  }

  private clearSurfacelessObservationsForLiveSurfaces(
    liveSurfaceKeys: ReadonlySet<string>,
  ): void {
    for (const [agentId, observation] of this.surfacelessObservations) {
      if (liveSurfaceKeys.has(observation.surfaceId)) {
        this.surfacelessObservations.delete(agentId);
      }
    }
  }

  repairFromDiscovery(
    discovered: DiscoveredAgent[],
    opts?: { seatRegistry?: SeatRegistry | null },
  ): RegistryRepairSummary {
    if (
      !hasBijectiveDiscoveryIdentity(discovered) ||
      hasMixedDiscoveryIdentityCoverage(discovered)
    ) {
      this.surfacelessObservations.clear();
      return { repaired: [], evicted: [], skipped: [] };
    }
    const repaired: RegistryRepairEntry[] = [];
    const evicted = new Set<string>();
    const skipped: RegistryRepairSkip[] = [];
    const liveSurfaceRefs = new Set(
      discovered.map((entry) => entry.surface_id),
    );

    for (const removed of this.evictPendingGhostRegistrations(liveSurfaceRefs)) {
      evicted.add(removed);
    }

    for (const entry of discovered) {
      if (entry.read_error) continue;
      const candidate = this.repairCandidateForDiscovery(
        entry,
        opts?.seatRegistry,
      );
      if (!candidate) continue;

      try {
        const repair = this.repairDiscoveredSurface(
          entry,
          candidate,
          evicted,
          liveSurfaceRefs,
        );
        if (repair) {
          repaired.push(repair);
        }
      } catch (error) {
        if (!(error instanceof AgentNotFoundError)) {
          throw error;
        }
        skipped.push({
          surface_id: entry.surface_id,
          ...(entry.surface_uuid != null
            ? { surface_uuid: entry.surface_uuid }
            : {}),
          surface_title: entry.surface_title,
          agent_id: error.agentId,
          seat_id: candidate.seat.seat_id,
          reason: error.message,
        });
      }
    }

    for (const removed of this.evictPendingGhostRegistrations(liveSurfaceRefs)) {
      evicted.add(removed);
    }

    return { repaired, evicted: [...evicted], skipped };
  }

  private evictPendingGhostRegistrations(
    liveSurfaceRefs: ReadonlySet<string>,
  ): string[] {
    if (liveSurfaceRefs.size === 0) {
      return [];
    }

    const managedRecords = [...this.agents.values()].filter(
      (candidate) =>
        !isPendingAgentId(candidate.agent_id) &&
        !isAutoAgentId(candidate.agent_id),
    );
    const evicted: string[] = [];
    for (const [id, agent] of [...this.agents.entries()]) {
      if (!isPendingAgentId(id)) {
        continue;
      }
      if (!this.canMutateForObservedAbsence(agent)) {
        continue;
      }

      const liveBackingSurface = liveSurfaceRefs.has(agent.surface_id);
      const supersededByManagedSeat = managedRecords.some(
        (candidate) =>
          candidate.surface_id === agent.surface_id &&
          identityKeysOverlap(
            recordIdentityKeys(agent),
            recordIdentityKeys(candidate),
          ),
      );
      const supersededByRealRecord = [...this.agents.values()].some(
        (candidate) =>
          candidate.agent_id !== id &&
          candidate.surface_id === agent.surface_id &&
          !isPendingAgentId(candidate.agent_id) &&
          !isAutoAgentId(candidate.agent_id),
      );

      if (!liveBackingSurface || supersededByRealRecord || supersededByManagedSeat) {
        const removedAgentId = this.evict(id);
        if (removedAgentId) {
          evicted.push(removedAgentId);
        }
      }
    }

    return evicted;
  }

  private repairDiscoveredSurface(
    discovered: DiscoveredAgent,
    candidate: RegistryRepairCandidate,
    evicted: Set<string>,
    liveSurfaceRefs: ReadonlySet<string>,
  ): RegistryRepairEntry | null {
    const recordsForSurface = [...this.agents.values()].filter(
      (agent) => agent.surface_id === discovered.surface_id,
    );
    const managedRecord = recordsForSurface.find(
      (agent) =>
        !isAutoAgentId(agent.agent_id) &&
        !isPendingAgentId(agent.agent_id) &&
        !hasSurfaceUuidConflict(agent, discovered) &&
        this.canUseObservedBinding(agent, discovered.surface_uuid),
    );

    if (managedRecord) {
      const updated = this.updateManagedSurfaceRegistration(
        managedRecord,
        discovered,
        candidate,
      );
      return updated
        ? this.repairEntry(updated, discovered, candidate, "updated")
        : null;
    }

    const existingSeatRecord = this.stateMgr.readState(candidate.agentId);
    const seatIsManagedOnAnotherLiveSurface = Boolean(
      existingSeatRecord &&
        existingSeatRecord.surface_id !== discovered.surface_id &&
        liveSurfaceRefs.has(existingSeatRecord.surface_id),
    );

    for (const record of recordsForSurface) {
      if (
        isAutoAgentId(record.agent_id) ||
        (isPendingAgentId(record.agent_id) &&
          !seatIsManagedOnAnotherLiveSurface)
      ) {
        const removedAgentId = this.evict(record.agent_id);
        if (removedAgentId) {
          evicted.add(removedAgentId);
        }
      }
    }

    if (existingSeatRecord) {
      if (hasSurfaceUuidConflict(existingSeatRecord, discovered)) {
        return null;
      }
      if (!this.canUseObservedBinding(existingSeatRecord, discovered.surface_uuid)) {
        return null;
      }
      if (
        existingSeatRecord.surface_id !== discovered.surface_id &&
        liveSurfaceRefs.has(existingSeatRecord.surface_id)
      ) {
        return null;
      }

      const updated = this.updateManagedSurfaceRegistration(
        existingSeatRecord,
        discovered,
        candidate,
      );
      return updated
        ? this.repairEntry(updated, discovered, candidate, "updated")
        : this.repairEntry(existingSeatRecord, discovered, candidate, "updated");
    }

    const created = this.createRepairedRecord(discovered, candidate);
    this.stateMgr.writeState(created);
    this.agents.set(created.agent_id, created);
    return this.repairEntry(created, discovered, candidate, "created");
  }

  private updateManagedSurfaceRegistration(
    record: AgentRecord,
    discovered: DiscoveredAgent,
    candidate: RegistryRepairCandidate,
  ): AgentRecord | null {
    if (
      hasSurfaceUuidConflict(record, discovered) ||
      !this.canUseObservedBinding(record, discovered.surface_uuid)
    ) {
      return null;
    }
    const patch = patchForRepairCandidate(record, discovered, candidate);
    const observerId = this.getObserverId();
    if (observerId && record.surface_observer_id !== observerId) {
      patch.surface_observer_id = observerId;
    }
    if (Object.keys(patch).length === 0) {
      return null;
    }

    let updated: AgentRecord;
    try {
      updated = this.stateMgr.updateRecord(record.agent_id, patch);
    } catch (error) {
      const missingState = this.getMissingStateSentinel(record.agent_id);
      if (missingState) {
        throw missingState;
      }
      throw error;
    }
    this.agents.delete(record.agent_id);
    this.agents.set(updated.agent_id, updated);
    return updated;
  }

  private createRepairedRecord(
    discovered: DiscoveredAgent,
    candidate: RegistryRepairCandidate,
  ): AgentRecord {
    const now = new Date().toISOString();
    const state = discoveredStatusToAgentState(discovered.parsed_status);
    return {
      agent_id: candidate.agentId,
      surface_id: discovered.surface_id,
      surface_uuid: discovered.surface_uuid ?? null,
      surface_observer_id: this.getObserverId(),
      workspace_id: discovered.workspace_id ?? null,
      state,
      repo: candidate.repo,
      model: discovered.model ?? "unknown",
      cli: candidate.cli,
      cli_session_id: null,
      cli_session_path: null,
      launcher_name: candidate.launcherName,
      seat_id: candidate.seat.seat_id,
      seat_lane: candidate.seat.seat_lane,
      seat_role: candidate.seat.seat_role,
      seat_identity_status: candidate.seat.seat_identity_status,
      seat_identity_error: candidate.seat.seat_identity_error,
      task_summary: "(resync-repaired)",
      pid: null,
      version: 1,
      created_at: now,
      updated_at: now,
      error:
        state === "error"
          ? "Repaired agent surface reported a frozen state"
          : null,
      parent_agent_id: null,
      spawn_depth: 0,
      role: candidate.role,
      auto_archive_on_done: false,
      deletion_intent: false,
      quality: "unknown",
      max_cost_per_agent: null,
      crash_recover: candidate.role === "orchestrator",
      respawn_attempts: 0,
      user_killed: false,
    };
  }

  private repairEntry(
    record: AgentRecord,
    discovered: DiscoveredAgent,
    candidate: RegistryRepairCandidate,
    action: "created" | "updated",
  ): RegistryRepairEntry {
    return {
      surface_id: discovered.surface_id,
      ...(discovered.surface_uuid != null
        ? { surface_uuid: discovered.surface_uuid }
        : {}),
      surface_title: discovered.surface_title,
      agent_id: record.agent_id,
      repo: candidate.repo,
      cli: candidate.cli,
      role: candidate.role,
      launcher_name: candidate.launcherName,
      seat_id: candidate.seat.seat_id,
      action,
    };
  }

  private evictMissingStateAgent(agentId: string): boolean {
    if (this.getMissingStateSentinel(agentId) === null) {
      return false;
    }

    const removedAgentId = this.deleteAgentAndAliases(agentId);
    this.stateMgr.removeState(removedAgentId);
    return true;
  }

  private getMissingStateSentinel(agentId: string): AgentNotFoundError | null {
    if (this.stateMgr.hasStateFile(agentId)) {
      return null;
    }

    return new AgentNotFoundError(agentId);
  }

  private async evictBootingGhosts(
    discovered: DiscoveredAgent[],
  ): Promise<void> {
    if (hasMixedDiscoveryIdentityCoverage(discovered)) {
      return;
    }
    const now = Date.now();
    const bySurface = new Map(discovered.map((entry) => [entry.surface_id, entry]));

    for (const [id, agent] of [...this.agents.entries()]) {
      if (agent.state !== "booting") {
        continue;
      }
      if (!this.canMutateForObservedAbsence(agent)) {
        continue;
      }
      const lastUpdated = Date.parse(agent.updated_at);
      if (Number.isNaN(lastUpdated)) {
        continue;
      }
      if (now - lastUpdated < BOOTING_GHOST_TIMEOUT_MS) {
        continue;
      }

      const discoveredEntry = bySurface.get(agent.surface_id);
      if (
        !discoveredEntry ||
        discoveredEntry.read_error ||
        discoveredEntry.has_agent
      ) {
        continue;
      }

      try {
        this.stateMgr.transition(id, "error", {
          error: "Launch failed — no agent detected in surface after boot timeout",
        });
      } catch {
        // Best-effort transition before eviction.
      }

      const removedAgentId = this.deleteAgentAndAliases(id);
      this.stateMgr.removeState(removedAgentId);
    }
  }

  /**
   * Startup purge: remove terminal-state agents (done/error) without checking
   * whether their old surface ref was recycled into the new cmux session.
   * Called after reconstitute() to clear stale entries from previous cmux sessions.
   *
   * More aggressive than purgeTerminal() because it doesn't check surface existence:
   * after cmux restart, surface refs get recycled (surface:3 in a new session
   * ≠ surface:3 from before), so a live surface ref doesn't mean the agent is alive.
   *
   * Callers can retain errors created by surfaceless reconciliation so those
   * ambiguous topology misses still pass through the normal confirmation gate.
   *
   * Returns purged agent records for sidebar cleanup.
   */
  purgeAllTerminal(
    opts: { retainAgentIds?: ReadonlySet<string> } = {},
  ): AgentRecord[] {
    const purgedAgents: AgentRecord[] = [];

    for (const [id, agent] of this.agents) {
      if (
        shouldRetainCrashRecoveryError(agent) &&
        this.canControlSurface(agent)
      ) {
        continue;
      }
      if (!this.canPurgeAtStartup(agent)) {
        continue;
      }
      if (opts.retainAgentIds?.has(agent.agent_id)) {
        continue;
      }
      if (TERMINAL_STATES.has(agent.state)) {
        purgedAgents.push(agent);
        const removedAgentId = this.deleteAgentAndAliases(id);
        this.stateMgr.removeState(removedAgentId);
      }
    }

    return purgedAgents;
  }

  /**
   * Purge terminal-state agents (done/error) whose surface no longer exists.
   * Used by the periodic sweep — less aggressive than purgeStale().
   * Agents whose surface is still alive are kept (user may want to inspect output).
   */
  async purgeTerminal(
    opts: { confirmationMs?: number; now?: number } = {},
  ): Promise<number> {
    const observerSnapshot = this.captureObserverSnapshot();
    let surfaces: CmuxSurface[];
    try {
      surfaces = await this.surfaceProvider();
    } catch {
      return 0;
    }
    if (!this.isObserverSnapshotCurrent(observerSnapshot)) {
      return 0;
    }
    if (surfaces.length === 0) {
      return 0;
    }
    if (!hasCoherentSurfaceIdentity(surfaces)) {
      this.surfacelessObservations.clear();
      return 0;
    }
    const liveSurfaceKeys = this.liveSurfaceKeys(surfaces);
    this.clearSurfacelessObservationsForLiveSurfaces(liveSurfaceKeys);
    const confirmationOpts = {
      confirmationMs:
        opts.confirmationMs ?? SURFACE_EVICTION_CONFIRMATION_MS,
      ...(opts.now === undefined ? {} : { now: opts.now }),
    };
    let purged = 0;

    for (const [id, agent] of this.agents) {
      if (shouldRetainCrashRecoveryError(agent)) {
        continue;
      }
      if (agent.role === "orchestrator" || agent.role === "ic") {
        continue;
      }
      if (this.matchingLiveSurface(agent, surfaces)) {
        this.surfacelessObservations.delete(agent.agent_id);
        continue;
      }
      if (!this.isSurfaceAbsenceAuthoritative(agent, surfaces)) {
        this.surfacelessObservations.delete(agent.agent_id);
        continue;
      }
      if (
        TERMINAL_STATES.has(agent.state) &&
        this.isSurfacelessConfirmed(
          agent,
          liveSurfaceKeys,
          confirmationOpts,
          observerSnapshot.ownerId,
        )
      ) {
        const removedAgentId = this.deleteAgentAndAliases(id);
        this.stateMgr.removeState(removedAgentId);
        purged++;
      }
    }

    return purged;
  }

  /**
   * Get direct children of parentId.
   */
  getChildren(parentId: string): AgentRecord[] {
    const parentIds = new Set<string>([parentId]);
    const parent = this.get(parentId);
    if (parent) {
      parentIds.add(parent.agent_id);
      for (const alias of this.aliasesResolvingTo(parent.agent_id)) {
        parentIds.add(alias);
      }
    }

    return [...this.agents.values()].filter(
      (a) => a.parent_agent_id !== null && parentIds.has(a.parent_agent_id),
    );
  }

  /**
   * Get all agents in the subtree rooted at rootId (including root).
   * DFS post-order: children before root.
   */
  getSubtree(rootId: string): AgentRecord[] {
    const result: AgentRecord[] = [];
    const visited = new Set<string>();
    const root = this.get(rootId);
    if (!root) {
      return result;
    }
    const collect = (id: string) => {
      if (visited.has(id)) return; // Prevent cycles from corrupted state
      visited.add(id);
      const children = this.getChildren(id);
      for (const child of children) {
        collect(child.agent_id);
      }
      const agent = this.agents.get(id);
      if (agent) result.push(agent);
    };
    collect(root.agent_id);
    return result;
  }
}
