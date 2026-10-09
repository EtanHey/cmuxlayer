import { scenario, marker, spawn, resume, observe, replied, requireEvidence } from "../x2-evidence.mjs";

// --worker is consumed by repoGolem, so the child argv exposes its connector
// policy rather than the launcher flag. Store only these non-secret overrides.
const strips = args => typeof args === "string"
  ? args.match(/(?:features\.apps|apps\._default\.enabled|apps\.[\w-]+\.enabled)=false/g) ?? [] : [];
export default scenario({
  id: "resume_keeps_worker_role", bug: { sha: "14aa55b5", issue: "resume connector strips" },
  fix: { sha: null, pr: "pending" },
}, async (ctx, evidence) => {
  const token = marker(ctx, "resume_worker");
  const seat = await spawn(ctx, evidence, `Reply exactly ${token}. Use no tools.`);
  await observe(ctx, evidence, seat.surface_id, s => replied(s, token), "screenBefore");
  evidence.stripsBefore = strips(await ctx.processArgs(seat.agent_id));
  requireEvidence(evidence.stripsBefore.length > 0, "worker_policy_unavailable");
  const resumed = await resume(ctx, evidence, seat);
  evidence.stripsAfter = strips(await ctx.processArgs(resumed.agent_id));
  requireEvidence(evidence.stripsBefore.every(flag => evidence.stripsAfter.includes(flag)), "worker_policy_dropped");
  evidence.role = (await ctx.inspectAgent(resumed.agent_id))?.role;
  requireEvidence(evidence.role === "worker", "worker_role_dropped");
  requireEvidence(evidence.screenAfter.column === 1 && evidence.screenAfter.column_count === 2, "worker_placement_dropped");
});
