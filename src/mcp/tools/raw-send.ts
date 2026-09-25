// send_input, send_command and send_key: formerly internally dispatched MCP
// registrations, now plain functions called directly by send_to's surface,
// command and key modes (CX-3 S7). Bodies are verbatim; captured closure
// state arrives as RawSendDeps.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CliType, DeliveryEventType } from "../../agent-types.js";
import { currentCallerContext } from "../../caller-context.js";
import type { DeliveryEngine } from "../../delivery/engine.js";
import { PANE_INPUT_BREAKAGE_GUIDANCE, SEND_INPUT_CHUNK_DELAY_MS, SEND_INPUT_CHUNK_THRESHOLD, SEND_INPUT_MAX_INLINE_CHARS, SEND_INPUT_PASTE_BATCH_MAX_BYTES, assertDenseInlineInputAllowed, assertInlineInputAllowed, assertInteractiveMultilineInputAllowed, chunkTerminalInput, getBootPromptPath, limitInputChunksByUtf8ByteSize } from "../../delivery/input-policy.js";
import { BootComposerResidueError, BootPromptDeliveryError, BootPromptTimeoutError, BootPromptUpdateMenuBlockedError, DeliveryError, type DeliveryPhaseTimings, type DeliveryRecord, DeliverySafetyGateError, SubmitVerificationError, SurfaceGoneError, buildPublicDeliveryReceipt, timeDeliveryPhase } from "../../delivery/receipts.js";
import { resolveLatestSurfaceAgentRecord } from "../../delivery/surface-state.js";
import { formatDelivery, formatOk } from "../../format.js";
import { normalizeKeyName } from "../../key-names.js";
import { INTERACTIVE_AGENT_STATES } from "../../live-agent-state.js";
import { sanitizeTerminalInput } from "../../sanitize.js";
import { StateManager } from "../../state-manager.js";
import type { CmuxServerContext } from "../context.js";
import { BOOT_PROMPT_TIMEOUT_MS } from "../schemas.js";
import type { RawSurfaceMutationRoute } from "../shared-types.js";
import { preflightBootPromptFile } from "../tool-input.js";
import { type ToolReturn, err, okFormatted, surfaceGonePayload } from "../tool-result.js";

/** createServer's closure state the raw surface-send functions use. */
export interface RawSendDeps {
  assertSurfaceMutationAllowed: (toolName: string, surface: string, workspace?: string) => Promise<void>;
  context: CmuxServerContext;
  deliverBootPrompt: DeliveryEngine["deliverBootPrompt"];
  executeDeliveryEngine: DeliveryEngine["executeDeliveryEngine"];
  isBootPromptDelivered: DeliveryEngine["isBootPromptDelivered"];
  remapFields: (route: RawSurfaceMutationRoute) => Pick<RawSurfaceMutationRoute, "remapped_from" | "remapped_to">;
  resolveRawSurfaceMutationRoute: (requestedSurface: string, requestedWorkspace: string | undefined, operation: string, trustedAgentScopedClose?: boolean) => Promise<RawSurfaceMutationRoute>;
  sendLauncherCommandToSurface: DeliveryEngine["sendLauncherCommandToSurface"];
  shouldVerifyRawSurfaceSubmit: DeliveryEngine["shouldVerifyRawSurfaceSubmit"];
  startBackgroundDelivery: DeliveryEngine["startBackgroundDelivery"];
  stateMgr: StateManager;
  withSurfaceWrite: DeliveryEngine["withSurfaceWrite"];
}

function inferLauncherCli(command: string): CliType | null {
  if (!/(^|\s)-s(?:\s|$)/.test(command)) {
    return null;
  }

  const match = command.match(
    /(?:^|\s)[A-Za-z0-9_.-]+(Claude|Codex|Cursor|Gemini|Kiro)\b/,
  );
  if (!match) {
    return null;
  }

  return match[1].toLowerCase() as CliType;
}

export interface TargetIdentity {
  surface: string;
  title?: string;
  model?: string;
  agent_type?: string;
}

// Best-effort target-agent identity for delivery responses (send_input /
// send_command). `title` is the live cmux tab/surface title when known — never
// the boot prompt / task_summary. Model/cli come from the in-memory registry.
function resolveTargetIdentity(
  stateMgr: StateManager,
  surfaceRef: string,
  surfaceTitle?: string | null,
  stableSurfaceIdentity?: string | null,
): TargetIdentity {
  const identity: TargetIdentity = { surface: surfaceRef };
  const title = surfaceTitle?.trim();
  if (title) identity.title = title;
  const record = resolveLatestSurfaceAgentRecord(
    stateMgr,
    surfaceRef,
    stableSurfaceIdentity,
  );
  if (record?.model) identity.model = record.model;
  if (record?.cli) identity.agent_type = record.cli;
  return identity;
}

