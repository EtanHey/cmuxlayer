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
  sessionIdentityResolver: () => null,
});

const registeredTools = (
  server as unknown as {
    _registeredTools: Record<
      string,
      {
        handler: (args: { verbose?: boolean; type?: string }) => Promise<{
          content: Array<{ type: "text"; text: string }>;
          structuredContent: Record<string, unknown>;
        }>;
      }
    >;
  }
)._registeredTools;

for (const toolName of PUBLIC_TOOL_NAMES) {
  registeredTools[toolName]!.handler = async (args) => {
    if (toolName === "spawn_agent") {
      return buildSpawnToolReturn(args.type === "terminal"
        ? { retry_count: 0, type: "terminal", surface_id: "surface:test" }
        : { retry_count: 0, spawn_state: "boot_unsubmitted",
            agent_id: "cmuxlayerCodex-test", surface_id: "surface:test",
            workspace_id: "workspace:test", delivered_chars: 42,
            contract_path: "/tmp/synthetic-contract.md",
            report_path: "/tmp/synthetic-report.md", done_marker: "DONE_SYNTHETIC",
            boot_prompt_receipt: { typed: true, submit_attempted: true,
              submit_verified: false } }, args.verbose);
    }
    return {
      content: [{ type: "text", text: `${toolName} ok` }],
      structuredContent: { ok: true, retry_count: 0, stdio_contract_probe: toolName },
    };
  };
}

await server.connect(new StdioServerTransport());
