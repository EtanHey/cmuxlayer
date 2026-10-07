import { readFileSync } from "node:fs";
import { join } from "node:path";
import { requireLauncherMode } from "./target.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { boundedSpawn, checkCliAuth } from "./target-client.mjs";
import { captureSpawnIdentity } from "./resume-identity.mjs";
import { unwrap } from "./ctx.mjs";

const client = new Client({ name: "xmac-private-lead", version: "1.1" });
const entry = process.env.XMAC_ENTRY, defaults = JSON.parse(process.env.XMAC_DEFAULTS);
if (!process.env.CMUXLAYER_DAEMON_SOCKET || !process.env.CMUXLAYER_STATE_DIR || !process.env.CMUXLAYER_INBOX_BASE_DIR) throw new Error("lead private routing missing");
const replay = entry.endsWith("/dist/index.js");
await client.connect(new StdioClientTransport({ command: replay ? process.execPath : entry, args: replay ? [entry] : [], env: process.env, stderr: "inherit" }));
const server = new Server({ name: "xmac-private-lead", version: "1.1" }, { capabilities: { tools: {} } });
const identities = new Map();
const allowed = new Set(["spawn_agent", "list_agents", "send_to", "read_screen", "close_surface"]);
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: (await client.listTools()).tools.filter(tool => allowed.has(tool.name)) }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name } = request.params;
  if (!allowed.has(name)) throw new Error("tool outside scenario lead scope");
  const args = name === "spawn_agent" ? boundedSpawn(request.params.arguments ?? {}, defaults, identities) : request.params.arguments;
  if (name === "spawn_agent") checkCliAuth(args.resume_agent_id ? identities.get(args.resume_agent_id).cli : args.cli, process.env);
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 });
  if (name === "spawn_agent" && !args.resume_agent_id && !result.isError) await captureSpawnIdentity(identities, unwrap(result), async id =>
    unwrap(await client.callTool({ name: "list_agents", arguments: { agent_ids: [id], detail: "full" } }, undefined, { timeout: 90_000 })).agents?.find(agent => agent.agent_id === id));
  if (name === "spawn_agent" && process.env.XMAC_EXPECTED_LAUNCHERS && result.structuredContent?.agent_id) {
    requireLauncherMode(JSON.parse(readFileSync(join(process.env.CMUXLAYER_STATE_DIR, result.structuredContent.agent_id, "state.json"), "utf8")), JSON.parse(process.env.XMAC_EXPECTED_LAUNCHERS)[args.resume_agent_id ? identities.get(args.resume_agent_id).cli : args.cli]);
  }
  return result;
});
await server.connect(new StdioServerTransport());
process.stdin.on("end", () => { void client.close(); });
