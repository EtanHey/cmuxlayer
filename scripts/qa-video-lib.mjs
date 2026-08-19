/**
 * Pure helpers for the QA video harness (lane QA-V).
 *
 * AIDEV-NOTE: Everything in this file must stay side-effect free so the harness
 * logic (frame planning, question generation, verdict reconciliation, report
 * rendering) is unit-testable without a live cmux, a display, or ffmpeg.
 * The impure runner lives in scripts/qa-video-harness.mjs.
 */

/** Verdicts an adjudicating sub-agent may return. */
export const VERDICTS = ["YES", "NO", "NOT_OBSERVABLE"];

/** Reconciliation outcomes between a tool receipt and the recorded frames. */
export const OUTCOMES = ["AGREE", "CONTRADICT", "NOT_OBSERVABLE", "MISSING"];

/**
 * Probe catalogue. Each entry names the fleet-reported repro it re-runs and the
 * narrow questions a vision sub-agent must answer about it. `mark` selects which
 * timestamp on the step the frame window is centred on.
 */
export const PROBE_SPECS = [
  {
    id: "busy-send",
    title: "send_to a BUSY agent",
    issues: ["#432", "#484"],
    questions: [
      {
        suffix: "typed",
        mark: "send",
        // AIDEV-NOTE: the mark is the instant the tool CALL was made; the pixels
        // lag it by the cmux round-trip plus a terminal repaint. A measured
        // dry-run put that at ~1.7s, so this window is deliberately generous
        // after the mark — missing the transition is the one failure that makes
        // the whole frame budget worthless.
        window: { before: 1.0, after: 6.0 },
        text: (ctx) =>
          `Did the exact text \`${ctx.nonce}\` appear in the composer / input line of the agent pane (${ctx.paneHint})?`,
        expectedIfReceiptTrue: (step) =>
          receiptDelivered(step) ? "YES" : "NO",
      },
      {
        suffix: "submitted",
        mark: "plus2",
        window: { before: 0.5, after: 2.0 },
        text: (ctx) =>
          `Two seconds after the send, is \`${ctx.nonce}\` STILL sitting unsent in the composer of ${ctx.paneHint}? Answer YES if it is still in the composer (i.e. it was never submitted), NO if the composer is clear or the text has moved into the transcript above the composer (i.e. it was submitted).`,
        // A receipt that claims submitted implies the composer is clear -> NO.
        expectedIfReceiptTrue: (step) =>
          receiptSubmitted(step) ? "NO" : "YES",
      },
    ],
  },
  {
    id: "stale-terminal-send",
    title: "send_to a pane whose registry row is stale-terminal",
    issues: ["#484"],
    questions: [
      {
        suffix: "typed",
        mark: "send",
        // AIDEV-NOTE: the mark is the instant the tool CALL was made; the pixels
        // lag it by the cmux round-trip plus a terminal repaint. A measured
        // dry-run put that at ~1.7s, so this window is deliberately generous
        // after the mark — missing the transition is the one failure that makes
        // the whole frame budget worthless.
        window: { before: 1.0, after: 6.0 },
        text: (ctx) =>
          `The registry believes this agent is terminal (done/error) but its pane is still alive. Did the exact text \`${ctx.nonce}\` appear in the composer of ${ctx.paneHint}?`,
        expectedIfReceiptTrue: (step) =>
          receiptDelivered(step) ? "YES" : "NO",
      },
      {
        suffix: "submitted",
        mark: "plus2",
        window: { before: 0.5, after: 2.0 },
        text: (ctx) =>
          `Two seconds later, is \`${ctx.nonce}\` still unsent in the composer of ${ctx.paneHint}? YES = still in the composer (never submitted). NO = composer clear or text moved into the transcript (submitted).`,
        expectedIfReceiptTrue: (step) =>
          receiptSubmitted(step) ? "NO" : "YES",
      },
    ],
  },
  {
    id: "close-agent",
    title: 'close_surface(scope:"agent")',
    issues: ["#485"],
    questions: [
      {
        suffix: "pane-gone",
        mark: "plus3",
        window: { before: 3.5, after: 1.5 },
        text: (ctx) =>
          `Before the close there were ${ctx.surfaceCountBefore ?? "N"} terminal pane(s)/tab(s) in this window. After the close, has the agent pane (${ctx.paneHint}) actually disappeared from the window? YES = the pane is gone. NO = the pane is still rendered.`,
        expectedIfReceiptTrue: (step) => (receiptOk(step) ? "YES" : "NO"),
      },
    ],
  },
  {
    id: "list-closure-flap",
    title: "list_agents x3 over ~20s",
    issues: ["#488"],
    questions: [
      {
        suffix: "pane-unchanged",
        mark: "span",
        window: { before: 0.5, after: 21.0 },
        text: () =>
          `Across this ~20 second span, did the agent pane change in any visible way that could justify its lifecycle/closure state changing — did it start or stop streaming, exit, show a new prompt, or disappear? YES = something visibly changed. NO = the pane looked static throughout.`,
        // The receipt is honest only if a flapping closure field is matched by a
        // visible change. If closure did NOT flap, frames are simply corroborating.
        expectedIfReceiptTrue: (step) =>
          step?.context?.closureFlapped ? "YES" : "NO",
      },
    ],
  },
  {
    id: "wait-for-working",
    title: "wait_for on a working agent",
    issues: ["#473"],
    questions: [
      {
        suffix: "still-working",
        mark: "return",
        window: { before: 2.0, after: 1.5 },
        text: (ctx) =>
          `At the instant wait_for returned, was the agent pane (${ctx.paneHint}) visibly STILL working — spinner animating, tokens streaming, or a "working/thinking/esc to interrupt" style status line on screen? YES = still working. NO = the pane is idle at a bare prompt.`,
        // A receipt claiming "already completed" is only honest if the pane is idle.
        expectedIfReceiptTrue: (step) =>
          step?.context?.claimedAlreadyCompleted ? "NO" : "YES",
      },
    ],
  },
  {
    id: "spawn-under-keystrokes",
    title: "spawn while keystrokes are injected",
    issues: ["#434", "#440"],
    questions: [
      {
        suffix: "launcher-line-clean",
        mark: "launch",
        // A spawn takes far longer to reach the launcher line than a send does.
        window: { before: 1.0, after: 12.0 },
        text: (ctx) =>
          `Keystrokes were injected into this pane while the launcher command was being typed. Look at the shell command line in ${ctx.paneHint}. Is the launcher invocation clean — i.e. does it read as an intact command with no stray injected characters (\`${ctx.junk}\`) spliced into it? YES = clean. NO = corrupted / interleaved.`,
        expectedIfReceiptTrue: (step) => (receiptOk(step) ? "YES" : "NO"),
      },
      {
        suffix: "recovered",
        mark: "settle",
        window: { before: 2.0, after: 4.0 },
        text: (ctx) =>
          `A few seconds after launch, did the agent CLI in ${ctx.paneHint} actually come up (a real agent TUI is rendered), or is the pane sitting at a shell prompt / showing a command-not-found style error? YES = the agent CLI is up. NO = it did not launch.`,
        expectedIfReceiptTrue: (step) => (receiptOk(step) ? "YES" : "NO"),
      },
    ],
  },
];

