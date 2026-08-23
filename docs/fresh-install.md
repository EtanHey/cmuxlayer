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

Then install the lifecycle hooks that let Claude and Codex sessions register
their stable cmux surface identity and live process evidence:

```bash
cmuxlayer install-session-hooks
```

The installer adds one `SessionStart` command without replacing other hooks,
backs up each existing JSON config before changing it, and is safe to run again.
Codex hooks are enabled by default. Unattended cmuxlayer launches pass
`--dangerously-bypass-hook-trust` after the packaged script has been vetted;
prompting-mode or manually launched Codex sessions require a one-time `/hooks`
review whenever the exact hook definition changes. If `[features] hooks = false`
is set in `~/.codex/config.toml`, enable it before relying on registration.
Cursor hook wiring is not installed because its lifecycle payload is not
contract-compatible with the Claude/Codex scripts. Gemini and Kiro are outside
cmuxlayer's JSONL session-harness set.

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

The wizard writes `~/.config/cmuxlayer/env.sh`, and **cmuxlayer reads that file
itself at startup** — you do not have to source it for cmuxlayer to work. This
matters because an MCP client launched from the GUI (Claude Desktop, VS Code, a
launchd agent) never reads your shell profile; if the config only lived in
`~/.zshrc`, those clients would silently run without it.

Sourcing it is still worth doing, so that shells and panes see the same values:

```bash
echo '[ -f ~/.config/cmuxlayer/env.sh ] && . ~/.config/cmuxlayer/env.sh' >> ~/.zshrc
```

A variable already set in the environment always wins over the file, so an MCP
client that passes an explicit `env` block is never overridden by a stale
config. Only cmuxlayer's own settings are read from the file — it is parsed, not
executed, and it cannot set `PATH`, `NODE_OPTIONS`, or anything else.
`CMUXLAYER_CONFIG_FILE` points cmuxlayer at a different file.

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

Read-only, exits 0 when healthy, and names what it could not verify. Its
`init config:` line reports which config file the running process found and
which settings it actually applied — the fastest way to confirm your answers
reached cmuxlayer and not just your shell.

## Scripted installs

`--yes` runs the same thing with no prompts:

```bash
cmuxlayer init --yes \
  --repo ~/code/my-app \
  --repo ~/code/api \
  --permissions skip
```

`--repo <path>` names the repository after its directory; `--repo <name>=<path>`
sets the name explicitly — useful in launcher mode, where the path is recorded
and the directory name does not have to match. On the raw lane a name that
differs from the directory cannot be found (see "How a repository gets found"),
and the wizard says so when you try. Add `--print` to see the files without writing them,
and `--force` to overwrite an existing config. `cmuxlayer init --help` lists
every flag.

## What the wizard writes

### `~/.config/cmuxlayer/env.sh`

Shell exports, in every mode:

| variable | meaning |
|---|---|
| `CMUXLAYER_REPO_HOME` | colon-separated directories holding your checkouts. A repo named `<repo>` is looked for at `<root>/<repo>`, in order. A directory whose own path contains a `:` cannot be expressed here. |
| `CMUXLAYER_SPAWN_PERMISSION_MODE` | `skip-permissions` (unattended) or `default` (agents prompt). |
| `CMUXLAYER_LAUNCHER_REGISTRY_PATH` | written only in launcher mode: where the launcher registry lives. |
| `CMUXLAYER_REQUIRE_LAUNCHER_REGISTRY` | written only with `--require-registry`: fail a spawn for an unregistered repo instead of falling back to the CLI. |

These four are the only settings cmuxlayer accepts from the config file.
Anything else in it is ignored (and named by `cmuxlayer doctor`).

### `~/.config/ralphtools/launchers.zsh` — launcher mode only

This path is a historical default: it is where the launcher tooling cmuxlayer
was first built against keeps its registry, and cmuxlayer reads it so an
existing setup keeps working untouched. If you have no such file, you are not
in launcher mode and nothing writes here. To put the registry somewhere of your
own choosing, pass `--registry-path`, or set `CMUXLAYER_LAUNCHER_REGISTRY_PATH`.

**The file is yours, not cmuxlayer's.** It is read as a shell file that happens
to contain `repoGolem` lines: the wizard rewrites only those lines, in place,
and preserves everything else — functions, aliases, comments, guards — verbatim.
It will not touch an existing file without an explicit yes, and it copies the
current contents to `<file>.bak` before writing.

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

`cmuxlayer init` never rewrites a file that already exists without asking. The
interactive run tells you which file it would rewrite and where the backup goes,
and waits for a yes; `--yes` refuses outright unless you also pass `--force`.
Either way the current contents are copied to `<file>.bak` (`.bak.1`, `.bak.2`,
… — an earlier backup is never overwritten) before anything is written.

Re-registering a repository that already points somewhere else is reported as a
note naming both paths, so a moved checkout is never repointed silently.

You can also just edit the files by hand — they are plain shell and are meant to
be readable. The full behaviour of both lanes is in
[registry-optional-spawn.md](registry-optional-spawn.md).
