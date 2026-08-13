import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, PUBLIC_TOOL_NAMES } from "../../src/server.js";

const stateDir = process.env.CMUXLAYER_TEST_STATE_DIR;
if (!stateDir) {
  throw new Error("CMUXLAYER_TEST_STATE_DIR is required");
}

const server = createServer({
  exec: async () => ({ stdout: "{}", stderr: "" }),
  stateDir,
  lifecycleInitializer: async () => {},
  disableSpawnPreflight: true,
  controlHealthIntervalMs: 0,
  exposeInternalToolsForTests: false,
  sessionIdentityResolver: () => null,
});

const registeredTools = (
  server as unknown as {
    _registeredTools: Record<
      string,
      {
        handler: () => Promise<{
          content: Array<{ type: "text"; text: string }>;
          structuredContent: Record<string, unknown>;
        }>;
      }
    >;
  }
)._registeredTools;

for (const toolName of PUBLIC_TOOL_NAMES) {
  registeredTools[toolName]!.handler = async () => ({
    content: [{ type: "text", text: `${toolName} ok` }],
    structuredContent: {
      ok: true,
      retry_count: 0,
      stdio_contract_probe: toolName,
    },
  });
}

await server.connect(new StdioServerTransport());
