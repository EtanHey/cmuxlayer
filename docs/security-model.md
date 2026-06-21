# Security Model — ChatGPTMCPcmux Secure MCP Gateway

## Threat Model

ChatGPTMCPcmux operates under a **hostile-tunnel threat model**:

> **The tunnel endpoint is considered potentially hostile.**

We assume an attacker could:
- Gain access to the OpenAI tunnel cloud (compromised OpenAI infrastructure)
- Intercept traffic in transit (MITM on the tunnel)
- Forge MCP requests with arbitrary tool names and parameters
- Attempt prompt injection through ChatGPT to trick it into calling dangerous tools
- Exfiltrate data by crafting tool calls that read sensitive files
- Attempt to execute destructive commands through agent tasks

**What we trust:**
- Your local machine (the tunnel-client and ChatGPTMCPcmux run here)
- The cmux process and its agent sessions (they run on your local machine)
- The policy.yaml file (you control it)

**What we do NOT trust:**
- Anything coming through the tunnel (all requests are untrusted)
- ChatGPT's tool selection (it can be tricked by prompt injection)
- The tunnel cloud infrastructure (compromisable)

This threat model drives every design decision in the security architecture.

## Defense Layers

ChatGPTMCPcmux implements **9 defense layers**. An attacker must bypass all of them to compromise the system.

```
┌─────────────────────────────────────────────────────────┐
│  LAYER 1: Tool Name Mapping                              │
│  Upstream names → secure namespaced names               │
│  Blocks: forging of unknown/internal tool names         │
├─────────────────────────────────────────────────────────┤
│  LAYER 2: Policy Engine (deny-by-default)                │
│  Unknown tools denied by default                         │
│  Blocks: any tool not explicitly allowed                │
├─────────────────────────────────────────────────────────┤
│  LAYER 3: Prefix Filtering                               │
│  Agent/session/workspace filtering by prefix             │
│  Blocks: access to unauthorized agents/surfaces         │
├─────────────────────────────────────────────────────────┤
│  LAYER 4: Path Guard                                     │
│  Filesystem access limited to project root               │
│  Blocks: directory traversal, reading /etc, ~/.ssh      │
├─────────────────────────────────────────────────────────┤
│  LAYER 5: Command Guard                                  │
│  Filters dangerous patterns in agent tasks               │
│  Blocks: rm -rf, sudo, curl | sh, secret exfiltration   │
├─────────────────────────────────────────────────────────┤
│  LAYER 6: Redaction                                      │
│  Secrets redacted from all outputs                       │
│  Blocks: accidental API key exposure in responses       │
├─────────────────────────────────────────────────────────┤
│  LAYER 7: Output Limits                                  │
│  Truncation of oversized responses                       │
│  Blocks: DoS via massive file reads                     │
├─────────────────────────────────────────────────────────┤
│  LAYER 8: Audit Logging                                  │
│  Every tool call logged to JSONL                         │
│  Blocks: undetected probing, provides forensic trail    │
├─────────────────────────────────────────────────────────┤
│  LAYER 9: Emergency Stop                                 │
│  Immediate termination of all connections                │
│  Blocks: ongoing attacks after detection                │
└─────────────────────────────────────────────────────────┘
```

### Layer details

| Layer | File(s) | What it blocks |
|-------|---------|---------------|
| **1. Tool Name Mapping** | `src/server-secure.ts` §6 | `list_surfaces` → `cmux.list_surfaces`; raw upstream names uncallable |
| **2. Policy Engine** | `src/secure/tool-policy.ts` | Tools not in `allow` list; everything denied by default |
| **3. Prefix Filtering** | `src/secure/tool-wrapper.ts` §`checkPrefixAllowlist` | Agents/surfaces not matching `allowed_prefixes` |
| **4. Path Guard** | `src/secure/path-guard.ts` | `../../.ssh/id_rsa`, `/etc/passwd`, `~/.env`, symlinks |
| **5. Command Guard** | `src/secure/command-guard.ts` | `rm -rf`, `sudo`, `curl \| sh`, `mkfs`, secret access |
| **6. Redaction** | `src/secure/redactor.ts` | `sk-...`, `ghp_...`, private keys, env vars in output |
| **7. Output Limits** | `src/secure/limits.ts` §`truncateOutput` | Files > 200KB, responses > 500 lines / 50K chars |
| **8. Audit Logging** | `src/secure/audit.ts` | Undetected tool probing; provides full trail |
| **9. Emergency Stop** | `scripts/emergency-stop.sh` | Active compromise, unauthorized tool execution |

