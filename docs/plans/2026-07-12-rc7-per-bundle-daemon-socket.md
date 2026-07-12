# RC7 Per-Bundle Daemon Socket Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Isolate production and Nightly cmux instances behind separate cmuxlayer daemons, and retire a daemon whose upstream cmux-app socket remains unreachable.

**Architecture:** Resolve the daemon socket and upstream candidates from the selected cmux instance axis: explicit socket pins first, then Nightly detection from `CMUX_SOCKET_PATH` or `CMUX_BUNDLE_ID`, otherwise the backward-compatible production paths. Extend the self-healing timer to probe active and degraded transports, and reuse its three-failure/60-second retirement circuit for ordinary upstream connection failures rather than only access-control denial failures.

**Tech Stack:** TypeScript, Node.js Unix sockets, Vitest, Bun scripts.

---

### Task 1: Namespace daemon sockets by cmux axis

**Files:**
- Create: `tests/daemon-socket-path.test.ts`
- Modify: `src/daemon-socket-path.ts`
- Modify: `src/cmux-socket-path.ts`
- Modify: `src/cmux-socket-probe.ts`
- Modify: `tests/cmux-client-factory.test.ts`

1. Add tests for unset/production, Nightly bundle, Nightly upstream socket, explicit daemon override, and bundle-only upstream alignment.
2. Run `bunx vitest run tests/daemon-socket-path.test.ts` and confirm the Nightly cases fail.
3. Add the minimal production/Nightly axis resolver while retaining `cmuxlayer-stated.sock` for production.
4. Re-run the focused test and confirm it passes.

### Task 2: Retire after sustained upstream death

**Files:**
- Modify: `tests/cmux-transport-self-heal.test.ts`
- Modify: `src/cmux-transport-self-heal.ts`

1. Add tests where consecutive unreachable upstream probes reach the configured threshold, including an idle active socket whose app disappears.
2. Run the focused self-heal test and confirm the new test fails because ordinary upstream failures are not counted.
3. Generalize the existing retirement evidence from access-control denial to upstream unreachability, retaining the default three-failure/60-second threshold and reset-on-success behavior; probe active sockets so idle daemons also retire.
4. Re-run the focused test and existing self-heal suite.

### Task 3: Verify and publish for review

**Files:**
- Verify all modified source and test files.

1. Run `bun run test`.
2. Run `bun run typecheck`.
3. Build and exercise a real daemon/proxy client path with isolated sockets for production and Nightly.
4. Run bounded CodeRabbit pre-commit review if available.
5. Commit, push `fix/rc7-per-bundle-daemon-socket`, open a ready PR, and request reviewers.
6. Stop without merging, per the RC7 brief.
