import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { installToolRegistration } from "../src/mcp/registration.js";

const text = (value: string) => ({
  content: [{ type: "text" as const, text: value }],
});

function install(exposeInternalToolsForTests: boolean) {
  const server = new McpServer({ name: "registration-test", version: "0.0.0" });
  const registration = installToolRegistration(server, {
    client: {},
    palette: null,
    exposeInternalToolsForTests,
    resolveCallerAgentId: () => null,
  });
  const tool = (server as unknown as { tool: (...args: unknown[]) => unknown })
    .tool;
  tool("internal_probe", "internal", async () => text("internal"));
  tool("read_screen", "public", async () => text("public"));
  const registered = (
    server as unknown as { _registeredTools: Record<string, unknown> }
  )._registeredTools;
  return { registration, registered };
}

describe("installToolRegistration (mcp/registration.ts)", () => {
  it("hides non-public tools from the MCP surface but keeps their handlers dispatchable", async () => {
    const { registration, registered } = install(false);
    expect(Object.keys(registered)).toEqual(["read_screen"]);
    const handler = registration.toolHandlersByName.get("internal_probe");
    expect(handler).toBeTypeOf("function");
    const result = await handler!({}, {});
    expect(result.content[0]).toEqual({ type: "text", text: "internal" });
  });

  it("registers non-public tools only when exposeInternalToolsForTests is set", () => {
    const { registered } = install(true);
    expect(Object.keys(registered).sort()).toEqual([
      "internal_probe",
      "read_screen",
    ]);
  });

  it("tracks public handlers by name as well", () => {
    const { registration } = install(false);
    expect([...registration.toolHandlersByName.keys()].sort()).toEqual([
      "internal_probe",
      "read_screen",
    ]);
  });
});
