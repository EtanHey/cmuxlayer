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

Useful flags: `--capture-fps`, `--frame-fps`, `--scale-width`, `--max-frames` (default 750),
`--keep-runs` (default 5), `--keep-window`, `--root <dir>`, `--server-command`/`--server-arg`,
`--skip-preflight` (don't).

Output under `results/qa-video/<runId>/` (gitignored):

- `video.mov` — the recording, cropped to the probe window
- `run.json` — every probe step, every tool receipt verbatim, every mark on the recording clock
- `questions.json` — the receipt-free adjudicator payload, with each narrow question and its frames
- `expectations.json` — receipt claims and expected verdicts, held back until report generation
- `frames/<questionId>/f-<PTS>.jpg` — JPEG frames named with ffmpeg's real filtered-frame PTS

The harness refuses extraction when the planned questions exceed `--max-frames`, prints the total
artifact size on completion, and automatically retains only the newest `--keep-runs` completed runs
under the default gitignored output path. Custom `--root` paths are never pruned automatically. To
remove older default-output artifacts by age instead:

```bash
find results/qa-video -mindepth 1 -maxdepth 1 -type d -mtime +7 -print -exec rm -rf -- {} +
```

## Adjudicating

Sub-agents are **Sonnet** — cheap vision, high frame density — and they run **in-process**, not as
cmux panes. Each answers exactly one question and returns the frame it used.

For each entry in `questions.json`, dispatch one sub-agent with:

- the `question` text verbatim,
- the absolute path to its `frame_dir` and the `frame_times` mapping. These times are read from the
  `-frame_pts 1` JPEG filenames after extraction, so a missing frame leaves a timestamp gap instead
  of shifting every later image,
- the instruction to return only
  `{"id": ..., "verdict": "YES"|"NO"|"NOT_OBSERVABLE", "frame": ..., "note": ...}`.

`questions.json` contains no receipt claim or expected answer. Do not give the adjudicator
`expectations.json`; the split makes independence structural rather than relying on prompt prose.

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

**Isolation is by window, and where possible by display.** `cmux new-window` gets a window containing
only the probe panes, renamed to a unique `QAV-<runId>` title. Teardown closes exactly that window,
refuses to touch any window that existed beforehand, and also runs on SIGINT/SIGTERM so an
interrupted run does not leave an orphan window on the operator's desktop.

The recorder captures a screen **region**, so isolation is not free — whatever is stacked over that
region silently becomes the evidence. Five things had to be true before the frames could be trusted,
and each was learned by getting it wrong first:

1. **Address the window, never "the frontmost process."** That resolved to whatever the human last
   touched; the first recording cropped to a browser window and captured private content.
2. **Resolve geometry through CoreGraphics, not System Events.** A freshly created cmux window is
   intermittently absent from the accessibility window list entirely, and it drops out of the
   on-screen list whenever its Space is not active — so a single miss is a flap, not an absence.
3. **Record the display the window is actually on.** cmux does not always open on the main display.
   Two runs' worth of frames showed display 0 while the probe window sat on display 1, and every one
   of those frames looked completely plausible.
4. **Do not fight for z-order; take a display.** The harness runs from inside a cmux pane, so the
   operator's own cmux window is being activated constantly by the commands driving the probe.
   `isolateProbeWindowOnOwnDisplay` moves the probe window to the least-occupied display, because
   occlusion is per-display and stacking then stops mattering. On a single-display machine this is a
   no-op and the z-order checks carry the weight instead.
5. **Raise with AXRaise only.** An earlier per-probe re-assert also called `cmux focus-window`, which
   churned cmux's surface topology hard enough that `spawn_agent` began failing with `not live or
   uniquely resolvable in a complete fresh topology`. An observer that changes the observed state
   produces evidence about itself.

Every mark records whether the window was unoccluded at that instant, and
`buildAdjudicationManifest` refuses to generate a question for any mark where it was not. A
compromised probe reports NOT OBSERVABLE; it never reports as a pass. If the window cannot be made
clear at all, the run aborts rather than recording the desktop.

**Rejected: capturing the window's own content.** `screencapture -l <CGWindowID>` composites a single
window and is immune to occlusion, display placement and focus stealing — it looked like the answer.
It is not: cmux renders its terminals with Metal, so window capture returns the chrome and sidebar
with a **blank content area**. The terminal text, which is the entire point, is absent. Do not retry
this without looking at a frame.

**The harness must carry no caller identity.** cmux exports the operator pane's `CMUX_SURFACE_ID`,
`CMUX_TAB_ID`, `CMUX_WORKSPACE_ID` and friends into every child process. With those inherited, the
MCP server resolved the *caller* as whatever agent was running the harness and started guarding that
agent's surface — the first full run died on `refusing terminal I/O`. They are stripped before the
server is spawned. `CMUX_SOCKET_PATH` is kept: it addresses the daemon, it does not identify anyone.

**Recorder: ffmpeg + avfoundation**, not `screencapture -v`. Not because ffmpeg records better, but
because `-progress` makes it report its own clock. The first progress block with a real `out_time_us`
is captured exactly once as the immutable anchor that maps wall-clock instants onto recording
seconds; later progress blocks cannot move it. The recording is verified with `ffprobe` (non-empty,
real duration, decodable frames) before anything is derived from it.

**Frames are sampled densely at transitions, not uniformly.** Each question gets its own window
around its own mark, at 10 fps. The window reaches well past the mark because a mark is the instant
of the tool *call* and the pixels lag it — a dry-run measured that lag at ~1.7s for a plain
`cmux send`, so a tight window would simply miss the event it exists to catch. Frames are JPEG rather
than PNG because terminal-text adjudication does not need archival losslessness; `-q:v 2` now applies
to the actual encoder instead of being ignored.

**The dry-run is a clock test, not just a smoke test.** It prints a unique nonce into the probe pane
at a known instant and asks a sub-agent whether that nonce is visible in the frames the harness
predicted. If the wall-clock-to-video mapping were wrong, that question would fail.

## Requirements

- macOS with **Screen Recording** permission for whatever runs the harness (ffmpeg inherits it).
- **Accessibility** permission for the same process, for the AXRaise/window-move AppleScript.
- `python3` with `pyobjc` Quartz bindings, for `scripts/qa-video-windows.py`. This is how the harness
  finds the probe window, its display and its occluders; without it the run aborts rather than
  guessing.
- `ffmpeg` and `ffprobe` on PATH (`brew install ffmpeg`).
- A running cmux, and `bun run build` so `dist/index.js` exists (or pass `--server-command`).
- A second display is not required, but it is the difference between reliable isolation and fighting
  the operator's own cmux window for z-order.

## Known limits

- Activating the probe window steals focus for the length of the run. That is inherent to recording
  a live GUI; run it when the machine is free. Running the harness from inside a cmux pane makes this
  materially worse, because the operator's own cmux window is being raised by the very commands
  driving the probe.
- The composer questions are binary, and Cursor's TUI has a third state: a queued "follow-ups" panel
  that is neither the composer nor the transcript. The first live run landed exactly there. The
  question wording should become three-way before the next run.
- Anything that is not on screen cannot be adjudicated. Registry-internal fields — `closure` most of
  all — have no pixels. `list-closure-flap` therefore asks the nearest observable question ("did the
  pane visibly change at all during the span?") and will often be NOT OBSERVABLE. That is the honest
  answer, and it is still useful: a `closure` that flaps while the pane is provably static is a
  receipt with no referent.
