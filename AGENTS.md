# cmuxlayer

## What this repo is for

cmuxlayer should be a harness for harnesses — one thing that can control every other harness with a
single truth.

Codex, Kiro, Cursor CLI, whatever's next. I'm not locked into one and I don't want to be. And they
don't die when they're done: formal agents that persist, controlled by one agent.

The panes are already visible — I can go look myself. The point is that orc, the leads, and the other
workers know what each other are doing, which model they're on, how many tokens they've burned and how
much of their context window is left, without anyone opening a pane. And when a pane dies and something reboots it to resume, it's the same agent, on
the right model, and cmuxlayer knows how to change that model on whichever harness it happens to be.

That's the single truth. Everything else here is downstream of it.

## The one principle

Where a pane lands is not something an agent should have to remember. It should be deterministic enough
that they can't really get it wrong — that's the point of this repo.

A workspace is my mental model of what's scoped. Leads left, workers right, same workspace. Ninety-nine
percent of the time I won't ask for anything else, so anything that can quietly put it somewhere else
is broken.

## Resumable, automatically

Any lead or orchestrator should be able to resume an agent by its ID from the registry — I shouldn't
have to go find the session and run resume myself. Mostly that's one of two cases: a worker got killed because its pane
broke, or a lead thought it was done and wants it back.

If the session is old and lives in the Drive-mounted folder, cmuxlayer should pull it by agent ID on
its own. It should be automatic and work right.

## The tools are the product

cmux owns the terminal socket — don't rebuild it. But cmuxlayer must always be able to replace or fix
its own backend without killing the MCP connection.

And keep what the tools hand back concise and to the point. They give us way too many rows of data — it
eats tokens for no reason.

Don't bank fully on cmux. Be modular, touch the right layers, and if something better ever comes along,
**change the connectors and keep the tools.** The primitives should be solid enough to move anywhere.
What a tool does, and what it takes to control another pane, shouldn't change when the backend does —
so the tools and their descriptions stay; only the connectors underneath get rewritten.

Don't assume my setup either — someone installing this fresh has none of my skills or launchers.

## Working in this repo

Commands (bun, as in CI):

- `bun install`, then `bun run build` (tsc to `dist/`) and `bun run typecheck`.
- `bun run test` runs the vitest suite serially. `git config core.hooksPath .githooks` enables the
  pre-push hook, which runs `scripts/guard-no-docslocal.sh` and `scripts/run_tests.sh` (fixture
  checks plus the full vitest suite). Never push with `--no-verify`.

`src/` is flat; the layers are:

- MCP tools: `server.ts` (all tool handlers), `control-health.ts`, `palette.ts`.
- Engine: `agent-engine.ts` (spawn, monitor, resume, teardown) and its support files (`agent-*`, `launcher-registry.ts`, `model-policy.ts`, `permission-mode.ts`, `worktree.ts`).
- Daemon and proxy: `daemon*.ts`, `proxy.ts`, `entry.ts`, `stdio-lifecycle.ts`.
- cmux transport: `cmux-*.ts` (persistent socket, CLI fallback, version compatibility).
- Watches and inbox: `watch-spec.ts`, `inbox.ts`, `outbox-drainer.ts`.
- Screen parsing: `screen-parser.ts`, `pattern-registry.ts`, `harness-session.ts`.
- CLI and setup: `index.ts`, `init-*.ts`, `doctor.ts`.

Rules that tests and hooks enforce:

- Pane input is one short line. Put longer payloads in a file and send `Read and follow <path>`;
  multi-paragraph inline text is refused.
- Operator docs use the consolidated verbs, never the legacy names (`tests/thin-core-tools.test.ts`,
  "legacy-name drift").
- Documented tool counts must match the registrations (`tests/tool-count-drift.test.ts`).
- Nothing under `docs.local/` is ever tracked (`scripts/guard-no-docslocal.sh`).
- Stop a process by its recorded PID, never with a pattern killer (`pkill -f`): see the comment in
  `src/coordination-paths.ts`.
