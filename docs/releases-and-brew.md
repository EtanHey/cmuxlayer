# Releases, Homebrew, and dogfooding cmuxlayer

> How the cmuxlayer MCP server is versioned, installed, run by the fleet, and
> developed. Read this before changing how cmuxlayer is launched or cutting a
> release.

## TL;DR

- The fleet runs the **brew-installed, pinned** cmuxlayer so every agent is on
  the *same* version (deterministic placement/teardown). No more "runs from a
  random working tree."
- Install / update:
  ```bash
  brew install etanhey/layers/cmuxlayer            # stable, latest tagged release
  brew upgrade etanhey/layers/cmuxlayer            # move to a newer tag
  brew install --HEAD etanhey/layers/cmuxlayer     # dogfood the latest main
  brew upgrade --fetch-HEAD etanhey/layers/cmuxlayer
  ```
- Develop cmuxlayer itself with your **live, uncommitted** working tree:
  ```bash
  export CMUXLAYER_DEV=1     # the launcher then runs ~/Gits/cmuxlayer/src via bun
  ```

## How the fleet launches cmuxlayer

cmuxlayer is an **MCP stdio server** — an MCP client (cmux / Claude Code) spawns
it and speaks JSON-RPC over stdin/stdout. It is *not* a daemon; there is no
`brew services`.

The launch chain:

```
~/.golems/config.yaml                 mcpServers.cmuxlayer  (SOURCE OF TRUTH)
   │  scripts/sync-config.sh --enforce  (regenerates per-repo configs)
   ▼
~/Gits/<repo>/.mcp.json               mcpServers.cmuxlayer.command  (GENERATED; do not hand-edit)
   ▼
~/.golems/bin/cmuxlayer-mcp           (launcher)
   ▼
brew --prefix/opt/cmuxlayer/bin/cmuxlayer   (brew, default)
   └─ or ~/Gits/cmuxlayer/src/index.ts via bun, when CMUXLAYER_DEV=1
```

**Editing the launch command:** change `mcpServers.cmuxlayer` in `~/.golems/config.yaml`
(the source), then propagate to every profiled repo's generated `.mcp.json`:

```bash
~/Gits/golems/scripts/sync-config.sh --diff      # preview
~/Gits/golems/scripts/sync-config.sh --enforce   # write
```

The `.mcp.json` files are generated artifacts — never hand-edit them; they get
overwritten. Only newly-spawned sessions / `/mcp` reconnects pick up the change.

The launcher (`~/.golems/bin/cmuxlayer-mcp`):
- runs the brew bin by default;
- runs your live source (`bun run src/index.ts`) when `CMUXLAYER_DEV=1`
  (override the path with `CMUXLAYER_SRC`);
- falls back to live source with a stderr warning if the brew bin is missing, so
  the fleet never loses `cmux`.

**Only newly-spawned agents pick up a change** — an already-running agent keeps
its existing MCP child until it reconnects (`/mcp`) or is respawned.

## Pinning the cmux instance — `CMUX_SOCKET_PATH`

cmux exports `CMUX_SOCKET_PATH` into each agent's environment, pointing at the
instance that spawned it. When set (or `socketPath` is passed in code) cmuxlayer
binds to **that one instance only** and never falls through to another live
cmux's socket. This is what stops a worker from opening in a *different* cmux app
(e.g. stable vs nightly). If it is unset and more than one cmux instance is live,
the factory logs which socket it bound to and how to pin it.

## Cutting a release (versioning, on the go)

One command does the whole pipeline:

```bash
~/Gits/cmuxlayer/scripts/release.sh 0.3.0
```

It will: verify a clean tree + green build/tests, bump `package.json`, commit,
push `main`, tag `vX.Y.Z`, then update the Homebrew formula's `url` + `sha256`
in `~/Gits/homebrew-layers` and push the tap. Afterwards:

```bash
brew update && brew upgrade etanhey/layers/cmuxlayer
```

Manual equivalent, if you prefer:

1. `package.json` → bump `version`.
2. Commit + open PR + merge to `main`.
3. `git tag -a vX.Y.Z -m "..." <merge-sha> && git push origin vX.Y.Z`.
4. `curl -fsSL https://github.com/EtanHey/cmuxlayer/archive/refs/tags/vX.Y.Z.tar.gz | shasum -a 256`.
5. In `~/Gits/homebrew-layers/Formula/cmuxlayer.rb` set `url` to the new tag and
   `sha256` to the value from step 4; `brew audit etanhey/layers/cmuxlayer`;
   commit + push.
6. `brew upgrade etanhey/layers/cmuxlayer`.

The formula also carries a `head` block, so `--HEAD` installs always track
`main` with **no** sha/tag bump — that is the on-the-go dogfood path.