// send_input: formerly an internally dispatched MCP registration. Its callers
// call it directly now; like the old by-name dispatch, the arguments are not
// re-parsed, so the shape below is the args type only.
export const sendInputArgsShape = z.object({
    surface: z.string().describe("Target surface ref"),
    text: z
      .string()
      .describe(
        `${PANE_INPUT_BREAKAGE_GUIDANCE} Text to send. Capped at ${SEND_INPUT_MAX_INLINE_CHARS} inline UTF-8 bytes by default.`,
      ),
    workspace: z.string().optional().describe("Target workspace ref"),
    chunk_size: z
      .number()
      .int()
      .min(1)
      .optional()
      .default(200)
      .describe("Chunk size for automatic long-text delivery"),
    background: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Return immediately with a delivery_id and continue chunked delivery in the background",
      ),
    press_enter: z
      .boolean()
      .optional()
      .default(false)
      .describe("Press return once after all chunks have landed."),
    rename_to_task: z
      .string()
      .optional()
      .describe("Rename tab suffix to this task name"),
    allow_long_inline: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Bypass the inline length and multi-paragraph safety guards for a deliberate raw send. Large allowed sends keep the existing chunked delivery behavior.",
      ),
  });
export type SendInputArgs = z.input<typeof sendInputArgsShape>;

