# Run 10 Harness Review Follow-up Design

## Scope

Close the eight unanswered PR #575 findings without changing the benchmark matrix or its recorded measurements. The follow-up is limited to `scripts/bench-e2e.mjs`, `tests/bench-e2e.test.ts`, and these planning notes.

## Decision

The reclaim marker remains an atomic hard link, but it is treated as an owned lease rather than an immortal sentinel. A contender reads the marker's existing PID/start-time identity, preserves it while that owner is live, and unlinks it when the owner is dead or the PID has been reused. It then retries the ordinary atomic claim. This follows the ruling directly and avoids both unsafe age-based guessing and a wider lock-protocol replacement.

The output and workspace leases get separate lifetimes. Workspace pressure may be released after benchmark execution and provenance revalidation, but the output lease remains held until the receipt write finishes. The outer cleanup remains idempotent so every failure path still attempts both releases.

The remaining findings are accepted as instrument-validity defects: all workers settle before an abort escapes a row; isolated child environments remove inherited `CMUXLAYER_*`, Node, and Bun runtime overrides before installing recorded values; source provenance includes untracked files; and absent comparison rows derive their declared concurrency profile.

## Alternatives rejected

- Reclaim markers based only on age or retry count can delete a slow live owner's marker.
- Replacing hard-link locks with a new directory-lock protocol widens a corrective PR and discards already-tested contention behavior.
- Merely documenting inherited environment values leaves the benchmark dependent on an open-ended set of launcher/runtime controls; clearing the behavior-changing class is smaller and reproducible.

## Verification

Each defect receives a focused regression test that is observed failing before production edits. Then run the complete harness test file, typecheck in both required environment modes, the D138 grep gate, and the full repository suite. Every original PR #575 thread receives a signed in-thread disposition and is resolved. The follow-up PR remains unmerged until unresolved threads are zero and Etan explicitly says go.
