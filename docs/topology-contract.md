# Sidebar and Registry Topology Contract

`tests/topology-contract.test.ts` is the CI contract for Fleet sidebar topology.
It exercises the real publisher, engine lifecycle, registry, snapshot projection,
and generated Swift source through isolated fixtures.

## Invariants

### 1. Publication is monotonic under inconclusive evidence

A populated last-good Fleet source cannot be replaced by:

- `discovering` or `unknown` output;
- a populated snapshot that omits a surface the same scan still reports live;
- an `empty` snapshot while any previously rendered Fleet surface is still
  observed.

An empty or failed enumeration is inconclusive. A partial enumeration can add
evidence, but it cannot prove that an omitted live seat disappeared.

### 2. Ghost eviction requires authoritative confirmation

The normal lifecycle sweep may evict a seat only when a non-empty topology
specifically omits its surface across the 5-second confirmation window. The
first miss records evidence; a live observation clears it; a later miss starts a
new window. Empty topology does not mark or evict the record.

### 3. First paint starts in discovery

`AgentEngine.initialize()` publishes `discovering` before startup discovery and
performs the first sync before any periodic sweep. A discoverable live surface
therefore reaches a populated first render without an intermediate authoritative
empty publication.

### 4. Seats bind to their own surfaces

Each projected seat retains one coherent tuple:

```text
agent id ↔ surface ref ↔ surface title ↔ parsed screen action
```

The binding fixture uses two live surfaces with different screen text so a
swapped read, reused identity, duplicate surface, or ghost row fails visibly.

### 5. Row content separates status from health

Registry/topology binding diagnostics are repair metadata and never render as
row health or status. Actionable operational health remains visible. Generated
Swift caps normal status at one line with tail truncation, while actionable
health keeps its default multiline wrapping.

### 6. Collapse is presentation-only

Collapse state is independent per lane. Folding a lane republishes the same
authoritative surface set in source metadata, so populated-to-populated collapse
cannot look like topology shrinkage to the publisher guard.

## Running the contract

Focused run:

```bash
bun run test:topology
```

Full CI-equivalent test discovery:

```bash
bun run test
```

The GitHub Actions `test` job invokes `bun run test`, so every pull request to
`main` includes this suite automatically.

## Revert proof

During suite creation, the populated-over-unknown guard in
`FleetSidebarPublisher.shouldPublish()` was removed locally and the focused suite
was run. The monotonicity fixture failed because the generated header changed
from:

```text
cmuxlayer-fleet-state: populated rendered=2 observed=2
```

to:

```text
cmuxlayer-fleet-state: unknown rendered=1 observed=2
```

The run reported one failed test. Restoring the guard made the same focused test
pass. The temporary source reversion is not part of the committed diff.

To repeat the proof, temporarily remove that guard, run `bun run test:topology`,
confirm the last-good assertion fails, restore the source, and rerun the same
command.
