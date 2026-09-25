/**
 * Agent lifecycle: spawn, resume, wait and stop. Moved verbatim from agent-engine.ts (CX-3 E8).
 */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { AgentEngine } from "../agent-engine.js";
import { resumeInvocationForAgent, toPublicAgent } from "../agent-facade.js";
import { SURFACE_EVICTION_CONFIRMATION_MS } from "../agent-registry.js";
import {
  type AgentRecord,
  type AgentRoute,
  type AgentState,
  MAX_CHILDREN,
  MAX_SPAWN_DEPTH,
  type WaitResult,
  generateAgentId,
  summarizeTaskSummary,
} from "../agent-types.js";
import { inferAgentRole, inferRecordRole } from "../layout-policy.js";
import {
  INTERACTIVE_AGENT_STATES,
  type LiveAgentState,
  isLiveActive,
  resolveLiveAgentState,
} from "../live-agent-state.js";
import {
  resolveSpawnEffort,
  resolveSpawnModelPolicy,
} from "../model-policy.js";
import { buildTitle } from "../naming.js";
import { matchReadyPattern } from "../pattern-registry.js";
import { agentProcessLiveness } from "../process-liveness.js";
import {
  antigravityScreenIsActive,
  isAntigravityScreen,
  parseScreen,
} from "../screen-parser.js";
import { assertSeatIdentity } from "../seat-identity.js";
import { initializeNewSurfaceRuntime } from "../surface-runtime.js";
import {
  buildLaunchCommand,
  describeModelPin,
  resolveLaunchModelFlagForCommand,
} from "./launch-command.js";
import {
  AgentLaunchError,
  type AgentLaunchMode,
  BOOT_SESSION_CAPTURE_LINES,
  type CreatedAgentSurface,
  type RefreshedTargetStateEvidenceSource,
  STOP_POST_CONDITION_POLL_MS,
  type SpawnAgentParams,
  type SpawnAgentResult,
  type StopPostConditionResult,
  TERMINAL_STATES,
  WAIT_FOR_LIVE_EVIDENCE_INTERVAL_MS,
  WAIT_FOR_SWEEP_INTERVAL_MS,
} from "./types.js";


function isWorktreeLaunch(
  params: Pick<SpawnAgentParams, "cwd" | "worktree_branch">,
): boolean {
  if (params.worktree_branch) return true;
  const cwd = params.cwd;
  if (!cwd) return false;
  return (
    /(?:^|[/\\])[^/\\]+\.wt(?:[/\\]|$)/.test(cwd) ||
    /(?:^|[/\\])\.worktrees(?:[/\\]|$)/.test(cwd)
  );
}

/**
 * The title of a managed pane (#492 / #479). A caller-supplied title is already
 * the complete human-facing label, including its role/task convention, so the
 * engine must not compose launcher, surface, or agent-id text around it. Legacy
 * callers that omit or blank a title retain the existing agent-id/surface
 * fallback. Managed repo/CLI/role identity stays in AgentRecord and discovery
 * reads that registry state; the display title is never the identity source.
 */
export function managedPaneTitle(
  agentId: string,
  surface: string,
  title?: string | null,
): string {
  return title?.trim() ? title : buildTitle(`${agentId} [${surface}]`);
}

/**
 * The engine surface these functions read and drive. AgentEngine builds it
 * once (lifecycleHost()); fields are live getters and methods forward to the
 * engine, so spies on the engine still intercept.
 */
export interface LifecycleHost {
  readonly client: AgentEngine["client"];
  readonly freshLiveStateProbe: AgentEngine["freshLiveStateProbe"];
  readonly freshLiveStates: AgentEngine["freshLiveStates"];
  readonly registry: AgentEngine["registry"];
  readonly seatRegistry: AgentEngine["seatRegistry"];
  readonly selfRegistrationSessionLookup: AgentEngine["selfRegistrationSessionLookup"];
  readonly selfRegistrationSessionResolver: AgentEngine["selfRegistrationSessionResolver"];
  readonly spawnGuard: AgentEngine["spawnGuard"];
  readonly spawnPreflight: AgentEngine["spawnPreflight"];
  readonly stateMgr: AgentEngine["stateMgr"];
  readonly stopPostConditionTimeoutMs: AgentEngine["stopPostConditionTimeoutMs"];
  assertSurfaceObserverEpochCurrent: AgentEngine["assertSurfaceObserverEpochCurrent"];
  captureBootSessionId: AgentEngine["captureBootSessionId"];
  captureCodexSpawnSessionId: AgentEngine["captureCodexSpawnSessionId"];
  cleanupUnboundCreatedSurface: AgentEngine["cleanupUnboundCreatedSurface"];
  createAgentSurface: AgentEngine["createAgentSurface"];
  formatStopPostConditionError: AgentEngine["formatStopPostConditionError"];
  geminiHasSettledReply: AgentEngine["geminiHasSettledReply"];
  getTargetStateEvidenceSource: AgentEngine["getTargetStateEvidenceSource"];
  interactiveMatchScreenIsActive: AgentEngine["interactiveMatchScreenIsActive"];
  isAgentSurfaceGone: AgentEngine["isAgentSurfaceGone"];
  isExactDurableSurfaceBinding: AgentEngine["isExactDurableSurfaceBinding"];
  isPaneGone: AgentEngine["isPaneGone"];
  isProcessConfirmedGone: AgentEngine["isProcessConfirmedGone"];
  isProcessGone: AgentEngine["isProcessGone"];
  isProcessMissingError: AgentEngine["isProcessMissingError"];
  liveStateOf: AgentEngine["liveStateOf"];
  readAgentScreen: AgentEngine["readAgentScreen"];
  readStopPostCondition: AgentEngine["readStopPostCondition"];
  reconcileRolePlacements: AgentEngine["reconcileRolePlacements"];
  refreshLiveState: AgentEngine["refreshLiveState"];
  refreshTargetStateEvidence: AgentEngine["refreshTargetStateEvidence"];
  resolveAgentIoRoute: AgentEngine["resolveAgentIoRoute"];
  resolveAgentRoute: AgentEngine["resolveAgentRoute"];
  resolveAgentStopIoRoute: AgentEngine["resolveAgentStopIoRoute"];
  resolveResumeAgent: AgentEngine["resolveResumeAgent"];
  resolveStopSurfaceClosePolicy: AgentEngine["resolveStopSurfaceClosePolicy"];
  resolveUnchangedAgentStopIoRoute: AgentEngine["resolveUnchangedAgentStopIoRoute"];
  sameSurfaceRoute: AgentEngine["sameSurfaceRoute"];
  schedulePostSpawnLivenessAssertion: AgentEngine["schedulePostSpawnLivenessAssertion"];
  sendLaunchCommand: AgentEngine["sendLaunchCommand"];
  stableSurfaceWriteOptions: AgentEngine["stableSurfaceWriteOptions"];
  stopAgent: AgentEngine["stopAgent"];
  terminationStateOf: AgentEngine["terminationStateOf"];
  waitForStopPostCondition: AgentEngine["waitForStopPostCondition"];
}

/**
 * Spawn an agent — async, returns immediately with agent handle.
 * Does NOT wait for ready state.
 */
