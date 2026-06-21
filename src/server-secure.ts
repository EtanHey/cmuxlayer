/**
 * Secure MCP server factory — wraps upstream createServer with a security layer.
 *
 * When --config is provided, creates a secure server that:
 * - Exposes only policy-allowed tools with safe namespaced names
 * - Applies tool access checks, prefix filtering, command guards
 * - Redacts secrets and truncates output
 * - Writes audit events for every tool call
 *
 * Without --config, upstream createServer() is used directly (backward compatible).
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CmuxClient } from "./cmux-client.js";
import { createServerContext, type CreateServerOptions, type CmuxServerContext } from "./server.js";
import { loadPolicy } from "./secure/policy.js";
import { createAuditLogger, type AuditLogger } from "./secure/audit.js";
import { createDefaultRedactor, type Redactor } from "./secure/redactor.js";
import { wrapTool, type WrappedToolResult } from "./secure/tool-wrapper.js";
import type { SecureToolContext, Policy } from "./secure/policy-schema.js";
import { createRequestId } from "./secure/limits.js";

// System tools — direct async functions
import {
  systemHealth,
  systemVersion,
  systemPolicy,
  systemCmuxHealth,
  systemMemoryUsage,
} from "./tools/secure-system-tools.js";

// Project tools — direct async functions
import {
  projectInfo,
  projectTree,
  projectReadFile,
  projectSearch,
  projectGrep,
  projectGitStatus,
  projectGitDiff,
  projectGitLogRecent,
} from "./tools/secure-project-tools.js";

// Cmux/agent/audit tools — factory functions
import { createSecureCmuxTools } from "./tools/secure-cmux-tools.js";
import { createSecureAgentTools } from "./tools/secure-agent-tools.js";
import { createSecureAuditTools } from "./tools/secure-audit-tools.js";

export interface CreateSecureServerOptions extends CreateServerOptions {
  policyPath?: string;
  policy?: Policy;
  auditLogger?: AuditLogger;
  redactor?: Redactor;
}

const RO = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const MU = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

/**
 * Create a secure MCP server with policy-enforced tool exposure.
 */
