// send_to and wait_for moved verbatim out of createServer's closure (CX-3b
// S10b); captured closure state arrives as the *ToolDeps interfaces below.

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { RetryableDeliveryError } from "../../agent-engine.js";
import { type WatchSpec } from "../../watch-spec.js";
import type { AgentRecord, AgentState } from "../../agent-types.js";
import { formatOk } from "../../format.js";
import { sanitizeTerminalInput } from "../../sanitize.js";
import { assertCanonicalSurfaceRef } from "../../surface-ref.js";
import { healthTopologyOverrides } from "../../surface-topology.js";
import {
  ANNOTATIONS,
  WatchSpecSchema,
  SEND_TO_WORKING_EXAMPLE,
  SendToArgsSchema,
} from "../schemas.js";
import {
  deliveryRpcMethodsFromError,
  deliveryTypedFromError,
  deliverySubmitDispatchedFromError,
  createDeliveryPhaseTimings,
  withSurfaceDeliveryTimings,
  buildPublicDeliveryReceipt,
  pausedTargetWarning,
  SubmitVerificationError,
  AmbiguousBootRecoveryReturnError,
  submitVerificationFailurePayload,
  DeliverySafetyGateError,
} from "../../delivery/receipts.js";
import { okFormatted, err } from "../tool-result.js";
import {
  PANE_INPUT_BREAKAGE_GUIDANCE,
  SEND_INPUT_MAX_INLINE_CHARS,
  assertInteractiveMultilineInputAllowed,
  assertInlineInputAllowed,
  assertDenseInlineInputAllowed,
} from "../../delivery/input-policy.js";
import { formatToolValidationError } from "../tool-input.js";
import type { AgentEngine } from "../../agent-engine.js";
import type { AgentHealthInputOverrides } from "../../agent-health-input.js";
import type {
  AgentHealthIssueCode,
  AgentHealthIssueSeverity,
  AgentHealthStatus,
} from "../../agent-health.js";
import type { AgentRegistry } from "../../agent-registry.js";
import type { LifecycleAgentInputDeliverer } from "../context.js";
import type { LiveAgentState } from "../../live-agent-state.js";
import type {
  ParsedControlPlaneState,
  ParsedScreenAgentType,
  ParsedScreenStatus,
} from "../../types.js";
import type { ServerAgentHealthEvaluator } from "./agent.js";
import type { SurfaceTopologySnapshot } from "../../surface-topology.js";
import type { ToolHandlerRegistry } from "../registration.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DeliveryEventType } from "../../agent-types.js";
import type {
  DeliveryPhaseTimings,
  PublicDeliveryState,
  SubmitEvidence,
  SubmitKeyVerificationReason,
} from "../../delivery/receipts.js";
import type { ParsedScreenResult } from "../../types.js";

export interface WaitForToolDeps {
  collectSurfaceTopology: (workspace?: string) => Promise<SurfaceTopologySnapshot | null>;
  engine: AgentEngine;
  evaluateServerAgentHealth: ServerAgentHealthEvaluator;
  observeAgentOnce: (agent: AgentRecord, topology: SurfaceTopologySnapshot | null) => Promise<{ screenOverrides: AgentHealthInputOverrides; live: LiveAgentState; }>;
  refreshManagedMetadataBestEffort: (agentId?: string) => Promise<void>;
  registry: AgentRegistry;
  resolveCurrentCallerAgent: () => AgentRecord | null;
}

