/**
 * MCP tool registration: the `server.tool` gating wrapper that tracks every
 * handler by name, hides non-public tools, defers palette tools, attaches
 * transport provenance, and upgrades legacy registrations to output schemas;
 * plus the `expand_palette` tool and the `ToolDeps` handlers need to leave the
 * `createServer` closure. Moved verbatim from server.ts (CX-3 S5).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentEngine } from "../agent-engine.js";
import type { AgentRegistry } from "../agent-registry.js";
import type { CmuxClient } from "../cmux-client.js";
import type { CmuxSocketClient } from "../cmux-socket-client.js";
import { getTransportHealth } from "../cmux-transport-self-heal.js";
import type { DefaultToolPalette } from "../palette.js";
import type { StateManager } from "../state-manager.js";
import { runWithSurfaceTopologyCallScope } from "../surface-topology.js";
import {
  currentCliFallbackCount,
  currentCliFallbackSources,
  currentCliFallbackUsed,
  withTransportRetryTracking,
} from "../transport-retry-context.js";
import type { DeliveryRpcMethod } from "../delivery/receipts.js";
import type { CmuxServerContext } from "./context.js";
import {
  ANNOTATIONS,
  BaseOutputShape,
  PUBLIC_TOOL_NAME_SET,
  PUBLIC_TOOL_OUTPUT_SCHEMAS,
} from "./schemas.js";
import {
  ok,
  shapeSuccessfulSendToResult,
  type ToolReturn,
} from "./tool-result.js";

export type ToolHandler = (
  args: Record<string, unknown>,
  extra: unknown,
) => Promise<ToolReturn>;
export type ToolHandlerRegistry = Map<string, ToolHandler>;

/**
 * What a tool handler needs once it leaves the `createServer` closure.
 * `engine` and `registry` stay null until the agent-lifecycle block wires
 * them, and stay null for `skipAgentLifecycle` servers.
 */
export interface ToolDeps {
  client: CmuxClient | CmuxSocketClient;
  stateMgr: StateManager;
  context: CmuxServerContext;
  toolHandlersByName: ToolHandlerRegistry;
  engine: AgentEngine | null;
  registry: AgentRegistry | null;
}

// A global-registry symbol, not a module WeakMap: tests that call
// vi.resetModules() load a second copy of this module and must still find
// the deps a server from the first copy was bound with.
const TOOL_DEPS = Symbol.for("cmuxlayer.toolDeps");

/** Record the deps a server's handlers use, so tests can reach them. */
export function bindToolDeps(server: McpServer, deps: ToolDeps): void {
  Object.defineProperty(server, TOOL_DEPS, { value: deps, enumerable: false });
}

/**
 * Tests only: the lifecycle engine behind a `createServer` result, or
 * undefined for `skipAgentLifecycle` servers. Replaces the handle that used
 * to hang off the hidden `interact` tool.
 */
export function engineForTests(server: unknown): AgentEngine | undefined {
  if (!server || typeof server !== "object") return undefined;
  const deps = (server as { [TOOL_DEPS]?: ToolDeps })[TOOL_DEPS];
  return deps?.engine ?? undefined;
}

/**
 * An RPC method counts as the one that dispatched only when no CLI fallback
 * happened during the dispatch and the transport is the socket.
 */
export function createSuccessfulDispatchRpcMethod(client: unknown) {
  return (
    method: DeliveryRpcMethod,
    cliFallbackCountBeforeDispatch: number,
  ): DeliveryRpcMethod | null =>
    currentCliFallbackCount() === cliFallbackCountBeforeDispatch &&
    getTransportHealth(client)?.mode === "socket"
      ? method
      : null;
}

export interface ToolRegistrationOptions {
  /** The (topology-invalidating) cmux client whose transport health is reported. */
  client: unknown;
  palette: DefaultToolPalette | null;
  /** Keep retired handlers registered only for direct unit coverage. */
  exposeInternalToolsForTests: boolean;
  /** Caller agent stamped onto send_to receipts. */
  resolveCallerAgentId: () => string | null;
}

export interface ToolRegistration {
  toolHandlersByName: ToolHandlerRegistry;
  /** Register `expand_palette` when a default palette is configured. */
  registerPaletteExpansion: () => void;
}

const TRANSPORT_PROVENANCE_TOOLS = new Set([
  "spawn_agent",
  "send_to",
  "close_surface",
  "control_health",
  "list_surfaces",
  "read_screen",
  "list_agents",
]);

function isLeanSuccessfulTransportReceipt(
  toolResult: ToolReturn,
  toolName: string,
  verbose: boolean,
): boolean {
  const structured = toolResult.structuredContent;
  if (
    verbose ||
    toolResult.isError === true ||
    !structured ||
    structured.ok !== true
  ) {
    return false;
  }
  if (toolName === "spawn_agent") return true;
  if (toolName !== "send_to") return false;
  const submittedReceipt =
    structured.delivery_state === "submitted" && structured.submitted === true;
  const verifiedKeyReceipt =
    typeof structured.key === "string" && structured.submit_verified === true;
  return submittedReceipt || verifiedKeyReceipt;
}

