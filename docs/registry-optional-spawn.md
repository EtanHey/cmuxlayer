# Registry-optional spawn and resume

> Contract for issue #392. AGENTS.md law: *"Don't assume my setup — someone
> installing this fresh has none of my skills or launchers."*

The repoGolem launcher registry (`~/.config/ralphtools/launchers.zsh`) is an
**optional enhancement**. `spawn_agent` and resume work with it and without it.

## The two lanes

| | registry lane | raw lane |
|---|---|---|
| trigger | `launchers.zsh` exists **and** names the repo | no registry file, or no entry for the repo |
| launch | `mmClaude -s` | `cd '<root>' && MCP_CONNECTION_NONBLOCKING=1 CLAUDE_CODE_NO_FLICKER=1 claude --dangerously-skip-permissions` |
| resume | `mmClaude -s --resume <uuid>` | `cd '<root>' && … claude --dangerously-skip-permissions --resume <uuid>` |
| `launcher_name` on the record | the launcher | `null` |
| `launch_mode` on the record | `"launcher"` | `"raw"` |
| `model_pin` on the record | `"launcher"` | `"cli_flag"` or `"cli_default"` |
| everything else in the receipt | identical | identical |

`kiro` has no launcher and is raw on both lanes.

**The approval bypass is on the resume too.** An agent that comes back without
it blocks on its first tool call and presents as a hung pane rather than a
failed resume, so both lanes carry it in both commands. The parity suite
asserts this lane-independently, by reading the command the engine actually
sent rather than comparing against a per-lane expected string.

Raw flags, verified against each CLI's `--help`:

| cli | binary | skip flag | model flag | resume |
|---|---|---|---|---|
| claude | `claude` | `--dangerously-skip-permissions` | `--model` | `--resume <uuid>` |
| codex | `codex` | `--dangerously-bypass-approvals-and-sandbox` | `-m` | `resume <uuid>` (global flags precede the subcommand) |
| cursor | `cursor agent` | `--force` | `--model` | `--resume <uuid>` |
| gemini | `gemini` | `-y` | `--model` | **none** — see below |

### gemini has no raw resume

`gemini --resume` takes `"latest"` or an **index number** ("Resume a previous
session. Use \"latest\" for most recent or index number (e.g. --resume 5)"),
never a session UUID. There is therefore no raw gemini resume addressable by
the id cmuxlayer captures. `buildRawResumeCommand` refuses rather than emitting
a command that would start a *fresh* session while reading as a successful
resume; raw gemini agents report `resumable: false`, and gemini is excluded
from same-surface auto-revive. The registered gemini launcher path is
unchanged.

Retired command forms are still *recognized* on screen
(`rawResumeEchoCandidates`) even when they are no longer *emitted* — the
stale-resume guards match against scrollback typed by older builds, including
the old bypass-less forms and the old gemini form.

## Model pin provenance (`model_pin`)

Model tokens in this repo are **launcher vocabulary** (`claude-opus-5[1m]`,
`pro`, `codex`, `auto`); raw binaries do not share it. Canon §5 puts the pin on
the launcher, so in raw mode there is no launcher to carry it. The receipt
therefore states what actually happened instead of claiming a pin it never
applied:

| `model_pin` | meaning |
|---|---|
| `launcher` | the repoGolem launcher carries the pin |
| `cli_flag` | raw mode passed an explicit `--model`/`-m` the binary understands |
| `cli_default` | **unpinned** — the CLI used its own configured default, which may be a prior session's model |

`cli_default` always ships a `MODEL PIN NOT APPLIED` warning on the spawn
receipt. Gemini's launcher aliases (`pro`, `flash`, `pro-high`) are *not*
passed to a raw gemini, because they are repoGolem names the binary does not
define; only canonical `gemini-*` names are forwarded.

## Where the raw lane looks for the repo

`resolveRepoRootWithoutRegistry` (src/repo-root-fallback.ts), first hit wins:

1. every absolute root in `CMUXLAYER_REPO_HOME` (colon separated) → `<root>/<repo>`
2. the running checkout, when its basename **is** the repo
3. a sibling of the running checkout
4. `~/Gits/<repo>`
5. `~/<repo>`

