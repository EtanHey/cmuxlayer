#!/usr/bin/env python3
"""cmuxlayer inbox-wake hook — transport for the metacommlayer WRITE channel
that does NOT depend on cmux agent state (Etan's idea A, 2026-06-05).

One script, three Claude Code hook events (dispatch on hook_event_name):

  SessionStart : ensure the agent's inbox dir exists, announce the channel,
                 and register inbox.jsonl in watchPaths so FileChanged fires
                 the moment a dispatch lands.
  FileChanged  : a line landed in inbox.jsonl -> inject "inbox has a message"
                 (EXPERIMENTAL: verify additionalContext is honored for this
                 event in a live session before relying on it).
  Stop         : safety net — if undelivered (un-acked) messages exist, block
                 the stop with a reason so the agent drains the inbox first.

Identity resolution (until B4 ships {golemName}-{sessionIdPrefix} everywhere):
  1. $CMUX_INBOX_ID (explicit override, set by launcher)
  2. {basename(cwd)}Claude-{session_id[:8]}   (B4 canonical scheme)
  3. {basename(cwd)}Claude                    (legacy/manual)
For reads, the first candidate with an existing inbox dir wins; SessionStart
creates the canonical (2) dir when none exists.

FAIL-OPEN: any error -> exit 0 with no output. This hook must never wedge a
session. NOT auto-registered — see docs/inbox-hook-transport.md (HOOK FILE
RULE: file exists first; registration is an explicit, separate decision).
"""

import json
import os
import sys

AGENTS_DIR = os.environ.get(
    "CMUX_AGENTS_DIR", os.path.expanduser("~/.cmux/agents")
)
MAX_PREVIEW = 200


def candidates(payload):
    ids = []
    env_id = os.environ.get("CMUX_INBOX_ID")
    if env_id:
        ids.append(env_id)
    cwd = payload.get("cwd") or os.getcwd()
    golem = os.path.basename(cwd.rstrip("/")) + "Claude"
    session_id = payload.get("session_id") or ""
    if session_id:
        ids.append(f"{golem}-{session_id[:8]}")
    ids.append(golem)
    return ids


def resolve_agent_id(payload, create=False):
    ids = candidates(payload)
    for agent_id in ids:
        if os.path.isdir(os.path.join(AGENTS_DIR, agent_id)):
            return agent_id
    canonical = ids[0]
    if create:
        os.makedirs(os.path.join(AGENTS_DIR, canonical), exist_ok=True)
    return canonical


def read_jsonl(path):
    rows = []
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    continue  # tolerate partial lines on a live channel
    except OSError:
        return []
    return rows


def undelivered(agent_id):
    base = os.path.join(AGENTS_DIR, agent_id)
    acked = {
        row.get("ack_of")
        for row in read_jsonl(os.path.join(base, "inbox.ack.jsonl"))
    }
    return [
        row
        for row in read_jsonl(os.path.join(base, "inbox.jsonl"))
        if row.get("id") not in acked
    ]


def summarize(messages):
    parts = []
    for msg in messages[:5]:
        task = str(msg.get("task", ""))[:MAX_PREVIEW]
        parts.append(f"- [{msg.get('id')}] from {msg.get('from')}: {task}")
    if len(messages) > 5:
        parts.append(f"... and {len(messages) - 5} more")
    return "\n".join(parts)


def ack_hint(agent_id):
    ack_path = os.path.join(AGENTS_DIR, agent_id, "inbox.ack.jsonl")
    return (
        "Act on each message, then append an ack per message to "
        f"{ack_path} as JSON: "
        '{"ts_ms": <now-ms>, "agent": "' + agent_id + '", '
        '"ack_of": "<message id>", "status": "done"}'
    )


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return
    event = payload.get("hook_event_name", "")

    if event == "SessionStart":
        agent_id = resolve_agent_id(payload, create=True)
        inbox = os.path.join(AGENTS_DIR, agent_id, "inbox.jsonl")
        # Touch so watchPaths has a real file to watch from t0.
        try:
            open(inbox, "a", encoding="utf-8").close()
        except OSError:
            return
        pending = undelivered(agent_id)
        context = (
            f"[cmux inbox] Your inbox id is {agent_id}; channel file {inbox} "
            "is being watched. When notified that the inbox changed, read the "
            "undelivered messages, act on them, and ack. " + ack_hint(agent_id)
        )
        if pending:
            context += (
                f"\nALREADY WAITING ({len(pending)} undelivered):\n"
                + summarize(pending)
            )
        print(
            json.dumps(
                {
                    "hookSpecificOutput": {
                        "hookEventName": "SessionStart",
                        "additionalContext": context,
                        "watchPaths": [inbox],
                    }
                }
            )
        )
        return

    if event == "FileChanged":
        agent_id = resolve_agent_id(payload)
        pending = undelivered(agent_id)
        if not pending:
            return
        print(
            json.dumps(
                {
                    "hookSpecificOutput": {
                        "hookEventName": "FileChanged",
                        "additionalContext": (
                            f"[cmux inbox] {len(pending)} undelivered "
                            f"message(s) for {agent_id}:\n"
                            + summarize(pending)
                            + "\n"
                            + ack_hint(agent_id)
                        ),
                    }
                }
            )
        )
        return

    if event == "Stop":
        agent_id = resolve_agent_id(payload)
        pending = undelivered(agent_id)
        if not pending:
            return
        print(
            json.dumps(
                {
                    "decision": "block",
                    "reason": (
                        f"[cmux inbox] {len(pending)} undelivered message(s) "
                        f"for {agent_id} — handle and ack before stopping:\n"
                        + summarize(pending)
                        + "\n"
                        + ack_hint(agent_id)
                    ),
                }
            )
        )
        return


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # FAIL-OPEN — never break a session over inbox plumbing.
        pass
    sys.exit(0)
