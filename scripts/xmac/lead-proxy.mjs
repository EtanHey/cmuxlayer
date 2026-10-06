import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { boundedSpawn, checkCliAuth } from "./target-client.mjs";

const client = new Client({ name: "xmac-private-lead", version: "1.1" });
const entry = process.env.XMAC_ENTRY, defaults = JSON.parse(process.env.XMAC_DEFAULTS);
if (!process.env.CMUXLAYER_DAEMON_SOCKET || !process.env.CMUXLAYER_STATE_DIR || !process.env.CMUXLAYER_INBOX_BASE_DIR) throw new Error("lead private routing missing");
const replay = entry.endsWith("/dist/index.js");
await client.connect(new StdioClientTransport({ command: replay ? process.execPath : entry, args: replay ? [entry] : [], env: process.env, stderr: "inherit" }));
const server = new Server({ name: "xmac-private-lead", version: "1.1" }, { capabilities: { tools: {} } });
const allowed = new Set(["spawn_agent", "list_agents", "send_to", "read_screen", "close_surface"]);
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: (await client.listTools()).tools.filter(tool => allowed.has(tool.name)) }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name } = request.params;
  if (!allowed.has(name)) throw new Error("tool outside scenario lead scope");
  const args = name === "spawn_agent" ? boundedSpawn(request.params.arguments ?? {}, defaults) : request.params.arguments;
  if (name === "spawn_agent") checkCliAuth(args.cli, process.env);
  return client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 });
});
await server.connect(new StdioServerTransport());
process.stdin.on("end", () => { void client.close(); });
