# R7 Continuous CI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make SEAT A's integration timing deterministic under CI load and package the NIGHTLY real-cmux contract lane as an Etan-gated M4 LaunchAgent.

**Architecture:** Repair the test-only fake-clock driver so fake time advances only when a timer is pending, leaving production timing untouched. Add a caffeinate-pattern launchd bundle whose wrapper pins the NIGHTLY socket and emits explicit pass/fail/skip JSON receipts while documenting the pane-ancestry limitation.

**Tech Stack:** TypeScript, Vitest 3, Bun, Bash, macOS launchd.

---

### Task 1: Reproduce and fix residual fake-timer starvation

**Files:**
- Modify: `tests/server.test.ts`

**Step 1: Write the failing regression test**

Add a test-only handler that crosses more real event-loop turns than the current
helper's fixed fake-time loop before scheduling a fake timeout. Assert that
`runWithFakeTimers` returns the handler result.

**Step 2: Run RED**

Run:

```bash
bunx vitest run tests/server.test.ts -t "waits for non-timer async progress"
```

Expected: FAIL by timing out with the current helper.

**Step 3: Implement the minimal harness fix**

Capture the real `setImmediate`, snapshot the pre-handler timer count, yield one
real event-loop turn per iteration, and advance fake time only when the handler
has added a timer above that baseline. Throw a deterministic helper-budget error
if the handler never settles.

**Step 4: Run GREEN**

Run the new regression and the historical token-evidence test. Expected: both
pass without increasing their Vitest timeout.

**Step 5: Convert sibling timing assumptions**

Drive update-menu/relaunch cases with the same helper, await lifecycle startup
before asserting persisted registry state, and scope every static server-test
temporary directory by process and Vitest worker ID.

### Task 2: Specify the nightly launchd contract

**Files:**
- Create: `launchd/cmux-contract-nightly/tests/cmux-contract-nightly.sh`
- Create: `launchd/cmux-contract-nightly/tests/run-tests.sh`

**Step 1: Write failing shell tests**

Use fake `bun` binaries to cover terminal pass, command failure, and explicit
contract skip. Assert the wrapper pins `/tmp/cmux-nightly.sock`, writes a valid
dated JSON receipt, preserves a raw log, returns nonzero only for failure, and
that the plist contains a nightly calendar interval without `RunAtLoad` or
`KeepAlive`.

**Step 2: Run RED**

Run:

```bash
bash launchd/cmux-contract-nightly/tests/run-tests.sh
```

Expected: FAIL because the wrapper and plist do not exist.

### Task 3: Implement the nightly LaunchAgent bundle

**Files:**
- Create: `launchd/cmux-contract-nightly/bin/cmux-contract-nightly.sh`
- Create: `launchd/cmux-contract-nightly/launchd/com.golems.cmux-contract-nightly.plist`
- Create: `launchd/cmux-contract-nightly/README.md`

**Step 1: Write the wrapper**

Run the canonical repository command with the NIGHTLY socket pin, capture raw
output, classify the existing final marker, and atomically publish a JSON
receipt with date, timestamp, outcome, exit code, socket, command, and log path.

**Step 2: Write the plist and README**

Schedule one nightly run, use durable stdout/stderr paths, provide only the
Etan-gated bootstrap/reload commands, explain all three outcomes, and state the
plain-launchd ancestry limitation.

**Step 3: Run GREEN**

Run the shell test entrypoint and `plutil -lint`.

### Task 4: Verify under load and publish

**Files:**
- Modify: PR body only

**Step 1: Run ten loaded processes**

Start a bounded CPU load and run the affected server timing tests ten times with
`--pool=forks`, recording each fresh-process summary.

**Step 2: Run repository verification**

Run the launchd shell tests, `bun run test`, `bun run typecheck`, and
`bun run build`.

**Step 3: Review and publish**

Read the full diff, run the bounded local review gate, commit only SEAT A files,
push `test/r7-continuous-ci`, and open a ready-for-review PR with the exact
verification evidence and the ancestry finding.
