import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, PUBLIC_TOOL_NAMES } from "../../src/server.js";
import { buildSpawnToolReturn } from "../../src/spawn-response.js";

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
  registeredTools[toolName]!.handler = async () => {
    const partialSpawn =
      toolName === "spawn_agent"
        ? buildSpawnToolReturn({
            spawn_state: "boot_unsubmitted",
            agent_id: "cmuxlayerCodex-test",
            surface_id: "surface:test",
            workspace_id: "workspace:test",
            delivered_chars: 42,
            boot_prompt_receipt: {
              typed: true,
              submit_attempted: true,
              submit_verified: false,
            },
          }).structuredContent
        : {};
    return {
      content: [
        {
          type: "text",
          text:
            toolName === "spawn_agent"
              ? "spawn_state: boot_unsubmitted"
              : `${toolName} ok`,
        },
      ],
      structuredContent: {
        ok: true,
        retry_count: 0,
        stdio_contract_probe: toolName,
        ...partialSpawn,
      },
    };
  };
}

await server.connect(new StdioServerTransport());
