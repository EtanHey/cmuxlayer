# Per-seat Expected-state Manifest Design

## Purpose

Activate orchestrator's A3 resume-integrity watcher by publishing the state that cmuxlayer intentionally established for each managed seat.

## Design

Add a small `seat-manifest` module that owns the JSON contract, surface-id filename sanitization, the default orchestrator directory, and an atomic filesystem writer. Server construction accepts an injected writer; production server construction defaults to the filesystem writer, while Vitest construction defaults to a no-op so the test suite cannot touch `~/Gits/orchestrator`.

After a managed spawn is registered and renamed, the server publishes the agent record plus its actual tab title, pinned model, `-s` permission mode, launch cwd/repo, CLI session id, and timestamp. Deliberate `rename_tab` and `interact(action=model)` mutations refresh the existing manifest only after their surface operation succeeds. Both `spawn_agent` and `new_worktree_split` share the same publishing helper.

Writer failures are best-effort and logged because manifest publication must not turn a successfully created/control-plane seat into an API failure. Tests inject an in-memory writer and assert exact payloads and refresh behavior; the filesystem writer is tested only against a temporary directory.

## JSON contract

```json
{
  "surface_id": "surface:42",
  "agent_id": "cmuxlayer-codex",
  "tab_name": "cmuxlayerCodex [surface:42]",
  "session_name": "019...",
  "model": "fable-5",
  "permission_mode": "skip-permissions",
  "cwd": "/Users/etanheyman/Gits/cmuxlayer",
  "repo": "cmuxlayer",
  "cli": "codex",
  "updated_at": "2026-07-12T12:00:00.000Z"
}
```

The default path is `~/Gits/orchestrator/docs.local/monitor-state/seat-manifests/<surface>.json`; `CMUXLAYER_SEAT_MANIFEST_DIR` overrides the directory and `:` is sanitized to `-` in filenames.
