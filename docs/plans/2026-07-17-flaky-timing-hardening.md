# Flaky Timing Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make every cataloged timing-sensitive test deterministic without timeout increases, retries, serialization, or behavioral coverage loss.

**Architecture:** Keep production timing policy intact. Repair harness ordering with controlled fake time and one-shot fixtures, and inject only the fleet collapse watcher boundary so tests can signal the same cached-publication path without real `fs.watchFile` scheduling.

**Tech Stack:** TypeScript, Vitest 3, Bun, Node timers/filesystem/Unix sockets.

---

### Task 1: Make the fleet watcher boundary hermetic

**Files:**
- Modify: `src/fleet-sidebar.ts`
- Modify: `tests/fleet-sidebar.test.ts`

**Step 1: Write the watcher-seam tests**

Update the two flaky tests to inject a watcher factory, capture its change
listener, and invoke that listener after writing collapse state. Assert the
factory receives the exact state path and its cleanup runs on dispose.

**Step 2: Verify RED**

Run the two named tests. Expected: type/test failure because
`collapseStateWatcher` is not yet a publisher option.

**Step 3: Implement the minimal watcher seam**

Add the injectable watcher factory to `FleetSidebarPublisherOptions`; keep a
default adapter that registers `watchFile` with the existing 100ms production
interval and returns an `unwatchFile` cleanup closure.

**Step 4: Verify GREEN**

Run both tests and the complete fleet-sidebar file. Expected: all pass with the
same render/topology assertions and no wall-clock polling loop.

### Task 2: Control the manifest and waitFor clocks

**Files:**
- Modify: `tests/server-agent-tools.test.ts`
- Modify: `tests/agent-engine.test.ts`

**Step 1: Drive manifest launch time explicitly**

Start the spawn handler and server lifecycle initialization, advance fake
timers in small async slices until both settle, then assert the exact manifest.
Restore real time in `finally` and add file-scope lifecycle-context cleanup so
no test-owned sweep survives.

**Step 2: Stage done-evidence confirmation**

Pin fake system time, advance one polling tick, assert that trailing output
created `task_done_candidate_at`, then advance the five-second confirmation
window and await the original `waitFor` promise.

**Step 3: Verify focused GREEN**

Run both named tests and their complete files. Expected: existing behavioral
assertions pass without real launch waits or a coarse timeout-crossing jump.

### Task 3: Bound the proxy fixture to one version transition

**Files:**
- Modify: `tests/proxy-version-bump.test.ts`

**Step 1: Preserve RED evidence**

Use the recorded concurrent run where the current fixture failed twice in ten
fresh processes and connection 2 contained only `initialize`.

**Step 2: Make stale detection one-shot**

After the fixture reports the intended installed-version bump once, have later
checks report matched versions. Keep the real Unix socket, replay response, and
exact `initialize` → `notifications/initialized` → `tools/list` assertion.

**Step 3: Verify GREEN**

Run the named test and complete proxy-version-bump file repeatedly.

### Task 4: Prove determinism and publish

**Files:**
- Modify: PR body only

**Step 1: Loop every fixed test and file**

Run each named test and each affected file at least 20 times in fresh processes,
starting a new process for every iteration and recording zero failures per
target.

**Step 2: Run the full gate three times**

Run the exact brief command in three fresh processes and record file/test
counts and failures.

**Step 3: Review and publish**

Run typecheck/diff checks, bounded local CodeRabbit review, commit, push
`fix/flaky-timing-tests`, and open a ready PR with the catalog, classifications,
and loop evidence. Invoke PR reviewers, resolve real findings, and do not merge.

**Step 4: Report SETTLED**

Re-enumerate cmux surfaces, send the PR URL/head/full evidence to cmuxLead-v2
surface:143, verify the message in scrollback, and store WHAT + WHY in
BrainLayer.
