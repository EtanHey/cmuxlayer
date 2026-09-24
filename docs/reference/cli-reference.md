# CLI reference

How cmuxlayer launches, resumes, types into and reads each agent CLI it drives: Claude Code,
Codex, Cursor agent, Gemini and Kiro. Every fact cites the source line that implements it, so
when a CLI changes you know where to look.

Paths are relative to the repo root. Line numbers were checked against `main` when this page was
written; if one has drifted, search for the quoted symbol.

## Launch

cmuxlayer launches an agent in one of two forms (`src/agent-engine.ts:1537`, `buildLaunchCommand`):

- **Launcher form.** If a launcher is registered for the repo (see
  [registry-optional-spawn](../guides/registry-optional-spawn.md)), cmuxlayer runs
  `{repo}{Cli}` (for example `myrepoClaude`) with, when applicable, `-s` (skip approvals),
  `-w <cwd>`, `-m <model>` (only when a model resolves) and, for Codex, `-E <effort>` and
  `--worker` (`src/agent-engine.ts:1563-1576`; `--worker` is used only in the Codex form at
  `:1625`). The launcher owns
  the environment.
- **Raw form.** Without a launcher, cmuxlayer runs the CLI binary directly
  (`src/agent-engine.ts:1590`, `:1614-1617`). Kiro always uses its raw form.

