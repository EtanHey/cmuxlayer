# Real cmux Contract Lane Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an opt-in `bun run test:contract` lane that verifies cmuxlayer against a live, explicitly pinned cmux instance without mutating that instance or touching fleet daemon state.

**Architecture:** A standalone TypeScript runner performs the live assertions so Vitest's default discovery can never execute them. The runner first probes the explicit `CMUX_SOCKET_PATH`; absence or an unreachable/denied socket prints a clear skip and exits 0. Once admitted, it drives only read-only cmux/MCP operations, uses a temporary `CMUXLAYER_DAEMON_SOCKET` for all lifecycle checks, records every spawned PID, and sends signals only to those recorded PIDs during the isolated retire/autostart assertion and cleanup.

**Tech Stack:** TypeScript/tsx, Node Unix sockets and child processes, MCP JSON-RPC over stdio, Vitest for hermetic runner-unit tests, Bash release gating.

---

## Design

### Alternatives considered

1. **Recommended: standalone contract runner plus hermetic unit tests.** This keeps the live lane wholly outside default Vitest discovery, permits a precise skip message/exit code, and makes PID/socket safety explicit. The trade-off is a small MCP harness in the runner.
2. **Dedicated Vitest config and live test file.** This provides familiar assertions, but top-level reachability/skip reporting and detached-helper cleanup become harder to reason about, and an exclude/include configuration regression could leak the lane into `bun run test`.
3. **Shell-only smoke script.** This is easy to invoke from releases, but JSON-RPC framing, response-shape validation, timeouts, and process cleanup are substantially more fragile in Bash.

### Runtime flow

1. Require a non-empty `CMUX_SOCKET_PATH` and send a bounded `system.ping` directly to that exact socket. Missing, unreachable, or access-denied pins produce `SKIP` and exit 0.
2. Assert the admitted pane-descended process receives the expected `{ pong: true }` shape.
3. Spawn a short-lived helper that launches a detached grandchild, exits, and leaves the grandchild reparented. The grandchild sends `system.ping` to the same socket and writes a result receipt into the contract temp directory. Assert the real daemon rejects it with the EPIPE/broken-pipe ancestry-denial signature. Record both helper and grandchild PIDs and clean up only those PIDs if still alive.
4. Spawn `node dist/index.js` with the live cmux pin, a unique temp `CMUXLAYER_DAEMON_SOCKET`, a temp `HOME`, and piped MCP stdio. Initialize MCP, call `control_health`, and record the daemon PID returned by the real dist daemon.
5. Call `list_surfaces`, choose a terminal surface from its structured response, then call `read_screen` for that exact surface/workspace. Assert both real-daemon calls return structured, non-error results.
6. Run `node dist/index.js doctor --json` under the same isolated environment and assert exit 0 plus `healthy: true` and the expected daemon/cmux socket pins.
7. Send SIGTERM only to the recorded isolated daemon PID, wait for it to exit, then issue another MCP request through the still-running proxy. Assert a replacement daemon is autostarted on the same isolated socket, returns healthy, and has a different recorded PID.
8. Close the proxy and SIGTERM any still-live recorded child PID. Remove only the temp contract directory. Never unlink or write to `CMUX_SOCKET_PATH`.

### Error handling and safety

- All socket and MCP calls have finite timeouts and include captured stderr in failures.
- The live cmux socket is used only for `system.ping`, `workspace.list`, `pane.list`, `surface.list`, and `surface.read_text` (directly or through read-only MCP tools).
- Every lifecycle operation is guarded by an assertion that the daemon socket resides inside the freshly created temp root.
- Cleanup iterates the recorded PID set; broad `pkill`, process-name matching, production socket cleanup, and fleet daemon signals are forbidden.
- Contract assertion failures exit non-zero. Lack of a reachable explicit live pin is the only skip path and exits 0.

## Implementation Tasks

### Task 1: Specify runner contracts with failing hermetic tests

**Files:**
- Create: `tests/real-cmux-contract-runner.test.ts`
- Create: `scripts/run-real-cmux-contract.ts`

**Step 1: Write failing tests**

Add focused tests for ping-shape validation, ancestry-denial classification, structured MCP payload extraction, terminal-surface selection, and refusal to signal a PID when the daemon socket is outside the owned temp root.

**Step 2: Run tests to verify RED**

Run: `bunx vitest run tests/real-cmux-contract-runner.test.ts`

Expected: FAIL because the runner exports do not exist yet.

**Step 3: Implement the minimal pure helpers**

Export only the validation/classification helpers needed by the tests. Guard the executable entrypoint with an is-main check so imports never start the live lane.

**Step 4: Run tests to verify GREEN**

Run: `bunx vitest run tests/real-cmux-contract-runner.test.ts`

Expected: PASS.

### Task 2: Implement live socket and access-control assertions

**Files:**
- Modify: `scripts/run-real-cmux-contract.ts`
- Test: `tests/real-cmux-contract-runner.test.ts`

**Step 1: Add failing tests**

Test missing/unreachable pin classification and orphan receipt parsing with temp fixtures.

**Step 2: Run tests to verify RED**

Run: `bunx vitest run tests/real-cmux-contract-runner.test.ts`

