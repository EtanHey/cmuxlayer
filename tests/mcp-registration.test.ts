import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { installToolRegistration } from "../src/mcp/registration.js";
import { ok } from "../src/mcp/tool-result.js";

const text = (value: string) => ({
  content: [{ type: "text" as const, text: value }],
});

function install(client: Record<string, unknown> = {}) {
  const server = new McpServer({ name: "registration-test", version: "0.0.0" });
  const registration = installToolRegistration(server, {
    client,
    palette: null,
    resolveCallerAgentId: () => null,
  });
  const tool = (server as unknown as { tool: (...args: unknown[]) => unknown })
    .tool;
  tool("read_screen", "public", async () => text("public"));
  const registered = (
    server as unknown as { _registeredTools: Record<string, unknown> }
  )._registeredTools;
  return { server, registration, registered };
}

describe("installToolRegistration (mcp/registration.ts)", () => {
  it("round 1 a mixed skipped batch stays lean on the registered MCP path", async () => {
    const { server, registration } = install();
    const skipped = { agent_id: "paused", skipped: "paused" };
    server.tool("send_to", "synthetic send", async () => ok({ receipts: [{ agent_id: "delivered", delivery_state: "submitted", submitted: true }, skipped] }));
    const handler = registration.toolHandlersByName.get("send_to");
    if (!handler) throw new Error("send handler missing");
    const result = await handler({ mode: "agent", text: "synthetic" }, {});
    expect(result.structuredContent?.receipts).toEqual([expect.objectContaining({ agent_id: "delivered", submitted: true }), skipped]);
    expect(result.structuredContent).not.toHaveProperty("transport");
  });
  it.each(["cli", "socket"])("round 1 lean spawn retains %s transport warnings", async mode => {
    const { server, registration } = install({ getTransportHealth: () => ({ mode, degraded: true, current_socket_path: "/tmp/synthetic.sock" }) });
    server.tool("spawn_agent", "synthetic spawn", async () => ok({ agent_id: "synthetic", warnings: ["existing"] }));
    const handler = registration.toolHandlersByName.get("spawn_agent");
    if (!handler) throw new Error("spawn handler missing");
    const result = await handler({}, {});
    expect(result.structuredContent?.warnings).toEqual(["existing", mode === "cli" ? "cli_fallback_active" : "socket_degraded"]);
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    expect(result.structuredContent).not.toHaveProperty("transport");
  });
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