export async function sendInput(
  deps: RawSendDeps,
  input: SendInputArgs,
): Promise<ToolReturn> {
  // Callers pass unparsed input, as the by-name dispatch did; the body was
  // written against the parsed shape, so name that contract here.
  const args = input as z.infer<typeof sendInputArgsShape>;
  const { assertSurfaceMutationAllowed, context, executeDeliveryEngine, remapFields, resolveRawSurfaceMutationRoute, shouldVerifyRawSurfaceSubmit, startBackgroundDelivery, stateMgr, withSurfaceWrite } = deps;
  try {
    const internalArgs = args as typeof args & {
      _cmuxlayer_source_event?: DeliveryEventType;
      _cmuxlayer_delivery_id?: string;
      _cmuxlayer_timings?: DeliveryPhaseTimings;
    };
    const sourceEvent =
      internalArgs._cmuxlayer_source_event ?? "send_input";
    const requestedDeliveryId = internalArgs._cmuxlayer_delivery_id;
    const timings = internalArgs._cmuxlayer_timings;
    assertInlineInputAllowed({
      tool: "send_input",
      arg: "text",
      value: args.text,
      allowLongInline: args.allow_long_inline,
    });
    assertDenseInlineInputAllowed({
      tool: "send_input",
      arg: "text",
      value: args.text,
      allowLongInline: args.allow_long_inline,
    });
    const sanitizedText = sanitizeTerminalInput(args.text);
    const effectiveChunkSize = Math.min(
      args.chunk_size,
      SEND_INPUT_PASTE_BATCH_MAX_BYTES,
    );
    const chunks =
      sanitizedText.length > SEND_INPUT_CHUNK_THRESHOLD
        ? limitInputChunksByUtf8ByteSize(
            chunkTerminalInput(sanitizedText, effectiveChunkSize),
          )
        : [sanitizedText];
    const route = await timeDeliveryPhase(timings, "enumerate", () =>
      resolveRawSurfaceMutationRoute(
        args.surface,
        args.workspace,
        "send_input",
      ),
    );
    const targetRecord = resolveLatestSurfaceAgentRecord(
      stateMgr,
      route.surface,
      route.stableSurfaceIdentity,
    );
    // A public delivery_id is a promise that wait_for can resolve. Raw,
    // unmanaged surfaces have no lifecycle identity for the verifier, so
    // keep their truthful queued receipt ID-free instead of exposing an
    // orphaned handle.
    const deliveryId = targetRecord ? requestedDeliveryId : undefined;
    assertInteractiveMultilineInputAllowed({
      tool: "send_input",
      value: args.text,
      cli: targetRecord?.cli,
      allowLongInline: args.allow_long_inline,
    });
    if (args.background) {
      const shouldVerifySubmit =
        args.press_enter &&
        (await shouldVerifyRawSurfaceSubmit(
          targetRecord,
          route.surface,
          route.workspace,
        ));
      await assertSurfaceMutationAllowed(
        "send_input",
        route.surface,
        route.workspace,
      );
      await route.assertCurrent();
      const record: DeliveryRecord = {
        delivery_id: deliveryId ?? randomUUID(),
        surface: route.surface,
        workspace: route.workspace,
        status: "delivering",
        total_chunks: chunks.length,
        sent_chunks: 0,
        chunk_size: effectiveChunkSize,
        chunk_delay_ms: SEND_INPUT_CHUNK_DELAY_MS,
        chunks,
        press_enter: args.press_enter,
        verify_submit: shouldVerifySubmit,
        submit_verified: null,
        retry_count: 0,
        rpc_methods: [],
        typed: false,
        submit_dispatched: false,
        rename_to_task: args.rename_to_task,
        started_at: new Date().toISOString(),
        stableSurfaceIdentity: route.stableSurfaceIdentity,
        beforeMutation: route.assertCurrent,
      };
      const receiptEngine = context.lifecycleSweepEngine;
      const backgroundLifecycle =
        targetRecord && receiptEngine
          ? {
              engine: receiptEngine,
              agent_id: targetRecord.agent_id,
              text: sanitizedText,
              source_event: sourceEvent,
            }
          : undefined;
      if (backgroundLifecycle) {
        backgroundLifecycle.engine.registerExternalDelivery({
          delivery_id: record.delivery_id,
          agent_id: backgroundLifecycle.agent_id,
          text: sanitizedText,
          press_enter: args.press_enter,
          source_event: sourceEvent,
          rpc_methods: [],
        });
      }
      startBackgroundDelivery(record, backgroundLifecycle);
      const publicBackgroundDeliveryId =
        backgroundLifecycle || sourceEvent !== "send_to"
          ? record.delivery_id
          : undefined;

      const identity = resolveTargetIdentity(
        stateMgr,
        route.surface,
        route.title,
        route.stableSurfaceIdentity,
      );
      const data = {
        ...identity,
        ...buildPublicDeliveryReceipt({
          delivery_state: "queued",
          delivery_id: publicBackgroundDeliveryId,
          typed: false,
          submit_attempted: args.press_enter,
          submit_verified: record.submit_verified,
          retry_count: record.retry_count,
        }),
        status: record.status,
        ...remapFields(route),
      };
      return okFormatted(
        formatDelivery("send_input", {
          ...identity,
          delivered: false,
          pending: true,
        }) +
          (publicBackgroundDeliveryId
            ? ` (background ${record.delivery_id})`
            : " (background started; no wait_for receipt for unmanaged surface)"),
        data,
      );
    }

    const delivery = await withSurfaceWrite(
      route.surface,
      async () => {
        await route.assertCurrent();
        return executeDeliveryEngine({
          surface: route.surface,
          workspace: route.workspace,
          chunks,
          chunk_size: effectiveChunkSize,
          chunk_delay_ms: SEND_INPUT_CHUNK_DELAY_MS,
          press_enter: args.press_enter,
          rename_to_task: args.rename_to_task,
          stableSurfaceIdentity: route.stableSurfaceIdentity,
          source_event: sourceEvent,
          delivery_id: deliveryId,
          verify_submit:
            args.press_enter &&
            !!targetRecord &&
            INTERACTIVE_AGENT_STATES.has(targetRecord.state),
          verify_submit_for_tracked_surface:
            args.press_enter ? targetRecord : undefined,
          beforeMutation: route.assertCurrent,
          timings,
        });
      },
      {
        toolName: "send_input",
        workspace: route.workspace,
        observePtyWrite: true,
        stableSurfaceIdentity: route.stableSurfaceIdentity,
        timings,
      },
    );

    const receiptEngine = context.lifecycleSweepEngine;
    if (
      sourceEvent === "send_to" &&
      deliveryId &&
      targetRecord &&
      receiptEngine
    ) {
      if (
        delivery.delivery === "queued" ||
        delivery.delivery === "queued_followup"
      ) {
        receiptEngine.acceptComposerQueue({
          delivery_id: deliveryId,
          agent_id: targetRecord.agent_id,
          text: sanitizedText,
          press_enter: args.press_enter,
          source_event: "send_to",
          retry_count: delivery.retry_count,
          rpc_methods: delivery.rpc_methods,
          typed: delivery.typed,
          submit_dispatched: delivery.submit_dispatched,
          delivery_state: delivery.delivery,
        });
      } else if (delivery.delivery === "pending_verify") {
        receiptEngine.acceptPendingVerify({
          delivery_id: deliveryId,
          agent_id: targetRecord.agent_id,
          text: sanitizedText,
          press_enter: args.press_enter,
          source_event: "send_to",
          retry_count: delivery.retry_count,
          rpc_methods: delivery.rpc_methods,
          typed: delivery.typed,
          submit_dispatched: delivery.submit_dispatched,
        });
      } else {
        receiptEngine.resolveDelivery({
          delivery_id: deliveryId,
          agent_id: targetRecord.agent_id,
          text: sanitizedText,
          press_enter: args.press_enter,
          source_event: "send_to",
          delivery_state:
            delivery.delivery === "rescued"
              ? "rescued"
              : delivery.delivery === "typed"
                ? "typed"
                : "submitted",
          terminal: true,
          retry_count: delivery.retry_count,
          rpc_methods: delivery.rpc_methods,
          typed: delivery.typed,
          submit_dispatched: delivery.submit_dispatched,
          submit_verified: delivery.submit_verified,
          error:
            delivery.delivery === "rescued"
              ? "Prompt appeared only after an external interrupt"
              : null,
        });
      }
    }

    const identity = resolveTargetIdentity(
      stateMgr,
      route.surface,
      route.title,
      route.stableSurfaceIdentity,
    );
    const data = {
      ...identity,
      ...delivery,
      ...remapFields(route),
    };
    return okFormatted(
      formatDelivery("send_input", {
        ...identity,
        delivered: delivery.delivered,
        pending: delivery.delivery === "queued",
        typed: delivery.typed,
        submit_attempted: delivery.submit_attempted,
        submit_verified: delivery.submit_verified,
      }),
      data,
    );
  } catch (e) {
    if (e instanceof SurfaceGoneError) {
      return err(e, surfaceGonePayload(e));
    }
    if (e instanceof DeliverySafetyGateError) {
      return err(e, {
        error_code: e.error_code,
        submit_verified: e.submit_verified,
        screen: e.screen,
      });
    }
    if (e instanceof SubmitVerificationError) {
      return err(e, {
        ...(e.receipt ?? {}),
        submit_verified: false,
        retry_count: e.retry_count,
      });
    }
    if (e instanceof DeliveryError) {
      return err(e, { failed_chunk: e.failed_chunk ?? null });
    }
    return err(e);
  }
}

