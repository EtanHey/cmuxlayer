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

export type SurfaceProvider = () => Promise<CmuxSurface[]>;

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
  surface_title: string;
  agent_id: string;
  repo: string;
  cli: CliType;
  role: AgentRole;
  launcher_name: string;
  seat_id: string | null;
  action: "created" | "updated";
}

export interface RegistryRepairSummary {
  repaired: RegistryRepairEntry[];
  evicted: string[];
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

function primaryRecordIdentityKey(record: AgentRecord): string | null {
  if (record.seat_id) return `seat:${record.seat_id}`;
  if (record.launcher_name) return `launcher:${record.launcher_name}`;
  return null;
}

function canonicalIdentityName(record: AgentRecord): string | null {
  return record.seat_id ?? record.launcher_name ?? null;
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
  private stateMgr: StateManager;
  private surfaceProvider: SurfaceProvider;

  constructor(stateMgr: StateManager, surfaceProvider: SurfaceProvider) {
    this.stateMgr = stateMgr;
    this.surfaceProvider = surfaceProvider;
  }

  /**
   * Load all agent state from disk and cross-check against live surfaces.
   * Call once on startup.
   */
  async reconstitute(): Promise<void> {
    this.agents.clear();
    this.aliases.clear();

    const stateFiles = this.stateMgr.listStates();
    for (const record of stateFiles) {
      this.agents.set(record.agent_id, record);
    }

    await this.reconcileSurfaces();
  }

  /**
   * Periodic reconciliation: cross-check in-memory state against
   * actual cmux surfaces and state files on disk.
   */
  async reconcile(): Promise<void> {
    // Pick up new state files created by other processes
    const onDisk = this.stateMgr.listStates();
    for (const record of onDisk) {
      const existing = this.agents.get(record.agent_id);
      if (!existing || existing.version < record.version) {
        this.agents.set(record.agent_id, record);
      }
    }

    await this.reconcileSurfaces();
  }

  private async reconcileSurfaces(): Promise<void> {
    let surfaces: CmuxSurface[];
    try {
      surfaces = await this.surfaceProvider();
    } catch {
      // Treat enumeration failures as "unknown", not "zero surfaces". A transient
      // socket/listing failure must not mark every active agent as disappeared.
      return;
    }
    if (surfaces.length === 0) {
      // An empty topology is indistinguishable from a degraded cmux/app-server
      // listing path. Do not mass-mark agents dead until a non-empty scan proves
      // their specific surfaces are absent.
      return;
    }
    const liveSurfaceRefs = new Set(surfaces.map((s) => s.ref));

    // Phase 1: Mark agents with disappeared surfaces as error
    const crashedIds = new Set<string>();
    for (const [id, agent] of this.agents) {
      if (TERMINAL_STATES.has(agent.state)) continue;

      if (!liveSurfaceRefs.has(agent.surface_id)) {
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
        if (agent.parent_agent_id && crashedIds.has(agent.parent_agent_id)) {
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
    agent: Pick<AgentRecord, "surface_id">,
    opts: { ptyDead?: boolean } = {},
  ): Promise<boolean> {
    if (opts.ptyDead === true) {
      return false;
    }

    let surfaces: CmuxSurface[];
    try {
      surfaces = await this.surfaceProvider();
    } catch {
      // "Live" here means "not proven absent" for liveness guards.
      return true;
    }
    if (surfaces.length === 0) {
      // Empty enumeration is inconclusive until a non-empty scan proves absence.
      return true;
    }
    return surfaces.some((surface) => surface.ref === agent.surface_id);
  }

  async hasLiveSurface(surfaceId: string): Promise<boolean> {
    return this.isSurfaceAlive({ surface_id: surfaceId });
  }

  async listMerged(
    discovery: AgentDiscovery,
    opts?: { filter?: AgentFilter; force?: boolean },
  ): Promise<MergedAgent[]> {
    await this.reconcile();
    await this.purgeTerminal();

    const discovered = await discovery.scan(opts?.force ?? false);
    await this.evictBootingGhosts(discovered);

    const bySurface = new Map(discovered.map((entry) => [entry.surface_id, entry]));
    const repairCandidates = this.liveRepairCandidatesForDiscovery(discovered);
    this.selfHealManagedRegistrationsFromDiscovery(repairCandidates, bySurface);
    const suppressedDuplicateSurfaceRefs =
      this.duplicateDiscoverySurfaceRefs(repairCandidates);
    const merged: MergedAgent[] = [];
    const seenSurfaces = new Set<string>();

    for (const record of this.list()) {
      const discoveredEntry = bySurface.get(record.surface_id);
      const isAutoRecord = record.agent_id.startsWith("auto-");

      if (
        isAutoRecord &&
        discoveredEntry &&
        !discoveredEntry.read_error &&
        !discoveredEntry.has_agent
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

      seenSurfaces.add(record.surface_id);
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
        discoveredEntry.read_error
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
        discoveredEntry.surface_id,
      );
      const record = this.stateMgr.ensureAutoRecord(agentId, discoveredEntry);
      this.agents.set(agentId, record);
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

    const discovered = await discovery.scan(opts?.force ?? false);
    const bySurface = new Map(
      discovered
        .filter((entry) => !entry.read_error)
        .map((entry) => [entry.surface_id, entry]),
    );

    let requested: AgentRecord | null = null;
    for (const record of records) {
      if (record.agent_id.startsWith("auto-")) {
        continue;
      }
      const discoveredEntry = bySurface.get(record.surface_id);
      if (!discoveredEntry) {
        continue;
      }
      const updated = this.syncManagedRecordSurfaceMetadata(
        record,
        discoveredEntry,
      );
      if (!updated) {
        continue;
      }
      if (!opts?.agentId || updated.agent_id === this.resolveAlias(opts.agentId)) {
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
      const candidate = repairCandidateForSurface(entry);
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

  private selfHealManagedRegistrationsFromDiscovery(
    candidates: LiveRepairCandidate[],
    bySurface: ReadonlyMap<string, DiscoveredAgent>,
  ): void {
    if (candidates.length === 0) return;

    const claimedSurfaceRefs = new Set<string>();
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
          identityKeysOverlap(recordKeys, entry.identityKeys),
      );
      if (currentLiveCandidate) {
        claimedSurfaceRefs.add(currentLiveCandidate.discovered.surface_id);
        continue;
      }

      const currentSurface = bySurface.get(record.surface_id);
      if (
        currentSurface &&
        (currentSurface.read_error || currentSurface.has_agent)
      ) {
        continue;
      }

      const replacement = candidates.find(
        (entry) =>
          !claimedSurfaceRefs.has(entry.discovered.surface_id) &&
          identityKeysOverlap(recordKeys, entry.identityKeys),
      );
      if (!replacement) continue;

      const moved =
        this.updateManagedSurfaceRegistration(
          record,
          replacement.discovered,
          replacement.candidate,
        ) ?? record;
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
    const agentId = record.agent_id;
    const repo = inferRepoFromTitle(discoveredEntry.surface_title) || record.repo;
    const model = discoveredEntry.model ?? record.model;
    const workspaceId = discoveredEntry.workspace_id ?? null;
    const desiredState = discoveredStatusToAgentState(
      discoveredEntry.parsed_status,
    );

    const patch: Partial<AgentRecord> = {};
    if (repo !== record.repo) patch.repo = repo;
    if (model !== record.model) patch.model = model;
    if ((record.workspace_id ?? null) !== workspaceId) {
      patch.workspace_id = workspaceId;
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
    if (discoveredEntry.workspace_id == null) {
      return record;
    }
    const workspaceId = discoveredEntry.workspace_id;
    if ((record.workspace_id ?? null) === workspaceId) {
      return record;
    }

    try {
      const updated = this.stateMgr.updateRecord(record.agent_id, {
        workspace_id: workspaceId,
      });
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
    if (!this.agents.has(resolved) && this.stateMgr.readState(resolved) === null) {
      return null;
    }

    const removedAgentId = this.deleteAgentAndAliases(agentId);
    this.stateMgr.removeState(removedAgentId);
    return removedAgentId;
  }

  async evictSurfaceless(): Promise<string[]> {
    let surfaces: CmuxSurface[];
    try {
      surfaces = await this.surfaceProvider();
    } catch {
      return [];
    }
    if (surfaces.length === 0) {
      return [];
    }

    const liveSurfaceRefs = new Set(surfaces.map((surface) => surface.ref));
    const evicted: string[] = [];

    for (const [id, agent] of [...this.agents.entries()]) {
      if (isCrashRecoveryEligible(agent)) {
        continue;
      }
      if (liveSurfaceRefs.has(agent.surface_id)) {
        continue;
      }

      const removedAgentId = this.evict(id);
      if (removedAgentId) {
        evicted.push(removedAgentId);
      }
    }

    return evicted;
  }

  repairFromDiscovery(
    discovered: DiscoveredAgent[],
    opts?: { seatRegistry?: SeatRegistry | null },
  ): RegistryRepairSummary {
    const repaired: RegistryRepairEntry[] = [];
    const evicted = new Set<string>();
    const liveSurfaceRefs = new Set(
      discovered
        .filter((entry) => !entry.read_error)
        .map((entry) => entry.surface_id),
    );

    for (const removed of this.evictPendingGhostRegistrations(liveSurfaceRefs)) {
      evicted.add(removed);
    }

    for (const entry of discovered) {
      if (entry.read_error) continue;
      const candidate = repairCandidateForSurface(entry, opts?.seatRegistry);
      if (!candidate) continue;

      const repair = this.repairDiscoveredSurface(
        entry,
        candidate,
        evicted,
        liveSurfaceRefs,
      );
      if (repair) {
        repaired.push(repair);
      }
    }

    for (const removed of this.evictDuplicateManagedRegistrations(liveSurfaceRefs)) {
      evicted.add(removed);
    }

    for (const removed of this.evictPendingGhostRegistrations(liveSurfaceRefs)) {
      evicted.add(removed);
    }

    return { repaired, evicted: [...evicted] };
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

  private evictDuplicateManagedRegistrations(
    liveSurfaceRefs: ReadonlySet<string>,
  ): string[] {
    const byIdentity = new Map<string, AgentRecord[]>();
    for (const record of this.agents.values()) {
      if (isAutoAgentId(record.agent_id) || isPendingAgentId(record.agent_id)) {
        continue;
      }
      const key = primaryRecordIdentityKey(record);
      if (!key) continue;
      byIdentity.set(key, [...(byIdentity.get(key) ?? []), record]);
    }

    const evicted: string[] = [];
    for (const records of byIdentity.values()) {
      if (records.length <= 1) continue;
      const sorted = [...records].sort((left, right) => {
        const leftCanonical =
          left.agent_id === canonicalIdentityName(left) ? 0 : 1;
        const rightCanonical =
          right.agent_id === canonicalIdentityName(right) ? 0 : 1;
        if (leftCanonical !== rightCanonical) {
          return leftCanonical - rightCanonical;
        }
        const leftLive = liveSurfaceRefs.has(left.surface_id) ? 0 : 1;
        const rightLive = liveSurfaceRefs.has(right.surface_id) ? 0 : 1;
        if (leftLive !== rightLive) {
          return leftLive - rightLive;
        }
        return left.agent_id.localeCompare(right.agent_id);
      });
      const keep = sorted[0];
      for (const duplicate of sorted.slice(1)) {
        const removedAgentId = this.evict(duplicate.agent_id);
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
        !isAutoAgentId(agent.agent_id) && !isPendingAgentId(agent.agent_id),
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
    const patch = patchForRepairCandidate(record, discovered, candidate);
    if (Object.keys(patch).length === 0) {
      return null;
    }

    const updated = this.stateMgr.updateRecord(record.agent_id, patch);
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
    if (this.stateMgr.readState(agentId) !== null) {
      return null;
    }

    return new AgentNotFoundError(agentId);
  }

  private async evictBootingGhosts(
    discovered: DiscoveredAgent[],
  ): Promise<void> {
    const now = Date.now();
    const bySurface = new Map(discovered.map((entry) => [entry.surface_id, entry]));

    for (const [id, agent] of [...this.agents.entries()]) {
      if (agent.state !== "booting") {
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
   * Startup purge: remove ALL terminal-state agents (done/error) unconditionally.
   * Called after reconstitute() to clear stale entries from previous cmux sessions.
   *
   * More aggressive than purgeTerminal() because it doesn't check surface existence:
   * after cmux restart, surface refs get recycled (surface:3 in a new session
   * ≠ surface:3 from before), so a live surface ref doesn't mean the agent is alive.
   *
   * Non-terminal agents with dead surfaces are already handled by reconcileSurfaces()
   * (marked as error during reconstitute), then caught here as terminal.
   *
   * Returns purged agent records for sidebar cleanup.
   */
  purgeAllTerminal(): AgentRecord[] {
    const purgedAgents: AgentRecord[] = [];

    for (const [id, agent] of this.agents) {
      if (shouldRetainCrashRecoveryError(agent)) {
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
  async purgeTerminal(): Promise<number> {
    let surfaces: CmuxSurface[];
    try {
      surfaces = await this.surfaceProvider();
    } catch {
      return 0;
    }
    if (surfaces.length === 0) {
      return 0;
    }
    const liveSurfaceRefs = new Set(surfaces.map((s) => s.ref));
    let purged = 0;

    for (const [id, agent] of this.agents) {
      if (shouldRetainCrashRecoveryError(agent)) {
        continue;
      }
      if (agent.role === "orchestrator" || agent.role === "ic") {
        continue;
      }
      if (
        TERMINAL_STATES.has(agent.state) &&
        !liveSurfaceRefs.has(agent.surface_id)
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
