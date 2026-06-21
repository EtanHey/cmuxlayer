/**
 * Zod schemas and TypeScript types for the security policy.
 *
 * This module is the **single source of truth** for all policy-related types.
 * It defines the {@link Redactor} and {@link AuditLogger} interfaces so that
 * downstream modules (audit, redactor) can import the interfaces from here
 * and re-export them without creating circular dependencies.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

/** Zod schema for a complete security policy configuration. */
export const PolicySchema = z.object({
  project: z.object({
    root: z.string(),
    max_file_read_bytes: z.number().int().positive().default(200_000),
    max_search_results: z.number().int().positive().default(100),
    deny: z.array(z.string()).default([]),
  }),
  workspaces: z
    .object({
      allowed_prefixes: z.array(z.string()).default([]),
    })
    .optional(),
  agents: z
    .object({
      allowed_prefixes: z.array(z.string()).default([]),
    })
    .optional(),
  surfaces: z
    .object({
      allowed_name_prefixes: z.array(z.string()).default([]),
    })
    .optional(),
  tools: z.object({
    allow: z.array(z.string()).default([]),
    require_confirmation: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
  }),
  commands: z
    .object({
      deny_patterns: z.array(z.string()).default([]),
      require_confirmation_patterns: z.array(z.string()).default([]),
    })
    .optional(),
  audit: z
    .object({
      path: z
        .string()
        .default("~/.local/share/chatgpt-mcp-cmux/audit.jsonl"),
      redact_secrets: z.boolean().default(true),
      log_full_inputs: z.boolean().default(false),
      log_input_preview_chars: z.number().int().positive().default(300),
    })
    .optional(),
  limits: z
    .object({
      max_output_lines: z.number().int().positive().default(500),
      max_screen_chars: z.number().int().positive().default(50_000),
      max_request_body_bytes: z.number().int().positive().default(100_000),
      tool_timeout_ms: z.number().int().positive().default(30_000),
      max_concurrent_requests: z.number().int().positive().default(5),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

/** Parsed and validated security policy. */
export type Policy = z.infer<typeof PolicySchema>;

/** Possible access decisions for a tool. */
export type ToolDecision = "allowed" | "denied" | "confirmation_required";

// ---------------------------------------------------------------------------
// Audit types
// ---------------------------------------------------------------------------

/** A single audit event describing a tool invocation and its outcome. */
export interface AuditEvent {
  /** ISO-8601 timestamp. */
  ts: string;
  /** Unique request identifier. */
  request_id: string;
  /** Client identifier. */
  client: string;
  /** Server mode (e.g. "stdio-secure"). */
  mode: string;
  /** Tool name that was invoked. */
  tool: string;
  /** Optional target of the tool (path, agent_id, etc.). */
  target?: string;
  /** Access decision or execution outcome. */
  decision: ToolDecision | "failed" | "timeout";
  /** Preview of the tool input (redacted). */
  input_preview: string;
  /** SHA-256 hash of the full input. */
  input_hash: string;
  /** Result summary or error message. */
  result: string;
  /** Duration of tool execution in milliseconds. */
  duration_ms: number;
}

// ---------------------------------------------------------------------------
// Redactor interface (implemented in redactor.ts)
// ---------------------------------------------------------------------------

/** Secret-redaction interface used during audit logging and output handling. */
export interface Redactor {
  /** Return a copy of {@link input} with known secret patterns replaced. */
  redact(input: string): string;
  /** Register a new redaction pattern. */
  addPattern(name: string, pattern: RegExp, replacement?: string): void;
}

// ---------------------------------------------------------------------------
// Audit logger interface (implemented in audit.ts)
// ---------------------------------------------------------------------------

/** Persistent audit logger interface. */
export interface AuditLogger {
  /** Asynchronously write an audit event (timestamp is added automatically). */
  log(event: Omit<AuditEvent, "ts">): Promise<void>;
  /** Synchronously write an audit event (timestamp is added automatically). */
  logSync(event: Omit<AuditEvent, "ts">): void;
  /** Retrieve the most recent {@link count} audit events. */
  recent(count: number): Promise<AuditEvent[]>;
  /** Release resources. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Secure tool execution context
// ---------------------------------------------------------------------------

/**
 * Context object passed through every secure tool invocation.
 * Bundles the loaded policy, audit logger, redactor, and request metadata.
 */
export interface SecureToolContext {
  /** Loaded security policy. */
  policy: Policy;
  /** Audit logger for recording tool invocations. */
  auditLogger: AuditLogger;
  /** Secret redactor for sanitising inputs and outputs. */
  redactor: Redactor;
  /** Unique identifier for this request. */
  requestId: string;
  /** Server mode string. */
  mode: string;
}

// ---------------------------------------------------------------------------
// Tool wrapper types
// ---------------------------------------------------------------------------

/** Result shape returned by every wrapped secure tool handler. */
export interface WrappedToolResult {
  /** MCP content blocks. */
  content: Array<{ type: "text"; text: string }>;
  /** Whether the result represents an error. */
  isError?: boolean;
}

/** Options used when wrapping a raw tool handler with security guards. */
export interface ToolWrapOptions {
  /** Name of the tool (secure side). */
  toolName: string;
  /** Zod schema for validating tool arguments. */
  schema: z.ZodType;
  /** Handler that implements the tool logic. */
  handler: (
    args: unknown,
    context: SecureToolContext,
    serverContext: unknown,
  ) => Promise<WrappedToolResult>;
  /** MCP tool annotations. */
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}