export function registerWaitForTool(
  server: McpServer,
  deps: WaitForToolDeps,
): void {
  const {
    collectSurfaceTopology,
    engine,
    evaluateServerAgentHealth,
    observeAgentOnce,
    refreshManagedMetadataBestEffort,
    registry,
    resolveCurrentCallerAgent,
  } = deps;
  // 12. wait_for
  server.tool(
    "wait_for",
    "Block until one agent_id or every agent in ids reaches a target registry state and return health. Defaults to waiting for completion (`done`).",
    {
      watch: WatchSpecSchema.optional().describe(
        "Declared WatchSpec alternative to agent_id/ids",
      ),
      agent_id: z
        .string()
        .optional()
        .describe("Single agent ID from spawn_agent"),
      delivery_id: z
        .string()
        .optional()
        .describe(
          "Wait for a send_to delivery_id to reach a terminal outcome",
        ),
      ids: z
        .array(z.string())
        .min(1)
        .optional()
        .describe("Agent IDs to wait for together"),
      mine: z
        .boolean()
        .optional()
        .default(false)
        .describe("Wait for every direct child of the calling agent"),
      target_state: z
        .enum(["ready", "working", "idle", "done", "error"])
        .optional()
        .describe("State to wait for"),
      condition: z
        .enum(["ready", "working", "idle", "done", "error"])
        .optional()
        .describe("Alias for target_state"),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .default(300000)
        .describe("Timeout in milliseconds (default: 5 minutes)"),
    },
    ANNOTATIONS.mutating,
    async (args, extra) => {
      const progressToken = extra._meta?.progressToken;
      let progress = 0;
      const progressTimer =
        progressToken !== undefined
          ? setInterval(() => {
              progress += 1;
              void extra
                .sendNotification({
                  method: "notifications/progress",
                  params: {
                    progressToken,
                    progress,
                    message: "wait_for still waiting",
                  },
                })
                .catch(() => {});
            }, 45_000)
          : null;
      progressTimer?.unref?.();
      try {
        if (args.watch) {
          if (args.agent_id || args.ids || args.mine || args.delivery_id) {
            throw new Error(
              "wait_for watch is mutually exclusive with agent_id, ids, mine, and delivery_id",
            );
          }
          const publicSpec = { ...(args.watch as WatchSpec) };
          delete (publicSpec as WatchSpec & { provenance?: unknown })
            .provenance;
          const result = await engine.waitForWatch(
            { ...publicSpec, provenance: "public" },
            args.timeout_ms,
          );
          return okFormatted(
            formatOk("wait_for", {
              watch_id: result.watch.watch_id,
              state: result.watch.state,
            }),
            result,
          );
        }
        if (args.delivery_id) {
          if (args.agent_id || args.ids || args.mine) {
            throw new Error(
              "wait_for delivery_id is mutually exclusive with agent_id, ids, and mine",
            );
          }
          const receipt = await engine.waitForDelivery(
            args.delivery_id,
            args.timeout_ms,
          );
          const data = {
            ...buildPublicDeliveryReceipt({
              delivery_id: receipt.delivery_id,
              delivery_state: receipt.delivery_state,
              typed: receipt.typed === true,
              submit_attempted: receipt.press_enter,
              submit_dispatched: receipt.submit_dispatched === true,
              submit_verified: receipt.submit_verified,
              retry_count: receipt.retry_count,
              rpc_methods: receipt.rpc_methods ?? [],
              needs_attention: receipt.needs_attention,
              attention_reason: receipt.attention_reason,
            }),
            agent_id: receipt.agent_id,
            ...(receipt.needs_attention === true
              ? {
                  needs_attention: true,
                  attention_reason: receipt.attention_reason,
                }
              : {}),
            ...(receipt.timed_out ? { timed_out: true } : {}),
          };
          return okFormatted(formatOk("wait_for", data), data);
        }
        if (
          args.condition &&
          args.target_state &&
          args.condition !== args.target_state
        ) {
          throw new Error(
            "wait_for condition and target_state disagree; provide one state",
          );
        }
        const targetState = args.target_state ?? args.condition ?? "done";
        if (args.mine && (args.agent_id || args.ids)) {
          throw new Error(
            "wait_for mine=true is mutually exclusive with agent_id and ids",
          );
        }
        let waitIds = args.ids;
        if (args.mine) {
          const caller = resolveCurrentCallerAgent();
          if (!caller) {
            throw new Error(
              "wait_for mine=true requires a managed calling agent identity",
            );
          }
          waitIds = registry
            .getChildren(caller.agent_id)
            .map((agent) => agent.agent_id);
        }
        if (waitIds) {
          if (waitIds.length === 0) {
            return okFormatted(
              formatOk("wait_for", { count: 0, target: targetState }),
              { results: [], mine: args.mine },
            );
          }
          const results = await engine.waitForAll(
            waitIds,
            targetState,
            args.timeout_ms,
          );
          await Promise.all(
            results
              .map((result) => result.agent?.agent_id)
              .filter((agentId): agentId is string => Boolean(agentId))
              .map((agentId) => refreshManagedMetadataBestEffort(agentId)),
          );
          const topology = await collectSurfaceTopology();
          const enrichedResults = await Promise.all(
            results.map(async (result) => {
              const resultAgent = result.agent
                ? engine.getAgentState(result.agent.agent_id)
                : null;
              // T1b (#488): one observation feeds this reply's health block
              // AND its closure, so the two cannot contradict each other.
              const observed = resultAgent
                ? await observeAgentOnce(resultAgent, topology)
                : null;
              // P11 Contract B: a lead that BLOCKS on its children gets the
              // closure state in the reply it was already waiting for -- the
              // completion signal surfaces where the parent actually looks,
              // with no new carrier (#414: a carrier without a reader is not
              // a carrier).
              const harvest = resultAgent
                ? engine.assessHarvestability(resultAgent, {
                    live: observed?.live ?? null,
                  })
                : null;
              const health = resultAgent
                ? await evaluateServerAgentHealth(
                    resultAgent,
                    {
                      ...healthTopologyOverrides(resultAgent, topology),
                      ...(observed?.screenOverrides ?? {}),
                      ...(harvest ? { harvestability: harvest } : {}),
                    },
                    topology,
                  )
                : undefined;
              return {
                ...result,
                registry_state: resultAgent?.state ?? null,
                screen_confirmed_state: health?.screen_confirmed_state ?? null,
                health,
                ...(harvest
                  ? {
                      closure: harvest.closure,
                      closure_artifact_verified:
                        harvest.closure_artifact_verified,
                      report_path: harvest.report_path,
                      done_marker: harvest.done_marker,
                    }
                  : {}),
                agent:
                  result.agent && health
                    ? { ...result.agent, health }
                    : result.agent,
              };
            }),
          );
          return okFormatted(
            formatOk("wait_for", {
              count: results.length,
              target: targetState,
            }),
            { results: enrichedResults },
          );
        }
        if (!args.agent_id) {
          throw new Error("wait_for requires agent_id, ids, or delivery_id");
        }
        const result = await engine.waitFor(
          args.agent_id,
          targetState,
          args.timeout_ms,
        );
        await refreshManagedMetadataBestEffort(result.agent?.agent_id);
        const resultAgent = result.agent
          ? engine.getAgentState(result.agent.agent_id)
          : null;
        const topology = resultAgent ? await collectSurfaceTopology() : null;
        const health = resultAgent
          ? await evaluateServerAgentHealth(
              resultAgent,
              {
                ...healthTopologyOverrides(resultAgent, topology),
              },
              topology,
            )
          : undefined;
        return okFormatted(
          formatOk("wait_for", {
            agent_id: args.agent_id,
            state: result.state,
            health,
          }),
          {
            agent_id: args.agent_id,
            ...result,
            registry_state: resultAgent?.state ?? null,
            screen_confirmed_state: health?.screen_confirmed_state ?? null,
            health,
            agent:
              result.agent && health
                ? { ...result.agent, health }
                : result.agent,
          },
        );
      } catch (e) {
        if (e instanceof DeliverySafetyGateError) {
          return err(e, {
            error_code: e.error_code,
            submit_verified: e.submit_verified,
            screen: e.screen,
          });
        }
        if (e instanceof SubmitVerificationError) {
          return err(e, {
            submit_verified: false,
            retry_count: e.retry_count,
          });
        }
        return err(e);
      } finally {
        if (progressTimer) clearInterval(progressTimer);
      }
    },
  );
}

