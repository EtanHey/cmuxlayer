/**
 * MCP tool schemas: annotations, monitor/watch argument schemas, the send_to
 * argument schema, the public tool list and output schemas, and the role and
 * spawn-axis schemas. Moved verbatim from server.ts (CX-2 S2); imports nothing
 * from the server.
 */

import { z } from "zod";
import { REGISTERED_TOOL_NAMES } from "../palette.js";
import { WATCH_AGENT_PREDICATES } from "../watch-spec.js";
import type {
  AgentAuthority,
  AgentFunction,
  AgentPlacement,
  AgentRole,
} from "../agent-types.js";

/** ToolAnnotations for MCP spec compliance */
export const ANNOTATIONS = {
  readOnly: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  } as const,
  mutating: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  } as const,
  destructive: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  } as const,
  idempotentMutating: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  } as const,
};

export const WatchSpecArgsSchema = {
  owner: z.string().min(1).describe("Agent/seat notified by the watch"),
  target: z.string().min(1).describe("Absolute file path or public agent_id"),
  predicate: z
    .enum(WATCH_AGENT_PREDICATES)
    .optional()
    .describe(
      "Agent screen-state predicate: thinking, working, idle, done, error; mutually exclusive with marker and change",
    ),
  marker: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Literal file marker; mutually exclusive with predicate and change",
    ),
  change: z
    .literal("content")
    .optional()
    .describe(
      "Persistent file-content change watch; mutually exclusive with predicate and marker",
    ),
  watermark: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Prior marker count; defaults to count observed at arm time"),
  notify: z
    .boolean()
    .optional()
    .describe("Opt in to the configured external notification transport"),
  deadline: z
    .number()
    .int()
    .positive()
    .describe("Absolute Unix deadline in milliseconds"),
} as const;

export const WatchSpecSchema = z.object(WatchSpecArgsSchema).refine(
  (watch) => {
    const selectors = [watch.predicate, watch.marker, watch.change].filter(
      (value) => value !== undefined,
    );
    return selectors.length === 1;
  },
  {
    message: "WatchSpec requires exactly one of predicate, marker, or change",
  },
);

export const BOOT_PROMPT_TIMEOUT_MS = 60_000;

export const SEND_TO_WORKING_EXAMPLE =
  'Example: send_to({ mode: "agent", agent_id: "cmuxlayerCodex-1234", text: "hello" })';

export const SendToArgsSchema = z.object({
  // AIDEV-NOTE (#611): `.default("agent")`, NOT `.optional()`. This field was
  // declared optional while the runtime threw when it was omitted, so the
  // published contract and the behaviour disagreed and a correct reading of the
  // schema produced a failing call. Agents rediscovered that by trial and error
  // and paid 2-3 turns each time -- one of them said out loud that "the
  // coordination tool rejected its documented default mode". Either the schema
  // tells the truth or it must not claim optionality: agent mode is what
  // essentially every caller means, so it is now a real default that the
  // runtime honours.
  mode: z
    .enum(["agent", "surface", "command", "key"], {
      errorMap: () => ({
        message:
          'Expected one of "agent" | "surface" | "command" | "key". ' +
          SEND_TO_WORKING_EXAMPLE,
      }),
    })
    .default("agent"),
  target: z
    .union([z.string(), z.number().transform((value) => String(value))])
    .optional(),
  agent_id: z.string().optional(),
  surface: z
    .union([z.string(), z.number().transform((value) => String(value))])
    .optional(),
  text: z
    .string()
    .optional()
    .describe(
      'Text for every mode. In mode="key", this is the key name; submit aliases are normalized to "return".',
    ),
  workspace: z.string().optional(),
  chunk_size: z.number().int().min(1).optional().default(200),
  background: z.boolean().optional().default(false),
  rename_to_task: z.string().optional(),
  boot_prompt_path: z.string().nullable().optional(),
  boot_prompt_timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .default(BOOT_PROMPT_TIMEOUT_MS),
  press_enter: z.boolean().optional().default(true),
  allow_busy: z.boolean().optional().default(false),
  allow_long_inline: z.boolean().optional().default(false),
  verbose: z.boolean().optional().default(false).describe("Return the full legacy success receipt, including transport and timing diagnostics. Failures always keep full detail."),
  targeting: z
    .object({
      role: z.enum(["implementor", "reviewer", "gatherer"]).optional(),
      workspace: z.string().optional(),
      agent_ids: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional().default([]),
    })
    .refine(
      (targeting) =>
        targeting.role !== undefined ||
        targeting.workspace !== undefined ||
        targeting.agent_ids !== undefined,
      "targeting requires at least one of role, workspace, or agent_ids",
    )
    .optional(),
});

