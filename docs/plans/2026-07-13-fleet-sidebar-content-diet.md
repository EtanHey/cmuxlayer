# Fleet Sidebar Content Diet Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove info-tier health noise and replace loud missing-status warnings with screen-parsed current action, using a subtle marker only as the final fallback in PR #309's generated fleet sidebar.

**Architecture:** Extend `ParsedScreenResult` with a strict nullable `current_action`, then carry it with aligned health issue codes and severity metadata into the existing fleet candidate. Apply set-status > parsed-action > dim-marker priority in the pure snapshot builder, filter health reasons there, and leave all structural/sidebar-publication behavior unchanged.

**Tech Stack:** TypeScript, Vitest, cmux 0.64.17 interpreted SwiftUI sidebar DSL.

---

### Task 1: Pin the content diet with RED tests

**Files:**
- Modify: `tests/screen-parser.test.ts`
- Modify: `tests/fleet-sidebar.test.ts`
- Modify: `tests/sidebar-sync.test.ts`

**Step 1: Write failing parser tests**

Assert Claude `Reading src/server.ts` and Codex `• Ran bunx vitest run` become
`current_action`, while a plain idle prompt yields `null`.

**Step 2: Write a failing snapshot test**

Create a candidate containing all four named info-tier codes and reasons. Assert
that its projected seat has no visible health text. Add a degraded
`inbox_monitor_not_alive` case and assert its full reason remains visible.

Assert set status wins over parsed action, parsed action wins over the marker,
and only a row with neither renders `— no status`.

**Step 3: Write a failing renderer test**

Assert a missing-status row contains `— no status`, never contains
`STATUS NOT SET`, and uses tertiary/dim styling.

**Step 4: Run RED**

Run: `bunx vitest run tests/screen-parser.test.ts tests/fleet-sidebar.test.ts tests/sidebar-sync.test.ts`

Expected: failures because the parser has no `current_action`, the candidate
does not carry it, the builder retains all health reasons, and missing status
is still loud.

### Task 2: Implement the minimal snapshot/renderer change

**Files:**
- Modify: `src/types.ts`
- Modify: `src/screen-parser.ts`
- Modify: `src/fleet-sidebar.ts`
- Modify: `src/agent-engine.ts`
- Modify: `tests/fleet-sidebar.test.ts`
- Modify: `tests/sidebar-sync.test.ts`

**Step 1: Parse current action**

Add `current_action: string | null` to `ParsedScreenResult`. Extract only strict
activity verbs or Codex tool/command bullet lines; do not promote arbitrary
terminal prose.

**Step 2: Carry issue metadata and parsed action**

Add candidate fields for `healthIssueCodes` and `healthIssueSeverities`. Populate
them from the already-evaluated `AgentHealth` result in `AgentEngine.syncSidebar`.
Capture `parseScreen(...).current_action` during the same screen read and add it
to the fleet candidate.

**Step 3: Filter actionable reasons**

Pair codes with reasons by index and retain only `degraded|blocking` entries.
Expose `healthVisible` and join only retained full reasons.

**Step 4: Apply status priority**

Project real set status first, then parsed current action, then `— no status`;
render only the final marker with tertiary color.

**Step 5: Run GREEN**

Run: `bunx vitest run tests/screen-parser.test.ts tests/fleet-sidebar.test.ts tests/sidebar-sync.test.ts`

Expected: both files pass.

### Task 3: Regenerate and visually verify

**Files:**
- Modify: `assets/sidebars/fleet.swift`
- Modify: `docs/assets/fleet-sidebar-v1.jpeg`

**Step 1: Regenerate the fallback from the empty snapshot**

Run the existing generator/asset parity test and update the committed Swift
asset to match.

**Step 2: Publish a live reconciled snapshot**

Generate `~/.config/cmux/sidebars/fleet.swift` from the live read-only registry,
screen, and health evidence without disturbing any worker.

**Step 3: Validate and inspect**

Run `cmux sidebar validate fleet --json`, open `fleet`, and confirm info-only
health rows have no health line while actionable reasons wrap fully.

**Step 4: Capture evidence**

Replace `docs/assets/fleet-sidebar-v1.jpeg` with the cleaner live render.

### Task 4: Verify, review, and merge PR #309

**Files:**
- All scoped delta files above

**Step 1: Run the completion gate**

Run typecheck, build, the full Vitest suite, sidebar validation, and
`git diff --check`.

**Step 2: Run bounded local CodeRabbit review**

Run `coderabbit review --agent --type uncommitted` for at most three minutes.
Disposition every critical/high finding; use the required fallback review if
the CLI is unavailable or limited.

**Step 3: Commit and push**

Stage only the content-diet delta and updated evidence. Push to
`feat/sidebar-v1-fleet`.

**Step 4: Update and re-review**

Update PR #309's body, post `content diet applied` with the new screenshot, and
request delta re-review from available reviewers. Read and disposition every
comment.

**Step 5: Merge and verify**

When CI and the delta review loop are clean, merge PR #309 with a merge commit,
verify the merge contains the latest pushed SHA/content, update BrainLayer, and
report the merge.
