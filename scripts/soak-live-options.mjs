export function options(argv) {
  const opts = { cycles: 40, concurrency: 2, timeoutMs: 90_000, durationMinutes: 60,
    agentId: process.env.GOLEM_SEAT || "", leadAgentId: "", entry: process.env.CMUXLAYER_SOAK_ENTRY || "cmuxlayer",
    claudeModel: null, codexModel: "gpt-6-sol", codexEffort: "low", pool: 0, freshEvery: 0 };
  const fields = { "--cycles": "cycles", "--concurrency": "concurrency",
    "--timeout-ms": "timeoutMs", "--duration-minutes": "durationMinutes",
    "--agent-id": "agentId", "--lead-agent-id": "leadAgentId", "--entry": "entry",
    "--claude-model": "claudeModel", "--codex-model": "codexModel",
    "--codex-effort": "codexEffort", "--pool": "pool", "--fresh-every": "freshEvery" };
  for (let i = 0; i < argv.length; i += 2) {
    const field = fields[argv[i]];
    if (!field || !argv[i + 1]) throw new Error(`unknown or incomplete argument: ${argv[i]}`);
    opts[field] = ["cycles", "concurrency", "timeoutMs", "durationMinutes", "pool", "freshEvery"].includes(field)
      ? Number(argv[i + 1]) : argv[i + 1];
  }
  if (!/^[A-Za-z0-9_-]+$/.test(opts.agentId)) throw new Error("--agent-id is required");
  if (!Number.isInteger(opts.cycles) || opts.cycles < 1 || opts.cycles > 40) throw new Error("cycles must be 1..40");
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1 || opts.concurrency > 2) throw new Error("concurrency must be 1..2");
  if (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs < 1000 || opts.timeoutMs > 300_000) {
    throw new Error("timeout-ms must be 1000..300000");
  }
  if (!Number.isInteger(opts.durationMinutes) || opts.durationMinutes < 0 || opts.durationMinutes > 360) {
    throw new Error("duration-minutes must be 0..360");
  }
  if (!Number.isInteger(opts.pool) || opts.pool < 0 || opts.pool > 40 || (opts.pool > 0 && opts.pool < opts.concurrency)) {
    throw new Error("pool must be 0 or between concurrency and 40");
  }
  if (opts.pool > 0 && !argv.includes("--fresh-every")) opts.freshEvery = 5;
  if (!Number.isInteger(opts.freshEvery) || (opts.pool > 0 && opts.freshEvery < 1)
    || (opts.pool === 0 && opts.freshEvery !== 0)) throw new Error("fresh-every requires a pool and must be positive");
  return opts;
}

export function cycleAssignment(cycle, pool, freshEvery) {
  if (!pool || cycle % freshEvery === 0) {
    return { kind: "fresh", cli: cycle % 2 === 0 ? "codex" : "claude" };
  }
  const poolCycle = cycle - Math.floor(cycle / freshEvery);
  const slot = (poolCycle - 1) % pool;
  return { kind: "pool", slot, cli: slot % 2 === 0 ? "claude" : "codex" };
}
