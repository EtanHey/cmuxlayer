# Inbox dispatch (metacomm WRITE channel)

This page has two parts: the inbox channel itself (files, dispatch, the agent-side boot policy), and
the wake transport that gets an agent to read its inbox.

`dispatch_to_agent` and `inbox_check` below are internal handlers, not part of the 10 public MCP
tools; they are reachable through the `src/inbox.ts` library and the server internals.

## Part 1: the inbox channel

> Sterile, deterministic dispatch that replaces raw `send_to(mode:"surface")`/TUI typing. Pairs with the READ
> channel (`harness-session.ts`). Library: `src/inbox.ts`. Handlers: `dispatch_to_agent`,
> `inbox_check`.
>
> **Raw-surface `send_to` is KEPT as the fallback** — this channel is additive (belt-and-suspenders) until
> proven in production. Fall back to `send_to(mode:"surface")` whenever `inbox_check` shows a wedged monitor.

### Files (per agent, EPHEMERAL plumbing — NOT BrainLayer)
- `~/.cmux/agents/<agent-id>/inbox.jsonl` — append-only dispatches.
- `~/.cmux/agents/<agent-id>/inbox.ack.jsonl` — append-only ACKs.
- `~/.cmux/agents/<agent-id>/monitor.heartbeat` — liveness.

Do NOT auto-ingest these into BrainLayer. Only messages with `persist:true` are candidates for
`brain_store`, at the caller's discretion. Keep the channel dir off any BrainLayer watch path.

### orc / lead side (the write)
- Dispatch: the internal `dispatch_to_agent { agent_id, task, from?, tag?, persist? }` handler (or append a line via
  the `dispatch()` lib). One record: `{ id, ts_ms, from, to, tag, task, persist? }`.
- **FM#4 — keep dispatch low-rate / batched** so the agent's Monitor doesn't trip its flood auto-stop.
- **FM#3 — detect wedged agents:** `inbox_check { agent_id, ack_timeout_ms, heartbeat_max_age_ms }`
  → `{ monitor_alive, undelivered, stale }`. Non-empty `stale` (un-acked past the timeout) or
  `monitor_alive:false` ⇒ the channel is down → **fall back to `send_to(mode:"surface")`** for that agent.
- Triage: when an agent needs orc, it dispatches to `to:"orc"`; orc's own inbox monitor + its
  existing cron-tick loop catch it. No firehose, no separate buddy/local-model.