// send_command: formerly an internally dispatched MCP registration. Its callers
// call it directly now; like the old by-name dispatch, the arguments are not
// re-parsed, so the shape below is the args type only.
export const sendCommandArgsShape = z.object({
    surface: z.string().describe("Target surface ref"),
    command: z
      .string()
      .describe(
        `${PANE_INPUT_BREAKAGE_GUIDANCE} Command text to send before pressing return. Capped at ${SEND_INPUT_MAX_INLINE_CHARS} inline UTF-8 bytes by default; for agent boot prompts, pass boot_prompt_path.`,
      ),
    workspace: z.string().optional().describe("Target workspace ref"),
    boot_prompt_path: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Optional readable prompt-file path for launcher commands matching <repo>Codex|Claude|Cursor|Gemini|Kiro with -s. Checked before launch; multiline or over-cap files are submitted as one `Read and follow <path>` pointer after readiness.",
      ),
    boot_prompt_timeout_ms: z
      .number()
      .int()
      .positive()
      .optional()
      .default(BOOT_PROMPT_TIMEOUT_MS)
      .describe("Timeout in milliseconds waiting for the agent ready prompt"),
    allow_long_inline: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Bypass the inline command length cap for a deliberate raw send.",
      ),
  });
export type SendCommandArgs = z.input<typeof sendCommandArgsShape>;