## Policy Engine

The policy engine is the central access control mechanism. Every tool call passes through it.

### Decision order

The engine evaluates decisions in this strict priority order:

```
1. DENY list    — if tool matches → "denied"        (highest priority)
2. ALLOW list   — if tool matches → check confirmation
3. CONFIRMATION — if tool matches → "confirmation_required"
4. DEFAULT      → "denied"                          (lowest priority)
```

This is a **deny-by-default** policy: if a tool is not explicitly allowed, it is denied.

### Policy configuration

```yaml
tools:
  allow:
    - "system.*"        # Allow all system tools
    - "project.*"       # Allow all project tools
    - "cmux.*"          # Allow all cmux tools
    - "agent.*"         # Allow all agent tools
    - "audit.*"         # Allow all audit tools
  require_confirmation:
    - "agent.send_task" # Must confirm before sending tasks
    - "agent.continue"  # Must confirm before continuing
    - "project.git_diff"# Must confirm before viewing diffs
  deny:
    - "system.memory_usage" # Explicitly deny this specific tool
```

### Prefix matching rules

The `isAllowedPrefix()` function supports:
- **Exact match**: `agent.send_task` matches only `agent.send_task`
- **Category wildcard**: `project.*` matches all `project.` tools
- **String prefix**: `claude-` matches `claude-main`, `claude-dev`, etc.
- **Global wildcard**: `*` matches everything (use with caution)

### Confirmation flow

Tools in `require_confirmation` return a special response:
```json
{
  "ok": false,
  "error": "Tool \"agent.send_task\" requires user confirmation before execution",
  "confirmation_required": true,
  "tool": "agent.send_task"
}
```

**Note**: The full interactive confirmation flow (UI prompt) is not yet implemented in the MVP. The tool returns `confirmation_required` but does not block for human input. This is a known limitation.

## Audit Log

Every tool call is recorded in a JSONL audit log. The audit log is the **source of truth** for forensic analysis.

### Location

Default: `~/.local/share/chatgpt-mcp-cmux/audit.jsonl`

Configurable in `policy.yaml`:
```yaml
audit:
  path: ~/.local/share/chatgpt-mcp-cmux/audit.jsonl
```

### Format

Each line is a JSON object:
```json
{
  "ts": "2025-01-15T09:30:00.000Z",
  "request_id": "req_1736937000000_a1b2c3d4",
  "client": "ChatGPTMCPcmux",
  "mode": "stdio-secure",
  "tool": "agent.send_task",
  "target": "claude-main",
  "decision": "allowed",
  "input_preview": "{\"agent_id\":\"claude-main\",\"task\":\"Fix the login bug\"}",
  "input_hash": "sha256:abc123...",
  "result": "{\"ok\":true,\"status\":\"sent\",\"agent_id\":\"claude-main\"}",
  "duration_ms": 45
}
```

### Fields

| Field | Description |
|-------|-------------|
| `ts` | ISO-8601 timestamp |
| `request_id` | Unique request identifier |
| `client` | Client identifier (always `ChatGPTMCPcmux`) |
| `mode` | Server mode (`stdio-secure`) |
| `tool` | Tool name that was invoked |
| `target` | Target of the tool (agent_id, surface, path) |
| `decision` | `allowed`, `denied`, `confirmation_required`, `failed`, or `timeout` |
| `input_preview` | Truncated input (secrets redacted) |
| `input_hash` | SHA-256 hash of full input (for integrity verification) |
| `result` | Result summary (secrets redacted, truncated to 2000 chars) |
| `duration_ms` | Execution time in milliseconds |

### What is logged

- Every tool invocation (allowed, denied, confirmation_required)
- Every execution failure
- Tool name, target, decision, timing
- Input preview (truncated, redacted)
- Result summary (truncated, redacted)

### What is NOT logged

- Full inputs (only hash and preview)
- Secrets (redacted before writing)
- File contents (only that a file was read)
- Agent output (only that output was read)
- API keys, tokens, or credentials (always redacted)

### Reading the audit log

