import { scenario, marker, spawn, record, observe, replied, resume, requireEvidence } from "../x2-evidence.mjs";

export default scenario({
  id: "resume_stale_done",
  bug: { sha: "14aa55b5", issue: "#1022" }, fix: { sha: null, pr: "pending" },
}, async (ctx, evidence) => {
  const token = marker(ctx, "resume_stale_done");
  const seat = await spawn(ctx, evidence, `Reply exactly ${token}. Use no tools.`);
  await observe(ctx, evidence, seat.surface_id, s => replied(s, token), "screenBoot");
  requireEvidence(typeof seat.report_path === "string" && seat.report_path.startsWith("/") &&
    /^DONE_[A-Z0-9_]+$/.test(seat.done_marker), "report_contract_missing");
  const sent = await record(ctx, evidence, "seed", await ctx.send({ agent_id: seat.agent_id,
    text: `Write ${JSON.stringify(seat.done_marker)} as the final line of ${JSON.stringify(seat.report_path)}. Reply exactly ${token}_SEEDED.`, press_enter: true }));
  requireEvidence(sent.ok === true, "report_seed_send_failed");
  await observe(ctx, evidence, seat.surface_id, s => replied(s, `${token}_SEEDED`), "screenBefore");
  const seeded = await record(ctx, evidence, "oldDone", await ctx.call("wait_for", {
    agent_id: seat.agent_id, report_path: seat.report_path, done_marker: seat.done_marker, timeout_ms: 10_000, verbose: true,
  }));
  requireEvidence(seeded.ok === true && seeded.matched === true, "old_done_unproven");
  await resume(ctx, evidence, seat);
  const wait = await record(ctx, evidence, "readyWait", await ctx.call("wait_for", {
    agent_id: seat.agent_id, target_state: "ready", timeout_ms: 10_000, verbose: true,
  }));
  requireEvidence(wait.ok === true && wait.matched === true && wait.state === "ready", "stale_done_wait");
});
