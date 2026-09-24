# cmuxLayer

cmuxLayer exposes a 10-tool public MCP surface for controlling cmux terminal workspaces and managing CLI agents.

<p align="center">
  <img src="./assets/cmuxlayer-logo-split-pane-grid.svg" alt="cmuxLayer" width="96" height="96" />
</p>

[![install](https://img.shields.io/badge/install-brew%20install%20etanhey%2Flayers%2Fcmuxlayer-22c55e)](#quick-start)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![MCP Tools](https://img.shields.io/badge/MCP-10%20tools-green.svg)](https://modelcontextprotocol.io)
[![Tests](https://img.shields.io/badge/tests-4452%20collected-brightgreen.svg)](#testing)

## Quick start

```bash
brew install etanhey/layers/cmuxlayer       # stable, pinned release
brew install --HEAD etanhey/layers/cmuxlayer # or: dogfood the latest main
```

This installs the `cmuxlayer` command plus `cmuxlayer-app-server` and
`cmuxlayer-proxy`. [cmux](https://github.com/manaflow-ai/cmux) must be running.
For fleet wiring, versions, dogfooding, and the `CMUX_SOCKET_PATH` pin, see
[docs/guides/releases-and-brew.md](docs/guides/releases-and-brew.md).

Then set up this machine:

```bash
cmuxlayer init
```

The wizard selects spawnable repositories, per-repo launchers or direct CLI
launches, and approval behavior. It writes `~/.config/cmuxlayer/env.sh` and, in
launcher mode, a launcher registry. cmuxlayer reads both at startup, including
when an MCP client starts it from a GUI. The wizard asks before replacing a file
and creates a backup first.

For scripted installs, pass `--yes` with `--repo <name>=<path>`. cmuxlayer does
not assume a fixed repository layout. See
[docs/guides/fresh-install.md](docs/guides/fresh-install.md) for the walkthrough and
[docs/guides/registry-optional-spawn.md](docs/guides/registry-optional-spawn.md) for how each
lane behaves.

### Optional fleet sidebar

Install the optional lane-grouped fleet view with:

```bash
bun run install:fleet-sidebar
```

cmuxLayer refreshes `~/.config/cmux/sidebars/fleet.swift` from its reconciled
live-agent snapshot. It does not change cmux settings or replace the stock
sidebar. Activate it from the sidebar toggle by choosing `fleet`.

Development and screenshot QA use a separate picker entry:

```bash
bun run install:fleet-sidebar:dev
bun run dev
```

Those commands publish only
`~/.config/cmux/sidebars/fleet-dev.swift`; choose `fleet-dev` in cmux while
testing. Runtime tests must inject a temporary publisher `outputPath`.

Add to your MCP config:

**Codex CLI / T3 Code**

T3 Code inherits MCP servers from the Codex CLI config file at `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`).

```toml
[mcp_servers.cmuxlayer]
command = "cmuxlayer"
env_vars = ["CMUX_SURFACE_ID", "CMUX_WORKSPACE_ID", "CMUX_TAB_ID", "CMUX_SOCKET_CAPABILITY", "CMUX_SOCKET_PATH"]
```

`env_vars` forwards the pane's existing values into Codex's MCP process. Do not paste a capability value into this file.

**Claude Code, Cursor, VS Code, Claude Desktop**

```json
{
  "mcpServers": {
    "cmuxlayer": {
      "command": "cmuxlayer"
    }
  }
}
```

To keep only a per-session resident subset of tools, set
`CMUXLAYER_DEFAULT_PALETTE` to comma-separated bare tool names, for example
`list_surfaces,spawn_agent,send_to`. The server also exposes `expand_palette`,
which registers the rest of the 10 public tools for the rest of that MCP
session; it never exposes the internal definitions.
When unset or blank, the signed 10-tool thin-core default applies. When set, the
environment value overrides that default for the session. Unknown names are
warned and ignored while valid names still load.

Autonomous prompt resolution is experimental and disabled by default.
cmuxlayer detects prompt choosers, marks the agent `blocked_on_prompt`, and
escalates without sending a key. Setting
`CMUXLAYER_EXPERIMENTAL_PROMPT_AUTO_RESOLVE=1` restores the known-imperfect
Escape-based resolver for isolated testing only; do not enable it for fleet use.

> **Config locations:** Codex CLI / T3 Code `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`) | Claude Code `.mcp.json` or `claude mcp add cmuxlayer -s user -- cmuxlayer` | Cursor `.cursor/mcp.json` | VS Code `.vscode/mcp.json` | Claude Desktop — see [MCP docs](https://modelcontextprotocol.io/quickstart/user) for platform-specific paths

## What you can do

Tell your AI agent things like:

- *"Split a pane to the right and run my test suite there"*
- *"Spawn a Claude Code agent in a new pane to refactor auth.ts"*
- *"Read the screen of surface:2 and tell me if the build passed"*
- *"Wait for all agents to finish, then read their output"*
- *"Set the sidebar status to show our deploy progress"*

cmuxLayer retains 45 internal tool definitions; only 10 are registered and callable through MCP. The other 35 are not exposed through ToolSearch or any other MCP path. `read_screen` parses agent metadata (status, model, tokens, context %) for Claude Code, Codex, Gemini, and Cursor.

## Agent routing workflow

For managed agents, use the agent-first path: `list_agents` to find the target, `send_to` to deliver work by `agent_id`, then `wait_for` when you need completion. `send_to` also preserves the registry-independent escape hatch: use `mode:"surface"`, `mode:"command"`, or `mode:"key"` with a raw surface ref for shells, launch/resume commands, and stuck-pane recovery.

See [Agent Routing and Handling Workflow](docs/guides/agent-routing-and-handling.md) for the full operator playbook, including stuck surface recovery and safe `/mcp` menu reconnects.

## MCP tools (10 registered and callable)

All public tools include [ToolAnnotations](https://modelcontextprotocol.io/specification/2025-03-26/server/tools#annotations) that clients can use in safety policy.

**Public MCP surface** — `spawn_agent` `report_to_parent` `send_to` `read_screen` `list_agents` `wait_for` `control_health` `close_surface` `update_surface` `list_surfaces`

| Tool | What it does |
|------|-------------|
| `spawn_agent` | Spawn a CLI agent and return an `agent_id` for routing |
| `report_to_parent` | Raise a short blocker to the managed agent's registry parent |
| `send_to` | Send by agent ID or raw surface using `mode:"agent"\|"surface"\|"command"\|"key"` |
| `read_screen` | Read terminal output with parsed agent status |
| `list_agents` | All agents, with optional filters |
| `wait_for` | Wait for one `agent_id` or several `ids` (defaults to `done`) |
| `control_health` | Report socket, binary, process, and job-control diagnostics |
| `close_surface` | Close one surface, managed agent, or workspace, with live-agent guards |
| `update_surface` | Move or rename one terminal surface |
| `list_surfaces` | List all surfaces across workspaces |

These 10 are the whole public surface. The internal definitions are not callable over MCP.

## Supported agents

| CLI | Command | Auto-detected |
|-----|---------|---------------|
| Claude Code | `claude` | status, model, tokens, context % |
| Codex | `codex` | status, model, context % |
| Gemini CLI | `gemini` | status, model, tokens, context % |
| Cursor | `cursor agent` | status, model, tokens, context % |
| Kiro CLI | `kiro-cli` | spawn and lifecycle only; no Kiro-specific screen parser |
`read_screen` auto-detects agent type and parses metadata from terminal output.

## Architecture

```text
AI Agent  ─── MCP ───>  cmuxLayer  ─── Unix socket ───>  cmux
                         ├── Agent engine (spawn → monitor → teardown)
                         ├── Screen parser (Claude Code, Codex, Gemini, Cursor)
                         ├── Mode policy (autonomous vs manual)
                         ├── State manager + event log
                         ├── Metacomm READ  — harness JSONL (real tokens/context/model)
                         └── Metacomm WRITE — per-agent inbox file + Monitor dispatch
```

The socket client connects to cmux through a persistent Unix socket instead of starting a `cmux` CLI subprocess per call. It reconnects after a disconnect and falls back to the CLI subprocess when the socket is unavailable.

## Troubleshooting

**cmux is not running**
cmuxLayer requires a running [cmux](https://github.com/manaflow-ai/cmux) instance. Install it first, then start a cmux session before using cmuxLayer.

**Tools not appearing in Codex CLI or T3 Code**
Restart the client after adding `cmuxlayer` to `~/.codex/config.toml`. If you use a custom Codex home, verify `$CODEX_HOME/config.toml` contains the same `mcp_servers.cmuxlayer` entry.

**Tools not appearing in Claude Code**
Restart Claude Code after adding the MCP config. Run `claude mcp list` to verify cmuxlayer is connected.

**Socket connection failed**
cmuxLayer auto-discovers the cmux socket (macOS: `~/Library/Application Support/cmux/cmux.sock`). Override with `CMUX_SOCKET_PATH` if needed.

**"Cannot resolve a working directory for repo ..."**
cmuxLayer could not find that checkout. Run `cmuxlayer init` to register it, or
set `CMUXLAYER_REPO_HOME` to the colon-separated directories holding your
repositories. The error lists every path it searched.

## Testing

```bash
bun run test        # vitest; 4452 tests collected by `vitest list`
bun run typecheck   # Type checking
```

## Git hooks

Enable project hooks to run the regression gate automatically on `git push`:

```bash
git config core.hooksPath .githooks
```

This enables `.githooks/pre-push`, which runs `scripts/run_tests.sh` and blocks pushes on regression failures.

## Development

```bash
bun install
bun run dev         # Run with tsx (hot reload)
bun run build       # Compile TypeScript
bun run start       # Run compiled output
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and PR guidelines.

## License

Apache 2.0 — see [LICENSE](LICENSE).

---

Part of the [Golems](https://github.com/EtanHey/golems) AI agent ecosystem. [cmuxlayer.etanheyman.com](https://cmuxlayer.etanheyman.com) | Built by [@EtanHey](https://github.com/EtanHey).