```bash
# View the most recent entries
tail -20 ~/.local/share/chatgpt-mcp-cmux/audit.jsonl | jq .

# Count denied requests
grep '"decision":"denied"' ~/.local/share/chatgpt-mcp-cmux/audit.jsonl | wc -l

# Search for a specific tool
grep '"tool":"agent.send_task"' ~/.local/share/chatgpt-mcp-cmux/audit.jsonl | jq .

# Use the built-in audit tools
# audit.recent(count: 20)
# audit.search(tool: "agent.send_task", since: "2025-01-15T00:00:00Z")
```

### Log rotation

The audit log is append-only. Rotate it periodically:
```bash
# Daily rotation
mv ~/.local/share/chatgpt-mcp-cmux/audit.jsonl \
   ~/.local/share/chatgpt-mcp-cmux/audit-$(date +%Y%m%d).jsonl
gzip ~/.local/share/chatgpt-mcp-cmux/audit-$(date +%Y%m%d).jsonl
```

## Redaction

All output (tool responses and audit log entries) passes through a secret redactor.

### Redacted patterns

| Pattern | Example | Replacement |
|---------|---------|-------------|
| OpenAI API keys | `sk-abc123...` | `[REDACTED_SECRET]` |
| GitHub PAT (classic) | `ghp_xxxxxxxx...` | `[REDACTED_SECRET]` |
| GitHub PAT (fine-grained) | `github_pat_xxx...` | `[REDACTED_SECRET]` |
| Tailscale keys | `tskey-xxx...` | `[REDACTED_SECRET]` |
| `OPENAI_API_KEY=...` | `OPENAI_API_KEY=sk-...` | `OPENAI_API_KEY=[REDACTED_SECRET]` |
| `ANTHROPIC_API_KEY=...` | `ANTHROPIC_API_KEY=sk-ant-...` | `ANTHROPIC_API_KEY=[REDACTED_SECRET]` |
| `DEEPSEEK_API_KEY=...` | `DEEPSEEK_API_KEY=sk-...` | `DEEPSEEK_API_KEY=[REDACTED_SECRET]` |
| `SUPABASE_SERVICE_ROLE_KEY=...` | `SUPABASE_SERVICE_ROLE_KEY=eyJ...` | `SUPABASE_SERVICE_ROLE_KEY=[REDACTED_SECRET]` |
| `AWS_SECRET_ACCESS_KEY=...` | `AWS_SECRET_ACCESS_KEY=AKIA...` | `AWS_SECRET_ACCESS_KEY=[REDACTED_SECRET]` |
| Private key blocks | `-----BEGIN RSA PRIVATE KEY-----...` | `[REDACTED_SECRET]` |
| Bearer tokens | `Bearer eyJhbG...` | `Bearer [REDACTED_SECRET]` |
| Authorization headers | `Authorization: Basic dXNlcjphZG1pbg==` | `Authorization: [REDACTED_SECRET]` |

### Idempotency

Redaction is idempotent: `redact(redact(text)) === redact(text)`. The replacement string `[REDACTED_SECRET]` never matches any secret pattern, so repeated redaction is a no-op.

### Custom patterns

Add custom redaction patterns at runtime via the policy or programmatically:
```typescript
import { createDefaultRedactor } from "./src/secure/redactor.js";
const redactor = createDefaultRedactor();
redactor.addPattern("custom_token", /ctkn_[A-Za-z0-9]{20,}/g);
```

### Audit-specific redaction

The audit logger has its own inline redactor (in `src/secure/audit.ts`) that applies the same patterns to `input_preview` and `result` fields before writing to disk. This prevents circular dependencies between the audit and redactor modules.

## Path Guard

The path guard ensures all filesystem access stays within the configured project root.

### What it blocks

| Attack | Example | Blocked by |
|--------|---------|-----------|
| Directory traversal | `../../.ssh/id_rsa` | `resolveInsideProject()` |
| Home directory access | `~/.ssh/authorized_keys` | Home-dir check |
| Absolute path escape | `/etc/passwd` | `isInsideRoot()` check |
| Symlink escape | Symlink pointing outside project | `realpath()` resolution |
| Sensitive file access | `.env.local` | `isDeniedPath()` glob matching |

### How it works

