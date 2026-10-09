import { scenario, marker, spawn, observe, replied, requireEvidence } from "../x2-evidence.mjs";

export default scenario({
  id: "codex_launch_under_cmux_wrapper", targets: ["m1:nightly", "mbp:nightly"],
  bug: { sha: "14aa55b5", issue: "cmux wrapper double-flag early warning" },
  fix: { sha: null, pr: "pending" },
}, async (ctx, evidence) => {
  requireEvidence(typeof ctx.target.codexWrapper === "string" && ctx.target.codexWrapper.startsWith("/"), "wrapper_path_unavailable");
  evidence.codexWrapper = ctx.target.codexWrapper;
  const token = marker(ctx, "codex_launch_under_cmux_wrapper");
  const seat = await spawn(ctx, evidence, `Reply exactly ${token}. Use no tools.`);
  evidence.screenBefore = await ctx.readScreen(seat.surface_id);
  await observe(ctx, evidence, seat.surface_id, s => replied(s, token));
  const args = await ctx.processArgs(seat.agent_id);
  requireEvidence(typeof args === "string" && /(?:^|\/)codex(?:-[\w-]+)?(?:\s|$)/.test(args), "launcher_process_unavailable");
  // Persist counts only: actual argv may contain private MCP configuration.
  evidence.profileFlagCount = (args.match(/(?:^|\s)(?:--profile(?:=|\s)|-p(?=\S|\s))/g) ?? []).length;
  requireEvidence(evidence.profileFlagCount <= 1, "duplicate_profile_flag");
  evidence.bypassFlagCounts = Object.fromEntries([
    "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust",
  ].map(flag => [flag, args.split(/\s+/).filter(arg => arg === flag).length]));
  requireEvidence(Object.values(evidence.bypassFlagCounts).every(count => count <= 1), "duplicate_bypass_flag");
});
