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
5. Read detailed state only when needed with `list_agents` at
   `detail:"full"` (scope it with `agent_ids`) or `read_screen`.

This path keeps pane, tab, and surface refs as transport details. Surface refs
can change after respawns, moves, reconnects, or stale terminal cleanup; an
`agent_id` is the routing handle.

After spawning, `state:"pending_verify"` in the default lean receipt means boot
submission remains unproven. Keep the agent and follow `warning`'s
`wait_for({delivery_id})` guidance (`verbose:true` exposes `spawn_state` and the
boot receipt's ID). A queued boot has no submission ID because no payload was sent;
inspect the existing pane before sending work. `boot_unsubmitted` identifies a
boot whose Return was never dispatched, with recovery scoped to the draft owner.

## Tool Choice

`wait_for({delivery_id:"<original-id>", diagnostic:"ownership"})` immediately
reports local ownership predicates without waiting, reading the pane, sending
input, binding a boot token, or updating a receipt. Caller attribution must
resolve normally; there is no caller override. Receipt identity follows the
existing delivery wait policy, but owner evidence is limited to the current
caller's entries. `owner_present:false` means no entry was found for that
caller/key or delivery ID; it says nothing about another caller's token.
Predicates distinguish `false`, `unavailable`, and `not_applicable`. A changed
snapshot returns `uncertain`. Boot first-capture compatibility is reported
without pinning the session or boot instance. Route data is retained local
metadata, not a live topology/composer check. Ownership evidence is bounded,
in memory, and can disappear with context disposal or eviction; the diagnostic
cannot identify why historical evidence was lost. `ownership_match:true` only
models the duplicate ownership gate; it never authorizes Return or proves that
this receipt can be recovered. `ownership_match:"unavailable"` means NOT_PROVEN,
not the guard's boolean verdict. The route_surface/uuid/workspace_match fields
are informational comparisons, not authorization conjuncts; a recycled ref
with the same stable UUID may report route_surface_match:false alongside a
true ownership match.

`send_to({mode:"recover_delivery", delivery_id:"<original-id>"})` currently
provides original-ID observation/refusal only. It accepts no replacement text
or target, reads retained local evidence without pane input or topology reads,
and never updates the receipt, claims ownership, types, or presses Return.
`ok:false` and `recovery_eligible:false` mean this call cannot submit; nested
`receipt` fields describe the original delivery, not input by this call.
Every outcome returns MCP `isError:true` and JSON text containing `ok:false`
and an explicit recovery refusal, including terminal and observation-only receipts.
Terminal receipts remain terminal. Queued/accepted or previously dispatched
uncertain submissions return `observe_only`. Every other case is unsupported:
even an intact complete keyed owner plus submit_dispatched:false lacks proven
durable pre-Return journalling across existing paths. Lost ownership cannot be
rebuilt from screen or receipt text. Unresolved callers receive no receipt
lookup, foreign owner evidence stays private, and worker upward-channel guards
remain enforced. Concurrent calls perform no input or receipt mutation.
This operation does not trigger the existing verifier; attributable late
acceptance settled independently by that verifier appears on a later call.

| Need | Use | Avoid |
| --- | --- | --- |
| Find available agents | `list_agents` | `list_surfaces` plus title guessing |
| Send a prompt to a managed agent | `send_to` | A remembered surface when an `agent_id` is healthy |
| Wait for agent completion | `wait_for` | Polling `read_screen` only |
| Inspect internal route/session data | `list_agents` with `agent_ids` and `detail:"full"` | Guessing from `list_surfaces` |
| Start a new managed agent | `spawn_agent` with `placement`, `workspace`, or `worktree` | A raw split unless you need a shell |
| Launch or resume with an exact shell command | `send_to(mode:"command")` | Separate text and key sends |
| Operate a raw terminal/shell | `send_to(mode:"surface"|"command"|"key")` | Agent mode without an `agent_id` |
| Close or recover a stuck pane | `read_screen`, `close_surface`, then `spawn_agent` for managed agents | Absorbing the worker task into the caller |

## Spawn Receipts

`spawn_agent` successes return at most six fields: `ok`, `agent_id`,
`surface_id`, `state`, `delivered`, and optional `warning`. `state` is the spawn
outcome, such as `started` or `boot_unsubmitted`; `delivered` is true only when
the boot prompt was verified delivered. A raw terminal has `agent_id:null`
and `delivered:false`. Follow any recovery warning on the existing pane.
If the coordination contract was not delivered, `warning` carries its note and the exact contract pointer to relay, or the issued report path and done marker when no contract file exists. On resume, relay only if the restored session lost its contract context.

Request `verbose:true` on the spawn call to include `contract_path`,
`report_path`, `done_marker`, coordination notes, transport, worktree, and
timings. The issued contract file already contains `report_path` and
`done_marker`. Failures keep full detail regardless of `verbose`.

## Handling Existing Agents

When a user names a worker by role, tab, or short ref:

1. Re-enumerate with `list_agents` and, if needed, `list_surfaces`.
2. Match by stable facts: `agent_id`, repo, role, title, and current state.
3. If there is a matching tracked agent, route through `send_to`.
4. If only a raw terminal exists, use `send_to` with a raw-surface mode and keep the operation
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

Raw-surface `send_to` modes are still the right abstraction for:

- raw shells that are not tracked agents;
- browser or terminal layout operations;
- initial agent bootstrap before an `agent_id` exists;
- exact command launch or resume flows;
- stuck-pane recovery;
- terminal menus where the user explicitly asked the controlling agent to
  operate the UI directly.

The rule is not "never use surfaces." The rule is: use agent routing for agents,
and use surface tools only when the task is actually about the terminal surface.
