# PTY Write-Liveness Health Design

## Problem

A terminal surface can keep rendering a stale active spinner after its PTY socket has died. The current health path parses that stale frame as `working` or `thinking`, downgrades `registry_screen_disagreement` to informational, and therefore reports a false-green agent even after real writes fail with `EPIPE`/errno 32.

## Chosen approach

Record the outcome of top-level real surface-write operations at the existing `withSurfaceWrite` boundary. Store a bounded, per-surface sequence of timestamped outcomes in the shared server context. Classify a surface as PTY-dead only when the latest configurable number of write operations all failed with a broken-pipe-class error and all fall inside a configurable time window. A successful write or a non-broken-pipe failure interrupts the consecutive broken-pipe sequence.

This avoids synthetic terminal input, avoids counting internal retries from one user operation as multiple independent failures, and covers both public write tools and agent-engine writes that already share the wrapper.

## Health data flow

`withSurfaceWrite` records success or the caught error. `evaluateServerAgentHealth` reads the surface observation and threads it through `buildAgentHealthInput`. `evaluateAgentHealth` adds blocking issue `pane_pty_dead` only when the screen still parses active and the observation meets the repeated-failure policy. When this evidence exists, `registry_screen_disagreement` remains at its normal degraded severity rather than being downgraded to info.

The existing `list_agents` and other health-bearing responses already serialize the full health object, so the new issue code, message, and severity surface without a new response shape.

## Error recognition and anti-flapping policy

Broken-pipe recognition accepts structured `code: EPIPE`, structured `errno: 32`/`-32`, and broken-pipe/EPIPE text from wrapped errors. Defaults are two failed top-level writes within 30 seconds. The tracker accepts an injected clock, threshold, and window for hermetic tests.

## Tests

- Pure tracker tests prove structured/text EPIPE recognition, threshold behavior, success reset, non-EPIPE interruption, and time-window expiry.
- Health tests prove an active spinner plus repeated recent EPIPE evidence produces blocking `pane_pty_dead`, a single transient does not, healthy writes preserve behavior, and binary status remains unhealthy only because of the new blocking code.
- Input-builder tests prove the observation is threaded into health input.

## Scope

Do not modify `src/proxy.ts` or `src/doctor.ts`. Do not change the existing severity tiers beyond adding `pane_pty_dead` as blocking.