export interface SendToToolDeps {
  assertWorkerUpwardChannel: (target: string) => void;
  awaitLifecycleStart: () => Promise<void>;
  broadcastSkipReason: (agent: AgentRecord) => Promise<string | null>;
  canonicalWorkspaceRef: (candidate?: string) => Promise<string | undefined>;
  collectDeliveryEvidence: (agentId: string) => Promise<{ registry_state: null; screen: null; state_conflict: boolean; health: undefined; } | { registry_state: AgentState; screen: { status: ParsedScreenStatus; agent_type: ParsedScreenAgentType; model: string | null; done_signal: string | null; actions: string[]; } | null; state_conflict: boolean; health: { screen_observation?: { observed_at_ms: number; status: ParsedScreenStatus; agent_type: ParsedScreenAgentType; control_state: ParsedControlPlaneState; model: string | null; } | undefined; status: AgentHealthStatus; issue_codes: AgentHealthIssueCode[]; issues: string[]; issue_severities?: Partial<Record<AgentHealthIssueCode, AgentHealthIssueSeverity>>; reconciled_state?: AgentState; screen_confirmed_state?: AgentState; recommended_actions?: string[]; }; }>;
  collectTargetRecords: () => Promise<AgentRecord[]>;
  deliverAgentInput: (args: { agent_id: string; text: string; press_enter: boolean; allow_busy?: boolean; source_event: DeliveryEventType; delivery_id?: string; timings?: DeliveryPhaseTimings; }) => Promise<{ queued_behind_turn: boolean; delivered: boolean; terminal: boolean; typed: boolean; submit_attempted: boolean; submit_dispatched?: boolean; submit_verified: boolean | null; submitted: boolean; submit_evidence?: SubmitEvidence | null; retry_count: number; rpc_methods: Array<"surface.send_text" | "surface.send_key">; delivery?: PublicDeliveryState; delivery_state?: PublicDeliveryState; delivery_id?: string; duplicate_of?: string; needs_attention?: boolean; attention_reason?: string; timings_ms?: DeliveryPhaseTimings; observation?: { status: ParsedScreenResult["status"]; composer_empty: boolean; prompt_echoed: boolean; last_10_lines: string[]; }; WARNING?: string; bytes: number; key_dispatched?: boolean; submit_verification_reason?: SubmitKeyVerificationReason | null; }>;
  engine: AgentEngine;
  observePausedTarget: (agent: AgentRecord | null | undefined) => Promise<{ paused: boolean; source: string; }>;
  registry: AgentRegistry;
  toolHandlersByName: ToolHandlerRegistry;
}

