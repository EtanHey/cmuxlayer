# Thin-core tool cut

This release keeps every cmuxlayer capability except the explicitly deleted `reorder_surface` tool registered while reducing the default MCP palette to 12 tools. The remaining definitions use `defer_loading` and stay ToolSearch-callable.

The deferral is **INTERIM and reversible**. A separate architecture decision will determine whether low-frequency operations remain MCP tools or move to CLI/programmatic surfaces.

## Default palette

`spawn_agent` · `send_to` · `wait_for` · `read_screen` · `my_agents` · `list_agents` · `broadcast` · `close_surface` · `dispatch_to_agent` · `list_surfaces` · `control_health` · `stop_agent`

## Consolidated contracts

- `send_to` accepts `mode:"agent"` (default), `mode:"surface"`, `mode:"command"`, and `mode:"key"`. Surface modes accept `target` or `surface` directly and do not require an agent-registry record.
- `spawn_agent` accepts role-driven `placement`, `workspace`, and `worktree` arguments.
- `wait_for` accepts one `agent_id` or several `ids`.

The enumerated legacy mapping contains eight names, despite the signed-off prose calling it “9→3”: `send_to_agent`, `send_input`, `send_command`, `send_key`, `new_worktree_split`, `spawn_in_workspace`, `new_split`, and `wait_for_all`. They remain callable for one release, are ToolSearch-deferred, emit runtime warnings, and carry replacement metadata. `// DRIFT: retire next release` in `src/server.ts` is the removal marker.

The signed rethink moves `interact` off the default palette and deletes `reorder_surface` entirely. The signed disposition (orc 18:09) adds `stop_agent`; with `delete_workspace` landed upstream, the reconciled inventory is therefore 12 default + 22 interim-deferred operations + 8 interim-deferred aliases = 42 registered tools.

## Representative boot receipt

Measured from the exact MCP `tools/list` JSON using UTF-8 byte length:

| | Definitions loaded at boot | Schema bytes |
| --- | ---: | ---: |
| Before (`v0.3.45`) | 42 | 50,126 |
| After | 12 | 17,282 |
| Reduction | 30 | 32,844 (65.5%) |

All 42 remaining tools are present in `tools/list`; the 30 non-default definitions carry interim `defer_loading:true` metadata for ToolSearch. `reorder_surface` is absent.

## Reference sweep

Updated in this repository:

- `README.md`
- `docs/agent-routing-and-handling.md`
- `docs/metacommlayer-inbox.md`
- `docs/inbox-hook-transport.md`

Historical design and test-plan documents retain legacy names as historical evidence. The signed-off brief retains the names because it defines the migration mapping itself.

The reachable golems skills checkout was also audited. It already had overlapping uncommitted edits in the active `cmux-agents` skill and adapters, including an in-progress `send_to_agent` → `send_to` migration, so this cmuxlayer branch did not overwrite or claim those external changes. Remaining active-skill hits are recorded for the owning golems change rather than silently edited outside this PR.
