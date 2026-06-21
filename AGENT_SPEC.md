# AGENT_SPEC — ChatGPTMCPcmux Production Readiness Fixes

## User Goal
Fix all CRITICAL and HIGH defects identified in AUDIT_REPORT.md to make the project production-ready. Each worker owns a separable slice.

## Repo Facts
- **Stack:** TypeScript + Zod + MCP SDK, Node 20+, npm
- **Package manager:** npm (package-lock.json exists, NO bun.lockb)
- **Test runner:** vitest (`npm run test`, `vitest run`)
- **Build:** `npm run build` (tsc)
- **Typecheck:** `npm run typecheck` (tsc --noEmit)
- **Main repo:** /Users/danissimode/ChatGPTMCPcmux
- **Security-critical:** The security layer (src/secure/) must remain defensive, never throw to break tool execution, never leak secrets

## Architecture Decisions (must not change without approval)
1. `McpServer` from `@modelcontextprotocol/sdk` is the server framework
2. `CmuxSocketClient` / `CmuxClient` are the cmux transport layers
3. `AgentEngine` + `AgentRegistry` + `StateManager` form the agent lifecycle
4. Secure mode (`--config`) wraps standard tools via `wrapTool` in `src/secure/tool-wrapper.ts`
5. Audit logger MUST swallow errors (never break tool execution)
6. Policy YAML is parsed by a minimal inline parser (no external YAML deps)
7. All tool handlers return `{ content: TextContent[], structuredContent?, isError? }`

## Shared Interfaces (do not change signatures)
- `checkToolAccess(toolName, policy): ToolDecision` — must keep same signature
- `wrapTool(toolName, handler, context)` — must keep same signature
- `createSecureServer({ client, policyPath })` — must keep same signature
- `ok(data)` / `err(error)` helpers in server.ts — must keep same behavior
- `auditLogger.log()` / `auditLogger.logSync()` — must keep same interface

## Task Slices

### Worker 1: Security Hotfix (branch: agent/security-hotfix)
**Worktree:** `/Users/danissimode/ChatGPTMCPcmux/.worktrees/security`
**Implements:** All fixes in `src/secure/` and `config/policy.example.yaml`

**Allowed edits:**
- `src/secure/command-guard.ts` (fix wildcardToRegex, add ALWAYS_DENIED_COMMANDS)
- `src/secure/tool-wrapper.ts` (fix checkPrefixAllowlist, add max_file_read_bytes enforcement, global output limits)
- `src/secure/path-guard.ts` (fix matchGlob trailing slash, fix safeRealpath symlink, add ~user/ UNC protection)
- `src/secure/audit.ts` (fix expandHomeDir, add reverse file reading for recent())
- `src/secure/limits.ts` (increase requestId entropy to 16 bytes)
- `src/secure/policy.ts` (add warning for over-indented YAML lines)
- `src/secure/redactor.ts` (unify with audit.ts patterns, add more secret patterns)
- `src/secure/policy-schema.ts` (add `type: regex` / `type: wildcard` to command patterns, add `max_file_read_bytes` enforcement flag)
- `config/policy.example.yaml` (fix patterns to use regex or wildcard correctly, add project.* wildcard)
- `src/secure/server-secure.ts` (if exists, fix version, fix client cast, add timeout enforcement)

**Forbidden:**
- Do NOT edit `src/server.ts`, `src/agent-engine.ts`, `src/daemon.ts`
- Do NOT add external YAML parser dependency
- Do NOT change the public API of `createSecureServer` or `wrapTool`

**Validation:**
```bash
npm run build
npm run test -- tests/security/
```

**Key fixes to make (from AUDIT_REPORT):**
- CRITICAL-SEC-1: wildcardToRegex must either support true regex or document that it only supports wildcard
- CRITICAL-SEC-2: checkPrefixAllowlist must use agents.allowed_prefixes and workspaces.allowed_prefixes
- CRITICAL-SEC-3: matchGlob must handle trailing slash (treat as `/**` or strip)
- CRITICAL-SEC-4: expandHomeDir must not produce `/audit.jsonl` from `~/audit.jsonl`
- CRITICAL-SEC-5: max_file_read_bytes must be enforced in tool-wrapper
- HIGH-SEC-1: recent() must read from end of file, not entire file
- HIGH-SEC-2: truncateResult must apply limits globally across all content blocks
- HIGH-SEC-3: ALWAYS_DENIED_COMMANDS must include macOS /Users/ paths, `set`, `python -c`
- HIGH-SEC-4: safeRealpath must resolve symlinks even for non-existent paths (use lstat + readlink)

