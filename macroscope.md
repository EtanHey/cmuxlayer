# cmuxlayer Review Rules

These rules apply repo-wide. Flag violations when reviewing any code in this repository.

### Security
- Never expose cmux socket paths, socket passwords, `CMUX_SOCKET_PATH`, or any auth/API tokens in logs, error messages, channel notifications, or tool output.
- cmux socket communication must validate and constrain input before forwarding it. Do not pass unchecked refs, keys, URLs, scripts, or shell fragments into socket commands, browser actions, or CLI dispatch.

### Architecture
- MCP tools in `src/server.ts` must match the cmux CLI command interface. Tools may compose existing cmux behaviors, but no tool should invent behavior that the underlying cmux CLI/socket cannot perform.
- Agent lifecycle events and state transitions must go through `AgentEngine`. Do not bypass it from server handlers, helpers, or tests when spawning agents, stopping them, mutating lifecycle state, or emitting lifecycle notifications.
- Browser automation tools must validate that the target surface exists before acting, and every non-`open` browser action must target an existing browser surface.

### Testing
- All new tools and tool behavior changes need transport-level coverage in `tests/server.test.ts`, not only engine-level or client-mock tests.
- `bun test` must pass before any pull request is opened or merged.
- `tsc --noEmit` must pass before any pull request is opened or merged.

### Style
- Keep TypeScript in strict-mode style. Do not introduce `any` unless it is unavoidable and accompanied by a short comment that justifies it.
- Tool descriptions must be clear enough for an LLM to use correctly without examples or tribal knowledge.
- Keep tool parameter schemas tight: required fields should be explicitly required, enums should be used when the value set is bounded, and format validation should happen at the schema boundary.

### Channels
- Every `notifications/claude/channel` payload must include structured metadata with at least `agent_id`, `event_type`, and `timestamp`.
- Never push terminal content over channels. Channels are for signals and lifecycle/status metadata, not terminal screen data, prompts, or other bulk terminal output.
