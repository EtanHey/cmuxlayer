# Clickable Collapsed Leads and mm Lane Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep idle/collapsed fleet leads focusable by stable UUID and place mm seats in a dedicated `mm` lane.

**Architecture:** Preserve the existing reconciled fleet snapshot and generated SwiftUI pipeline. Carry the lead's resolved stable UUID into the collapsed summary projection, render a focus button only when that UUID exists, and extend the pure lane inference table with boundary-aware mm launcher/repo/worktree recognition.

**Tech Stack:** TypeScript, Vitest, generated SwiftUI custom-sidebar source, cmux staging sidebar output.

---

### Task 1: Make collapsed lead summaries focusable

**Files:**
- Modify: `tests/fleet-sidebar.test.ts`
- Modify: `tests/topology-contract.test.ts`
- Modify: `src/fleet-sidebar.ts`
- Modify: `src/agent-engine.ts`

1. Add regression tests proving a collapsed present lead emits `surface.focus` with its observed stable UUID and a legacy ref-only lead emits no lead focus button through the production topology path.
2. Run the focused test and confirm RED because the current lead projection omits UUID and `fleetLeadSummary` is an `HStack` only.
3. Preserve resolved UUID provenance on the projected seat, add `surfaceUuid` to the lead dictionary, and render the summary inside a `Button` only when the UUID is non-empty.
4. Run the focused test and full `tests/fleet-sidebar.test.ts` file; confirm GREEN while the lane header remains non-interactive and status stays one line.

### Task 2: Normalize mm seats into an mm lane

**Files:**
- Modify: `tests/fleet-sidebar.test.ts`
- Modify: `tests/fleet-sidebar-cli.test.ts`
- Modify: `src/fleet-sidebar.ts`
- Modify: `src/fleet-sidebar-cli.ts`

1. Add regression fixtures for `mmClaude`/`mmCodex`, repo `mm`, and `~/Gits/mm.wt/...`; assert all resolve to `mm`, not `other`.
2. Run the focused test and confirm RED because `FleetLaneKey`, lane order, labels, and inference currently omit `mm`.
3. Add the `mm` lane and boundary-aware recognition for mm launcher/repo/worktree identities without broad substring matching; include it in the CLI expand/collapse allowlist.
4. Run the focused test and full sidebar test file; confirm GREEN.

### Task 3: Tint seat accents by agent type

**Files:**
- Modify: `tests/fleet-sidebar.test.ts`
- Modify: `tests/topology-contract.test.ts`
- Modify: `src/fleet-sidebar.ts`
- Modify: `src/agent-engine.ts`
- Modify: `assets/sidebars/fleet.swift`

1. Add regression fixtures proving Claude row and collapsed-lead accents use orange, Codex accents use blue, and Gemini/Cursor/Kiro use a neutral token while state-dot colors remain unchanged.
2. Run the focused tests and confirm RED because fleet candidates/seats and generated dictionaries omit `agentType` and accents are role-based.
3. Project the registry CLI through `agentType`, add the generated Swift tint helper, and apply it only to row and lead-summary RoundedRectangle backgrounds.
4. Run the focused tests, topology contract, and full sidebar test file; confirm GREEN and fallback-asset parity.

### Task 4: Verify staging output and deliver one PR

**Files:**
- Verify: `src/fleet-sidebar.ts`
- Verify: `tests/fleet-sidebar.test.ts`
- Verify: an ephemeral staging sidebar with a unique name (never `fleet.swift` or `fleet-dev.swift`)

1. Run `bun run test`, `bun run typecheck`, and `bun run build` and read their complete results.
2. Generate a fixture-backed sidebar through an injected temporary `outputPath`; render it as a uniquely named staging sidebar and inspect the screenshot pixels for a collapsed clickable lead and an `mm` lane. Never create or mutate `fleet.swift` or `fleet-dev.swift` in the live sidebar directory, and remove the staging output immediately after capture.
3. Review the diff against the brief, commit the scoped files, push the worker branch, and open `fix(sidebar): clickable collapsed leads + mm lane normalization`.
4. Post the PR URL to the driver-buddy hub tagged `@cmuxlayerRethink-lead`, then store WHAT changed and WHY in BrainLayer.
