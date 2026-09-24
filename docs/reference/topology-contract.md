# Registry Topology Contract

`tests/topology-contract.test.ts` is the CI contract for registry topology.
It exercises the real engine, registry, and state manager through isolated
fixtures.

## Invariant: ghost eviction requires authoritative confirmation

The normal lifecycle sweep may evict a seat only when a non-empty topology
specifically omits its surface across the 5-second confirmation window. The
first miss records evidence; a live observation clears it; a later miss starts a
new window. Empty topology does not mark or evict the record.

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
