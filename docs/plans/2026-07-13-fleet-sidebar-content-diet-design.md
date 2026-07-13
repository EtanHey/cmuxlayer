# Fleet Sidebar Content Diet Design

## Approved scope

Keep the fleet sidebar's lanes, row nesting, state glyphs, counts, idle collapse,
click-to-focus action, ghost eviction, and coalesced generated-source publisher
unchanged. Change only row text density before merging PR #309.

## Health projection

`AgentHealth` already returns aligned `issue_codes` and `issues`, plus an
`issue_severities` value for each code. The fleet candidate will carry this
metadata into the pure snapshot builder. The builder will retain a reason only
when its code has `degraded` or `blocking` severity. `info` reasons—including
`auto_discovered_agent`, `missing_cli_session_id`, `non_resumable`, and an
info-tier `inbox_monitor_not_alive`—will not enter rendered row text. A degraded
`inbox_monitor_not_alive` or any blocking actionable issue remains visible with
its complete, wrapping reason.

The generated row will carry an explicit `healthVisible` Boolean so the
interpreted Swift view does not infer visibility from aggregate health status.
This keeps source generation deterministic even when a record has a mixture of
info and actionable issues.

## Status projection

Status priority is:

1. non-placeholder registry/set-status one-liner;
2. screen-parser `current_action`, derived from a strict current-activity or
   last-tool/command line such as `Reading src/server.ts`, `Running tests`, or
   Codex `Ran bunx vitest run`;
3. `— no status` only when both sources are empty.

The final marker uses the renderer's tertiary/dim color. Manual or parsed text
uses the existing secondary styling. The parser exposes `current_action` as a
structured nullable field instead of making the sidebar scrape raw terminal
text independently.

## Verification

- RED-first parser tests prove strict activity extraction, while pure
  snapshot/render tests prove status priority, info-only health produces no
  health line, and a fully missing status never emits `STATUS NOT SET`.
- Integration coverage proves issue codes and severities flow from the existing
  reconciled health snapshot.
- The fallback asset remains byte-identical to the empty generator output.
- A live generated sidebar is validated, opened, and screenshot after the
  content diet; the PR body and comment receive the updated visual receipt.
