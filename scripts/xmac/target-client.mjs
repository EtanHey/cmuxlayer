import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { startSoakRuntime, rpc, INSTALLED_ENTRY } from "../soak-runtime.mjs";
import { targetOptions, shellQuote, privateBuild } from "./target.mjs";
import { unwrap } from "./ctx.mjs";
import { productionSnapshot, productionChanges } from "./production-guard.mjs";


export function boundedSpawn(args, defaults) {
  const cli = args.cli ?? "codex", model = cli === "codex" ? "gpt-6-luna" : "haiku";
  if (!["codex", "claude"].includes(cli) || args.model && args.model !== model || cli === "codex" && args.effort && args.effort !== "low") throw new Error("cheapest models only");
  return { ...args, repo: defaults.repo, cwd: defaults.cwd, workspace: defaults.workspace, worktree: false,
    force_new: true, mcp_profile: "sterile", cli, model, ...(cli === "codex" ? { effort: "low" } : {}) };
}
export function claudeWrapper(binary, config) {
  // A registered launcher can supply its own --mcp-config. Strip ALL such flags.
  return `#!/bin/bash\nargs=()\nwhile (($#)); do\ncase "$1" in\n--mcp-config) shift; (($#)) || exit 2 ;;\n--mcp-config=*) ;;\n--strict-mcp-config) ;;\n*) args+=("$1") ;;\nesac\nshift\ndone\nexec ${shellQuote(binary)} --strict-mcp-config --mcp-config ${shellQuote(config)} "\${args[@]}"\n`;
}
export async function startTarget(input) {
  const opts = targetOptions(input);
  const { deriveRoleColumnIndex } = await import("../../dist/layout-policy.js");
  const { agentProcessLiveness } = await import("../../dist/util/pid-alive.js");
  if (opts.host === "m1" && hostname() !== opts.gateHost) throw new Error("SSH target hostname mismatch");
  const harness = privateBuild(opts.driverRoot, opts.driverSha);
  opts.outputRoot = join(harness.root, "evidence");
  const before = productionSnapshot(homedir());
  const runtime = await startSoakRuntime({ ...opts, launcherMode: opts.target === "m1-gate", entry: opts.buildRoot ? `${opts.buildRoot}/dist/entry.js` : INSTALLED_ENTRY }, opts.outputRoot);
  const client = new Client({ name: "xmac-under-test", version: "1.1" });
  const socket = (method, params = {}) => rpc(runtime.env.CMUX_SOCKET_PATH, method, { workspace_id: runtime.workspace, ...params });
  const agents = new Map(), leads = new Set(), owned = new Set();
  const defaults = { repo: opts.repo ?? "soak", cwd: runtime.cwd, workspace: runtime.workspace };
  let finished;
  const call = async (name, args = {}) => {
    if (name === "spawn_agent") {
      if (args.resume_agent_id && !args.cli) args = { ...args, cli: (await inspect(args.resume_agent_id))?.cli };
      args = boundedSpawn(args, defaults);
    }
    if (name === "close_surface" && args.agent_id && !agents.has(args.agent_id)) {
      const child = await inspect(args.agent_id);
      if (child?.surface_id) { owned.add(args.agent_id); agents.set(args.agent_id, { surface: child.surface_uuid ?? child.surface_id }); }
    }
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 });
    const value = result.structuredContent ?? (() => { try { return unwrap(result); } catch { return {}; } })();
    if (name === "spawn_agent" && value.agent_id) {
      owned.add(value.agent_id);
      agents.set(value.agent_id, { surface: value.surface_uuid ?? value.surface_id });
    }
    return result;
  };
  const inspect = async id => unwrap(await call("list_agents", { agent_ids: [id], detail: "full" })).agents?.[0];
  const surfaceList = async () => {
    const value = await socket("surface.list");
    if (!Array.isArray(value.surfaces)) throw new Error("raw surface enumeration incomplete");
    return value.surfaces;
  };
  const sweepChildren = async () => {
    const receipts = [], errors = [];
    for (const parent of leads) {
      try {
        const listed = unwrap(await call("list_agents", { parent_agent_id: parent, detail: "full" }));
        if (!Array.isArray(listed.agents)) throw new Error("child enumeration failed");
        for (const child of listed.agents.filter(child => child.parent_agent_id === parent)) {
          owned.add(child.agent_id); agents.set(child.agent_id, { surface: child.surface_uuid ?? child.surface_id });
          receipts.push(unwrap(await call("close_surface", { agent_id: child.agent_id, scope: "agent", force: true })));
          if (!await driver.verifyClosed(child.agent_id)) throw new Error("child close unverified");
        }
      } catch (error) { errors.push(String(error)); }
    }
    if (errors.length) {
      // This entire workspace was created by this run; never sweep another one.
      for (const surface of await surfaceList()) await socket("surface.close", { surface_id: surface.id ?? surface.ref });
      if ((await surfaceList()).length) throw new Error("fallback surface sweep failed");
    }
    return { receipts, enumeration_errors: errors, fallback: errors.length > 0 };
  };
  const driver = {
    target: { host: opts.host, cmux: opts.cmux === "prod" ? "prod-0.64.22" : "nightly", cmuxVersion: runtime.receipt.app_target.version,
      cmuxlayerSha: opts.sha, codexWrapper: opts.cmux === "nightly" && existsSync(join(opts.app, "Contents/Resources/bin/codex")) ? join(opts.app, "Contents/Resources/bin/codex") : null },
    call, sweepChildren,
    spawnLeadSeat: async args => {
      if (!runtime.receipt.private_mcp_config) throw new Error("lead private MCP config missing");
      const result = await call("spawn_agent", { ...args, cli: "claude", model: "haiku", authority: "lead", role: "implementor", placement: "left" });
      const value = result.structuredContent ?? unwrap(result);
      if (value.agent_id) leads.add(value.agent_id);
      return result;
    },
    readScreen: async surface => {
      const raw = await socket("surface.read_text", { surface_id: surface });
      const { panes } = await socket("pane.list"), columns = deriveRoleColumnIndex(panes);
      const pane = panes.find(pane => [...pane.surface_refs, ...(pane.surface_ids ?? [])].includes(surface));
      return { text: raw.text, column: pane ? columns.get(pane.ref) ?? null : null, column_count: new Set(columns.values()).size };
    },
    focusedSurface: async () => {
      const focused = (await socket("system.identify")).focused?.surface_ref;
      if (!focused) throw new Error("focused surface missing");
      return focused;
    },
    processArgs: async id => {
      const agent = JSON.parse(readFileSync(join(runtime.env.CMUXLAYER_STATE_DIR, id, "state.json"), "utf8"));
      if (agentProcessLiveness(agent) !== "alive") throw new Error("agent PID identity unverified");
      const args = execFileSync("ps", ["-ww", "-p", String(agent.pid), "-o", "args="], { encoding: "utf8", timeout: 2000 }).trim();
      const executable = execFileSync("ps", ["-p", String(agent.pid), "-o", "comm="], { encoding: "utf8", timeout: 2000 }).trim();
      if (!new RegExp(`/(?:${agent.cli})(?:$|[-.])`).test(executable)) throw new Error("recorded pane child is not the CLI process");
      return args;
    },
    verifyClosed: async id => {
      const known = agents.get(id);
      if (!known?.surface) throw new Error("closed seat surface identity missing");
      const listed = await surfaceList();
      return !listed.some(row => [row.id, row.ref].includes(known.surface));
    },
    close: () => finished ??= (async () => {
      const errors = [];
      try { await sweepChildren(); } catch (error) { errors.push(String(error)); }
      try {
        for (const surface of await surfaceList()) await socket("surface.close", { surface_id: surface.id ?? surface.ref });
      } catch (error) { errors.push(String(error)); }
      try { await client.close(); } catch (error) { errors.push(String(error)); }
      const lifecycle = await runtime.close();
      const reads = []; let changes = [];
      try { changes = productionChanges(before, productionSnapshot(homedir()), [runtime.receipt.launch_token, runtime.env.CMUXLAYER_DAEMON_SOCKET, runtime.env.CMUX_SOCKET_PATH, runtime.receipt.scratch, ...owned], [...owned], reads); }
      catch (error) { errors.push(`attribution guard: ${error}`); }
      lifecycle.attribution = { changes, reads, private_socket: runtime.env.CMUXLAYER_DAEMON_SOCKET };
      lifecycle.violations.push(...errors, ...changes.map(path => `production attribution: ${path}`));
      if (lifecycle.violations.length) lifecycle.status = "FAIL";
      writeFileSync(runtime.receiptPath, JSON.stringify(lifecycle, null, 2) + "\n");
      return lifecycle;
    })(),
  };
  try {
    const bin = join(runtime.receipt.scratch, "bin"); mkdirSync(bin, { mode: 0o700 });
    const config = join(runtime.receipt.scratch, "private-mcp.json");
    const routing = Object.fromEntries(Object.entries(runtime.env).filter(([key]) => /^(CMUXLAYER|CMUX_SOCKET|CMUX_BUNDLE|CMUX_ALLOW|CODEX_HOME|CLAUDE_CONFIG_DIR)/.test(key)));
    routing.XMAC_ENTRY = opts.buildRoot ? `${opts.buildRoot}/dist/entry.js` : INSTALLED_ENTRY;
    routing.XMAC_DEFAULTS = JSON.stringify(defaults);
    writeFileSync(config, JSON.stringify({ mcpServers: { cmuxlayer: { command: "/opt/homebrew/opt/node/bin/node", args: [`${opts.driverRoot}/scripts/xmac/lead-proxy.mjs`], env: routing } } }), { mode: 0o600 });
    const binary = join(homedir(), ".local/bin/claude");
    if (!existsSync(binary)) throw new Error("target Claude binary missing");
    writeFileSync(join(bin, "claude"), claudeWrapper(binary, config), { mode: 0o700 });
    runtime.env.PATH = `${bin}:${runtime.env.PATH}`;
    // App is already running, but no model seat has been launched. Update only its private zsh startup.
    const zshenv = join(runtime.env.ZDOTDIR, ".zshenv");
    writeFileSync(zshenv, readFileSync(zshenv, "utf8") + `\nexport PATH=${shellQuote(runtime.env.PATH)}\n`, { mode: 0o600 });
    runtime.receipt.private_mcp_config = config;
    const entry = routing.XMAC_ENTRY, privateEntry = !!opts.buildRoot;
    await client.connect(new StdioClientTransport({ command: privateEntry ? "/opt/homebrew/opt/node/bin/node" : entry, args: privateEntry ? [entry] : [], env: runtime.env, stderr: "inherit" }));
    const health = unwrap(await call("control_health", { detail: "full" }));
    if (!health.ok || health.health?.current_process?.pid !== runtime.receipt.daemon.pid || health.socket_path !== runtime.env.CMUX_SOCKET_PATH) throw new Error("private daemon control identity mismatch");
    runtime.receipt.control_health = health;
    // Execute a model-free command inside the actual app-created pane, preserving its real PATH.
    const marker = `XMAC_CODEX_${runtime.receipt.launch_token}:`;
    const probe = await socket("workspace.create", { cwd: runtime.cwd,
      initial_command: `/bin/zsh -lc ${shellQuote(`printf '%s%s\\n' ${shellQuote(marker)} "$(command -v codex)"; exec /bin/cat`)}` });
    try {
      for (let attempt = 0; attempt < 30; attempt++) {
        const text = (await rpc(runtime.env.CMUX_SOCKET_PATH, "surface.read_text", { workspace_id: probe.workspace_id, surface_id: probe.surface_id })).text;
        const resolved = text?.split("\n").find(line => line.startsWith(marker))?.slice(marker.length).trim();
        if (resolved) { runtime.receipt.resolved_codex = resolved; runtime.receipt.codex_probe_screen = text; break; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!runtime.receipt.resolved_codex?.startsWith("/")) throw new Error("pane Codex resolution probe missing");
      if (driver.target.codexWrapper && runtime.receipt.resolved_codex !== driver.target.codexWrapper) throw new Error("bundle Codex wrapper is not first on pane PATH");
    } finally { await rpc(runtime.env.CMUX_SOCKET_PATH, "workspace.close", { workspace_id: probe.workspace_id }); }
    return driver;
  } catch (error) { await driver.close(); throw error; }
}