/** The single trivial probe used by --dry-run to prove the whole pipeline. */
export const DRY_RUN_SPEC = {
  id: "clapper",
  title: "recorder + frame-extraction self-test",
  issues: [],
  questions: [
    {
      suffix: "visible",
      mark: "clap",
      window: { before: 1.0, after: 5.0 },
      text: (ctx) =>
        `Is the exact string \`${ctx.nonce}\` visible anywhere in this frame? YES = visible. NO = not visible.`,
      expectedIfReceiptTrue: () => "YES",
    },
  ],
};

function firstReceipt(step) {
  const call = (step?.calls ?? []).find((entry) => entry?.receipt);
  return call?.receipt ?? null;
}

/** True when the receipt claims the text reached the pane at all. */
export function receiptDelivered(step) {
  const receipt = firstReceipt(step);
  if (!receipt) return false;
  const structured = receipt.structured ?? {};
  if (structured.delivered === true) return true;
  return ["submitted", "queued", "queued_followup", "pending_verify"].includes(
    String(structured.delivery ?? structured.delivery_state ?? ""),
  );
}

/** True when the receipt claims the text was actually submitted (Enter landed). */
export function receiptSubmitted(step) {
  const receipt = firstReceipt(step);
  if (!receipt) return false;
  const structured = receipt.structured ?? {};
  return (
    String(structured.delivery ?? structured.delivery_state ?? "") ===
    "submitted"
  );
}