// One source for the public tool list: the palette owns it (CX-2 S2 dedupe).
export const PUBLIC_TOOL_NAMES = REGISTERED_TOOL_NAMES;

export const PUBLIC_TOOL_NAME_SET = new Set<string>(PUBLIC_TOOL_NAMES);

export const BaseOutputShape = {
  ok: z.boolean(),
  retry_count: z.number().int().nonnegative(),
};

export const DeliveryOutputShape = {
  delivered: z.boolean().optional(),
  delivery: z
    .enum([
      "submitted",
      "typed",
      "queued",
      "queued_followup",
      "rescued",
      "failed",
      "pending_verify",
      "failed_confirmed",
      "stalled_queue",
    ])
    .optional(),
  delivery_state: z
    .enum([
      "submitted",
      "typed",
      "queued",
      "queued_followup",
      "rescued",
      "failed",
      "pending_verify",
      "failed_confirmed",
      "stalled_queue",
    ])
    .optional(),
  terminal: z.boolean().optional(),
  typed: z.boolean().optional(),
  submit_attempted: z.boolean().optional(),
  submit_dispatched: z.boolean().optional(),
  submit_verified: z.boolean().nullable().optional(),
  submit_evidence: z
    .enum(["token_delta", "transcript_echo", "cleared_composer", "status_only"])
    .nullable()
    .optional(),
  rpc_methods: z
    .array(z.enum(["surface.send_text", "surface.send_key"]))
    .optional(),
  delivery_id: z.string().optional(),
  duplicate_of: z.string().optional(),
  needs_attention: z.boolean().optional(),
  attention_reason: z.string().optional(),
};

export const DeliveryReceiptOutputSchema = z
  .object({
    ...DeliveryOutputShape,
    bytes: z.number().int().nonnegative().optional(),
    prompt_bytes: z.number().int().nonnegative().optional(),
    prompt_sha256: z.string().optional(),
    prompt_warning: z.string().nullable().optional(),
  })
  .passthrough();

