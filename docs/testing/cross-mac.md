# Cross-Mac scenario runner

The source-checkout runner drives a private cmuxlayer daemon on the target Mac.
M1 with pinned cmux 0.64.22 supplies release-gate evidence; MBP runs use NIGHTLY
and supply early warning. The scenario table is a gate component, not the #998
40-cycle/60-minute soak or release approval.

Run a plan without SSH, app launches, installs or model calls:

```sh
node scripts/xmac/live.mjs --host m1 --cmux prod \
  --repo cmuxlayer --dmg /absolute/path/to/pinned-0.64.22.dmg \
  --scenario /absolute/path/to/reviewed-scenario.mjs --dry-run
```

`--scenario` may repeat. Scenario modules implement the lead-pinned context in
`scripts/xmac/ctx.d.mjs`. The runner reads raw screen text directly from the
cmux socket and preserves blank and composer rows. MCP receipts are decoded
separately. It closes owned seats, enumerates real-lead children and falls back
to a raw sweep of the run-created workspace when child enumeration fails.

Live execution requires review of the driver and teardown first. On M1, the
CLIs use the target user's authenticated HOME and actual repoGolem registry.
The daemon socket, state, inbox, app pointer HOME and MCP config are private.
Shell startup restores the target CLI HOME; no auth files move between Macs.
On NIGHTLY, `--private-home` must name a separate owned mode-0700 auth HOME.
The target must have the required CLI binaries and reviewed launcher setup.
Before M1 app or seat launch, the driver reads the target's launcher registry
and checks each required launcher's registered root is a directory. A missing
root produces `PRECONDITION_ABSENT` with the exact target path and a failed run;
it cannot count as a behavior defect or a passing fix. The current scenarios'
CLI requirements are known; new scenarios declare `launcherClis` explicitly
(a nonempty array of `codex` and/or `claude`). This check never creates a root,
changes the registry or installs a repository.

`--prepare-driver` archives the committed harness SHA, transfers tracked code
only through fixed-alias `ssh m1`, and builds inside a new mode-0700 temporary
prefix. Alternatively supply an existing reviewed `--driver-root` with its
`--driver-sha`. Builds never replace the installed Homebrew keg.

An installed run needs `--sha` and `--installed-dist-digest`: the digest of the
compiled `.js` tree from that exact SHA's reference build, obtained with
`distDigest` from `scripts/xmac/target.mjs`. The target verifies this digest and
the private daemon's PID/socket before running scenarios. The installed M1
release gate also requires cmuxlayer 0.4.101 and the pinned DMG digest from the
soak runbook. The lead owns that installation.

For bug-to-fix replays, add `--replay --prepare-driver`. Each scenario's bug and
known fix SHA is built in its own private prefix and served through its own
private socket/state/inbox. Pending fixes remain pending. Build/auth/socket,
missing evidence and teardown failures are infrastructure failures. A ratchet
counts only when the bug has a recognized expected behavior defect, the fix
passes, and host/cmux/version match. Scenarios can supply `bug.failure_code`
for an exact failure-note match; unknown defect signatures remain unproven.

Outputs go into a fresh `docs.local/xmac/<run>/` directory (or `--output` below
this checkout's `docs.local`). `ratchet-table.json` records each scenario's
status, target version, exact SHA, failure kind and evidence path;
`pr-comment.md` provides the table without posting it. Per-scenario evidence,
cleanup receipts and the target lifecycle/production-attribution receipt stay
private. Raw argv is returned only for scenario assertions, not put in the
public table. Prefixes remain available for diagnosis; the runner does not
remove them or stop any process by pattern.

A real lead is Haiku with lead authority and left placement. Its strict MCP
config points only at this run's private cmuxlayer. Child spawns retain the
omitted-role trigger while their model, repo, workspace and worktree settings
are bounded by the private proxy. Codex uses gpt-6-luna at low effort. On
NIGHTLY, the bundle bin directory precedes the native CLI and a model-free
pane probe records `command -v codex` and its raw screen as wrapper evidence.

`PRECONDITION_ABSENT` is not green. The opportunistic overlay row links to the
R1 `send_under_codex_banner` replay (bug 7f26603f, fix 64260ba3) and the captured
hooks-review fixture. Never manufacture trust/setup overlays to obtain a pass.