export function installToolRegistration(
  server: McpServer,
  {
    client,
    palette,
    exposeInternalToolsForTests,
    resolveCallerAgentId,
  }: ToolRegistrationOptions,
): ToolRegistration {
  const rawTool = server.tool.bind(server) as (...args: unknown[]) => unknown;
  const rawRegisterTool = server.registerTool.bind(server) as (
    name: string,
    config: Record<string, unknown>,
    handler: (...args: unknown[]) => unknown,
  ) => unknown;
  const transportProvenance = (): Record<string, unknown> => {
    const health = getTransportHealth(client);
    const transport = currentCliFallbackUsed()
      ? "cli"
      : (health?.mode ?? "cli");
    const socketPath = health?.current_socket_path ?? null;
    return {
      transport,
      socket_path: socketPath,
      socket_path_state:
        transport === "socket"
          ? "active"
          : socketPath
            ? "fallback"
            : "unavailable",
      ...(transport === "cli"
        ? { warnings: ["cli_fallback_active"] }
        : health?.degraded
          ? { warnings: ["socket_degraded"] }
          : {}),
      ...(currentCliFallbackUsed()
        ? { transport_fallbacks: currentCliFallbackSources() }
        : {}),
    };
  };
  /** Attach full transport diagnostics, or warnings alone on lean successes. */
  const attachTransportProvenance = (
    result: unknown,
    toolName: string,
    verbose = false,
  ): unknown => {
    if (!TRANSPORT_PROVENANCE_TOOLS.has(toolName)) {
      return result;
    }
    if (!result || typeof result !== "object") return result;
    const toolResult = result as ToolReturn;
    const structured = toolResult.structuredContent;
    if (!structured || typeof structured !== "object") return result;
    const leanSuccessfulReceipt = isLeanSuccessfulTransportReceipt(
      toolResult,
      toolName,
      verbose,
    );
    const provenance = transportProvenance();
    const existingWarnings = Array.isArray(structured.warnings)
      ? structured.warnings
      : [];
    const provenanceWarnings = Array.isArray(provenance.warnings)
      ? provenance.warnings
      : [];
    const warnings = [...new Set([...existingWarnings, ...provenanceWarnings])];
    if (leanSuccessfulReceipt) {
      if (warnings.length === 0) return result;
      const nextStructured = { ...structured, warnings };
      return {
        ...toolResult,
        content: toolResult.content.map((entry) =>
          entry.type === "text"
            ? { ...entry, text: JSON.stringify(nextStructured) }
            : entry,
        ),
        structuredContent: nextStructured,
      };
    }
    const nextStructured = {
      ...structured,
      ...provenance,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(Array.isArray(structured.receipts)
        ? {
            receipts: Object.freeze(
              structured.receipts.map((receipt) =>
                receipt && typeof receipt === "object"
                  ? Object.freeze({
                      ...(receipt as Record<string, unknown>),
                      ...provenance,
                    })
                  : receipt,
              ),
            ),
          }
        : {}),
    };
    const content = toolResult.content.map((entry) => {
      if (entry.type !== "text") return entry;
      try {
        const parsed = JSON.parse(entry.text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return entry;
        }
        return { ...entry, text: JSON.stringify(nextStructured) };
      } catch {
        return entry;
      }
    });
    return { ...toolResult, content, structuredContent: nextStructured };
  };
  const registerLegacyToolWithOutputSchema = (
    args: unknown[],
    outputSchema: z.ZodTypeAny,
  ): unknown => {
    const toolName = args[0];
    const handler = args.at(-1);
    if (typeof toolName !== "string" || typeof handler !== "function") {
      throw new Error("Invalid legacy MCP tool registration");
    }

    const legacyArgs = args.slice(1, -1);
    const description =
      typeof legacyArgs[0] === "string"
        ? (legacyArgs.shift() as string)
        : undefined;
    let inputSchema: unknown;
    let annotations: unknown;
    if (legacyArgs.length > 1) {
      inputSchema = legacyArgs.shift();
      annotations = legacyArgs.shift();
    } else if (legacyArgs.length === 1) {
      const candidate = legacyArgs.shift();
      const annotationKeys = new Set([
        "title",
        "readOnlyHint",
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
      ]);
      const keys =
        typeof candidate === "object" && candidate !== null
          ? Object.keys(candidate)
          : [];
      if (keys.length > 0 && keys.every((key) => annotationKeys.has(key))) {
        annotations = candidate;
      } else {
        inputSchema = candidate;
      }
    }
    if (legacyArgs.length > 0) {
      throw new Error(`Unsupported legacy MCP registration for ${toolName}`);
    }

    return rawRegisterTool(
      toolName,
      {
        ...(description ? { description } : {}),
        ...(inputSchema !== undefined ? { inputSchema } : {}),
        outputSchema,
        ...(annotations !== undefined ? { annotations } : {}),
      },
      handler as (...args: unknown[]) => unknown,
    );
  };
  const toolHandlersByName: ToolHandlerRegistry = new Map();
  (server as unknown as { tool: (...args: unknown[]) => unknown }).tool = (
    ...args: unknown[]
  ): unknown => {
    const toolName = args[0];
    const handlerIndex = args.length - 1;
    const handler = args[handlerIndex];
    if (typeof handler === "function") {
      const trackedHandler = (...handlerArgs: unknown[]) =>
        runWithSurfaceTopologyCallScope(() =>
          withTransportRetryTracking(async () => {
            const toolNameString =
              typeof toolName === "string" ? toolName : "";
            const rawArgs =
              handlerArgs[0] && typeof handlerArgs[0] === "object"
                ? (handlerArgs[0] as Record<string, unknown>)
                : {};
            const verbose = rawArgs.verbose === true;
            const callerAgentId = toolNameString === "send_to" ? resolveCallerAgentId() : null;
            let handled = (await handler(...handlerArgs)) as ToolReturn;
            if (toolNameString === "send_to") {
              const payload = { ...handled.structuredContent, caller_agent_id: callerAgentId };
              handled = { ...handled, structuredContent: payload, content: handled.content.map((entry) => {
                if (entry.type !== "text") return entry;
                try {
                  const value = JSON.parse(entry.text);
                  if (value && typeof value === "object" && !Array.isArray(value)) {
                    return { ...entry, text: JSON.stringify(payload) };
                  }
                } catch { /* Preserve human summaries alongside their structured receipt. */ }
                return entry;
              }) };
            }
            const shaped =
              toolNameString === "send_to" && !verbose
                ? shapeSuccessfulSendToResult(handled, rawArgs)
                : handled;
            return attachTransportProvenance(shaped, toolNameString, verbose);
          }),
        );
      args[handlerIndex] = trackedHandler;
      if (typeof toolName === "string") {
        toolHandlersByName.set(
          toolName,
          trackedHandler as (
            args: Record<string, unknown>,
            extra: unknown,
          ) => Promise<ToolReturn>,
        );
      }
    }
    if (
      typeof toolName === "string" &&
      !PUBLIC_TOOL_NAME_SET.has(toolName) &&
      !exposeInternalToolsForTests
    ) {
      return {
        update(updates: Record<string, unknown>) {
          const callback = updates.callback;
          if (typeof callback === "function") {
            toolHandlersByName.set(
              toolName,
              callback as (
                args: Record<string, unknown>,
                extra: unknown,
              ) => Promise<ToolReturn>,
            );
          }
        },
      };
    }
    if (
      palette &&
      typeof toolName === "string" &&
      !palette.shouldRegister(toolName)
    ) {
      return palette.defer(toolName, args);
    }
    if (typeof toolName === "string") {
      const outputSchema = PUBLIC_TOOL_OUTPUT_SCHEMAS[toolName];
      if (outputSchema) {
        return registerLegacyToolWithOutputSchema(args, outputSchema);
      }
    }
    return rawTool(...args);
  };
  const registerPaletteExpansion = (): void => {
    if (palette) {
      palette.warnAboutUnknownTools();
      rawRegisterTool(
        "expand_palette",
        {
          description:
            "Register the remaining Phase 5 tools for this MCP session.",
          inputSchema: {},
          outputSchema: z
            .object({
              ...BaseOutputShape,
              expanded: z.boolean(),
              already_expanded: z.boolean(),
              registered_tools: z.array(z.string()),
            })
            .passthrough(),
          annotations: ANNOTATIONS.idempotentMutating,
        },
        async () =>
          withTransportRetryTracking(async () => {
            const sendToolListChanged = server.sendToolListChanged;
            server.sendToolListChanged = () => {};
            let expansion;
            try {
              expansion = palette.expand((...args) => {
                const toolName = args[0];
                const outputSchema =
                  typeof toolName === "string"
                    ? PUBLIC_TOOL_OUTPUT_SCHEMAS[toolName]
                    : undefined;
                return outputSchema
                  ? registerLegacyToolWithOutputSchema(args, outputSchema)
                  : rawTool(...args);
              });
            } finally {
              server.sendToolListChanged = sendToolListChanged;
            }
            if (expansion.expanded) server.sendToolListChanged();
            return ok({ ...expansion });
          }),
      );
    }
  };

  return { toolHandlersByName, registerPaletteExpansion };
}
