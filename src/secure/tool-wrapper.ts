import { z } from "zod";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type { SecureToolContext, ToolDecision, AuditEvent } from "./policy-schema.js";
import { checkToolAccess, isAllowedPrefix } from "./tool-policy.js";
import { truncateOutput, hashInput } from "./limits.js";
import type { CmuxServerContext } from "../server.js";

export interface WrappedToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

export type WrappedToolHandler<TInput> = (
  args: TInput,
  context: SecureToolContext,
  serverContext: CmuxServerContext,
) => Promise<WrappedToolResult>;

export interface ToolWrapOptions {
  toolName: string;
  schema: z.ZodType;
  handler: WrappedToolHandler<unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

/**
 * Tools whose input should be checked by command-guard.
 * These tools accept free-form text that could contain shell commands.
 */
const TEXT_INPUT_TOOLS: string[] = [
  "agent.send_task",
  "agent.continue",
  "project.search",
  "project.grep",
];

/**
 * Tools that require workspace/agent/surface prefix checks.
 */
const PREFIX_SENSITIVE_TOOLS: ReadonlySet<string> = new Set([
  "cmux.read_screen",
  "cmux.read_output",
  "cmux.read_recent_activity",
  "cmux.get_agent_metadata",
  "agent.list",
  "agent.status",
  "agent.read",
  "agent.send_task",
  "agent.continue",
  "agent.extract_summary",
  "agent.extract_errors",
  "agent.extract_next_actions",
]);

/**
 * The surface-prefixed tools that read from a specific surface.
 */
const SURFACE_PREFIX_TOOLS: ReadonlySet<string> = new Set([
  "cmux.read_screen",
  "cmux.read_output",
  "cmux.read_recent_activity",
  "cmux.get_agent_metadata",
  "agent.read",
  "agent.extract_summary",
  "agent.extract_errors",
  "agent.extract_next_actions",
]);

/**
 * The agent-prefixed tools that target a specific agent.
 */
const AGENT_PREFIX_TOOLS: ReadonlySet<string> = new Set([
  "agent.status",
  "agent.read",
  "agent.send_task",
  "agent.continue",
  "agent.extract_summary",
  "agent.extract_errors",
  "agent.extract_next_actions",
]);

function extractTargetFromArgs(toolName: string, args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;

  if (SURFACE_PREFIX_TOOLS.has(toolName) && typeof record.surface === "string") {
    return record.surface;
  }
  if (AGENT_PREFIX_TOOLS.has(toolName) && typeof record.agent_id === "string") {
    return record.agent_id;
  }
  if (toolName === "cmux.list_surfaces" && typeof record.workspace === "string") {
    return record.workspace;
  }

  return undefined;
}

function extractWorkspaceFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  if (typeof record.workspace === "string") return record.workspace;
  return undefined;
}

function checkPrefixAllowlist(
  toolName: string,
  args: unknown,
  policy: SecureToolContext["policy"],
): { allowed: true } | { allowed: false; reason: string } {
  const target = extractTargetFromArgs(toolName, args);
  if (!target) {
    return { allowed: true };
  }

  // Check surface prefixes
  if (SURFACE_PREFIX_TOOLS.has(toolName)) {
    const surfacePrefixes = policy.surfaces?.allowed_name_prefixes ?? [];
    if (surfacePrefixes.length > 0 && !isAllowedPrefix(target, surfacePrefixes)) {
      return {
        allowed: false,
        reason: `Target "${target}" does not match allowed surface prefixes: ${surfacePrefixes.join(", ")}`,
      };
    }
  }

  // Check agent prefixes
  if (AGENT_PREFIX_TOOLS.has(toolName)) {
    const agentPrefixes = policy.agents?.allowed_prefixes ?? [];
    if (agentPrefixes.length > 0 && !isAllowedPrefix(target, agentPrefixes)) {
      return {
        allowed: false,
        reason: `Target "${target}" does not match allowed agent prefixes: ${agentPrefixes.join(", ")}`,
      };
    }
  }

  // Check workspace prefixes for workspace-targeted tools
  if (toolName === "cmux.list_surfaces") {
    const workspacePrefixes = policy.workspaces?.allowed_prefixes ?? [];
    if (workspacePrefixes.length > 0) {
      const workspaceTarget = extractWorkspaceFromArgs(args);
      if (workspaceTarget && !isAllowedPrefix(workspaceTarget, workspacePrefixes)) {
        return {
          allowed: false,
          reason: `Workspace "${workspaceTarget}" does not match allowed workspace prefixes: ${workspacePrefixes.join(", ")}`,
        };
      }
    }
  }

  return { allowed: true };
}