### agent side (the read + act) — boot policy
1. **On boot/arm:** `writeHeartbeat(self)`, then arm the native **Monitor** with
   `recommendedMonitorCommand(self)` (= `tail -n0 -F .../inbox.jsonl`) using **`persistent:true`**
   (FM#1 — a non-persistent monitor times out silently and misses dispatches).
2. **Replay first (FM#2):** call `replayUndelivered(self)` and act on anything already queued —
   `tail -n0` only catches appends *after* arming, so messages written while you were down are
   recovered from the acked-id set, not a tail offset.
3. **On each Monitor event:** read the new message, **act**, then `ack(self, msg.id, status)`
   (ack also refreshes the heartbeat). Process `replayUndelivered` in order to avoid gaps.
4. **FM#5 — policy:** Monitor events arrive as *system notifications*, not user input. The agent
   MUST treat an inbox event as an actionable dispatch (this is the standing instruction), not
   background noise.

### Honest latency
The file watch is sub-second; end-to-end latency = (time until the agent's current turn ends) +
(one LLM turn). Idle agent ≈ seconds; busy agent = queued until free. Dispatch cadence ≈ turn
cadence — fine for coordination, not for sub-second control.

### Per-harness status
- **Claude:** native Monitor ✅ — true async wake-up. `recommendedMonitorCommand()`, `persistent:true`.
- **Codex:** **no native Monitor → no async wake-up.** Honest finding: the inbox FILE is already the
  durable queue, so the load-bearing requirement is a **poll cadence**, NOT a bg-tail. Codex pattern =
  **poll-on-turn**: at the start of each turn (e.g. each loop tick) call `replayUndelivered(self)`,
  act, `ack()`. This reuses the universal lib with zero Codex-specific code. `recommendedCodexWatch()`
  (bg-tail → `inbox.surfaced.log`) is OPTIONAL continuous capture only — it does NOT wake an idle
  Codex. **Residual:** a truly-idle, non-looping Codex still needs a turn trigger; that one case is
  where raw-surface `send_to` (the kept fallback) remains required. Deterministic dispatch for a *looping*
  Codex is fully covered (latency = next tick).
- **Cursor:** same as Codex — no native async Monitor; poll-on-turn via `replayUndelivered`. TBD which
  Cursor surface/loop drives the cadence.

## Part 2: the inbox-wake hook transport

> Transport for the metacommlayer WRITE channel that does **not** depend on cmux
> agent state. Born from the 2026-06-05 incident: a poisoned (error) registry
> record killed the raw-surface send fallback and a GO dispatch sat unread in
> `inbox.jsonl`.

### Two layers

#### 1. `dispatch_to_agent` nudge (server-side, live by default)

`dispatch_to_agent` now reports `monitor_alive` and, when the recipient's
inbox-monitor heartbeat is stale/absent (`nudge: "auto"`, the default),
best-effort types a one-line inbox pointer **directly into the agent's
surface** — resolved from the registry record regardless of lifecycle state
(error/done included; no `INTERACTIVE_STATES` gate). `nudge: "never"` restores
pure file-append semantics. A failed nudge never fails the dispatch: the inbox
file is the durable queue.

#### 2. Claude Code hook script (opt-in, NOT auto-registered)

`scripts/hooks/inbox_hook.py` — one fail-open script, three events:

| Event | Behavior |
|-------|----------|
| `SessionStart` | Ensures the inbox dir, announces the channel + any already-waiting messages, and returns `watchPaths: [inbox.jsonl]` so the harness watches the file. |
| `FileChanged` | The moment a dispatch lands, injects "N undelivered message(s)" + ack instructions into context. **EXPERIMENTAL** — verify `additionalContext` is honored for this event in a live session. |
| `Stop` | Safety net: blocks the stop (`decision: "block"`) while undelivered messages exist, so an agent drains its inbox before going idle. |

Identity resolution order: `$CMUX_INBOX_ID` → `{repo}Claude-{session_id[:8]}`
(the B4 canonical scheme) → `{repo}Claude`. Reads pick the first existing dir.

### Registration (explicit decision — HOOK FILE RULE)

The script ships **unregistered**. To enable for a project, add to that
project's `.claude/settings.json` (or `settings.local.json`):

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "python3 <path-to-cmuxlayer>/scripts/hooks/inbox_hook.py" }] }
    ],
    "FileChanged": [
      { "hooks": [{ "type": "command", "command": "python3 <path-to-cmuxlayer>/scripts/hooks/inbox_hook.py" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "python3 <path-to-cmuxlayer>/scripts/hooks/inbox_hook.py" }] }
    ]
  }
}
```

### Honest limitations

- Hooks cannot wake a **fully idle** session (no timer events; `FileChanged`
  and `Stop` fire only around session activity). For truly idle agents the
  `dispatch_to_agent` nudge (layer 1) or manual `send_to(mode:"surface")` remains the
  wake of last resort. The durable queue is always the inbox file.
- Codex/Cursor have no hook system — they keep the poll-on-turn convention
  (`replayUndelivered()` at turn start; see `recommendedCodexWatch`).

### Verification status

- 6/6 nudge tests (`tests/inbox-nudge.test.ts`), 8/8 hook smoke tests
  (`tests/inbox-hook.test.ts`) driving the script over stdin exactly as the
  harness does, including fail-open on garbage input.
- Live FileChanged wake demo: pending (tracked in the 2026-06-05 collab).
