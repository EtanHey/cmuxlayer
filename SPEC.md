# SPEC.md — ChatGPTMCPcmux Secure MCP Gateway

## 1. Overview

Add a security layer on top of existing cmuxlayer stdio MCP mode. When `--config <policy.yaml>` is provided, the server runs in "secure ChatGPT mode" — exposing only filtered safe tools with policy/audit/redaction guards.

Without `--config`, upstream behavior is unchanged (backward compatible).

## 2. Target Command

```bash
# Local stdio with security
node dist/index.js stdio --config ~/.config/chatgpt-mcp-cmux/policy.yaml

# Or via tunnel-client --mcp-command
# Backward-compatible upstream mode (no --config = no security layer)
node dist/index.js
```

## 3. Module Structure

```
src/
  index.ts                  # Entry point: parse --config flag
  server.ts                 # Upstream: createServer() (UNMODIFIED except new export)
  server-secure.ts          # Secure server factory: createSecureServer()
  secure/
    errors.ts               # SecurityError classes
    policy-schema.ts        # Policy type definitions + Zod schemas
    policy.ts               # loadPolicy(), validatePolicy()
    tool-policy.ts          # checkToolAccess(), filterByPrefix()
    path-guard.ts           # resolveInsideProject(), isDeniedPath()
    command-guard.ts        # checkCommandText(), isDangerousPattern()
    redactor.ts             # redactSecrets(), addPattern()
    audit.ts                # AuditLogger class
    limits.ts               # truncateOutput(), enforceTimeout()
    tool-wrapper.ts         # wrapTool() central pipeline
  tools/
    secure-system-tools.ts   # system.* tool handlers
    secure-project-tools.ts  # project.* tool handlers
    secure-cmux-tools.ts     # cmux.* tool handlers (wrap upstream)
    secure-agent-tools.ts    # agent.* tool handlers (wrap upstream)
    secure-audit-tools.ts    # audit.* tool handlers
config/
  policy.example.yaml        # Example configuration
docs/
  implementation-audit.md    # (exists)
  openai-secure-mcp-tunnel.md
  chatgpt-connector.md
  security-model.md
  mcpkit-reference-audit.md
  implementation-closeout.md
scripts/
  openai-tunnel-init-stdio.sh
  openai-tunnel-doctor.sh
  openai-tunnel-run.sh
  openai-tunnel-stop.sh
  emergency-stop.sh
  smoke-stdio.sh
tests/
  security/
    errors.test.ts
    policy.test.ts
    path-guard.test.ts
    redactor.test.ts
    audit.test.ts
    command-guard.test.ts
    tool-wrapper.test.ts
    tool-policy.test.ts
```

## 4. Type Definitions

### 4.1 Policy Types (src/secure/policy-schema.ts)

```typescript
import { z } from "zod";

export const PolicySchema = z.object({
  project: z.object({
    root: z.string(),
    max_file_read_bytes: z.number().int().positive().default(200000),
    max_search_results: z.number().int().positive().default(100),
    deny: z.array(z.string()).default([]),
  }),
  workspaces: z.object({
    allowed_prefixes: z.array(z.string()).default([]),
  }).optional(),
  agents: z.object({
    allowed_prefixes: z.array(z.string()).default([]),
  }).optional(),
  surfaces: z.object({
    allowed_name_prefixes: z.array(z.string()).default([]),
  }).optional(),
  tools: z.object({
    allow: z.array(z.string()).default([]),
    require_confirmation: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
  }),
  commands: z.object({
    deny_patterns: z.array(z.string()).default([]),
    require_confirmation_patterns: z.array(z.string()).default([]),
  }).optional(),
  audit: z.object({
    path: z.string().default("~/.local/share/chatgpt-mcp-cmux/audit.jsonl"),
    redact_secrets: z.boolean().default(true),
    log_full_inputs: z.boolean().default(false),
    log_input_preview_chars: z.number().int().positive().default(300),
  }).optional(),
  limits: z.object({
    max_output_lines: z.number().int().positive().default(500),
    max_screen_chars: z.number().int().positive().default(50000),
    max_request_body_bytes: z.number().int().positive().default(100000),
    tool_timeout_ms: z.number().int().positive().default(30000),
    max_concurrent_requests: z.number().int().positive().default(5),
  }).optional(),
});

export type Policy = z.infer<typeof PolicySchema>;

export type ToolDecision = "allowed" | "denied" | "confirmation_required";

export interface AuditEvent {
  ts: string;
  request_id: string;
  client: string;
  mode: string;
  tool: string;
  target?: string;
  decision: ToolDecision | "failed" | "timeout";
  input_preview: string;
  input_hash: string;
  result: string;
  duration_ms: number;
}

export interface SecureToolContext {
  policy: Policy;
  auditLogger: AuditLogger;
  redactor: Redactor;
  requestId: string;
  mode: string;
}
```

### 4.2 Tool Wrapper Types (src/secure/tool-wrapper.ts)

