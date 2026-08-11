# A3 Session Capture and Resume Correctness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make managed Codex agents resumable from their real rollout UUID and emit runnable, harness-correct recovery commands from clean registry fields.

**Architecture:** Split boot-session identity capture by harness. Codex trusts only the bounded rollout-directory lookup matched to launch cwd/time (and prompt when needed); existing Claude/Cursor paths retain their current resolver and screen behavior. Resume command construction validates the full UUID and uses an explicitly clean launcher name or a sanitized repo-derived launcher.

**Tech Stack:** TypeScript, Node.js filesystem APIs, Vitest, cmuxlayer registry/engine.

---

### Task 1: Pin Codex rollout-only capture

**Files:**
- Modify: `tests/agent-engine.test.ts`
- Modify: `src/agent-engine.ts`
- Modify: `src/harness-session.ts` only if candidate matching needs a narrow helper

1. Add a test whose Codex screen contains an unrelated contextual UUID while the matching rollout JSONL contains the real session UUID.
2. Record the expected failure in `docs.local/tasks/a3-capture-brief.md` under `PREDICTION` before running the test.
3. Run the focused Vitest case and verify it fails because the screen UUID is captured.
4. Add the smallest per-harness capture strategy so Codex never falls through to screen scraping and resolves only from rollout metadata matched to spawn cwd/time.
5. Re-run the focused case and existing boot-session capture cases.

### Task 2: Pin clean, full-ID resume commands

**Files:**
- Modify: `tests/agent-engine.test.ts`
- Modify: `src/agent-command.ts`
- Modify: `src/agent-facade.ts` only if clean launcher provenance belongs at the facade boundary

1. Add tests for the exact golems #695 canonical Codex command, full Claude UUID, and a polluted auto-discovered title/repo value.
2. Run the focused cases and verify the pollution case fails for the expected reason.
3. Validate full session UUIDs and launcher identifiers; fall back to a sanitized repo-derived launcher when the stored launcher is not clean.
4. Re-run the focused cases and route/facade tests.

### Task 3: Verify the decisive lifecycle receipt

**Files:**
- Modify: `tests/agent-engine.test.ts` or `tests/server-agent-tools.test.ts`
- Append: `docs.local/tasks/a3-capture-brief.md`

1. Add an integration-level test representing a spawned Codex agent whose rollout appears after spawn, then assert `resumable: true` and an exact runnable `resume_command` after lifecycle termination.
2. Run it red if any production behavior remains absent, implement only the missing behavior, and re-run green.
3. Run typecheck, focused tests, the full suite, and a real managed Codex spawn/stop/resume probe against the built binary.
4. Obtain a Claude pair review, address findings, and repeat verification.
5. Append the PREDICTION-vs-result diff and verification receipt to the task brief, ending with `DONE_A3_LANE`.
6. Sign the commit/PR, push `fix/a3-session-capture`, open the PR referencing #364 and #361, and dispatch the PR URL to `cmuxlayerClaude`.
