# Sleep Survival

The cmux fleet previously died when the Mac display/system slept and cmux quit.
The fragile mitigation was a transient `caffeinate -i -t 300` assertion, which
lapses after five minutes and does not survive process failure.

The durable guard is `launchd/cmux-caffeinate/`: launchd starts
`bin/cmux-caffeinate.sh` at load and keeps it alive if the `caffeinate` process
exits. The default flags are `-dis`, covering display sleep, idle system sleep,
and system sleep on AC.

Install is intentionally out-of-band and human-gated:

```bash
launchctl bootstrap gui/$UID /Users/etanheyman/Gits/cmuxlayer/launchd/cmux-caffeinate/launchd/com.golems.cmux-caffeinate.plist
```

Do not bootstrap it from tests, releases, or automation while the fleet is live.

`cmuxlayer doctor` reports a sleep guard line. Durable coverage requires both:

- `pmset -g assertions` aggregate `PreventUserIdleSystemSleep` is `1`
- launchd has `gui/$UID/com.golems.cmux-caffeinate` loaded

If either side is missing, doctor stays healthy when the version resolves, but
prints the install hint at `launchd/cmux-caffeinate/README.md`.

AC caveat: `-s` only asserts system sleep prevention on AC power. `-i` covers
battery idle sleep. Drop `-d` if display sleep is acceptable.
