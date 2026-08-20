import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// @ts-expect-error -- plain .mjs helper module shared with the harness script
import {
  DRY_RUN_SPEC,
  OUTCOMES,
  PROBE_SPECS,
  VERDICTS,
  assertFrameBudget,
  buildAdjudicationManifest,
  buildReportMarkdown,
  combineAdjudicationArtifacts,
  describeReceiptClaim,
  planFrameWindow,
  receiptOk,
  receiptSubmitted,
  reconcile,
  splitAdjudicationManifest,
  wallToVideoSeconds,
} from "../scripts/qa-video-lib.mjs";

// @ts-expect-error -- executable .mjs module also exports testable runner seams
import {
  Recorder,
  assertOptIn,
  assertPreflightReady,
  assertVideoUsable,
  destroyProbeWindow,
  displayContaining,
  installSignalHandlers,
  parseArgs,
  probeWindowGeometryFromState,
  pruneRunDirectories,
  readExtractedFrameMapping,
  rectsIntersect,
  sterileEnv,
} from "../scripts/qa-video-harness.mjs";

function sendStep(delivery: string | undefined, overrides: Record<string, unknown> = {}) {
  return {
    id: "busy-send",
    marks: { send: { videoS: 12.4 }, plus2: { videoS: 14.4 } },
    context: { nonce: "QAV-BUSY-AB12", paneHint: "pane 2" },
    calls: [
      {
        tool: "send_to",
        args: {},
        receipt: {
          ok: true,
          text: "",
          structured: delivery === undefined ? { ok: true } : { ok: true, delivered: true, delivery },
        },
        error: null,
      },
    ],
    ...overrides,
  };
}

function runFixture(steps: unknown[]) {
  return {
    runId: "test-run",
    mode: "full",
    startedAt: "2026-08-19T00:00:00.000Z",
    window: { windowRef: "window:2", workspaceRef: "workspace:13" },
    video: { path: "video.mov", fps: 15, durationS: 120, frames: 1800 },
    steps,
  };
}

