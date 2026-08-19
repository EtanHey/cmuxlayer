# QA video harness — video ground truth for cmuxlayer claims

cmuxlayer is normally the only witness to cmuxlayer. Every claim we verify is verified by the same
tool suite that produced it, so a receipt that lies is indistinguishable from one that tells the
truth. This harness gets evidence from **outside** the system under test: it screen-records a live
probe in an isolated cmux window, then has cheap vision sub-agents adjudicate the frames one narrow
question at a time.

The product of a run is the **contradictions** — places where the tool receipt and the pixels
disagree. No unit test can produce those, because a unit test is inside the same box.

- Runner: `scripts/qa-video-harness.mjs`
- Decision logic (pure, unit-tested): `scripts/qa-video-lib.mjs`
- Tests: `tests/qa-video-harness.test.ts`
- Reports land in `docs.local/reports/qa-video-<date>.md`

## What it probes

Each probe re-runs a repro the fleet actually reported, and every tool receipt is captured verbatim
next to its position on the recording clock.

| probe | repro | issues |
| --- | --- | --- |
| `busy-send` | `send_to` a BUSY agent — does the text appear in the composer, and does it submit? | #432, #484 |
| `stale-terminal-send` | `send_to` a pane whose registry row is terminal but whose pane is live | #484 |
| `close-agent` | `close_surface(scope:"agent")` — does the pane actually disappear? | #485 |
| `list-closure-flap` | `list_agents` ×3 over ~20s — does `closure` flap for an unchanged agent? | #488 |
| `wait-for-working` | `wait_for` on a working agent — does it block, or claim "already completed"? | #473 |
| `spawn-under-keystrokes` | spawn while keystrokes are injected — does the launcher line recover? | #434, #440 |

## Running it

The harness drives a live cmux, opens a window, records the screen and spawns real agents. It is
opt-in and it is loud about it.

```bash
# 1. Always start here. Trivial probe, no agents, proves the whole pipeline.
CMUX_QA_VIDEO=1 npm run qa:video:dry-run

# 2. Full run. Runs the dry-run as a preflight first and refuses to continue if it produced no frames.
bun run build                       # the harness talks to dist/index.js
CMUX_QA_VIDEO=1 npm run qa:video -- --cli cursor --repo cmuxlayer
```