export async function sendCommand(
  deps: RawSendDeps,
  input: SendCommandArgs,
): Promise<ToolReturn> {
  // Callers pass unparsed input, as the by-name dispatch did; the body was
  // written against the parsed shape, so name that contract here.
  const args = input as z.infer<typeof sendCommandArgsShape>;
  const { deliverBootPrompt, executeDeliveryEngine, isBootPromptDelivered, remapFields, resolveRawSurfaceMutationRoute, sendLauncherCommandToSurface, stateMgr, withSurfaceWrite } = deps;
  try {
    assertInlineInputAllowed({
      tool: "send_command",
      arg: "command",
      value: args.command,
      allowLongInline: args.allow_long_inline,
    });
    assertDenseInlineInputAllowed({
      tool: "send_command",
      arg: "command",
      value: args.command,
      allowLongInline: args.allow_long_inline,
    });
    const bootPromptPath = getBootPromptPath(args.boot_prompt_path);
    const launcherCli = bootPromptPath
      ? inferLauncherCli(args.command)
      : null;
    if (bootPromptPath && !launcherCli) {
      throw new Error(
        "boot_prompt_path is only supported for agent launcher commands with -s",
      );
    }
    if (bootPromptPath) {
      await preflightBootPromptFile(bootPromptPath);
    }

    const sanitizedCommand = sanitizeTerminalInput(args.command);
    const chunks =
      sanitizedCommand.length > SEND_INPUT_CHUNK_THRESHOLD
        ? chunkTerminalInput(sanitizedCommand, SEND_INPUT_CHUNK_THRESHOLD)
        : [sanitizedCommand];
    const route = await resolveRawSurfaceMutationRoute(
      args.surface,
      args.workspace,
      "send_command",
    );
    const targetRecord = resolveLatestSurfaceAgentRecord(
      stateMgr,
      route.surface,
    );
    // #805: a seat sending to its OWN surface (e.g. `/mcp reconnect x`) is
    // blocked inside this very tool call, so its composer only queues the
    // input until the turn ends: submit evidence cannot appear, and
    // verifying would poll topology to a timeout. Deliver, skip that
    // verification, and say so on the receipt.
    // Match on the stable UUID whenever the route has one; the mutable ref
    // is only the fallback for ref-only connectors (a ref-shaped caller id
    // must not match a UUID-bound route by ref).
    const callerSurface = currentCallerContext()?.surfaceId?.trim().toLowerCase();
    const routeUuid = route.stableSurfaceIdentity?.trim().toLowerCase();
    const selfTarget = Boolean(callerSurface) &&
      (routeUuid
        ? routeUuid === callerSurface
        : route.surface.toLowerCase() === callerSurface);
    const delivery = await withSurfaceWrite(
      route.surface,
      async () => {
        await route.assertCurrent();
        return executeDeliveryEngine({
          surface: route.surface,
          workspace: route.workspace,
          chunks,
          chunk_size: SEND_INPUT_CHUNK_THRESHOLD,
          chunk_delay_ms: SEND_INPUT_CHUNK_DELAY_MS,
          press_enter: true,
          stableSurfaceIdentity: route.stableSurfaceIdentity,
          source_event: "send_command",
          verify_submit:
            !bootPromptPath &&
            !selfTarget &&
            !!targetRecord &&
            INTERACTIVE_AGENT_STATES.has(targetRecord.state),
          verify_submit_for_tracked_surface:
            bootPromptPath || selfTarget ? undefined : targetRecord,
          beforeMutation: route.assertCurrent,
        });
      },
      {
        toolName: "send_command",
        workspace: route.workspace,
        observePtyWrite: true,
        stableSurfaceIdentity: route.stableSurfaceIdentity,
      },
    );

    let bootPromptDelivery:
      Awaited<ReturnType<typeof deliverBootPrompt>> | undefined;
    if (bootPromptPath && launcherCli) {
      bootPromptDelivery = await deliverBootPrompt({
        surface: route.surface,
        stableSurfaceIdentity: route.stableSurfaceIdentity,
        workspace: route.workspace,
        cli: launcherCli,
        boot_prompt_path: bootPromptPath,
        timeout_ms: args.boot_prompt_timeout_ms,
        resolveRoute: async () => {
          await route.assertCurrent();
          return { surface: route.surface, workspace: route.workspace };
        },
        onUpdateShellRelaunch: () =>
          sendLauncherCommandToSurface({
            surface: route.surface,
            stableSurfaceIdentity: route.stableSurfaceIdentity,
            workspace: route.workspace,
            command: sanitizedCommand,
            relaunch: true,
            assertSurfaceBindingCurrent: route.assertCurrent,
          }),
      });
    }

    const identity = resolveTargetIdentity(
      stateMgr,
      route.surface,
      route.title,
      route.stableSurfaceIdentity,
    );
    const data = {
      ...identity,
      command: sanitizedCommand,
      ...delivery,
      ...(selfTarget
        ? {
            self_target: true,
            self_target_note:
              "Typed into the caller's own surface: the caller's turn is blocked in this call, so the command is expected to run when that turn ends; submit is not verifiable from inside it.",
          }
        : {}),
      ...remapFields(route),
      boot_prompt_delivered: isBootPromptDelivered(bootPromptDelivery),
      boot_prompt_receipt: bootPromptDelivery,
      boot_prompt_bytes: bootPromptDelivery?.bytes,
      boot_prompt_submit_verified:
        bootPromptDelivery?.submit_verified ?? null,
      boot_prompt_warning: bootPromptDelivery?.prompt_warning ?? null,
    };
    return okFormatted(
      formatDelivery("send_command", {
        ...identity,
        delivered: delivery.delivered,
        pending: delivery.delivery === "queued",
        typed: delivery.typed,
        submit_attempted: delivery.submit_attempted,
        submit_verified: delivery.submit_verified,
      }),
      data,
    );
  } catch (e) {
    if (e instanceof SurfaceGoneError) {
      return err(e, surfaceGonePayload(e));
    }
    if (e instanceof DeliverySafetyGateError) {
      return err(e, {
        error_code: e.error_code,
        submit_verified: e.submit_verified,
        screen: e.screen,
      });
    }
    if (e instanceof SubmitVerificationError) {
      return err(e, {
        ...(e.receipt ?? {}),
        submit_verified: false,
        retry_count: e.retry_count,
      });
    }
    if (e instanceof BootPromptTimeoutError) {
      return err(e, { last_10_lines: e.last_10_lines });
    }
    if (e instanceof BootPromptUpdateMenuBlockedError) {
      return err(e, {
        error_code: e.error_code,
        last_10_lines: e.last_10_lines,
        recovery: e.recovery,
      });
    }
    if (e instanceof BootComposerResidueError) {
      return err(e, {
        delivered_chars: e.delivered_chars,
        error_code: e.error_code,
        composer_residue: e.composer_residue,
        typed: e.typed,
        submit_dispatched: e.submit_dispatched,
        rpc_methods: e.rpc_methods,
      });
    }
    if (e instanceof BootPromptDeliveryError) {
      return err(e, { delivered_chars: e.delivered_chars });
    }
    if (e instanceof DeliveryError) {
      return err(e, { failed_chunk: e.failed_chunk ?? null });
    }
    return err(e);
  }
}

