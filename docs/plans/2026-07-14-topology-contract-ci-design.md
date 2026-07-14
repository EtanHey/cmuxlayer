# Topology Contract CI Design

**Status:** Approved by the dispatched topology-contract CI mission.

## Goal

Create one CI-runnable contract suite that fails when the Fleet sidebar or agent
registry regresses any topology invariant fixed by sidebar v1.1 work: preservation
under inconclusive scans, confirmed ghost eviction, first-paint discovery,
surface/seat binding, row-content projection, and independent collapse.

## Considered approaches

1. **Contract suite over existing public seams (chosen).** Exercise
   `AgentEngine` for startup and sweep behavior, `FleetSidebarPublisher` for
   publication monotonicity, and the snapshot/Swift renderer for binding,
   content, and collapse. This keeps fixtures realistic without adding a new
   production abstraction.
2. **Tag the existing scattered regression tests.** This has the smallest diff,
   but leaves the contract implicit across several large suites and makes it
   difficult to run or review as one invariant set.
3. **Add a JSON replay runner.** This would provide durable external fixtures,
   but it introduces a new parser/runner solely for tests and duplicates the
   current TypeScript domain model.

## Contract boundary

- Publisher fixtures seed a populated last-good source, then attempt unknown,
  empty, partial, and folded populated publications.
- Engine fixtures own an in-memory topology and capture Fleet publications.
  They drive `initialize()` and the normal `runSweep()` path with deterministic
  screen text and clock control.
- Pure projection fixtures build candidates and inspect the resulting seat
  identity, status, health content, collapse state, and generated Swift source.
- `test:topology` runs only `tests/topology-contract.test.ts`; the existing CI
  `test` job still runs the suite through Vitest's normal discovery.

## RED proof

Temporarily remove the publisher guard that preserves a populated source over an
`unknown` publication, run the new suite, and record the expected failing
last-good assertion. Restore the guard and rerun the same command to green. The
temporary source change is not committed.

## Delivery

Commit the suite, `test:topology` script, and `docs/topology-contract.md` on
`test/topology-contract-ci`; open the requested ready-for-review PR and stop at a
green reviewed PR. Post the PR URL and RED/GREEN proof to driver-buddy.
