# Claude Channels And Mobile Notes

## Status

cmuxlayer can now expose a Claude Code `--channels` compatible push surface for agent lifecycle updates. When `CMUXLAYER_ENABLE_CLAUDE_CHANNELS=1` is set, the stdio MCP server:

- advertises `capabilities.experimental["claude/channel"] = {}`
- sets server instructions describing the one-way channel behavior
- emits `notifications/claude/channel` for agent `spawned`, `done`, and `errored` lifecycle events

The implementation reuses the existing `AgentEngine.syncSidebar()` lifecycle dedupe, so sidebar logs and Claude channel pushes stay aligned.

## What The Channel Prototype Is Good For

Claude channels are a useful notification plane for orchestrator sessions. The current payloads carry identifier-safe metadata for `event`, `agent_id`, `repo`, `state`, `surface_id`, `model`, `cli`, and optional parent/session IDs, which is enough for:

- orchestrator awareness that a worker has started, completed, or crashed
- low-frequency status fan-out into an already-running Claude session
- eventually bridging BrainBar pub/sub events into Claude-visible `<channel>` updates

This is intentionally one-way. cmuxlayer does not register a reply tool or accept inbound channel messages.

## OpenClaw Patterns Worth Stealing

OpenClaw's mobile node pairing is the best reference point for a real cmux mobile bridge. The patterns that transfer cleanly are:

- Keep the first hop local. OpenClaw's gateway is loopback-first and only exposed remotely through an explicit transport like Tailscale Serve, Funnel, or SSH tunneling.
- Require explicit owner approval. Unknown devices do not start sending commands immediately; they enter a pending approval flow.
- Use trust on first use for the gateway itself. The iOS client stores the server fingerprint and forces a user-visible trust decision on first connect.
- Store pairing state explicitly. Pending requests, paired devices, scopes, and rotated tokens live in durable structures rather than an ad hoc boolean trust flag.
- Bound approvals by scope. Approval is not global; the granted role/scope is checked and stale approvals are invalidated when superseded.
- Make reconnect and catch-up explicit. OpenClaw treats reconnect as a stateful resume problem, not an excuse to flood replay blindly.

## What cmux Mobile Still Needs

Claude channels do not make cmux mobile "done". They help with notifications, but not with terminal transport. A serious mobile design still needs:

- A Mac-side bridge process. iOS cannot connect to cmux's local Unix socket directly, so a local bridge must translate cmuxlayer and BrainBar events into a mobile-friendly transport such as authenticated WebSocket.
- Real device pairing and approval. OpenClaw's pending-request, approval, TOFU fingerprint, scoped token, and stale-request invalidation model should be copied almost directly.
- A terminal data plane separate from channels. `notifications/claude/channel` is appropriate for coarse lifecycle events, not for high-frequency terminal output.
- Incremental terminal syncing. cmux still lacks a native pushed output subscription, so mobile terminal rendering needs either polling plus diffing or a new stream API for PTY output.
- Viewport and resize contracts. Mobile needs a clear protocol for rows, columns, scrollback windows, and reconnect snapshots.
- Multi-client control rules. If desktop and mobile can both type, the bridge needs explicit control leases or another arbitration mechanism.
- Background delivery strategy. iOS background WebSockets are unreliable; notification-only background behavior needs APNs or a similar out-of-band wake path.

## Recommended Architecture Split

Use two planes:

1. Notification plane: BrainBar pub/sub plus Claude `--channels` for low-frequency agent and orchestrator events.
2. Terminal plane: a dedicated mobile bridge that streams terminal deltas and forwards user input to cmuxlayer or cmux directly.

That split keeps Claude sessions useful as orchestrators while avoiding the mistake of treating channel notifications as a terminal streaming protocol.
