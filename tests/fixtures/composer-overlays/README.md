# Live composer overlays — issue 999 follow-up A

Captured 2026-10-05 through cmuxlayer `read_screen(raw:true, scrollback:false)`
in scratch terminals; no model prompt was submitted. All scratch surfaces closed.
Original screen receipts and snapshot hashes are retained in the worker's private
`captures/` directory. User/home/worktree paths are sanitized and right-edge terminal padding stripped;
menu placement, complete footers, blank rows, left indentation, and borders are preserved.
Hashes and capture receipts are recorded in `capture-provenance.json`.

| Files | Surface | Harness | Capture |
| --- | --- | --- | --- |
| Captured `codex-*` (excluding `codex-daybreak-*` and `codex-hooks-review.txt`) | 580 | Codex 0.160.0, GPT-6-Luna low | Fresh security banner, Esc-dismissed idle, @ mention picker, slash menu |
| `cursor-*` | 585 | Cursor 2026.10.01-e373342, Auto (no model flag) | Idle, `/999e_no_match_capture` No matches picker, Esc-closed draft |
| `claude-*` | 587 | Claude Code 2.1.289, Haiku 4.5 | Idle, slash menu, Esc-closed draft |

The original security-banner capture was followed by Esc before typing. Its initial
parser state was `ready`; the superseding 2026-10-06 ruling confirms the security notice is normal composer chrome. Both Cursor's No matches and the slash
menus were also missed by the installed parser. These captures establish UI
shape, not successful delivery by a changed or installed cmuxlayer binary.

`codex-daybreak-synthetic.txt` is synthetic from orc's quoted “security for Daybreak mode” stall, not a live capture. It deliberately has no composer below the notice.

`codex-hooks-review.txt` is a real Codex 0.160.0 capture from surface 697 via a fresh SDK client to the installed cmuxlayer MCP. The attached MCP connection was closed. The spawn requested a scratch cwd and gpt-6-luna low, but the launcher opened the registered repo and showed GPT-6-Luna default after Esc; those observed values are recorded rather than claimed as scratch/low. The 15-second readiness timeout delivered no boot prompt. One Esc skipped hook trust, then the managed agent and surface were closed; no task or file mutation ran in the capture pane.

The Hooks fixture omits trailing blank terminal padding; interior blank rows and option/footer placement remain intact. The complete 33-line raw receipt is retained privately.

`codex-daybreak-real.txt` and `codex-daybreak-real-draft.txt` were captured on 2026-10-06 from ONE managed Codex 0.160.0 / GPT-6-Luna low scratch (surface 732). The empty capture showed the real Daybreak / Advanced Account Security notice. Native text transport retained the complete `alphabetaproof` draft while the notice stayed visible; no Return or model prompt was submitted. Esc and refocus did not clear that observed screen. The scratch was closed. The repo path was replaced with `~/scratch` and right-edge padding stripped; option/footer, blank rows and left indentation remain as captured. These fixtures prove screen shape and text retention, not successful submission; the delivery tests model submission separately. Security notices are non-blocking per the superseding ruling; Hooks review remains blocking.