describe("qa-video probe catalogue", () => {
  it("covers every fleet-reported repro the lane was chartered for", () => {
    const issues = PROBE_SPECS.flatMap((spec: { issues: string[] }) => spec.issues);
    for (const issue of ["#432", "#484", "#485", "#488", "#473", "#434", "#440"]) {
      expect(issues).toContain(issue);
    }
  });

  it("keeps the post-mark window wide enough for the measured call-to-pixel lag", () => {
    // A mark is the instant of the tool CALL; the pixels lag it by the cmux
    // round-trip plus a repaint. A dry-run measured that at ~1.7s for a plain
    // `cmux send`, so any window centred on an action mark must reach past it.
    const actionMarks = new Set(["send", "launch", "clap"]);
    for (const spec of [...PROBE_SPECS, DRY_RUN_SPEC]) {
      for (const question of spec.questions) {
        if (!actionMarks.has(question.mark)) continue;
        expect(question.window.after).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it("asks only narrow, single-fact questions with a receipt-derived expectation", () => {
    for (const spec of [...PROBE_SPECS, DRY_RUN_SPEC]) {
      expect(spec.questions.length).toBeGreaterThan(0);
      for (const question of spec.questions) {
        expect(typeof question.text).toBe("function");
        expect(typeof question.expectedIfReceiptTrue).toBe("function");
        expect(question.window.before + question.window.after).toBeGreaterThan(0);
      }
    }
  });
});

describe("recording clock", () => {
  it("maps wall clock onto the recording clock through the recorder anchor", () => {
    const video = { t0WallMs: 1_000_000, t0VideoS: 0.5 };
    expect(wallToVideoSeconds(video, 1_000_000)).toBe(0.5);
    expect(wallToVideoSeconds(video, 1_012_000)).toBe(12.5);
  });

  it("refuses to guess when the recorder never anchored", () => {
    expect(() => wallToVideoSeconds({ t0VideoS: 0 }, 1)).toThrow(/t0WallMs/);
  });

  it("keeps the first recorder progress block as the stable clock anchor", async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { write: () => void };
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: () => undefined };
    child.kill = () => undefined;
    let wallMs = 10_000;
    const recorder = new Recorder({
      path: "/tmp/qa-video-test.mov",
      captureFps: 15,
      scaleWidth: 0,
      crop: null,
      deviceIndex: "1",
      spawnFn: () => child,
      now: () => wallMs,
      anchorTimeoutMs: 100,
    });

    const started = recorder.start();
    child.stdout.emit("data", "out_time_us=250000\nprogress=continue\n");
    await started;
    expect({ t0WallMs: recorder.t0WallMs, t0VideoS: recorder.t0VideoS }).toEqual({
      t0WallMs: 10_000,
      t0VideoS: 0.25,
    });

    wallMs = 20_000;
    child.stdout.emit("data", "out_time_us=10250000\nprogress=continue\n");
    expect({ t0WallMs: recorder.t0WallMs, t0VideoS: recorder.t0VideoS }).toEqual({
      t0WallMs: 10_000,
      t0VideoS: 0.25,
    });
    expect(recorder.secondsAt(12_000)).toBe(2.25);
  });
});

describe("frame planning", () => {
  it("samples densely around the mark rather than uniformly across the video", () => {
    const plan = planFrameWindow({
      markSeconds: 12.4,
      window: { before: 1, after: 2 },
      fps: 10,
      durationS: 120,
    });
    expect(plan?.start).toBe(11.4);
    expect(plan?.end).toBe(14.4);
    expect(plan?.count).toBe(30);
    expect(plan?.times[0]).toBe(11.4);
    expect(plan?.times.at(-1)).toBeCloseTo(14.3, 3);
  });

  it("clamps to the recording instead of planning frames that do not exist", () => {
    const plan = planFrameWindow({
      markSeconds: 119.5,
      window: { before: 1, after: 10 },
      fps: 10,
      durationS: 120,
    });
    expect(plan?.end).toBe(120);
  });

  it("returns null when the mark was never recorded", () => {
    expect(planFrameWindow({ markSeconds: undefined, window: { before: 1, after: 1 }, fps: 10 })).toBeNull();
  });
});

describe("receipt reading", () => {
  it("distinguishes queued from submitted", () => {
    expect(receiptSubmitted(sendStep("submitted"))).toBe(true);
    expect(receiptSubmitted(sendStep("queued"))).toBe(false);
    expect(receiptOk(sendStep("queued"))).toBe(true);
  });

  it("summarises the claim verbatim enough to be checkable", () => {
    expect(describeReceiptClaim(sendStep("submitted"))).toContain('delivery="submitted"');
    expect(describeReceiptClaim({ id: "x", calls: [] })).toBe("no tool call recorded");
    expect(
      describeReceiptClaim({ id: "x", calls: [{ tool: "send_to", error: "boom" }] }),
    ).toContain("send_to threw: boom");
  });
});

describe("adjudication manifest", () => {
  it("emits one narrow question per fact, each carrying its own frames", () => {
    const manifest = buildAdjudicationManifest(runFixture([sendStep("submitted")]), { fps: 10 });
    expect(manifest.questions.map((q: { id: string }) => q.id)).toEqual([
      "busy-send.typed",
      "busy-send.submitted",
    ]);
    const typed = manifest.questions[0];
    expect(typed.frames.length).toBe(typed.frame_times.length);
    expect(typed.frames[0]).toBe("frames/busy-send.typed/f-0001.jpg");
    expect(typed.question).toContain("QAV-BUSY-AB12");
    expect(manifest.allowed_verdicts).toEqual(VERDICTS);
  });

  it("derives the frame expectation from the receipt, so a lying receipt is what fails", () => {
    const submitted = buildAdjudicationManifest(runFixture([sendStep("submitted")]));
    const queued = buildAdjudicationManifest(runFixture([sendStep("queued")]));
    // "submitted" implies the composer is clear two seconds later.
    expect(submitted.questions[1].expected_if_receipt_true).toBe("NO");
    // "queued" implies the text is still sitting there.
    expect(queued.questions[1].expected_if_receipt_true).toBe("YES");
  });

  it("refuses to ask about frames recorded while the probe window was occluded", () => {
    const occluded = {
      ...sendStep("submitted"),
      marks: { send: { videoS: 12.4, frontmost: false }, plus2: { videoS: 14.4, frontmost: true } },
    };
    const manifest = buildAdjudicationManifest(runFixture([occluded]));
    expect(manifest.questions[0].frames).toEqual([]);
    expect(manifest.questions[0].unadjudicable_reason).toContain("occluded");
    expect(manifest.questions[1].frames.length).toBeGreaterThan(0);
  });

  it("marks steps that never reached their mark as unadjudicable instead of silently dropping them", () => {
    const broken = { ...sendStep("submitted"), marks: {}, error: "spawn failed" };
    const manifest = buildAdjudicationManifest(runFixture([broken]));
    expect(manifest.questions[0].frames).toEqual([]);
    expect(manifest.questions[0].unadjudicable_reason).toContain("spawn failed");
  });
});

describe("adjudicator independence", () => {
  it("keeps receipt claims structurally absent from the adjudicator questions file", () => {
    const manifest = buildAdjudicationManifest(runFixture([sendStep("submitted")]), { fps: 10 });
    const { questions, expectations } = splitAdjudicationManifest(manifest);
    const adjudicatorPayload = JSON.stringify(questions);
    expect(adjudicatorPayload).not.toContain("receipt_claim");
    expect(adjudicatorPayload).not.toContain("expected_if_receipt_true");
    expect(adjudicatorPayload).not.toContain('delivery=\\"submitted\\"');
    expect(expectations.expectations[0]).toHaveProperty("receipt_claim");
    expect(combineAdjudicationArtifacts(questions, expectations)).toEqual(manifest);
  });
});

describe("frame storage controls", () => {
  it("rejects a run whose planned extraction exceeds the configured frame cap", () => {
    const manifest = buildAdjudicationManifest(runFixture([sendStep("submitted")]), { fps: 10 });
    expect(() => assertFrameBudget(manifest, 10)).toThrow(/frame cap/i);
    expect(() => assertFrameBudget(manifest, 100)).not.toThrow();
  });

  it("reads timestamp gaps from frame PTS filenames instead of relabelling by array index", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-video-frame-map-"));
    try {
      await writeFile(join(root, "f-0000000000.jpg"), "a");
      await writeFile(join(root, "f-0000000002.jpg"), "b");
      expect(await readExtractedFrameMapping(root, { relativeDir: "frames/q", start: 11.4, fps: 10 })).toEqual([
        { frame: "frames/q/f-0000000000.jpg", timeS: 11.4 },
        { frame: "frames/q/f-0000000002.jpg", timeS: 11.6 },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prunes old completed runs while preserving the newest configured runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-video-retention-"));
    try {
      const runs = [
        ["full-2026-08-18", 1],
        ["full-2026-08-19", 2],
        ["dry-run-2026-08-20", 3],
      ] as const;
      for (const [name, seconds] of runs) {
        await mkdir(join(root, name));
        await writeFile(join(root, name, "run.json"), "{}\n");
        await utimes(join(root, name), seconds, seconds);
      }
      expect(await pruneRunDirectories(root, { keep: 2 })).toEqual(["full-2026-08-18"]);
      expect((await readdir(root)).sort()).toEqual(["dry-run-2026-08-20", "full-2026-08-19"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("reconciliation", () => {
  const manifest = buildAdjudicationManifest(runFixture([sendStep("submitted")]));

  it("calls a receipt-vs-frames mismatch a CONTRADICT", () => {
    const { rows, totals } = reconcile(manifest, [
      { id: "busy-send.typed", verdict: "YES" },
      // Receipt said submitted, so the text should be gone; the frames show it stuck.
      { id: "busy-send.submitted", verdict: "YES", frame: "frames/busy-send.submitted/f-0007.png" },
    ]);
    expect(totals).toMatchObject({ AGREE: 1, CONTRADICT: 1 });
    expect(rows[1].outcome).toBe("CONTRADICT");
  });

  it("keeps NOT_OBSERVABLE distinct from agreement", () => {
    const { totals } = reconcile(manifest, [
      { id: "busy-send.typed", verdict: "NOT_OBSERVABLE", note: "pane off-screen" },
      { id: "busy-send.submitted", verdict: "NO" },
    ]);
    expect(totals.NOT_OBSERVABLE).toBe(1);
    expect(totals.AGREE).toBe(1);
    expect(totals.CONTRADICT).toBe(0);
  });

  it("reports a partial adjudication as MISSING rather than as a pass", () => {
    const { totals } = reconcile(manifest, [{ id: "busy-send.typed", verdict: "YES" }]);
    expect(totals.MISSING).toBe(1);
    expect(OUTCOMES).toContain("MISSING");
  });

  it("rejects a verdict outside the allowed set", () => {
    const { rows } = reconcile(manifest, [
      { id: "busy-send.typed", verdict: "probably" },
      { id: "busy-send.submitted", verdict: "NO" },
    ]);
    expect(rows[0].outcome).toBe("MISSING");
    expect(rows[0].note).toContain("invalid verdict");
  });
});

describe("report", () => {
  it("leads with contradictions and still prints the raw receipts", () => {
    const run = runFixture([sendStep("submitted")]);
    const manifest = buildAdjudicationManifest(run);
    const markdown = buildReportMarkdown(run, manifest, [
      { id: "busy-send.typed", verdict: "YES" },
      { id: "busy-send.submitted", verdict: "YES", frame: "frames/busy-send.submitted/f-0007.png" },
    ]);
    expect(markdown).toContain("**1 CONTRADICT**");
    expect(markdown.indexOf("## Contradictions")).toBeLessThan(markdown.indexOf("## Per-probe detail"));
    expect(markdown).toContain("frames/busy-send.submitted/f-0007.png");
    expect(markdown).toContain("## Raw receipts");
    expect(markdown).toContain("#432");
  });

  it("says so out loud when nothing could be observed", () => {
    const run = runFixture([{ ...sendStep("submitted"), marks: {}, error: "spawn failed" }]);
    const manifest = buildAdjudicationManifest(run);
    const markdown = buildReportMarkdown(run, manifest, []);
    expect(markdown).toContain("## Not observable from video");
    expect(markdown).toContain("spawn failed");
  });
});

describe("harness runner behaviour", () => {
  it("refuses to run without an explicit live opt-in", () => {
    expect(() => assertOptIn({})).toThrow(/Refusing to run the QA video harness/);
    expect(() => assertOptIn({ CMUX_QA_VIDEO: "1" })).not.toThrow();
  });

  it("refuses a full run when the recorder preflight produced no frames", () => {
    expect(() => assertPreflightReady({ extracted: 0 })).toThrow(
      /Refusing to run the full harness against live panes/,
    );
    expect(() => assertPreflightReady({ extracted: 1 })).not.toThrow();
  });

  it("never closes a window that existed before the run", async () => {
    let closeCalls = 0;
    await destroyProbeWindow(
      { windowId: "window-1", preExisting: new Set(["window-1"]) },
      { cmuxFn: async () => { closeCalls += 1; }, stderr: { write: () => undefined } },
    );
    expect(closeCalls).toBe(0);
  });

  it("strips caller identity while preserving the cmux socket address", () => {
    expect(
      sterileEnv({
        CMUX_WORKSPACE_ID: "workspace-1",
        CMUX_TAB_ID: "tab-1",
        CMUX_SURFACE_ID: "surface-1",
        CMUX_PANEL_ID: "panel-1",
        CMUX_TERMINAL_LIFECYCLE_ID: "lifecycle-1",
        CMUX_SOCKET_PATH: "/tmp/cmux.sock",
        PATH: "/usr/bin",
      }),
    ).toEqual({ CMUX_SOCKET_PATH: "/tmp/cmux.sock", PATH: "/usr/bin" });
  });

  it("selects the display containing the probe window centre", () => {
    const displays = [
      { index: 0, main: true, bounds: { x: 0, y: 0, w: 100, h: 100 } },
      { index: 1, main: false, bounds: { x: 100, y: 0, w: 100, h: 100 } },
    ];
    expect(displayContaining(displays, { x: 120, y: 20, w: 40, h: 40 })?.index).toBe(1);
  });

  it("detects rectangle overlap without treating edge contact as occlusion", () => {
    expect(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 9, y: 9, w: 2, h: 2 })).toBe(true);
    expect(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 2, h: 2 })).toBe(false);
  });

  it("derives capture geometry and occlusion from a window-server snapshot", () => {
    const state = {
      displays: [{ index: 1, main: true, scale: 2, bounds: { x: 100, y: 50, w: 500, h: 400 } }],
      windows: [
        { id: 9, owner: "Browser", name: "cover", layer: 0, bounds: { x: 140, y: 90, w: 50, h: 50 } },
        { id: 7, owner: "cmux", name: "QAV-test", layer: 0, bounds: { x: 120, y: 70, w: 100, h: 250 } },
      ],
    };
    expect(probeWindowGeometryFromState(state, "QAV-test")).toMatchObject({
      id: 7,
      clear: false,
      occluders: ["Browser: cover"],
      crop: { x: 40, y: 40, width: 200, height: 500 },
      display: { index: 1 },
    });
  });

  it("closes the isolated window on SIGINT and SIGTERM", () => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const signalSource = new EventEmitter();
      const calls: unknown[][] = [];
      const exits: number[] = [];
      const remove = installSignalHandlers(
        { windowId: "window-2" },
        {
          signalSource,
          execFileFn: (...args: unknown[]) => {
            calls.push(args);
            const callback = args.at(-1);
            if (typeof callback === "function") callback();
          },
          exit: (code: number) => { exits.push(code); },
        },
      );
      signalSource.emit(signal);
      expect(calls[0]?.slice(0, 2)).toEqual(["cmux", ["close-window", "--window", "window-2"]]);
      expect(exits).toEqual([130]);
      remove();
    }
  });

  it("verifies the recording is real before deriving anything from it", () => {
    expect(() => assertVideoUsable({ bytes: 1, durationS: 1, frames: 0 }, "video.mov")).toThrow(
      /no decodable frames/,
    );
    expect(() => assertVideoUsable({ bytes: 1, durationS: 1, frames: 1 }, "video.mov")).not.toThrow();
  });

  it("parses runner options and validates every numeric capture setting", () => {
    expect(parseArgs(["--capture-fps", "20", "--frame-fps", "5", "--scale-width", "1920"])).toMatchObject({
      captureFps: 20,
      frameFps: 5,
      scaleWidth: 1920,
    });
    expect(() => parseArgs(["--scale-width", "abc"])).toThrow(/scaleWidth/);
  });

  it("records through ffmpeg avfoundation instead of blank window capture", async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let invocation: { command: string; args: string[] } | null = null;
    const recorder = new Recorder({
      path: "/tmp/qa-video-test.mov",
      captureFps: 15,
      scaleWidth: 0,
      crop: { x: 1, y: 2, width: 3, height: 4 },
      deviceIndex: "2",
      spawnFn: (command: string, args: string[]) => {
        invocation = { command, args };
        return child;
      },
      now: () => 1,
      anchorTimeoutMs: 100,
    });
    const started = recorder.start();
    child.stdout.emit("data", "out_time_us=1\n");
    await started;
    expect(invocation?.command).toBe("ffmpeg");
    expect(invocation?.args).toContain("avfoundation");
    expect(invocation?.args.join(" ")).toContain("crop=3:4:1:2");
    expect(invocation?.args.join(" ")).not.toContain("screencapture");
  });
});
