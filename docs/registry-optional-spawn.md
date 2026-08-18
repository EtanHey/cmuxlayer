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
| resume | `mmClaude -s --resume <uuid>` | `cd '<root>' && … claude --resume <uuid>` |
| `launcher_name` on the record | the launcher | `null` |
| everything else in the receipt | identical | identical |

`kiro` has no launcher and is raw on both lanes.

Raw skip-approval flags, verified against each CLI's `--help`:

| cli | binary | skip flag | model flag | resume |
|---|---|---|---|---|
| claude | `claude` | `--dangerously-skip-permissions` | `--model` | `--resume <uuid>` |
| codex | `codex` | `--dangerously-bypass-approvals-and-sandbox` | `-m` | `resume <uuid>` |
| cursor | `cursor agent` | `--force` | `--model` | `--resume <uuid>` |
| gemini | `gemini` | `-y` | `--model` | `--resume <uuid>` |

## Where the raw lane looks for the repo

`resolveRepoRootWithoutRegistry` (src/repo-root-fallback.ts), first hit wins:

1. every absolute root in `CMUXLAYER_REPO_HOME` (colon separated) → `<root>/<repo>`
2. the running checkout, when its basename **is** the repo
3. a sibling of the running checkout
4. `~/Gits/<repo>`
5. `~/<repo>`

Nothing found is an error that names every path it searched — spawn never
launches into a lookalike directory silently.

## Environment variables

| var | effect |
|---|---|
| `CMUXLAYER_LAUNCHER_REGISTRY_PATH` | override the registry location |
| `CMUXLAYER_REPO_HOME` | colon-separated roots searched first on the raw lane |
| `CMUXLAYER_REQUIRE_LAUNCHER_REGISTRY=1` | restore the pre-#392 hard failure when a repo is unregistered |

Set `CMUXLAYER_REQUIRE_LAUNCHER_REGISTRY=1` on a machine where every repo *is*
registered: a typo'd repo name then fails loudly instead of raw-launching in a
directory that happens to exist.

## Resume honesty

Claude, Cursor, and Gemini key their session stores by working directory, so a
raw resume for those is only advertised when a cwd is known (`launch_cwd` or
`worktree_path`). Without one, `resumable` is `false` rather than a command
that would silently start a *new* session. Codex reads a global session store
and needs no cwd to find the session.

## CI

`bun run test:parity` runs the contract through both lanes. The `launcher-parity`
job in `.github/workflows/ci.yml` runs it twice: once on a runner with no
registry (a real fresh install) and once with a registry planted.
