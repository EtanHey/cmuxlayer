# Resource Guard installation and cutover

After the guard and migration PRs are merged and the installed release includes
both (the initial cutover is scheduled after 0.4.105), preview the one-job plist:

```bash
"$(brew --prefix cmuxlayer)/libexec/scripts/install-mcp-reaper.sh" --resource-guard --dry-run
```

Then perform the idempotent cutover with one command:

```bash
"$(brew --prefix cmuxlayer)/libexec/scripts/install-mcp-reaper.sh" --resource-guard --install
```

This command verifies Homebrew's active Cellar keg, parses old plists with plutil,
checks the GUI launchd domain, stops the four legacy labels, installs the new job,
and archives old plists under `~/Library/LaunchAgents/resource-guard-archive/` only
after the replacement is loaded. A bootstrap or archival failure restores the prior jobs and
config; rollback failures are reported explicitly. A loaded legacy job without
its plist blocks cutover because it cannot be restored safely.

Fresh installs get a 60-second interval, RAM sampling every 30th tick, and a dry-run
MCP reaper every fifth tick. The memory watchdog and heavy-ML guardian are off.
On migration, only loaded host-specific legacy duties are enabled; an existing
explicit guard config takes precedence, including opt-outs. Legacy duty env knobs
and the reaper's `--execute` mode are preserved in
`~/.config/cmuxlayer/resource-guard.json`. Legacy jobs that lack a plist must be
resolved before installation; the installer does not guess their settings.

The job runs the native executable `cmux-resource-guard` from the installed keg. It has
no checkout dependency. jq is declared as a Homebrew dependency. Optional clx,
BrainBar, and notification sinks remain optional. Configured duty log/data paths
are preserved; fresh defaults use `~/Library/Logs/cmux-resource-guard/` with caps.

Preview does not write config, install a job, or stop any process. Installation
never runs as part of `brew install` / upgrade. The old single-reaper installer
mode remains available for compatibility; new installations use the guard mode.