## Pre-deploy hygiene: archive the outbox before shipping outbox-semantics changes

Any release that could change how `outbox-drainer.ts` derives dedup ids or
gates delivery (e.g. #240's byte-position → `sha256(body)#occurrence` switch, or
the v1→v2 quarantine that followed it) can, on the first drain after deploy,
re-interpret the *existing* backlog in `~/.golems-zikaron/outbox.md`. The
in-code guard for this is the **version-gated quarantine** in `drainOutbox`: on a
`STATE_VERSION` bump it adopts the current backlog as drained *without*
re-delivering (see `src/outbox-drainer.ts`). That guard is the real safety net —
the drainer itself stays **non-destructive** (idempotency is the sidecar, never a
mutation of `outbox.md`; see the L7 invariant).

As belt-and-suspenders release hygiene, **before shipping a release that touches
outbox semantics**, archive the live outbox on each target Mac so operator
history is preserved before the new code path runs.

> ⚠️ **Never discard undelivered entries.** The drainer reads only `outbox.md`
> and its sidecar — it does **not** read `outbox-archive.md`. So truncating
> `outbox.md` while it still holds *undelivered* entries silently drops them
> (they are archived-as-history but never delivered). Truncation is therefore
> only safe **after** the outbox is confirmed fully drained. If you cannot
> confirm that, **archive only — do not truncate.**

```bash
# Run on EACH target Mac, per user, before the new binary goes live.
z=~/.golems-zikaron
if [ -s "$z/outbox.md" ]; then
  # 1) Always safe: append a copy to the durable archive (history survives).
  { printf '\n<!-- archived %s (pre-deploy) -->\n' "$(date -u +%FT%TZ)"; cat "$z/outbox.md"; } >> "$z/outbox-archive.md"

  # 2) Truncate ONLY after confirming the outbox is fully drained — i.e. every
  #    entry has already been delivered (no pending/undelivered messages). If you
  #    have not confirmed that, SKIP this line and leave outbox.md in place; the
  #    version-gated quarantine already prevents a re-send, and the drainer stays
  #    non-destructive. Truncating an undrained outbox would DROP those messages.
  : > "$z/outbox.md"   # keep the file so the drainer no-ops cleanly
fi
```

This is a **documented manual deploy step**, not something the drainer does — the
drainer must remain non-destructive. Do **not** wire an unguarded `rm`/truncate
into `scripts/release.sh`; a release runs on the maintainer's machine and must not
silently delete another operator's pending (undelivered) messages. If you add a
hook, make it a **commented reminder** that prints the step for the operator to
run per target Mac, gated behind an explicit opt-in flag.

## Behavioural invariants (what changed in v0.2.0)

These are enforced in code + tests; rely on them and don't regress them.

### Panes are protected on close (`close_surface`)
- Automatic/idle pane closing is **disabled** (#170): `TASK_DONE`/idle never
  auto-close a pane.
- `close_surface` **refuses** to tear down a surface backing a still-live
  (non-terminal) agent **unless `force: true`**, and on refusal returns a fresh
  read of the pane so you can confirm it is actually finished before destroying
  it. Browser panes and surfaces with no tracked agent close normally.
- On a real close it forwards the collapse decision, so a worker pane collapses
  cleanly instead of being left as a bare-shell "zombie" pane.

**Agent guidance:** never force-close to "clean up" a busy agent — read the pane
the refusal hands you first. Closing a done/error agent needs no force.

### Workers land in the parent's workspace
- A spawned worker **inherits its parent orchestrator's workspace** (same repo,
  case/hyphen-insensitive) before any repo-name resolution, so it splits to the
  **right of the parent** — even for worktree workers whose cwd is
  `~/Gits/<repo>.wt/<name>` (which does not match the repo name). Pass an
  explicit `workspace` to override.
- repo↔workspace matching is worktree-aware (anchored to `.wt` / `.worktrees`
  shapes — a repo named like an ancestor dir won't hijack an unrelated
  workspace) and deterministic.

**Agent guidance:** to put a worker in the same workspace as its parent, just
pass `parent_agent_id`; you don't need to compute `workspace` yourself. Pass an
explicit `workspace` only when you deliberately want a different one.

## Files

| Path | Role |
|------|------|
| `~/.golems/config.yaml` → `mcpServers.cmuxlayer` | wires the launcher into the fleet |
| `~/.golems/bin/cmuxlayer-mcp` | launcher: brew (default) vs live source (`CMUXLAYER_DEV=1`) |
| `EtanHey/homebrew-layers` → `Formula/cmuxlayer.rb` | the brew formula (stable tag + `head`) |
| `scripts/release.sh` | one-command release: bump → tag → formula bump → push |
