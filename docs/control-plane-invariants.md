# Control-Plane Invariants

Status: Phase 0 contract. This document is the canonical state-machine target for later painpoint
fixes; it does not claim current source already implements every state.

## Current Vocabulary Split

The current codebase has three related but non-equivalent vocabularies:

- Persisted lifecycle: `creating | booting | ready | working | idle | done | error`
  (`src/agent-types.ts:6-13`), with transitions in `src/agent-types.ts:199-206`.
- Parsed screen status: `frozen | thinking | working | idle | done`
  (`src/types.ts:124-129`).
- Delivery status: `delivering | delivered | failed` (`src/server.ts:219-225`).

The canonical classifier unifies these into states that are safe for routing, delivery, spawning,
recovery, and sidebar/reporting decisions.

## Canonical States

| State | Entry evidence | Exit evidence | Current representation |
| --- | --- | --- | --- |
| `unknown` | No reliable agent identity, no live-shell evidence, or unreadable/degraded evidence channel. | A stronger state-specific detector fires. | Parser agent type includes `unknown` and `detectAgentType()` falls back to it (`src/types.ts:118-123`, `src/screen-parser.ts:277-319`). Not a persisted lifecycle state (`src/agent-types.ts:6-13`). |
| `shell` | Shell prompt such as `$`, `%`, `#`, or a bare `>` without an agent identity. | Agent identity plus ready/busy/booting evidence, or dead/stale evidence. | Not modelled. Shell-like prompts currently parse as `idle` (`src/screen-parser.ts:803-807`); launch shell readiness only matches `$%#` (`src/server.ts:786-787`). |
| `agent_booting` | Managed record is `booting`, or boot prompt delivery/readiness is in progress. | Ready evidence after boot prompt submission, explicit boot failure, or dead/stale evidence. | Current name is lifecycle `booting` (`src/agent-types.ts:6-13`), with initial spawn state at `src/agent-engine.ts:2000-2007` and `boot_prompt_pending` at `src/agent-types.ts:56-57`, `src/agent-engine.ts:2030`. |
| `ready` | Agent identity plus ready prompt or proven idle/interactive state for that CLI. | Delivery starts, working/thinking marker appears, overlay/prompt appears, or route becomes dead/stale/poisoned. | Persisted as `ready` (`src/agent-types.ts:6-13`), allowed after `booting` (`src/agent-types.ts:199-204`), set after boot delivery (`src/server.ts:5064-5068`) and sweeps (`src/agent-engine.ts:1359-1374`). |
| `busy` | Working/thinking markers, active execution banners, or lifecycle `working`. | Ready/done/dead/stale evidence. | Not modelled under this name. Parsed `thinking`/`working` exist (`src/types.ts:124-129`); send routing treats non-`ready`/`idle` as non-interactive unless `allow_busy` (`src/server.ts:201`, `src/server.ts:4785-4790`). |
| `interactive_overlay` | AskUserQuestion, model picker, generic confirmation menu, or other modal/picker that captures keystrokes. | Overlay is dismissed and normal ready/busy state returns. | Not modelled. Permission is partially detected, but generic overlays are absent from current parser/patterns (`src/screen-parser.ts:168-169`, `src/screen-parser.ts:509-523`, `src/pattern-registry.ts:52-75`). |
| `permission_prompt` | Permission/approval strings such as `do you want to allow`, `allow for this session`, or `[y/n]`. | Explicit allow/deny outcome and prompt disappears. | Partially modelled as parser error `permission_prompt` and status `frozen` (`src/screen-parser.ts:168-169`, `src/screen-parser.ts:509-523`, `src/screen-parser.ts:739-741`), with parser test coverage (`tests/screen-parser.test.ts:85-99`). |
| `composer_dirty` | Submitted text tail remains visible in the composer, or long/multiline delivery was partially typed/refused before clear evidence. | Composer clear evidence plus agent identity, or explicit refusal/failure. | Not modelled as a state. Current private helper checks the submitted tail (`src/server.ts:850-860`) and submit/boot verification consumes it (`src/server.ts:1694-1735`, `src/server.ts:1989-1997`). |
| `dead` | Surface read says gone, pane closed, empty dead pane, or process/surface disappearance is positively known. | Respawn/recovery creates a new live route, or the record is terminally archived. | Partially modelled as lifecycle `error` and `pane_died` errors (`src/agent-registry.ts:101-110`, `src/server.ts:279-338`), not a distinct state. Empty submit verification returns null, not true (`src/server.ts:1686-1688`). |
| `stale_surface` | Registry route points to a surface not in the live list, or live surface has a different occupant/session. | Route is repaired from session index or resync, or delivery refuses clearly. | Partially modelled as delivery-time stale-ref guard (`src/server.ts:4703-4745`) plus durable surface/session index (`src/state-manager.ts:34-45`, `src/state-manager.ts:83-130`). |
| `poisoned_registry` | Registry records conflict, duplicate routes disagree, ghosts remain after vanished surfaces, or stale `error` state would suppress wakeups. | Reconcile/evict repairs to one route per agent, or poisoned records are isolated/refused. | Not modelled as a state. `dispatch_to_agent` bypasses lifecycle because stale `error` records previously killed wakeups (`src/server.ts:4278-4286`, `src/server.ts:4307-4313`); duplicate route rejection exists in tests (`tests/agent-facade.test.ts:95-111`). |

