#!/usr/bin/env python3
"""SessionStart hook: boot-time SELF-REGISTRATION of the CLI session id.

orc-driver P0 (2026-07-18): cmuxlayer's session-id capture only fires on
spawn_agent, but the fleet spawns RAW — so 25/25 agents show session_id:null
and cmuxlayer falls back to scan-side cwd+recency inference (the #333 resync
wedge). This flips capture to the correct side: each session, at boot, appends
its own record to a registry file cmuxlayer reads (read-side contract v1,
cmuxLead-v2). Kills scanning, kills inference, worktree-precise, raw-spawn-safe.

Fail-OPEN always: a registration failure must never block session start.
Writes ONE JSONL line matching the agreed schema:
  {session_id, cwd, pid, cli, launcher, session_path, ts}
"""
import json
import os
import sys
import time

# Interface agreed with cmuxlayer read side (cmuxLead-v2 contract v2).
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
        return  # never fabricate either identity field

    entry = {
        "session_id": session_id,
        # PRIMARY join key (contract v2): cmux injects CMUX_SURFACE_ID into every
        # pane; cmuxlayer already keys on agent.surface_uuid. pid/cwd proved
        # unreliable in prod (AgentRecord.pid != CLI pid; launch_cwd = shell-home
        # or null), so surface_uuid is the information-theoretic join.
        "surface_uuid": surface_uuid,
        "cwd": payload.get("cwd") or os.getcwd(),  # optional secondary validator
        "pid": os.getppid(),  # telemetry only (Claude proc; no longer a join key)
        "cli": "claude",  # SessionStart fires for Claude only
        "launcher": os.environ.get("CMUX_LAUNCHER")
        or os.environ.get("REPOGOLEM_LAUNCHER")
        or "",
        # Claude's transcript_path is the analogue of Codex's rollout path.
        "session_path": payload.get("transcript_path") or "",
        "ts": int(time.time() * 1000),  # epoch MS per contract
    }
    try:
        os.makedirs(os.path.dirname(REGISTRY), exist_ok=True)
        with open(REGISTRY, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass  # fail-open


if __name__ == "__main__":
    try:
        main()
    finally:
        sys.exit(0)
