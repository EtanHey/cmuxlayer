import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { installToolRegistration } from "../src/mcp/registration.js";

const text = (value: string) => ({
  content: [{ type: "text" as const, text: value }],
});

function install() {
  const server = new McpServer({ name: "registration-test", version: "0.0.0" });
  const registration = installToolRegistration(server, {
    client: {},
    palette: null,
    resolveCallerAgentId: () => null,
  });
  const tool = (server as unknown as { tool: (...args: unknown[]) => unknown })
    .tool;
  tool("read_screen", "public", async () => text("public"));
  const registered = (
    server as unknown as { _registeredTools: Record<string, unknown> }
  )._registeredTools;
  return { registration, registered };
}

describe("installToolRegistration (mcp/registration.ts)", () => {
  it("registers a tool on the MCP surface", () => {
    const { registered } = install();
    expect(Object.keys(registered)).toEqual(["read_screen"]);
  });

  // Every registration is public since CX-3 S7; the name map remains for
  // close_surface's scope=agent -> scope=surface self-dispatch.
  it("tracks the wrapped handler by name and keeps it dispatchable", async () => {
    const { registration } = install();
    const handler = registration.toolHandlersByName.get("read_screen");
    expect(handler).toBeTypeOf("function");
    const result = await handler!({}, {});
    expect(result.content[0]).toEqual({ type: "text", text: "public" });
  });
});
