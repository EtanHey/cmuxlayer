# cmux Caffeinate Guard

Durable sleep-survival guard for the live cmux fleet. It runs `caffeinate` under
launchd with `KeepAlive=true`, replacing ad-hoc `caffeinate -t` assertions that
expire after a few minutes.

## What it does

`bin/cmux-caffeinate.sh` logs its start time and PID to:

```bash
~/.local/state/cmux/cmux-caffeinate.log
```

Then it execs `caffeinate` with:

```bash
-dis
```

Those defaults prevent display sleep, idle system sleep, and system sleep while
on AC power. Override them with `CMUX_CAFFEINATE_FLAGS` only when you understand
the tradeoff.

## Install

Do not arm this from automation. Etan-gated install command:

```bash
launchctl bootstrap gui/$UID /Users/etanheyman/Gits/cmuxlayer/launchd/cmux-caffeinate/launchd/com.golems.cmux-caffeinate.plist
```

To reload after changes:

```bash
launchctl bootout gui/$UID /Users/etanheyman/Gits/cmuxlayer/launchd/cmux-caffeinate/launchd/com.golems.cmux-caffeinate.plist 2>/dev/null || true
launchctl bootstrap gui/$UID /Users/etanheyman/Gits/cmuxlayer/launchd/cmux-caffeinate/launchd/com.golems.cmux-caffeinate.plist
```

## AC caveat

`-s` only asserts system sleep prevention on AC power. `-i` covers battery idle
sleep. Drop `-d` if you accept display sleep but still want idle system sleep
coverage.

## Doctor

`cmuxlayer doctor` reports whether `pmset -g assertions` shows
`PreventUserIdleSystemSleep 1` and whether launchd has
`com.golems.cmux-caffeinate` loaded. A transient assertion without the launchd
guard is not durable.
