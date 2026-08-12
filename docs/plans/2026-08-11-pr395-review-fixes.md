# PR 395 High-Severity Review Fixes

## Goal

Close the two high-severity review gaps without widening Phase 1 scope.

## Design

1. Bootstrap inbox state for every spawned role and append the concrete per-agent mailbox monitor/cursor contract to every delivered boot instruction. Preserve the caller's task text as the task summary.
2. Make the guarded `deliverAgentInput` route state the sole interactive-state authority for queued delivery. Represent a pre-mutation posture rejection as retryable, retain the durable queued receipt, and retry with exponential backoff capped at a fixed maximum. Mark a receipt terminal only when the target is gone or the submission outcome is uncertain.
3. Pin worker and workspace spawn boot delivery, posture disagreement retry, backoff, eventual submission, and target-gone resolution with focused tests.
4. Run focused tests, typecheck/build/full suite, compiled probes, push the signed commit, update PR 395, and inbox the lead.

