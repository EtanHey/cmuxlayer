# Fix #333 Resync Convergence Design

## Status

Approved for implementation by the 2026-07-17 design ruling, with Etan's 400,000-token gpt-5.6 app-tier ruling folded into the same batch.

## Root cause and #333 causality audit

The timeout is caused by startup synchronously resolving transcript identity while `AgentEngine.initializeOnce()` awaits first-connect sidebar synchronization. A persisted JSONL-harness record with no `cli_session_id` and managed-launch metadata is eligible for `maybeCaptureBootSessionId()`. The production Codex resolver then recursively scans `~/.codex/sessions` and reads candidate JSONL files. That unbounded real-filesystem work delays lifecycle readiness and every tool handler that awaits it.

The accepted timeout is real, but the premise that #333 introduced the eligibility path is not supported by the source or runtime evidence:

- `v0.4.14` and #333 contain identical transcript-eligibility, capture, first-connect sidebar, and initialization code in `src/agent-engine.ts`.
- #333 added an explicit-role provider backed by `roleSurfaceOverrides`; the map is populated only by a successful managed spawn.
- In the isolated regression, a controlled runtime probe observed an empty override map while the resolver was called for `stale-left-worker` as a working Codex record with launcher `cmuxlayerCodex`.
- Repeated runs at the same #333 merge commit varied from roughly 1.5 seconds to 16.7 seconds, including both pass and timeout. A two-run version comparison was therefore timing-correlated with filesystem/cache state rather than a causal #333 state transition.

The fix still belongs in this batch because a user-sized sessions directory must not determine MCP startup/tool readiness.

## Production boundary

First-connect sidebar synchronization will skip only transcript-filesystem identity resolution. It will continue topology binding, screen-based boot capture, lifecycle reconciliation, and sidebar publication. Eligible sessionless rows remember that deferral so a same-pass transition to `done` or `error` cannot make transcript capture permanently ineligible or expose the row to the one-time stale-terminal purge. The normal sweep and explicit `captureBootSessionId()` path retain transcript resolution, so session identity is deferred rather than removed.

This is narrower than making the synchronous resolver asynchronous or adding a cross-agent cache:

- no startup await can enter the recursive sessions scan;
- first-connect terminalization cannot discard a deferred identity lookup;
- existing later-capture and resume semantics remain intact;
- screen-derived session IDs can still be captured during the boot window;
- the change is deterministic and directly testable with an injected resolver spy.

## Test hermeticity

Production-server test helpers in `resync-tool.test.ts` and the sibling server suites will inject `sessionIdentityResolver: () => null` unless a test explicitly supplies a resolver. This prevents fixtures from consulting a developer's real `~/.codex/sessions`, while preserving focused resolver tests via explicit override.

The lifecycle regression will assert both halves of the boundary:

1. `initialize()` completes without invoking an eligible transcript resolver.
2. A subsequent explicit sweep invokes that resolver, including when the row became terminal during first-connect, proving capture was deferred rather than disabled.

The resync regression remains outcome-focused and deterministic under the hermetic helper.

## gpt-5.6 window ruling

Keep an explicit gpt-5.6 rule at 400,000 with `jsonlFloor: true` in `MODEL_WINDOW_RULES`, and mirror 400,000 in the screen-parser fallback table. Although this now equals the generic gpt-5 fallback, the explicit rule preserves two important semantics:

- it documents the model-specific app-tier ruling and its provenance;
- it retains the verified JSONL floor when a lagging client reports a smaller window.

Comments will retain the prior 2026-07-11 Etan web-verification/fleet-rules attribution and add the 2026-07-15 app-tier ruling that supersedes the older 1,050,000 value for the app tier.

## Verification and delivery

Use TDD for the startup boundary and window expectations. Run focused suites first, then the required full gate:

```bash
bun run typecheck && env -u CMUX_SOCKET_PATH -u CMUX_DAEMON_SOCKET bun run test
```

The full result must be 2,210/2,210 before the ready-for-review PR is opened. The worker endpoint is PR plus review responses; cmuxLead-v2 owns merge.
