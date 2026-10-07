import { scenario, marker, spawn, resume, observe, replied, requireEvidence } from "../x2-evidence.mjs";

export default scenario({
  id: "resume_focus",
  bug: { sha: "af060e67cc48e9da0f79e58495b0cb30c60ad7db", issue: "PR-d #1028" },
  fix: { sha: "d2ae985607f1bbcad0e20a21fa3b4038c2e522e6", pr: "#1028" },
}, async (ctx, evidence) => {
  const token = marker(ctx, "resume_focus");
  const seat = await spawn(ctx, evidence, `Reply exactly ${token}. Use no tools.`);
  await observe(ctx, evidence, seat.surface_id, s => replied(s, token), "screenBefore");
  evidence.focusBefore = await ctx.focusedSurface();
  requireEvidence(typeof evidence.focusBefore === "string" && evidence.focusBefore &&
    evidence.focusBefore !== seat.surface_id, "focus_anchor_missing");
  await resume(ctx, evidence, seat);
  evidence.focusAfter = await ctx.focusedSurface();
  requireEvidence(evidence.focusAfter === evidence.focusBefore, "focus_stolen");
});
