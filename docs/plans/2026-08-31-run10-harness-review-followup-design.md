# Run 10 Harness Review Follow-up Design

## Scope

Close the eight unanswered PR #575 findings without changing the benchmark matrix or its recorded measurements. The follow-up is limited to `scripts/bench-e2e.mjs`, `tests/bench-e2e.test.ts`, and these planning notes.

## Decision

Reservation authority is a kernel advisory lock acquired through macOS `/usr/bin/lockf` or Linux `/usr/bin/flock` on a file descriptor retained by the benchmark process. Process exit closes the descriptor and releases the kernel lock, so abandoned lock bytes and legacy `.reclaim` markers have no authority and need no racy cleanup. The lock file retains PID and claim metadata for diagnosis only.

The output and workspace leases get separate lifetimes. Workspace pressure may be released after benchmark execution and provenance revalidation, but the output lease remains held until the receipt write finishes. The outer cleanup remains idempotent so every failure path still attempts both releases.

The remaining findings are accepted as instrument-validity defects: all workers settle before an abort escapes a row; isolated child environments remove inherited `CMUXLAYER_*`, Node, and Bun runtime overrides before installing recorded values; source provenance includes untracked files; and absent comparison rows derive their declared concurrency profile.

## Alternatives rejected

- Reclaim markers based on age, PID checks, or content comparison still require a conditional unlink operation the filesystem API does not provide. Review demonstrated that a replacement can land between inspection and cleanup.
- Quarantining a marker with `rename` is insufficient when restoration finds a third claim at the shared path; discarding the quarantined inode loses ownership authority.
- Directory locks have the same stale-owner removal race. A kernel advisory lock makes liveness physical and releases automatically on process death.
- Merely documenting inherited environment values leaves the benchmark dependent on an open-ended set of launcher/runtime controls; clearing the behavior-changing class is smaller and reproducible.

## Verification

Each defect receives a focused regression test that is observed failing before production edits. Then run the complete harness test file, typecheck in both required environment modes, the D138 grep gate, and the full repository suite. Every original PR #575 thread receives a signed in-thread disposition and is resolved. The follow-up PR remains unmerged until unresolved threads are zero and Etan explicitly says go.
