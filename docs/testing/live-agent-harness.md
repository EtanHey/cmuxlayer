# Live Agent Harness

Deterministic, CI-adjacent live validation for cmuxlayer managed-agent lifecycle.

This harness is **not** part of normal unit CI. It drives a real cmux instance, real
agent launchers, and local auth/session state through cmuxlayer's stdio MCP server.

## What it proves

Before any worker, the runner:

- pins **a private daemon socket** (`~/.local/state/cmux/cmuxlayer-harness-<pid>.sock`)
  unless you pass `--daemon-socket` or `--installed-daemon`. The entry is a
  daemon-first proxy: without a pinned socket it talks to whatever daemon owns the
  default socket, which on a fleet Mac is the installed Homebrew build, and a green
  run would prove that binary instead of this one (#800). The private socket makes
  the proxy start a daemon from this build's `dist/`. "Private" means **this run
  created the socket and so started the daemon** (`started_by_run:true`), not
  merely a non-default path: a `--daemon-socket` (or `CMUXLAYER_DAEMON_SOCKET`)
  whose socket already exists is inherited, and the installed stable and nightly
  sockets are always installed. The runner stops only a daemon it started, by its
  recorded PID, even when the run goes red; it never signals an inherited or
  installed daemon.
- `--installed-daemon` **opts out of the build check**: the run proves the
  installed daemon, not this build. The artifact's daemon block then says
  `private:false, from_this_build:false, build_check:"opted_out"`, and the run
  does not fail for `daemon_not_from_this_build`.
- PREFLIGHT, before any `spawn_agent`: checks `tools/list` for every tool it
  calls (`spawn_agent`, `list_agents`, `list_surfaces`, `wait_for`,
  `close_surface`, `control_health`) and fails red naming any that are missing;
  and, when run inside a managed pane, reads that seat's spawn depth
  (`list_agents({detail:"full"})`, matched on `CMUX_SURFACE_ID`) and exits
  non-zero at depth 2 or more. Run it from a plain terminal or from a lead seat
  at depth 1 or less.
- records **which daemon served the run** from `control_health(detail:"full")`
  (version, binary path, pid, socket) and fails red if that binary is not under
  this build's `dist/` (unless `--installed-daemon`).

For each sequential worker the runner:

1. writes a tiny read-only goal file naming the worker's report path under the
   coordination root (`~/.cmux/live-harness/<run>/<worker>.report.md`)
2. calls `spawn_agent` with `boot_prompt_path` and that `report_path`
3. spawns the worker with a sandboxed MCP profile by default
4. verifies managed id / launcher-model policy
5. captures verbose `list_surfaces` topology (`selected`, `column`, `column_count`)
6. waits for file-backed DONE via `wait_for({agent_id, report_path, done_marker})`
   on the `report_path` the `spawn_agent` receipt issued: it matches when the
   report's final non-empty line equals the marker. `wait_for` reads only a path
   that, after symlinks resolve, sits under `~/.cmux/` or
   `~/.cmux/agents/<agent_id>/`; anything else is refused. A sterile
   worker is never told the engine's own report path (#782), so the registry may
   stay `ready`; the file is the done signal (#808). The wait runs in 120 s
   slices up to `--wait-timeout-ms`, because the daemon-first proxy fails any
   single request at 300 s
7. copies the report into `reports/<worker>.md` and harvests the marker
8. stops the worker and closes its pane: `close_surface({agent_id, scope:"agent", force:true})`.
   The harness owns the dummy and has harvested its report; a plain surface close is
   (correctly) refused while the agent is still live
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
fixtures only, including MCP-shaped replay payloads for `spawn_agent`,
`wait_for`, `list_agents`, `list_surfaces`, and `close_surface`. It does not connect to cmux, launch agent CLIs, touch
BrainLayer, or write run artifacts.

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
RUN_ROOT="$HOME/cmux-live-harness/cursor-dummy-$(date +%Y%m%dT%H%M%S)"
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
- `reports/<worker>.md` (copied from the issued report path)
- `mcp-run-results.json`: includes `daemon` (`socket_path`, `private`,
  `started_by_run`, `installed_socket`, `build_check`, `version`, `binary`, `pid`,
  `expected_dist`, `from_this_build`, `stopped`), `preflight` (`tools`, `missing`,
  `caller_depth`) and, on a run-level failure, `error`
- `run-report.md`: includes a `## Daemon` section and, on failure, `## Run error`

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

- a required tool missing from `tools/list`
- a calling seat at spawn depth 2 or more (refused in preflight, before any spawn)
- any run-level error (recorded as `error` in the JSON and `## Run error` in the
  report), and any worker the runner never classified (`worker_not_classified`);
  the exit code and final marker come from this run-level verdict
- a serving daemon that is not this build (`daemon_not_from_this_build`), unless
  `--installed-daemon` opted out of that check
- `spawn_agent` `ok:false`
- boot prompt typed but not submitted
- missing report file or wrong DONE marker
- `wait_for` not matching (neither the report marker nor registry `done`)
- duplicate managed id under one run
- `auto-*` managed id
- stale managed record after close: the worker is still listed as **live** (a stopped
  agent keeps a persisted `done`/resumable record by design, and that is not stale)
- unexpected extra live worker surfaces in the target workspace
- worker not in right column / workspace not selected / third column topology

## Classifier vs agent-health boundary

`classifyWorkerFailures` is the live harness worker-run classifier. It only
uses the evidence collected by the live runner for one harness worker:
`spawn_agent`, launch state text, verbose `list_surfaces`, `wait_for`, report
marker text, cleanup `list_agents({agent_ids})`, cleanup `list_agents`, and
cleanup `list_surfaces`.

Agent lifecycle health remains the owner for broader registry/session/screen
health:

- `missing_cli_session_id` and `non_resumable`: outside the harness classifier
  because the harness does not prove CLI session capture or resumability. Codex
  replay fixtures can be classifier-green while `agent-health` marks a
  long-running agent without `cli_session_id` unhealthy.
- `registry_screen_disagreement`: outside the harness classifier because it
  compares registry state against screen-parser state. The harness consumes
  `wait_for` completion and report-marker evidence instead.
- `parser_drift_after_done_evidence`: outside the harness classifier until the
  screen parser exposes a concrete issue code or runner field for parser drift
  after artifact-backed DONE evidence.
- `inbox_turn_nudge_required`: outside the harness classifier because inbox
  nudges are agent-health or inbox-monitor routing signals, not worker-run
  pass/fail evidence from the no-live harness replay.

## Scope limits

- Cursor dummy green does **not** prove Codex `cli_session_id` resumability.
- This is pre-commit-adjacent/local fleet validation, not GitHub Actions unit CI.
- Helpers in `src/live-agent-harness.ts` are unit-tested; the live loop itself is not.