/** True when the receipt reported success. */
export function receiptOk(step) {
  const receipt = firstReceipt(step);
  if (!receipt) return false;
  if (receipt.ok === false) return false;
  if (receipt.structured?.ok === false) return false;
  return receipt.ok === true || receipt.structured?.ok === true;
}

/** Human-readable one-liner of what the receipts CLAIMED for a step. */
export function describeReceiptClaim(step) {
  const calls = step?.calls ?? [];
  if (calls.length === 0) return "no tool call recorded";
  return calls
    .map((call) => {
      if (call.error) return `${call.tool} threw: ${call.error}`;
      const structured = call.receipt?.structured ?? {};
      const bits = [];
      if (typeof structured.ok === "boolean" || typeof call.receipt?.ok === "boolean") {
        bits.push(`ok=${structured.ok ?? call.receipt?.ok}`);
      }
      for (const key of [
        "delivered",
        "delivery",
        "delivery_state",
        "state",
        "closure",
        "closed",
        "scope",
        "agent_id",
      ]) {
        if (structured[key] !== undefined) bits.push(`${key}=${JSON.stringify(structured[key])}`);
      }
      return `${call.tool} -> ${bits.length > 0 ? bits.join(" ") : "(no structured fields)"}`;
    })
    .join("; ");
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Convert a wall-clock instant into a position on the recording clock.
 * `video.t0WallMs` is the wall time at which the recorder reported `t0VideoS`.
 */
export function wallToVideoSeconds(video, wallMs) {
  if (!video || typeof video.t0WallMs !== "number") {
    throw new Error("video clock is missing t0WallMs");
  }
  return round(video.t0VideoS + (wallMs - video.t0WallMs) / 1000);
}

/**
 * Dense frame plan for one question: samples at `fps` across the mark's window,
 * clamped to the recording. Transitions are the hot spots, so the caller gives a
 * tight window rather than sampling the whole video uniformly.
 */
export function planFrameWindow({ markSeconds, window: win, fps, durationS }) {
  if (typeof markSeconds !== "number" || Number.isNaN(markSeconds)) return null;
  const start = Math.max(0, round(markSeconds - win.before));
  const rawEnd = round(markSeconds + win.after);
  const end = typeof durationS === "number" ? Math.min(rawEnd, round(durationS)) : rawEnd;
  if (end <= start) return null;
  const count = Math.max(1, Math.floor((end - start) * fps) + 1);
  const times = [];
  for (let index = 0; index < count; index += 1) {
    times.push(round(start + index / fps));
  }
  return { start, end, fps, count, times };
}

function specForStep(step) {
  if (step?.id === DRY_RUN_SPEC.id) return DRY_RUN_SPEC;
  return PROBE_SPECS.find((spec) => spec.id === step?.id) ?? null;
}

/**
 * Build the adjudication manifest: one narrow question per entry, each carrying
 * the frames a Sonnet sub-agent should look at and nothing else.
 */
export function buildAdjudicationManifest(run, { fps = 10 } = {}) {
  const durationS = run?.video?.durationS;
  const questions = [];
  for (const step of run?.steps ?? []) {
    const spec = specForStep(step);
    if (!spec) continue;
    const claim = describeReceiptClaim(step);
    for (const question of spec.questions) {
      const mark = step.marks?.[question.mark];
      const id = `${step.id}.${question.suffix}`;
      // A mark taken while the probe window was not frontmost recorded some
      // OTHER window. Those frames cannot answer anything about the probe, and
      // asking a sub-agent about them invites a confident wrong answer.
      if (mark && mark.frontmost === false) {
        questions.push({
          id,
          step: step.id,
          step_title: spec.title,
          issues: spec.issues,
          mark: question.mark,
          mark_video_s: mark.videoS,
          question: safeText(question, step),
          receipt_claim: claim,
          expected_if_receipt_true: safeExpected(question, step),
          frames: [],
          frame_times: [],
          unadjudicable_reason:
            "the probe window was not frontmost at this mark; the recording captured a different window",
        });
        continue;
      }
      if (!mark || typeof mark.videoS !== "number") {
        questions.push({
          id,
          step: step.id,
          step_title: spec.title,
          issues: spec.issues,
          mark: question.mark,
          question: safeText(question, step),
          receipt_claim: claim,
          expected_if_receipt_true: safeExpected(question, step),
          frames: [],
          frame_times: [],
          unadjudicable_reason: step.error
            ? `step failed before the mark was reached: ${step.error}`
            : `mark "${question.mark}" was never recorded`,
        });
        continue;
      }
      const plan = planFrameWindow({
        markSeconds: mark.videoS,
        window: question.window,
        fps,
        durationS,
      });
      questions.push({
        id,
        step: step.id,
        step_title: spec.title,
        issues: spec.issues,
        mark: question.mark,
        mark_video_s: mark.videoS,
        question: safeText(question, step),
        receipt_claim: claim,
        expected_if_receipt_true: safeExpected(question, step),
        frame_dir: `frames/${id}`,
        frame_window: plan ? { start: plan.start, end: plan.end, fps: plan.fps } : null,
        frames: plan
          ? plan.times.map((_, index) => `frames/${id}/f-${String(index + 1).padStart(4, "0")}.png`)
          : [],
        frame_times: plan ? plan.times : [],
        unadjudicable_reason: plan ? null : "mark falls outside the recorded video",
      });
    }
  }
  return {
    run_id: run?.runId ?? null,
    mode: run?.mode ?? null,
    video: run?.video ?? null,
    allowed_verdicts: VERDICTS,
    questions,
  };
}

function safeText(question, step) {
  try {
    return question.text(step?.context ?? {});
  } catch (error) {
    return `(question text failed to render: ${error instanceof Error ? error.message : String(error)})`;
  }
}

function safeExpected(question, step) {
  try {
    return question.expectedIfReceiptTrue(step);
  } catch {
    return null;
  }
}

/**
 * Reconcile sub-agent verdicts against what the receipts claimed.
 * A CONTRADICT is the product of this harness; a MISSING verdict is loud on
 * purpose so a partial adjudication can never read as a clean run.
 */
export function reconcile(manifest, verdicts) {
  const byId = new Map(
    (verdicts ?? []).map((verdict) => [verdict.id, verdict]),
  );
  const rows = manifest.questions.map((question) => {
    const verdict = byId.get(question.id);
    if (question.unadjudicable_reason && !verdict) {
      return {
        ...question,
        verdict: "NOT_OBSERVABLE",
        outcome: "NOT_OBSERVABLE",
        note: question.unadjudicable_reason,
        frame: null,
      };
    }
    if (!verdict) {
      return { ...question, verdict: null, outcome: "MISSING", note: "no verdict returned", frame: null };
    }
    const value = String(verdict.verdict ?? "").toUpperCase();
    if (!VERDICTS.includes(value)) {
      return {
        ...question,
        verdict: value || null,
        outcome: "MISSING",
        note: `invalid verdict ${JSON.stringify(verdict.verdict)}`,
        frame: verdict.frame ?? null,
      };
    }
    let outcome = "NOT_OBSERVABLE";
    if (value !== "NOT_OBSERVABLE") {
      if (question.expected_if_receipt_true === null || question.expected_if_receipt_true === undefined) {
        outcome = "NOT_OBSERVABLE";
      } else {
        outcome = value === question.expected_if_receipt_true ? "AGREE" : "CONTRADICT";
      }
    }
    return {
      ...question,
      verdict: value,
      outcome,
      note: verdict.note ?? null,
      frame: verdict.frame ?? null,
    };
  });
  const totals = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0]));
  for (const row of rows) totals[row.outcome] += 1;
  return { rows, totals };
}

