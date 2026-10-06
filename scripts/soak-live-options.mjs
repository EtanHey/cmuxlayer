function assertRange(value, minimum, maximum, message) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(message);
}

export function options(argv) {
  const opts = { cycles: 40, concurrency: 2, timeoutMs: 90_000, durationMinutes: 60,
    app: "/Applications/cmux NIGHTLY.app", target: "nightly", repo: "cmuxlayer", gateHost: "", dmg: "", privateHome: "", dryRun: false,
    agentId: process.env.GOLEM_SEAT || "", leadAgentId: "", entry: process.env.CMUXLAYER_SOAK_ENTRY || "/opt/homebrew/opt/cmuxlayer/bin/cmuxlayer",
    claudeModel: "haiku", codexModel: "gpt-6-luna", codexEffort: "low", pool: 2, freshEvery: 0, cases: [], queueDeadlineMs: 90_000, longTurnMinutes: 2 };
  const fields = { "--repo": "repo", "--private-home": "privateHome", "--app": "app", "--target": "target", "--gate-host": "gateHost", "--dmg": "dmg", "--dry-run": "dryRun", "--cycles": "cycles", "--concurrency": "concurrency",
    "--timeout-ms": "timeoutMs", "--duration-minutes": "durationMinutes",
    "--agent-id": "agentId", "--lead-agent-id": "leadAgentId", "--entry": "entry",
    "--claude-model": "claudeModel", "--codex-model": "codexModel",
    "--codex-effort": "codexEffort", "--pool": "pool", "--fresh-every": "freshEvery", "--cases": "cases",
    "--queue-deadline-ms": "queueDeadlineMs", "--long-turn-minutes": "longTurnMinutes" };
  for (let i = 0; i < argv.length; i += 2) {
    const field = fields[argv[i]];
    if (!field || !argv[i + 1]) throw new Error(`unknown or incomplete argument: ${argv[i]}`);
    opts[field] = ["cycles", "concurrency", "timeoutMs", "durationMinutes", "pool", "freshEvery", "queueDeadlineMs", "longTurnMinutes"].includes(field)
      ? Number(argv[i + 1]) : argv[i + 1];
  }
  if (!["nightly", "m1-gate"].includes(opts.target)) throw new Error("target must be nightly or m1-gate");
  if (![false, "true", "false"].includes(opts.dryRun)) throw new Error("dry-run must be true or false");
  opts.dryRun = opts.dryRun === "true";
  if (!/^[A-Za-z0-9_-]+$/u.test(opts.agentId)) throw new Error("--agent-id is required");
  assertRange(opts.cycles, 1, 40, "cycles must be 1..40");
  assertRange(opts.concurrency, 1, 2, "concurrency must be 1..2");
  assertRange(opts.timeoutMs, 1000, 300000, "timeout-ms must be 1000..300000");
  assertRange(opts.durationMinutes, 0, 360, "duration-minutes must be 0..360");
  if (!Number.isInteger(opts.pool) || opts.pool < 0 || opts.pool > 40 || (opts.pool > 0 && opts.pool < opts.concurrency)) {
    throw new Error("pool must be 0 or between concurrency and 40");
  }
  if (opts.pool > 0 && !argv.includes("--fresh-every")) opts.freshEvery = 5;
  if (!Number.isInteger(opts.freshEvery) || (opts.pool > 0 && opts.freshEvery < 1)
    || (opts.pool === 0 && opts.freshEvery !== 0)) throw new Error("fresh-every requires a pool and must be positive");
  opts.cases = typeof opts.cases === "string" ? opts.cases.split(",") : opts.cases;
  if (opts.cases.some((id) => !/^[a-h]$/u.test(id)) || new Set(opts.cases).size !== opts.cases.length) {
    throw new Error("cases must be unique letters a..h");
  }
  assertRange(opts.queueDeadlineMs, 1000, 300000, "queue-deadline-ms must be 1000..300000");
  assertRange(opts.longTurnMinutes, 1, 15, "long-turn-minutes must be 1..15");
  if (opts.codexModel !== "gpt-6-luna" || opts.codexEffort !== "low" || opts.claudeModel !== "haiku") {
    throw new Error("soak seats require gpt-6-luna low and haiku");
  }
  if (opts.pool > 2) throw new Error("soak pool must be at most 2");
  if (opts.leadAgentId) throw new Error("soak cannot read a production lead inbox");
  if (opts.target === "m1-gate" && !opts.dryRun &&
    (opts.cycles !== 40 || opts.durationMinutes < 60 || !"abcdefg".split("").every(id => opts.cases.includes(id)))) {
    throw new Error("M1 release gate requires 40 cycles, at least 60 minutes, and cases a-g");
  }
  if (!opts.dryRun && opts.target !== "m1-gate" && !opts.privateHome) throw new Error("MBP/NIGHTLY real soak requires an authenticated --private-home");
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

export function isPoolSeatDead(row) {
  return !row || row.state === "error";
}
