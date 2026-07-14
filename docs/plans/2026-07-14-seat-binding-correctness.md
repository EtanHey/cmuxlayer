# Seat-binding correctness implementation plan

> Mission: make the Fleet sidebar join registry identity, live screen state, and
> focus routing through one stable surface-instance key.

## Root cause

cmuxlayer persists the process-local `surface:N` ref and discards the stable
cmux surface UUID. The same ref then drives reconciliation, screen parsing,
row identity, deduplication, and focus. Refs can be unresolved before their
handle is registered and can become stale or refer to a different surface after
a cmux restart. Static seat lookup independently turns duplicate launcher
classes into a false first-match identity.

## Tasks

1. Add a sanitized round-5 capture fixture containing stable UUIDs, refs,
   opposite screen states, and a recycled-ref specimen.
2. Write RED tests for:
   - ambiguous static seat policy never choosing the first seat;
   - UUID/ref topology resolution and current-ref rebinding;
   - a never-active first-render row focusing by UUID;
   - working/idle state coming from the UUID-correct surface;
   - stale UUID bindings not rendering false identity;
   - one missing topology observation not transitioning a live record to error.
3. Add optional `surface_uuid` fields to split/create results, discovery,
   registry state, manifests, and Fleet candidates.
4. Preserve `surface_id` from cmux responses and persist it at managed spawn or
   crash recovery before launch activity.
5. Extend topology snapshots with `UUID -> current ref` and `ref -> UUID` maps.
   Resolve each registry row through this snapshot before any sidebar screen
   read. Backfill a legacy record only from a complete live observation.
6. Reconcile UUID-backed records by UUID and update their mutable ref when it
   changes. Apply the existing five-second confirmation window before a missing
   surface becomes an error.
7. Build/deduplicate rows by UUID and emit `surface.focus` with the UUID while
   retaining the ref only for diagnostics.
8. Make duplicate seat-policy matches return an unknown/ambiguous assertion.
9. Run focused tests after each GREEN step, then typecheck, build, full tests,
   pre-PR verification, fixture validation, and visual sidebar verification.
10. Commit, push, open the exact-title PR, run local/review-bot/CI loops, and
    post the PR URL plus AgentOpology verdict to driver-buddy.

## Compatibility and safety

- Fields are additive; old state and manifest JSON remains readable.
- No `.at` runtime dependency is introduced.
- UUID-less owned legacy records retain the ref path. A record that already
  has a UUID fails closed when the current observation cannot prove it.
- Failed/empty/incomplete topology never proves absence.
- A known UUID mismatch fails closed for Fleet publication; it cannot borrow a
  live row's labels or state.
