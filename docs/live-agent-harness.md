# Live Agent Harness

Deterministic, CI-adjacent live validation for cmuxlayer managed-agent lifecycle.

This harness is **not** part of normal unit CI. It drives a real cmux instance, real
agent launchers, and local auth/session state through cmuxlayer's stdio MCP server.

## What it proves

For each sequential worker the runner:

1. writes a tiny read-only goal file
2. calls `spawn_agent` with `boot_prompt_path`
3. spawns the worker with a sandboxed MCP profile by default
4. verifies managed id / launcher-model policy
5. captures verbose `list_surfaces` topology (`selected`, `column`, `column_count`)
6. waits for file-backed DONE via `wait_for(report_path, done_marker)`
7. harvests the report marker
8. closes the worker surface
9. polls cleanup until no stale managed record or worker surface remains

It writes machine JSON plus human Markdown with an exact final green/red marker.
The default artifact directory is ignored by git.

## Prerequisites

- cmux app running and reachable (socket or CLI fallback)
- repo launchers installed (`skillcreatorCursor`, etc.)
- worker repo checked out locally
- cmuxlayer built: `bun run build`

Optional:

- `CMUX_SOCKET_PATH` to pin a specific cmux instance
- `CMUXLAYER_DEV=1` if your MCP config already points at source

## Pre-PR Tier Ladder

Use the deterministic tier for normal local PR hooks and pre-push checks:

```bash
bun run pre-pr
```

This runs typecheck plus the fixture-backed harness contract tests. It is
usage-free: no cmux connection, no agent CLIs, no BrainLayer writes, and no live
worker artifacts.

The harness-only deterministic tier is:


```bash
bun run pre-pr:harness
```

This checks the Cursor, Codex, Claude, and Gemini harness contracts with
fixtures only. It does not connect to cmux, launch agent CLIs, touch BrainLayer,
or write run artifacts.

Use the explicit live smoke tier only when you are willing to launch one real
worker:

```bash
CMUX_LIVE_HARNESS=1 bun run pre-pr:live
```

`pre-pr:live` delegates to `live:harness`, which defaults to Cursor, `--count 1`,
and `--mcp-profile sterile`. The script refuses to run unless
`CMUX_LIVE_HARNESS=1` is present.

Use manual stress only when that is the intended task:

```bash
CMUX_LIVE_HARNESS=1 bun run live:harness -- --count 8
```

Do not put the live or stress tiers in normal pre-push hooks; they consume real
agent usage.

## Local Hook Installer

Install the local pre-push hook explicitly:

```bash
bun scripts/install-hooks.mjs
```

The installer writes `.git/hooks/pre-push` with a simple `bun run pre-pr` hook.
It is never installed or changed automatically.

## Live Runs

Default run directory:

```bash
CMUX_LIVE_HARNESS=1 \
bun run live:harness -- \
  --cli cursor \
  --repo skill-creator \
  --workspace workspace:1 \
  --count 1 \
  --mcp-profile sterile \
  --marker-prefix DONE_CURSOR_DUMMY \
  --final-green GREEN_CURSOR_DUMMY_1_AGENT \
  --final-red NOT_GREEN_CURSOR_DUMMY_1_AGENT
```

Explicit run directory:

```bash
RUN_ROOT="/Users/etanheyman/Gits/orchestrator/collab/2026-06-26-cmux-codex-collab-infra/live-8-agent-test/cursor-dummy-$(date +%Y%m%dT%H%M%S)"
CMUX_LIVE_HARNESS=1 \
bun run live:harness -- \
  --cli cursor \
  --repo skill-creator \
  --workspace workspace:1 \
  --count 8 \
  --root "$RUN_ROOT" \
  --mcp-profile sterile \
  --marker-prefix DONE_CURSOR_DUMMY \
  --final-green GREEN_CURSOR_DUMMY_8_AGENT \
  --final-red NOT_GREEN_CURSOR_DUMMY_8_AGENT
```

Direct script invocation:

```bash
bun run build
CMUX_LIVE_HARNESS=1 node scripts/run-live-agent-harness.mjs --root /tmp/cmux-harness-run ...
```

## Artifacts

Under `--root`:

- `goals/<worker>.md`
- `reports/<worker>.md` (written by live workers)
- `mcp-run-results.json`
- `run-report.md`

The default `results/live-agent-harness/` tree is local scratch and is ignored
by git. Treat raw harness artifacts as local ignored scratch. Do not
`brain_store` raw `mcp-run-results.json` payloads or wholesale report trees;
store only the final summary, final marker, and path to the run when the result
matters.

The runner defaults to `--mcp-profile sterile` so dummy workers do not inherit
the normal MCP surface. Use `--mcp-profile skill_eval` or `--mcp-profile inherit`
only when the test explicitly needs those capabilities.

Exit code `0` only when every worker is green and the final marker matches
`--final-green`.

## Red conditions

The runner fails red on:

- `spawn_agent` `ok:false`
- boot prompt typed but not submitted
- missing report file or wrong DONE marker
- `wait_for` not reaching `done`
- duplicate managed id under one run
- `auto-*` managed id
- stale managed record after close
- unexpected extra live worker surfaces in the target workspace
- worker not in right column / workspace not selected / third column topology

## Scope limits

- Cursor dummy green does **not** prove Codex `cli_session_id` resumability.
- This is pre-commit-adjacent/local fleet validation, not GitHub Actions unit CI.
- Helpers in `src/live-agent-harness.ts` are unit-tested; the live loop itself is not.
