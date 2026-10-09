import { createHash } from "node:crypto";
import { constants, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { isAbsolute } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { AgentRecord } from "./agent-types.js";
import type { AgentRegistry } from "./agent-registry.js";
import type { StateManager } from "./state-manager.js";
import type { CmuxWorkspace } from "./types.js";
import { resolveAgentSurfaceBinding, type SurfaceTopologySnapshot } from "./surface-topology.js";
import { validateSurfaceIdentityBijection } from "./surface-topology.js";
import { makeSelfRegistrationContinuityResolver, makeSelfRegistrationSessionHistoryLookup,
  parseSelfRegistrationLines, type SelfRegistrationEntry } from "./self-registration.js";
import { processLiveness, processStartedAtMs, qualifyAgentProcessLiveness,
  type ProcessLiveness, type SessionProcessScanner } from "./util/pid-alive.js";

export const AdoptSessionSchema = z.object({
  surface: z.string().uuid(), workspace: z.string().uuid(),
  managed_agent_id: z.string().min(1), session_id: z.string().min(1),
  expected_agent_version: z.number().int().nonnegative(),
  observer_transition: z.object({ historical_owner_id: z.string().min(1), current_owner_id: z.string().min(1) }).strict(),
  binding_evidence_path: z.string().refine(isAbsolute), binding_evidence_sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type AdoptSessionRequest = z.infer<typeof AdoptSessionSchema>;
export interface AdoptionProcessProof { liveness: ProcessLiveness; started_at: number | null; cwd: string | null; cli: string | null }
export interface AdoptionOptions {
  processProof?: (pid: number) => Promise<AdoptionProcessProof>;
  currentRegistration?: ReturnType<typeof makeSelfRegistrationContinuityResolver>;
  sessionHistory?: ReturnType<typeof makeSelfRegistrationSessionHistoryLookup>;
}
interface AdoptionHost {
  registry: AgentRegistry; stateMgr: StateManager; options?: AdoptionOptions;
  observe: () => Promise<{ topology: SurfaceTopologySnapshot | null; workspaces: CmuxWorkspace[] }>;
  sessionProcessScanner: SessionProcessScanner;
}
const key = (value: string | null | undefined) => value?.trim().toLowerCase();
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const exec = promisify(execFile);

/** Read only a fixed PID; absent tooling or incomplete process evidence refuses recovery. */
export async function readAdoptionProcess(pid: number): Promise<AdoptionProcessProof> {
  const liveness = processLiveness(pid), started_at = processStartedAtMs(pid);
  if (liveness !== "alive") return { liveness, started_at, cwd: null, cli: null };
  try {
    const opts = { timeout: 500, maxBuffer: 65536, encoding: "utf8" as const };
    const command = (await exec("ps", ["-p", String(pid), "-o", "ucomm="], opts)).stdout.trim();
    const lines = (await exec("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], opts)).stdout.split("\n");
    const paths = lines.filter(line => line.startsWith("n/")).map(line => line.slice(1));
    if (processStartedAtMs(pid) !== started_at || processLiveness(pid) !== "alive") throw new Error("PID changed");
    return { liveness, started_at, cli: command.split("/").at(-1) ?? null, cwd: paths.length === 1 ? paths[0]! : null };
  } catch { return { liveness: "unknown", started_at, cwd: null, cli: null }; }
}

function readPinnedWitness(request: AdoptSessionRequest): { historical: AgentRecord[]; registrations: SelfRegistrationEntry[] } {
  const fd = openSync(request.binding_evidence_path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > 1024 * 1024) throw new Error("Witness must be a bounded regular file");
    const bytes = Buffer.alloc(stat.size + 1), count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count !== stat.size || digest(bytes.subarray(0, count)) !== request.binding_evidence_sha256) throw new Error("Witness digest changed");
    const witness = JSON.parse(bytes.subarray(0, count).toString("utf8"));
    const historical = witness.historical_tool_receipts.flatMap((row: { tool_result: AgentRecord[] }) => row.tool_result)
      .filter((row: AgentRecord) => row.agent_id === request.managed_agent_id);
    const registrations = witness.exact_session_registrations.flatMap((row: { registration: unknown }) =>
      parseSelfRegistrationLines(JSON.stringify(row.registration)));
    return { historical, registrations };
  } finally { closeSync(fd); }
}

/** Explicitly rebind one existing identity. This function performs no pane/input/placement actions. */
export async function adoptManagedSession(host: AdoptionHost, input: AdoptSessionRequest) {
  const request = AdoptSessionSchema.parse(input), requestHash = digest(JSON.stringify(request));
  const { registry, stateMgr } = host, agent = stateMgr.readState(request.managed_agent_id);
  if (!agent || agent.agent_id.startsWith("auto-") || agent.surface_provenance !== "cmuxlayer_spawn" ||
      !agent.role || !agent.authority || !agent.placement || agent.cli !== "codex" || !agent.launch_cwd ||
      agent.cli_session_id !== request.session_id || agent.user_killed || agent.deletion_intent) throw new Error("Original managed identity disagrees");
  const repeat = agent.session_adoption?.request_sha256 === requestHash;
  if (!repeat && agent.version !== request.expected_agent_version) throw new Error("Original record version changed");
  const owner = registry.getObserverId(), epoch = registry.getObserverEpoch();
  const unbound = agent.surface_id === "surface:unbound" && !agent.surface_uuid && !agent.workspace_id;
  if (!owner || !epoch || owner !== request.observer_transition.current_owner_id ||
      (!unbound && ![owner, request.observer_transition.historical_owner_id].includes(agent.surface_observer_id ?? ""))) throw new Error("Observer selection disagrees");
  const witness = readPinnedWitness(request), historical = witness.historical[0];
  if (!historical || witness.historical.some(row => row.surface_uuid !== historical.surface_uuid ||
      row.workspace_id !== historical.workspace_id || row.surface_observer_id !== request.observer_transition.historical_owner_id ||
      row.cli_session_id !== agent.cli_session_id || row.launch_cwd !== agent.launch_cwd ||
      row.role !== agent.role || row.authority !== agent.authority || row.placement !== agent.placement ||
      row.surface_provenance !== "cmuxlayer_spawn") || !historical.surface_uuid || !historical.workspace_id) throw new Error("Historical binding disagrees");
  const registration = host.options?.currentRegistration ?? makeSelfRegistrationContinuityResolver();
  const history = host.options?.sessionHistory ?? makeSelfRegistrationSessionHistoryLookup();
  const readProcess = host.options?.processProof ?? readAdoptionProcess;
  const observe = async () => {
    const observed = await host.observe(), topology = observed.topology;
    if (!topology?.complete || topology.observerId !== owner || topology.observerEpoch !== epoch ||
        registry.getObserverId() !== owner || registry.getObserverEpoch() !== epoch ||
        topology.surfaces.some(surface => !surface.id) || !validateSurfaceIdentityBijection(
          topology.surfaces.map(surface => ({ surfaceRef: surface.ref, surfaceId: surface.id }))).isBijective) throw new Error("Current topology is ambiguous");
    const workspaces = observed.workspaces.filter(workspace => key(workspace.id) === key(request.workspace));
    const binding = resolveAgentSurfaceBinding({ surface_id: "surface:unbound", surface_uuid: request.surface }, topology);
    if (workspaces.length !== 1 || !binding || binding.workspaceId !== workspaces[0]!.ref ||
        topology.surfaces.some(surface => key(surface.id) === key(historical.surface_uuid)) ||
        (agent.surface_uuid && key(agent.surface_uuid) !== key(request.surface))) throw new Error("Selected seat or old-seat absence disagrees");
    return { binding, uuids: topology.surfaces.map(surface => surface.id!) };
  };
  const first = await observe(), proof = registration({ ...agent, surface_uuid: request.surface }, first.uuids);
  if (!proof?.pid || !proof.ts) throw new Error("Current exact registration is missing or conflicting");
  const qualified = async (row: SelfRegistrationEntry) => {
    if (!row.pid || row.pid < 1 || !row.ts) throw new Error("Relevant registration lacks qualified PID evidence");
    const process = await readProcess(row.pid);
    const liveness = qualifyAgentProcessLiveness({ pid: row.pid, created_at: agent.created_at,
      pid_registered_at: new Date(row.ts).toISOString() }, process.liveness, process.started_at, { ignoreCreationLowerBound: true });
    if (liveness === "unknown") throw new Error("Relevant PID liveness is unknown");
    return { ...process, liveness };
  };
  const current = await qualified(proof);
  if (current.liveness !== "alive" || current.cli !== agent.cli || current.cwd !== agent.launch_cwd) throw new Error("Current process CLI/cwd disagrees");
  const knownHistory = history(request.session_id);
  if (!knownHistory) throw new Error("Known registration history is unreadable");
  const recordedClaimants: SelfRegistrationEntry[] = [agent, ...witness.historical]
    .filter(row => row.pid && row.pid !== proof.pid).map(row => ({ ...proof, pid: row.pid!,
      ts: Date.parse(row.pid_registered_at ?? "") }));
  for (const row of [...witness.registrations, ...knownHistory, ...recordedClaimants]) {
    if (row.session_id !== request.session_id || row.pid === proof.pid) continue;
    if ((await qualified(row)).liveness === "alive") throw new Error("Another known session process is live");
  }
  const argvProcesses = await host.sessionProcessScanner(request.session_id);
  for (const process of argvProcesses ?? []) {
    if (process.pid === proof.pid) continue;
    const observed = await readProcess(process.pid);
    if (observed.liveness === "unknown" || (observed.liveness === "alive" && observed.cli === agent.cli)) throw new Error("Known argv session claimant is unresolved");
  }
  const occupants = stateMgr.listStates().filter(row => row.agent_id !== agent.agent_id && key(row.surface_uuid) === key(request.surface));
  const auto = occupants[0];
  if (occupants.length > 1 || (auto && (!auto.agent_id.startsWith("auto-") || auto.cli !== agent.cli ||
      auto.surface_observer_id !== owner || auto.workspace_id !== first.binding.workspaceId || auto.boot_prompt_pending ||
      auto.blocked_on_prompt || auto.prompt_delivered === false || (auto.cli_session_id && auto.cli_session_id !== agent.cli_session_id) ||
      (auto.parent_agent_id && auto.parent_agent_id !== agent.parent_agent_id))) || stateMgr.listStates().some(row =>
        row.agent_id !== agent.agent_id && row.agent_id !== auto?.agent_id && row.cli_session_id === agent.cli_session_id)) throw new Error("Competing identity or target work cannot be preserved");
  if (auto && stateMgr.listStates().some(row => row.parent_agent_id === auto.agent_id)) throw new Error("Discovery identity has children");
  const last = await observe(), finalProcess = await qualified(proof);
  const finalStates = stateMgr.listStates();
  const finalOccupants = finalStates.filter(row => row.agent_id !== agent.agent_id && key(row.surface_uuid) === key(request.surface));
  if (JSON.stringify(finalOccupants) !== JSON.stringify(occupants) || finalStates.some(row =>
      row.agent_id !== agent.agent_id && row.agent_id !== auto?.agent_id && row.cli_session_id === agent.cli_session_id)) throw new Error("Competing identity changed before persistence");
  if (JSON.stringify(history(request.session_id)) !== JSON.stringify(knownHistory) ||
      last.binding.surfaceRef !== first.binding.surfaceRef || finalProcess.liveness !== "alive" ||
      finalProcess.started_at !== current.started_at ||
      finalProcess.cli !== agent.cli || finalProcess.cwd !== agent.launch_cwd ||
      JSON.stringify(registration({ ...agent, surface_uuid: request.surface }, last.uuids)) !== JSON.stringify(proof) ||
      stateMgr.readState(agent.agent_id)?.version !== agent.version || registry.getObserverEpoch() !== epoch) throw new Error("Adoption proof changed before persistence");
  if (repeat && (agent.surface_id !== last.binding.surfaceRef || key(agent.surface_uuid) !== key(request.surface) ||
      agent.workspace_id !== last.binding.workspaceId || agent.surface_observer_id !== owner ||
      agent.pid !== proof.pid || agent.pid_registered_at !== new Date(proof.ts).toISOString() ||
      agent.session_adoption?.observer_epoch !== epoch)) throw new Error("Prior adoption binding invalidated; use a fresh explicitly versioned request");
  const receipt = { request_sha256: requestHash, evidence_sha256: request.binding_evidence_sha256, observer_epoch: epoch, status: "pending_verify" as const };
  let result = agent;
  try {
    if (!repeat) result = stateMgr.updateRecord(agent.agent_id, { surface_id: last.binding.surfaceRef,
      surface_uuid: request.surface, workspace_id: last.binding.workspaceId, surface_observer_id: owner,
      pid: proof.pid, pid_registered_at: new Date(proof.ts).toISOString(), cli_session_path: proof.session_path ?? agent.cli_session_path,
      session_continuity_aliases: [...new Set([...(agent.session_continuity_aliases ?? []), ...(auto ? [auto.agent_id] : [])])], session_adoption: receipt });
    // state.json may survive a later index failure, even with an adopted marker.
    const index = stateMgr.getSurfaceSessionIndex();
    const routingMatches = () => {
      const entry = index.lookup({ workspace_id: result.workspace_id, surface_id: result.surface_id });
      return entry?.agent_id === result.agent_id && entry.cli_session_id === result.cli_session_id;
    };
    if (!routingMatches()) index.persistRecord(result);
    if (!routingMatches()) throw new Error("Adoption routing persistence is incomplete");
    for (const alias of result.session_continuity_aliases ?? []) stateMgr.retireDiscoveryState(alias, agent.agent_id);
    if (result.session_adoption?.status !== "adopted") result = stateMgr.updateRecord(agent.agent_id, { session_adoption: { ...receipt, status: "adopted" } });
    if (!routingMatches()) throw new Error("Adoption routing persistence is incomplete");
  } catch (error) {
    let persisted = stateMgr.readState(agent.agent_id);
    if (persisted?.session_adoption?.request_sha256 !== requestHash) throw error;
    // Completion's state write can precede its failed index write. Retain the
    // primary failure and pending status even if this cleanup also fails.
    if (persisted.session_adoption.status === "adopted") {
      try { persisted = stateMgr.updateRecord(agent.agent_id, { session_adoption: receipt }); }
      catch { persisted = stateMgr.readState(agent.agent_id) ?? persisted; }
    }
    result = persisted; registry.set(result.agent_id, result);
    for (const alias of result.session_continuity_aliases ?? []) registry.rename(alias, result.agent_id, result);
    return { status: "pending_verify" as const, agent_id: result.agent_id, error: String(error), evidence_sha256: receipt.evidence_sha256 };
  }
  registry.set(result.agent_id, result);
  for (const alias of result.session_continuity_aliases ?? []) registry.rename(alias, result.agent_id, result);
  return { status: "adopted" as const, agent_id: result.agent_id, surface_uuid: result.surface_uuid,
    workspace_uuid: request.workspace, observer_id: owner, session_id: result.cli_session_id,
    role: result.role, authority: result.authority, evidence_sha256: receipt.evidence_sha256,
    idempotent: repeat, argv_scan: argvProcesses === null ? "unavailable" : "observed", placement: "not_attempted" as const };
}
