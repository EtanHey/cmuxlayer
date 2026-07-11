# Nightly contract — Gemini runbook

Follow these steps exactly. Do not edit files. Do not investigate failures. Do
not run any command except the command in step 2.

1. Run only inside a Gemini terminal pane in the **cmux NIGHTLY** instance. The
   Gemini process must have been started from that pane.
2. Run this one command:

   ```bash
   bash /Users/etanheyman/Gits/cmuxlayer/scripts/nightly-contract-run.sh
   ```

3. Read the first word of the one output line. It is exactly `PASS`, `FAIL`, or
   `SKIP`.
4. If it is `PASS`, the command has already posted that one line to
   `~/.local/state/cmux/nightly-contract-gemini.log`. Stop.
5. If it is `FAIL`, the command has already posted one line containing the
   failure reason and receipt path to
   `~/.local/state/cmux/nightly-contract-gemini.log`. Do not fix, edit, retry,
   or investigate anything. Stop.
6. If it is `SKIP`, the NIGHTLY instance was unavailable or the Gemini process
   was not descended from a NIGHTLY pane. This is **not a pass**. The command
   has already posted the skip reason and receipt path to
   `~/.local/state/cmux/nightly-contract-gemini.log`. Do not retry. Stop.

The receipt is the durable evidence for the run. Its path is
`~/.local/state/cmux/contract-nightly-<UTC-date>.json` and is printed in the
single output line.

Etan or an orchestrator is responsible for spawning or keeping one Gemini in a
cmux NIGHTLY pane and having it run step 2 on the nightly cadence. Do not
install a system cron or LaunchAgent. Those processes are not pane-descended
and cannot prove this contract.
