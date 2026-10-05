# Live composer overlays — issue 999 follow-up A

Captured 2026-10-05 through cmuxlayer `read_screen(raw:true, scrollback:false)`
in scratch terminals; no model prompt was submitted. All scratch surfaces closed.
Original screen receipts and snapshot hashes are retained in the worker's private
`captures/` directory. User/home/worktree paths are sanitized and right-edge terminal padding stripped;
menu placement, complete footers, blank rows, left indentation, and borders are preserved.
Hashes and capture receipts are recorded in `capture-provenance.json`.

| Files | Surface | Harness | Capture |
| --- | --- | --- | --- |
| `codex-*` | 580 | Codex 0.160.0, GPT-6-Luna low | Fresh security banner, Esc-dismissed idle, @ mention picker, slash menu |
| `cursor-*` | 585 | Cursor 2026.10.01-e373342, Auto (no model flag) | Idle, `/999e_no_match_capture` No matches picker, Esc-closed draft |
| `claude-*` | 587 | Claude Code 2.1.289, Haiku 4.5 | Idle, slash menu, Esc-closed draft |

The security banner was dismissed using Esc only before typing. Its initial
parser state was incorrectly `ready`; both Cursor's No matches and the slash
menus were also missed by the installed parser. These captures establish UI
shape, not successful delivery by a changed or installed cmuxlayer binary.
