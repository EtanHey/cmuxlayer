# metacommlayer WRITE channel — inbox dispatch (operations)

> Sterile, deterministic dispatch that replaces raw `send_to(mode:"surface")`/TUI typing. Pairs with the READ
> channel (`harness-session.ts`). Library: `src/inbox.ts`. MCP tools: `dispatch_to_agent`,
> `inbox_check`. Spike proof: `orchestrator/docs.local/handoffs/2026-06-04/metacommlayer-write-channel-SPIKE-findings.md`.
>
> **Raw-surface `send_to` is KEPT as the fallback** — this channel is additive (belt-and-suspenders) until
> proven in production. Fall back to `send_to(mode:"surface")` whenever `inbox_check` shows a wedged monitor.

## Files (per agent, EPHEMERAL plumbing — NOT BrainLayer)
- `~/.cmux/agents/<agent-id>/inbox.jsonl` — append-only dispatches.
- `~/.cmux/agents/<agent-id>/inbox.ack.jsonl` — append-only ACKs.
- `~/.cmux/agents/<agent-id>/monitor.heartbeat` — liveness.

Do NOT auto-ingest these into BrainLayer. Only messages with `persist:true` are candidates for
`brain_store`, at the caller's discretion. Keep the channel dir off any BrainLayer watch path.

## orc / lead side (the write)
- Dispatch: MCP `dispatch_to_agent { agent_id, task, from?, tag?, persist? }` (or append a line via
  the `dispatch()` lib). One record: `{ id, ts_ms, from, to, tag, task, persist? }`.
- **FM#4 — keep dispatch low-rate / batched** so the agent's Monitor doesn't trip its flood auto-stop.
- **FM#3 — detect wedged agents:** `inbox_check { agent_id, ack_timeout_ms, heartbeat_max_age_ms }`
  → `{ monitor_alive, undelivered, stale }`. Non-empty `stale` (un-acked past the timeout) or
  `monitor_alive:false` ⇒ the channel is down → **fall back to `send_to(mode:"surface")`** for that agent.
- Triage: when an agent needs orc, it dispatches to `to:"orc"`; orc's own inbox monitor + its
  existing cron-tick loop catch it. No firehose, no separate buddy/local-model.

## agent side (the read + act) — boot policy
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

## Honest latency
The file watch is sub-second; end-to-end latency = (time until the agent's current turn ends) +
(one LLM turn). Idle agent ≈ seconds; busy agent = queued until free. Dispatch cadence ≈ turn
cadence — fine for coordination, not for sub-second control.

## Per-harness status
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
