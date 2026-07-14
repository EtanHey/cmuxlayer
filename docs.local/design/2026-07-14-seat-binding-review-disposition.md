# Seat-binding review disposition

Status: SKIPPED — CodeRabbit free OSS rate limit exceeded; completed the required red-team/blue-team fallback audit instead.

Weighted evaluator: SKIPPED — the read-only evaluator produced no output within the three-minute bound and was stopped.

## Fallback findings

- HIGH: successful subset enumeration was treated as authoritative — FIXED (declared/observed pane membership must be complete before lifecycle or placement mutation).
- HIGH: observer ownership could cross a same-path cmux restart — FIXED (persisted socket-node owner is separate from transient connection/route epoch).
- HIGH: UUID-less rows could adopt a recycled UUID by mutable ref — FIXED (UUID-capable observations quarantine ref-only adoption; complete owned all-ref compatibility remains explicit).
- HIGH: discovery and sweep could retain screen evidence after a UUID moved — FIXED (post-read binding validation discards raced evidence).
- HIGH: placement could mutate from truncated, mixed, or contradictory topology — FIXED (non-authoritative coverage fails closed).
- HIGH: agent delivery reused one route across chunks and Return — FIXED (fresh binding/manual-mode guard runs immediately before each terminal mutation).
- HIGH: managed boot prompts were raw-ref routed and not blocked by manual mode — FIXED (stable agent route plus per-write guard; `boot_prompt` is a mutating policy action).
- HIGH: stop could close a stale ref and verify completion by that ref — FIXED (re-resolve before signal/close and prove completion by stable UUID).

No CRITICAL findings were reported. Final local verification: 103/103 test files and 2,081/2,081 tests passed; typecheck and `git diff --check` passed. The mandated lead-side ULTRA counterfactual review remains the independent post-PR gate.
