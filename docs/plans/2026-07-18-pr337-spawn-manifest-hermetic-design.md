# PR #337 Spawn-Manifest Hermeticity Design

## Evidence and corrected proof condition

The independently observed failure is a real 5,000 ms Vitest wall-clock
timeout under concurrent load, not the fake-clock ordering race addressed by
the first #337 commit. Running the four flaky files together produced a 6.499 s
manifest-test timeout for the reviewer. A local ten-run repetition did not fail,
but the same tests reached 4.530 s and 3.245 s, leaving no safe wall-clock
margin. Isolated test/file loops are therefore supplementary evidence only;
the acceptance topology must run all four files together.

The current manifest tests construct a complete server lifecycle. Before the
manifest assertion can finish, that path creates a filesystem-backed
`StateManager`, reconstitutes and discovers the lifecycle registry, performs
managed-metadata refreshes, persists a spawn record and event log, and tears
the lifecycle down. Fake timers do not remove this CPU/filesystem work, and
Vitest's five-second watchdog remains real.

## Considered approaches

1. **Inject lifecycle persistence, registry, and initialization (selected).**
   Add optional `CreateServerOptions` seams for a `StateManager`, an
   `AgentRegistry`, and the lifecycle initializer. Production defaults remain
   the current filesystem manager, registry construction, and
   `engine.initialize(discovery)`. The two manifest tests inject an in-memory
   state manager, a registry backed by it, and a resolved initializer. This
   keeps the real `spawn_agent` handler, `AgentEngine.spawnAgent`, client
   protocol, and manifest publisher while removing external lifecycle I/O.
2. **Inject an entire fake `AgentEngine`.** This would eliminate more code but
   requires a broad, incomplete engine double for every lifecycle tool closure
   and risks testing mock behavior rather than the real spawn path.
3. **Extract and unit-test a pure record-to-manifest mapper.** This is fast but
   weakens coverage: it no longer proves that `spawn_agent` publishes the
   expected-state manifest, so it violates the brief.

## Selected design

`createServerContext` accepts an optional state manager and registry instead of
unconditionally creating filesystem-backed lifecycle state. The context also
retains an optional zero-argument lifecycle initializer. `createServer` calls
that initializer when supplied; otherwise it executes the unchanged production
`engine.initialize(discovery)` path.

The test-only in-memory state manager preserves the real record semantics used
by spawn: write, read, list, update, transition, reset, rename, and remove. The
real `AgentRegistry` and `AgentEngine` operate over those records. Both
manifest tests assert that their deliberately nonexistent state directory stays
absent, proving no fallback filesystem state was created, and that the injected
initializer ran exactly once. The exact full manifest assertion and launcher
name assertion remain unchanged.

The earlier fake-time driver is removed from the manifest test because the
hermetic handler has no awaited lifecycle timer. Scheduled post-spawn liveness
is still owned and canceled by context disposal.

## Verification

- Watch the hermeticity test fail before the seams exist because the forbidden
  state directory is created by the real `StateManager`.
- Run both manifest tests and the complete server-tools file.
- Run all four flaky files together in at least 20 fresh Vitest processes with
  zero failures.
- Run the full suite in at least five fresh processes with typecheck and zero
  failures.
- Do not raise timeouts, add retries/serialization, modify the other three test
  files, or weaken assertions.
