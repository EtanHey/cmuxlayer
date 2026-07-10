# Harness JSONL Field Map — one source of truth

> **Status:** canonical · **Owners:** cmuxlayer (live agent-state) + golems Phoenix ingest (`jsonl_to_phoenix_traces.py`).
> Both readers MUST agree on where each number lives per harness. Change this doc in lockstep with either reader.
> Every path below was verified against on-disk JSONL on 2026-06-04 — do **not** add a field without verifying it exists.

## Enablement
**DEFAULT-ON** as of 2026-06-04 (validated: 647 tests + 4 live Codex sessions correct).
Strictly additive — the JSONL overlay only fires when a session transcript resolves; otherwise
the screen-parser stands. Opt out with `CMUXLAYER_HARNESS_JSONL=0`. The resolver honors
`CODEX_HOME` and (for tests) `CMUXLAYER_HARNESS_HOME`.

## Why this exists
cmuxlayer reads the harness transcript JSONL (not the rendered terminal) to report real agent
state: tokens used, context window, model, last response, last tool, done. Phoenix ingest reads
the **same** JSONL to emit OTEL spans. They produce different outputs (live state vs spans) so
they do **not** share code — they share **this field map**. Terminal scraping is kept only for
live-TUI liveness the JSONL can't show (wedge / menu / permission prompt / idle-at-ready).

## Transcript locations (resolve from per-thread `cwd` + `sessionId`)
`app-server-bridge.ts` exposes `cwd` and `sessionId` per thread — that is the surface→JSONL link.

| Harness | Path template | Notes |
|---|---|---|
| **Claude** | `~/.claude/projects/<enc-cwd>/<sessionId>.jsonl` | `<enc-cwd>` = absolute cwd with every `/` → `-` (leading `-` kept). |
| **Codex**  | `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<sessionId>.jsonl` | Resolve by globbing `*<sessionId>*.jsonl` under `~/.codex/sessions/` (honor `CODEX_HOME`). |
| **Cursor** | `~/.cursor/projects/<enc-cwd>/agent-transcripts/<sessionId>/<sessionId>.jsonl` | Per-session subdir named by id. |

## Field map (verified paths)

### Claude — `~/.claude/projects/.../<sessionId>.jsonl`
One JSON object per line. Token usage lives on **assistant** events.
- **event filter:** `obj.type === "assistant"`
- **model:** `obj.message.model` — API id, e.g. `"claude-opus-4-8"`.
- **usage (last assistant event):** `obj.message.usage` =
  `{ input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens }`
  (also nested `cache_creation.ephemeral_{5m,1h}_input_tokens`).
- **tokens_used (context occupancy):** `input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens` of the **last** assistant usage. (= Phoenix `prompt + completion = total`.)
- **context_window:** ❌ NOT in JSONL. Derive from model via the verified table below.
- **last_text:** last assistant `message.content[]` item with `type:"text"`.
- **last_tool:** last assistant `message.content[]` item with `type:"tool_use"` → `.name`.
- **done:** no explicit field; liveness comes from the screen-peek, not the JSONL.

### Codex — `~/.codex/sessions/.../rollout-*.jsonl`
One JSON object per line, **wrapped**: `{ type, timestamp, payload }`. Real type is `payload.type`.
- **token usage + window (last `token_count` event):** `payload.type === "token_count"` → `payload.info` =
  - `info.last_token_usage = { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens }`
  - `info.total_token_usage = { ... }` — **cumulative across session; NOT context occupancy.**
  - `info.model_context_window` — **the REAL window for this session** (e.g. `258400`). ✅ in-JSONL.
- **tokens_used (context occupancy):** `info.last_token_usage.total_tokens` of the **last** token_count event.
- **context_window:** `info.model_context_window`, except when an explicitly versioned verified
  table rule is larger. Use the larger value because client CLIs can lag model reality and an
  under-denominator can wrongly retire an orchestrated seat. Unknown models keep JSONL as their
  only signal.
- **model:** last `turn_context` event → `payload.model` (e.g. `"gpt-5.5"`). (`session_meta` has `cwd`,`id`,`cli_version`,`model_provider` but NOT the model id.)
- **last_text:** last `agent_message` → `payload.message`.
- **last_tool:** last of `{function_call, custom_tool_call, mcp_tool_call_end}` → `payload.name`.
- **done:** last `task_complete` event (has `last_agent_message`, `duration_ms`, `turn_id`).
- **envelope:** every line is `{ type, timestamp, payload }`; read `payload.type` (falls back to outer `type` for `session_meta`).

### Cursor — `~/.cursor/projects/.../agent-transcripts/<id>/<id>.jsonl`
One JSON object per line: `{ role, message:{ content:[...] } }`. **Claude-style content blocks.**
- **tokens_used:** ❌ NONE in JSONL.
- **context_window:** ❌ NONE in JSONL.
- **context_pct:** ❌ NOT derivable from JSONL → **keep the TUI status-strip ("Auto · X%") scrape.**
- **model:** ❌ not in transcript (Cursor config lives elsewhere).
- **last_text:** last `message.content[]` item `type:"text"` on an `assistant` row.
- **last_tool:** last `message.content[]` item `type:"tool_use"` → `.name` on an `assistant` row.
- **done:** no explicit field; liveness from screen-peek.

## Verified per-model context-window table
Source: researcher, citation-backed, BrainLayer `brainbar-8a3da79c-159` (2026-06-04), plus
gpt-5.6 verified by Etan web-verify + fleet rules doc §10 (2026-07-11).
Used for Claude (no window in JSONL), as a fallback when harness JSONL is unavailable, and as a
floor when an explicitly versioned Codex rule is larger than the CLI-reported JSONL window.

| Model (API id / family) | Window | Notes |
|---|---|---|
| `claude-opus-4-6/4-7/4-8`, `claude-sonnet-4-6` | 1,000,000 | 1M now standard (not beta) on these gens. |
| `claude-haiku-4-5`, Sonnet/Opus 4.0–4.5, `opus-4-1` | 200,000 | 200K tier. |
| gpt-5.6 family | 1,050,000 | Verified whole-family window; larger of this and Codex JSONL wins. |
| gpt-5 / gpt-5.1 / gpt-5.5 / gpt-5-codex | 400,000 | Generic fallback; Codex JSONL overrides per-session. |
| gpt-4o / gpt-4-turbo | 128,000 | |
| gemini-2.5 / 3 / 3.1 pro | 1,048,576 | Not 2M. |
| unknown | `null` | **Never emit a wrong 1M.** Omit context_pct. |

## Semantics note
`context_pct = round(tokens_used / context_window * 100)`, clamped [0,100]. `tokens_used` is the
current context **occupancy** (last turn), NOT the session cumulative. Mixing the two is the
exact class of bug (false "near limit") this map prevents.
