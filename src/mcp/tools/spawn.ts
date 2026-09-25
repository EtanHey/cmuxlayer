// spawn_agent moved verbatim out of createServer's closure (CX-3b S10b);
// captured closure state arrives as SpawnAgentToolDeps.

import { z } from "zod";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  initializeNewSurfaceRuntime,
  readRuntimeMetadata,
  SurfaceRuntimeNotStartedError,
} from "../../surface-runtime.js";
import { buildSpawnToolReturn } from "../../spawn-response.js";
import {
  CODEX_EFFORT_VALUES,
  resolveSpawnEffort,
  resolveSpawnModelPolicy,
} from "../../model-policy.js";
import { shellQuote } from "../../agent-command.js";
import { currentTransportRetryCount } from "../../transport-retry-context.js";
import { AgentLaunchError } from "../../agent-engine.js";
import {
  COORDINATION_CONTRACT_DELIVERED_NOTE,
  COORDINATION_CONTRACT_POINTER_NOT_VERIFIED,
  COORDINATION_CONTRACT_POINTER_SKIPPED_STERILE,
  COORDINATION_CONTRACT_SKIPPED_STERILE_NO_FILE,
  COORDINATION_CONTRACT_REFRESHED_NOT_REDELIVERED,
  COORDINATION_FOOTER_NOT_DELIVERED,
  coordinationFooterBytes,
} from "../../coordination-paths.js";
import { releaseWatchReportPathReservation } from "../../watch-spec.js";
import { TERMINAL_AGENT_STATES } from "../../live-agent-state.js";
import { bootPromptRegistryFields, summarizeTaskSummary } from "../../agent-types.js";
import { formatOk } from "../../format.js";
import { CreatedIdentityScope } from "../../created-identity.js";
import {
  chooseAgentSpawnPlacement,
  inferAgentRole,
  inferRecordRoleOrNull,
  launcherNameForCli,
} from "../../layout-policy.js";
import { reposEquivalent } from "../../repo-workspace.js";
import { healthTopologyOverrides } from "../../surface-topology.js";
import { rollbackPreparedWorktree, type McpProfile } from "../../worktree.js";
import { hasInlinePrompt } from "../../delivery/composer-screen.js";
import {
  ANNOTATIONS,
  spawnFunctionSchema,
  spawnPlacementSchema,
  normalizeSpawnAxes,
} from "../schemas.js";
import {
  bootPromptFailureMutationEvidence,
  buildPublicDeliveryReceipt,
  submitVerificationFailurePayload,
  DeliverySafetyGateError,
  ManualModeMutationError,
  BootPromptTimeoutError,
  LauncherReadinessError,
  BootPromptDeliveryError,
  BootComposerResidueError,
  BootPromptUpdateMenuBlockedError,
  SurfaceGoneError,
} from "../../delivery/receipts.js";
import {
  surfaceGonePayload,
  ok,
  err,
  findErrorInChain,
  requireValue,
} from "../tool-result.js";
import {
  SEND_INPUT_CHUNK_THRESHOLD,
  PANE_INPUT_BREAKAGE_GUIDANCE,
  SEND_INPUT_CHUNK_DELAY_MS,
  SEND_INPUT_MAX_INLINE_CHARS,
  getBootPromptPath,
  assertSpawnPromptInputAllowed,
  assertBootPromptMode,
} from "../../delivery/input-policy.js";
import { preflightBootPromptFile } from "../tool-input.js";
import { mcpProfileSchema, worktreeArgSchema } from "../schemas.js";
import type { AgentEngine } from "../../agent-engine.js";
import type { AgentRecord } from "../../agent-types.js";
import type { AgentRegistry } from "../../agent-registry.js";
import type { CmuxServerContext, CreateServerOptions } from "../context.js";
import type { CoordinationContract } from "../../coordination-paths.js";
import type { DeliveryEngine } from "../../delivery/engine.js";
import type { PreparedWorktree } from "../../worktree.js";
import type { ServerAgentHealthEvaluator } from "./agent.js";
import type { StateManager } from "../../state-manager.js";
import type { SurfaceTopologySnapshot } from "../../surface-topology.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  FocusRestoreLease,
  FocusTarget,
  MonitorBootResult,
} from "../shared-types.js";

export interface SpawnAgentToolDeps {
  appendStaleBuildWarning: (result: { warnings?: string[]; }) => void;
  armParentReportWatch: (parentAgentId: string, childAgentId: string, coordination: { report_path: string; done_marker: string; }) => Promise<string | null>;
  assertWorkspaceMutationAllowed: (toolName: string, workspace?: string) => Promise<void>;
  awaitLifecycleStart: () => Promise<void>;
  buildBootContractInjection: (agentId: string, monitorBoot: MonitorBootResult, coordination: CoordinationContract | null) => { text: string; contract_path: string | null; };
  callerOwnsTypedDraft: DeliveryEngine["callerOwnsTypedDraft"];
  canonicalWorkspaceRef: (candidate?: string) => Promise<string | undefined>;
  capturePostCreationFocus: (lease: FocusRestoreLease | null, created?: { surface: string; workspace?: string; }) => Promise<FocusRestoreLease | null>;
  captureSpawnSessionBestEffort: <T extends { agent_id: string; surface_id: string; }>(result: T) => Promise<AgentRecord | null>;
  client: CmuxServerContext["client"];
  collectSurfaceTopology: (workspace?: string) => Promise<SurfaceTopologySnapshot | null>;
  currentSafetyCallerWorkspace: () => Promise<string | undefined>;
  deliverBootPrompt: DeliveryEngine["deliverBootPrompt"];
  engine: AgentEngine;
  ensureMonitorBoot: (agentId: string) => MonitorBootResult;
  evaluateServerAgentHealth: ServerAgentHealthEvaluator;
  executeDeliveryEngine: DeliveryEngine["executeDeliveryEngine"];
  focusTargetBeforeSplit: (targetWorkspace: string | undefined, restore?: boolean, capturedPrior?: FocusTarget | null) => Promise<FocusRestoreLease | null>;
  isBootPromptDelivered: DeliveryEngine["isBootPromptDelivered"];
  issueSpawnCoordination: (agentId: string, reportPathOverride?: string | null) => CoordinationContract;
  launchShellRecoveryBySurface: Map<string, { recovered: true; cleared: string[]; }>;
  lifecycleSeatManifestPublisher: (input: { agentId?: string; surfaceId?: string; surfaceUuid?: string; tabName?: string; model?: string; }) => Promise<void>;
  opts: CreateServerOptions | undefined;
  originalLaunchCommandsBySurface: Map<string, string>;
  parentReportPathReservations: Set<string>;
  prepareSpawnWorktree: (repo: string, worktree: boolean | string | object | undefined, mcpProfile: McpProfile | undefined) => Promise<{ prepared: undefined; mcpProfileLabel: undefined; mcpEnv: undefined; repoRoot?: undefined; } | { prepared: PreparedWorktree; repoRoot: string; mcpProfileLabel: string; mcpEnv: string; }>;
  refreshManagedMetadataBestEffort: (agentId?: string) => Promise<void>;
  registry: AgentRegistry;
  relaunchSpawnAgentAfterUpdate: (opts: { agentId: string; surface: string; workspace?: string; model?: string | null; mcpEnv?: string; originalCommand?: string; timeout_ms?: number; }) => Promise<void>;
  reserveParentReportPath: (parentAgentId: string, reportPath: string, childAgentId?: string) => Promise<{ ok: true; key: string; reservation_id: string; } | { ok: false; message: string; }>;
  resolveCurrentCallerAgent: () => AgentRecord | null;
  resolveManagedDeliveryRoute: (agentId: string) => Promise<{ surface: string; workspace?: string; }>;
  resolvePlacementWorkspace: (opts: { explicitWorkspace?: string; callerWorkspace?: string; repo?: string | null; }) => Promise<{ workspace?: string; warnings: string[]; }>;
  resolveSpawnRecord: (agentId: string, surfaceId: string) => AgentRecord | null;
  restoreFocusAfterRender: (lease: FocusRestoreLease | null, surface: string | undefined, workspace: string | undefined, opts?: { waitForReady?: boolean; }) => Promise<string | null>;
  spawnDeliveryWorkspace: (result: { workspace_id?: string; }, fallback?: string) => string | undefined;
  stateMgr: StateManager;
  watchRegistryPath: string;
  withSurfaceWrite: DeliveryEngine["withSurfaceWrite"];
}

