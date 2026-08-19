import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// @ts-expect-error -- plain .mjs helper module shared with the harness script
import {
  DRY_RUN_SPEC,
  OUTCOMES,
  PROBE_SPECS,
  VERDICTS,
  buildAdjudicationManifest,
  buildReportMarkdown,
  describeReceiptClaim,
  planFrameWindow,
  receiptOk,
  receiptSubmitted,
  reconcile,
  wallToVideoSeconds,
} from "../scripts/qa-video-lib.mjs";

const repoRoot = join(__dirname, "..");

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
    expect(plan?.count).toBe(31);
    expect(plan?.times[0]).toBe(11.4);
    expect(plan?.times.at(-1)).toBeCloseTo(14.4, 3);
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
    expect(typed.frames[0]).toBe("frames/busy-send.typed/f-0001.png");
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

describe("harness script wiring", () => {
  const source = readFileSync(join(repoRoot, "scripts", "qa-video-harness.mjs"), "utf8");

  it("refuses to run without an explicit live opt-in", () => {
    expect(source).toContain("CMUX_QA_VIDEO");
    expect(source).toContain("Refusing to run the QA video harness");
  });

  it("runs the recorder self-test before touching live panes", () => {
    expect(source).toContain("Preflight produced no frames");
    expect(source).toContain("Refusing to run the full harness against live panes");
  });

  it("never closes a window it did not create", () => {
    expect(source).toContain("Refusing to close pre-existing window");
    expect(source).toContain("refusing to proceed");
  });

  it("runs the MCP server without the operator pane's caller identity", () => {
    // Inheriting it made cmuxlayer treat the harness as the operator's own agent
    // and refuse terminal I/O to its surface.
    expect(source).toContain("CMUX_SURFACE_ID");
    expect(source).toContain("sterileEnv");
    expect(source).not.toContain("env: process.env });");
  });

  it("records the display the probe window is actually on", () => {
    // cmux does not always open its new window on the main display; earlier runs
    // recorded display 0 while the probe window sat on display 1.
    expect(source).toContain("screenDeviceIndexFor(geometry.display.index)");
    expect(source).toContain("Capture screen");
  });

  it("resolves geometry and occlusion through CoreGraphics, not AppleScript", () => {
    expect(source).toContain("qa-video-windows.py");
    expect(source).toContain("clear: occluders.length === 0");
    expect(source).not.toContain("first process whose frontmost is true");
  });

  it("keeps the rejected window-capture approach documented so it is not retried", () => {
    // screencapture -l is occlusion-proof but returns a blank content area for
    // cmux's Metal-rendered terminals.
    expect(source).toContain("REJECTED");
    expect(source).toContain("Metal");
  });

  it("tears the isolated window down even when the harness is killed", () => {
    expect(source).toContain('process.once("SIGINT", onSignal)');
    expect(source).toContain('process.once("SIGTERM", onSignal)');
  });

  it("verifies the recording is real before deriving anything from it", () => {
    expect(source).toContain("has no decodable frames");
    expect(source).toContain("assertVideoUsable");
  });

  it("ships the CoreGraphics window helper it depends on", () => {
    const helper = readFileSync(join(repoRoot, "scripts", "qa-video-windows.py"), "utf8");
    expect(helper).toContain("CGWindowListCopyWindowInfo");
    expect(helper).toContain("CGGetActiveDisplayList");
  });

  it("is exposed through package.json", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    expect(pkg.scripts["qa:video"]).toBe("node scripts/qa-video-harness.mjs");
    expect(pkg.scripts["qa:video:dry-run"]).toBe("node scripts/qa-video-harness.mjs --dry-run");
  });
});