## Surface Topology Evidence

An empty/failed surface listing is inconclusive (`unknown`); only a non-empty topology lacking a
specific surface proves absence; stale records reap on the next non-empty scan.

## Allowed Transitions

Allowed transitions are intentionally narrower than current ad hoc state movement:

- `unknown -> shell | agent_booting | ready | busy | interactive_overlay | permission_prompt | dead | stale_surface | poisoned_registry`
- `shell -> agent_booting | ready | dead`
- `agent_booting -> ready | busy | composer_dirty | permission_prompt | interactive_overlay | dead | stale_surface | poisoned_registry`
- `ready -> busy | interactive_overlay | permission_prompt | composer_dirty | dead | stale_surface | poisoned_registry`
- `busy -> ready | interactive_overlay | permission_prompt | dead | stale_surface | poisoned_registry`
- `interactive_overlay -> ready | busy | permission_prompt | dead | stale_surface`
- `permission_prompt -> ready | busy | interactive_overlay | dead | stale_surface`
- `composer_dirty -> ready | busy | permission_prompt | interactive_overlay | dead | stale_surface`
- `dead -> agent_booting | poisoned_registry`
- `stale_surface -> ready | agent_booting | dead | poisoned_registry`
- `poisoned_registry -> unknown | ready | dead | stale_surface`

Terminal lifecycle states such as `done` remain lifecycle/reporting outcomes; delivery must still
classify their backing control-plane route before sending or closing.

## Fixture Pass/Fail Criteria

| Fixture | Desired state/refusal | Pass criterion |
| --- | --- | --- |
| `claude-ask-user-question-overlay.txt` | `interactive_overlay`, `blocked_by_interactive_prompt` | Normal delivery refuses, does not send keystrokes, and never reports `submit_verified:true`. |
| `claude-permission-confirmation.txt` | `permission_prompt`, `blocked_by_permission_prompt` | Parser preserves Claude identity and permission evidence; delivery refuses as permission-blocked, not generic frozen/idle. |
| `boot-prompt-typed-not-submitted.json` | `composer_dirty` plus `agent_booting` | Pending text remains visible, boot prompt is not silently marked delivered, and record does not transition to `ready`. |
| `bare-shell-and-bare-gemini-prompt.txt` | `shell` | Bare shell/`>` prompts never become `ready` without agent identity, including sweep ready patterns. |
| `empty-dead-pane-submit.json` | `dead` | Empty/gone pane submit verification returns null/false or `pane_died`, never `submit_verified:true`. |
| `stale-surface-after-respawn.json` | `stale_surface` | Route is repaired from session index or refused after rescan; no send targets the stale surface. |
| `registry-ghost-duplicate-surface.json` | `poisoned_registry` | Ghosts are evicted/isolated and duplicate conflicting routes are rejected before delivery. |
| `wrong-workspace-spawn.json` | `ready` only in intended workspace | Same-repo child inherits parent workspace; any wrong-workspace route is rejected or marked stale/poisoned. |
| `long-inline-prompt-wedge.json` | preflight refusal or `composer_dirty` | Oversized inline prompt is refused before typing unless explicitly allowed; no partial send or false submit success. |
| `multiline-payload-premature-submit.json` | paste-as-one-message or refusal | Multiline payload is pasted/chunked as one composer message with one final Enter, or refuses before typing if paste is unavailable. |

The executable Phase 0 contract lives in `tests/painpoint-replay.test.ts`. It keeps fixture loading
green and registers the desired canonical classifier assertions as `todo` until later phases add the
classifier and delivery gates.
