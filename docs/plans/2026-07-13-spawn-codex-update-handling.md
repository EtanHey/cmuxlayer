# Codex Auto-update Launch-readiness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `spawn_agent` recognize Codex CLI self-update progress/completion, accept interactive updates, relaunch the original command, and deliver the boot prompt without a false timeout or poisoned agent record.

**Architecture:** `screen-parser.ts` will expose one optional canonical `cli_update_state` signal (`updating` or `update_complete`) from active terminal-tail output. The existing bounded readiness recovery in `server.ts` will consume that signal instead of maintaining a narrower duplicate regex, preserving its two-cycle relaunch cap and update-specific time budget. Deterministic fixtures drive parser and full `spawn_agent` tests through launcher, updater, restart shell, relaunched Codex, and submit-verification screens.

**Tech Stack:** TypeScript, Bun, Vitest, mocked cmux terminal screens.

---

### Task 1: Capture the live updater sequence as RED

**Files:**
- Create: `tests/fixtures/spawn/codex-auto-update-restart.json`
- Modify: `tests/screen-parser.test.ts`
- Modify: `tests/server.test.ts`

1. Add a fixture whose screens contain the live `Updating Codex CLI from X → Y`, `Downloading Codex CLI …`, `Installing standalone package …`, and `Update ran successfully! Please restart Codex.` forms.
2. Add parser assertions for `cli_update_state: updating` and `cli_update_state: update_complete`, plus a stale-transcript guard when a ready Codex composer follows old updater output.
3. Add a `spawn_agent` harness test that feeds the update-complete line and shell prompt together, asserts the original launcher command is sent twice, boot prompt submission is verified once, and the managed record ends `ready` rather than `error`.
4. Run the focused tests and confirm they fail because the parser signal is absent and the launch-readiness path times out.

### Task 2: Implement canonical update-state parsing

**Files:**
- Modify: `src/types.ts`
- Modify: `src/screen-parser.ts`
- Test: `tests/screen-parser.test.ts`

1. Add `ParsedCliUpdateState = "updating" | "update_complete"` and optional `cli_update_state` to `ParsedScreenResult`.
2. Parse explicit update-complete/restart markers before progress markers; only inspect the active tail and suppress stale updater output when a later recognized agent-ready screen exists.
3. Cover Codex's live progress wording and the existing generic `Updating … via …` wording so Claude/Cursor/Gemini behavior does not regress.
4. Run the parser tests and confirm GREEN.

### Task 3: Consume parser state in launch-readiness

**Files:**
- Modify: `src/server.ts`
- Test: `tests/server.test.ts`

1. Replace the server-local update marker regexes with `parsed.cli_update_state`.
2. Treat `updating` as a recoverable boot phase with the existing update timeout extension.
3. Treat `update_complete` plus a shell prompt as the relaunch trigger even when completion and shell appear in the same screen.
4. Preserve `BOOT_PROMPT_UPDATE_RELAUNCH_MAX = 2`, the exact original launcher command, submit verification, and non-poisoning timeout behavior.
5. Run the focused parser/server tests and confirm GREEN.

### Task 4: Same-class sweep and full verification

**Files:**
- Modify tests only if locally observed Claude/Cursor updater output shares the same explicit markers.

1. Inspect installed Claude and Cursor launchers plus repository fixtures for their update prompt shapes.
2. Document whether the canonical generic parser coverage applies or why no cheap deterministic fixture is warranted.
3. Run `bun run typecheck`, focused regression tests, `bun run pre-pr`, and `bun run test`.
4. Revert the production fix temporarily and confirm the regression test returns RED, then restore it and rerun GREEN.

### Task 5: Review-ready PR delivery

**Files:**
- All scoped source, fixture, test, and plan files from Tasks 1–4.

1. Review the diff and run the bounded local CodeRabbit review.
2. Commit the scoped files, push `fix/spawn-codex-update-handling`, and open a ready-for-review PR titled `fix(spawn): handle Codex CLI auto-update during launch-readiness (detect + auto-relaunch, no false timeout)`.
3. Invoke configured reviewers, read every review/check result, address actionable findings, and repeat until the PR is green.
4. Post/store the PR URL and WHAT+WHY verification evidence. Do not merge; the mission endpoint is a green PR for the owning lead.

## Execution notes

- Same-class sweep (2026-07-13): installed Claude Code uses a background/native updater and exposed no startup restart screen matching Codex's flow. Installed Cursor Agent exposes an explicit `update` command and likewise showed no startup `Please restart Cursor` screen. The canonical `Updating … via …` parser path remains covered for any CLI that does emit the existing generic form; no speculative Claude/Cursor fixture was added.
- Counterfactual verification: disabling `cli_update_state` made the launch-readiness regression test time out; restoring the parser signal returned the focused test to green.
- Local CodeRabbit CLI review: `SKIPPED — free OSS rate limit (24 minutes)`. Required red-team and blue-team diff reviews completed with no critical, high, or medium findings.
- Macroscope review: fixed its medium false-positive finding by requiring ambiguous bare `Downloading…` / `Installing…` steps to have no earlier ready-agent transcript; CLI-specific installer lines remain independently detectable.
- Codex review: fixed the complementary later-evidence case by recognizing a minimal `codex>` composer independently of whole-screen agent-type inference.
