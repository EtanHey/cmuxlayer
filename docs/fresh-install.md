# Fresh install

Setting up cmuxlayer on a machine that has never run it. Nothing here assumes
any particular shell setup, wrapper commands, or directory layout.

## What cmuxlayer needs

1. **[cmux](https://github.com/manaflow-ai/cmux), running.** cmuxlayer does not
   own a terminal; it drives cmux's. Start a cmux session before using it.
2. **At least one agent CLI on your `PATH`** — `claude`, `codex`, `cursor`, or
   `gemini`. cmuxlayer starts these inside cmux panes; it does not install them.
3. **The repositories you want agents to work in**, checked out somewhere.

## 1. Install

```bash
brew install etanhey/layers/cmuxlayer
```

or `npm install -g cmuxlayer`. Both provide the `cmuxlayer` command.

## 2. Run the setup wizard

```bash
cmuxlayer init
```

The wizard asks three things.

**Which repositories?** Give the absolute path to each checkout you want to be
able to spawn agents in, and the name agents will use to address it. The name
defaults to the directory name, which is what you want unless you have a
reason otherwise.

**How should agents be started?** Two ways, and the wizard picks the second for
you unless it finds evidence of the first:

- *Shell launcher functions.* Some setups have per-repository wrapper commands —
  `myrepoClaude`, `myrepoCodex` — that `cd` into the repo and apply their own
  model pin, MCP config, and terminal profile. If you have those, cmuxlayer
  will call them. It does not create them.
- *The CLI binaries directly.* cmuxlayer `cd`s into the repository itself and
  runs `claude` / `codex` / `cursor` / `gemini`. **This is the normal case** and
  needs nothing beyond the CLIs being installed.

**How should agents handle tool approvals?**

- *Run unattended* (the default). Agents start with their CLI's approval prompt
  bypassed, so they can read, edit, and run commands without stopping to ask.
  This is what makes an agent in a background pane useful — and it is a real
  risk. Choose it only for repositories you trust.
- *Ask every time.* Agents start in their CLI's normal mode. Expect a pane to
  sit waiting on its first tool call until you look at it.

## 3. Load the configuration

The wizard writes `~/.config/cmuxlayer/env.sh`. Source it from your shell
profile so the panes cmuxlayer starts inherit it:

```bash
echo '[ -f ~/.config/cmuxlayer/env.sh ] && . ~/.config/cmuxlayer/env.sh' >> ~/.zshrc
```

## 4. Point your MCP client at cmuxlayer

Claude Code, Cursor, VS Code, Claude Desktop:

```json
{ "mcpServers": { "cmuxlayer": { "command": "cmuxlayer" } } }
```

Codex CLI / T3 Code, in `~/.codex/config.toml`:

```toml
[mcp_servers.cmuxlayer]
command = "cmuxlayer"
```

Restart the client afterwards.

## 5. Check it

```bash
cmuxlayer doctor
```

Read-only, exits 0 when healthy, and names what it could not verify.

## Scripted installs

`--yes` runs the same thing with no prompts:

```bash
cmuxlayer init --yes \
  --repo ~/code/my-app \
  --repo api=/srv/services/api \
  --permissions skip
```

`--repo <path>` names the repository after its directory; `--repo <name>=<path>`
sets the name explicitly. Add `--print` to see the files without writing them,
and `--force` to overwrite an existing config. `cmuxlayer init --help` lists
every flag.

## What the wizard writes

### `~/.config/cmuxlayer/env.sh`

Shell exports, in every mode:

| variable | meaning |
|---|---|
| `CMUXLAYER_REPO_HOME` | colon-separated directories holding your checkouts. A repo named `<repo>` is looked for at `<root>/<repo>`, in order. |
| `CMUXLAYER_SPAWN_PERMISSION_MODE` | `skip-permissions` (unattended) or `default` (agents prompt). |
| `CMUXLAYER_LAUNCHER_REGISTRY_PATH` | written only in launcher mode: where the launcher registry lives. |
| `CMUXLAYER_REQUIRE_LAUNCHER_REGISTRY` | written only with `--require-registry`: fail a spawn for an unregistered repo instead of falling back to the CLI. |

### `~/.config/ralphtools/launchers.zsh` — launcher mode only

One line per repository:

```
repoGolem myapp /Users/you/code/my-app
```

cmuxlayer reads the prefix and the path, and starts an agent by running
`myappClaude`, `myappCodex`, `myappCursor`, or `myappGemini`. Those commands
must exist in the shell your cmux panes start; the wizard does not create them.
Hyphens are stripped from the prefix, so `my-app` becomes `myappClaude`.

## How a repository gets found

Without a launcher registry, cmuxlayer resolves the `repo` an agent asks for by
searching, first hit wins:

1. each root in `CMUXLAYER_REPO_HOME`, as `<root>/<repo>`
2. the cmuxlayer checkout itself, when its directory name *is* the repo
3. a sibling of that checkout
4. `~/Gits/<repo>`
5. `~/<repo>`

Nothing found is an error naming every path it searched — it never launches in
a lookalike directory. Entries 4 and 5 are defaults kept for existing installs;
`CMUXLAYER_REPO_HOME` is what the wizard writes, and it wins.

Because that search matches on *directory name*, a repository whose directory
differs from the name you gave it cannot be found this way. The wizard warns
when it sees that, and the fix is either to address the repo by its directory
name or to use launcher mode, where the path is recorded explicitly.

## Re-running it

`cmuxlayer init` refuses to overwrite an existing config; re-run with `--force`
to replace it, or edit the files by hand — they are plain shell and are meant to
be readable. The full behaviour of both lanes is in
[registry-optional-spawn.md](registry-optional-spawn.md).