```typescript
import { z } from "zod";
import type { CmuxServerContext } from "./server.js";
import type { Policy, AuditEvent, ToolDecision, SecureToolContext } from "./secure/policy-schema.js";

export type WrappedToolHandler<TInput> = (
  args: TInput,
  context: SecureToolContext,
  serverContext: CmuxServerContext,
) => Promise<WrappedToolResult>;

export interface WrappedToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

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

export function wrapTool<TInput>(
  options: ToolWrapOptions,
  context: SecureToolContext,
  serverContext: CmuxServerContext,
): { name: string; schema: z.ZodType; handler: (args: TInput) => Promise<WrappedToolResult> };
```

## 5. Module Contracts

### 5.1 errors.ts

```typescript
export class SecurityError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export class ToolDeniedError extends SecurityError {
  readonly tool: string;
  readonly reason: string;
  constructor(tool: string, reason: string);
}

export class PathDeniedError extends SecurityError {
  readonly path: string;
  constructor(path: string);
}

export class ConfirmationRequiredError extends SecurityError {
  readonly tool: string;
  constructor(tool: string);
}

export class CommandDeniedError extends SecurityError {
  readonly pattern: string;
  constructor(pattern: string);
}
```

### 5.2 policy.ts

```typescript
import type { Policy } from "./policy-schema.js";

export function loadPolicy(configPath: string): Promise<Policy>;
export function loadPolicySync(configPath: string): Policy;
export function validatePolicy(raw: unknown): Policy;
export function expandHomeDir(path: string): string;
```

### 5.3 tool-policy.ts

```typescript
import type { Policy, ToolDecision } from "./policy-schema.js";

export function checkToolAccess(toolName: string, policy: Policy): ToolDecision;
export function isAllowedPrefix(name: string, prefixes: string[]): boolean;
export function filterByPrefix<T extends { name?: string; title?: string; ref?: string }>(
  items: T[],
  prefixes: string[],
): T[];
```

### 5.4 path-guard.ts

```typescript
import type { Policy } from "./policy-schema.js";

export function resolveInsideProject(inputPath: string, policy: Policy): Promise<string>;
export function isDeniedPath(realPath: string, policy: Policy): boolean;
export function assertReadableProjectPath(inputPath: string, policy: Policy): Promise<string>;
export function matchesGlob(filePath: string, pattern: string): boolean;
```

### 5.5 command-guard.ts

```typescript
import type { Policy } from "./policy-schema.js";

export type CommandRisk = "allowed" | "denied" | "confirmation_required";

export function checkCommandText(text: string, policy: Policy, context: "terminal" | "agent_task"): CommandRisk;
export function isDangerousPattern(text: string, patterns: string[]): boolean;
```

### 5.6 redactor.ts

```typescript
export interface Redactor {
  redact(input: string): string;
  addPattern(name: string, pattern: RegExp, replacement?: string): void;
}

export function createDefaultRedactor(): Redactor;
export const DEFAULT_SECRET_PATTERNS: Array<{ name: string; pattern: RegExp; replacement: string }>;
```

### 5.7 audit.ts

```typescript
import type { AuditEvent, Policy } from "./policy-schema.js";

export interface AuditLogger {
  log(event: Omit<AuditEvent, "ts">): Promise<void>;
  logSync(event: Omit<AuditEvent, "ts">): void;
  recent(count: number): Promise<AuditEvent[]>;
}

export function createAuditLogger(policy: Policy): AuditLogger;
```

### 5.8 limits.ts

```typescript
export function truncateOutput(text: string, maxLines: number, maxChars: number): string;
export function hashInput(input: string): string;
```

## 6. Tool Name Mapping

| Upstream Name | Secure Name | Category |
|---------------|-------------|----------|
| control_health | system.cmux_health | system |
| — | system.health | system (new) |
| — | system.version | system (new) |
| — | system.policy | system (new) |
| — | system.memory_usage | system (new) |
| — | project.info | project (new) |
| — | project.tree | project (new) |
| — | project.read_file | project (new) |
| — | project.search | project (new) |
| — | project.grep | project (new) |
| — | project.git_status | project (new) |
| — | project.git_diff | project (new) |
| — | project.git_log_recent | project (new) |
| list_surfaces | cmux.list_surfaces | cmux |
| read_screen | cmux.read_screen | cmux |
| — | cmux.read_output | cmux (alias) |
| — | cmux.read_recent_activity | cmux (new) |
| — | cmux.get_agent_metadata | cmux (new) |
| list_agents | agent.list | agent |
| get_agent_state | agent.status | agent |
| read_agent_output | agent.read | agent |
| send_to | agent.send_task | agent |
| wait_for | agent.continue | agent (renamed) |
| — | agent.extract_summary | agent (new) |
| — | agent.extract_errors | agent (new) |
| — | agent.extract_next_actions | agent (new) |
| — | audit.recent | audit (new) |
| — | audit.search | audit (new) |

## 7. Tool Handler Contracts

### 7.1 System Tools