// send_key: formerly an internally dispatched MCP registration. Its callers
// call it directly now; like the old by-name dispatch, the arguments are not
// re-parsed, so the shape below is the args type only.
export const sendKeyArgsShape = z.object({
    surface: z.string().describe("Target surface ref"),
    key: z
      .string()
      .describe("Key name (e.g. 'return', 'escape', 'tab', 'ctrl-c')"),
    workspace: z.string().optional().describe("Target workspace ref"),
  });
export type SendKeyArgs = z.input<typeof sendKeyArgsShape>;

export async function sendKey(
  deps: RawSendDeps,
  input: SendKeyArgs,
): Promise<ToolReturn> {
  // Callers pass unparsed input, as the by-name dispatch did; the body was
  // written against the parsed shape, so name that contract here.
  const args = input as z.infer<typeof sendKeyArgsShape>;
  const { executeDeliveryEngine, remapFields, resolveRawSurfaceMutationRoute, withSurfaceWrite } = deps;
  try {
    const key = normalizeKeyName(args.key);
    const route = await resolveRawSurfaceMutationRoute(
      args.surface,
      args.workspace,
      "send_key",
    );
    const delivery = await withSurfaceWrite(
      route.surface,
      async () => {
        await route.assertCurrent();
        return executeDeliveryEngine({
          surface: route.surface,
          workspace: route.workspace,
          chunks: [],
          key,
          chunk_size: 0,
          chunk_delay_ms: 0,
          press_enter: false,
          // A submit key is the documented recovery for a typed-but-unsent
          // message. It has to prove it landed rather than assert it.
          verify_submit: true,
          stableSurfaceIdentity: route.stableSurfaceIdentity,
          source_event: "send_key",
          beforeMutation: route.assertCurrent,
        });
      },
      {
        toolName: "send_key",
        workspace: route.workspace,
        observePtyWrite: true,
        stableSurfaceIdentity: route.stableSurfaceIdentity,
      },
    );
    const data = {
      surface: route.surface,
      key,
      ...delivery,
      ...remapFields(route),
    };
    if (delivery.submit_verified === false) {
      return err(
        new Error(
          `send_key ${key} reached ${route.surface} but the submit did not land (${delivery.submit_verification_reason}). The composer still holds its unsent contents — nothing was delivered. Read the surface and resolve the pending input before relaying this as sent.`,
        ),
        data,
      );
    }
    return okFormatted(formatOk("send_key", data), data);
  } catch (e) {
    return err(e);
  }
}
