import { scenario, marker, spawn, raw, replied, record, observe, requireEvidence } from "../x2-evidence.mjs";

const working = screen => /(?:Working|Thinking)\s*\([^\n]*esc to interrupt/i.test(raw(screen));
function pending(screen, prompt, mode) {
  const lines = raw(screen).split("\n");
  const heading = mode === "queue" ? "Queued follow-up inputs" : "Messages to be submitted after next tool call";
  const start = lines.findLastIndex(line => line.includes(heading));
  const composer = lines.findLastIndex(line => /^\s*›(?:\s|$)/u.test(line));
  return start >= 0 && composer > start && lines.slice(start + 1, composer)
    .some(line => line.replace(/^\s*[│┃║┆┊]?\s*↳\s*/u, "").trim() === prompt);
}
export default scenario({
  id: "busy_codex_steer_vs_queue", bug: { sha: "14aa55b5", issue: "queued vs consumed" },
  fix: { sha: null, pr: "pending" },
}, async (ctx, evidence) => {
  for (const mode of ["steer", "queue"]) {
    const token = marker(ctx, `busy_${mode}`), prompt = `Reply exactly ${token}. Use no tools.`;
    const entry = evidence[mode] = {};
    const seat = await spawn(ctx, entry, `Reply exactly ${token}_READY. Use no tools.`);
    await ctx.busy(seat.agent_id, 10);
    entry.screenBefore = await ctx.readScreen(seat.surface_id);
    requireEvidence(working(entry.screenBefore), "busy_not_exercised");
    const sent = await record(ctx, entry, "send", await ctx.send({ agent_id: seat.agent_id,
      text: prompt, press_enter: true, allow_busy: true, codex_busy_mode: mode }));
    requireEvidence(sent.ok === true && sent.delivery_id && sent.delivery_state ===
      (mode === "queue" ? "queued" : "steer_pending"), "busy_mode_not_exercised");
    requireEvidence(sent.submitted === false, "pending_claimed_consumed");
    await observe(ctx, entry, seat.surface_id, s => pending(s, prompt, mode), "screenPending");
    const settled = await record(ctx, entry, "consumed", await ctx.call("wait_for", {
      delivery_id: sent.delivery_id, timeout_ms: 30_000, verbose: true,
    }));
    requireEvidence(settled.ok === true && settled.timed_out !== true &&
      settled.delivery_state === "submitted" && settled.submitted === true, "queue_not_consumed");
    await observe(ctx, entry, seat.surface_id, s => replied(s, token));
    requireEvidence(!pending(entry.screenAfter, prompt, mode), "queue_still_visible");
    const closed = await record(ctx, entry, "close", await ctx.close(seat.agent_id));
    requireEvidence(closed.ok === true && closed.agent_stopped === true && closed.surface_closed === true, "busy_seat_cleanup_failed");
  }
  evidence.screenBefore = evidence.steer.screenBefore;
  evidence.screenAfter = evidence.queue.screenAfter;
});