export function registerSendToTool(
  server: McpServer,
  deps: SendToToolDeps,
): void {
  const {
    assertWorkerUpwardChannel,
    awaitLifecycleStart,
    broadcastSkipReason,
    canonicalWorkspaceRef,
    collectDeliveryEvidence,
    collectTargetRecords,
    deliverAgentInput,
    engine,
    observePausedTarget,
    registry,
    toolHandlersByName,
  } = deps;
  // 17. send_to
  server.tool(
    "send_to",
    "Send text or a key through the shared delivery engine. Never send a Return yourself for a message; send_to submits messages. Key-Return is for pickers, menus, and permission prompts. Every receipt includes caller_agent_id (null when unknown). Workers with collab_path cannot address their own parent or ancestor leads in any mode; append to that collab file instead. Unknown callers remain allowed. Lead-originated and engine-internal pushes remain allowed. Targets may be one agent, structured agent targeting, or a raw surface in surface/command/key mode. A clean verified success returns up to six mode-specific core fields by default: text/command mode returns ok, retry_count, target identity, delivery_state, submitted, and delivery_id when available; key mode returns ok, retry_count, surface, key, submit_verified, and submit_verification_reason. A degraded transport, queued-behind-turn landing, or deduplicated send adds its warning or status field. Pass verbose=true for the full legacy receipt; non-success keeps full diagnostics automatically.",
    {
      ...SendToArgsSchema.shape,
      text: SendToArgsSchema.shape.text.describe(
        `${PANE_INPUT_BREAKAGE_GUIDANCE} Text to send. Capped at ${SEND_INPUT_MAX_INLINE_CHARS} inline UTF-8 bytes by default.`,
      ),
      press_enter: SendToArgsSchema.shape.press_enter.describe(
        "Press enter after sending text",
      ),
      allow_busy: SendToArgsSchema.shape.allow_busy.describe(
        "Deprecated no-op. Safety gates still refuse text at a picker/menu or permission prompt; use mode=key to drive those deliberately.",
      ),
      allow_long_inline: SendToArgsSchema.shape.allow_long_inline.describe(
        "Bypass the inline length and multi-paragraph safety guards for a deliberate raw send. Large allowed sends keep the existing chunked delivery behavior.",
      ),
    },
    ANNOTATIONS.mutating,
    async (rawArgs) => {
      let failedReceiptPayload: Record<string, unknown> = {};
      try {
        // #611: an omitted mode is no longer an error -- the schema now
        // defaults it to "agent". Only an explicitly invalid value fails, and
        // that goes through the enum errorMap, which already carries a
        // copy-pasteable example.
        if ("message" in rawArgs || "command" in rawArgs || "key" in rawArgs) {
          throw new Error(
            "send_to accepts one payload parameter: text. " +
              SEND_TO_WORKING_EXAMPLE,
          );
        }
        for (const field of ["surface", "target"] as const) {
          if (typeof rawArgs[field] === "number") {
            throw new Error(
              `bare surface index ${JSON.stringify(rawArgs[field])} is not allowed; use surface:<index> ref or a surface UUID`,
            );
          }
        }
        const parsedArgs = SendToArgsSchema.safeParse(rawArgs);
        if (!parsedArgs.success) {
          return err(
            new Error(formatToolValidationError("send_to", parsedArgs.error)),
          );
        }

        const args = parsedArgs.data;
        const mode = args.mode;
        if (!mode) {
          // Defensive only: the schema default makes this unreachable. If it
          // ever fires, say what to do rather than what went wrong (#611).
          throw new Error(
            `mode required (agent|surface|command|key). ${SEND_TO_WORKING_EXAMPLE}`,
          );
        }
        if (args.targeting && mode !== "agent") {
          throw new Error(
            "send_to.targeting is supported only in mode=agent",
          );
        }
        if (mode !== "agent") {
          const surface = args.surface ?? args.target;
          if (!surface) {
            throw new Error(
              `send_to mode=${mode} requires target or surface`,
            );
          }
          assertCanonicalSurfaceRef(surface);
          assertWorkerUpwardChannel(surface);
          const legacyHandler = (name: string) => {
            const handler = toolHandlersByName.get(name);
            if (!handler) {
              throw new Error(`Internal tool handler unavailable: ${name}`);
            }
            return handler;
          };
          if (mode === "surface") {
            if (args.text === undefined) {
              throw new Error("send_to mode=surface requires text");
            }
            const deliveryId = randomUUID();
            const timings = createDeliveryPhaseTimings();
            return withSurfaceDeliveryTimings(
              await legacyHandler("send_input")(
                {
                  surface,
                  workspace: args.workspace,
                  text: args.text,
                  chunk_size: args.chunk_size,
                  background: args.background,
                  press_enter: args.press_enter,
                  rename_to_task: args.rename_to_task,
                  allow_long_inline: args.allow_long_inline,
                  _cmuxlayer_source_event: "send_to",
                  _cmuxlayer_delivery_id: deliveryId,
                  _cmuxlayer_timings: timings,
                },
                {},
              ),
              timings,
            );
          }
          if (mode === "command") {
            const command = args.text;
            if (command === undefined) {
              throw new Error("send_to mode=command requires text");
            }
            return legacyHandler("send_command")(
              {
                surface,
                workspace: args.workspace,
                command,
                boot_prompt_path: args.boot_prompt_path,
                boot_prompt_timeout_ms: args.boot_prompt_timeout_ms,
                allow_long_inline: args.allow_long_inline,
              },
              {},
            );
          }
          if (!args.text) {
            throw new Error("send_to mode=key requires text");
          }
          return legacyHandler("send_key")(
            { surface, workspace: args.workspace, key: args.text },
            {},
          );
        }

        if (args.targeting && (args.agent_id || args.target)) {
          throw new Error(
            "send_to accepts either targeting or agent_id/target, not both",
          );
        }
        if (!args.targeting && !args.agent_id && !args.target) {
          throw new Error(
            "send_to mode=agent requires agent_id/target or targeting",
          );
        }
        if (args.text === undefined) {
          throw new Error("send_to mode=agent requires text");
        }
        args.text = sanitizeTerminalInput(args.text);
        assertInlineInputAllowed({
          tool: "send_to",
          arg: "text",
          value: args.text,
          allowLongInline: args.allow_long_inline,
        });
        assertDenseInlineInputAllowed({
          tool: "send_to",
          arg: "text",
          value: args.text,
          allowLongInline: args.allow_long_inline,
        });
        if (args.targeting) {
          await awaitLifecycleStart();
          const allTargets = await collectTargetRecords();
          const excludedIds = new Set(args.targeting.exclude);
          const scopedWorkspace = await canonicalWorkspaceRef(
            args.targeting.workspace,
          );
          type TargetPlan = {
            requested_agent_id?: string;
            agent?: Readonly<AgentRecord>;
            resolution: "resolved" | "filtered_out" | "unknown";
            predicate?: "exclude" | "role" | "workspace";
          };
          const filterPredicate = (
            agent: AgentRecord,
          ): TargetPlan["predicate"] | null => {
            if (excludedIds.has(agent.agent_id)) return "exclude";
            if (
              args.targeting?.role &&
              agent.function !== args.targeting.role
            ) {
              return "role";
            }
            if (
              scopedWorkspace &&
              agent.workspace_id !== scopedWorkspace &&
              agent.workspace_id !== args.targeting?.workspace
            ) {
              return "workspace";
            }
            return null;
          };
          const targetPlan: TargetPlan[] = [];
          if (args.targeting.agent_ids) {
            for (const requestedId of args.targeting.agent_ids) {
              const exact = allTargets.find(
                (agent) => agent.agent_id === requestedId,
              );
              const candidates = exact
                ? [exact]
                : allTargets.filter((agent) =>
                    agent.agent_id.startsWith(requestedId),
                  );
              if (candidates.length > 1) {
                throw new Error(
                  `Ambiguous agent_id prefix "${requestedId}"; candidates: ${candidates
                      .map((agent) => agent.agent_id)
                      .sort()
                      .join(", ")}. Refusing to guess.`,
                );
              }
              const agent = candidates[0];
              if (!agent) {
                targetPlan.push({
                  requested_agent_id: requestedId,
                  resolution: "unknown",
                });
                continue;
              }
              const predicate = filterPredicate(agent);
              targetPlan.push({
                requested_agent_id: requestedId,
                agent: Object.freeze({ ...agent }),
                resolution: predicate ? "filtered_out" : "resolved",
                ...(predicate ? { predicate } : {}),
              });
            }
          } else {
            for (const agent of allTargets) {
              if (filterPredicate(agent)) continue;
              targetPlan.push({
                agent: Object.freeze({ ...agent }),
                resolution: "resolved",
              });
            }
          }
          const resolvedTargets = Object.freeze(
            targetPlan
              .filter(
                (
                  entry,
                ): entry is TargetPlan & { agent: Readonly<AgentRecord> } =>
                  entry.resolution === "resolved" &&
                  entry.agent !== undefined,
              )
              .map((entry) => entry.agent),
          );
          for (const agent of resolvedTargets) {
            assertWorkerUpwardChannel(agent.agent_id);
            assertInteractiveMultilineInputAllowed({
              tool: "send_to",
              value: args.text,
              cli: agent.cli,
              allowLongInline: args.allow_long_inline,
            });
          }
          const mutableReceipts: Array<Record<string, unknown>> = [];
          for (const plan of targetPlan) {
            if (plan.resolution !== "resolved" || !plan.agent) {
              mutableReceipts.push({
                ...(plan.requested_agent_id
                  ? { requested_agent_id: plan.requested_agent_id }
                  : {}),
                ...(plan.agent ? { agent_id: plan.agent.agent_id } : {}),
                resolution: plan.resolution,
                ...(plan.predicate ? { predicate: plan.predicate } : {}),
                ...buildPublicDeliveryReceipt({
                  typed: false,
                  submit_attempted: false,
                  submit_verified: null,
                  retry_count: 0,
                }),
                accepted: false,
                skipped:
                  plan.resolution === "unknown"
                    ? "unknown_agent_id"
                    : `filtered_out:${plan.predicate}`,
              });
              continue;
            }
            const agent = plan.agent;
            const resolutionMetadata = plan.requested_agent_id
              ? {
                  requested_agent_id: plan.requested_agent_id,
                  resolution: "resolved",
                }
              : {};
            const skipped =
              agent.state === "working"
                ? null
                : await broadcastSkipReason(agent);
            if (skipped) {
              mutableReceipts.push({
                ...resolutionMetadata,
                agent_id: agent.agent_id,
                ...buildPublicDeliveryReceipt({
                  typed: false,
                  submit_attempted: false,
                  submit_verified: null,
                  retry_count: 0,
                }),
                accepted: false,
                skipped,
              });
              continue;
            }
            const duplicate = engine.findOpenDuplicate({
              agent_id: agent.agent_id,
              text: args.text,
              press_enter: args.press_enter,
            });
            if (duplicate) {
              mutableReceipts.push({
                ...resolutionMetadata,
                agent_id: agent.agent_id,
                duplicate_of: duplicate.delivery_id,
                ...buildPublicDeliveryReceipt({
                  delivery_state: duplicate.delivery_state,
                  delivery_id: duplicate.delivery_id,
                  typed: duplicate.typed === true,
                  submit_attempted: duplicate.press_enter,
                  submit_dispatched: duplicate.submit_dispatched,
                  submit_verified: duplicate.submit_verified,
                  retry_count: duplicate.retry_count,
                  rpc_methods: duplicate.rpc_methods ?? [],
                  needs_attention: duplicate.needs_attention,
                  attention_reason: duplicate.attention_reason,
                }),
                accepted: true,
              });
              continue;
            }
            const deliveryId = randomUUID();
            engine.acceptPendingVerify({
              delivery_id: deliveryId,
              agent_id: agent.agent_id,
              text: args.text,
              press_enter: args.press_enter,
              source_event: "send_to",
              retry_count: 0,
            });
            const livePaused = await observePausedTarget(agent);
            if (livePaused.paused) {
              const queued = engine.queueDelivery({
                delivery_id: deliveryId,
                agent_id: agent.agent_id,
                text: args.text,
                press_enter: args.press_enter,
                source_event: "send_to",
              });
              mutableReceipts.push({
                ...resolutionMetadata,
                agent_id: agent.agent_id,
                ...buildPublicDeliveryReceipt({
                  delivery_state: "queued",
                  delivery_id: queued.delivery_id,
                  typed: false,
                  submit_attempted: false,
                  submit_verified: queued.submit_verified,
                  retry_count: queued.retry_count,
                  WARNING: pausedTargetWarning(livePaused.source),
                }),
                accepted: true,
              });
              continue;
            }
            try {
              const delivery = await deliverAgentInput({
                agent_id: agent.agent_id,
                text: args.text,
                press_enter: args.press_enter,
                allow_busy: args.allow_busy,
                source_event: "send_to",
                delivery_id: deliveryId,
              });
              const accepted =
                delivery.delivery === "queued" ||
                delivery.delivery === "queued_followup"
                  ? engine.acceptComposerQueue({
                      delivery_id: deliveryId,
                      agent_id: agent.agent_id,
                      text: args.text,
                      press_enter: args.press_enter,
                      source_event: "send_to",
                      retry_count: delivery.retry_count,
                      rpc_methods: delivery.rpc_methods,
                      typed: delivery.typed,
                      submit_dispatched: delivery.submit_dispatched,
                      delivery_state: delivery.delivery,
                    })
                  : delivery.delivery === "pending_verify"
                    ? engine.acceptPendingVerify({
                        delivery_id: deliveryId,
                        agent_id: agent.agent_id,
                        text: args.text,
                        press_enter: args.press_enter,
                        source_event: "send_to",
                        retry_count: delivery.retry_count,
                        rpc_methods: delivery.rpc_methods,
                        typed: delivery.typed,
                        submit_dispatched: delivery.submit_dispatched,
                      })
                    : delivery.delivery === "rescued"
                      ? engine.resolveDelivery({
                          delivery_id: deliveryId,
                          agent_id: agent.agent_id,
                          text: args.text,
                          press_enter: args.press_enter,
                          source_event: "send_to",
                          delivery_state: "rescued",
                          terminal: true,
                          retry_count: delivery.retry_count,
                          rpc_methods: delivery.rpc_methods,
                          typed: delivery.typed,
                          submit_dispatched: delivery.submit_dispatched,
                          submit_verified: false,
                          error:
                            "Prompt appeared only after an external interrupt",
                        })
                      : delivery.delivery === "submitted"
                        ? engine.resolveDelivery({
                            delivery_id: deliveryId,
                            agent_id: agent.agent_id,
                            text: args.text,
                            press_enter: args.press_enter,
                            source_event: "send_to",
                            delivery_state: "submitted",
                            terminal: true,
                            retry_count: delivery.retry_count,
                            rpc_methods: delivery.rpc_methods,
                            typed: delivery.typed,
                            submit_dispatched: delivery.submit_dispatched,
                            submit_verified: delivery.submit_verified,
                            error: null,
                          })
                        : null;
              mutableReceipts.push({
                ...resolutionMetadata,
                agent_id: agent.agent_id,
                ...buildPublicDeliveryReceipt({
                  delivery_state: accepted?.delivery_state,
                  delivery_id: accepted?.delivery_id ?? deliveryId,
                  typed: delivery.typed,
                  submit_attempted: delivery.submit_attempted,
                  submit_verified: delivery.submit_verified,
                  submit_evidence: delivery.submit_evidence,
                  retry_count: delivery.retry_count,
                  rpc_methods: delivery.rpc_methods,
                  submit_dispatched: delivery.submit_dispatched,
                  queued_behind_turn: delivery.queued_behind_turn,
                }),
                accepted: true,
              });
            } catch (error) {
              if (error instanceof AmbiguousBootRecoveryReturnError && error.receipt) {
                mutableReceipts.push({
                  ...resolutionMetadata,
                  agent_id: agent.agent_id,
                  ...error.receipt,
                  accepted: false,
                  error: error.message,
                });
                continue;
              }
              const errorRpcMethods = deliveryRpcMethodsFromError(error);
              const errorTyped = deliveryTypedFromError(error);
              const errorSubmitDispatched =
                deliverySubmitDispatchedFromError(error);
              if (
                error instanceof RetryableDeliveryError &&
                errorRpcMethods.length === 0 &&
                !errorTyped &&
                !errorSubmitDispatched
              ) {
                const queued = engine.queueDelivery({
                  delivery_id: deliveryId,
                  agent_id: agent.agent_id,
                  text: args.text,
                  press_enter: args.press_enter,
                  source_event: "send_to",
                });
                mutableReceipts.push({
                  ...resolutionMetadata,
                  agent_id: agent.agent_id,
                  ...buildPublicDeliveryReceipt({
                    delivery_state: "queued",
                    delivery_id: queued.delivery_id,
                    typed: false,
                    submit_attempted: false,
                    submit_verified: queued.submit_verified,
                    retry_count: queued.retry_count,
                    WARNING: `Delivery is queued for retry, not delivered yet: ${error.message}`,
                  }),
                  accepted: true,
                });
                continue;
              }
              const failed = engine.resolveDelivery(
                {
                  delivery_id: deliveryId,
                  agent_id: agent.agent_id,
                  text: args.text,
                  press_enter: args.press_enter,
                  source_event: "send_to",
                  delivery_state: "failed",
                  terminal: true,
                  retry_count:
                    error instanceof SubmitVerificationError
                      ? error.retry_count
                      : 0,
                  rpc_methods: errorRpcMethods,
                  typed: errorTyped,
                  submit_dispatched: errorSubmitDispatched,
                  submit_verified:
                    error instanceof SubmitVerificationError ? false : null,
                  error:
                    error instanceof Error ? error.message : String(error),
                },
                {
                  appendFailureEvent: !(
                    error instanceof SubmitVerificationError
                  ),
                },
              );
              mutableReceipts.push({
                ...resolutionMetadata,
                agent_id: agent.agent_id,
                ...buildPublicDeliveryReceipt({
                  delivery_state: "failed",
                  delivery_id: failed.delivery_id,
                  typed:
                    error instanceof SubmitVerificationError
                      ? (error.receipt?.typed ?? true)
                      : errorTyped,
                  submit_attempted:
                    error instanceof SubmitVerificationError
                      ? (error.receipt?.submit_attempted ?? args.press_enter)
                      : args.press_enter,
                  submit_dispatched: errorSubmitDispatched,
                  submit_verified: failed.submit_verified,
                  retry_count: failed.retry_count,
                  rpc_methods: errorRpcMethods,
                }),
                accepted: false,
                error: failed.error,
              });
            }
          }
          const receipts = Object.freeze(
            mutableReceipts.map((receipt) => Object.freeze({ ...receipt })),
          );
          const submittedCount = receipts.filter(
            (receipt) => receipt.delivery_state === "submitted",
          ).length;
          const queuedCount = receipts.filter(
            (receipt) => receipt.delivery_state === "queued",
          ).length;
          const pendingVerifyCount = receipts.filter(
            (receipt) => receipt.delivery_state === "pending_verify",
          ).length;
          const failedCount = receipts.filter(
            (receipt) =>
              receipt.delivery_state === "failed" ||
              receipt.delivery_state === "rescued",
          ).length;
          const skippedCount = receipts.filter(
            (receipt) => receipt.skipped !== undefined,
          ).length;
          const data = {
            targeting: Object.freeze({ ...args.targeting }),
            target_count: receipts.length,
            resolved_target_count: resolvedTargets.length,
            submitted_count: submittedCount,
            queued_count: queuedCount,
            pending_verify_count: pendingVerifyCount,
            delivered_count: submittedCount,
            failed_count: failedCount,
            skipped_count: skippedCount,
            receipts,
          };
          if (resolvedTargets.length === 0) {
            return err(
              new Error(
                "send_to targeting resolved zero targets; refusing silent no-op",
              ),
              data,
            );
          }
          return okFormatted(
            `send_to targeting: ${submittedCount} submitted, ${queuedCount} queued${pendingVerifyCount ? `, ${pendingVerifyCount} pending verify` : ""}, ${failedCount} failed, ${skippedCount} skipped`,
            data,
          );
        }

        const agentId = args.agent_id ?? args.target;
        if (!agentId) {
          throw new Error("send_to mode=agent requires agent_id or target");
        }
        assertWorkerUpwardChannel(agentId);
        const timings = createDeliveryPhaseTimings();
        const targetAgent =
          engine.getAgentState(agentId) ?? registry.get(agentId);
        assertInteractiveMultilineInputAllowed({
          tool: "send_to",
          value: args.text,
          cli: targetAgent?.cli,
          allowLongInline: args.allow_long_inline,
        });
        const duplicate = engine.findOpenDuplicate({
          agent_id: agentId,
          text: args.text,
          press_enter: args.press_enter,
        });
        if (duplicate) {
          const data = {
            accepted: true,
            agent_id: agentId,
            duplicate_of: duplicate.delivery_id,
            ...buildPublicDeliveryReceipt({
              delivery_state: duplicate.delivery_state,
              delivery_id: duplicate.delivery_id,
              typed: duplicate.typed === true,
              submit_attempted: duplicate.press_enter,
              submit_dispatched: duplicate.submit_dispatched,
              submit_verified: duplicate.submit_verified,
              retry_count: duplicate.retry_count,
              rpc_methods: duplicate.rpc_methods ?? [],
              needs_attention: duplicate.needs_attention,
              attention_reason: duplicate.attention_reason,
              timings_ms: timings,
            }),
          };
          return okFormatted(
            `send_to duplicate_of ${duplicate.delivery_id}`,
            data,
          );
        }
        const deliveryId = randomUUID();
        engine.acceptPendingVerify({
          delivery_id: deliveryId,
          agent_id: agentId,
          text: args.text,
          press_enter: args.press_enter,
          source_event: "send_to",
          retry_count: 0,
        });
        const livePaused = await observePausedTarget(targetAgent);
        if (livePaused.paused) {
          const receipt = engine.queueDelivery({
            delivery_id: deliveryId,
            agent_id: agentId,
            text: args.text,
            press_enter: args.press_enter,
            source_event: "send_to",
          });
          const data = {
            accepted: true,
            agent_id: agentId,
            ...buildPublicDeliveryReceipt({
              delivery_state: "queued",
              delivery_id: receipt.delivery_id,
              typed: false,
              submit_attempted: false,
              submit_verified: receipt.submit_verified,
              retry_count: receipt.retry_count,
              timings_ms: timings,
              WARNING: pausedTargetWarning(livePaused.source),
            }),
          };
          return okFormatted(
            `WARNING — send_to queued; paused target ${agentId} cannot act`,
            data,
          );
        }
        let delivery: Awaited<ReturnType<typeof deliverAgentInput>>;
        // Observe the daemon scheduler during this send, not the benchmark
        // runner's event loop. The histogram reports nanoseconds.
        const eventLoopDelay = monitorEventLoopDelay({ resolution: 1 });
        eventLoopDelay.enable();
        let eventLoopDelayStopped = false;
        const finishEventLoopDelay = () => {
          if (eventLoopDelayStopped) return;
          eventLoopDelayStopped = true;
          eventLoopDelay.disable();
          timings.event_loop_delay_max = Number.isFinite(eventLoopDelay.max)
            ? eventLoopDelay.max / 1_000_000 : 0;
          timings.event_loop_delay_mean = Number.isFinite(eventLoopDelay.mean)
            ? eventLoopDelay.mean / 1_000_000 : 0;
        };
        try {
          delivery = await deliverAgentInput({
            agent_id: agentId,
            text: args.text,
            press_enter: args.press_enter,
            allow_busy: args.allow_busy,
            source_event: "send_to",
            delivery_id: deliveryId,
            timings,
          });
        } catch (error) {
          // Failure receipts copy timings in this branch, before `finally`.
          finishEventLoopDelay();
          if (error instanceof AmbiguousBootRecoveryReturnError) {
            return err(error, { agent_id: agentId });
          }
          // AIDEV-NOTE (F1): a RetryableDeliveryError is, by name and by the
          // drain loop's own handling, NOT a terminal outcome -- the engine
          // backs it off and tries again. Flattening it into a terminal
          // `failed` receipt here would contradict the delivery engine's
          // retryable queue semantics and tell a lead its live worker was
          // dead. Hand back the queued receipt the drain loop will honour.
          const errorRpcMethods = deliveryRpcMethodsFromError(error);
          const errorTyped = deliveryTypedFromError(error);
          const errorSubmitDispatched =
            deliverySubmitDispatchedFromError(error);
          if (
            error instanceof RetryableDeliveryError &&
            errorRpcMethods.length === 0 &&
            !errorTyped &&
            !errorSubmitDispatched
          ) {
            const receipt = engine.queueDelivery({
              delivery_id: deliveryId,
              agent_id: agentId,
              text: args.text,
              press_enter: args.press_enter,
              source_event: "send_to",
            });
            const data = {
              accepted: true,
              agent_id: agentId,
              ...buildPublicDeliveryReceipt({
                delivery_state: "queued",
                delivery_id: receipt.delivery_id,
                typed: false,
                submit_attempted: false,
                submit_verified: receipt.submit_verified,
                retry_count: receipt.retry_count,
                timings_ms: timings,
                WARNING: `Delivery is queued for retry, not delivered yet: ${error.message}`,
              }),
            };
            return okFormatted(
              `send_to accepted — delivery ${receipt.delivery_id} queued for retry`,
              data,
            );
          }
          const failedReceipt = engine.resolveDelivery(
            {
              delivery_id: deliveryId,
              agent_id: agentId,
              text: args.text,
              press_enter: args.press_enter,
              source_event: "send_to",
              delivery_state: "failed",
              terminal: true,
              retry_count:
                error instanceof SubmitVerificationError
                  ? error.retry_count
                  : 0,
              rpc_methods: errorRpcMethods,
              typed: errorTyped,
              submit_dispatched: errorSubmitDispatched,
              submit_verified:
                error instanceof SubmitVerificationError ? false : null,
              error: error instanceof Error ? error.message : String(error),
            },
            {
              // Submission-verification failures already emitted the source
              // event immediately before throwing. Earlier failures did not.
              appendFailureEvent: !(error instanceof SubmitVerificationError),
            },
          );
          failedReceiptPayload = {
            ...buildPublicDeliveryReceipt({
              delivery_state: "failed",
              delivery_id: failedReceipt.delivery_id,
              typed:
                error instanceof SubmitVerificationError
                  ? (error.receipt?.typed ?? true)
                  : errorTyped,
              submit_attempted:
                error instanceof SubmitVerificationError
                  ? (error.receipt?.submit_attempted ?? args.press_enter)
                  : args.press_enter || errorSubmitDispatched,
              submit_dispatched: errorSubmitDispatched,
              submit_verified: failedReceipt.submit_verified,
              retry_count: failedReceipt.retry_count,
              rpc_methods: errorRpcMethods,
              timings_ms: timings,
            }),
            retry_safe:
              errorRpcMethods.length === 0 &&
              !errorTyped &&
              !errorSubmitDispatched,
          };
          throw error;
        } finally {
          finishEventLoopDelay();
        }
        const receipt =
          delivery.delivery === "queued" ||
          delivery.delivery === "queued_followup"
            ? engine.acceptComposerQueue({
                delivery_id: deliveryId,
                agent_id: agentId,
                text: args.text,
                press_enter: args.press_enter,
                source_event: "send_to",
                retry_count: delivery.retry_count,
                rpc_methods: delivery.rpc_methods,
                typed: delivery.typed,
                submit_dispatched: delivery.submit_dispatched,
                delivery_state: delivery.delivery,
              })
            : delivery.delivery === "pending_verify"
              ? engine.acceptPendingVerify({
                  delivery_id: deliveryId,
                  agent_id: agentId,
                  text: args.text,
                  press_enter: args.press_enter,
                  source_event: "send_to",
                  retry_count: delivery.retry_count,
                  rpc_methods: delivery.rpc_methods,
                  typed: delivery.typed,
                  submit_dispatched: delivery.submit_dispatched,
                })
              : delivery.delivery === "rescued"
                ? engine.resolveDelivery({
                    delivery_id: deliveryId,
                    agent_id: agentId,
                    text: args.text,
                    press_enter: args.press_enter,
                    source_event: "send_to",
                    delivery_state: "rescued",
                    terminal: true,
                    retry_count: delivery.retry_count,
                    rpc_methods: delivery.rpc_methods,
                    typed: delivery.typed,
                    submit_dispatched: delivery.submit_dispatched,
                    submit_verified: false,
                    error: "Prompt appeared only after an external interrupt",
                  })
                : delivery.delivery === "typed"
                  ? engine.resolveDelivery({
                      delivery_id: deliveryId,
                      agent_id: agentId,
                      text: args.text,
                      press_enter: args.press_enter,
                      source_event: "send_to",
                      delivery_state: "typed",
                      terminal: true,
                      retry_count: delivery.retry_count,
                      rpc_methods: delivery.rpc_methods,
                      typed: delivery.typed,
                      submit_dispatched: delivery.submit_dispatched,
                      submit_verified: null,
                      error: null,
                    })
                  : delivery.delivery === "submitted"
                    ? engine.resolveDelivery({
                        delivery_id: deliveryId,
                        agent_id: agentId,
                        text: args.text,
                        press_enter: args.press_enter,
                        source_event: "send_to",
                        delivery_state: "submitted",
                        terminal: true,
                        retry_count: delivery.retry_count,
                        rpc_methods: delivery.rpc_methods,
                        typed: delivery.typed,
                        submit_dispatched: delivery.submit_dispatched,
                        submit_verified: delivery.submit_verified,
                        error: null,
                      })
                    : null;
        // Preserve the already-terminal receipt if optional evidence
        // collection fails after the pane mutation has succeeded.
        const publicReceipt = buildPublicDeliveryReceipt({
          delivery_state: receipt?.delivery_state,
          delivery_id: receipt?.delivery_id ?? deliveryId,
          typed: delivery.typed,
          submit_attempted: delivery.submit_attempted,
          submit_verified: delivery.submit_verified,
          submit_evidence: delivery.submit_evidence,
          retry_count: delivery.retry_count,
          rpc_methods: delivery.rpc_methods,
          submit_dispatched: delivery.submit_dispatched,
          queued_behind_turn: delivery.queued_behind_turn,
          timings_ms: timings,
        });
        failedReceiptPayload = { ...publicReceipt };
        const evidence = await collectDeliveryEvidence(agentId);
        const data = {
          agent_id: agentId,
          ...publicReceipt,
          ...evidence,
        };
        return okFormatted(formatOk("send_to", data), data);
      } catch (e) {
        if (e instanceof DeliverySafetyGateError) {
          return err(e, {
            ...e.receipt,
            ...failedReceiptPayload,
            error_code: e.error_code,
            submit_verified: e.submit_verified,
            screen: e.screen,
          });
        }
        if (e instanceof SubmitVerificationError) {
          return err(e, {
            ...failedReceiptPayload,
            ...submitVerificationFailurePayload(e),
          });
        }
        return err(e, failedReceiptPayload);
      }
    },
  );
}