---

### Worker 2: Core Stability (branch: agent/core-stability)
**Worktree:** `/Users/danissimode/ChatGPTMCPcmux/.worktrees/core`
**Implements:** All fixes in core engine files for race conditions, unhandled rejections, protocol corruption

**Allowed edits:**
- `src/cmux-persistent-socket.ts` (fix V2→V1 queue corruption, fix connectPromise settlement on close)
- `src/daemon.ts` (fix getContext forever-rejected promise)
- `src/cmux-socket-client.ts` (fix resolveWorkspace try/catch, fix sendV1 newline injection)
- `src/agent-engine.ts` (fix waitFor setInterval race, fix assertPostSpawnLiveness void, fix stopAgent EPERM, fix createAgentSurface selectWorkspace fallback, fix resolveLauncherName try/catch, fix spawn_in_workspace rollback)
- `src/server.ts` (fix my_agents unhandled rejection, fix send_command verify_submit for short commands, fix roleSurfaceOverrides leak, fix close_surface check all agents, fix dispatch_to_agent use args.to)
- `src/event-log.ts` (fix readEntries skip malformed lines)
- `src/state-manager.ts` (fix removeState order: rmSync before eventLog.append)
- `src/harness-session.ts` (fix parseClaude token duplication)

**Forbidden:**
- Do NOT edit `src/secure/` files
- Do NOT change the signature of public API functions (createServer, createServerContext)
- Do NOT change MCP tool schemas (Zod schemas) unless the bug is in schema validation

**Validation:**
```bash
npm run build
npm run test -- tests/cmux-persistent-socket.test.ts tests/daemon.test.ts tests/agent-engine.test.ts tests/server.test.ts
```

**Key fixes to make (from AUDIT_REPORT):**
- CRITICAL-CORE-1: V2 response with unknown id must NOT go to V1 queue
- CRITICAL-CORE-2: getContext must reset contextPromise on error
- CRITICAL-CORE-3: connectPromise must be settled on 'close' event
- CRITICAL-CORE-4: my_agents must cancel readScreen on timeout or catch its rejection
- CRITICAL-CORE-5: assertPostSpawnLiveness must not be void'd
- HIGH-CORE-1: waitFor must use setTimeout with await, not setInterval
- HIGH-CORE-2: resolveWorkspace must try/catch each workspace iteration
- HIGH-CORE-3: readEntries must skip malformed JSONL lines
- HIGH-CORE-4: roleSurfaceOverrides must delete when workspace is undefined
- HIGH-CORE-5: createAgentSurface must fallback or abort on selectWorkspace failure
- MED-CORE-1: removeState must rmSync before eventLog.append
- MED-CORE-2: stopAgent must check EPERM vs ESRCH
- MED-CORE-3: resolveLauncherName must try/catch each candidate
- MED-CORE-4: close_surface must check all live agents, not just first
- MED-SEC-4: send_command must verify_submit for all commands, not just long ones
- MED-SEC-5: spawn_in_workspace must rollback (stop) already spawned agents on boot prompt failure
- MED-SEC-6: parseClaude must not double-count cache tokens
- LOW-6: dispatch_to_agent must use args.to if provided

---

### Worker 3: CI/CD & Testing (branch: agent/cicd-testing)
**Worktree:** `/Users/danissimode/ChatGPTMCPcmux/.worktrees/cicd`
**Implements:** All fixes in CI/CD, scripts, tests, and build infrastructure

