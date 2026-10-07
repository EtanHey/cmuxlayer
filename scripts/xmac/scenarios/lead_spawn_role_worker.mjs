import { scenario, marker, record, observe, replied, requireEvidence } from "../x2-evidence.mjs";

export default scenario({
  id: "lead_spawn_role_worker", bug: { sha: "001898c8", issue: "PR-e" },
  fix: { sha: null, pr: "pending" },
}, async (ctx, evidence) => {
  const token = marker(ctx, "lead_spawn_role_worker");
  // Explicit parent_agent_id on an external client is not a lead-origin call.
  // Let the real lead invoke its own MCP connection with the role omitted.
  // Claude's role-omitted path reproduces PR-e's ROLE_REQUIRED failure; Codex
  // already defaulted to worker before that fix and would miss this regression.
  const prompt = `Use cmuxlayer to spawn one Claude in your repo/workspace: model haiku, effort low, worktree false, sterile profile, prompt "Reply exactly ${token}_CHILD. Use no tools."; omit role, authority and parent_agent_id. Reply exactly ${token} after tool success.`;
  const leader = await record(ctx, evidence, "leadSpawn", await ctx.spawnLeadSeat({
    cli: "claude", model: "haiku", effort: "low", role: "implementor", authority: "lead",
    placement: "left", worktree: false, prompt: `Reply exactly ${token}_READY. Use no tools.`,
  }));
  requireEvidence(leader.ok === true && leader.agent_id && leader.surface_id, "lead_spawn_failed");
  let children = [];
  try {
    await observe(ctx, evidence, leader.surface_id, s => replied(s, `${token}_READY`), "screenBefore");
    const sent = await record(ctx, evidence, "leadSend", await ctx.leadSend(leader.agent_id, prompt));
    requireEvidence(sent.ok === true, "lead_action_send_failed");
    await observe(ctx, evidence, leader.surface_id, s => replied(s, token), "leadScreen");
    const listed = await record(ctx, evidence, "children", await ctx.call("list_agents", {
      parent_agent_id: leader.agent_id, detail: "full", max_age_ms: 0,
    }));
    children = (listed.agents ?? []).filter(row => row.parent_agent_id === leader.agent_id);
    requireEvidence(listed.ok === true && children.length === 1, "lead_child_unproven");
    const child = children[0];
    requireEvidence(child.role === "worker", "lead_child_wrong_role");
    const screen = await observe(ctx, evidence, child.surface_id, s => replied(s, `${token}_CHILD`));
    requireEvidence(screen.column === 1 && screen.column_count === 2, "lead_child_wrong_column");
  } finally {
    // This seat was spawned through the lead's MCP, outside ctx.spawn tracking.
    const listed = await ctx.call("list_agents", { parent_agent_id: leader.agent_id, detail: "full", max_age_ms: 0 });
    requireEvidence(listed.ok === true && Array.isArray(listed.agents), "child_cleanup_enumeration_failed");
    children = listed.agents.filter(row => row.parent_agent_id === leader.agent_id);
    const cleanupErrors = [];
    for (const child of children) {
      try {
        const closed = await record(ctx, evidence, `close_${child.agent_id}`, await ctx.close(child.agent_id));
        requireEvidence(closed.ok === true && closed.agent_stopped === true && closed.surface_closed === true, "child_cleanup_failed");
      } catch (error) { cleanupErrors.push(`${child.agent_id}:${error.message}`); }
    }
    requireEvidence(cleanupErrors.length === 0, `child_cleanup_failed:${cleanupErrors.join(",")}`);
  }
});
