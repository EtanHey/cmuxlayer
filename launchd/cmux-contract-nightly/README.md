# cmux NIGHTLY Contract Job

This LaunchAgent schedules `bun run test:contract` at 03:30 each night against
the isolated NIGHTLY cmux socket:

```bash
CMUX_SOCKET_PATH=/tmp/cmux-nightly.sock
```

It does not install itself and it never opts into the production-socket
override.

## Result receipts

Each run writes a raw log and a structured receipt:

```text
~/.local/state/cmux/contract-nightly-YYYY-MM-DD.log
~/.local/state/cmux/contract-nightly-YYYY-MM-DD.json
```

The JSON `outcome` has three possible values:

- `pass`: the runner ended with exactly one real-cmux contract pass marker.
- `fail`: the command failed or exited without a terminal pass/skip marker.
- `skip`: the existing contract runner refused to run, typically because the
  NIGHTLY socket was absent or the caller was rejected by ancestry policy. The
  skip marker must likewise be the only terminal marker and final log line.

Multiple terminal markers or any output after a pass/skip marker are recorded
as `fail`; trailing cleanup errors cannot be hidden behind an earlier pass.

A `skip` is not green. It means no continuous contract evidence was produced
that night and the log explains which infrastructure precondition was missing.

## Ancestry limitation

cmux socket access is restricted to cmux-pane descendants. A plain LaunchAgent
is descended from launchd, so it cannot create genuine pane ancestry merely by
setting `CMUX_SOCKET_PATH`. The contract lane also asserts that detached/orphan
callers are denied, which prevents this job from safely bypassing that rule.

This bundle is therefore a best-effort scheduler and records that context in
every receipt as `plain-launchd-best-effort`. A fully admitted nightly run still
requires an Etan-gated mechanism that starts the command from a NIGHTLY cmux
terminal descendant (or an upstream cmux capability for authenticated scheduled
jobs). Do not interpret a launchd `skip` as a contract pass.

## Install (Etan-gated)

Do not arm this from automation. After reviewing the ancestry finding and the
canonical checkout path, Etan can install it with:

```bash
launchctl bootstrap gui/$UID /Users/etanheyman/Gits/cmuxlayer/launchd/cmux-contract-nightly/launchd/com.golems.cmux-contract-nightly.plist
```

To reload after changes:

```bash
launchctl bootout gui/$UID /Users/etanheyman/Gits/cmuxlayer/launchd/cmux-contract-nightly/launchd/com.golems.cmux-contract-nightly.plist 2>/dev/null || true
launchctl bootstrap gui/$UID /Users/etanheyman/Gits/cmuxlayer/launchd/cmux-contract-nightly/launchd/com.golems.cmux-contract-nightly.plist
```

Inspect the last receipt first. A `fail` means an admitted contract check found
a regression or the wrapper could not complete; a `skip` means the continuous
lane itself was not admitted and needs infrastructure attention.
