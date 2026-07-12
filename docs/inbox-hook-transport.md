# Inbox-Wake Hook Transport (B5 prototype)

> Transport for the metacommlayer WRITE channel that does **not** depend on cmux
> agent state. Born from the 2026-06-05 incident: a poisoned (error) registry
> record killed the raw-surface send fallback and a GO dispatch sat unread in
> `inbox.jsonl`.

## Two layers shipped in this PR

### 1. `dispatch_to_agent` nudge (server-side, live by default)

`dispatch_to_agent` now reports `monitor_alive` and, when the recipient's
inbox-monitor heartbeat is stale/absent (`nudge: "auto"`, the default),
best-effort types a one-line inbox pointer **directly into the agent's
surface** — resolved from the registry record regardless of lifecycle state
(error/done included; no `INTERACTIVE_STATES` gate). `nudge: "never"` restores
pure file-append semantics. A failed nudge never fails the dispatch: the inbox
file is the durable queue.

### 2. Claude Code hook script (opt-in, NOT auto-registered)

`scripts/hooks/inbox_hook.py` — one fail-open script, three events:

| Event | Behavior |
|-------|----------|
| `SessionStart` | Ensures the inbox dir, announces the channel + any already-waiting messages, and returns `watchPaths: [inbox.jsonl]` so the harness watches the file. |
| `FileChanged` | The moment a dispatch lands, injects "N undelivered message(s)" + ack instructions into context. **EXPERIMENTAL** — verify `additionalContext` is honored for this event in a live session. |
| `Stop` | Safety net: blocks the stop (`decision: "block"`) while undelivered messages exist, so an agent drains its inbox before going idle. |

Identity resolution order: `$CMUX_INBOX_ID` → `{repo}Claude-{session_id[:8]}`
(the B4 canonical scheme) → `{repo}Claude`. Reads pick the first existing dir.

## Registration (explicit decision — HOOK FILE RULE)

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

## Honest limitations

- Hooks cannot wake a **fully idle** session (no timer events; `FileChanged`
  and `Stop` fire only around session activity). For truly idle agents the
  `dispatch_to_agent` nudge (layer 1) or manual `send_to(mode:"surface")` remains the
  wake of last resort. The durable queue is always the inbox file.
- Codex/Cursor have no hook system — they keep the poll-on-turn convention
  (`replayUndelivered()` at turn start; see `recommendedCodexWatch`).

## Verification status

- 6/6 nudge tests (`tests/inbox-nudge.test.ts`), 8/8 hook smoke tests
  (`tests/inbox-hook.test.ts`) driving the script over stdin exactly as the
  harness does, including fail-open on garbage input.
- Live FileChanged wake demo: pending (tracked in the 2026-06-05 collab).
