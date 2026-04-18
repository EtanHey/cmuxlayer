# Track 4: `send_to` / `wait_for` / `list_agents` Facade

## Goal

Give GUI clients a stable, agent-first control surface so they can drive `cmuxlayer` without knowing about panes, surfaces, or splits.

This track does not solve logical agent naming or auto-spawn. It standardizes the public facade around `agent_id` and keeps pane math internal.

## Current Problem

`cmuxlayer` already has most of the machinery needed for agent routing, but the public tool surface is inconsistent:

- `send_to_agent` is agent-first but exposed as a specialized engine tool rather than a stable client facade.
- `wait_for` is agent-first but optimized for engine state choreography (`target_state` required) rather than default client completion semantics.
- `list_agents` returns raw `AgentRecord`s, which leak `surface_id` and other internal fields directly to clients.
- Surface-based tools like `send_input(surface, text)` remain necessary for operators and debugging, but they should not be the default integration contract for GUI clients.

The result is that clients still have to reason about runtime topology even when they only want to talk to an agent.

## Recommended Approach

Ship a thin facade on top of the existing registry and engine:

1. Add a new public `send_to` tool.
2. Rework `wait_for` to support facade defaults while staying compatible with current agent-id routing.
3. Rework `list_agents` to return public agent objects instead of raw `AgentRecord`s.
4. Keep the raw tools (`send_to_agent`, `send_input`, `get_agent_state`, `my_agents`) for advanced and internal use.

This is the smallest change that makes `cmuxlayer` GUI-agnostic today while leaving room for a later logical-name layer.

## Alternatives Considered

### A. Add logical agent names and auto-spawn now

Pros:

- Closest to the long-term north star (`send_to(agent_name, message)`).

Cons:

- Requires a spawn recipe model that does not exist in current persisted state.
- Forces product decisions about name uniqueness, lifecycle ownership, and spawn defaults.
- Expands Track 4 into a larger orchestration redesign.

Decision: reject for this track.

### B. Tell clients to use `interact`

Pros:

- No new tools.

Cons:

- `interact` is a mixed command multiplexer, not a clear public contract.
- It still exposes action choreography instead of an obvious message-routing primitive.
- It does not fix `list_agents` leaking surface data.

Decision: reject as the primary facade.

## Public Tool Surface

### `list_agents`

Keep the tool name, but change the structured payload from raw `AgentRecord[]` to public agent objects:

```ts
type PublicAgent = {
  agent_id: string;
  repo: string;
  model: string;
  state: AgentState;
  session_id: string | null;
};
```

Filters stay the same:

- `state?`
- `repo?`
- `model?`

Structured response:

```ts
{
  ok: true,
  agents: PublicAgent[],
  count: number
}
```

No `surface_id`, `pane`, `workspace`, or other topology fields are returned here.

### `send_to`

Add a new public tool:

```ts
{
  agent_id: string,
  text: string,
  press_enter?: boolean
}
```

Behavior:

- Resolve the current route for `agent_id`.
- Return `ok: false` when `agent_id` is unknown or route resolution fails.
- Only allow interactive agents in `ready` or `idle` state.
- Send sanitized input to the routed surface.
- Optionally press enter.
- Return immediately after delivering the input; command completion is handled separately via `wait_for`.
- Return a lightweight acknowledgment containing `agent_id`.

Structured response:

```ts
{
  ok: true,
  agent_id: string
}
```

### `wait_for`

Keep the tool name, but shift it toward facade semantics.

Proposed schema:

```ts
{
  agent_id: string,
  timeout_ms?: number,
  target_state?: "ready" | "working" | "idle" | "done" | "error"
}
```

Behavior:

- `target_state` becomes optional.
- Default `target_state` is `"done"`, so GUI clients can call `wait_for(agent_id)` without learning engine choreography.
- The tool still supports explicit states for internal and advanced clients.
- The response includes the projected public agent object for the final state.

Structured response:

```ts
{
  ok: true,
  agent_id: string,
  state: AgentState,
  matched: boolean,
  elapsed: number,
  source: "immediate" | "sweep" | "timeout",
  error?: string,
  agent: PublicAgent | null
}
```

Response notes:

- `state` stays at the top level for compatibility with existing callers that already read `wait_for().state`.
- `agent` is the new first-class public object for facade clients.
- `error` is allowed with `ok: true` for non-fatal outcomes such as timeout or terminal-state mismatch. Fatal lookup or routing failures return `ok: false`.

## Agent Object Shape

The facade promotes agents as first-class objects with the following stable shape:

```ts
{
  agent_id,
  repo,
  model,
  state,
  session_id
}
```

Notes:

