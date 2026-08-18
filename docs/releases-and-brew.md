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

The fleet sidebar follows the same instance axis. Stable keeps its canonical
`~/.config/cmux/sidebars/fleet.swift` output unchanged. A named socket or bundle
instance writes `~/.config/cmux-<instance>/sidebars/fleet.swift`; for example,
`/tmp/cmux-nightly.sock` writes under `~/.config/cmux-nightly/`. Its collapse
state is isolated under `~/.local/state/cmuxlayer/<instance>/`. Set
`CMUXLAYER_FLEET_SIDEBAR_OUTPUT_PATH` to override the generated Swift path
explicitly; the matching collapse state is stored beside that override. The
canonical `/tmp/cmux-nightly.sock` and `/tmp/cmux-dev.sock` names stay readable;
other instance keys include a short hash of the complete socket path or bundle
ID so distinct identities cannot collide after filename sanitization.

## Cutting a release (versioning, on the go)

One command does the whole pipeline:

```bash
~/Gits/cmuxlayer/scripts/release.sh 0.4.44                     # asks once before pushing
~/Gits/cmuxlayer/scripts/release.sh 0.4.44 --yes               # no prompt
~/Gits/cmuxlayer/scripts/release.sh 0.4.44 --dry-run           # print every step, change nothing
~/Gits/cmuxlayer/scripts/release.sh 0.4.44 --require-contract  # a skipped real-cmux gate aborts
```

It will: verify a clean tree + green typecheck/tests, run the real-cmux
contract gate, bump `package.json`, commit, push `main`, tag `vX.Y.Z`, update
the Homebrew formula's `url` + `sha256` in `~/Gits/homebrew-layers`, push the
tap, and **sync the tap clone Homebrew itself reads**. Afterwards, run the
verification helper on **each** Mac:

```bash
~/Gits/cmuxlayer/scripts/release-verify.sh 0.4.44                # sync clone → upgrade → assert
~/Gits/cmuxlayer/scripts/release-verify.sh 0.4.44 --verify-only  # assert only; never upgrades
```

### The release receipt (stop trusting scrollback)

Both scripts write a durable **release receipt** through
`scripts/release-receipt.mjs` instead of leaving the answer to "did this
release actually gate, ship, and land on every Mac?" in four terminals'
scrollback.

- Location: `$CMUXLAYER_RELEASE_RECEIPTS_DIR`, defaulting to
  `~/.local/state/cmuxlayer/release-receipts/release-<version>.json`.
- `release.sh` records: version, tag, release commit SHA, timestamps,
  tarball URL + `sha256`, each gate's result (`gates.typecheck`,
  `gates.tests`, `gates.contract` — `pass` / `skip` / `fail`, with
  `gates.contract_reason` on a skip), the tap push, and the tap-clone sync
  (`tap.clone_sync` = `synced` / `skipped` / `failed`, with before/after SHAs).
- `release-verify.sh` records `verify.result`, `verify.mode`, tap-clone
  divergence, and appends one **install evidence** entry
  (`{host, result, installed, mode, at}`) to `installs[]`.
- Every mutation also appends to an in-file `events[]` trail; writes are atomic
  (temp file + rename), and re-running `init` never drops existing install
  evidence.

**The default ledger is per-Mac, not fleet-wide.** `~/.local/state/…` is local
disk: four Macs running `release-verify.sh` produce four separate
`release-<version>.json` files, each holding its own single `installs[]` entry.
That is still a real improvement — four durable files beat four scrollbacks —
but collecting them is on you.

To aggregate a release into **one** file, point every Mac at shared storage:

```bash
export CMUXLAYER_RELEASE_RECEIPTS_DIR=/path/to/shared/release-receipts
```

The `installs[]` array and its `host` field exist for exactly that. One caveat
before you do it: `release-receipt.mjs` does a read-modify-write with **no
locking**, so two Macs verifying the same version at the same moment can drop
one another's entry. Stagger them, or treat a shared ledger as best-effort
until locking lands.

Read one directly:

```bash
node ~/Gits/cmuxlayer/scripts/release-receipt.mjs show 0.4.44
node ~/Gits/cmuxlayer/scripts/release-receipt.mjs path 0.4.44
```

Receipt writes are never a gate: a failed receipt write warns and the release
continues. `--dry-run` writes no receipt at all.

### The real-cmux contract gate (#370)

`release.sh` runs `bun run test:contract`. That lane **skips itself** when no
live, non-production cmux socket is reachable — cmux grants
`CMUX_SOCKET_CAPABILITY` only to processes started inside a pane, and the
runner refuses the production socket outright (pin
`/tmp/cmux-nightly.sock`, or set `CMUX_CONTRACT_ALLOW_PROD=1` to override).
Those skips are why 0.4.17–0.4.19 shipped without the gate ever running.

Now the skip is classified and written to the receipt as
`gates.contract: skip` with its reason, and there are two ways to make it a
hard gate:

- `scripts/release.sh <version> --require-contract` — a skipped gate aborts the
  release before anything is pushed;