function needsTextGuard(toolName: string): boolean {
  return TEXT_INPUT_TOOLS.includes(toolName);
}

function errorResponse(toolName: string, message: string): WrappedToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ ok: false, error: message, tool: toolName }),
      },
    ],
    isError: true,
  };
}

function confirmationResponse(toolName: string): WrappedToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: false,
          error: `Tool "${toolName}" requires user confirmation before execution`,
          confirmation_required: true,
          tool: toolName,
        }),
      },
    ],
    isError: true,
  };
}

function truncateResult(result: WrappedToolResult, context: SecureToolContext): WrappedToolResult {
  const maxLines = context.policy.limits?.max_output_lines ?? 500;
  const maxChars = context.policy.limits?.max_screen_chars ?? 50000;

  // Apply limits globally across all text blocks combined, not per-block
  let totalChars = 0;
  let totalLines = 0;
  const truncated = result.content.map((item) => {
    if (item.type === "text") {
      totalChars += item.text.length;
      totalLines += (item.text.match(/\n/g) ?? []).length + 1;
    }
    return item;
  });

  // If total exceeds limits, concatenate and truncate
  if (totalChars > maxChars || totalLines > maxLines) {
    const combined = result.content
      .filter((item) => item.type === "text")
      .map((item) => (item.type === "text" ? item.text : ""))
      .join("\n");
    const truncatedText = truncateOutput(combined, maxLines, maxChars);
    return {
      content: [{ type: "text", text: truncatedText }],
      isError: result.isError,
    };
  }

  return {
    content: truncated,
    isError: result.isError,
  };
}

function redactResult(result: WrappedToolResult, context: SecureToolContext): WrappedToolResult {
  const redacted = result.content.map((item) => {
    if (item.type === "text") {
      return {
        type: "text" as const,
        text: context.redactor.redact(item.text),
      };
    }
    return item;
  });

  return {
    content: redacted,
    isError: result.isError,
  };
}

async function writeAuditEvent(
  options: ToolWrapOptions,
  context: SecureToolContext,
  args: unknown,
  decision: ToolDecision | "failed" | "timeout",
  result: WrappedToolResult,
  durationMs: number,
  target?: string,
): Promise<void> {
  const inputPreview = JSON.stringify(args).slice(
    0,
    context.policy.audit?.log_input_preview_chars ?? 300,
  );
  const inputHash = hashInput(JSON.stringify(args));
  const resultText = result.content.map((c) => (c.type === "text" ? c.text : "")).join(" ");

  const event: Omit<AuditEvent, "ts"> = {
    request_id: context.requestId,
    client: "ChatGPTMCPcmux",
    mode: context.mode,
    tool: options.toolName,
    target,
    decision,
    input_preview: inputPreview,
    input_hash: inputHash,
    result: resultText.slice(0, 2000),
    duration_ms: durationMs,
  };

  try {
    await context.auditLogger.log(event);
  } catch {
    // Audit logging failures must not break tool execution
  }
}

