# Nightly Contract Diagnostics Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make nightly contract failures identify their exact step and preserve full output, while accepting both legacy EPIPE and the nightly app's explicit ancestry-denial wire response.

**Architecture:** The contract runner will attach a logical step name to failures and emit one machine-readable marker before the stack. The receipt wrapper will extract that marker and persist failed output without altering successful or skipped receipts. A shared access-control predicate will classify both denial generations, and the persistent socket parser will surface raw denial frames to the transport probe instead of timing out.

**Tech Stack:** TypeScript, Node Unix sockets, Vitest, Bash integration tests, Bun scripts.

---

### Task 1: Pin the failing receipt behavior

**Files:**
- Modify: `scripts/tests/nightly-contract-run.test.sh`
- Modify: `tests/real-cmux-contract-runner.test.ts`

1. Add a fake contract failure whose marker names `detached-orphan ancestry denial`, followed by unrelated stack output.
2. Assert the wrapper receipt reason equals the marker payload, `output_log` names an existing file, and that file contains the full failure output.
3. Assert PASS and SKIP receipts do not gain an `output_log` field.
4. Add a runner test proving a named step failure formats one single-line marker.
5. Run the focused tests and verify they fail for the missing behavior.

### Task 2: Pin both ancestry-denial wire generations

**Files:**
- Modify: `tests/real-cmux-contract-runner.test.ts`
- Modify: `tests/cmux-persistent-socket.test.ts`
- Modify: `tests/cmux-client.test.ts`
- Modify: `tests/cmux-transport-self-heal.test.ts`

1. Add an orphan receipt with `ERROR: Access denied — only processes started inside cmux can connect` and assert it is accepted while unrelated errors remain rejected.
2. Add a persistent V2 socket test that returns the raw nightly denial line and assert the request rejects immediately with the raw text preserved.
3. Add a CLI normalization test asserting the explicit denial has a stable access-denied error class.
4. Change the transport denial server fixture to the raw nightly line and assert the factory reports `denied_reason: access-control`.
5. Run the focused tests and verify each new assertion fails for the expected reason.

### Task 3: Implement the minimal diagnostics and compatibility changes

**Files:**
- Modify: `scripts/run-real-cmux-contract.ts`
- Modify: `scripts/nightly-contract-run.sh`
- Modify: `src/cmux-socket-probe.ts`
- Modify: `src/cmux-persistent-socket.ts`
- Modify: `src/cmux-client.ts`
- Modify: `src/cmux-transport-self-heal.ts`

1. Track the active logical contract step, wrap failures with that step, and emit `[contract] FAIL: <step>: <message>` before the stack.
2. Preserve non-JSON probe frames in the probe receipt so explicit denial text remains classifiable.
3. Extract the exact final failure marker in the wrapper, atomically preserve failed output, and emit `output_log` only on failure.
4. Broaden and reuse the shared access-control predicate for `Access denied` and `only processes started inside cmux` text.
5. Reject unexpected raw V2 frames immediately with their content preserved.
6. Normalize explicit CLI denial as `CmuxSocketError` code `access_denied` and use the shared predicate in self-heal classification.
7. Run focused tests until green, then refactor only duplicated denial checks.

### Task 4: Verify, document, and deliver

**Files:**
- Create: `docs.local/design/2026-07-13-nightly-contract-rootcause.md`

1. Run Bash syntax/integration tests, focused Vitest files, typecheck, build, and the full test suite.
2. Confirm the stable/main wrapper edit was adopted into this branch, then restore only `scripts/nightly-contract-run.sh` in the primary checkout; preserve unrelated user files.
3. Compare stable and nightly CLI metadata/help plus the captured failure evidence and write the root-cause/disposition report with the complete sweep results.
4. Run the local CodeRabbit gate, commit the scoped files, push, and create the required ready-for-review PR.
5. Invoke reviewers, read and address feedback, wait for CI, and stop at the mission's merged-ready PR endpoint unless explicit merge authority is provided.
6. Post the PR URL and root-cause conclusion to the driver channel/in-pane, then store the verified milestone and rationale in BrainLayer.
