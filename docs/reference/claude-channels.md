# Claude Channels

## Status

cmuxlayer can now expose a Claude Code `--channels` compatible push surface for agent lifecycle updates. When `CMUXLAYER_ENABLE_CLAUDE_CHANNELS=1` is set, the stdio MCP server:

- advertises `capabilities.experimental["claude/channel"] = {}`
- sets server instructions describing the one-way channel behavior
- emits `notifications/claude/channel` for agent `spawned`, `done`, and `errored` lifecycle events

The implementation reuses the existing `AgentEngine.reconcileAgents()` lifecycle dedupe, so lifecycle logs and Claude channel pushes stay aligned.

## What The Channel Prototype Is Good For

Claude channels are a useful notification plane for orchestrator sessions. The current payloads carry identifier-safe metadata for `event`, `agent_id`, `repo`, `state`, `surface_id`, `model`, `cli`, and optional parent/session IDs, which is enough for:

- orchestrator awareness that a worker has started, completed, or crashed
- low-frequency status fan-out into an already-running Claude session
- eventually bridging BrainBar pub/sub events into Claude-visible `<channel>` updates

This is intentionally one-way. cmuxlayer does not register a reply tool or accept inbound channel messages.