| CLI | Raw binary | Skip-approvals flag | Model flag | Env added in raw form |
|---|---|---|---|---|
| Claude Code | `claude` | `--dangerously-skip-permissions` | `--model` | `MCP_CONNECTION_NONBLOCKING=1 CLAUDE_CODE_NO_FLICKER=1` |
| Codex | `codex` | `--dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust` | `-m`; effort `-c model_reasoning_effort=<e>` | none |
| Cursor | `cursor agent` | `--force` | `--model` (see [Cursor is Auto-only](#cursor-is-auto-only)) | none |
| Gemini | `gemini` | `-y` | `--model`, only for `gemini-*` names | same as Claude |
| Kiro | `kiro-cli` | none | `--model` | same as Claude (always) |

Sources: skip flags `src/agent-command.ts:70-88` (`RAW_SKIP_APPROVALS`); env
`src/agent-command.ts:16-17` (`AGENT_ENV`) applied at `src/agent-engine.ts:1594` (raw Claude and
Gemini) and `:1630` (Kiro); model flags `src/agent-engine.ts:1600-1612`; the Gemini name filter
`src/agent-engine.ts:1489`. With a launcher, Claude's `sonnet` becomes `-S`
(`src/agent-engine.ts:1563-1566`).

**Skip-approvals is configurable.** `CMUXLAYER_SPAWN_PERMISSION_MODE` defaults to
`skip-permissions`; `default`, `ask` or `prompt` make spawned agents prompt instead
(`src/permission-mode.ts:13-29`). `cmuxlayer init --permissions ask` writes it
(`src/init-wizard.ts:229-237`, `:511`). The same choice
applies to resume commands (`src/agent-command.ts:93-100`).

**If a raw launch cannot apply the model you asked for**, the spawn result carries a
`MODEL PIN NOT APPLIED` warning instead of failing silently (`src/agent-engine.ts:1513-1534`).

### Default models

From `src/model-policy.ts`:

| CLI | Default | Line |
|---|---|---|
| Claude Code | `claude-opus-5-5[1m]` | `:81` |
| Codex | `codex` (the launcher token; no `-m` is sent) | `:73` |
| Cursor | `auto` | `:46` |
| Gemini | `pro` | `:54` |
| Kiro | `opus` | `:91` |

A Codex model you name is checked in spawn preflight, before any worktree or pane is created
(`src/agent-engine.ts:2059-2066`): against your account's catalog (`codex debug models`), and only
if that cannot be read, against the list bundled with the binary, which can warn but never
reject. If neither list can be read, the spawn is refused (`src/agent-engine.ts:685-740`,
`:730-733`).

### Cursor is Auto-only

Cursor's default is `auto`. A non-`auto` Cursor model is coerced back to `auto` with a
`MODEL POLICY` warning (`src/model-policy.ts:266-289`). Setting `REPOGOLEM_ALLOW_MODEL` to `1`,
`true`, `yes` or `on` lets the requested model through (`src/model-policy.ts:3`, `:103-106`,
`:226`), and then a raw launch emits `cursor agent --model <m>`.

## Resume

Resume commands are built in `src/agent-command.ts:145-229`. A session UUID is required; anything
else is refused (`:153-155`).

| CLI | Raw resume form |
|---|---|
| Claude Code | `claude [skip] --resume <uuid>` |
| Codex | `codex [skip] resume <uuid>` (global flags go before the subcommand) |
| Cursor | `cursor agent [skip] --resume <uuid>` (there is no `--session` flag) |
| Kiro | `kiro-cli chat --resume-id <uuid>` |
| Gemini | refused: `gemini --resume` takes `latest` or an index, never a UUID (`:100-115`) |

**Why the working directory matters.** Claude Code, Cursor and Gemini key their transcripts by
working directory. Resuming from a different directory silently starts a new session instead of
resuming, so a raw resume for these CLIs is only offered when the original cwd is known, and it
`cd`s there first (`src/agent-command.ts:53-68`, `:120-127`). Codex keeps sessions in a global
store, and Kiro carries its own `cd`.

The skip-approvals flag is kept on resume: a resumed agent without it blocks on its first tool
call and looks like a hung pane (`src/agent-command.ts:77-80`).

## Typing into a pane

### Typed or pasted

Text is pasted when it spans more than one chunk or batch, or contains a newline, carriage return
or tab, or the literal escape sequences `\n`, `\r` or `\t` (`src/server.ts:2608-2621`).
Otherwise it is typed with the cmux `surface.send_text` call (`src/cmux-socket-client.ts:594-599`).

- A paste goes through cmux `set-buffer` then `paste-buffer` (`src/cmux-client.ts:573-584`). The
  socket protocol has no paste RPC, so pasting needs the CLI client
  (`src/cmux-socket-client.ts:602-613`).
- If a required paste fails, no Return is sent (`src/server.ts:2632-2638`).

### Limits

| Limit | Value | Source |
|---|---|---|
| Chunk size | 500 characters | `src/server.ts:653` |
| Inline maximum | 1,800 characters; `CMUXLAYER_MAX_INLINE_CHARS` overrides it (minimum 500) | `src/server.ts:657`, `:685-697` |
| Paste batch | 16,000 bytes | `src/server.ts:662` |

**Multi-paragraph text is refused** for Claude Code, Codex, Cursor and Gemini: a blank line can
split into separate submitted messages. Write the payload to a file and send one line,
`Read and follow <path>` (`src/server.ts:2641-2646`, `:2656-2679`). `allow_long_inline: true`
overrides the refusal.

### Submit

- Return is a separate key press about 50 ms after the text. The delay grows by 50 ms per extra
  chunk and by 100 ms for payloads of 500 bytes or more, capped at 250 ms
  (`src/server.ts:666`, `:4006-4012`).
- If the draft is still in the composer after the CLI's observe window, cmuxlayer waits 150 ms
  and sends one recovery Return (`src/server.ts:667`, `:6860-6891`).
- Observe windows before that recovery Return: Claude Code 4 s, except for the boot prompt,
  which uses 250 ms; Codex 250 ms; Cursor follow-ups 250 ms (`src/server.ts:709-712`,
  `:6848-6856`).
- An Antigravity (`agy`) boot prompt repaints slowly, so cmuxlayer polls every 250 ms for up to
  3 s to see it on screen before pressing Return (`src/server.ts:670-673`, `:6523-6531`).
- `return`, `enter`, `kp_enter`, `ctrl-m` and similar all count as a submit in the receipt
  (`src/key-names.ts:11-30`).

### Codex and Cursor composer states

- Codex's composer lines start with `›` or `»` (`src/screen-parser.ts:200-201`).
- Codex counts as working when a `Working (… esc to interrupt)` line, an empty composer and
  "tab to queue message" are all on screen (`src/server.ts:3020-3029`).
- "Messages to be submitted after next tool call" means Codex has queued your message for later.
  The pane stays active; it is not an unsent draft (`src/screen-parser.ts:204`, `:2198-2201`).
- Cursor shows a queued follow-up with "enter send now" (`src/pattern-registry.ts:43-46`;
  handled at `src/server.ts:3776-3783`).

## Reading state: ready, working, done

Patterns live in `src/pattern-registry.ts` and `src/screen-parser.ts`.

**Where the strings come from.** Most strings are *sampled*: copied from live panes, so a CLI
release can change them without notice. The Antigravity (`agy`) strings are *upstream-sourced*:
each one cites a byte offset in the agy 1.2.10 binary in its source comment
(`src/screen-parser.ts:284-318`, e.g. `esc to cancel` @48882141). The Source column says which,
and what pins it in the tests.

| CLI | Ready (prompt) | Working | Source |
|---|---|---|---|
| Claude Code | `❯`, high confidence | a spinner glyph (`✻✢✳✶⏺●`) + Thinking, Working, Running… | sampled; captured screens in `tests/fixtures/a3-claude/` |
| Codex | `›`, `»`, `❯`, `codex>` | `Working (`, `• Working`, Waiting, Thinking; "Starting MCP servers" means still booting | sampled; captured screens in `tests/fixtures/painpoints/`, `live/` |
| Cursor | `→`, `cursor>` | braille spinner or `⬢`/`⬡` + Calling, Editing, Reading… | sampled; `tests/fixtures/cursor-*.txt` |
| Gemini (gemini-cli) | `gemini>`, or a bare `>` seen twice (low confidence) | `✦ Working…` | sampled; inline test strings only, no captured screen |
| Gemini (agy) | an empty `>` composer between `─` rules | an `esc to cancel` footer, or a braille spinner right above the composer's top rule | upstream-sourced; specimens in `tests/fixtures/gemini-antigravity/` |
| Kiro | `kiro>`, or a bare `>` seen twice (low confidence) | not detected | no specimen |

Sources: prompt prefixes `src/pattern-registry.ts:28-34`; ready patterns `:36-103`; working
patterns `src/pattern-registry.ts:38-74` and `src/screen-parser.ts:249-283`, `:365-366`; Codex
boot `src/pattern-registry.ts:70-71`.

Done and stopped signals:

- A line that is just a `*_DONE` marker, for example `REVIEW_DONE`, optionally followed by one
  token of up to 16 characters (`src/screen-parser.ts:155-156`).
- Claude Code: `⏺ Completed` (`src/screen-parser.ts:319`).
- Codex: "To continue this session, run codex resume" (the CLI exited;
  `src/screen-parser.ts:255`).
- Cursor: "Task completed", "Generation complete", "All edits applied", "Session complete" or
  `✓ Done` (`src/screen-parser.ts:376-379`).
- A shell prompt coming back sets `control_state: "shell"`: the agent process is gone
  (`src/screen-parser.ts:1832-1834`).
- Codex `Goal paused (/goal resume)` is a **pause**, not done; a paused pane is never cleared as
  finished (`src/screen-parser.ts:328`, `src/agent-engine.ts:5406`).

Gemini agents launched through a launcher may run the Antigravity CLI (`agy`), which is not a
gemini-cli fork; a raw launch still runs `gemini`. An agy screen is recognized by its banner or
footer model (`src/screen-parser.ts:693`) and reported as Gemini (`:868`). Its signals are
structural, never spinner labels:

- Ready: an empty `>` composer between full-width `─` rules (`src/screen-parser.ts:303-307`;
  `antigravityScreenIsReady` at `:800`).
- Working: the footer starts with `esc to cancel` (`:316`), or a braille spinner sits right above
  the composer's top rule (`:308-310`); both are read by `antigravityScreenIsActive` (`:768`).
- Not working: a finished `▸ Thought for` row left in the transcript (`:313`, `:761-766`).
- Approval: `⚠ Approval Required` or `Do you want to proceed?` (`:317-318`).

Kiro has no screen parser: only the ready pattern above, and it is never reported as working
(`src/pattern-registry.ts:93-97`, `:231-232`).

## Slash commands

- cmuxlayer's public tools send no slash commands of their own. The internal `interact` handler,
  which is not callable over MCP, can send `/model <m>` and `/resume [id]`
  (`src/server.ts:20318`, `:20339-20341`).
- **Reloading MCP after an upgrade.** In each Claude Code session, run `/mcp reconnect cmuxlayer`
  (`scripts/post-release-reconnect-sweep.sh:67`); cmuxlayer prints that advice when a session runs
  a stale build (`src/version.ts:259`). To drive the `/mcp` menu in another agent's pane, see the
  [routing guide](../guides/agent-routing-and-handling.md). **Codex has no `/mcp`**: restart the
  Codex process (`scripts/post-release-reconnect-sweep.sh:64-65`).
- Nothing sends `/exit` or runs `/compact`. At high context use, a top-level agent gets a nudge
  line suggesting `/compact`, typed without Return (`src/agent-engine.ts:6848-6852`).
- Stopping an agent sends Ctrl-C; a forced stop sends SIGKILL to a PID whose identity is verified
  (`src/agent-engine.ts:11754-11788`).

## Menus and prompts

- **Codex "Update available!"** is matched exactly (`src/server.ts:2912-2925`). At spawn,
  cmuxlayer moves the selection down to "Skip until next version", re-reads the screen, and
  presses Return (`src/server.ts:2928-2966`, `:7817-7858`).
- **During monitoring,** the sweep classifies a Codex update menu as `codex_update_menu` and a
  model chooser as `model_menu` (`src/screen-parser.ts:1607-1635`). It only resolves them (with
  Escape) when `CMUXLAYER_EXPERIMENTAL_PROMPT_AUTO_RESOLVE=1`; otherwise the agent is escalated
  (`src/agent-engine.ts:1976-1977`, `:5320-5339`).
- **Permission prompts** are always escalated: the agent is marked `blocked_on_prompt` and no key
  is sent (`src/screen-parser.ts:1710-1711`, `src/agent-engine.ts:5394-5397`).
- **Folder-trust prompts:** cmuxlayer has no handler for them (no trust-prompt pattern in `src/`).
  Approve them by hand, or pre-trust the directory in the CLI.