export function registerSpawnAgentTool(
  server: McpServer,
  deps: SpawnAgentToolDeps,
): void {
  const {
    appendStaleBuildWarning,
    armParentReportWatch,
    assertWorkspaceMutationAllowed,
    awaitLifecycleStart,
    buildBootContractInjection,
    callerOwnsTypedDraft,
    canonicalWorkspaceRef,
    capturePostCreationFocus,
    captureSpawnSessionBestEffort,
    client,
    collectSurfaceTopology,
    currentSafetyCallerWorkspace,
    deliverBootPrompt,
    engine,
    ensureMonitorBoot,
    evaluateServerAgentHealth,
    executeDeliveryEngine,
    focusTargetBeforeSplit,
    isBootPromptDelivered,
    issueSpawnCoordination,
    launchShellRecoveryBySurface,
    lifecycleSeatManifestPublisher,
    opts,
    originalLaunchCommandsBySurface,
    parentReportPathReservations,
    prepareSpawnWorktree,
    refreshManagedMetadataBestEffort,
    registry,
    relaunchSpawnAgentAfterUpdate,
    reserveParentReportPath,
    resolveCurrentCallerAgent,
    resolveManagedDeliveryRoute,
    resolvePlacementWorkspace,
    resolveSpawnRecord,
    restoreFocusAfterRender,
    spawnDeliveryWorkspace,
    stateMgr,
    watchRegistryPath,
    withSurfaceWrite,
  } = deps;
  // 11. spawn_agent
  server.tool(
    "spawn_agent",
    "Spawn a managed agent or terminal, or resume a captured agent on a fresh surface while preserving its ID. Placement is deterministic; boot_prompt_timeout_ms also bounds pane placement. Boot prompts return evidence-backed receipts. Successful receipts are lean by default; verbose=true restores full transport and diagnostic detail. Failures always keep full detail.",
    {
      version: z
        .literal(1)
        .optional()
        .default(1)
        .describe("SpawnSpec schema version"),
      type: z
        .enum(["agent", "terminal"])
        .optional()
        .default("agent")
        .describe("Spawn an AI agent or a plain terminal"),
      resume_agent_id: z
        .string()
        .optional()
        .describe(
          "THE way to revive an agent: resume this captured session on a fresh surface, keeping its public agent ID and re-issuing its coordination contract. cmuxlayer never revives a pane by itself (#492) -- a pane you close stays closed -- so a lead that wants an agent back asks here, by id. Refused with a reason when the session transcript is not on disk, rather than opening an empty pane. Mutually exclusive with new-spawn fields.",
        ),
      force: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "With resume_agent_id only: override inconclusive recorded-process liveness after the caller deliberately verifies the old agent is gone. Does not bypass session or terminal-state requirements.",
        ),
      repo: z
        .string()
        .optional()
        .describe("Repository name (e.g. 'brainlayer', 'golems')"),
      model: z
        .string()
        .optional()
        .describe(
          "OPTIONAL — leave UNSET so the launcher pins the top-tier model. For cli:'codex', an explicit model is checked against Codex's runtime model list before any worktree or surface is created, then passed through to the launcher. Never pass 'opus' for claude — the top Claude model is already the default.",
        ),
      effort: z
        .enum(CODEX_EFFORT_VALUES)
        .optional()
        .describe(
          "Codex reasoning effort, passed to the repoGolem launcher. CHOOSE THIS DELIBERATELY PER MISSION — it is a cost decision, not a default to inherit. The installed launcher currently accepts: low, medium, high, xhigh, max, ultra. spawn_agent rejects other values before creating a worktree or surface. The live launcher defaults to HIGH when omitted (~/.config/ralphtools/golem-dispatch.zsh). Per /agent-routing, MEDIUM is the settled floor for well-specified implementation lanes — use it unless the task genuinely needs more; xhigh and above burn budget fast and are rarely warranted for a lane with a clear brief.",
        ),
      cli: z
        .enum(["claude", "codex", "gemini", "kiro", "cursor"])
        .optional()
        .describe("CLI tool to launch"),
      cwd: z
        .string()
        .optional()
        .describe("Initial working directory for type=terminal"),
      title: z
        .string()
        .optional()
        .describe(
          "The caller-supplied agent pane title is applied verbatim (for example `cmuxlayer-WORKER · run1 name-the-tabs`); when omitted or blank, the existing agent-id/surface fallback is retained. Managed identity comes from the agent registry, not this display title (#479/#492).",
        ),
      prompt: z
        .string()
        .optional()
        .describe(
          `${PANE_INPUT_BREAKAGE_GUIDANCE} Inline task prompt to send after the agent is ready. Capped at ${SEND_INPUT_MAX_INLINE_CHARS} inline UTF-8 bytes by default; use boot_prompt_path for larger prompts. Mutually exclusive with boot_prompt_path.`,
        ),
      boot_prompt_path: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Optional readable prompt-file path. Checked before spawning; multiline or over-cap files are submitted as one `Read and follow <path>` pointer and one final return after readiness. Mutually exclusive with prompt.",
        ),
      boot_prompt_timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Optional timeout override in milliseconds for pane placement, initial shell readiness, agent launch readiness, and the boot prompt. When omitted, each phase keeps its established default (45s placement, 10s shell, 15s launch, 60s boot prompt).",
        ),
      workspace: z
        .string()
        .optional()
        .describe(
          "Target workspace ref. Omit to use the caller/current workspace; pass only when intentionally spawning in a different workspace.",
        ),
      worktree: worktreeArgSchema
        .optional()
        .describe(
          'When set, create or reuse a git worktree before launch. Pass a string such as "tool-usage" as the worktree name, true for a generated name, or an object with name, path, branch, base, create, and reuse. When repoGolem registers the repo with an absolute path, that path is the repo root; otherwise the root is resolved from CMUXLAYER_REPO_HOME, the running checkout, or ~/Gits. true uses <registered-root>/.worktrees/<generated-name> (legacy ~/Gits/<repo>.wt read-fallback until ~2026-09). If a later spawn step fails before a recoverable surface exists, a newly created worktree and branch are rolled back.',
        ),
      mcp_profile: mcpProfileSchema
        .optional()
        .describe(
          "MCP profile hint for worktree launches. Defaults to inherit. Use sterile/skill_eval or include/exclude lists for narrower evals.",
        ),
      collab_path: z
        .string()
        .trim()
        .min(1)
        .refine(isAbsolute, "collab_path must be absolute")
        .optional()
        .describe("Lead coordination file; workers inherit their parent lead collab_path unless explicitly supplied."),
      parent_agent_id: z
        .string()
        .optional()
        .describe(
          "ID of the parent agent for hierarchical spawning. Normally inferred from the managed caller surface; pass explicitly only when no managed caller supplies the hierarchy. Parent must exist.",
        ),
      role: spawnFunctionSchema()
        .optional()
        .describe(
          "Agent job function: implementor, reviewer, or gatherer. Legacy orchestrator/worker aliases remain accepted for compatibility. Claude requires this field explicitly.",
        ),
      placement: spawnPlacementSchema()
        .optional()
        .describe(
          "Physical placement axis: left or right. It must agree with authority (lead=left, worker=right). Legacy orchestrator/worker aliases remain accepted.",
        ),
      authority: z
        .enum(["lead", "worker"])
        .optional()
        .describe(
          "Authority axis, independent from job function and placement",
        ),
      auto_archive_on_done: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Deprecated compatibility flag. TASK_DONE updates agent state only; cmuxlayer does not auto-close panes.",
        ),
      max_cost_per_agent: z
        .number()
        .optional()
        .describe("Maximum cost cap in USD for this agent"),
      halt_escalation: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Notify the nearest live ancestor when this agent remains awaiting input, idle without done evidence, or wedged past its dwell threshold. Set false for deliberate debugging lanes.",
        ),
      report_path: z
        .string()
        .refine((value) => isAbsolute(value.trim()), {
          message:
            "report_path must be absolute so the producer and consumer resolve the same file",
        })
        .optional()
        .describe(
          'Optional ABSOLUTE override for the engine-issued report path. Omit in almost all cases: the engine issues ~/.cmux/agents/<agent_id>/report.md, returns it here, and verifies closure against it. Pass a distinct FILE path per child (never a directory) to place a report somewhere you already watch. Check coordination_footer_delivered. For resume_agent_id calls, false means the pointer was deliberately not re-delivered: follow coordination_footer_note and relay only if the restored session lost its original context. For new spawns, if false and contract_path is present, folded pointer submission was queued or unverified, so YOU must relay contract_path, report_path, and done_marker. If false and contract_path is absent, inline mode is active or the contract file could not be written, so YOU must relay report_path and done_marker.',
        ),
      force_new: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "When true, suppress same repo/workspace/role duplicate-lane warnings. Default false so collab leads see reusable existing agents before spawning another lane.",
        ),
      focus: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Leave focus on the created agent tab instead of restoring the exact origin after initialization.",
        ),
      allow_long_inline: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Bypass the inline prompt length cap for a deliberate raw boot-prompt send. Prefer boot_prompt_path for large prompts.",
        ),
      verbose: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Return the full legacy spawn response instead of the lean default.",
        ),
    },
    ANNOTATIONS.mutating,
    async (args) => {
      const creation = new CreatedIdentityScope();
      let reportPathReservationKey: string | null = null;
      let reportPathReservationId: string | null = null;
      try {
        // P11 finding 2: reject a relative override BEFORE anything launches.
        // The zod .refine() covers real MCP calls; this covers direct handler
        // invocation, so no call path can leave an orphaned pane behind an
        // input-validation error.
        if (
          typeof args.report_path === "string" &&
          !isAbsolute(args.report_path.trim())
        ) {
          return err(
            new Error(
              `report_path must be absolute so the producer and consumer resolve the same file: ${args.report_path}`,
            ),
          );
        }
        if (args.collab_path && !isAbsolute(args.collab_path.trim())) {
          throw new Error("collab_path must be absolute");
        }
        if (
          args.report_path &&
          [args.collab_path, ...stateMgr.listStates().map((agent) => agent.collab_path)]
            .some((path) => path && resolve(path) === resolve(args.report_path!.trim()))
        ) {
          return err(
            new Error("report_path cannot target a shared collab_path"),
            { error_code: "shared_collab_report_path" },
          );
        }
        if (args.resume_agent_id) {
          const incompatible = [
            "repo",
            "model",
            "effort",
            "cli",
            "cwd",
            "prompt",
            "boot_prompt_path",
            "worktree",
            "mcp_profile",
            "collab_path",
            "parent_agent_id",
            "role",
            "placement",
            "authority",
            "max_cost_per_agent",
          ].filter((field) =>
            Object.prototype.hasOwnProperty.call(args, field),
          );
          if ((args.type ?? "agent") !== "agent" || incompatible.length > 0) {
            return err(
              new Error(
                `resume_agent_id is mutually exclusive with new-spawn fields${
                    incompatible.length > 0
                      ? `: ${incompatible.join(", ")}`
                      : ""
                  }`,
              ),
              { error_code: "INVALID_RESUME_SPEC" },
            );
          }
          await awaitLifecycleStart();
          const existing = engine.resolveResumeAgent(args.resume_agent_id);
          if (!existing) {
            return err(new Error(`Agent not found: ${args.resume_agent_id}`));
          }
          const resumeCoordination = issueSpawnCoordination(
            existing.agent_id,
            args.report_path,
          );
          if (existing.parent_agent_id) {
            const reservation = await reserveParentReportPath(
              existing.parent_agent_id,
              resolve(resumeCoordination.report_path),
              existing.agent_id,
            );
            if (!reservation.ok) {
              return err(new Error(reservation.message), {
                error_code: "REPORT_PATH_IN_USE",
              });
            }
            reportPathReservationKey = reservation.key;
            reportPathReservationId = reservation.reservation_id;
          }
          const workspace = await canonicalWorkspaceRef(
            args.workspace ?? existing.workspace_id ?? undefined,
          );
          await assertWorkspaceMutationAllowed("spawn_agent", workspace);
          let focusRestoreLease = await focusTargetBeforeSplit(
            workspace,
            args.focus !== true,
          );
          const result = await engine.resumeAgent(args.resume_agent_id, {
            workspace,
            force: args.force,
          });
          creation.record({
            agent_id: result.agent_id,
            surface_id: result.surface_id,
            workspace_id: result.workspace_id ?? workspace ?? null,
          });
          focusRestoreLease = await capturePostCreationFocus(
            focusRestoreLease,
            {
              surface: result.surface_id,
              workspace: result.workspace_id ?? workspace,
            },
          );
          const focusRestoreWarning = await restoreFocusAfterRender(
            focusRestoreLease,
            result.surface_id,
            result.workspace_id ?? workspace,
          );
          // AIDEV-NOTE (P11b / #462 item 2): resume used to return NO
          // contract at all -- no report_path, no done_marker, no contract
          // file -- so the crash-recovery case this repo exists for was the
          // one case where a lead could not even SEE where its worker should
          // report. The contract is derived from agent_id alone, so what is
          // issued here is byte-identical to what the original spawn issued;
          // refreshing the file is idempotent and restores it if the channel
          // dir was reaped between the crash and the resume.
          //
          // What is deliberately NOT done: re-injecting the pointer as
          // keystrokes into a resuming pane. `claude --resume` restores the
          // prior session, so the original pointer message is already in the
          // agent's context, and typing into a pane mid-resume is a change to
          // the most incident-prone path in this repo -- the exact thing this
          // PR exists to move work OFF. That sliver stays open on #462.
          const resumeMonitorBoot = ensureMonitorBoot(result.agent_id);
          const resumeContract = buildBootContractInjection(
            result.agent_id,
            resumeMonitorBoot,
            resumeCoordination,
          );
          result.report_path = resumeCoordination.report_path;
          result.done_marker = resumeCoordination.done_marker;
          result.contract_path = resumeContract.contract_path ?? undefined;
          result.coordination_footer_bytes =
            coordinationFooterBytes(resumeCoordination);
          // Provenance, same rule as the spawn path: the file is refreshed,
          // but nothing was re-delivered to the pane on this call. Saying
          // `true` here would be the claim this PR's own thesis forbids.
          result.coordination_footer_delivered = false;
          result.coordination_footer_note = resumeContract.contract_path
            ? COORDINATION_CONTRACT_REFRESHED_NOT_REDELIVERED
            : COORDINATION_FOOTER_NOT_DELIVERED;
          try {
            const patched = stateMgr.updateRecord(result.agent_id, {
              report_path: resumeCoordination.report_path,
              done_marker: resumeCoordination.done_marker,
            });
            registry.set(result.agent_id, patched);
          } catch {
            // Receipt already carries the contract; a registry write failure
            // must not fail an otherwise-successful resume.
          }
          const reportWatchWarning = result.parent_agent_id
            ? await armParentReportWatch(
                result.parent_agent_id,
                result.agent_id,
                resumeCoordination,
              )
            : null;
          const resumeWarnings = [
            ...(result.warnings ?? []),
            ...(reportWatchWarning ? [reportWatchWarning] : []),
            ...(focusRestoreWarning ? [focusRestoreWarning] : []),
          ];
          const resumed = {
            spawn_state: "started" as const,
            version: 1,
            type: "agent",
            resumed: true,
            ...result,
            role: inferRecordRoleOrNull(existing) ?? "worker",
            ...(resumeWarnings.length > 0
              ? {
                  warning: resumeWarnings.join(" | "),
                  warnings: resumeWarnings,
                }
              : {}),
          };
          return buildSpawnToolReturn(
            { retry_count: currentTransportRetryCount(), ...resumed },
            args.verbose,
            formatOk("spawn_agent", resumed),
          );
        }
        if (args.type === "terminal") {
          if (
            args.role !== undefined ||
            args.authority !== undefined ||
            args.placement !== undefined ||
            args.worktree !== undefined
          ) {
            return err(
              new Error(
                "Terminal spawns do not accept role, authority, placement, or worktree",
              ),
              { error_code: "INVALID_TERMINAL_SPAWN_SPEC" },
            );
          }
          const requestedWorkspace = args.workspace;
          const callerWorkspace = await currentSafetyCallerWorkspace();
          const createsWorkspace = requestedWorkspace?.startsWith("new:");
          await assertWorkspaceMutationAllowed(
            "spawn_agent",
            createsWorkspace
              ? callerWorkspace
              : (requestedWorkspace ?? callerWorkspace),
          );
          const workspace = createsWorkspace
            ? (await client.createWorkspace(requestedWorkspace!.slice(4)))
                .workspace
            : (requestedWorkspace ?? callerWorkspace);
          const panes = await client.listPanes({ workspace });
          const placement = chooseAgentSpawnPlacement(
            panes.panes,
            [],
            new Set<string>(),
            { role: "worker" },
          );
          const created =
            placement.kind === "surface"
              ? await client.newSurface({
                  focus: args.focus ?? !client.listSurfaceRuntimeMetadata,
                  pane: placement.pane,
                  ...(workspace ? { workspace } : {}),
                  type: "terminal",
                })
              : await client.newSplit(placement.direction, {
                  ...(workspace ? { workspace } : {}),
                  ...(placement.pane ? { pane: placement.pane } : {}),
                  focus: args.focus ?? !client.listSurfaceRuntimeMetadata,
                });
          creation.record({
            surface_id: created.surface,
            workspace_id: created.workspace ?? workspace ?? null,
          });
          let runtimeInitialization: string;
          try {
            runtimeInitialization = await initializeNewSurfaceRuntime(
              {
                listTerminalMetadata: client.listSurfaceRuntimeMetadata
                  ? () => client.listSurfaceRuntimeMetadata!()
                  : undefined,
                sendKey: (surface, key, options) => client.sendKey(surface, key, options),
              },
              created.surface,
              created.workspace ?? workspace,
              args.boot_prompt_timeout_ms,
              undefined,
              created.surface_id,
            );
          } catch (error) {
            try {
              await client.closeSurface(created.surface, { workspace: created.workspace ?? workspace });
            } catch (cleanupError) {
              const primary = error instanceof Error ? error : new Error(String(error));
              primary.message += `. Failed to close launcher surface ${created.surface}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
              throw primary;
            }
            throw error;
          }
          if (args.title) {
            await client.renameTab(created.surface, args.title, {
              workspace: created.workspace ?? workspace,
            });
          }
          const cwdReceipt = args.cwd
            ? await withSurfaceWrite(
                created.surface,
                () =>
                  executeDeliveryEngine({
                    surface: created.surface,
                    workspace: created.workspace ?? workspace,
                    chunks: [`cd -- ${shellQuote(args.cwd!)}`],
                    chunk_size: SEND_INPUT_CHUNK_THRESHOLD,
                    chunk_delay_ms: SEND_INPUT_CHUNK_DELAY_MS,
                    press_enter: true,
                    source_event: "send_command",
                    verify_submit: false,
                  }),
                {
                  toolName: "spawn_agent",
                  workspace: created.workspace ?? workspace,
                  observePtyWrite: true,
                },
              )
            : undefined;
          return ok({
            version: 1,
            type: "terminal",
            runtime_initialization: runtimeInitialization,
            surface_id: created.surface,
            workspace_id: created.workspace ?? workspace ?? null,
            cwd: args.cwd ?? null,
            title: args.title ?? null,
            ...(cwdReceipt ? { cwd_receipt: cwdReceipt } : {}),
          });
        }
        const spawnProblems: string[] = [];
        if (!args.repo) {
          spawnProblems.push("repo is required for type=agent");
        }
        if (!args.cli) {
          spawnProblems.push("cli is required for type=agent");
        }
        const rolelessClaude =
          args.version === 1 &&
          (args.cli === "claude" || args.cli === undefined) &&
          args.role === undefined;
        if (rolelessClaude) {
          spawnProblems.push(
            'Claude spawns require an explicit job role; use either authority:"lead", role:"implementor" or authority:"worker", role:"reviewer"',
          );
        }
        if (args.cli) {
          try {
            resolveSpawnModelPolicy(args.cli, args.model);
          } catch (error) {
            spawnProblems.push(
              error instanceof Error ? error.message : String(error),
            );
          }
          try {
            resolveSpawnEffort(args.cli, args.effort);
          } catch (error) {
            spawnProblems.push(
              error instanceof Error ? error.message : String(error),
            );
          }
        }
        if (spawnProblems.length > 0) {
          const error_code =
            spawnProblems.length === 1 &&
            rolelessClaude &&
            args.cli === "claude"
              ? "ROLE_REQUIRED"
              : spawnProblems.length > 1
                ? "INVALID_SPAWN_SPEC"
                : undefined;
          return err(
            new Error(spawnProblems.join("; ")),
            error_code ? { error_code } : {},
          );
        }
        requireValue(args.repo, "repo is required for type=agent");
        requireValue(args.cli, "cli is required for type=agent");
        const normalizedRole = normalizeSpawnAxes({
          role: args.role,
          placement: args.placement,
          authority: args.authority,
        });
        resolveSpawnModelPolicy(args.cli, args.model);
        resolveSpawnEffort(args.cli, args.effort);
        const bootPromptPath = getBootPromptPath(args.boot_prompt_path);
        assertBootPromptMode(args.prompt, bootPromptPath);
        assertSpawnPromptInputAllowed({
          tool: "spawn_agent",
          value: args.prompt,
          cli: args.cli,
          allowLongInline: args.allow_long_inline,
        });
        if (bootPromptPath) {
          await preflightBootPromptFile(bootPromptPath);
        }
        const bootPromptText = bootPromptPath
          ? await readFile(bootPromptPath, "utf8")
          : null;

        if (args.parent_agent_id && args.report_path) {
          const earlyReservation = await reserveParentReportPath(
            args.parent_agent_id,
            resolve(args.report_path.trim()),
          );
          if (!earlyReservation.ok) {
            return err(new Error(earlyReservation.message), {
              error_code: "REPORT_PATH_IN_USE",
            });
          }
          reportPathReservationKey = earlyReservation.key;
          reportPathReservationId = earlyReservation.reservation_id;
        }
        await refreshManagedMetadataBestEffort(args.parent_agent_id);
        await refreshManagedMetadataBestEffort();
        const callerAgent = resolveCurrentCallerAgent();
        const callerRole = callerAgent
          ? inferRecordRoleOrNull(callerAgent)
          : null;
        const callerIsWorker = callerRole === "worker";
        const effectiveParentAgentId = callerIsWorker
          ? callerAgent!.agent_id
          : (args.parent_agent_id ?? callerAgent?.agent_id);
        if (effectiveParentAgentId && args.report_path) {
          const requestedReportPath = resolve(args.report_path.trim());
          const effectiveReservationKey = JSON.stringify([
            effectiveParentAgentId,
            requestedReportPath,
          ]);
          if (
            reportPathReservationKey &&
            reportPathReservationKey !== effectiveReservationKey
          ) {
            parentReportPathReservations.delete(reportPathReservationKey);
            if (reportPathReservationId) {
              await releaseWatchReportPathReservation(
                reportPathReservationId,
                { registryPath: watchRegistryPath },
              );
            }
            reportPathReservationKey = null;
            reportPathReservationId = null;
          }
          if (!reportPathReservationKey) {
            const reservation = await reserveParentReportPath(
              effectiveParentAgentId,
              requestedReportPath,
            );
            if (!reservation.ok) {
              return err(new Error(reservation.message), {
                error_code: "REPORT_PATH_IN_USE",
              });
            }
            reportPathReservationKey = reservation.key;
            reportPathReservationId = reservation.reservation_id;
          }
        }
        const effectiveRole = callerIsWorker ? "worker" : normalizedRole.role;
        const workerCallerWarning = callerIsWorker
          ? `Worker caller ${callerAgent!.agent_id} forced child role to worker and recorded itself as parent; worker-spawned agents cannot claim orchestrator placement.`
          : undefined;
        // TODO(#378): a future policy decision may refuse worker-initiated
        // spawn_agent calls entirely. Current binding is force+warn.
        if (
          effectiveParentAgentId &&
          effectiveParentAgentId !== args.parent_agent_id
        ) {
          await refreshManagedMetadataBestEffort(effectiveParentAgentId);
        }
        const parentWorkspace = effectiveParentAgentId
          ? (engine.getAgentState(effectiveParentAgentId)?.workspace_id ??
            undefined)
          : undefined;
        const targetResolution = await resolvePlacementWorkspace({
          explicitWorkspace: args.workspace,
          callerWorkspace: parentWorkspace,
          repo: args.repo,
        });
        const spawnWorkspace = targetResolution.workspace;
        const comparisonWorkspace = spawnWorkspace ?? parentWorkspace;
        await assertWorkspaceMutationAllowed(
          "spawn_agent",
          comparisonWorkspace,
        );
        const requestedRole = inferAgentRole({
          role: effectiveRole,
          cli: args.cli,
          launcherName: launcherNameForCli(args.repo, args.cli),
        });
        const existingSameLaneAgents = args.force_new
          ? []
          : registry
              .list()
              .filter(
                (agent) =>
                  (agent.state === "ready" || agent.state === "idle") &&
                  reposEquivalent(agent.repo, args.repo!) &&
                  (agent.workspace_id ?? null) ===
                    (comparisonWorkspace ?? null) &&
                  inferRecordRoleOrNull(agent) === requestedRole,
              )
              .map((agent) => ({
                agent_id: agent.agent_id,
                surface_id: agent.surface_id,
                workspace_id: agent.workspace_id ?? null,
                state: agent.state,
                role: inferRecordRoleOrNull(agent),
                task_summary: summarizeTaskSummary(agent.task_summary),
              }));
        const duplicateSpawnWarning =
          existingSameLaneAgents.length > 0
            ? `Existing same-lane agent(s) are idle/ready in ${comparisonWorkspace ?? "unknown workspace"}; reuse or supersede unless a new lane is intentional. Pass force_new:true to suppress this warning.`
            : undefined;
        const spawnPrompt = hasInlinePrompt(args.prompt)
          ? args.prompt
          : (bootPromptText ?? "");
        // Prepare only after every non-spawn gate has passed. From this point
        // onward the catch below owns rollback for any newly created worktree.
        const worktree = await prepareSpawnWorktree(
          args.repo,
          args.worktree,
          args.mcp_profile as McpProfile | undefined,
        );
        const cleanupFailedLauncherArtifacts = async (
          error: Error,
          agentId: string,
          surface: string,
          workspace?: string,
        ): Promise<boolean> => {
          const record = engine.getAgentState(agentId);
          const cleanupSurface = record?.surface_uuid?.trim() || surface;
          try {
            await client.closeSurface(cleanupSurface, { workspace });
          } catch (cleanupError) {
            error.message = `${error.message}. Failed to close launcher surface ${cleanupSurface}: ${
                cleanupError instanceof Error
                  ? cleanupError.message
                  : String(cleanupError)
              }`;
            return false;
          }
          const current = engine.getAgentState(agentId);
          if (current && !TERMINAL_AGENT_STATES.has(current.state)) {
            try {
              const failed = stateMgr.transition(agentId, "error", {
                error: `Launcher surface closed after failed readiness: ${error.message}`,
              });
              registry.set(agentId, failed);
            } catch (stateError) {
              error.message = `${error.message}. Failed to mark closed launcher agent ${agentId} terminal: ${
                  stateError instanceof Error
                    ? stateError.message
                    : String(stateError)
                }`;
            }
          }
          if (worktree.prepared?.created && worktree.repoRoot) {
            try {
              await rollbackPreparedWorktree(
                worktree.repoRoot,
                worktree.prepared,
                opts?.worktreeExec,
              );
            } catch (rollbackError) {
              error.message = `${error.message}. Worktree rollback also failed: ${
                  rollbackError instanceof Error
                    ? rollbackError.message
                    : String(rollbackError)
                }`;
            }
          }
          return true;
        };
        const runtimeMetadataSupported = typeof client.listSurfaceRuntimeMetadata === "function" ||
          (typeof client.listTerminalMetadata === "function" &&
          await readRuntimeMetadata(() => client.listTerminalMetadata())
            .then(({ terminals }) => terminals.some((item) => typeof item.runtime_surface_ready === "boolean"))
            .catch(() => false));
        const focusForLaunch = args.focus === true || !runtimeMetadataSupported;
        let focusRestoreLease = focusForLaunch
          ? await focusTargetBeforeSplit(spawnWorkspace, args.focus !== true)
          : null;
        let surfaceCreated = false;
        let result: Awaited<ReturnType<typeof engine.spawnAgent>>;
        try {
          result = await engine.spawnAgent({
            repo: args.repo,
            focus: focusForLaunch,
            runtime_metadata_supported: runtimeMetadataSupported,
            model: args.model,
            effort: args.effort,
            cli: args.cli,
            prompt: spawnPrompt,
            boot_prompt_path: bootPromptPath,
            boot_prompt_pending: true,
            workspace: spawnWorkspace,
            cwd: worktree.prepared?.path,
            mcp_env: worktree.mcpEnv,
            mcp_profile_label: worktree.mcpProfileLabel,
            worktree_branch: worktree.prepared?.branch,
            parent_agent_id: effectiveParentAgentId,
            collab_path: args.collab_path,
            role: effectiveRole,
            authority: callerIsWorker ? "worker" : normalizedRole.authority,
            function: normalizedRole.function,
            placement: callerIsWorker ? "right" : normalizedRole.placement,
            auto_archive_on_done: args.auto_archive_on_done ?? false,
            title: args.title,
            max_cost_per_agent: args.max_cost_per_agent,
            halt_escalation: args.halt_escalation,
            boot_prompt_timeout_ms: args.boot_prompt_timeout_ms,
            on_surface_created: async (created) => {
              surfaceCreated = true;
              creation.record({
                agent_id: created.agent_id,
                surface_id: created.surface,
                workspace_id: created.workspace ?? spawnWorkspace ?? null,
              });
              focusRestoreLease = await capturePostCreationFocus(
                focusRestoreLease,
                created,
              );
            },
          });
        } catch (e) {
          if (
            e instanceof AgentLaunchError &&
            e.launch_phase === "launch" &&
            (e.launch_cause instanceof SurfaceRuntimeNotStartedError ||
              e.launch_cause instanceof LauncherReadinessError ||
              (e.launch_cause instanceof BootPromptTimeoutError &&
                e.launch_cause.pending_input_observed))
          ) {
            await cleanupFailedLauncherArtifacts(
              e,
              e.agent_id,
              e.surface_id,
              e.workspace_id,
            );
          }
          let rollbackError: unknown = null;
          if (
            !surfaceCreated &&
            worktree.prepared?.created &&
            worktree.repoRoot
          ) {
            try {
              await rollbackPreparedWorktree(
                worktree.repoRoot,
                worktree.prepared,
                opts?.worktreeExec,
              );
            } catch (error) {
              rollbackError = error;
            }
          }
          try {
            await restoreFocusAfterRender(
              focusRestoreLease,
              undefined,
              spawnWorkspace,
            );
          } catch {
            // Preserve the original spawn error response.
          }
          if (rollbackError) {
            const rollback =
              rollbackError instanceof Error
                ? rollbackError.message
                : String(rollbackError);
            if (e instanceof Error) {
              e.message = `${e.message}. Worktree rollback also failed: ${rollback}`;
              throw e;
            }
            throw new Error(
              `${String(e)}. Worktree rollback also failed: ${rollback}`,
              { cause: e },
            );
          }
          throw e;
        }
        const originalLaunchCommand = originalLaunchCommandsBySurface.get(
          result.surface_id,
        );
        originalLaunchCommandsBySurface.delete(result.surface_id);
        const launchShellRecovery = launchShellRecoveryBySurface.get(
          result.surface_id,
        );
        launchShellRecoveryBySurface.delete(result.surface_id);
        const monitorBoot = ensureMonitorBoot(result.agent_id);
        const coordination = issueSpawnCoordination(
          result.agent_id,
          args.report_path,
        );
        // AIDEV-NOTE (P11b): P11 could not deliver this contract -- inline,
        // the mailbox contract alone was ~479 chars against a 500-char chunk
        // threshold, so appending the report contract (measured 618 chars)
        // moved every spawn onto the chunked paste path (#434/#438). The
        // contract now goes to a file and the wire carries one short line, so
        // the worker is finally TOLD the same two strings the receipt reports.
        const bootContract = buildBootContractInjection(
          result.agent_id,
          monitorBoot,
          coordination,
        );
        // #782/#801: a sterile seat gets only the caller's brief typed.
        const skipContractPointer = args.mcp_profile === "sterile";
        const injectedBootPrompt = skipContractPointer
          ? undefined
          : bootContract.text;
        result.report_path = coordination.report_path;
        result.done_marker = coordination.done_marker;
        // Finding 3: never report the contract's size without reporting how
        // (or whether) it reached the worker -- the v0.4.42 `paused`
        // provenance fix, applied to both outcomes of the fallback above.
        result.coordination_footer_bytes =
          coordinationFooterBytes(coordination);
        result.contract_path = bootContract.contract_path ?? undefined;
        result.coordination_footer_delivered = false;
        result.coordination_footer_note = skipContractPointer
          ? bootContract.contract_path
            ? COORDINATION_CONTRACT_POINTER_SKIPPED_STERILE
            : COORDINATION_CONTRACT_SKIPPED_STERILE_NO_FILE
          : bootContract.contract_path
            ? COORDINATION_CONTRACT_POINTER_NOT_VERIFIED
            : COORDINATION_FOOTER_NOT_DELIVERED;
        try {
          const patched = stateMgr.updateRecord(result.agent_id, {
            report_path: coordination.report_path,
            done_marker: coordination.done_marker,
          });
          registry.set(result.agent_id, patched);
        } catch {
          // Receipt already carries the contract; a registry write failure
          // must not fail an otherwise-successful spawn.
        }
        if (result.parent_agent_id) {
          const reportWatchWarning = await armParentReportWatch(
            result.parent_agent_id,
            result.agent_id,
            coordination,
          );
          if (reportWatchWarning) {
            result.warnings = [
              ...(result.warnings ?? []),
              reportWatchWarning,
            ];
          }
        }
        const spawnedBinding = engine.getAgentState(result.agent_id);
        const callerOwnsSpawnedDraft = () => callerOwnsTypedDraft({
          surface: result.surface_id,
          workspace: spawnDeliveryWorkspace(result, spawnWorkspace),
          stableSurfaceIdentity: spawnedBinding?.surface_uuid,
        });
        appendStaleBuildWarning(result);
        const placementWarnings = [
          ...targetResolution.warnings,
          ...(normalizedRole.warning ? [normalizedRole.warning] : []),
          ...(workerCallerWarning ? [workerCallerWarning] : []),
        ];
        if (placementWarnings.length > 0) {
          result.warnings = [
            ...(result.warnings ?? []),
            ...placementWarnings,
          ];
        }

        let bootPromptDelivery:
          Awaited<ReturnType<typeof deliverBootPrompt>> | undefined;
        let launcherSurfaceClosed = false;
        try {
          {
            const deliveryWorkspace = spawnDeliveryWorkspace(
              result,
              spawnWorkspace,
            );
            bootPromptDelivery = await deliverBootPrompt({
              surface: result.surface_id,
              workspace: deliveryWorkspace,
              stableSurfaceIdentity: spawnedBinding?.surface_uuid,
              resolveRoute: spawnedBinding?.surface_uuid
                ? () => resolveManagedDeliveryRoute(result.agent_id)
                : undefined,
              assertStableSurfaceIdentity: spawnedBinding?.surface_uuid
                ? async () => {
                  const current = engine.getAgentState(result.agent_id);
                  if (current?.surface_uuid?.toLowerCase() !==
                      spawnedBinding.surface_uuid?.toLowerCase()) {
                    throw new Error("Spawn surface UUID changed during Codex update menu selection");
                  }
                }
                : undefined,
              cli: args.cli,
              prompt: args.prompt,
              boot_prompt_path: bootPromptPath,
              injected_prompt: injectedBootPrompt,
              timeout_ms: args.boot_prompt_timeout_ms,
              onUpdateShellRelaunch: () =>
                relaunchSpawnAgentAfterUpdate({
                  agentId: result.agent_id,
                  surface: result.surface_id,
                  workspace: deliveryWorkspace,
                  model: result.model ?? args.model,
                  mcpEnv: result.mcp_env,
                  originalCommand: originalLaunchCommand,
                  timeout_ms: args.boot_prompt_timeout_ms,
                }),
            });
            if (bootContract.contract_path !== null && !skipContractPointer) {
              result.coordination_footer_delivered =
                isBootPromptDelivered(bootPromptDelivery);
              result.coordination_footer_note =
                result.coordination_footer_delivered
                  ? COORDINATION_CONTRACT_DELIVERED_NOTE
                  : COORDINATION_CONTRACT_POINTER_NOT_VERIFIED;
            }

            await captureSpawnSessionBestEffort(result);
            if (bootPromptDelivery.prompt_text !== null) {
              const updated = stateMgr.updateRecord(result.agent_id, {
                ...bootPromptRegistryFields(
                  bootPromptDelivery.prompt_text,
                  bootPromptPath,
                ),
                boot_prompt_pending:
                  bootPromptDelivery.submit_verified !== true,
                prompt_delivered: bootPromptDelivery.submit_verified === true,
                submit_verified: bootPromptDelivery.submit_verified,
              });
              registry.set(result.agent_id, updated);
            } else {
              const updated = stateMgr.updateRecord(result.agent_id, {
                boot_prompt_pending:
                  bootPromptDelivery.delivery_state === "queued",
                prompt_delivered: false,
                submit_verified: null,
              });
              registry.set(result.agent_id, updated);
            }

            const current = engine.getAgentState(result.agent_id);
            if (
              current?.state === "booting" &&
              (hasInlinePrompt(args.prompt) || Boolean(bootPromptPath)) &&
              bootPromptDelivery.submit_verified === true
            ) {
              const ready = stateMgr.transition(result.agent_id, "ready");
              registry.set(result.agent_id, ready);
              result.state = "ready";
            } else if (current?.state === "ready") {
              result.state = "ready";
            }
          }
        } catch (e) {
          creation.attach(e);
          if (e instanceof LauncherReadinessError) {
            launcherSurfaceClosed = await cleanupFailedLauncherArtifacts(
              e,
              result.agent_id,
              result.surface_id,
              spawnDeliveryWorkspace(result, spawnWorkspace),
            );
          }
          const message = e instanceof Error ? e.message : String(e);
          const clearBootPromptPending = () => {
            const record = resolveSpawnRecord(
              result.agent_id,
              result.surface_id,
            );
            const agentId = record?.agent_id ?? result.agent_id;
            const updated = stateMgr.updateRecord(
              agentId,
              e instanceof BootComposerResidueError
                ? {
                  // The brief itself was submitted and is running; only the
                  // residue was left behind (#801 review F1).
                  boot_prompt_pending: false,
                  prompt_delivered: true,
                  submit_verified: e.submit_verified,
                }
                : {
                  // A readiness timeout happens before delivery. Preserve the
                  // pending marker so a later idle CLI cannot be mistaken for a
                  // successfully tasked agent by the lifecycle sweep.
                  boot_prompt_pending:
                    e instanceof BootPromptTimeoutError ||
                    e instanceof BootPromptDeliveryError,
                  prompt_delivered: false,
                  submit_verified:
                    e instanceof BootPromptDeliveryError ? false : null,
                },
            );
            registry.set(agentId, updated);
            result.agent_id = updated.agent_id;
            return updated;
          };
          try {
            await captureSpawnSessionBestEffort(result);
            let updated = clearBootPromptPending();
            if (
              !(e instanceof BootPromptTimeoutError) &&
              !(e instanceof BootPromptDeliveryError) &&
              updated.state !== "done" &&
              updated.state !== "error"
            ) {
              updated = stateMgr.transition(result.agent_id, "error", {
                error: `Boot prompt failed: ${message}`,
              });
              registry.set(result.agent_id, updated);
            }
          } catch {
            // Preserve the original boot prompt error response.
          }
          try {
            // Boot delivery already performed its own readiness wait. On a
            // timeout, restore immediately instead of starting a second wait.
            await restoreFocusAfterRender(
              focusRestoreLease,
              launcherSurfaceClosed ? undefined : result.surface_id,
              spawnDeliveryWorkspace(result, spawnWorkspace),
              { waitForReady: false },
            );
          } catch {
            // Preserve the original boot prompt error response.
          }
          const extra = {
            agent_id: result.agent_id,
            surface_id: result.surface_id,
          };
          if (e instanceof SurfaceGoneError) {
            return err(e, surfaceGonePayload(e, extra));
          }
          if (e instanceof BootPromptTimeoutError) {
            try {
              clearBootPromptPending();
            } catch {
              // Preserve the original timeout response.
            }
            return err(e, { ...extra, last_10_lines: e.last_10_lines });
          }
          if (e instanceof BootPromptUpdateMenuBlockedError) {
            return err(e, {
              ...extra,
              error_code: e.error_code,
              last_10_lines: e.last_10_lines,
              recovery: e.recovery,
            });
          }
          if (e instanceof BootComposerResidueError) {
            await refreshManagedMetadataBestEffort(result.agent_id);
            await lifecycleSeatManifestPublisher({ agentId: result.agent_id });
            return err(e, {
              ...extra,
              error_code: e.error_code,
              composer_residue: e.composer_residue,
              delivered_chars: e.delivered_chars,
              typed: e.typed,
              submit_dispatched: e.submit_dispatched,
              rpc_methods: e.rpc_methods,
              boot_prompt_submit_verified: e.submit_verified,
              report_path: result.report_path,
              done_marker: result.done_marker,
              contract_path: result.contract_path,
              next_action:
                "Return WAS dispatched: the brief was submitted and the agent is working on it, " +
                "but the text in composer_residue stayed unsent in its composer. Do not re-spawn. " +
                "If the residue is the contract pointer, relay contract_path, report_path and done_marker " +
                "to the agent yourself; otherwise send the residue with send_to once the draft is cleared.",
            });
          }
          if (e instanceof BootPromptDeliveryError) {
            const safetyError = findErrorInChain(
              e,
              (candidate): candidate is ManualModeMutationError | DeliverySafetyGateError =>
                candidate instanceof ManualModeMutationError ||
                candidate instanceof DeliverySafetyGateError,
            );
            if (safetyError) {
              return err(safetyError, {
                ...extra,
                delivered_chars: e.delivered_chars,
                ...bootPromptFailureMutationEvidence({
                  delivered_chars: e.delivered_chars,
                  typed: e.typed,
                  submit_dispatched: e.submit_dispatched,
                  rpc_methods: e.rpc_methods,
                }),
              });
            }
            const bootPromptReceipt = e.submit_verification_error
              ? { ...submitVerificationFailurePayload(e.submit_verification_error),
                  terminal: true,
                  bytes: e.delivered_chars }
              : {
                  ...buildPublicDeliveryReceipt({
                    delivery_state: "pending_verify",
                    typed: e.typed || e.delivered_chars > 0,
                    submit_attempted: e.submit_dispatched,
                    submit_dispatched: e.submit_dispatched,
                    submit_verified: false,
                    retry_count: currentTransportRetryCount(),
                    rpc_methods: e.rpc_methods,
                  }),
                  bytes: e.delivered_chars,
                };
            await refreshManagedMetadataBestEffort(result.agent_id);
            await lifecycleSeatManifestPublisher({ agentId: result.agent_id });
            return buildSpawnToolReturn(
              {
                retry_count: currentTransportRetryCount(),
                ...result,
                spawn_state: "boot_unsubmitted",
                workspace_id: result.workspace_id,
                delivered_chars: e.delivered_chars,
                boot_prompt_delivered: false,
                boot_prompt_receipt: bootPromptReceipt,
                boot_prompt_submit_verified: false,
              },
              args.verbose,
              undefined,
              undefined,
              { callerOwnsBootDraft: callerOwnsSpawnedDraft() },
            );
          }
          return err(e, extra);
        }

        const focusRestoreWarning = await restoreFocusAfterRender(
          focusRestoreLease,
          result.surface_id,
          spawnDeliveryWorkspace(result, spawnWorkspace),
          {
            waitForReady: !bootPromptDelivery,
          },
        );
        if (focusRestoreWarning) {
          result.warnings = [...(result.warnings ?? []), focusRestoreWarning];
        }

        await refreshManagedMetadataBestEffort(result.agent_id);
        await lifecycleSeatManifestPublisher({
          agentId: result.agent_id,
        });
        const currentAgent = engine.getAgentState(result.agent_id);
        const topologyRole =
          currentAgent?.role ??
          inferAgentRole({
            role: effectiveRole,
            cli: args.cli,
            launcherName: launcherNameForCli(args.repo, args.cli),
          });
        const topology = currentAgent ? await collectSurfaceTopology() : null;
        const health = currentAgent
          ? await evaluateServerAgentHealth(
              currentAgent,
              {
                ...healthTopologyOverrides(currentAgent, topology),
              },
              topology,
            )
          : undefined;

        if (callerAgent && !callerIsWorker && effectiveRole === "worker" &&
            result.parent_agent_id === callerAgent.agent_id && args.collab_path) {
          const adopted = stateMgr.updateRecord(callerAgent.agent_id, { collab_path: args.collab_path.trim() });
          registry.set(callerAgent.agent_id, adopted);
        }

        const formattedData = {
          agent_id: result.agent_id,
          parent_agent_id: result.parent_agent_id,
          repo: args.repo,
          model: result.model ?? args.model,
          requested_model: result.requested_model,
          warning:
            result.warnings && result.warnings.length > 0
              ? result.warnings.join(" | ")
              : undefined,
          surface: result.surface_id,
          role: args.version === 1 ? normalizedRole.function : topologyRole,
          authority: callerIsWorker ? "worker" : normalizedRole.authority,
          placement: callerIsWorker ? "right" : normalizedRole.placement,
          version: 1,
          type: "agent",
          health,
          duplicate_spawn_warning: duplicateSpawnWarning,
          monitor_boot: monitorBoot,
          boot_prompt_delivered: isBootPromptDelivered(bootPromptDelivery),
        };
        const responseData = {
          ...result,
          spawn_state:
            bootPromptDelivery && bootPromptDelivery.submit_verified !== true
              ? "boot_unsubmitted"
              : "started",
          worktree: worktree.prepared,
          mcp_profile: worktree.mcpProfileLabel,
          role: args.version === 1 ? normalizedRole.function : topologyRole,
          authority: callerIsWorker ? "worker" : normalizedRole.authority,
          placement: callerIsWorker ? "right" : normalizedRole.placement,
          version: 1,
          type: "agent",
          health,
          duplicate_spawn_warning: duplicateSpawnWarning,
          existing_same_lane_agents: existingSameLaneAgents,
          monitor_boot: monitorBoot,
          boot_prompt_delivered: isBootPromptDelivered(bootPromptDelivery),
          boot_prompt_receipt: bootPromptDelivery,
          boot_prompt_bytes: bootPromptDelivery?.bytes,
          boot_prompt_submit_verified:
            bootPromptDelivery?.submit_verified ?? null,
          ...(bootPromptDelivery?.update_menu_skipped ? {
            update_menu_skipped: true,
            update_menu_text_hash: bootPromptDelivery.update_menu_text_hash,
          } : {}),
          ...(launchShellRecovery?.recovered
            ? {
                readiness_recovered: true,
                readiness_cleared: launchShellRecovery.cleared,
              }
            : {}),
        };
        return buildSpawnToolReturn(
          {
            retry_count: currentTransportRetryCount(),
            ...responseData,
          },
          args.verbose,
          formatOk("spawn_agent", formattedData),
          undefined,
          { callerOwnsBootDraft: callerOwnsSpawnedDraft() },
        );
      } catch (e) {
        const caught = creation.attach(e);
        if (caught instanceof AgentLaunchError) {
          if (caught.launch_cause instanceof DeliverySafetyGateError) {
            creation.attach(caught.launch_cause);
            return err(caught.launch_cause, {
              agent_id: caught.agent_id,
              surface_id: caught.surface_id,
              workspace_id: caught.workspace_id,
              error_code: caught.launch_cause.error_code,
              submit_verified: caught.launch_cause.submit_verified,
              screen: caught.launch_cause.screen,
            });
          }
          if (caught.launch_cause instanceof SurfaceGoneError) {
            creation.attach(caught.launch_cause);
            return err(
              caught.launch_cause,
              surfaceGonePayload(caught.launch_cause, {
                agent_id: caught.agent_id,
                surface_id: caught.surface_id,
                workspace_id: caught.workspace_id,
              }),
            );
          }
          return err(caught, {
            agent_id: caught.agent_id,
            surface_id: caught.surface_id,
            workspace_id: caught.workspace_id,
          });
        }
        if (caught instanceof DeliverySafetyGateError) {
          return err(caught, {
            error_code: caught.error_code,
            submit_verified: caught.submit_verified,
            screen: caught.screen,
          });
        }
        if (caught instanceof SurfaceGoneError) {
          return err(caught, surfaceGonePayload(caught));
        }
        return err(caught);
      } finally {
        if (reportPathReservationKey) {
          parentReportPathReservations.delete(reportPathReservationKey);
        }
        if (reportPathReservationId) {
          try {
            await releaseWatchReportPathReservation(reportPathReservationId, {
              registryPath: watchRegistryPath,
            });
          } catch (error) {
            console.error(
              `[cmuxlayer] failed to release report-path reservation ${reportPathReservationId}:`,
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      }
    },
  );
}
