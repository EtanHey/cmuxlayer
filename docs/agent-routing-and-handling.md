# Agent Routing and Handling Workflow

This workflow is for MCP clients and agents using cmuxLayer to coordinate other
terminal agents. It separates stable agent routing from low-level surface
control so clients do not have to guess which pane currently owns an agent.

## Default Path: Route by Agent

Use the agent-first facade whenever the target is a tracked CLI agent.

1. Call `list_agents` to get public agent handles.
2. Pick the target `agent_id`.
3. Send work with `send_to`.
4. Wait for completion with `wait_for` when the caller needs a finished result.
5. Read detailed state only when needed with `get_agent_state` or
   `read_agent_output`.

This path keeps pane, tab, and surface refs as transport details. Surface refs
can change after respawns, moves, reconnects, or stale terminal cleanup; an
`agent_id` is the routing handle.

## Tool Choice

| Need | Use | Avoid |
| --- | --- | --- |
| Find available agents | `list_agents` | `list_surfaces` plus title guessing |
| Send a prompt to a managed agent | `send_to` | `send_input` to a remembered surface |
| Wait for agent completion | `wait_for` | Polling `read_screen` only |
| Inspect internal route/session data | `get_agent_state` | Adding topology fields to `list_agents` |
| Start a new managed agent | `spawn_agent` or `spawn_in_workspace` | Raw `new_split` unless you need a shell |
| Launch or resume with an exact shell command | `send_command` | Separate `send_input` then `send_key` |
| Operate a raw terminal/shell | `send_input`, `send_command`, `send_key` | `send_to` without an agent |
| Close or recover a stuck pane | `read_screen`, `close_surface`, `new_split` | Absorbing the worker task into the caller |

## Handling Existing Agents

When a user names a worker by role, tab, or short ref:

1. Re-enumerate with `list_agents` and, if needed, `list_surfaces`.
2. Match by stable facts: `agent_id`, repo, role, title, and current state.
3. If there is a matching tracked agent, route through `send_to`.
4. If only a raw terminal exists, use surface tools and keep the operation
   narrowly scoped to that terminal.
5. After any respawn or close/open sequence, discard old surface refs and
   re-enumerate before sending more input.

Never assume that `surface:4` still means the same runtime after a close,
reconnect, move, or restart. Treat surface refs as live transport coordinates,
not identities.

## Stuck Surface Recovery

If a terminal surface is frozen, remote control is lost, or the screen no
longer accepts input:

1. Read enough screen content to salvage important context.
2. Store or relay the recovered context if another agent will need it.
3. Close the stuck surface.
4. Open a replacement split or surface in the requested pane/location.
5. Relaunch with the exact command the user requested.
6. Verify the new surface is accepting input before sending follow-up work.

If the user says to run `orcClaude -s -c`, run exactly `orcClaude -s -c`.
Do not add model flags, sandbox flags, remote-control flags, or boot prompts
unless the user asked for them.

## Interactive Terminal Menus

`read_screen` is useful for text output, but it is not reliable proof of the
currently highlighted row in a terminal menu. For menus such as `/mcp`, `/model`,
or picker UIs:

1. Focus the exact target surface.
2. Open the menu.
3. Use rendered-window confirmation after each navigation move.
4. Before pressing Enter, verify the highlighted option is the intended option.
5. Press Enter only after that visual confirmation.
6. Verify the resulting terminal output.

For an MCP reconnect, the safe sequence is:

1. Focus the requested surface.
2. Send `/mcp`.
3. Highlight the requested server row, for example `cmuxlayer`.
4. Visually confirm the cursor is on that server row.
5. Press Enter.
6. Highlight `Reconnect`.
7. Visually confirm the cursor is on `Reconnect`, not `View tools`.
8. Press Enter.
9. Verify output such as `Reconnected to cmuxlayer`.

When multiple surfaces are requested, finish and verify one surface before
starting the next. Do not batch menu keypresses across panes.

## When Surface Tools Are Correct

Surface tools are still the right abstraction for:

- raw shells that are not tracked agents;
- browser or terminal layout operations;
- initial agent bootstrap before an `agent_id` exists;
- exact command launch or resume flows;
- stuck-pane recovery;
- terminal menus where the user explicitly asked the controlling agent to
  operate the UI directly.

The rule is not "never use surfaces." The rule is: use agent routing for agents,
and use surface tools only when the task is actually about the terminal surface.
