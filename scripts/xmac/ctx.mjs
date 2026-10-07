import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export class WaitTimeout extends Error {
  constructor(last) { super("screen wait timed out"); this.name = "WaitTimeout"; this.last = last; }
}
export function unwrap(result) {
  if (result?.isError) throw new Error(JSON.stringify(result));
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.find(item => item.type === "text")?.text;
  if (text !== undefined) return JSON.parse(text);
  throw new Error("MCP result has no structuredContent or JSON text");
}
function cheapSpawn(opts) {
  const cli = opts.cli ?? "codex";
  if (!["codex", "claude"].includes(cli)) throw new Error("only cheapest Codex/Claude seats allowed");
  const model = cli === "codex" ? "gpt-6-luna" : "haiku";
  if (opts.model && opts.model !== model || cli === "codex" && opts.effort && opts.effort !== "low") {
    throw new Error("only cheapest models and low Codex effort allowed");
  }
  return { ...opts, cli, model, ...(cli === "codex" ? { effort: "low" } : {}) };
}

/** @returns {import('./ctx.d.mjs').ScenarioContext} */
export function createContext({ driver, evidenceDir, parseScreen, onScreen = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now }) {
  const owned = new Set();
  let sequence = 0;
  const artifact = async (name, data) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) || name.includes("..")) throw new Error("unsafe artifact name");
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
    const path = join(evidenceDir, name);
    await writeFile(path, typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    return path;
  };
  const call = async (name, args = {}) => {
    if (name === "spawn_agent") {
      if (args.resume_agent_id && !args.cli) {
        const agent = unwrap(await driver.call("list_agents", { agent_ids: [args.resume_agent_id], detail: "full" })).agents?.[0];
        if (!agent?.cli) throw new Error("resume CLI identity missing");
        args = { ...args, cli: agent.cli };
      }
      args = cheapSpawn(args);
    }
    const result = await driver.call(name, args);
    // Error envelopes can still identify a partially-created seat: own it before decoding.
    const partial = result?.structuredContent;
    if (name === "spawn_agent" && partial?.agent_id) owned.add(partial.agent_id);
    const value = unwrap(result);
    if (name === "spawn_agent" && value.agent_id) owned.add(value.agent_id);
    return value;
  };
  const ctx = {
    target: driver.target, call, artifact,
    spawnLeadSeat: async (opts = {}) => {
      const args = { ...cheapSpawn({ ...opts, cli: "claude", model: "haiku" }), role: "implementor", authority: "lead", placement: "left", verbose: true };
      const result = await driver.spawnLeadSeat(args);
      if (result?.structuredContent?.agent_id) owned.add(result.structuredContent.agent_id);
      const value = unwrap(result);
      if (value.agent_id) owned.add(value.agent_id);
      return value;
    },
    leadSend: (agentId, text) => ctx.send({ agent_id: agentId, text }),
    receipt: (label, value) => artifact(`${++sequence}-${label}.json`, value),
    spawn: opts => call("spawn_agent", { ...opts, verbose: true }),
    resume: (agentId, opts = {}) => call("spawn_agent", { ...opts, resume_agent_id: agentId, verbose: true }),
    close: agentId => call("close_surface", { agent_id: agentId, scope: "agent", force: true }),
    send: opts => call("send_to", { mode: "agent", ...opts, verbose: true }),
    key: (surface, key) => call("send_to", { mode: "key", surface, text: key }),
    inspectAgent: async agentId => (await call("list_agents", { agent_ids: [agentId], detail: "full" })).agents[0],
    focusedSurface: () => driver.focusedSurface(),
    processArgs: agentId => driver.processArgs(agentId),
    readScreen: async surface => {
      const raw = await driver.readScreen(surface);
      if (typeof raw.text !== "string") throw new Error("raw socket screen text missing");
      await onScreen(surface, raw);
      return { text: raw.text, parsed: parseScreen(raw.text), column: raw.column ?? null, column_count: raw.column_count ?? null };
    },
    waitScreen: async (surface, predicate, ms) => {
      if (!Number.isFinite(ms) || ms < 0) throw new Error("invalid screen wait duration");
      const deadline = now() + ms;
      let last;
      do {
        last = await ctx.readScreen(surface);
        if (await predicate(last)) return last;
        if (now() >= deadline) break;
        await sleep(Math.min(100, deadline - now()));
      } while (now() <= deadline);
      throw new WaitTimeout(last);
    },
    busy: async (agentId, seconds) => {
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) throw new Error("busy duration must be 1..60 seconds");
      const agent = await ctx.inspectAgent(agentId);
      const receipt = await ctx.send({ agent_id: agentId, text: `Run sleep ${seconds} then reply BUSY_DONE.` });
      await ctx.waitScreen(agent.surface_id, screen => screen.parsed?.state === "working", 10_000);
      return receipt;
    },
    dispose: async () => {
      const receipts = [], errors = [];
      try { receipts.push({ children: await driver.sweepChildren() }); }
      catch (error) { errors.push({ children: String(error) }); }
      for (const agentId of owned) {
        try {
          const result = await ctx.close(agentId);
          receipts.push({ agent_id: agentId, result });
          if (result.ok === false || result.isError || !await driver.verifyClosed(agentId)) {
            throw new Error(`unverified close: ${agentId}`);
          }
        } catch (error) { errors.push({ agent_id: agentId, error: String(error) }); }
      }
      await artifact("cleanup.json", { receipts, errors });
      if (errors.length) throw new Error(`seat cleanup failed: ${JSON.stringify(errors)}`);
    },
  };
  return ctx;
}
