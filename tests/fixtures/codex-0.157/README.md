# Codex 0.157 screen captures (#905)

Raw `cmux read-screen` text from a scratch codex-cli 0.157.1 pane (GPT-6-Sol medium), captured 2026-09-27.
Only the pane's own `read-screen` output is stored; nothing was hand-edited.

| File | What the pane was doing |
|---|---|
| `idle-empty.txt` | Idle, empty composer (placeholder plus the `← for agents · ? for shortcuts` hint row). |
| `idle-draft.txt` | Idle, our typed draft in the composer. |
| `idle-submitted-working.txt` | Right after an idle Return: the message is in the transcript (`› …`), `Working`. |
| `idle-wrapped-draft.txt` | Idle, a long draft soft-wrapped onto a two-space-indented second row. |
| `midturn-empty.txt` | Turn running, empty composer. |
| `midturn-draft-tab-to-queue.txt` | Turn running, draft in the composer; footer reads `tab to queue message`. |
| `midturn-steer-queued.txt` | Return pressed mid-turn: 0.157 queues it under "Messages to be submitted after next tool call". |
| `midturn-followup-queued.txt` | Tab pressed mid-turn: a second block, "Queued follow-up inputs", drains at turn end. |
| `midturn-wrapped-draft.txt` | Turn running, long soft-wrapped draft. |
| `midturn-wrapped-steer-queued.txt` | That long draft after Return: a wrapped steer item. |
| `midturn-steer-and-followup-queued.txt` | Both queue blocks stacked above an empty composer. |
| `midturn-draft-under-queues.txt` | Both queue blocks, plus a new draft in the composer. |
| `midturn-steer-drained-draft-pending.txt` | The steer drained into the transcript; follow-up queued; draft pending. |
| `burst-return-placeholder-frame.txt` | Text typed and Return sent with no gap: 15 ms later the composer shows only the placeholder. |
| `burst-return-draft-reappears.txt` | 139 ms later: the same text reappears, and the Return became a newline. It never submits. |
| `boot-brief-padded.txt` | A two-paragraph brief pasted and Return sent at once: the Return became a newline and the brief sits unsent, with blank-line padding (1 in 4 tries). |

The `issue-999-*-picker.txt` files are synthetic reproductions for case (e).
The Codex mention footer and `no matches` text come from issue #999's live
comment; the slash menus reproduce the same completion interaction for Codex
and Claude. These fixtures do not claim a new live capture or installed proof.