function fence(value) {
  return "```json\n" + JSON.stringify(value, null, 2) + "\n```";
}

/** Render the human-facing report. Contradictions lead; they are the product. */
export function buildReportMarkdown(run, manifest, verdicts, { now } = {}) {
  const { rows, totals } = reconcile(manifest, verdicts);
  const stamp = now ?? run?.startedAt ?? "unknown";
  const lines = [];
  lines.push(`# QA video report — ${run?.runId ?? "unknown run"}`);
  lines.push("");
  lines.push(
    `Ground truth for cmuxlayer claims taken from **outside** cmuxlayer: a screen recording of an isolated probe window, adjudicated frame-by-frame by vision sub-agents.`,
  );
  lines.push("");
  lines.push(`- Run: \`${run?.runId ?? "?"}\` (mode: \`${run?.mode ?? "?"}\`) started ${stamp}`);
  lines.push(
    `- Video: \`${run?.video?.path ?? "?"}\` — ${run?.video?.durationS ?? "?"}s, ${run?.video?.fps ?? "?"} fps capture, ${run?.video?.frames ?? "?"} frames`,
  );
  lines.push(`- Isolated window: \`${run?.window?.windowRef ?? "?"}\`, workspace \`${run?.window?.workspaceRef ?? "?"}\``);
  lines.push(
    `- Outcomes: **${totals.CONTRADICT} CONTRADICT**, ${totals.AGREE} AGREE, ${totals.NOT_OBSERVABLE} NOT OBSERVABLE, ${totals.MISSING} MISSING`,
  );
  lines.push("");

  const contradictions = rows.filter((row) => row.outcome === "CONTRADICT");
  lines.push("## Contradictions");
  lines.push("");
  if (contradictions.length === 0) {
    lines.push("None. Every adjudicable receipt matched the frames.");
  } else {
    for (const row of contradictions) {
      lines.push(`### ${row.id} ${row.issues.length > 0 ? `(${row.issues.join(", ")})` : ""}`);
      lines.push("");
      lines.push(`- **Receipt claimed:** ${row.receipt_claim}`);
      lines.push(`- **Frames show:** verdict \`${row.verdict}\` (receipt implies \`${row.expected_if_receipt_true}\`)`);
      lines.push(`- **Evidence frame:** \`${row.frame ?? "(sub-agent returned none)"}\` at t≈${row.mark_video_s ?? "?"}s`);
      if (row.note) lines.push(`- **Adjudicator note:** ${row.note}`);
      lines.push("");
    }
  }
  lines.push("");

  lines.push("## Per-probe detail");
  lines.push("");
  lines.push("| probe | issues | question | receipt claimed | frames show | outcome |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const row of rows) {
    lines.push(
      `| \`${row.id}\` | ${row.issues.join(" ") || "—"} | ${escapeCell(row.question)} | ${escapeCell(row.receipt_claim)} | ${row.verdict ?? "—"} | **${row.outcome}** |`,
    );
  }
  lines.push("");

  const notObservable = rows.filter((row) => row.outcome === "NOT_OBSERVABLE");
  if (notObservable.length > 0) {
    lines.push("## Not observable from video");
    lines.push("");
    lines.push("These are honest gaps, not passes — the state they assert is off-screen.");
    lines.push("");
    for (const row of notObservable) {
      lines.push(`- \`${row.id}\` — ${row.note ?? row.unadjudicable_reason ?? "adjudicator could not tell from the frames"}`);
    }
    lines.push("");
  }

  lines.push("## Raw receipts");
  lines.push("");
  for (const step of run?.steps ?? []) {
    lines.push(`### ${step.id}`);
    lines.push("");
    if (step.error) lines.push(`Step error: \`${step.error}\``);
    lines.push(fence(step.calls ?? []));
    lines.push("");
  }
  return lines.join("\n");
}

function escapeCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}