1. **Resolve**: `resolveInsideProject(inputPath, policy)` → resolves to absolute path, checks it's inside `project.root`
2. **Validate**: `isDeniedPath(resolvedPath, policy)` → checks against deny globs
3. **Assert**: `assertReadableProjectPath(inputPath, policy)` → combines both, throws `PathDeniedError` on failure

### Deny patterns

Default deny globs from `config/policy.example.yaml`:
```yaml
project:
  deny:
    - "*.pem"
    - "*.key"
    - ".env*"
    - "id_rsa*"
    - "id_ed25519*"
    - "known_hosts"
    - ".ssh/"
    - "node_modules/"
    - ".git/"
```

Always-denied basenames (hardcoded, regardless of policy):
- `.env`, `.env.local`, `.env.production`, `.env.development`, `.env.staging`, `.env.test`

### Glob matching

The path guard supports standard glob syntax:
- `*` — matches any sequence except `/`
- `**` — matches any sequence including `/`
- `?` — matches a single character except `/`

Examples:
```
node_modules/**    → matches node_modules/foo/bar.js
*.pem              → matches any .pem file
.env*              → matches .env, .env.local, .env.production
```

## Command Guard

The command guard assesses text input for dangerous patterns. It operates in two contexts with different strictness levels.

### Terminal context (`"terminal"`)

Text is treated as a **literal shell command**. Applied strictly:
1. Matches `deny_patterns` → `denied`
2. Matches `require_confirmation_patterns` → `confirmation_required`
3. Otherwise → `allowed`

### Agent-task context (`"agent_task"`)

Text is treated as a **natural language task description**. Applied smartly:
1. Direct destructive commands → `denied`
2. Discussion about dangerous commands → `allowed` (e.g., "check if rm -rf appears in the codebase")
3. Direct execution requests → `confirmation_required`
4. Otherwise → `allowed`

### Discussion indicators

The guard recognizes phrases that indicate discussion rather than execution:
- "check if", "look for", "search for", "find", "detect", "scan"
- "review", "audit", "analyse", "examine", "inspect"
- "show me", "tell me", "what is", "how does", "explain"
- "in the code", "in the project", "in the repository"
- "appears in", "used in", "mentioned", "contains"

Example: `"Check if rm -rf appears in any deploy scripts"` → **allowed** (discussion)

### Direct command indicators

Phrases that indicate direct execution:
- "run ", "execute ", "do ", "perform ", "launch "
- Command verbs: `sudo `, `rm `, `git push`, `docker `, `kubectl `

Example: `"run rm -rf /tmp/old-builds"` → **confirmation_required**

### Always-denied commands

These commands are always denied regardless of natural language framing:
- `cat ~/.ssh/`, `cat /root/.ssh/`, `cat /etc/shadow`, `cat /etc/passwd`
- `printenv`, `env |`, `echo $`
- `curl -`, `wget -`, `nc -`, `telnet `, `scp `, `sftp `, `rsync -`
- `dd if=`, `mkfs.`, `> /dev/sd`, `:(){ :|:& };:`
- `chmod -R 777 /`, `chown -R`

### Default deny patterns

```yaml
commands:
  deny_patterns:
    - 'rm\s+-rf'
    - '>\s*/dev/null'
    - 'curl.*\|.*sh'
    - 'wget.*\|.*sh'
    - '\bsudo\b'
    - '\bmkfs\b'
    - 'dd\s+if='
    - '\beval\b'
    - 'base64\s+--decode'
    - '~/.ssh'
    - '/etc/shadow'
    - '/etc/passwd'

  require_confirmation_patterns:
    - 'git\s+push'
    - 'git\s+.*force'
    - 'npm\s+publish'
    - '\bdocker\b'
    - '\bkubectl\b'
```

## Tool Name Mapping

Upstream tools use flat names (e.g., `list_surfaces`). Secure mode uses **namespaced names** (e.g., `cmux.list_surfaces`). This mapping prevents direct invocation of upstream tools.

### Mapping table