**system.health**
- Input: `{}`
- Output: `{ ok: true, service: "ChatGPTMCPcmux", mode: "stdio-secure", transport: "openai-secure-mcp-tunnel-compatible" }`

**system.version**
- Input: `{}`
- Output: `{ version: string, upstream: "cmuxlayer" }`

**system.policy**
- Input: `{}`
- Output: Sanitized policy (no secrets, show allowed tools/prefixes/limits)

**system.cmux_health**
- Input: `{}`
- Output: `{ socket_exists: boolean, reachable: boolean, process_running: boolean, socket_path: string | null }`

**system.memory_usage**
- Input: `{}`
- Output: `{ process_mb: number, cmux_mb?: number }`

### 7.2 Project Tools

**project.info**
- Input: `{}`
- Output: `{ root: string, exists: boolean, git: boolean, branch: string | null }`

**project.tree**
- Input: `{ path?: string, max_depth?: number }`
- Output: `{ entries: Array<{ name, type: "file"|"dir", path }> }`

**project.read_file**
- Input: `{ path: string }`
- Output: `{ content: string, truncated: boolean }` (redacted)

**project.search**
- Input: `{ query: string, path?: string }`
- Output: `{ matches: Array<{ file, line, text }> }`

**project.grep**
- Input: `{ pattern: string, path?: string }`
- Output: Same as project.search

**project.git_status**
- Input: `{}`
- Output: `{ branch: string, clean: boolean, changes: Array<{ status, file }> }`

**project.git_diff**
- Input: `{ path?: string }`
- Output: `{ stat: string, diff?: string }`

**project.git_log_recent**
- Input: `{ n?: number }`
- Output: `{ commits: Array<{ hash, message, date }> }`

### 7.3 Cmux Tools

**cmux.list_surfaces**
- Input: `{ workspace?: string }`
- Output: Filtered surfaces by allowed_name_prefixes

**cmux.read_screen**
- Input: `{ surface: string }`
- Output: `{ surface, parsed, delivery }` (redacted)

### 7.4 Agent Tools

**agent.list**
- Input: `{}`
- Output: `{ agents: Array<{ id, state, surface, model }> }` (filtered by prefix)

**agent.status**
- Input: `{ agent_id: string }`
- Output: `{ agent_id, state, surface, model }` or denied if not allowed prefix

**agent.read**
- Input: `{ agent_id: string }`
- Output: `{ agent_id, output: string }` (redacted)

**agent.send_task**
- Input: `{ agent_id: string, task: string }`
- Output: `{ status: "sent", agent_id }` or confirmation_required

**agent.continue**
- Input: `{ agent_id: string, instruction?: string }`
- Output: `{ status: "sent", agent_id }`

**agent.extract_summary**
- Input: `{ agent_id: string }`
- Output: `{ agent_id, summary: string }`

**agent.extract_errors**
- Input: `{ agent_id: string }`
- Output: `{ agent_id, errors: string[] }`

**agent.extract_next_actions**
- Input: `{ agent_id: string }`
- Output: `{ agent_id, actions: string[] }`

### 7.5 Audit Tools

**audit.recent**
- Input: `{ count?: number }`
- Output: `{ events: AuditEvent[] }` (redacted)

**audit.search**
- Input: `{ tool?: string, decision?: string, since?: string }`
- Output: `{ events: AuditEvent[] }` (redacted)

## 8. Integration in index.ts

When `--config` flag is present:
1. Parse config path from argv
2. Load policy via `loadPolicy()`
3. Create audit logger via `createAuditLogger()`
4. Create redactor via `createDefaultRedactor()`
5. Call `createSecureServer({ policy, auditLogger, redactor, client })` instead of `createServer()`
6. `createSecureServer` internally calls `createServer()` for upstream context, then wraps all tools

When `--config` is absent: existing behavior unchanged.

## 9. Testing Requirements

### 9.1 Unit Tests (vitest)

**path-guard.test.ts:**
- README read inside project → allowed
- .env read → denied
- ../../.ssh/id_rsa → denied
- ~/ssh → denied
- absolute /Users/.../ssh → denied
- Symlink escape → denied

**redactor.test.ts:**
- sk-... → redacted
- ghp_... → redacted
- github_pat_... → redacted
- private key block → redacted
- SUPABASE key → redacted

**command-guard.test.ts:**
- "sudo rm -rf /" in terminal → denied
- "git push" in terminal → confirmation_required
- "check for .env" in agent task → allowed (natural language)
- "read ~/.ssh" in agent task → denied

**tool-policy.test.ts:**
- allowed tool → allowed
- denied tool → denied
- unknown tool → denied
- confirmation_required tool → confirmation_required

**audit.test.ts:**
- Every tool call creates event
- Event has request_id, tool, decision
- No secrets in audit

### 9.2 Integration Tests

**tool-wrapper.test.ts:**
- allowed tool executes and returns result
- denied tool returns error without executing
- confirmation_required returns appropriate response
- output is redacted
- audit event is written