- `session_id` is the public projection of `cli_session_id`.
- `agent_id` remains the routing key for this track.
- `surface_id` stays internal because it is transport topology, not client identity.
- `cli`, `spawn_depth`, `quality`, and parent/child fields remain available through debug-oriented tools such as `get_agent_state` and `my_agents`.

## Routing Layer

Add a small internal projection/routing module, e.g. `src/agent-facade.ts`, with two responsibilities:

1. Project raw `AgentRecord`s into `PublicAgent`s.
2. Resolve `agent_id -> surface_id` for message delivery.

Suggested internal types:

```ts
type AgentRoute = {
  agent_id: string;
  surface_id: string;
  state: AgentState;
  session_id: string | null;
};
```

Suggested helpers:

```ts
toPublicAgent(record: AgentRecord): PublicAgent
buildRouteTable(records: AgentRecord[]): Map<string, AgentRoute>
resolveAgentRoute(records: AgentRecord[], agentId: string): AgentRoute
```

### Why a dedicated routing layer?

- It gives `server.ts` a clear boundary between public objects and internal transport state.
- It centralizes collision detection instead of scattering ad hoc lookups.
- It lets future logical-name routing swap in without rewriting every tool handler.

### Collision Handling

Even though the current registry map is keyed by `agent_id`, the facade should still reject contradictory route input:

- If two `AgentRecord`s with the same `agent_id` point to different surfaces, route construction throws.
- `send_to` and `wait_for` surface that error instead of guessing.

That guard is mostly defensive today, but it becomes important if route data later comes from multiple sources.

## Backwards Compatibility

### Keep

- `send_input(surface, text)` remains available for operators and low-level tools.
- `send_to_agent(agent_id, text)` remains available as the legacy/internal path.
- `wait_for_all`, `get_agent_state`, `my_agents`, and `interact` stay unchanged in purpose.

### Deprecate for client use

- `send_to_agent` description should explicitly say it is superseded by `send_to` for public integrations.
- `send_input(surface, text)` should remain documented as a low-level surface tool, not the preferred GUI integration path.

### Safe behavior changes

- `list_agents` becomes less detailed, but only by removing internal topology leaks.
- `wait_for` becomes easier to call because `target_state` defaults to `"done"`.

If a caller needs raw topology, `get_agent_state` and `my_agents` remain the escape hatches.

## Implementation Plan

### Files to touch

- `src/agent-types.ts`
  - add `PublicAgent` and `AgentRoute` types
- `src/agent-facade.ts`
  - add projection and routing helpers
- `src/agent-engine.ts`
  - expose projected agent listing and route resolution helpers
- `src/server.ts`
  - register `send_to`
  - project `list_agents`
  - update `wait_for` defaults and response shape
  - mark `send_to_agent` as deprecated for public use
- `src/format.ts`
  - add public-agent list formatting that does not print `surface_id`
- `tests/agent-facade.test.ts`
  - projection, routing, and collision tests
- `tests/server-agent-tools.test.ts`
  - `send_to`, `wait_for`, and `list_agents` handler behavior
- `tests/security-hardening.test.ts`
  - tool count and annotations
- `README.md`
  - tool count and public-tool docs

### Expected tool-count change

This track adds one tool:

- before: 25 tools
- after: 26 tools

## Test Plan

### Unit tests

- `toPublicAgent()` strips `surface_id` and maps `cli_session_id -> session_id`.
- `buildRouteTable()` creates a stable route per agent.
- `buildRouteTable()` allows duplicate records when they agree on the same surface.
- `buildRouteTable()` throws on duplicate `agent_id` with conflicting `surface_id`.

### Server/tool tests

- `list_agents` returns `PublicAgent[]` and does not leak `surface_id`.
- `send_to` routes to the agent’s current surface and sends sanitized input.
- `send_to(agent_id)` returns an error when the agent does not exist.
- `send_to` rejects agents that are not interactive.
- `wait_for(agent_id)` defaults to `"done"`.
- `wait_for(agent_id)` returns an error when the agent does not exist.
- `wait_for(agent_id, target_state="ready")` still works for advanced callers.

### Regression coverage

- `send_to_agent` still works.
- `get_agent_state` still returns the full internal record.
- Tool annotation coverage and total tool count stay accurate.

## Client Consumption Path

### T3 Code / DP Code flow

1. Call `list_agents()` to populate agent objects.
2. Store/display `agent_id` as the durable handle.
3. Use `send_to(agent_id, text)` to deliver prompts.
4. Use `wait_for(agent_id)` when the UI wants completion semantics.

At no point does the client need to know which surface or pane owns the agent.

## Non-Goals

- Logical worker names
- Auto-spawn on missing agent
- Deterministic group layout policy
- Portable repo launch configuration
- T3/DP-specific UI code

Those belong to later tracks.
