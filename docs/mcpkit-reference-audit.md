# MCPKit Reference Analysis — Patterns Learned and Rejected

## Purpose

[MCPKit](https://github.com/keithhendry/mcpkit) is an **Apple-focused MCP server framework** that demonstrates several useful patterns for building production MCP servers. This document records our analysis of MCPKit — what to learn from it, what to reject, and what patterns to port into ChatGPTMCPcmux.

**MCPKit is a REFERENCE, not a dependency.** We do not import MCPKit, extend it, or replace our architecture with it. ChatGPTMCPcmux remains built on `cmuxlayer` as the base server, with our own security layer (`server-secure.ts` and `src/secure/`) added on top.

## What to Learn from MCPKit

### 1. Auth/entitlement check patterns

MCPKit demonstrates how to structure authentication and entitlement checks as **middleware** that runs before tool execution. Key observations:

- **Centralized auth gates**: All auth logic lives in one place, not scattered across tool handlers
- **Early rejection**: Auth failures return immediately, before any business logic runs
- **Clear error taxonomy**: Different error types for "not authenticated" vs "not authorized" vs "rate limited"

**Application in ChatGPTMCPcmux**: Our `tool-wrapper.ts` already implements this pattern — the `wrapTool()` function is the centralized gate where auth (policy check), validation (schema), and execution (handler) are composed. The `SecurityError` hierarchy in `errors.ts` provides the clear error taxonomy.

### 2. Logging/audit patterns

MCPKit uses structured logging with request IDs propagated through the call chain. Key observations:

- **Request-scoped IDs**: Every request gets a unique ID that follows it through all middleware
- **Structured output**: Logs are machine-parseable (JSON) not human-readable prose
- **Lifecycle coverage**: Every phase (start, auth, execution, response, error) is logged
- **Non-blocking**: Logging failures never break the main request flow

**Application in ChatGPTMCPcmux**: Our `AuditLogger` in `audit.ts` implements all of these:
- `request_id` generated in `createRequestId()` and propagated through `SecureToolContext`
- JSONL format (one JSON object per line, parseable by `jq`)
- Full lifecycle: decision → execution → redaction → audit write
- Failures swallowed (see `try/catch` around `auditLogger.log()` in `tool-wrapper.ts`)

### 3. Separation of concerns

MCPKit cleanly separates:
- **Auth** (who are you?) from **entitlements** (what can you do?) from **resources** (what can you access?) from **tools** (what can you invoke?)

**Application in ChatGPTMCPcmux**: Our architecture mirrors this separation:

| Concern | MCPKit approach | ChatGPTMCPcmux approach |
|---------|----------------|------------------------|
| Auth | OAuth/Apple ID | Tunnel-client handles auth with OpenAI |
| Entitlements | Per-tool permissions | `tool-policy.ts` § `checkToolAccess()` |
| Resources | File sandbox | `path-guard.ts` § `resolveInsideProject()` |
| Tools | Tool registry | `server-secure.ts` § `registerWrappedTool()` |
| Audit | Structured log | `audit.ts` § `createAuditLogger()` |

### 4. Request lifecycle instrumentation

MCPKit instruments every request with timing, input validation, and output post-processing. Key observations:

- **Pre-execution**: Input validation, auth checks, rate limiting
- **Execution**: Timed, with timeout enforcement
- **Post-execution**: Output transformation, sanitization, logging

**Application in ChatGPTMCPcmux**: The `wrapTool()` pipeline in `tool-wrapper.ts` implements a 10-step lifecycle:
1. Generate request ID
2. Check tool access (policy)
3. Check confirmation requirement
4. Check prefix allowlists (agent/surface filtering)
5. Run command guard (for text-input tools)
6. Execute handler
7. Redact output (secrets)
8. Truncate output (limits)
9. Write audit event
10. Return safe response

## What NOT to Adopt

### 1. MCPKit as server framework

**Do NOT replace cmuxlayer with MCPKit.**

MCPKit is a general-purpose MCP server framework. ChatGPTMCPcmux is built on `cmuxlayer`, which is a domain-specific MCP server for terminal multiplexer orchestration. Replacing cmuxlayer would mean:
- Losing all cmux integration (socket communication, surface management, agent lifecycle)
- Rewriting 35 upstream tool handlers
- Breaking compatibility with the existing cmux ecosystem
- Introducing a new dependency we don't control

**Our approach**: Keep `cmuxlayer` as the base. The `createSecureServer()` function in `server-secure.ts` calls `createServer()` from `server.ts` to get all upstream context, then wraps tools with our security layer. This is **composition, not replacement**.

### 2. MCPKit's tool definitions

**Do NOT use MCPKit's tool definitions.**

MCPKit defines tools as simple functions with decorators/annotations. Our tools are:
- **Wrapped upstream tools**: `agent.list` calls `list_agents` internally
- **New secure tools**: `project.read_file` doesn't exist upstream
- **Namespaced**: `cmux.list_surfaces` vs `list_surfaces`

**Our approach**: We define our own tool handlers in `src/tools/secure-*-tools.ts` that:
- Accept `SecureToolContext` (policy, audit logger, redactor)
- Call upstream functions from `cmuxlayer` where needed
- Return `WrappedToolResult` (structured, auditable)
- Are registered via `registerWrappedTool()` in `server-secure.ts`

### 3. MCPKit's file system model

**Do NOT adopt MCPKit's file sandbox model directly.**

MCPKit provides a file sandbox with resource URIs (`file:///path`). Our model is simpler:
- **Project root**: All paths are relative to `policy.project.root`
- **Path guard**: `resolveInsideProject()` ensures no escape
- **Glob deny**: `isDeniedPath()` blocks sensitive files
- **No resource URIs**: We use plain paths, validated at runtime

**Our approach**: `path-guard.ts` provides the file system boundary. It's simpler than MCPKit's model but sufficient for our threat model.

## Patterns to Port

Based on our analysis, here are the patterns from MCPKit we explicitly want to port into ChatGPTMCPcmux:

### Pattern 1: Central middleware/wrapper for tool execution

**Status**: ✅ **IMPLEMENTED** in `src/secure/tool-wrapper.ts`

The `wrapTool()` function is our central middleware. It wraps every tool handler with the full security pipeline. This is the equivalent of MCPKit's middleware chain.

```typescript
// tool-wrapper.ts — the central pipeline
export function wrapTool<TInput>(
  options: ToolWrapOptions,
  context: SecureToolContext,
  serverContext: CmuxServerContext,
): { name: string; schema: z.ZodType; handler: (args: TInput) => Promise<WrappedToolResult> };
```

Every tool goes through the same pipeline:
```
Request → checkToolAccess() → checkPrefixAllowlist() → checkCommandText()
  → execute handler → redactResult() → truncateResult() → writeAuditEvent()
  → return safe response
```

### Pattern 2: Structured audit logging

**Status**: ✅ **IMPLEMENTED** in `src/secure/audit.ts`

Our JSONL audit log follows MCPKit's structured logging pattern:

```typescript
// audit.ts
export interface AuditLogger {
  log(event: Omit<AuditEvent, "ts">): Promise<void>;
  logSync(event: Omit<AuditEvent, "ts">): void;
  recent(count: number): Promise<AuditEvent[]>;
  close(): Promise<void>;
}
```

Each event includes: timestamp, request ID, tool name, decision, input hash, result preview, duration. The format is JSONL (one JSON object per line), parseable with standard tools (`jq`, `grep`, `awk`).

### Pattern 3: Policy-based access control

**Status**: ✅ **IMPLEMENTED** in `src/secure/tool-policy.ts` and `src/secure/policy-schema.ts`

Our policy engine implements MCPKit's entitlement-check pattern:

```typescript
// tool-policy.ts
export function checkToolAccess(toolName: string, policy: Policy): ToolDecision;
```

The decision flow (deny → allow → confirmation_required → default deny) mirrors MCPKit's permission model but adapted for our YAML-driven configuration.

### Pattern 4: Secret redaction on output

**Status**: ✅ **IMPLEMENTED** in `src/secure/redactor.ts`

All output (tool responses AND audit log entries) passes through the redactor:

```typescript
// redactor.ts
export interface Redactor {
  redact(input: string): string;
  addPattern(name: string, pattern: RegExp, replacement?: string): void;
}
```

Built-in patterns cover: OpenAI keys, GitHub PATs, Tailscale keys, env var assignments, private key blocks, Bearer tokens. The redactor is idempotent and extensible.

### Pattern 5: Error taxonomy

**Status**: ✅ **IMPLEMENTED** in `src/secure/errors.ts`

Following MCPKit's clear error separation:

| Error Class | Code | When Thrown |
|-------------|------|-------------|
| `SecurityError` | varies | Base class for all security errors |
| `ToolDeniedError` | `TOOL_DENIED` | Tool not allowed by policy |
| `PathDeniedError` | `PATH_DENIED` | Path escapes project root |
| `ConfirmationRequiredError` | `CONFIRMATION_REQUIRED` | Tool needs human confirmation |
| `CommandDeniedError` | `COMMAND_DENIED` | Command matches deny pattern |
| `PolicyLoadError` | `POLICY_LOAD_ERROR` | Policy file cannot be loaded/parse |

Each error carries enough context to diagnose the issue without exposing sensitive data.

## Decision Log

### Why wrapping over rewriting

We chose to **wrap** `cmuxlayer`'s tools rather than **rewrite** the server on MCPKit:

| Factor | Wrapping (chosen) | Rewriting on MCPKit |
|--------|------------------|--------------------|
| **Time to production** | Days | Weeks |
| **Risk** | Low (proven base) | High (new framework) |
| **Upstream compatibility** | Full (same server.ts) | None (new codebase) |
| **cmux integration** | Inherited automatically | Must reimplement |
| **Tool count** | 35 upstream + 27 secure | Rewrite all 35 + 27 |
| **Maintenance burden** | Security layer only | Entire server |
| **Dependency count** | Same as cmuxlayer (+ Zod) | New framework dependency |
| **Testability** | Incremental (wrap one at a time) | Big-bang migration |

**Conclusion**: Wrapping is the pragmatic choice. It delivers a hardened MCP server in days, not weeks, with minimal risk and full upstream compatibility.

### Why stdio over HTTP

We chose **stdio transport** for the secure mode:

| Factor | stdio (chosen) | HTTP server |
|--------|---------------|-------------|
| **Attack surface** | None (no port binding) | Open port, TLS, auth needed |
| **Tunnel compatibility** | Native (tunnel-client wraps stdio) | Needs custom bridge |
| **Infrastructure** | Zero (no web server) | HTTP server, router, middleware |
| **Authentication** | Handled by tunnel-client | Must implement OAuth/API keys |
| **Complexity** | Low | High |

**Conclusion**: stdio is the right choice for a hardened local MCP server. The tunnel-client handles all networking, auth, and encryption. ChatGPTMCPcmux focuses on tool security.

### Why deny-by-default

We chose **deny-by-default** over allow-by-default:

| Factor | Deny-by-default (chosen) | Allow-by-default |
|--------|-------------------------|------------------|
| **Security posture** | Conservative, safe | Permissive, risky |
| **Configuration burden** | Must explicitly allow tools | Must explicitly deny tools |
| **Mistake cost** | Tool unavailable (safe) | Tool exposed (dangerous) |
| **Audit trail** | Clean (only allowed tools run) | Noisy (everything runs) |

**Conclusion**: Deny-by-default is the only acceptable posture for a security gateway. Every tool must be explicitly approved in policy.yaml.

## Summary

MCPKit informed our architecture but did not define it. The key lessons:

1. **Central middleware is powerful** — our `wrapTool()` pipeline is the single integration point for all security controls
2. **Structured audit logging is essential** — our JSONL audit log provides the forensic trail
3. **Separation of concerns scales** — auth, entitlements, resources, and tools are cleanly separated
4. **Composition beats replacement** — wrapping cmuxlayer is faster, safer, and more maintainable than rewriting

MCPKit showed us what a production MCP server looks like. ChatGPTMCPcmux implements those lessons in a security-focused way, purpose-built for the OpenAI Secure MCP Tunnel architecture.
