// A resume inherits the verified original seat; it is never a new cheap spawn.
export async function captureSpawnIdentity(identities, receipt, inspectAgent) {
  if (receipt?.agent_id) identities.delete(receipt.agent_id);
  const cli = receipt?.cli ?? receipt?.model_policy?.cli;
  const model = receipt?.model ?? receipt?.model_policy?.effective_model;
  if (receipt?.ok !== true || !receipt.agent_id || !receipt.surface_id ||
      !["codex", "claude"].includes(cli) || model !== (cli === "codex" ? "gpt-6-luna" : "haiku") ||
      receipt.model_policy?.cli && receipt.model_policy.cli !== cli) return;
  // Fresh spawn receipts omit session identity. Snapshot the registry while open.
  const agent = await inspectAgent(receipt.agent_id);
  const record = agent?.detail ?? agent;
  const session = record?.cli_session_id;
  if (agent?.agent_id !== receipt.agent_id || record?.agent_id !== receipt.agent_id ||
      agent.surface_id !== receipt.surface_id || (record.cli ?? agent.cli) !== cli ||
      agent.cli && agent.cli !== cli || typeof session !== "string" || !session.trim()) return;
  identities.set(receipt.agent_id, { cli, cli_session_id: session });
}
export function resumeArgs(args, identities) {
  if (!identities.has(args.resume_agent_id)) {
    const precondition = { status: "PRECONDITION_ABSENT", kind: "resume_identity", agent_id: args.resume_agent_id };
    throw Object.assign(new Error(`PRECONDITION_ABSENT: ${JSON.stringify(precondition)}`), { precondition });
  }
  // Only options consumed by the product's resume branch, never new-spawn fields.
  return Object.fromEntries(["resume_agent_id", "force", "focus", "workspace", "report_path", "verbose"]
    .filter(key => args[key] !== undefined).map(key => [key, args[key]]));
}
