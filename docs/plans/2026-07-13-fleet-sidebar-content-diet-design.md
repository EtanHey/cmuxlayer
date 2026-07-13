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

Missing, blank, auto-discovered, or repair-placeholder status becomes
`— no status`. Its text uses the renderer's tertiary/dim color. A real status
keeps secondary text styling, making the operator-authored one-liner visually
stronger without adding decoration.

## Verification

- RED-first pure snapshot/render tests prove info-only health produces no
  health line and missing status never emits `STATUS NOT SET`.
- Integration coverage proves issue codes and severities flow from the existing
  reconciled health snapshot.
- The fallback asset remains byte-identical to the empty generator output.
- A live generated sidebar is validated, opened, and screenshot after the
  content diet; the PR body and comment receive the updated visual receipt.

