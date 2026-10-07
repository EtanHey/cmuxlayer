import { scenario, marker, spawn, raw, replied, observe, requireEvidence } from "../x2-evidence.mjs";

export default scenario({
  id: "stray_newline",
  bug: { sha: "296664531f7fbb508ecaa96a18992b2466e1fd91", issue: "PR-c #1026" },
  fix: { sha: "af060e67cc48e9da0f79e58495b0cb30c60ad7db", pr: "#1026" },
}, async (ctx, evidence) => {
  const token = marker(ctx, "stray_newline");
  const prompt = `Reply exactly ${token}. Use no tools.`;
  const seat = await spawn(ctx, evidence, prompt);
  evidence.screenBefore = await ctx.readScreen(seat.surface_id);
  const screen = await observe(ctx, evidence, seat.surface_id, s => replied(s, token));
  const lines = raw(screen).split("\n");
  const promptRow = lines.findIndex(line => line.includes(prompt));
  requireEvidence(promptRow >= 0, "prompt_transcript_missing");
  requireEvidence(!/^\s*›[ \t]*$/u.test(lines[promptRow - 1] ?? ""), "leading_newline");
  requireEvidence(/^[ \t]*›[ \t]+/u.test(lines[promptRow]), "prompt_start_unproven");
});