| Upstream Name | Secure Name | Category | Notes |
|--------------|-------------|----------|-------|
| `control_health` | `system.cmux_health` | system | Renamed and namespaced |
| — | `system.health` | system | New (secure gateway health) |
| — | `system.version` | system | New |
| — | `system.policy` | system | New (sanitized policy view) |
| — | `system.memory_usage` | system | New |
| — | `project.info` | project | New |
| — | `project.tree` | project | New |
| — | `project.read_file` | project | New |
| — | `project.search` | project | New |
| — | `project.grep` | project | New |
| — | `project.git_status` | project | New |
| — | `project.git_diff` | project | New |
| — | `project.git_log_recent` | project | New |
| `list_surfaces` | `cmux.list_surfaces` | cmux | Namespaced |
| `read_screen` | `cmux.read_screen` | cmux | Namespaced |
| — | `cmux.read_output` | cmux | New (alias for read_screen) |
| — | `cmux.read_recent_activity` | cmux | New |
| — | `cmux.get_agent_metadata` | cmux | New |
| `list_agents` | `agent.list` | agent | Namespaced |
| `get_agent_state` | `agent.status` | agent | Renamed |
| `read_agent_output` | `agent.read` | agent | Renamed |
| `send_to` | `agent.send_task` | agent | Renamed, confirmation required |
| `wait_for` | `agent.continue` | agent | Renamed |
| — | `agent.extract_summary` | agent | New |
| — | `agent.extract_errors` | agent | New |
| — | `agent.extract_next_actions` | agent | New |
| — | `audit.recent` | audit | New |
| — | `audit.search` | audit | New |

### Key principles

1. **Upstream names are uncallable** in secure mode — only the mapped secure names are registered
2. **Destructive upstream tools are not mapped** — `kill`, `stop_agent`, `close_surface`, etc. have no secure equivalent
3. **New tools are added** for security-aware operations (audit, policy inspection, extraction)
4. **Confirmation-required tools** are marked in the policy

## Emergency Stop

The emergency stop (`scripts/emergency-stop.sh`) is the final safety mechanism.

### What it does

1. **Kills tunnel-client** with `kill -9` (SIGKILL) — immediate, uninterruptible
2. **Kills ChatGPTMCPcmux** Node.js process
3. **Stops cmux agent sessions** (optional, configurable)
4. **Writes emergency audit entry** with timestamp
5. **Prints confirmation** to stdout

### When to use

- Unauthorized tool calls detected in audit log
- ChatGPT executing tools you didn't approve
- Tunnel stuck or misbehaving
- Suspected prompt injection attack
- Any situation requiring immediate disconnection

### How to use

```bash
# Run the emergency stop
./scripts/emergency-stop.sh

# Sample output
[EMERGENCY STOP] 2025-01-15T09:45:30.000Z
[EMERGENCY STOP] Killed tunnel-client (PID 12345)
[EMERGENCY STOP] Killed ChatGPTMCPcmux (PID 12346)
[EMERGENCY STOP] Audit entry written
[EMERGENCY STOP] All connections severed.
```

### After emergency stop

1. Review audit log: `tail -50 ~/.local/share/chatgpt-mcp-cmux/audit.jsonl`
2. Check what ChatGPT was doing
3. Review and tighten policy if needed
4. Restart only after understanding the incident

## MVP Limitations

The current implementation is a **Minimum Viable Product**. The following features are planned but not yet implemented:

### No interactive confirmation flow

Tools marked `confirmation_required` return a `confirmation_required: true` response but do **not** block for human input. The ChatGPT client sees the error and can ask you, but there's no automatic UI prompt.

**Workaround**: ChatGPT will see the error and can relay it to you in chat. You can then explicitly approve.

### No OAuth

Authentication is handled entirely by the tunnel-client. There is no separate OAuth flow for ChatGPTMCPcmux itself.

**Mitigation**: The tunnel-client's auth + policy engine provides sufficient access control.

### No web dashboard

There is no web-based dashboard for viewing audit logs, managing policies, or monitoring tool calls.

**Workaround**: Use the built-in audit tools:
```
audit.recent(count: 50)
audit.search(tool: "agent.send_task", since: "2025-01-15T00:00:00Z")
```

And command-line tools:
```bash
tail -f ~/.local/share/chatgpt-mcp-cmux/audit.jsonl | jq .
```

### No rate limiting

There is no built-in rate limiting for tool calls.

**Mitigation**: The `max_concurrent_requests` policy limit (default: 5) provides basic concurrency control. External rate limiting can be added at the tunnel-client level.

### No RBAC (Role-Based Access Control)

There is a single policy file. No per-user or per-role policies.

**Mitigation**: For now, use a single conservative policy. RBAC can be added in a future version.
