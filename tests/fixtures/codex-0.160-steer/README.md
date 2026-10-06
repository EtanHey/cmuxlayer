# Codex 0.160 steer and explicit queue (#1001)

Captured 2026-10-05 through a rebuilt candidate MCP server and the real cmux
socket, in one disposable GPT-6-Luna low scratch pane. All prompts are synthetic.
Only the private scratch path was replaced with `~/scratch`; trailing terminal
padding was removed. No other screen text was changed.

| Capture | UTC | SHA-256 |
|---|---|---|
| busy.txt | 15:23:39.333 | 6d753b3bab1dbc808597f385f322fb5757c97bd4d29e720eaea4dc81abfdbc6d |
| pending-both.txt | 15:23:40.837 | 70b0b6a7130bb5ef3f860fcd5b654acddc9e507840cc7684863fec087beb6a8d |
| steer-committed.txt | 15:23:58.134 | 2534af75c9981fc8a74aa584a7dc4db9bffb9476e371241432b7373a6cec077c |
| submitted-idle.txt | 15:25:12.815 | d16505cb716c0f5e9dd4e39186424b82af6b23827d20a1587809ac1eab003e5f |

During `sleep 15`, explicit `codex_busy_mode:"queue"` used Tab and default
`send_to` used Return. Both first returned `delivered:false`, with states
`queued` and `steer_pending` respectively. At the tool boundary, the steer
became a committed `›` user turn while the Tab item remained queued. Both
`wait_for` receipts later returned `submitted`, `delivered:true`, `terminal:true`.
The model did not print the requested steer sentinel in this second trial;
the committed user turn and terminal receipt prove delivery, not compliance.
The scratch pane was closed through MCP (`surface_closed:true`). No Esc was sent.

Attention used a private 3000ms threshold, private state/inbox, and the source
verifier/halt sweep on actual pane screens. Both pending kinds raised attention;
the existing ancestor halt path wrote `agent_halt_delivery_stalled` to the
private parent inbox. This does not prove installed-release behavior.

An earlier `sleep 50` trial in the same pane closed its MCP context before
terminal verification. Its old synthetic transcript is visible above the
second trial. Its receipts remain pending because their pre-type baselines
were lost; they are not claimed as verified submissions. A daemon restart
likewise retains conservative pending truth when its baseline is unavailable.

The earlier 0.157 captures already document Return steering and Tab queuing.
Commit 4cf6d607 selected Tab on every active Codex turn; its fresh-read and
ownership safeguards remain, with Tab now available only by explicit opt-in.
