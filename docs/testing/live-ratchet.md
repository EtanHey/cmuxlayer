# NIGHTLY behavior ratchet

Run `node scripts/ratchet-live.mjs --prove --output /absolute/path/proof.json`
to establish the historical bug/fix pairs. The markdown table is written beside
the JSON receipt and printed for a PR comment. In proof mode its baseline/PR
columns identify the historical bug/fix commits, not the current PR head.

For an actual PR comparison, use `--baseline origin/main --candidate HEAD` (the
default). Every sampled commit gets a frozen-lockfile dependency installation
(lifecycle scripts disabled) and build in a detached temporary worktree. Both rows
must pass on the candidate. A baseline failure alone never makes a candidate pass.

The banner pair is `7f26603f` → `64260ba3`. The boot pair is `14aa55b5` →
**provisional #1019 head `f8f0e4ee`**; replace this pin with #1019's merge SHA when
it lands and identify that change in the PR. Proof mode requires the specific
banner refusal / contradictory boot receipt on the bug SHA, plus a passing fix.

Rows use real captured text inside a real NIGHTLY PTY and a real dist daemon.
Blank padding is compacted to fit the pane. The 200 ms post-Return transition and
the boot committed-row scroll-away are modeled from the recorded live specimen;
JSON provenance records that distinction and the captured-frame hashes. Fixture
key/input receipts independently corroborate daemon receipts and pane screens.
This proves replay behavior; it does not prove a live provider or a release soak.

The runner launches only `cmux NIGHTLY.app` with its own bundle ID, process-local
automation/socket overrides, session restoration disabled, and private daemon,
registry, inbox, fleet and harness state. Existing NIGHTLY means FAIL (`NIGHTLY
busy`); it is never adopted. Missing app/socket, build, or proof means exit 1 and
FAIL. Every dist daemon receives a private `HOME=<privateRoot>/home`, retaining
PATH and the runner's absolute Node/Bun executable. NIGHTLY also receives a
private HOME for pane shell startup. Before/after each sample and the full run,
guards attribute new agents, changed socket pointers and appended production
log/ticket bytes to the run UUID, sample tokens, agent IDs and scratch paths.
Only appended ranges are scanned (at most 4 MiB per file); buffers are discarded
and receipts contain paths/offsets, never production content. Unrelated writes
pass. Missing/truncated/changed sources and inspection errors fail closed.
Rotation by rename is supported while the original inode remains in the watched
files. Deleting a production log or rotated segment loses that inode and FAILs
the run because its appended bytes can no longer be inspected.
Production `~/.cmuxterm/events.jsonl` is never inspected. Each sample requires a
nonempty daemon log under its private HOME as a positive isolation control.
Attributed writes or missing private writes fail the run, including on a bug
baseline. Production cmux PID/start time is recorded before and after. Teardown
verifies each recorded PID's executable, sends SIGTERM, waits up to 10 seconds,
then verifies again before SIGKILL. No defaults edits, GUI driving or model calls.
An exclusive runner lock and a unique launch argument identify this invocation's
new NIGHTLY process. Interrupts drain through the same cleanup and FAIL receipt.

Local coverage is **NIGHTLY only**. A `--app` with production bundle ID
`com.cmuxterm.app` is explicitly refused before launch, including a renamed app
or a NIGHTLY wrapper whose executable resolves into that production bundle.
Recorded app process targets are checked again before each teardown signal.
Do not launch a second production cmux: 0.64.22's single-instance enforcement
terminates other processes with its bundle ID. Private HOME/socket overrides
do not prevent that behavior or isolate its real-account state writes.

`--capability` tests launch, ping, workspace creation and pane text only. The
PR-triggered macos-15 capability matrix downloads digest-pinned NIGHTLY and
**0.64.22**, validates notarization, and uploads separate receipts. 0.64.22 is
**hosted only**: `--hosted-release` requires `--capability`, GitHub Actions on a
`github-hosted` macOS runner, an app under `RUNNER_TEMP`, the production bundle ID
and version `0.64.22`. An existing process with that bundle ID refuses the run.
These environment checks are a runner policy, not cryptographic host attestation;
never spoof them on a local Mac. No bundle retagging or re-signing is performed.
The stable DMG URL is `/v0.64.22/cmux-macos.dmg`, with SHA-256
`fd148dba3519fe7d308844089ce4d062b17739ba645623f058f67a64798cea25`
from the upstream GitHub release asset metadata. It is not a required
check; hosting and required-check selection remain with the owner through the lead.
The `nightly` release tag rolls: the pinned DMG may disappear when it republishes.
A download HTTP 404 reports distinct FAIL stage `asset_gone`; update the asset
URL and independently verified digest together before retrying through a new PR.