Useful flags: `--crop auto|off|x,y,w,h`, `--capture-fps`, `--frame-fps`, `--scale-width`,
`--keep-window`, `--root <dir>`, `--server-command`/`--server-arg`, `--skip-preflight` (don't).

Output under `results/qa-video/<runId>/` (gitignored):

- `video.mov` — the recording, cropped to the probe window
- `run.json` — every probe step, every tool receipt verbatim, every mark on the recording clock
- `manifest.json` — the adjudication questions, each with its own densely-sampled frames
- `frames/<questionId>/f-NNNN.png`

## Adjudicating

Sub-agents are **Sonnet** — cheap vision, high frame density — and they run **in-process**, not as
cmux panes. Each answers exactly one question and returns the frame it used.

For each entry in `manifest.json`, dispatch one sub-agent with:

- the `question` text verbatim,
- the absolute path to its `frame_dir` and the `frame_times` mapping (frame `f-000N` is at
  `frame_window.start + (N-1)/frame_window.fps` seconds),
- the instruction to return only
  `{"id": ..., "verdict": "YES"|"NO"|"NOT_OBSERVABLE", "frame": ..., "note": ...}`.

Never show a sub-agent the receipt. It must not know what answer would be convenient.

Collect the verdicts into a JSON array and render the report:

```bash
node scripts/qa-video-harness.mjs report \
  results/qa-video/<runId> \
  results/qa-video/<runId>/verdicts.json \
  docs.local/reports/qa-video-$(date +%F).md
```

The report reconciles each verdict against what the receipt claimed:

- **AGREE** — the frames match what the receipt implies.
- **CONTRADICT** — they do not. This is the product.
- **NOT OBSERVABLE** — the sub-agent could not tell, or the step never reached its mark. An honest
  gap, never a pass.
- **MISSING** — no verdict came back. Loud on purpose, so a partial adjudication cannot read clean.

## Design notes, and the traps already hit

**Isolation is by window, not by workspace.** `cmux new-window` gets a window that contains only the
probe panes, renamed to a unique `QAV-<runId>` title. Teardown closes exactly that window and
refuses to touch any window that existed beforehand.

**The window must be provably frontmost before recording starts.** Two real failures, both caught by
the dry-run:

1. Asking System Events for "the frontmost process" resolved to whatever the human last touched. The
   first recording cropped to a browser window and captured private messages. The window is now
   addressed by the title the harness assigned it — never heuristically.
2. `cmux focus-window` changes cmux's own selection but does not restack macOS windows, so the
   operator's main cmux window stayed on top and got recorded instead. The fix is an AX `AXRaise`
   plus a check that the probe window really is `window 1` of a frontmost cmux.

If neither can be confirmed, the harness **aborts** rather than recording the whole desktop.

**Frontmost-ness is re-asserted before every probe, and recorded at every mark.** A five-minute run
lost the probe window partway through, and every probe after that point recorded the operator's main
window instead — three adjudicators independently reported seeing the wrong workspace. So every mark
now carries `frontmost`, `buildAdjudicationManifest` refuses to generate a question for any mark
where it is `false`, and `video.occlusionRisk` records whether the window was still on top when the
run ended. A compromised probe reports as NOT OBSERVABLE; it never reports as a pass.

The per-probe re-assert is AXRaise plus app activation and **nothing else**. An earlier version also
called `cmux focus-window` between probes and churned cmux's surface topology hard enough that
`spawn_agent` began failing with `not live or uniquely resolvable in a complete fresh topology` — the
harness was perturbing the system it exists to observe. An observer that changes the observed state
produces evidence about itself.

**The harness must carry no caller identity.** cmux exports the operator pane's `CMUX_SURFACE_ID`,
`CMUX_TAB_ID`, `CMUX_WORKSPACE_ID` and friends into every child process. With those inherited, the
MCP server resolved the *caller* as whatever agent was running the harness and started guarding that
agent's surface — the first full run died on `refusing terminal I/O`. They are stripped before the
server is spawned. `CMUX_SOCKET_PATH` is kept: it addresses the daemon, it does not identify anyone.

**A killed harness tears its window down.** SIGINT/SIGTERM close the isolated window; without that,
an interrupted run leaves an orphan window on the operator's desktop.

**Recorder: ffmpeg + avfoundation**, not `screencapture -v`. Not because ffmpeg records better, but
because `-progress` makes it report its own clock. That first progress block with a real `out_time_us`
is the anchor that maps wall-clock instants onto recording seconds; without it, frames could only be
aligned by eye. The recording is verified with `ffprobe` (non-empty, real duration, decodable frames)
before anything is derived from it. `screencapture -v` remains a fallback if ffmpeg is unavailable,
but it gives no clock signal and would need a visual clapper for every probe.

**Frames are sampled densely at transitions, not uniformly.** Each question gets its own window
around its own mark (typically ~1s before to ~2-4s after, at 10 fps). Sampling the whole video
uniformly would either miss the transition or cost a fortune in frames.

**The dry-run is a clock test, not just a smoke test.** It prints a unique nonce into the probe pane
at a known instant and asks a sub-agent whether that nonce is visible in the frames the harness
predicted. If the wall-clock-to-video mapping were wrong, that question would fail.

## Requirements

- macOS with **Screen Recording** permission for whatever runs the harness (ffmpeg inherits it).
- **Accessibility** permission for the same process, for the window-targeting AppleScript. Without
  it `--crop auto` cannot confirm the window and the run aborts by design.
- `ffmpeg` and `ffprobe` on PATH (`brew install ffmpeg`).
- A running cmux, and `bun run build` so `dist/index.js` exists (or pass `--server-command`).
- Auto-crop assumes a Retina backing scale of 2; override with `CMUX_QA_VIDEO_BACKING_SCALE` or an
  explicit `--crop x,y,w,h` in capture pixels.

## Known limits

- Activating the probe window steals focus for the length of the run. That is inherent to recording
  a live GUI; run it when the machine is free.
- Anything that is not on screen cannot be adjudicated. Registry-internal fields — `closure` most of
  all — have no pixels. `list-closure-flap` therefore asks the nearest observable question ("did the
  pane visibly change at all during the span?") and will often be NOT OBSERVABLE. That is the honest
  answer, and it is still useful: a `closure` that flaps while the pane is provably static is a
  receipt with no referent.
