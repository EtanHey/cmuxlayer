import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_TOOL_NAMES } from "../src/server.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/public-output-schema-stdio-server.ts", import.meta.url),
);
const testDirs: string[] = [];

afterEach(() => {
  for (const testDir of testDirs.splice(0)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

const validArguments: Record<string, Record<string, unknown>> = {
  spawn_agent: { type: "terminal" },
  send_to: {
    mode: "surface",
    surface: "surface:test",
    text: "schema probe",
    press_enter: false,
  },
  read_screen: { surface: "surface:test" },
  list_agents: {},
  wait_for: { ids: ["cmuxlayerCodex-test"] },
  control_health: {},
  close_surface: { surface: "surface:test" },
  update_surface: {
    action: "rename",
    surface: "surface:test",
    title: "schema probe",
  },
  list_surfaces: {},
};

describe("public tool output schemas over stdio", () => {
  it("accepts passthrough receipts from all nine tools after listTools caches Ajv validators", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "cmuxlayer-output-schema-"));
    testDirs.push(testDir);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", fixturePath],
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        CMUXLAYER_TEST_STATE_DIR: join(testDir, "state"),
        VITEST: "true",
      },
      stderr: "pipe",
    });
    const client = new Client({
      name: "public-output-schema-stdio-test",
      version: "0.1.0",
    });

    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools;
      expect(tools.map((tool) => tool.name).sort()).toEqual(
        [...PUBLIC_TOOL_NAMES].sort(),
      );
      for (const tool of tools) {
        expect(tool.outputSchema, tool.name).toMatchObject({
          type: "object",
          additionalProperties: true,
        });
      }
      const declaredFields: Record<string, string[]> = {
        spawn_agent: ["type", "cwd", "title", "cwd_receipt"],
        send_to: [
          "command",
          "title",
          "model",
          "agent_type",
          "boot_prompt_delivered",
          "boot_prompt_receipt",
          "boot_prompt_bytes",
          "boot_prompt_submit_verified",
          "boot_prompt_warning",
          "registry_state",
          "screen",
          "state_conflict",
          "health",
        ],
        close_surface: [
          "state",
          "force",
          "removed",
          "pane",
          "collapse_pane",
          "refused",
          "surfaces",
          "agents",
          "live_agents",
        ],
      };
      for (const [toolName, fields] of Object.entries(declaredFields)) {
        const schema = tools.find((tool) => tool.name === toolName)
          ?.outputSchema as { properties?: Record<string, unknown> } | undefined;
        for (const field of fields) {
          expect(schema?.properties, `${toolName}.${field}`).toHaveProperty(field);
        }
      }

      for (const toolName of PUBLIC_TOOL_NAMES) {
        const result = await client.callTool({
          name: toolName,
          arguments: validArguments[toolName],
        });
        expect(result.structuredContent, toolName).toMatchObject({
          ok: true,
          retry_count: 0,
          stdio_contract_probe: toolName,
        });
      }
    } finally {
      await client.close();
    }
  });
});