Expected: FAIL on the newly specified behavior.

**Step 3: Add the bounded ping and orphan helper**

Use Node's Unix-socket APIs for direct `system.ping`. Launch the orphan probe through a recorded helper process, persist its PID/result receipt inside the owned temp root, and assert the EPIPE-class denial.

**Step 4: Run tests to verify GREEN**

Run: `bunx vitest run tests/real-cmux-contract-runner.test.ts`

Expected: PASS.

### Task 3: Implement the dist MCP round-trip and isolated lifecycle cycle

**Files:**
- Modify: `scripts/run-real-cmux-contract.ts`
- Test: `tests/real-cmux-contract-runner.test.ts`

**Step 1: Add failing tests**

Specify MCP response parsing, daemon PID extraction, read-screen target extraction, and owned-socket lifecycle guards.

**Step 2: Run tests to verify RED**

Run: `bunx vitest run tests/real-cmux-contract-runner.test.ts`

Expected: FAIL on missing response/lifecycle helpers.

**Step 3: Add the minimal live MCP harness**

Spawn the built dist entrypoint under isolated environment pins, initialize JSON-RPC, call read-only tools, run doctor JSON, SIGTERM the recorded isolated daemon, and assert proxy-driven replacement autostart.

**Step 4: Run tests to verify GREEN**

Run: `bunx vitest run tests/real-cmux-contract-runner.test.ts`

Expected: PASS.

### Task 4: Wire package and release gates

**Files:**
- Modify: `package.json`
- Modify: `scripts/release.sh`
- Modify: `tests/pre-pr-scripts.test.ts`

**Step 1: Add failing tests**

Assert `test:contract` builds dist then runs the standalone runner, default `test` does not include it, and `release.sh` invokes the contract command after hermetic gates.

**Step 2: Run tests to verify RED**

Run: `bunx vitest run tests/pre-pr-scripts.test.ts`

Expected: FAIL because the script and release gate are not wired yet.

**Step 3: Add minimal wiring**

Add `test:contract` and invoke it from the release preflight. The runner's skip contract makes unavailable live cmux warn-only; any real assertion failure remains non-zero and stops `set -e` release execution.

**Step 4: Run tests to verify GREEN**

Run: `bunx vitest run tests/pre-pr-scripts.test.ts tests/real-cmux-contract-runner.test.ts`

Expected: PASS.

### Task 5: Document the operator lane

**Files:**
- Create: `docs/runbooks/contract-lane.md`

**Step 1: Write the one-page runbook**

Document pre-release timing, the preferred NIGHTLY pin (`CMUX_SOCKET_PATH=/tmp/cmux-nightly.sock`), the required launch-from-inside-NIGHTLY ancestry, the automatic isolated daemon socket, skip/pass/fail meanings, read-only fleet guarantees, and troubleshooting evidence to capture.

**Step 2: Verify documentation commands and paths**

Run: `rg -n "test:contract|/tmp/cmux-nightly.sock|CMUXLAYER_DAEMON_SOCKET|EPIPE|pre-release" docs/runbooks/contract-lane.md`

Expected: every required operator concept is present.

### Task 6: Full verification and PR loop

**Files:**
- Verify all changed files; do not modify `src/monitor-registry.ts`.

**Step 1: Verify the skip path**

Run: `env -u CMUX_SOCKET_PATH bun run test:contract`

Expected: clear `SKIP`, exit 0, and no daemon lifecycle process started.

**Step 2: Verify the live path when reachable**

Run from a pane descended from the chosen cmux instance: `CMUX_SOCKET_PATH=/tmp/cmux-nightly.sock bun run test:contract`

Expected: ping, ancestry denial, list/read round-trip, doctor, and isolated retire/autostart assertions all PASS. If NIGHTLY is not running/reachable, record the explicit skip rather than claiming live coverage.

**Step 3: Verify hermetic gates**

Run: `bun run typecheck && bun run test && bun run build`

Expected: all commands exit 0 with zero failed tests.

**Step 4: Audit safety and scope**

Run: `git diff --check && git diff -- src/monitor-registry.ts && git status --short`

Expected: no whitespace errors, no monitor-registry diff, and only planned files changed.

**Step 5: Commit, push, and open the PR**

Commit the verified changes, push `test/r4-real-cmux-ci`, and create a ready PR titled `test: real-cmux contract lane (live-instance smoke, opt-in)` with exact verification receipts and any unavailable-live limitation stated explicitly.

## Follow-up: production socket guard

Before probing `system.ping`, canonicalize the requested `CMUX_SOCKET_PATH` and compare it with both production identities: `$HOME/.local/state/cmux/cmux-501.sock` and the path stored in `$HOME/.local/state/cmux/last-socket-path` when that marker exists. A production match must print the specified warn-only skip and exit 0. The deliberate `CMUX_CONTRACT_ALLOW_PROD=1` override bypasses only this production classification; normal reachability and contract assertions still apply.

Use TDD for three cases: default production path skips, `/tmp/cmux-nightly.sock` is admitted by the guard, and production plus the exact override is admitted. Perform this guard before any live socket request so routine releases from production-descended panes do not touch the production cmux socket at all.
