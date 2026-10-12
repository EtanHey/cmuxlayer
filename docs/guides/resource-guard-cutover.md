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
config once the new job is confirmed unloaded; rollback failures are reported explicitly.
If the new guard stays loaded, legacy jobs remain stopped and its replacement
config/plist are retained, preventing both guardian jobs from running together.
Rollback reconciles previously loaded legacy jobs, including a bootout that took
effect before reporting an error; it does not reactivate previously unloaded jobs. A loaded legacy job without
its plist blocks cutover because it cannot be restored safely.

Fresh installs get a 60-second interval, RAM sampling every 30th tick, and a dry-run
MCP reaper every fifth tick. The memory watchdog and heavy-ML guardian are off.
On migration, only loaded host-specific legacy duties are enabled; an existing
guard config takes precedence. Omitted duty keys inherit loaded legacy jobs; only
explicit `false` opts out, with a warning before disabling a loaded legacy duty. Legacy duty env knobs
and the reaper's `--execute` mode are preserved in
`~/.config/cmuxlayer/resource-guard.json`. Legacy jobs that lack a plist must be
resolved before installation; the installer does not guess their settings.

The plist runs `<brew prefix>/opt/cmuxlayer/bin/cmux-resource-guard`, preserving
the unresolved opt path across upgrades; the active Cellar keg is validated first. It has
no checkout dependency. jq is declared as a Homebrew dependency. Optional clx,
BrainBar, and notification sinks remain optional. Configured duty log/data paths
are preserved. Migration also pins the legacy sampler default
`~/Library/Logs/cmux-ram-sampler/`, carrying sample history and the guardian sample
path forward. Fresh defaults use `~/Library/Logs/cmux-resource-guard/` with caps.

Preview does not write config, install a job, or stop any process. Installation
never runs as part of `brew install` / upgrade. The old single-reaper installer
mode remains available for compatibility; new installations use the guard mode.

Successful installation reports the resulting watchdog/guardian enablement,
sampler duty, and reaper execute/dry-run mode.