export const PUBLIC_TOOL_OUTPUT_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> = {
  spawn_agent: z
    .object({
      ...BaseOutputShape,
      version: z.literal(1).optional(),
      type: z.enum(["agent", "terminal"]).optional(),
      agent_id: z.string().optional(),
      parent_agent_id: z.string().nullable().optional(),
      role: z.string().optional(),
      surface_id: z.string().optional(),
      workspace_id: z.string().nullable().optional(),
      cwd: z.string().nullable().optional(),
      title: z.string().nullable().optional(),
      cwd_receipt: DeliveryReceiptOutputSchema.optional(),
      boot_prompt_delivered: z.boolean().optional(),
      boot_prompt_receipt: DeliveryReceiptOutputSchema.optional(),
      boot_prompt_bytes: z.number().int().nonnegative().optional(),
      report_path: z.string().optional(),
      done_marker: z.string().optional(),
      coordination_footer_bytes: z.number().int().nonnegative().optional(),
      contract_path: z.string().optional(),
      coordination_footer_delivered: z.boolean().optional(),
      coordination_footer_note: z.string().optional(),
      boot_prompt_submit_verified: z.boolean().nullable().optional(),
      update_menu_skipped: z.boolean().optional(),
      update_menu_text_hash: z.string().optional(),
      spawn_state: z.enum(["started", "boot_unsubmitted"]).optional(),
      next_action: z.string().optional(),
      delivered_chars: z.number().int().nonnegative().optional(),
    })
    .passthrough(),
  report_to_parent: z
    .object({
      ...BaseOutputShape,
      child_agent_id: z.string().optional(),
      parent_agent_id: z.string().optional(),
      notified_agent_id: z.string().optional(),
      route: z.enum(["direct", "fallback"]).optional(),
      durable: z.boolean().optional(),
      delivery: z.enum(["submitted", "queued", "refused", "pending_verify"]).optional(),
      delivery_id: z.string().optional(),
      error_code: z.string().optional(),
    })
    .passthrough(),
  send_to: z
    .object({
      ...BaseOutputShape,
      ...DeliveryOutputShape,
      agent_id: z.string().optional(),
      surface: z.string().optional(),
      command: z.string().optional(),
      key: z.string().optional(),
      title: z.string().optional(),
      model: z.string().optional(),
      agent_type: z.string().optional(),
      accepted: z.boolean().optional(),
      status: z.string().optional(),
      boot_prompt_delivered: z.boolean().optional(),
      boot_prompt_receipt: DeliveryReceiptOutputSchema.optional(),
      boot_prompt_bytes: z.number().int().nonnegative().optional(),
      report_path: z.string().optional(),
      done_marker: z.string().optional(),
      coordination_footer_bytes: z.number().int().nonnegative().optional(),
      contract_path: z.string().optional(),
      coordination_footer_delivered: z.boolean().optional(),
      coordination_footer_note: z.string().optional(),
      boot_prompt_submit_verified: z.boolean().nullable().optional(),
      boot_prompt_warning: z.string().nullable().optional(),
      registry_state: z.string().nullable().optional(),
      screen: z.record(z.unknown()).nullable().optional(),
      state_conflict: z.boolean().optional(),
      health: z.record(z.unknown()).optional(),
      receipts: z
        .array(z.object({ ...DeliveryOutputShape }).passthrough())
        .optional(),
    })
    .passthrough(),
  read_screen: z
    .object({
      ...BaseOutputShape,
      surface: z.string().optional(),
      parsed: z.record(z.unknown()).optional(),
    })
    .passthrough(),
  list_agents: z
    .object({
      ...BaseOutputShape,
      agents: z.array(z.record(z.unknown())).optional(),
      count: z.number().int().nonnegative().optional(),
      derived_at: z.number().optional(),
    })
    .passthrough(),
  wait_for: z
    .object({
      ...BaseOutputShape,
      ...DeliveryOutputShape,
      agent_id: z.string().optional(),
      results: z.array(z.record(z.unknown())).optional(),
      watch: z.record(z.unknown()).optional(),
      timed_out: z.boolean().optional(),
    })
    .passthrough(),
  control_health: z
    .object({
      ...BaseOutputShape,
      health: z.record(z.unknown()).optional(),
    })
    .passthrough(),
  close_surface: z
    .object({
      ...BaseOutputShape,
      scope: z.enum(["surface", "agent", "workspace"]).optional(),
      surface: z.string().optional(),
      agent_id: z.string().optional(),
      workspace: z.string().optional(),
      state: z.string().optional(),
      force: z.boolean().optional(),
      removed: z.record(z.unknown()).optional(),
      pane: z.string().optional(),
      collapse_pane: z.boolean().optional(),
      refused: z.boolean().optional(),
      caller_workspace: z.boolean().optional(),
      surfaces: z.array(z.record(z.unknown())).optional(),
      agents: z.array(z.record(z.unknown())).optional(),
      live_agents: z.array(z.record(z.unknown())).optional(),
    })
    .passthrough(),
  update_surface: z
    .object({
      ...BaseOutputShape,
      action: z.enum(["move", "rename"]).optional(),
      surface: z.string().optional(),
      pane: z.string().optional(),
      workspace: z.string().optional(),
      title: z.string().optional(),
    })
    .passthrough(),
  list_surfaces: z
    .object({
      ...BaseOutputShape,
      workspaces: z.array(z.record(z.unknown())).optional(),
      surfaces: z.array(z.record(z.unknown())).optional(),
      column_count: z.number().int().nonnegative().optional(),
    })
    .passthrough(),
};

export const BroadcastRoleSchema = z.enum(["leads", "workers", "all"]);

export const legacyCompatibleAgentRoleSchema = () =>
  z
    .enum(["orchestrator", "worker"])
    .catch((context) => context.input as AgentRole);

export const spawnFunctionSchema = () =>
  z
    .enum(["orchestrator", "worker", "implementor", "reviewer", "gatherer"])
    .catch((context) => context.input as AgentRole);

export const spawnPlacementSchema = () =>
  z
    .enum(["left", "right", "orchestrator", "worker"])
    .catch((context) => context.input as AgentPlacement);

