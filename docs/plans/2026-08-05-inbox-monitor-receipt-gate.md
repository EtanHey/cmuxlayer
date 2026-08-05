# Inbox Monitor Receipt Gate Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stop `dispatch_to_agent` from reporting ordinary success when no real inbox reader has ever been armed, without turning a temporarily stale reader into a fleet-wide false failure.

**Architecture:** Keep inbox-reader truth in `src/inbox.ts`, where the agent-authored heartbeat already lives. Classify the reader as `never-armed`, `alive`, or `stale`. Always preserve the durable append and existing recovery nudge, but return a non-success, non-retryable receipt for `never-armed`; stale readers retain explicit degraded success. Do not use the independent deadman registry or a server boot marker as evidence that an inbox reader exists.

**Tech Stack:** TypeScript, Vitest, MCP tool handlers.

---

### Task 1: Pin the three-state reader contract

**Files:**
- Modify: `tests/inbox.test.ts`
- Modify: `tests/inbox-nudge.test.ts`
- Modify: `tests/spawn-monitor-boot.test.ts`

**Step 1: Write the failing tests**

- Assert no agent heartbeat yields `never-armed`.
- Assert a fresh agent heartbeat yields `alive`.
- Assert an old agent heartbeat yields `stale`.
- Assert dispatch to `never-armed` returns `ok:false`, `error_code:"inbox_monitor_never_armed"`, and still appends the message durably so the fallback wake/replay path is not lost.
- Assert stale-but-previously-armed dispatch remains durable and returns an explicit degraded receipt.
- Keep the healthy dispatch regression green.
- Preserve the spawn boot-marker regression: server boot metadata alone does not make the inbox reader alive.

**Step 2: Run tests to verify RED**

Run: `TMPDIR=<isolated> bun run test -- tests/inbox.test.ts tests/inbox-nudge.test.ts tests/spawn-monitor-boot.test.ts`

Expected: FAIL because the three-state helper and receipt fields do not exist and unarmed dispatch still returns `ok:true`.

### Task 2: Implement the minimum truthful gate

**Files:**
- Modify: `src/inbox.ts`
- Modify: `src/server.ts`

**Step 1: Add the reader-state helper**

```ts
export type InboxMonitorState = "never-armed" | "alive" | "stale";

export function inboxMonitorState(
  agentId: string,
  maxAgeMs: number,
  opts?: InboxOpts,
): InboxMonitorState {
  const heartbeat = readLastAgentHeartbeat(agentId, opts);
  if (!heartbeat) return "never-armed";
  const ageMs = nowOf(opts) - heartbeat.ts_ms;
  return ageMs >= 0 && ageMs <= maxAgeMs ? "alive" : "stale";
}
```

Have `monitorAlive()` delegate to this helper so there is one classification source.

**Step 2: Make dispatch receipts reflect reader state**

- Resolve `monitor_state` before calling `dispatch()`.
- Keep the durable append and nudge behavior for all states.
- For `never-armed`, return a tool error with `error_code`, `monitor_state`, `monitor_alive:false`, the existing `dispatched:<stored message>` object, `durable:true`, and `retryable:false`; the message id tells callers not to retry and duplicate it.
- For `stale`, append durably, retain current `nudge:auto` recovery, and return `delivery_status:"queued_monitor_stale"`.
- For `alive`, append durably and return `delivery_status:"monitor_live"`.

**Step 3: Run focused tests to verify GREEN**

Run: `TMPDIR=<isolated> bun run test -- tests/inbox.test.ts tests/inbox-nudge.test.ts tests/spawn-monitor-boot.test.ts`

Expected: all focused tests pass.

### Task 3: Verify and publish the worker endpoint

**Files:**
- Verify all changed files.

**Step 1: Run repository gates**

Run:

```bash
TMPDIR=<isolated> bun run typecheck
TMPDIR=<isolated> bun run build
TMPDIR=<isolated> bun run test
TMPDIR=<isolated> bun run pre-pr
```

Expected: typecheck/build exit 0; 2,433 baseline tests plus new tests pass; pre-PR harness passes.

**Step 2: Run the daemon/client gate**

Because `src/server.ts` is MCP/daemon code, start the branch build through an isolated daemon/socket and issue real `inbox_check` and `dispatch_to_agent` requests. Verify `never-armed` is non-OK, stale is explicit/degraded, and healthy remains OK.

**Step 3: Commit, push, and open a ready PR**

Run the bounded local CodeRabbit command if available, commit only owned files, push `fix/inbox-monitor-lifecycle`, and create a ready PR. Per the worker brief, do not spawn or invoke a reviewer; post the PR URL and the unresolved lifecycle-arming architecture boundary to `@cmuxlayer` on FLEET-STANDING.
