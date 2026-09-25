# Thin-core tool cut

The current surface registers a 10-tool public MCP palette. The remaining 4 internal definitions are not registered and are not ToolSearch-callable; `reorder_surface` is explicitly deleted.

The deferral is **INTERIM and reversible**. A separate architecture decision will determine whether low-frequency operations remain MCP tools or move to CLI/programmatic surfaces.

## Default palette

`spawn_agent` · `report_to_parent` · `send_to` · `read_screen` · `list_agents` · `wait_for` · `control_health` · `close_surface` · `update_surface` · `list_surfaces`

## Consolidated contracts

- `send_to` accepts `mode:"agent"` (default), `mode:"surface"`, `mode:"command"`, and `mode:"key"`. Surface modes accept `target` or `surface` directly and do not require an agent-registry record.
  - `mode:"command"` to the caller's **own** surface (for example `/mcp reconnect <server>`) is typed with `delivery_state:"typed"` and `self_target:true`. It is expected to run when the caller's turn ends and is never submit-verified (#805).
- `spawn_agent` accepts role-driven `placement`, `workspace`, and `worktree` arguments.
  - `spawn_state:"boot_unsubmitted"` means the pane is live but the boot prompt was not verified as submitted. It keeps `ok:true`; never re-spawn. The typical case is a composer that repaints late: the prompt was typed, but it was not seen in time, so Return was never dispatched. That unsubmitted draft belongs to the **spawning caller** (#793). When `next_action` names `send_to({mode:"key",surface,text:"return"})`, that call passes the ownership guard, and a verified submit settles the boot record (`prompt_delivered:true`). The same call from any other caller is still refused with `blocked_by_foreign_draft`. Ownership lapses after 5 minutes, if the draft changes, if a newer boot of the agent replaces this one, or if the harness session changes. The one exception is spawn recording the session id for the first time; that first id is then pinned, so a later change still revokes ownership. When the caller could not be identified, `next_action` omits the key Return and says to report `boot_unsubmitted` to the lead.
- `wait_for` accepts one `agent_id` or several `ids`.
- `list_agents` rows at default detail carry `state`, `closure`, and, while a managed boot prompt is not yet verified as submitted, `boot:"unsubmitted"` (#863). In that window `state` stays `booting` even when the screen reads `working` or `ready`: the screen shows the CLI's own chrome or the unsent draft, not a tasked agent. `closure` stays `pending`, and full detail's `health` lists `boot_prompt_unsubmitted` (degraded). `boot` disappears once the registry verifies the submit (`prompt_delivered:true`). After that, the screen-derived state applies again. A `state` filter reads the same rendered state.

The enumerated legacy mapping contains eight names, despite the signed-off prose calling it “9→3”: `send_to_agent`, `send_input`, `send_command`, `send_key`, `new_worktree_split`, `spawn_in_workspace`, `new_split`, and `wait_for_all`. None of them is registered or callable through MCP. CX-3 S8 deletes the hidden definitions outright (Etan, R2-5): `new_split` and the other monitor, workspace and surface tools went in S8a-1, and the agent-family names in S8a-2. `move_surface`, `rename_tab` and `delete_workspace` became plain functions behind `update_surface` and `close_surface` in S6. The 4 that remain (`send_input`, `send_command`, `send_key`, `stop_agent`) are dispatched internally by `send_to` and `close_surface` and become plain functions in S7.

The public registry has 10 names. Source retains 14 unique internal definitions; the drift guard checks the exact public names and both counts against current documentation in CI.

## Representative boot receipt

Measured from the exact MCP `tools/list` JSON using UTF-8 byte length:

| | Definitions loaded at boot | Schema bytes |
| --- | ---: | ---: |
| Before (`v0.3.45`) | 42 | 50,126 |
| Current default | 10 | Re-measure before publishing a byte claim |

Only the exact 10-name public surface is callable; 4 internal definitions are unavailable through MCP. `reorder_surface` is absent.

## Reference sweep

Updated in this repository:

- `README.md`
- `docs/guides/agent-routing-and-handling.md`
- `docs/reference/inbox.md`

Historical design and test-plan documents retain legacy names as historical evidence. The signed-off brief retains the names because it defines the migration mapping itself.

The reachable golems skills checkout was also audited. It already had overlapping uncommitted edits in the active `cmux-agents` skill and adapters, including an in-progress `send_to_agent` → `send_to` migration, so this cmuxlayer branch did not overwrite or claim those external changes. Remaining active-skill hits are recorded for the owning golems change rather than silently edited outside this PR.