- `CMUX_CONTRACT_REQUIRE_LIVE=1 bun run test:contract` — the runner itself
  turns a skip into `[contract] FAIL:` and a non-zero exit.

`scripts/nightly-contract-run.sh` writes its own nightly receipt under
`~/.local/state/cmux/contract-nightly-<date>.json`.

**Running it green.** Open a shell *inside a cmux pane* (that is the only place
`CMUX_SOCKET_CAPABILITY` is granted) and run the lane. Verified green on
2026-08-18 from a pane on the live socket:

```bash
CMUX_CONTRACT_ALLOW_PROD=1 bun run test:contract
# [contract] PASS system.ping shape on ~/.local/state/cmux/cmux-501.sock
# [contract] PASS detached orphan pid=… denied with EPROTO
# [contract] PASS list_surfaces/read_screen through dist daemon pid=…
# [contract] PASS doctor --json healthy on isolated live stack
# [contract] PASS graceful retire/autostart …
# [contract] PASS real-cmux contract lane
```

The lane's live steps against the pinned cmux are read-only (`system.ping`,
`list_surfaces`, `read_screen`); the daemon it retires and restarts is its own,
under a temp `HOME` and a temp socket. Prefer the nightly pin
(`CMUX_SOCKET_PATH=/tmp/cmux-nightly.sock`) when nightly is up;
`CMUX_CONTRACT_ALLOW_PROD=1` is the explicit override when it is not.

### Verify-only mode (failures-ledger 10.5)

`release-verify.sh --verify-only` (alias `--no-upgrade`) **asserts without
mutating this Mac**: no `brew upgrade`, no `reset --hard` of Homebrew's tap
clone. It fetches (remote refs only), reports how many commits brew's clone is
behind `origin/main`, asserts `brew list --versions cmuxlayer`, and appends its
install evidence. This exists because a "verification" that silently upgraded
mid-fleet nearly broke an explicit operator hold on the v0.4.24 cut.

The default (upgrading) mode is unchanged: it fetches and hard-resets the tap
clone Homebrew actually reads at
`$(brew --repository)/Library/Taps/etanhey/homebrew-layers` to `origin/main`,
runs `brew upgrade etanhey/layers/cmuxlayer`, and fails unless
`brew list --versions cmuxlayer` prints exactly the released version.

> ⚠️ `brew upgrade` deletes the running keg under every live MCP child, so
> agents holding an old cmuxlayer child keep running deleted code until they
> `/mcp reconnect cmuxlayer` (#371). "Deployed" is per-agent, not fleet-wide —
> which is what the per-Mac `installs[]` evidence is for.

### Why the tap clone must be synced explicitly (#371, failures-ledger 16)

`release.sh` edits and pushes `~/Gits/homebrew-layers`, but brew reads its OWN
clone under `$(brew --repository)/Library/Taps/etanhey/homebrew-layers`. That
clone's `main` frequently has **no upstream tracking**, so `brew update` reports
"Already up-to-date" while sitting commits behind and `git pull` fails with "no
tracking information" — observed on both Macs after v0.4.26. Both `release.sh`
(after the tap push) and `release-verify.sh` (default mode) therefore run an
explicit `git -C <clone> fetch origin && git -C <clone> reset --hard origin/main`.
In `release.sh` this step is **additive and non-fatal** — the release is already
pushed by then, so a missing brew or missing clone is recorded as
`tap.clone_sync: skipped` rather than failing the run.

Manual equivalent, if you prefer:

1. `package.json` → bump `version`.
2. Commit + open PR + merge to `main`.
3. `git tag -a vX.Y.Z -m "..." <merge-sha> && git push origin vX.Y.Z`.
4. `curl -fsSL https://github.com/EtanHey/cmuxlayer/archive/refs/tags/vX.Y.Z.tar.gz | shasum -a 256`.
5. In `~/Gits/homebrew-layers/Formula/cmuxlayer.rb` set `url` to the new tag and
   `sha256` to the value from step 4; `brew audit etanhey/layers/cmuxlayer`;
   commit + push.
6. Sync the tap Homebrew reads:
   `git -C "$(brew --repository)/Library/Taps/etanhey/homebrew-layers" fetch origin && git -C "$(brew --repository)/Library/Taps/etanhey/homebrew-layers" reset --hard origin/main`.
7. `brew upgrade etanhey/layers/cmuxlayer`.
8. Assert `brew list --versions cmuxlayer` is exactly `cmuxlayer X.Y.Z`.

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
| `scripts/release.sh` | one-command release: gate → bump → tag → formula bump → push → sync brew's tap clone → receipt |
| `scripts/release-verify.sh` | sync Homebrew's tap clone → upgrade → assert installed version (`--verify-only` asserts without upgrading) |
| `scripts/release-receipt.mjs` | the release receipts ledger (`CMUXLAYER_RELEASE_RECEIPTS_DIR`) |
| `scripts/run-real-cmux-contract.ts` | the real-cmux contract lane (`CMUX_CONTRACT_REQUIRE_LIVE=1` makes a skip fatal) |
