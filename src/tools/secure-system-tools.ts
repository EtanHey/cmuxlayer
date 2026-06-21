import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SecureToolContext } from "../secure/policy-schema.js";

const execFileAsync = promisify(execFile);

export interface SystemToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

function ok(data: Record<string, unknown>): SystemToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: true, ...data }) }],
  };
}

function err(error: unknown, extra: Record<string, unknown> = {}): SystemToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ ok: false, error: message, ...extra }),
      },
    ],
    isError: true,
  };
}

/**
 * system.health — Return service health metadata
 */
export async function systemHealth(
  _args: unknown,
  _context: SecureToolContext,
): Promise<SystemToolResult> {
  return ok({
    service: "ChatGPTMCPcmux",
    mode: "stdio-secure",
    transport: "openai-secure-mcp-tunnel-compatible",
  });
}

/**
 * system.version — Read version from package.json
 */
export async function systemVersion(
  _args: unknown,
  _context: SecureToolContext,
): Promise<SystemToolResult> {
  try {
    // Traverse up from current file to find package.json
    const pkgPath = resolve(process.cwd(), "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      version?: string;
    };
    return ok({ version: pkg.version ?? "unknown", upstream: "cmuxlayer" });
  } catch {
    return ok({ version: "unknown", upstream: "cmuxlayer" });
  }
}

/**
 * system.policy — Return sanitized policy (no secrets)
 */
export async function systemPolicy(
  _args: unknown,
  context: SecureToolContext,
): Promise<SystemToolResult> {
  const policy = context.policy;

  // Build sanitized view — show structure but no sensitive values
  const sanitized: Record<string, unknown> = {
    project: {
      root: policy.project.root,
      max_file_read_bytes: policy.project.max_file_read_bytes,
      max_search_results: policy.project.max_search_results,
      deny_patterns: policy.project.deny,
    },
    tools: {
      allowed: policy.tools.allow,
      require_confirmation: policy.tools.require_confirmation,
      denied: policy.tools.deny,
    },
  };

  if (policy.workspaces) {
    sanitized.workspaces = {
      allowed_prefixes: policy.workspaces.allowed_prefixes,
    };
  }

  if (policy.agents) {
    sanitized.agents = {
      allowed_prefixes: policy.agents.allowed_prefixes,
    };
  }

  if (policy.surfaces) {
    sanitized.surfaces = {
      allowed_name_prefixes: policy.surfaces.allowed_name_prefixes,
    };
  }

  if (policy.commands) {
    sanitized.commands = {
      deny_patterns_count: policy.commands.deny_patterns.length,
      require_confirmation_patterns_count: policy.commands.require_confirmation_patterns.length,
    };
  }

  if (policy.limits) {
    sanitized.limits = {
      max_output_lines: policy.limits.max_output_lines,
      max_screen_chars: policy.limits.max_screen_chars,
      max_request_body_bytes: policy.limits.max_request_body_bytes,
      tool_timeout_ms: policy.limits.tool_timeout_ms,
      max_concurrent_requests: policy.limits.max_concurrent_requests,
    };
  }

  sanitized.audit = {
    enabled: true,
    path: policy.audit?.path ?? "~/.local/share/chatgpt-mcp-cmux/audit.jsonl",
    redact_secrets: policy.audit?.redact_secrets ?? true,
    log_full_inputs: policy.audit?.log_full_inputs ?? false,
    log_input_preview_chars: policy.audit?.log_input_preview_chars ?? 300,
  };

  return ok({ policy: sanitized });
}

/**
 * system.cmux_health — Check if cmux socket exists and is reachable
 */
export async function systemCmuxHealth(
  _args: unknown,
  _context: SecureToolContext,
): Promise<SystemToolResult> {
  const socketPaths: string[] = [];

  // Check CMUX_SOCKET_PATH env
  if (process.env.CMUX_SOCKET_PATH) {
    socketPaths.push(process.env.CMUX_SOCKET_PATH);
  }

  // Common socket paths
  const commonPaths = [
    "/tmp/cmux.sock",
    "/tmp/cmuxlayer.sock",
    "/var/run/cmux.sock",
    "/usr/local/var/cmux.sock",
  ];
  for (const p of commonPaths) {
    if (!socketPaths.includes(p)) {
      socketPaths.push(p);
    }
  }

  let socketExists = false;
  let reachable = false;
  let processRunning = false;
  let foundPath: string | null = null;

  for (const socketPath of socketPaths) {
    if (existsSync(socketPath)) {
      socketExists = true;
      foundPath = socketPath;

      // Try to check if socket is reachable by running a simple cmux command
      try {
        await execFileAsync("cmux", ["--json", "list-workspaces"], {
          env: { ...process.env, CMUX_SOCKET_PATH: socketPath },
          timeout: 3000,
        });
        reachable = true;
        break;
      } catch {
        // Socket exists but not reachable with this path
      }
    }
  }

  // Check if cmux process is running
  try {
    await execFileAsync("pgrep", ["-f", "cmux"], { timeout: 2000 });
    processRunning = true;
  } catch {
    processRunning = false;
  }

  // If no socket found via file check, but env var is set, report it
  if (!foundPath && process.env.CMUX_SOCKET_PATH) {
    foundPath = process.env.CMUX_SOCKET_PATH;
  }

  return ok({
    socket_exists: socketExists,
    reachable,
    process_running: processRunning,
    socket_path: foundPath,
  });
}

/**
 * system.memory_usage — Report process memory usage
 */
export async function systemMemoryUsage(
  _args: unknown,
  _context: SecureToolContext,
): Promise<SystemToolResult> {
  const mem = process.memoryUsage();
  return ok({
    process_mb: Math.round(mem.heapUsed / 1024 / 1024),
    rss_mb: Math.round(mem.rss / 1024 / 1024),
    heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
    external_mb: Math.round(mem.external / 1024 / 1024),
  });
}
