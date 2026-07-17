# Flaky Timing Hardening Design

## Root cause evidence

The default-parallel full suite ran 20 fresh processes from v0.4.15. Eighteen
passed. Run 10 failed `fleet-sidebar.test.ts` while its collapse-state change
was still unpublished, and run 20 failed `proxy-version-bump.test.ts` because
the asserted replacement connection had received only `initialize`; that run
also emitted an `EPIPE` from the fake daemon writing to a socket closed by a
later reconnect.

The four originally reported tests and the additional proxy failure share one
top-level mechanism: the harness lets scheduler progress determine when its
assertion becomes true. The specific races differ:

- `server-agent-tools.test.ts` drives the complete launch/submit path, including
  real timer delays and registry filesystem work, even though the assertion is
  only about the injected seat-manifest payload. Across the 20 full-suite runs,
  this test took 1.167–4.090 seconds against Vitest's five-second default.
- `agent-engine.test.ts` already uses fake time, but advances eight seconds in
  one operation. That jump crosses async one-second polling, the five-second
  done-evidence confirmation window, and the seven-second timeout. Under load,
  the timeout callback can observe the clock before the earlier async poll has
  persisted its candidate.
- Both `fleet-sidebar.test.ts` cases depend on real `fs.watchFile` polling, a
  real atomic state-file rename, the publisher's 500ms write throttle, and a
  wall-clock polling deadline. The full-suite failure retained the expanded
  source after the 1.2-second deadline, proving the watcher/publication signal
  had not completed rather than a rendering assertion being wrong.
- `proxy-version-bump.test.ts` makes `detectStaleBuild` return stale forever and
  polls every 10ms. The mocked daemon spawn never changes the installed/running
  versions, so another version-bump reconnect can destroy connection 2 while
  its handshake replay is in flight. Concurrent targeted runs reproduced this
  ordering failure twice in ten processes. The successful replay can occur on a
  later connection, making the assertion against `messages[1]` racy.

## Per-test classification

| Test | Primary class | Deterministic correction |
| --- | --- | --- |
| Spawn manifest | Real-timer/FS work outside the assertion | Drive the existing launch path with controlled Vitest time and dispose every created lifecycle context. |
| Non-Codex done confirmation | Async await-ordering race | Advance to the first poll, assert the persisted candidate, then advance the confirmation window. |
| Fleet collapse republish | Real filesystem watcher and timer race | Inject the collapse-state watcher callback and trigger the same publication path directly. |
| Fleet pending-decrease/collapse | Real filesystem watcher and timer race | Use the same watcher seam while retaining the pending-decrease invalidation assertions. |
| Proxy reconnect replay | Repeated-trigger await-ordering race | Model one installed-version transition so only one reconnect is initiated. |

## Chosen design

Keep production timeouts, Vitest parallelism, Unix-socket integration, and every
behavioral assertion. Add one production dependency-injection seam to
`FleetSidebarPublisher`: a collapse-state watcher factory whose default adapter
continues to use `watchFile`/`unwatchFile`. Tests inject a manual watcher, verify
registration and disposal, update the real collapse store, then emit the
dependency's change signal without racing libuv polling. Age the generated
sidebar file before the signal when the 500ms write throttle is irrelevant to
the behavior under test.

The other corrections stay in test code: fake-time driving for both the
manifest handler and its server lifecycle initialization before timer restore,
staged fake-time advancement for `waitFor`, and a one-shot stale-build fixture
for the proxy. This preserves launch behavior, evidence confirmation, collapse
republishing, topology protection, handshake replay, and real Unix socket
framing while removing scheduler-dependent gates.

## Alternatives rejected

- Raising per-test or global timeouts leaves the same races and only changes how
  often they appear.
- Serializing Vitest or adding retries hides cross-file contention and loses the
  default-parallel coverage that exposed these failures.
- Replacing the proxy socket test or the fleet publication assertions with
  mocked return values would make the tests faster but would remove protocol or
  behavior coverage.

## Verification

- Run each corrected test and each affected file in at least 20 fresh loops.
- Run `bun run typecheck && env -u CMUX_SOCKET_PATH -u CMUX_DAEMON_SOCKET bun run test`
  in at least three fresh processes.
- Keep the full assertion bodies and report any newly surfaced flaky test rather
  than narrowing the catalog silently.