Nothing found is an error that names every path it searched — spawn never
launches into a lookalike directory silently.

**A fallback past a *present* registry is disclosed.** On a fully-registered
machine, a repo whose key does not normalize to a registration would otherwise
fall through to `~/Gits/<repo>` — which usually exists — and boot a raw binary
with none of the launcher's MCP wiring or contexts, silently. The spawn receipt
now carries a `RAW LAUNCH:` warning naming which door failed and where it
landed, plus `launch_mode: "raw"`, so the degradation is legible without
forcing strict mode on and re-breaking fresh installs.

## Environment variables

| var | effect |
|---|---|
| `CMUXLAYER_LAUNCHER_REGISTRY_PATH` | override the registry location |
| `CMUXLAYER_REPO_HOME` | colon-separated roots searched first on the raw lane |
| `CMUXLAYER_REQUIRE_LAUNCHER_REGISTRY=1` | restore the pre-#392 hard failure when a repo is unregistered |
| `CMUXLAYER_SPAWN_PERMISSION_MODE` | `skip-permissions` (default) or `default` — see below |

`cmuxlayer init` writes all of these; see [fresh-install.md](fresh-install.md).

Set `CMUXLAYER_REQUIRE_LAUNCHER_REGISTRY=1` on a machine where every repo *is*
registered: a typo'd repo name then fails loudly instead of raw-launching in a
directory that happens to exist.

## Approval bypass is a choice, not a constant

Both lanes bypass the harness approval prompt by default, because an agent in a
background pane that stops on its first tool call reads as a hung pane. An
install that would rather be asked sets
`CMUXLAYER_SPAWN_PERMISSION_MODE=default` (what `cmuxlayer init --permissions
ask` writes), and then **neither** lane carries a bypass: the raw lane drops
`--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox`
/ `--force` / `-y`, and the launcher lane drops `-s`. Launch and resume move
together, so a resumed agent comes back in the mode it was spawned in.

The parity suite's "both lanes carry an approval bypass" invariant is an
assertion about the *default*, and it still holds: nothing changes for an
install that does not set the variable.

## Resume honesty

Claude, Cursor, and Gemini key their session stores by working directory, so a
raw resume for those is only advertised when a cwd is known (`launch_cwd` or
`worktree_path`). Without one, `resumable` is `false` rather than a command
that would silently start a *new* session. Codex reads a global session store
and needs no cwd to find the session.

`resumeInvocationForAgent` in `src/agent-facade.ts` is the **single authority**
for this: `list_agents`, `get_agent_state`, `resolveAgentRoute`, `resume_agent`,
and crash recovery all go through it, so what the tools advertise and what the
engine sends can never disagree. It returns either a command or a *reason*, and
the engine surfaces that reason — a malformed session id, a missing cwd, a
harness with no UUID resume form — instead of flattening it to "not resumable".

`harnessCwdForAgent`'s default remains, but only for transcript probing; it is
no longer used to aim a resume command. It now reads the first
`CMUXLAYER_REPO_HOME` root before falling back to `~/Gits/<repo>`, so the probe
follows the machine's own layout.

## CI

`bun run test:parity` runs the contract through both lanes. The `launcher-parity`
job in `.github/workflows/ci.yml` runs it twice: once on a runner with no
registry (a real fresh install) and once with a registry planted.

The registry lane **reads a planted `launchers.zsh` when the host has one**
rather than stubbing `CMUXLAYER_LAUNCHER_REGISTRY_PATH` over it, so the
`present` leg genuinely exercises registry parsing and root resolution instead
of running byte-identically to the `absent` leg.

The suite holds two kinds of assertion, and the second kind is the one that
matters:

- per-lane expected command strings (readable, but a hand-written table can
  only encode a divergence, never catch one);
- **lane-independent invariants** read off the command the engine actually
  sent: both lanes carry an approval bypass in launch *and* resume, the receipt
  claims a model pin only when the command applied one, the tab title is
  `<repo><Cli>` in both lanes, and the public agent id survives a resume.