**Allowed edits:**
- `.github/workflows/ci.yml` (use npm, use lockfile, add lint, add typecheck for tests)
- `.github/workflows/publish.yml` (use npm ci)
- `.github/workflows/pages.yml` (if needed)
- `scripts/release.sh` (fix URL, fix sed, fix tap)
- `scripts/run_tests.sh` (remove duplicate race-condition test, fix regression test filename)
- `scripts/smoke-stdio.sh` (fix MCP protocol: single process, stateful session)
- `scripts/emergency-stop.sh` (fix SIGKILL or description)
- `scripts/openai-tunnel-run.sh` (fix exec + trap)
- `scripts/openai-tunnel-stop.sh` (increase sleep or add loop)
- `scripts/openai-tunnel-init-stdio.sh` (quote paths with spaces)
- `scripts/generate-og.mjs` (use fs.unlinkSync instead of rm -f)
- `tests/regression/test_terminal_state.ts` → rename to `.test.ts`
- `tests/security/server-exposure.test.ts` (fix: actually call createSecureServer, remove dead code)
- `tests/server.test.ts` (reduce `as any` usage where possible, but don't break tests)
- `tests/app-server-runtime.test.ts` (reduce `as any`)
- `tests/security/limits.test.ts` (fix Date.now() race)
- `package.json` (add lint/format scripts if adding linter, fix version if needed)
- `tsconfig.json` (consider adding tsconfig.test.json)
- `tests/remote/` (remove or add placeholder)
- `.github/PULL_REQUEST_TEMPLATE.md` (fix bun test → npm test)
- `.github/CODEOWNERS` (fix to @Danissimode)
- Add `.eslintrc.json` or `biome.json` (optional but recommended)
- Add `vitest.config.ts` with coverage support (optional)

**Forbidden:**
- Do NOT change the project's runtime behavior (src/ files only for test fixes)
- Do NOT add bun as a dependency
- Do NOT remove vitest

**Validation:**
```bash
npm run build
npm run test
# Check: release.sh must be syntax-valid bash
bash -n scripts/release.sh
bash -n scripts/run_tests.sh
bash -n scripts/smoke-stdio.sh
```

**Key fixes to make (from AUDIT_REPORT):**
- CRITICAL-CI-1: release.sh URL must point to Danissimode/ChatGPTMCPcmux
- CRITICAL-CI-2: server-exposure.test.ts must actually test stdio discipline
- CRITICAL-CI-3: test_terminal_state.ts must be renamed to .test.ts
- CRITICAL-CI-4: run_tests.sh must not duplicate race-condition test
- HIGH-CI-1: ci.yml must use npm + package-lock.json
- HIGH-CI-2: publish.yml must use npm ci
- HIGH-CI-3: add tsconfig.test.json or include tests in typecheck
- HIGH-CI-4: add linter (ESLint or Biome) + format script
- HIGH-CI-5: add coverage (c8/v8) in vitest config
- MED-CI-5: release.sh sed -i '' must work on Linux (use cross-platform approach)
- MED-CI-6: limits.test.ts must avoid Date.now() race
- MED-CI-7: release.sh brew tap must point to correct owner
- CRITICAL-DOC-4: openai-tunnel-run.sh trap must work (remove exec or use subshell)
- CRITICAL-DOC-5: emergency-stop.sh must use -9 or fix description

---

### Worker 4: Documentation & Scripts (branch: agent/docs-ops)
**Worktree:** `/Users/danissimode/ChatGPTMCPcmux/.worktrees/docs`
**Implements:** All fixes in documentation, launchd, site, and operational files

**Allowed edits:**
- `SECURITY.md` (fix placeholder contact info)
- `README.md` (fix 27→28 tools count, fix empty lines, fix links if needed)
- `CONTRIBUTING.md` (fix bun → npm, fix repo URL)
- `CLAUDE.md` (update version if needed)
- `docs/` ALL files (fix contradictions, fix old URLs, fix numbers, fix tool counts, fix `/mnt/agents/` paths, fix sed commands for macOS, fix security model gaps)
- `site/` ALL files (fix 29 vs 22, fix GitHub links to Danissimode, fix layout metadata)
- `launchd/` ALL files (fix hardcoded /Users/etanheyman paths, use $HOME or install script)
- `scripts/com.cmuxlayer.mcp-reaper.plist` (fix hardcoded path)
- `config/policy.example.yaml` (fix wildcard vs regex, add project.*)
- `package.json` (fix homepage if needed, fix version)
- `.github/ISSUE_TEMPLATE/` (if needed)
- `.githooks/pre-push` (add bash check if needed)
- `docs/e2e-readiness-checklist.md` (fix version mismatch 0.2.1 vs 0.3.0)
- `docs/implementation-audit.md` (fix 33→35 tools, remove pnpm-lock mention)
- `docs/implementation-closeout.md` (fix tool counts, steps count)
- `docs/post-implementation-audit.md` (fix test counts)
- `docs/mcpkit-reference-audit.md` (fix step count)
- `docs/security-model.md` (fix always-denied commands: add `set`)
- `docs/openai-secure-mcp-tunnel.md` (fix curl with key, fix sed, fix leading spaces)
- `docs/chatgpt-connector.md` (fix .zshrc secret writing)
- `docs/e2e-readiness-checklist.md` (fix /mnt/agents/ paths)

**Forbidden:**
- Do NOT change src/ files
- Do NOT change CI/CD workflow files (owned by Worker 3)
- Do NOT change test files (owned by Worker 3)
- Do NOT change release.sh, run_tests.sh (owned by Worker 3)

**Validation:**
```bash
# Check all markdown files for broken internal links (best effort)
find docs -name "*.md" | head -5
# Check site builds (if possible)
cd site && npm install && npm run build 2>/dev/null || true
```

**Key fixes to make (from AUDIT_REPORT):**
- CRITICAL-DOC-1: SECURITY.md must have real contact info
- CRITICAL-DOC-2: launchd plist must not hardcode /Users/etanheyman
- CRITICAL-DOC-3: smoke-stdio.sh must be stateful (but this is in Worker 3 scope — skip if conflict)
- HIGH-DOC-1: README must say 28 tools (or recount)
- HIGH-DOC-2: site must have consistent number
- HIGH-DOC-3: CODEOWNERS must be @Danissimode
- HIGH-DOC-4: PR template must say npm test
- HIGH-DOC-5: release.sh references (in docs) must point to new repo
- HIGH-DOC-6: implementation-audit.md must not mention pnpm-lock
- HIGH-DOC-7: site GitHub links must point to Danissimode
- HIGH-DOC-8: openai-tunnel-init-stdio.sh must quote paths (but this is Worker 3 — skip if conflict)
- HIGH-DOC-9: docs must not have leading spaces in commands
- HIGH-DOC-10: /mnt/agents/ must be removed
- HIGH-DOC-11: version mismatch (0.2.1 vs 0.3.0) must be fixed
- MED-DOC-1: sed for macOS must be documented
- MED-DOC-2: .zshrc secret writing must be warned against
- MED-DOC-3: implementation-audit tool table must be correct
- MED-DOC-4: tunnel-stop sleep must be longer (but Worker 3 — skip)
- MED-DOC-5: generate-og.mjs rm -f (Worker 3 — skip)
- MED-DOC-6: step counts must be consistent across docs
- MED-DOC-7: 33→35 tools
- MED-DOC-8: pre-push bash check
- MED-DOC-9: security-model.md add `set`
- MED-DOC-10: policy.example.yaml use wildcard project.*

---

## Merge Order
1. **Worker 1 (security)** → first, because core may depend on security types
2. **Worker 2 (core)** → second, builds on stable security types
3. **Worker 3 (cicd)** → third, tests must pass after core fixes
4. **Worker 4 (docs)** → last, documentation is independent

## Final Verification (after all merges)
```bash
npm install
npm run build
npm run typecheck
npm run test
bash -n scripts/release.sh
bash -n scripts/run_tests.sh
bash -n scripts/smoke-stdio.sh
```

## Notes
- Each worker must read the AUDIT_REPORT.md in the main repo before starting
- Workers should commit their changes to their branch with descriptive messages
- If a worker discovers a file they need is outside their scope, they should report it, not edit it
- Do NOT add new external dependencies unless absolutely necessary and justified
- Security fixes MUST be backwards-compatible with existing policy.yaml files (or document breaking change)