export async function spawnAgent(this: LifecycleHost, params: SpawnAgentParams): Promise<SpawnAgentResult> {
  const modelPolicy = resolveSpawnModelPolicy(params.cli, params.model);
  const effort = resolveSpawnEffort(params.cli, params.effort);
  const spawnParams: SpawnAgentParams = {
    ...params,
    model: modelPolicy.effective_model,
  };
  const agentId = generateAgentId(spawnParams.cli, spawnParams.repo);

  // Resolve parent hierarchy
  let spawnDepth = 0;
  let parentAgentId: string | null = null;
  let parentAgent: AgentRecord | null = null;

  if (spawnParams.parent_agent_id) {
    let parent =
      this.registry.get(spawnParams.parent_agent_id) ??
      this.stateMgr.readState(spawnParams.parent_agent_id);
    if (!parent) {
      throw new Error(
        `Parent agent not found: ${spawnParams.parent_agent_id}`,
      );
    }
    if (!this.registry.get(parent.agent_id)) {
      this.registry.set(parent.agent_id, parent);
    }
    if (parent.surface_uuid) {
      await this.resolveAgentIoRoute(parent.agent_id);
      parent = this.registry.get(parent.agent_id);
      if (!parent) {
        throw new Error(
          `Parent agent disappeared while resolving its stable surface: ${spawnParams.parent_agent_id}`,
        );
      }
    }
    if (parent.spawn_depth >= MAX_SPAWN_DEPTH) {
      throw new Error(`Max spawn depth exceeded: ${MAX_SPAWN_DEPTH}`);
    }
    const childrenById = new Map<string, AgentRecord>();
    for (const child of this.stateMgr.listStates()) {
      if (
        child.parent_agent_id === parent.agent_id &&
        !TERMINAL_STATES.has(child.state)
      ) {
        childrenById.set(child.agent_id, child);
      }
    }
    for (const child of this.registry.getChildren(parent.agent_id)) {
      if (TERMINAL_STATES.has(child.state)) continue;
      childrenById.set(child.agent_id, child);
    }
    if (childrenById.size >= MAX_CHILDREN) {
      throw new Error(`Max children exceeded: ${MAX_CHILDREN}`);
    }
    spawnDepth = parent.spawn_depth + 1;
    parentAgentId = parent.agent_id;
    parentAgent = parent;
  }

  // Job role is authoritative. The versioned tool rejects missing agent
  // axes; direct legacy engine callers default to worker without consulting
  // the selected harness.
  const role =
    spawnParams.role !== undefined
      ? inferAgentRole({ role: spawnParams.role })
      : "worker";
  const authority =
    spawnParams.authority ?? (role === "orchestrator" ? "lead" : "worker");

  this.spawnGuard.check(spawnParams.workspace);

  const preflight = await this.spawnPreflight(spawnParams);
  const launchCwd = spawnParams.cwd ?? preflight?.repoRoot ?? null;
  const launchMode: AgentLaunchMode = preflight?.launchMode ?? "launcher";
  // Truthful provenance for BOTH the door we used and the pin we applied.
  // Neither may be inferable only from a null field on the record.
  const modelPin = describeModelPin(
    spawnParams.cli,
    launchMode,
    resolveLaunchModelFlagForCommand(
      spawnParams.cli,
      modelPolicy.launcher_model ?? undefined,
      { allowModelOverride: modelPolicy.override_allowed },
    ),
    modelPolicy.effective_model,
  );
  const collabPath =
    spawnParams.collab_path ??
    (role === "worker" ? parentAgent?.collab_path : null) ??
    null;
  const launchWarnings = [
    ...modelPolicy.warnings,
    ...(role === "worker" && parentAgentId && !collabPath
      ? ["collab_path missing: declare the parent lead channel before coordinating workers"]
      : []),
    ...(launchMode === "raw" && preflight?.launchModeReason
      ? [
          `RAW LAUNCH: ${preflight.launchModeReason} Started \`${spawnParams.cli}\` ` +
            `directly in "${launchCwd ?? "the surface cwd"}" -- without the ` +
            `launcher's MCP wiring or contexts.`,
        ]
      : []),
    ...(modelPin.warning ? [modelPin.warning] : []),
  ];
  const seatIdentity = assertSeatIdentity({
    repo: spawnParams.repo,
    cli: spawnParams.cli,
    launcherName: preflight?.launcherName ?? null,
    registry: this.seatRegistry,
  });
  if (seatIdentity.seat_identity_status === "mismatch") {
    throw new Error(
      `Spawn blocked by seat identity mismatch: ${
        seatIdentity.seat_identity_error ?? "registry identity mismatch"
      }`,
    );
  }

  // 1. Create cmux surface using the deterministic worker layout policy.
  const surface = await this.createAgentSurface(spawnParams.workspace, {
    role,
    focus: spawnParams.focus,
    parentAgent,
    repo: spawnParams.repo,
    worktree: isWorktreeLaunch(spawnParams),
    placementTimeoutMs: spawnParams.boot_prompt_timeout_ms,
  });
  try {
    this.assertSurfaceObserverEpochCurrent(
      surface.observerEpoch,
      "agent placement",
    );
  } catch (error) {
    await this.cleanupUnboundCreatedSurface(surface, "agent-placement");
    throw error;
  }
  const createdWorkspace = surface.actual_workspace ?? surface.workspace;
  let surfaceFocusError: unknown = null;
  try {
    // Metadata-capable backends initialize cold runtimes by input demand
    // below (cmux #9769). Focus here is for legacy backends or focus:true.
    if (spawnParams.focus !== false) await this.client.focusSurface(surface.surface, {
      workspace: createdWorkspace,
      beforeMutation: async () => {
        this.assertSurfaceObserverEpochCurrent(
          surface.observerEpoch,
          "agent focus",
        );
      },
    });
  } catch (error) {
    surfaceFocusError = error;
  }
  try {
    await spawnParams.on_surface_created?.({
      agent_id: agentId,
      surface: surface.surface,
      workspace: createdWorkspace,
    });
  } catch {
    // Focus observation is advisory and must never discard a created handle.
  }
  if (surfaceFocusError) {
    // Keep the unbound surface recoverable: AgentLaunchError returns its
    // identity so the caller can inspect, retry, or close the failed tab.
    const message =
      surfaceFocusError instanceof Error
        ? surfaceFocusError.message
        : String(surfaceFocusError);
    throw new AgentLaunchError(
      `Failed to focus created surface ${surface.surface}: ${message}`,
      agentId,
      surface.surface,
      createdWorkspace,
      surfaceFocusError,
      "focus",
    );
  }

  // 2. Write initial state (creating → booting)
  const now = new Date().toISOString();
  const record: AgentRecord = {
    agent_id: agentId,
    surface_id: surface.surface,
    surface_uuid: surface.surface_id ?? null,
    surface_observer_id: surface.observerId,
    surface_provenance: "cmuxlayer_spawn",
    workspace_id: surface.workspace,
    state: "booting",
    boot_instance_id: randomUUID(),
    repo: spawnParams.repo,
    model: spawnParams.model ?? modelPolicy.effective_model,
    effort: spawnParams.cli === "codex" ? (effort ?? "high") : null,
    cli: spawnParams.cli,
    cli_session_id: null,
    cli_session_path: null,
    launcher_name: preflight?.launcherName ?? null,
    tab_name: spawnParams.title?.trim() ? spawnParams.title : null,
    launch_mode: launchMode,
    model_pin: modelPin.pin,
    seat_id: seatIdentity.seat_id,
    seat_lane: seatIdentity.seat_lane,
    seat_role: seatIdentity.seat_role,
    seat_identity_status: seatIdentity.seat_identity_status,
    seat_identity_error: seatIdentity.seat_identity_error,
    task_summary: summarizeTaskSummary(
      spawnParams.prompt,
      spawnParams.boot_prompt_path,
    ),
    boot_prompt_text: spawnParams.prompt.trim() ? spawnParams.prompt : null,
    pid: null,
    version: 1,
    created_at: now,
    updated_at: now,
    error: null,
    parent_agent_id: parentAgentId,
    collab_path: collabPath,
    spawn_depth: spawnDepth,
    role,
    authority,
    function: spawnParams.function ?? "implementor",
    placement:
      spawnParams.placement ?? (role === "orchestrator" ? "left" : "right"),
    auto_archive_on_done: spawnParams.auto_archive_on_done,
    deletion_intent: false,
    quality: "unknown",
    max_cost_per_agent: spawnParams.max_cost_per_agent ?? null,
    user_killed: false,
    halt_escalation: spawnParams.halt_escalation ?? true,
    halt_episode_type: null,
    halt_episode_started_at: null,
    halt_episode_observations: 0,
    halt_notification_sent_at: null,
    halt_notified_ancestor_id: null,
    halt_last_observable_action: null,
    halt_last_active_at: null,
    halt_last_progress_at_ms: null,
    halt_last_progress_signature: null,
    boot_prompt_pending: spawnParams.boot_prompt_pending ?? false,
    submit_verified: null,
    prompt_delivered: false,
    parsed_model: null,
    model_mismatch: null,
    parsed_effort: null,
    effort_mismatch: null,
    launch_cwd: launchCwd,
    mcp_profile: spawnParams.mcp_profile_label ?? null,
    worktree_path: spawnParams.cwd ?? null,
    worktree_branch: spawnParams.worktree_branch ?? null,
  };
  try {
    this.stateMgr.writeState(record);
  } catch (error) {
    let durableRecord: AgentRecord | null = null;
    try {
      durableRecord = this.stateMgr.readState(agentId);
    } catch {
      // Without a readable exact binding, the created surface is still
      // unbound from cmuxlayer's point of view and must be cleaned safely.
    }
    if (
      durableRecord &&
      this.isExactDurableSurfaceBinding(durableRecord, record)
    ) {
      // rename(state.json.tmp, state.json) may have committed before a
      // secondary index/event append failed. No launch command has been sent,
      // so close this exact created surface and make the durable record
      // terminal rather than leaving an unlaunched booting child forever.
      await this.cleanupUnboundCreatedSurface(surface, "agent-placement");
      const persistenceMessage =
        error instanceof Error ? error.message : String(error);
      try {
        const failed = this.stateMgr.transition(agentId, "error", {
          error: `Initial agent state persistence failed: ${persistenceMessage}`,
          pid: null,
          cli_session_id: null,
        });
        this.registry.set(agentId, failed);
      } catch {
        // transition() also renames the state file before updating secondary
        // indexes. Re-read so a post-commit transition failure still
        // rehydrates the durable error record.
        let failedRecord: AgentRecord | null = null;
        try {
          failedRecord = this.stateMgr.readState(agentId);
        } catch {
          // The original persistence failure remains authoritative.
        }
        if (
          failedRecord?.state === "error" &&
          this.isExactDurableSurfaceBinding(failedRecord, record)
        ) {
          this.registry.set(agentId, failedRecord);
        } else {
          this.registry.remove(agentId);
        }
      }
    } else {
      await this.cleanupUnboundCreatedSurface(surface, "agent-placement");
    }
    throw error;
  }
  this.registry.set(agentId, record);
  await this.reconcileRolePlacements("spawn", {
    agentIds: new Set([record.agent_id]),
  });

  // 3. Send launch command
  const launchCmd = buildLaunchCommand(
    spawnParams.cli,
    spawnParams.repo,
    modelPolicy.launcher_model ?? undefined,
    preflight?.launcherName,
    {
      // Raw launches must cd themselves; the launcher path keeps its
      // existing `-w <cwd>` semantics (cwd only when explicitly requested).
      cwd: launchMode === "raw" ? (launchCwd ?? undefined) : spawnParams.cwd,
      envPrefix: spawnParams.mcp_env,
      allowModelOverride: modelPolicy.override_allowed,
      effort: effort ?? undefined,
      launchMode,
      authority,
    },
  );
  let runtimeInitialization: "unsupported" | "already_ready" | "input_demand" = "unsupported";
  try {
    if ((spawnParams.runtime_metadata_supported ?? this.client.supportsSurfaceRuntimeMetadata) === true) runtimeInitialization = await initializeNewSurfaceRuntime(
      this.client,
      surface.surface,
      createdWorkspace,
      spawnParams.boot_prompt_timeout_ms,
      async () => this.assertSurfaceObserverEpochCurrent(surface.observerEpoch, "runtime initialization"),
      surface.surface_id,
    );
    await this.client.renameTab(
      surface.surface,
      managedPaneTitle(agentId, surface.surface, spawnParams.title),
      { workspace: surface.actual_workspace ?? surface.workspace },
    );
    this.assertSurfaceObserverEpochCurrent(
      surface.observerEpoch,
      "agent launch",
    );
    const launchRoute =
      record.surface_uuid && this.registry.isObserverOwnershipEnforced()
        ? await this.resolveAgentIoRoute(agentId)
        : this.resolveAgentRoute(agentId);
    this.assertSurfaceObserverEpochCurrent(
      surface.observerEpoch,
      "agent launch",
    );
    await this.sendLaunchCommand(
      launchRoute.surface_id,
      launchRoute.workspace_id ?? undefined,
      launchCmd,
      agentId,
      surface.observerEpoch,
      spawnParams.boot_prompt_timeout_ms,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let failedAgentId = agentId;
    try {
      failedAgentId =
        (await this.captureBootSessionId(agentId))?.agent_id ?? agentId;
    } catch {
      // Preserve the original launch error for the caller.
    }
    try {
      const failed = this.stateMgr.transition(failedAgentId, "error", {
        error: `Launch failed: ${message}`,
      });
      this.registry.set(failedAgentId, failed);
    } catch {
      // Preserve the original launch error for the caller.
    }
    throw new AgentLaunchError(
      message,
      failedAgentId,
      surface.surface,
      surface.actual_workspace ?? surface.workspace,
      error,
    );
  }
  if (
    spawnParams.cli === "codex" &&
    this.selfRegistrationSessionResolver
  ) {
    try {
      await this.captureCodexSpawnSessionId(agentId);
    } catch {
      // Registration is written by the launched harness. A later sweep keeps
      // retrying if the append has not landed by the time spawn returns.
    }
  }
  this.schedulePostSpawnLivenessAssertion(agentId);
  return {
    runtime_initialization: runtimeInitialization,
    agent_id: agentId,
    parent_agent_id: parentAgentId,
    collab_path: collabPath,
    surface_id: surface.surface,
    workspace_id: surface.workspace,
    state: "booting",
    model: modelPolicy.effective_model,
    requested_model: modelPolicy.requested_model,
    warnings: [...launchWarnings],
    model_policy: modelPolicy,
    cwd: launchCwd ?? undefined,
    mcp_env: spawnParams.mcp_env,
    launch_mode: launchMode,
    model_pin: modelPin.pin,
  };
}

/**
 * Resume a captured CLI session on a fresh surface while preserving its
 * stable public agent ID. Since #492 this is the ONLY revive there is:
 * cmuxlayer never respawns a pane on its own, so a revive is always somebody
 * asking for one by agent id.
 */
export async function resumeAgent(
  this: LifecycleHost,
  agentId: string,
  opts?: { workspace?: string; force?: boolean },
): Promise<SpawnAgentResult> {
  let agent = this.resolveResumeAgent(agentId);
  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }
  if (!TERMINAL_STATES.has(agent.state)) {
    throw new Error(
      `Agent "${agent.agent_id}" is ${agent.state}; explicit resume requires a terminal agent`,
    );
  }
  const recordedProcessLiveness = agentProcessLiveness(agent);
  if (
    recordedProcessLiveness === "alive" ||
    (recordedProcessLiveness === "unknown" && !opts?.force)
  ) {
    throw new Error(
      `Agent "${agent.agent_id}" cannot resume while recorded pid ` +
        `${agent.pid} is still alive or cannot be proven gone`,
    );
  }
  if (!agent.cli_session_id) {
    throw new Error(
      `Agent "${agent.agent_id}" has no captured CLI session to resume`,
    );
  }
  // Same authority list_agents uses. Previously this passed
  // harnessCwdForAgent, whose ~/Gits guess never returns null -- so an agent
  // reported NOT resumable could still be sent `cd ~/Gits/<repo> && claude
  // --resume <id>`, silently starting a new session in a lookalike tree.
  const resumeInvocation = resumeInvocationForAgent(agent);
  if (resumeInvocation.command === null) {
    throw new Error(
      `Agent "${agent.agent_id}" has no runnable resume command: ` +
        `${resumeInvocation.reason}`,
    );
  }
  const resumeCommand = resumeInvocation.command;
  const requestedWorkspace =
    opts?.workspace ?? agent.workspace_id ?? undefined;
  this.spawnGuard.check(requestedWorkspace);
  const persistedAgent = this.stateMgr.readState(agent.agent_id);
  if (!persistedAgent) {
    throw new Error(`Agent not found: ${agent.agent_id}`);
  }
  if (!persistedAgent.cli_session_id) {
    agent = this.stateMgr.updateRecord(agent.agent_id, {
      cli_session_id: agent.cli_session_id,
      cli_session_path: agent.cli_session_path ?? null,
    });
    this.registry.set(agent.agent_id, agent);
  } else if (persistedAgent.cli_session_id !== agent.cli_session_id) {
    throw new Error(
      `Agent "${agent.agent_id}" session identity changed during resume resolution`,
    );
  }

  let surface: CreatedAgentSurface | null = null;
  let surfaceBound = false;
  let recordReopened = false;
  try {
    surface = await this.createAgentSurface(requestedWorkspace, {
      role: inferRecordRole(agent),
      parentAgent: agent.parent_agent_id
        ? this.registry.get(agent.parent_agent_id)
        : null,
      repo: agent.repo,
      worktree: Boolean(agent.worktree_path),
    });
    this.assertSurfaceObserverEpochCurrent(
      surface.observerEpoch,
      "explicit agent resume",
    );
    const workspace = surface.actual_workspace ?? surface.workspace;
    await this.client.focusSurface(surface.surface, {
      workspace,
      beforeMutation: async () => {
        this.assertSurfaceObserverEpochCurrent(
          surface!.observerEpoch,
          "explicit agent resume focus",
        );
      },
    });

    const creating = this.stateMgr.reopenForResume(agent.agent_id);
    recordReopened = true;
    this.registry.set(agent.agent_id, creating);
    const rebound = this.stateMgr.updateRecord(agent.agent_id, {
      surface_id: surface.surface,
      surface_uuid: surface.surface_id ?? null,
      surface_observer_id: surface.observerId,
      surface_provenance: "cmuxlayer_spawn",
      workspace_id: workspace,
      user_killed: false,
      deletion_intent: false,
      error: null,
      pid: null,
    });
    this.registry.set(agent.agent_id, rebound);
    surfaceBound = true;
    this.assertSurfaceObserverEpochCurrent(
      surface.observerEpoch,
      "explicit agent resume rename",
    );
    // A resumed pane is the same agent; it must say so, like the spawn path.
    await this.client.renameTab(
      surface.surface,
      managedPaneTitle(agent.agent_id, surface.surface, agent.tab_name),
      { workspace },
    );
    const booting = this.stateMgr.transition(agent.agent_id, "booting", {
      error: null,
      pid: null,
      cli_session_id: agent.cli_session_id,
    });
    this.registry.set(agent.agent_id, booting);
    await this.sendLaunchCommand(
      surface.surface,
      workspace,
      resumeCommand,
      agent.agent_id,
      surface.observerEpoch,
    );
    await this.reconcileRolePlacements("spawn", {
      agentIds: new Set([agent.agent_id]),
    });
    return {
      agent_id: agent.agent_id,
      parent_agent_id: agent.parent_agent_id,
      surface_id: surface.surface,
      workspace_id: workspace,
      state: "booting",
      model: agent.model,
      cwd: agent.launch_cwd ?? undefined,
    };
  } catch (error) {
    if (surface && !surfaceBound) {
      await this.cleanupUnboundCreatedSurface(surface, "agent-placement");
    }
    if (recordReopened) {
      try {
        const failed = this.stateMgr.transition(agent.agent_id, "error", {
          error: `Explicit resume failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        this.registry.set(agent.agent_id, failed);
      } catch {
        // Preserve the original failure.
      }
    }
    throw error;
  }
}

/** Resolve either cmuxlayer's public label or the harness's full session id. */
export function resolveResumeAgent(this: LifecycleHost, agentOrSessionId: string): AgentRecord | null {
  const direct =
    this.registry.get(agentOrSessionId) ??
    this.stateMgr.readState(agentOrSessionId);
  if (direct) return direct;
  const requestedSessionId = agentOrSessionId.trim().toLowerCase();
  const capturedMatches = this.stateMgr.listStates().filter(
    (record) =>
      record.cli_session_id?.trim().toLowerCase() === requestedSessionId,
  );
  const captured =
    capturedMatches.length === 1 ? capturedMatches[0]! : null;
  if (capturedMatches.length > 1) return null;
  if (captured) return captured;

  const registration = this.selfRegistrationSessionLookup?.(agentOrSessionId);
  if (!registration) return null;
  const surfaceUuid = registration.surface_uuid.trim().toLowerCase();
  const registrationCli = registration.cli?.trim().toLowerCase() || null;
  const records = this.stateMgr.listStates();
  const uniqueMatch = (
    predicate: (record: AgentRecord) => boolean,
  ): AgentRecord | null => {
    const matches = records.filter(predicate);
    return matches.length === 1 ? matches[0]! : null;
  };
  const surfaceMatches = records.filter(
    (record) => record.surface_uuid?.trim().toLowerCase() === surfaceUuid,
  );
  if (surfaceMatches.length > 1) return null;
  const registrationCwd = registration.cwd
    ? resolve(registration.cwd)
    : null;
  const registrationTimestamp =
    typeof registration.ts === "number" ? registration.ts : Number.NaN;
  const candidate =
    surfaceMatches[0] ??
    (registration.pid
      ? uniqueMatch((record) => {
          const recordTimestamp = Date.parse(record.created_at);
          const recordCwd = record.launch_cwd ?? record.worktree_path;
          return (
            record.pid === registration.pid &&
            Number.isFinite(registrationTimestamp) &&
            Number.isFinite(recordTimestamp) &&
            registrationTimestamp >= recordTimestamp &&
            registrationCwd !== null &&
            recordCwd !== null &&
            recordCwd !== undefined &&
            resolve(recordCwd) === registrationCwd
          );
        })
      : null);
  if (
    !candidate ||
    !TERMINAL_STATES.has(candidate.state) ||
    (registrationCli && candidate.cli !== registrationCli) ||
    (candidate.cli_session_id &&
      candidate.cli_session_id.trim().toLowerCase() !== requestedSessionId)
  ) {
    return null;
  }
  return {
    ...candidate,
    cli_session_id: registration.session_id,
    cli_session_path:
      registration.session_path ?? candidate.cli_session_path ?? null,
  };
}

/**
 * Cascade-kill all agents in the subtree rooted at rootId.
 * Uses DFS post-order (children before root). Continues on failures (best-effort).
 */
export async function cascadeKill(this: LifecycleHost, rootId: string, force?: boolean): Promise<void> {
  const subtree = this.registry.getSubtree(rootId);
  for (const agent of subtree) {
    try {
      await this.stopAgent(agent.agent_id, force);
    } catch {
      // Best-effort — continue to next agent
    }
  }
}

/**
 * Wait for an agent to reach a target state.
 * Retroactive check first, then polling sweep until match or timeout.
 */
export function geminiHasSettledReply(this: LifecycleHost, text: string): boolean {
  // Antigravity keeps past-tense `▸ Thought for` rows in its transcript and
  // draws its model footer below the composer; its live block decides.
  if (isAntigravityScreen(text)) return !antigravityScreenIsActive(text);
  const lines = text.trimEnd().split("\n").map((line) => line.trim());
  if (lines.at(-1) !== ">") return false;
  const activity = /^✦\s*(?:Thinking|Working|Running|Reading|Writing|Calling)\b/i;
  let lastActivity = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (activity.test(lines[index] ?? "")) {
      lastActivity = index;
      break;
    }
  }
  return lastActivity >= 0 && lines.slice(lastActivity + 1, -1).some(
    (line) => /^✦\s+\S/.test(line) && !activity.test(line),
  );
}

export async function interactiveMatchScreenIsActive(
  this: LifecycleHost,
  agent: AgentRecord,
  targetState: AgentState,
): Promise<boolean> {
  try {
    const screen = await this.readAgentScreen(agent, {
      lines: BOOT_SESSION_CAPTURE_LINES,
    });
    const parsed = parseScreen(screen.text);
    // Ready can mean the CLI has booted and is processing its boot prompt.
    // Only an idle match promises that active work has stopped.
    if (targetState === "ready") return false;
    // Gemini leaves a Thinking line in scrollback after a completed reply.
    // Its final input prompt remains the idle evidence used by PROBE-L.
    if (agent.cli === "gemini" && this.geminiHasSettledReply(screen.text)) {
      return false;
    }
    return parsed.status === "working" ||
      parsed.status === "thinking" ||
      parsed.status === "draft_pending" ||
      parsed.control_state === "busy";
  } catch {
    // A failed direct read has no new evidence to contradict the existing gate.
    return false;
  }
}

export async function waitFor(
  this: LifecycleHost,
  agentId: string,
  targetState: AgentState,
  timeoutMs: number,
): Promise<WaitResult> {
  const start = Date.now();

  // Check if agent exists
  const initial = this.registry.get(agentId);
  if (!initial) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  // AIDEV-NOTE (F1b, #473): a wait must never terminate on a record state the
  // screen contradicts. #408 flips live agents to `done` within minutes, and
  // these short-circuits read that record raw -- so `wait_for(target:"idle")`
  // returned `{state:"done", error:"Agent has already completed", elapsed:0}`
  // for an agent mid-`brew install`, and the lead that trusted it reported a
  // false completion. Every termination decision below reads the LIVE state
  // instead, and the top-level `state` reports the reconciled value rather
  // than the poisoned record. With no live probe wired the resolution IS the
  // record, so an unprobed engine behaves exactly as it did before.
  //
  // Round 2 (reviewer finding A): reading the live state is not enough if
  // nothing GUARANTEES there is any. `screenObservationForRecord` reads
  // `discovery.cachedScan()`, which returns null once the scan is 2000ms old
  // -- and nothing on this path refreshes it, so for a lead whose next action
  // is `wait_for` the cache is ordinarily cold and the resolution degrades to
  // the poisoned record, reproducing the original bug byte-for-byte. So the
  // wait BUYS its own evidence at entry, and again on a deliberate cadence
  // below. Cost: one screen read per agent at entry, one more per
  // WAIT_FOR_LIVE_EVIDENCE_INTERVAL_MS thereafter.
  const initialMemo = this.freshLiveStates.get(agentId);
  const initialLive = await this.refreshLiveState(initial);
  const initialProbeWasFresh = this.freshLiveStates.get(agentId) !== initialMemo;
  const initialState = this.terminationStateOf(initial, initialLive);
  // A pool seat can retain `done` throughout a newly delivered turn. A
  // single resting frame (or an unreadable pane) cannot confirm that record.
  const recordDoneNeedsConfirmation = (
    agent: AgentRecord,
    state: AgentState,
    live: LiveAgentState | null,
  ): boolean =>
    INTERACTIVE_AGENT_STATES.has(targetState) &&
    agent.state === "done" && state === "done" &&
    live?.screen_state !== "done" && live?.screen_state !== "error";

  // Retroactive check — already in target state with required evidence?
  const initialEvidence = await this.getTargetStateEvidenceSource(
    initial,
    targetState,
    initialState,
  );
  // A screen can momentarily look resting while the registry still records
  // active work. Let the poll path confirm that observation on a later tick.
  const initialRestingConflict =
    this.freshLiveStateProbe !== null &&
    INTERACTIVE_AGENT_STATES.has(targetState) &&
    (initial.state === "working" || initial.state === "booting") &&
    INTERACTIVE_AGENT_STATES.has(initialState);
  if (
    initialEvidence &&
    !initialRestingConflict &&
    !(this.freshLiveStateProbe && INTERACTIVE_AGENT_STATES.has(targetState) &&
      initialLive.source === "screen") &&
    (!INTERACTIVE_AGENT_STATES.has(targetState) ||
      !(await this.interactiveMatchScreenIsActive(initial, targetState)))
  ) {
    const stateEstablishedByScreen =
      initialLive?.source === "screen" && initialState !== initial.state;
    return {
      matched: true,
      state: initialState,
      elapsed: Date.now() - start,
      source:
        initialEvidence === "state"
          ? stateEstablishedByScreen
            ? "screen"
            : "immediate"
          : initialEvidence,
      agent: toPublicAgent({ ...initial, state: initialState }),
    };
  }

  // Already in terminal error state and target isn't error?
  if (initialState === "error" && targetState !== "error") {
    return {
      matched: false,
      state: initialState,
      elapsed: Date.now() - start,
      source: "immediate",
      agent: toPublicAgent({ ...initial, state: initialState }),
      error: initial.error ?? "Agent is in error state",
    };
  }

  // Already in terminal done state and target isn't done?
  if (initialState === "done" && targetState !== "done" &&
      !recordDoneNeedsConfirmation(initial, initialState, initialLive)) {
    return {
      matched: false,
      state: initialState,
      elapsed: Date.now() - start,
      source: "immediate",
      agent: toPublicAgent({ ...initial, state: initialState }),
      error: "Agent has already completed",
    };
  }

  const waitForReadyPatternMatches = new Map<string, number>();
  const confirmsRestingScreen = (live: LiveAgentState): boolean =>
    live.screen_state !== null &&
    INTERACTIVE_AGENT_STATES.has(live.screen_state);
  let restingObservations = confirmsRestingScreen(initialLive) ? 1 : 0;
  let needsSecondRestingRead = restingObservations === 1;
  let staleDoneRestingObservations = 0;
  let lastStaleDoneObservationAt = -1;
  let lastStaleDoneObservationConfirmed = false;
  let lastStaleDoneObservationActive = false;
  const observeStaleDoneScreen = async (
    agent: AgentRecord,
    live: LiveAgentState,
    probeWasFresh: boolean,
  ): Promise<void> => {
    if (!recordDoneNeedsConfirmation(agent, this.terminationStateOf(agent, live), live)) {
      staleDoneRestingObservations = 0;
      lastStaleDoneObservationConfirmed = false;
      lastStaleDoneObservationActive = false;
      return;
    }
    const memo = this.freshLiveStates.get(agentId);
    const freshProbe = probeWasFresh && memo?.live === live &&
      live.screen_state !== null;
    const observedAt = freshProbe ? memo.at : Date.now();
    if (observedAt <= lastStaleDoneObservationAt) return;
    lastStaleDoneObservationAt = observedAt;
    if (freshProbe) {
      lastStaleDoneObservationConfirmed = confirmsRestingScreen(live);
      lastStaleDoneObservationActive = isLiveActive(live);
    } else {
      // A null probe can mean a closed pane. Buy one direct read before
      // trusting the terminal record; a missing pane does not contradict it.
      try {
        const screen = await this.readAgentScreen(agent, {
          lines: BOOT_SESSION_CAPTURE_LINES,
        });
        const parsed = parseScreen(screen.text);
        const active = parsed.status === "working" ||
          parsed.status === "thinking" ||
          parsed.status === "draft_pending" ||
          parsed.control_state === "busy";
        const directState = resolveLiveAgentState(agent, parsed).screen_state;
        lastStaleDoneObservationActive = active;
        lastStaleDoneObservationConfirmed = !active &&
          (directState === "ready" || directState === "idle" ||
            directState === "error");
      } catch {
        lastStaleDoneObservationActive = false;
        lastStaleDoneObservationConfirmed = true;
      }
    }
    staleDoneRestingObservations = lastStaleDoneObservationConfirmed
      ? staleDoneRestingObservations + 1 : 0;
    if (staleDoneRestingObservations === 1) needsSecondRestingRead = true;
  };
  await observeStaleDoneScreen(initial, initialLive, initialProbeWasFresh);
  const confirmedStaleDone = async (
    agent: AgentRecord,
    state: AgentState,
    live: LiveAgentState | null,
  ): Promise<boolean> => {
    if (!recordDoneNeedsConfirmation(agent, state, live)) {
      return true;
    }
    if (staleDoneRestingObservations < 2 ||
        !lastStaleDoneObservationConfirmed) return false;
    // The direct veto is meaningful for idle. `ready` retains WF2's
    // established ready-target behavior.
    if (await this.interactiveMatchScreenIsActive(agent, targetState)) {
      restingObservations = 0;
      staleDoneRestingObservations = 0;
      lastStaleDoneObservationConfirmed = false;
      lastStaleDoneObservationActive = true;
      needsSecondRestingRead = false;
      return false;
    }
    return true;
  };
  if (restingObservations === 1) {
    waitForReadyPatternMatches.set(agentId, 1);
  } else if (INTERACTIVE_AGENT_STATES.has(targetState)) {
    // Count the entry screen as the first candidate. Short waits can then
    // confirm rest on the first poll tick, even without a forcing probe.
    await this.refreshTargetStateEvidence(
      initial,
      targetState,
      waitForReadyPatternMatches,
      initialState,
    );
    if (waitForReadyPatternMatches.has(agentId)) {
      restingObservations = 1;
      needsSecondRestingRead = true;
    }
  }
  // Entry already bought evidence, so the first sweep refresh is due one
  // full interval in.
  let lastForcedEvidenceElapsed = 0;

  // Polling sweep loop
  return new Promise<WaitResult>((resolve) => {
    const finish = (result: WaitResult) => {
      waitForReadyPatternMatches.clear();
      resolve(result);
    };

    const checkInterval = setInterval(async () => {
      const elapsed = Date.now() - start;
      if (elapsed >= timeoutMs) {
        clearInterval(checkInterval);
        try {
          await this.registry.reconcile({
            confirmationMs: SURFACE_EVICTION_CONFIRMATION_MS,
          });
        } catch (error) {
          const current = this.registry.get(agentId);
          const failureState = current
            ? this.terminationStateOf(current, this.liveStateOf(current))
            : "error";
          const detail =
            error instanceof Error ? error.message : String(error);
          finish({
            matched: false,
            state: failureState,
            elapsed,
            source: "timeout",
            agent: current
              ? toPublicAgent({ ...current, state: failureState })
              : null,
            error:
              `Timed out after ${timeoutMs}ms waiting for state "${targetState}"; ` +
              `final reconciliation failed: ${detail}`,
          });
          return;
        }
        let current = this.registry.get(agentId);
        // The timeout answer is the one a lead acts on, and it lands after
        // the memo from the last cadence refresh has expired -- so buy one
        // final observation rather than reporting the record by default.
        // It also leaves fresh evidence behind for whatever renders the
        // reply (P11 closure reads it in the same turn).
        const timeoutMemo = this.freshLiveStates.get(agentId);
        const timeoutLive = current
          ? await this.refreshLiveState(current)
          : null;
        if (current && timeoutLive) {
          await observeStaleDoneScreen(
            current,
            timeoutLive,
            this.freshLiveStates.get(agentId) !== timeoutMemo,
          );
        }
        if (
          current && timeoutLive && timeoutLive.screen_state !== null &&
          INTERACTIVE_AGENT_STATES.has(targetState)
        ) {
          restingObservations = confirmsRestingScreen(timeoutLive)
            ? restingObservations + 1 : 0;
          if (restingObservations === 0) {
            waitForReadyPatternMatches.delete(agentId);
          }
        }
        let timeoutState =
          current && timeoutLive
            ? this.terminationStateOf(current, timeoutLive)
            : "error";
        let refreshedSource: RefreshedTargetStateEvidenceSource | undefined;
        let refreshedActive = false;
        const finalReadyNeedsAnotherConsecutiveObservation =
          current !== null &&
          targetState === "ready" &&
          matchReadyPattern(current.cli, "").consecutive > 1;
        if (
          current &&
          INTERACTIVE_AGENT_STATES.has(targetState) &&
          !finalReadyNeedsAnotherConsecutiveObservation
        ) {
          const refreshed = await this.refreshTargetStateEvidence(
            current,
            targetState,
            waitForReadyPatternMatches,
            timeoutState,
          );
          current = refreshed.agent;
          refreshedSource = refreshed.source;
          refreshedActive = refreshed.observedActive === true;
          if (refreshed.observedActive) {
            restingObservations = 0;
            needsSecondRestingRead = false;
          }
          timeoutState =
            refreshed.observedActive || refreshed.source === "screen"
              ? current.state
              : this.terminationStateOf(current, this.liveStateOf(current));
        }
        const timeoutStateEstablishedByScreen =
          current !== null &&
          timeoutLive?.source === "screen" &&
          timeoutState !== current.state;
        const singleObservationReadyIsSafe =
          current !== null &&
          targetState === "ready" &&
          timeoutStateEstablishedByScreen &&
          matchReadyPattern(current.cli, "").consecutive === 1;
        const timeoutInteractiveEvidenceIsGated =
          targetState === "idle" ||
          refreshedSource !== undefined ||
          (current !== null && INTERACTIVE_AGENT_STATES.has(current.state)) ||
          singleObservationReadyIsSafe;
        const timeoutEvidence =
          current &&
          INTERACTIVE_AGENT_STATES.has(targetState) &&
          timeoutInteractiveEvidenceIsGated
            ? await this.getTargetStateEvidenceSource(
                current,
                targetState,
                timeoutState,
              )
            : null;
        if (
          current &&
          timeoutEvidence &&
          !refreshedActive &&
          (!INTERACTIVE_AGENT_STATES.has(targetState) ||
            (restingObservations >= 2 &&
              timeoutLive?.source === "screen" &&
              !isLiveActive(timeoutLive) &&
              current.state !== "working") ||
            (refreshedSource === "screen" &&
              INTERACTIVE_AGENT_STATES.has(current.state))) &&
          (!INTERACTIVE_AGENT_STATES.has(targetState) ||
            !(await this.interactiveMatchScreenIsActive(current, targetState)))
        ) {
          finish({
            matched: true,
            state: timeoutState,
            elapsed,
            source:
              refreshedSource ??
              (timeoutEvidence === "state"
                ? timeoutStateEstablishedByScreen
                  ? "screen"
                  : "sweep"
                : timeoutEvidence),
            agent: toPublicAgent({ ...current, state: timeoutState }),
          });
          return;
        }
        let unconfirmedDone = false;
        if (current && timeoutState === "done" &&
            INTERACTIVE_AGENT_STATES.has(targetState)) {
          if (await confirmedStaleDone(current, timeoutState, timeoutLive)) {
            finish({
              matched: false,
              state: "done",
              elapsed,
              source: "sweep",
              agent: toPublicAgent({ ...current, state: "done" }),
              error: current.error ?? "Agent entered terminal state: done",
            });
            return;
          }
          timeoutState = lastStaleDoneObservationActive
            ? "working" : timeoutLive?.screen_state ?? current.state;
          unconfirmedDone = true;
        }
        finish({
          matched: false,
          state: timeoutState,
          elapsed,
          source: "timeout",
          agent: current
            ? toPublicAgent({ ...current, state: timeoutState })
            : null,
          error: `Timed out after ${timeoutMs}ms waiting for state "${targetState}"` +
            (unconfirmedDone ? "; done record unconfirmed" : ""),
        });
        return;
      }

      // Re-read from disk (another process may have updated)
      await this.registry.reconcile({
        confirmationMs: SURFACE_EVICTION_CONFIRMATION_MS,
      });
      let current = this.registry.get(agentId);
      if (!current) {
        clearInterval(checkInterval);
        finish({
          matched: false,
          state: "error",
          elapsed,
          source: "sweep",
          agent: null,
          error: "Agent disappeared during wait",
        });
        return;
      }

      // Re-force evidence on a deliberate cadence. Between refreshes the
      // memo from the last one answers, and it expires exactly when the next
      // is due, so no tick ever decides on evidence older than the TTL.
      let forcedLive: LiveAgentState | null = null;
      if (
        (needsSecondRestingRead && INTERACTIVE_AGENT_STATES.has(targetState)) ||
        elapsed - lastForcedEvidenceElapsed >=
          WAIT_FOR_LIVE_EVIDENCE_INTERVAL_MS
      ) {
        lastForcedEvidenceElapsed = elapsed;
        needsSecondRestingRead = false;
        const forcedMemo = this.freshLiveStates.get(agentId);
        forcedLive = await this.refreshLiveState(current);
        await observeStaleDoneScreen(
          current,
          forcedLive,
          this.freshLiveStates.get(agentId) !== forcedMemo,
        );
        if (INTERACTIVE_AGENT_STATES.has(targetState) && forcedLive.screen_state !== null) {
          restingObservations = confirmsRestingScreen(forcedLive)
            ? restingObservations + 1 : 0;
          if (restingObservations === 1) needsSecondRestingRead = true;
        }
      }

      const activeScreen = forcedLive?.source === "screen" && isLiveActive(forcedLive);
      if (activeScreen && targetState === "idle") {
        waitForReadyPatternMatches.delete(agentId);
      }
      const refreshed = activeScreen && targetState === "idle"
        ? { agent: current }
        : await this.refreshTargetStateEvidence(
            current,
            targetState,
            waitForReadyPatternMatches,
            this.terminationStateOf(current, this.liveStateOf(current)),
          );
      current = refreshed.agent;
      if (refreshed.observedActive) {
        restingObservations = 0;
        needsSecondRestingRead = false;
      }
      if (waitForReadyPatternMatches.has(agentId)) {
        restingObservations = Math.max(restingObservations, 1);
        needsSecondRestingRead = true;
      }

      // The sweep runs the same live gate as the retroactive check: gating
      // only the entry short-circuit would just move the false completion
      // one poll interval later. Resolved AFTER the refresh, because a
      // refresh that transitions the record is itself fresh screen evidence
      // -- and `liveStateOf` drops a memo whose record has moved.
      const live = this.liveStateOf(current);
      const liveState = this.terminationStateOf(current, live);

      const evidenceSource = await this.getTargetStateEvidenceSource(
        current,
        targetState,
        liveState,
      );
      if (
        evidenceSource &&
        !refreshed.observedActive &&
        (!INTERACTIVE_AGENT_STATES.has(targetState) ||
          forcedLive?.source !== "screen" ||
          (restingObservations >= 2 && !isLiveActive(forcedLive))) &&
        (!INTERACTIVE_AGENT_STATES.has(targetState) ||
          !(await this.interactiveMatchScreenIsActive(current, targetState)))
      ) {
        const stateEstablishedByScreen =
          live?.source === "screen" && liveState !== current.state;
        clearInterval(checkInterval);
        finish({
          matched: true,
          state: liveState,
          elapsed,
          source:
            refreshed.source ??
            (evidenceSource === "state"
              ? stateEstablishedByScreen
                ? "screen"
                : "sweep"
              : evidenceSource),
          agent: toPublicAgent({ ...current, state: liveState }),
        });
        return;
      }

      // Fail-fast on terminal error
      if (
        TERMINAL_STATES.has(liveState) && liveState !== targetState &&
        await confirmedStaleDone(current, liveState, forcedLive)
      ) {
        clearInterval(checkInterval);
        finish({
          matched: false,
          state: liveState,
          elapsed,
          source: "sweep",
          agent: toPublicAgent({ ...current, state: liveState }),
          error:
            current.error ?? `Agent entered terminal state: ${liveState}`,
        });
      }
    }, WAIT_FOR_SWEEP_INTERVAL_MS);
  });
}
export async function readStopPostCondition(
  this: LifecycleHost,
  agent: AgentRecord,
  paneRef: string | null,
  treatUnknownProcessAsGone: boolean,
): Promise<StopPostConditionResult> {
  const processGone = treatUnknownProcessAsGone
    ? this.isProcessGone(agent)
    : this.isProcessConfirmedGone(agent);
  const [surfaceGone, paneGone] = await Promise.all([
    this.isAgentSurfaceGone(agent),
    this.isPaneGone(paneRef, agent.workspace_id),
  ]);
  return { processGone, surfaceGone, paneGone, paneRef };
}

export async function waitForStopPostCondition(
  this: LifecycleHost,
  agent: AgentRecord,
  paneRef: string | null,
  expectPaneGone: boolean,
  treatUnknownProcessAsGone: boolean,
): Promise<StopPostConditionResult> {
  const deadline = Date.now() + this.stopPostConditionTimeoutMs;
  let result = await this.readStopPostCondition(
    agent,
    paneRef,
    treatUnknownProcessAsGone,
  );
  while (
    !(
      result.processGone &&
      result.surfaceGone &&
      (!expectPaneGone || result.paneGone)
    ) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) =>
      setTimeout(resolve, STOP_POST_CONDITION_POLL_MS),
    );
    result = await this.readStopPostCondition(
      agent,
      paneRef,
      treatUnknownProcessAsGone,
    );
  }
  return result;
}

export function formatStopPostConditionError(
  this: LifecycleHost,
  agent: AgentRecord,
  result: StopPostConditionResult,
  expectPaneGone: boolean,
  closeError: string | null,
): string {
  const failed = [
    result.processGone ? null : "process still alive",
    result.surfaceGone ? null : "surface still live",
    expectPaneGone && !result.paneGone ? "pane still open" : null,
    closeError ? `close failed: ${closeError}` : null,
  ].filter((part): part is string => part !== null);
  return [
    `Stop post-condition failed for ${agent.agent_id}: ${failed.join(", ")}`,
    `(pid=${agent.pid ?? "unknown"} surface=${agent.surface_id}`,
    `pane=${result.paneRef ?? "unknown"})`,
  ].join(" ");
}

/**
 * Stop an agent gracefully (Ctrl+C) or forcefully (kill PID).
 */
export async function stopAgent(
  this: LifecycleHost,
  agentId: string,
  force?: boolean,
  opts?: {
    userInitiated?: boolean;
    beforeSurfaceMutation?: (route: AgentRoute) => Promise<void>;
    allowUnknownPidOwnedSurfaceClose?: boolean;
  },
): Promise<void> {
  let agent = this.registry.get(agentId);
  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }
  const canonicalAgentId = agent.agent_id;
  const ownedBeforeRouteResolution =
    this.registry.isObserverOwnershipEnforced() &&
    this.registry.canControlSurface(agent);

  const userInitiated = opts?.userInitiated ?? true;

  if (TERMINAL_STATES.has(agent.state)) {
    if (force) {
      if (!agent.cli_session_id) {
        this.registry.evictExplicit(canonicalAgentId);
        return;
      }
      const surfaceGone = await this.isAgentSurfaceGone(agent);
      if (
        surfaceGone &&
        (this.isProcessConfirmedGone(agent) || agent.pid == null)
      ) {
        const tombstone = this.stateMgr.updateRecord(canonicalAgentId, {
          user_killed: true,
          pid: null,
        });
        this.registry.set(canonicalAgentId, tombstone);
        return;
      }
    } else {
      if (
        agent.state === "error" &&
        userInitiated &&
        agent.user_killed !== true
      ) {
        const marked = this.stateMgr.updateRecord(canonicalAgentId, {
          user_killed: true,
        });
        this.registry.set(canonicalAgentId, marked);
      }
      return; // Already stopped
    }
  }

  let route = await this.resolveAgentStopIoRoute(canonicalAgentId);
  agent = this.registry.get(canonicalAgentId);
  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  let stopClosePolicy = await this.resolveStopSurfaceClosePolicy(
    route.surface_id,
    route.workspace_id,
  );
  let finalRoute = await this.resolveAgentStopIoRoute(canonicalAgentId);
  if (!this.sameSurfaceRoute(route, finalRoute)) {
    stopClosePolicy = await this.resolveStopSurfaceClosePolicy(
      finalRoute.surface_id,
      finalRoute.workspace_id,
    );
    const confirmedRoute =
      await this.resolveAgentStopIoRoute(canonicalAgentId);
    if (!this.sameSurfaceRoute(finalRoute, confirmedRoute)) {
      throw new Error(
        `Agent "${canonicalAgentId}" surface route changed repeatedly while ` +
          `preparing stop; refusing terminal mutation.`,
      );
    }
    finalRoute = confirmedRoute;
  }
  route = finalRoute;
  agent = this.registry.get(canonicalAgentId);
  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }
  await opts?.beforeSurfaceMutation?.(route);
  const mutationRoute = await this.resolveAgentStopIoRoute(canonicalAgentId);
  if (!this.sameSurfaceRoute(route, mutationRoute)) {
    throw new Error(
      `Agent "${canonicalAgentId}" surface route changed during the ` +
        `mutation gate; refusing terminal mutation.`,
    );
  }
  route = mutationRoute;
  if (opts?.beforeSurfaceMutation) {
    stopClosePolicy = await this.resolveStopSurfaceClosePolicy(
      route.surface_id,
      route.workspace_id,
    );
    const closeRoute = await this.resolveAgentStopIoRoute(canonicalAgentId);
    if (!this.sameSurfaceRoute(route, closeRoute)) {
      throw new Error(
        `Agent "${canonicalAgentId}" surface route changed while refreshing ` +
          `close policy after the mutation gate; refusing terminal mutation.`,
      );
    }
    route = closeRoute;
  }
  agent = this.registry.get(canonicalAgentId);
  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  const previousUserKilled = agent.user_killed ?? false;
  let stopIntentMarked = false;
  if (userInitiated && !previousUserKilled) {
    agent = this.stateMgr.updateRecord(canonicalAgentId, {
      user_killed: true,
    });
    this.registry.set(canonicalAgentId, agent);
    stopIntentMarked = true;
  }
  const rollbackUnacceptedStopIntent = (): void => {
    if (!stopIntentMarked) return;
    const current = this.registry.get(canonicalAgentId);
    if (!current) return;
    const restored = this.stateMgr.updateRecord(canonicalAgentId, {
      user_killed: previousUserKilled,
    });
    this.registry.set(canonicalAgentId, restored);
    stopIntentMarked = false;
  };

  let forceSignalAccepted = force === true && !agent.pid;
  let unknownPidOwnedClose = false;
  if (force && agent.pid) {
    const processIdentity = agentProcessLiveness(agent);
    if (processIdentity === "gone") {
      forceSignalAccepted = true;
    } else if (processIdentity === "unknown") {
      unknownPidOwnedClose =
        opts?.allowUnknownPidOwnedSurfaceClose === true &&
        ownedBeforeRouteResolution &&
        this.registry.canControlSurface(agent) &&
        Boolean(route.surface_uuid) &&
        route.surface_uuid?.trim().toLowerCase() ===
          agent.surface_uuid?.trim().toLowerCase();
      if (!unknownPidOwnedClose) {
        rollbackUnacceptedStopIntent();
        throw new Error(
          `Force stop refused for ${agent.agent_id}: recorded pid ${agent.pid} ` +
            `identity is unknown; refusing SIGKILL.`,
        );
      }
      // The owned UUID route may be closed without signalling an unproven
      // PID. Require both its disappearance and confirmed process absence
      // before reporting the agent stopped.
    } else {
      try {
        process.kill(agent.pid, "SIGKILL");
        forceSignalAccepted = true;
      } catch (error) {
        forceSignalAccepted = this.isProcessMissingError(error);
        if (!forceSignalAccepted) rollbackUnacceptedStopIntent();
        // Process may already be dead; other failures must preserve tracking.
      }
    }
  } else {
    // Graceful: send Ctrl+C
    const assertSignalRouteCurrent = async (): Promise<void> => {
      await this.resolveUnchangedAgentStopIoRoute(
        canonicalAgentId,
        route,
        "Ctrl+C",
      );
    };
    try {
      await this.client.sendKey(route.surface_id, "c-c", {
        workspace: route.workspace_id ?? undefined,
        ...this.stableSurfaceWriteOptions(route.surface_uuid),
        beforeMutation: assertSignalRouteCurrent,
      });
    } catch (error) {
      rollbackUnacceptedStopIntent();
      throw error;
    }
  }

  // Ctrl+C and process teardown can move the stable UUID to a replacement
  // ref before close runs. Re-resolve both the route and pane-collapse policy
  // after the signal so a recycled ref is never closed by mistake.
  let closeRoute: AgentRoute | null = null;
  try {
    closeRoute = await this.resolveAgentStopIoRoute(canonicalAgentId);
  } catch (error) {
    if (!(await this.isAgentSurfaceGone(agent))) {
      throw error;
    }
  }

  let closeError: string | null = null;
  if (closeRoute) {
    stopClosePolicy = await this.resolveStopSurfaceClosePolicy(
      closeRoute.surface_id,
      closeRoute.workspace_id,
    );
    let confirmedCloseRoute =
      await this.resolveAgentStopIoRoute(canonicalAgentId);
    if (!this.sameSurfaceRoute(closeRoute, confirmedCloseRoute)) {
      closeRoute = confirmedCloseRoute;
      stopClosePolicy = await this.resolveStopSurfaceClosePolicy(
        closeRoute.surface_id,
        closeRoute.workspace_id,
      );
      confirmedCloseRoute =
        await this.resolveAgentStopIoRoute(canonicalAgentId);
      if (!this.sameSurfaceRoute(closeRoute, confirmedCloseRoute)) {
        throw new Error(
          `Agent "${canonicalAgentId}" surface route changed repeatedly while ` +
            `preparing close; refusing terminal mutation.`,
        );
      }
    }
    route = confirmedCloseRoute;
    agent = this.registry.get(canonicalAgentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const assertCloseRouteCurrent = async (): Promise<void> => {
      await this.resolveUnchangedAgentStopIoRoute(
        canonicalAgentId,
        route,
        "surface close",
      );
    };

    try {
      await this.client.closeSurface(route.surface_id, {
        workspace: route.workspace_id ?? undefined,
        ...this.stableSurfaceWriteOptions(route.surface_uuid),
        collapsePane: stopClosePolicy.collapsePane,
        beforeMutation: assertCloseRouteCurrent,
      });
    } catch (error) {
      closeError = error instanceof Error ? error.message : String(error);
    }
  }

  const stopResult = await this.waitForStopPostCondition(
    agent,
    stopClosePolicy.paneRef,
    stopClosePolicy.collapsePane,
    force === true && forceSignalAccepted,
  );
  if (
    !stopResult.processGone ||
    !stopResult.surfaceGone ||
    (stopClosePolicy.collapsePane && !stopResult.paneGone)
  ) {
    const error = this.formatStopPostConditionError(
      agent,
      stopResult,
      stopClosePolicy.collapsePane,
      closeError,
    );
    try {
      const updated = this.stateMgr.updateRecord(canonicalAgentId, {
        error,
        quality: "degraded",
      });
      this.registry.set(canonicalAgentId, updated);
    } catch {
      // Preserve the post-condition error for the caller.
    }
    throw new Error(error);
  }

  if (unknownPidOwnedClose) {
    forceSignalAccepted = true;
  }

  if (force && !forceSignalAccepted) {
    const error =
      `Stop post-condition failed for ${agent.agent_id}: process still alive ` +
      `(pid=${agent.pid ?? "unknown"} surface=${agent.surface_id} pane=${stopResult.paneRef ?? "unknown"})`;
    try {
      const updated = this.stateMgr.updateRecord(canonicalAgentId, {
        error,
        quality: "degraded",
      });
      this.registry.set(canonicalAgentId, updated);
    } catch {
      // Preserve explicit force-stop failure for the caller.
    }
    throw new Error(error);
  }

  if (force) {
    const current = this.registry.get(canonicalAgentId) ?? agent;
    if (!current.cli_session_id) {
      this.registry.evictExplicit(canonicalAgentId);
      return;
    }
    const tombstone = this.stateMgr.updateRecord(canonicalAgentId, {
      user_killed: true,
      pid: null,
    });
    this.registry.set(canonicalAgentId, tombstone);
    if (!TERMINAL_STATES.has(current.state)) {
      try {
        const done = this.stateMgr.transition(canonicalAgentId, "done");
        this.registry.set(canonicalAgentId, done);
      } catch {
        try {
          const failed = this.stateMgr.transition(canonicalAgentId, "error", {
            error: "Force stopped",
          });
          this.registry.set(canonicalAgentId, failed);
        } catch {
          const committed = this.stateMgr.readState(canonicalAgentId);
          if (committed) this.registry.set(canonicalAgentId, committed);
        }
      }
    }
    return;
  }

  const current = this.registry.get(canonicalAgentId) ?? agent;
  let marked = current;
  if ((current.user_killed ?? false) !== userInitiated) {
    marked = this.stateMgr.updateRecord(canonicalAgentId, {
      user_killed: userInitiated,
    });
    this.registry.set(canonicalAgentId, marked);
  }

  // Transition to done
  try {
    const updated = this.stateMgr.transition(canonicalAgentId, "done");
    this.registry.set(canonicalAgentId, updated);
  } catch {
    // If transition to done fails (e.g. from error state), try error
    try {
      const updated = this.stateMgr.transition(canonicalAgentId, "error", {
        error: "Force stopped",
      });
      this.registry.set(canonicalAgentId, updated);
    } catch {
      // State is already terminal — that's fine
    }
  }
}