export function normalizeToolAgentRole(
  input: unknown,
  field: "role" | "placement",
): { role: AgentRole | undefined; warning: string | undefined } {
  if (input === undefined) return { role: undefined, warning: undefined };
  if (input === "ic") {
    return {
      role: "worker",
      warning: `Legacy ${field}=\"ic\" was coerced to \"worker\"; placement now has only orchestrator/worker columns`,
    };
  }
  if (input === "orchestrator" || input === "worker") {
    return { role: input, warning: undefined };
  }
  throw new Error(
    `Invalid ${field}=${JSON.stringify(input)}; expected orchestrator or worker`,
  );
}

export function normalizeSpawnAxes(input: {
  role: unknown;
  placement: unknown;
  authority: AgentAuthority | undefined;
}): {
  role: AgentRole;
  function: AgentFunction;
  authority: AgentAuthority;
  placement: AgentPlacement;
  warning: string | undefined;
} {
  const raw = input.role;
  if (
    raw !== undefined &&
    raw !== "orchestrator" &&
    raw !== "worker" &&
    raw !== "ic" &&
    raw !== "implementor" &&
    raw !== "reviewer" &&
    raw !== "gatherer"
  ) {
    throw new Error(
      `Invalid role=${JSON.stringify(raw)}; expected orchestrator, worker, implementor, reviewer, or gatherer`,
    );
  }
  if (
    input.placement !== undefined &&
    input.placement !== "left" &&
    input.placement !== "right" &&
    input.placement !== "orchestrator" &&
    input.placement !== "worker" &&
    input.placement !== "ic"
  ) {
    throw new Error(
      `Invalid placement=${JSON.stringify(input.placement)}; expected left or right`,
    );
  }
  const legacyRaw =
    raw === "orchestrator" || raw === "worker" || raw === "ic"
      ? raw
      : input.placement === "orchestrator" ||
          input.placement === "worker" ||
          input.placement === "ic"
        ? input.placement
        : undefined;
  const legacy =
    legacyRaw !== undefined
      ? normalizeToolAgentRole(
          legacyRaw,
          legacyRaw === input.role ? "role" : "placement",
        )
      : null;
  const jobFunction: AgentFunction =
    raw === "reviewer" || raw === "gatherer" || raw === "implementor"
      ? raw
      : "implementor";
  const defaultAuthority: AgentAuthority = "worker";
  const authority =
    input.authority ??
    (legacy?.role === "orchestrator"
      ? "lead"
      : legacy?.role === "worker"
        ? "worker"
        : defaultAuthority);
  if (
    (jobFunction === "reviewer" || jobFunction === "gatherer") &&
    authority !== "worker"
  ) {
    throw new Error(
      `${jobFunction} is a worker function and cannot claim lead authority`,
    );
  }
  const derivedPlacement: AgentPlacement =
    authority === "lead" ? "left" : "right";
  const requestedPlacement =
    input.placement === "left" || input.placement === "right"
      ? input.placement
      : undefined;
  if (requestedPlacement && requestedPlacement !== derivedPlacement) {
    throw new Error(
      `${jobFunction} with ${authority} authority must be placed ${derivedPlacement}, not ${requestedPlacement}`,
    );
  }
  return {
    role: authority === "lead" ? "orchestrator" : "worker",
    function: jobFunction,
    authority,
    placement: requestedPlacement ?? derivedPlacement,
    warning: legacy?.warning,
  };
}

export const BroadcastArgsSchema = z.object({
  text: z.string(),
  role: BroadcastRoleSchema.optional().default("leads"),
  exclude: z.array(z.string()).optional().default([]),
  workspace: z.string().optional(),
  press_enter: z.boolean().optional().default(true),
});

// Spawn-tool argument schemas, moved from createServer (CX-3b S10b).
export const worktreeArgSchema = z.union([
  z.boolean(),
  z.string(),
  z.object({
    create: z.boolean().optional(),
    reuse: z.boolean().optional(),
    name: z.string().optional(),
    path: z.string().optional(),
    branch: z.string().optional(),
    base: z.string().optional(),
  }),
]);

export const mcpProfileSchema = z.union([
  z.enum(["inherit", "sterile", "skill_eval"]),
  z.object({
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
  }),
]);