export async function createSecureServer(
  opts?: CreateSecureServerOptions,
): Promise<McpServer> {
  // 1. Create upstream context (reuses all cmux infrastructure)
  const context = opts?.context ?? createServerContext(opts);
  const client = context.client;

  // 2. Load policy
  const policy =
    opts?.policy ?? (opts?.policyPath ? await loadPolicy(opts.policyPath) : getDefaultPolicy());

  // 3. Create audit logger and redactor
  const auditLogger = opts?.auditLogger ?? createAuditLogger(policy);
  const redactor = opts?.redactor ?? createDefaultRedactor();

  // 4. Build the MCP server
  const server = new McpServer(
    {
      name: "@danissimode/chatgpt-mcp-cmux",
      version: "0.3.0",
    },
    {
      instructions:
        "Secure MCP gateway for ChatGPT remote orchestration of local CLI agents. " +
        "All tool calls are audited, secrets are redacted, and access is controlled by policy.",
    },
  );

  // 5. Create the shared secure context
  const secureContext: SecureToolContext = {
    policy,
    auditLogger,
    redactor,
    requestId: createRequestId(),
    mode: "stdio-secure",
  };

  // 6. Create factory-based tools
  const cmuxTools = createSecureCmuxTools(client as CmuxClient, policy);
  const agentTools = createSecureAgentTools(context, policy);
  const auditTools = createSecureAuditTools(auditLogger);

  // Helper: wrap any handler through the security pipeline
  const sh = (
    toolName: string,
    handler: (args: unknown, ctx: SecureToolContext) => Promise<WrappedToolResult>,
  ) =>
    async (args: unknown): Promise<WrappedToolResult> => {
      const result = wrapTool(
        {
          toolName,
          schema: z.object({}),
          handler: async (a: unknown, sc: SecureToolContext): Promise<WrappedToolResult> =>
            handler(a, sc),
          annotations: RO,
        },
        { ...secureContext, requestId: createRequestId() },
        context,
      );
      return result.handler(args);
    };

  // ── System tools ──────────────────────────────────────────────────
  server.tool("system.health", "Check if the secure MCP gateway is running", {}, RO, async () =>
    sh("system.health", systemHealth)({}),
  );

  server.tool("system.version", "Get the gateway version", {}, RO, async () =>
    sh("system.version", systemVersion)({}),
  );

  server.tool("system.policy", "View the active security policy (sanitized)", {}, RO, async () =>
    sh("system.policy", systemPolicy)({}),
  );

  server.tool(
    "system.cmux_health",
    "Check cmux socket connectivity and process status",
    {},
    RO,
    async () => sh("system.cmux_health", systemCmuxHealth)({}),
  );

  server.tool(
    "system.memory_usage",
    "Get memory usage of the gateway process",
    {},
    RO,
    async () => sh("system.memory_usage", systemMemoryUsage)({}),
  );

  // ── Project tools ─────────────────────────────────────────────────
  server.tool("project.info", "Get project root info and git status", {}, RO, async () =>
    sh("project.info", projectInfo)({}),
  );

  server.tool(
    "project.tree",
    "List files in the project directory tree",
    { path: z.string().optional(), max_depth: z.number().int().min(1).max(10).optional() },
    RO,
    async (args) => sh("project.tree", projectTree)(args),
  );

  server.tool(
    "project.read_file",
    "Read a file within the project root",
    { path: z.string() },
    RO,
    async (args) => sh("project.read_file", projectReadFile)(args),
  );

  server.tool(
    "project.search",
    "Search for text across project files",
    { query: z.string(), path: z.string().optional() },
    RO,
    async (args) => sh("project.search", projectSearch)(args),
  );

  server.tool(
    "project.grep",
    "Grep for a pattern across project files",
    { pattern: z.string(), path: z.string().optional() },
    RO,
    async (args) => sh("project.grep", projectGrep)(args),
  );

  server.tool("project.git_status", "Get git status of the project", {}, RO, async () =>
    sh("project.git_status", projectGitStatus)({}),
  );

  server.tool(
    "project.git_diff",
    "Get git diff of the project",
    { path: z.string().optional() },
    RO,
    async (args) => sh("project.git_diff", projectGitDiff)(args),
  );

  server.tool(
    "project.git_log_recent",
    "Get recent git log entries",
    { n: z.number().int().min(1).max(100).optional() },
    RO,
    async (args) => sh("project.git_log_recent", projectGitLogRecent)(args),
  );

  // ── Cmux tools ────────────────────────────────────────────────────
  server.tool(
    "cmux.list_surfaces",
    "List cmux surfaces filtered by allowed prefixes",
    { workspace: z.string().optional() },
    RO,
    async (args) => sh("cmux.list_surfaces", cmuxTools["cmux.list_surfaces"])(args),
  );

  server.tool(
    "cmux.read_screen",
    "Read a cmux terminal screen with parsing",
    { surface: z.string(), lines: z.number().int().min(1).max(500).optional() },
    RO,
    async (args) => sh("cmux.read_screen", cmuxTools["cmux.read_screen"])(args),
  );

  server.tool(
    "cmux.read_output",
    "Read raw output from a cmux surface",
    { surface: z.string(), lines: z.number().int().min(1).max(500).optional() },
    RO,
    async (args) => sh("cmux.read_output", cmuxTools["cmux.read_output"])(args),
  );

  server.tool(
    "cmux.read_recent_activity",
    "Read recent activity from a cmux surface",
    { surface: z.string(), since_seconds: z.number().int().min(1).max(3600).optional() },
    RO,
    async (args) => sh("cmux.read_recent_activity", cmuxTools["cmux.read_recent_activity"])(args),
  );

  server.tool(
    "cmux.get_agent_metadata",
    "Get parsed agent metadata from a surface",
    { surface: z.string() },
    RO,
    async (args) => sh("cmux.get_agent_metadata", cmuxTools["cmux.get_agent_metadata"])(args),
  );

  // ── Agent tools ───────────────────────────────────────────────────
  server.tool("agent.list", "List allowed agents filtered by prefix", {}, RO, async () =>
    sh("agent.list", agentTools["agent.list"])({}),
  );

  server.tool(
    "agent.status",
    "Get status of a specific agent",
    { agent_id: z.string() },
    RO,
    async (args) => sh("agent.status", agentTools["agent.status"])(args),
  );

  server.tool(
    "agent.read",
    "Read output from an agent",
    { agent_id: z.string(), lines: z.number().int().min(1).max(500).optional() },
    RO,
    async (args) => sh("agent.read", agentTools["agent.read"])(args),
  );

  server.tool(
    "agent.send_task",
    "Send a task to an allowed agent",
    { agent_id: z.string(), task: z.string() },
    MU,
    async (args) => sh("agent.send_task", agentTools["agent.send_task"])(args),
  );

  server.tool(
    "agent.continue",
    "Continue an agent with optional instruction",
    { agent_id: z.string(), instruction: z.string().optional() },
    MU,
    async (args) => sh("agent.continue", agentTools["agent.continue"])(args),
  );

  server.tool(
    "agent.extract_summary",
    "Extract summary from agent output",
    { agent_id: z.string() },
    RO,
    async (args) => sh("agent.extract_summary", agentTools["agent.extract_summary"])(args),
  );

  server.tool(
    "agent.extract_errors",
    "Extract errors from agent output",
    { agent_id: z.string() },
    RO,
    async (args) => sh("agent.extract_errors", agentTools["agent.extract_errors"])(args),
  );

  server.tool(
    "agent.extract_next_actions",
    "Extract suggested next actions from agent output",
    { agent_id: z.string() },
    RO,
    async (args) => sh("agent.extract_next_actions", agentTools["agent.extract_next_actions"])(args),
  );

  // ── Audit tools ───────────────────────────────────────────────────
  server.tool(
    "audit.recent",
    "View recent audit events",
    { count: z.number().int().min(1).max(1000).optional() },
    RO,
    async (args) => sh("audit.recent", auditTools["audit.recent"])(args),
  );

  server.tool(
    "audit.search",
    "Search audit events by tool, decision, or time",
    {
      tool: z.string().optional(),
      decision: z.string().optional(),
      since: z.string().optional(),
    },
    RO,
    async (args) => sh("audit.search", auditTools["audit.search"])(args),
  );

  return server;
}

/** Fallback default policy when no config is provided. */
function getDefaultPolicy(): Policy {
  return {
    project: {
      root: process.cwd(),
      max_file_read_bytes: 200_000,
      max_search_results: 100,
      deny: [".env", ".env.*", "*.pem", "*.key", "node_modules/**", ".git/objects/**"],
    },
    workspaces: { allowed_prefixes: [] },
    agents: { allowed_prefixes: [] },
    surfaces: { allowed_name_prefixes: [] },
    tools: {
      allow: ["system.health", "system.version"],
      require_confirmation: [],
      deny: [],
    },
    commands: {
      deny_patterns: [],
      require_confirmation_patterns: [],
    },
    audit: {
      path: "~/.local/share/chatgpt-mcp-cmux/audit.jsonl",
      redact_secrets: true,
      log_full_inputs: false,
      log_input_preview_chars: 300,
    },
    limits: {
      max_output_lines: 500,
      max_screen_chars: 50_000,
      max_request_body_bytes: 100_000,
      tool_timeout_ms: 30_000,
      max_concurrent_requests: 5,
    },
  };
}