export function wrapTool<TInput>(
  options: ToolWrapOptions,
  context: SecureToolContext,
  serverContext: CmuxServerContext,
): {
  name: string;
  schema: z.ZodType;
  handler: (args: TInput) => Promise<WrappedToolResult>;
} {
  return {
    name: options.toolName,
    schema: options.schema,
    handler: async (args: TInput): Promise<WrappedToolResult> => {
      const startMs = Date.now();

      // 1. Generate request_id (already in context, but ensure uniqueness per call)
      const requestId = context.requestId || randomUUID();
      const callContext: SecureToolContext = {
        ...context,
        requestId,
      };

      // 2. Load policy — already in context
      // 3. Check tool access via checkToolAccess()
      const accessDecision = checkToolAccess(options.toolName, callContext.policy);

      let decision: ToolDecision | "failed" | "timeout";
      let result: WrappedToolResult;
      let target: string | undefined;

      if (accessDecision === "denied") {
        decision = "denied";
        result = errorResponse(
          options.toolName,
          `Tool "${options.toolName}" is not allowed by policy`,
        );
        await writeAuditEvent(
          options,
          callContext,
          args,
          decision,
          result,
          Date.now() - startMs,
          target,
        );
        return result;
      }

      // 4. If confirmation_required, return confirmation_required response
      if (accessDecision === "confirmation_required") {
        decision = "confirmation_required";
        result = confirmationResponse(options.toolName);
        await writeAuditEvent(
          options,
          callContext,
          args,
          decision,
          result,
          Date.now() - startMs,
          target,
        );
        return result;
      }

      // 5. Check workspace/agent/surface allowlists if applicable
      if (PREFIX_SENSITIVE_TOOLS.has(options.toolName)) {
        const prefixCheck = checkPrefixAllowlist(
          options.toolName,
          args,
          callContext.policy,
        );
        if (!prefixCheck.allowed) {
          decision = "denied";
          result = errorResponse(options.toolName, prefixCheck.reason);
          await writeAuditEvent(
            options,
            callContext,
            args,
            decision,
            result,
            Date.now() - startMs,
            target,
          );
          return result;
        }
      }

      // 6. Run command-guard if tool involves text input
      if (needsTextGuard(options.toolName)) {
        const { checkCommandText } = await import("./command-guard.js");
        const text =
          options.toolName === "project.search" || options.toolName === "project.grep"
            ? String((args as Record<string, unknown>)?.query ?? (args as Record<string, unknown>)?.pattern ?? "")
            : String((args as Record<string, unknown>)?.task ?? (args as Record<string, unknown>)?.instruction ?? (args as Record<string, unknown>)?.text ?? "");

        if (text) {
          try {
            const risk = checkCommandText(text, callContext.policy, "agent_task");
            if (risk === "confirmation_required") {
              decision = "confirmation_required";
              result = confirmationResponse(options.toolName);
              await writeAuditEvent(
                options,
                callContext,
                args,
                decision,
                result,
                Date.now() - startMs,
                target,
              );
              return result;
            }
            // "allowed" → proceed
          } catch (guardError) {
            decision = "denied";
            const message =
              guardError instanceof Error
                ? guardError.message
                : String(guardError);
            result = errorResponse(options.toolName, message);
            await writeAuditEvent(
              options,
              callContext,
              args,
              decision,
              result,
              Date.now() - startMs,
              target,
            );
            return result;
          }
        }
      }

      // 7. Enforce max_file_read_bytes for file-read tools
      if (options.toolName === "project.read_file") {
        const filePath = (args as Record<string, unknown>)?.path;
        if (typeof filePath === "string") {
          const { assertReadableProjectPath } = await import("./path-guard.js");
          try {
            const resolved = await assertReadableProjectPath(
              filePath,
              callContext.policy,
            );
            const fileStat = await stat(resolved).catch(() => null);
            if (fileStat) {
              const maxSize =
                callContext.policy.project.max_file_read_bytes ?? 200_000;
              if (fileStat.size > maxSize) {
                decision = "denied";
                result = errorResponse(
                  options.toolName,
                  `File size (${fileStat.size} bytes) exceeds maximum allowed (${maxSize} bytes)`,
                );
                await writeAuditEvent(
                  options,
                  callContext,
                  args,
                  decision,
                  result,
                  Date.now() - startMs,
                  target,
                );
                return result;
              }
            }
          } catch {
            // Path validation errors will be caught by the handler
          }
        }
      }

      // 8-12. Execute handler, redact, truncate, audit — wrapped in safety
      // try-catch so that any unexpected failure in post-processing never
      // leaks raw error details to the client.
      try {
        result = await options.handler(args, callContext, serverContext);
        decision = "allowed";
        target = extractTargetFromArgs(options.toolName, args);

        // 8. Redact the output
        result = redactResult(result, callContext);

        // 9. Truncate output to limits
        result = truncateResult(result, callContext);
      } catch (postError) {
        // Handler or post-processing failed — return a safe redacted error
        decision = "failed";
        const rawMsg = postError instanceof Error ? postError.message : String(postError);
        // Ensure error message itself is redacted before returning
        const safeMsg = callContext.redactor.redact(rawMsg);
        result = errorResponse(options.toolName, safeMsg);
        target = extractTargetFromArgs(options.toolName, args);
      }

      // 10. Write audit event (always attempted, failures swallowed by logger)
      await writeAuditEvent(
        options,
        callContext,
        args,
        decision,
        result,
        Date.now() - startMs,
        target,
      );

      // 11. Return safe response
      return result;
    },
  };
}
