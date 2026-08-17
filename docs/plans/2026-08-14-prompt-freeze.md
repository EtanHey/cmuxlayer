# Prompt Freeze Observability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make every live permission/interactive prompt durably visible and queryable, and ensure escalation can never disappear silently when hierarchy or inbox monitoring is broken.

**Architecture:** Screen classification remains authoritative. The existing lifecycle sweep immediately persists prompt blockage on the `AgentRecord`, while the existing dwell episode controls notification timing. Escalation uses `dispatchOnce`: first to a healthy ancestor, then past prompt-blocked or unreadable ancestors, and finally to a deterministic top-level agent in the same workspace. Missing ancestors, fallback routing, and dispatch failures are persisted and logged; registry visibility never depends on inbox monitor liveness.

**Tech Stack:** TypeScript, Vitest, persisted JSON agent records, cmux live screen discovery, MCP `list_agents`, existing inbox `dispatchOnce` delivery.

---

### Task 1: Specify durable prompt visibility and query behavior

**Files:**
- Modify: `tests/agent-engine.test.ts`
- Modify: `tests/agent-registry.test.ts`
- Modify: `tests/agent-facade.test.ts`
- Modify: `tests/server.test.ts`

1. Add a failing engine test proving a real permission/interactive screen immediately writes `blocked_on_prompt: true`, even before dwell and even with `halt_escalation: false`.
2. In the same test flow, advance to a healthy working screen and prove the field clears without emitting a halt notification.
3. Add failing registry and server tests for `list_agents({ blocked_on_prompt: true })` and prove the structured summary row exposes the persisted field without requiring `detail=full`.
4. Run the focused tests and confirm RED is caused by the missing field/filter.

### Task 2: Specify every non-silent delivery path

**Files:**
- Modify: `tests/agent-engine.test.ts`

1. Add a failing parent-healthy case asserting prompt persistence plus exactly one existing-shape `dispatchOnce` message.
2. Add a failing `parent_agent_id: null` case asserting deterministic same-workspace top-level fallback delivery, a persisted missing-ancestor/fallback count, and event-log telemetry.
3. Add a failing blocked-parent case asserting the child alert reaches the next healthy ancestor; when there is no higher healthy ancestor, assert a known ancestor remains a best-effort sink and registry visibility remains true.
4. Add a failing dispatch-error/retry case: the first attempt increments delivery-failure telemetry without marking notification sent; a later sweep retries and succeeds.
5. In the same run, keep a healthy progressing agent and assert zero notifications and `blocked_on_prompt: false`.
6. Run the focused engine tests and confirm expected RED.

### Task 3: Implement the minimum durable schema and projection

**Files:**
- Modify: `src/agent-types.ts`
- Modify: `src/state-manager.ts`
- Modify: `src/agent-registry.ts`
- Modify: `src/agent-facade.ts`
- Modify: `src/event-log.ts`
- Modify: `src/server.ts`

1. Add optional/default-compatible prompt blockage, missing-ancestor/fallback count, delivery-failure count, last failure, and fallback sink fields.
2. Initialize those fields explicitly on auto-discovered and repaired records so `halt_escalation: true + parent_agent_id: null` is visibly incomplete rather than falsely healthy.
3. Add a typed halt-escalation telemetry event and append method.
4. Add `blocked_on_prompt` to `AgentFilter`, the registry filter, the `list_agents` MCP schema/cache key, and summary projection.
5. Run the schema/filter tests to GREEN.

### Task 4: Implement prompt persistence and escalation routing

**Files:**
- Modify: `src/agent-engine.ts`
- Modify: `tests/agent-engine.test.ts`

1. Parse first and persist/clear `blocked_on_prompt` before honoring notification opt-out.
2. Keep the existing dwell and deterministic message ID behavior.
3. Walk ancestors using live screen truth; skip a prompt-blocked ancestor when a higher healthy ancestor exists, while retaining known ancestors as best-effort sinks.
4. When hierarchy yields no sink, choose a deterministic top-level same-workspace fallback, preferring a screen-live orchestrator and then a known top-level record.
5. Persist and log missing-ancestor/fallback and dispatch-failure outcomes. Leave `halt_notification_sent_at` null on failure so later sweeps retry.
6. Run focused tests to GREEN, then refactor only while green.

### Task 5: Static and live verification

**Files:**
- Verify all modified source/tests
- Runtime artifacts only under predeclared literal absolute probe paths

1. State PREDICTION before targeted suite, typecheck/build, and full suite; record actual differences after each.
2. Run `git diff --check`, inspect the complete diff, and run repository verification.
3. Build the branch and invoke `dist/index.js` with `CMUXLAYER_FORCE_INPROCESS=1`.
4. Re-enumerate topology and preserve the two-column lead-left/workers-right invariant.
5. Probe real screens in one run: prompt child/healthy parent, prompt null-parent/fallback, prompt child/prompt parent, and healthy advancing agent.
6. Query `list_agents({ blocked_on_prompt: true })` for every prompt case and prove the healthy agent is excluded, independently of inbox monitor health.
7. Remove every probe surface and artifact by its predeclared literal absolute path, then re-enumerate to prove cleanup.

### Task 6: Worker PR handoff

**Files:**
- Append: `docs.local/plan/stability-v2/collab.md`

1. Run bounded local CodeRabbit review if available; address blocking findings and rerun fresh verification.
2. Read live session identity, commit with the required trailer, and push `wt/prompt-freeze`.
3. Open a signed, ready-for-review PR with exact RED/GREEN and live-probe evidence. Do not spawn reviewers and do not merge.
4. Verify PR state/head SHA, append the PR URL and evidence summary to the collab file, and stop.
