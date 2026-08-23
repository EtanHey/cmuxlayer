#!/usr/bin/env python3
"""Codex SessionStart hook: append this CLI session to cmuxlayer's registry.

The hook is deliberately silent and fail-open. It never guesses a session or
surface identity: without either required join field, it writes no row.
"""

import json
import os
import sys
import time

REGISTRY = os.environ.get("CMUXLAYER_SESSION_REGISTRY") or os.path.expanduser(
    "~/.cmuxlayer/session-registry.jsonl"
)


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except Exception:
        payload = {}

    session_id = payload.get("session_id") or ""
    surface_uuid = os.environ.get("CMUX_SURFACE_ID") or ""
    if not session_id or not surface_uuid:
        return

    entry = {
        "session_id": session_id,
        # Authoritative identity join: which registered pane is this?
        "surface_uuid": surface_uuid,
        "cwd": payload.get("cwd") or os.getcwd(),
        # Codex launches the command hook as its child. The parent is the live
        # CLI process; this pid plus ts is liveness evidence, never a join key.
        "pid": os.getppid(),
        "cli": "codex",
        "launcher": os.environ.get("CMUX_LAUNCHER")
        or os.environ.get("REPOGOLEM_LAUNCHER")
        or "",
        "session_path": payload.get("transcript_path") or "",
        "ts": int(time.time() * 1000),
    }
    try:
        os.makedirs(os.path.dirname(REGISTRY), exist_ok=True)
        with open(REGISTRY, "a", encoding="utf-8") as registry:
            registry.write(json.dumps(entry) + "\n")
    except Exception:
        pass


if __name__ == "__main__":
    try:
        main()
    finally:
        sys.exit(0)
