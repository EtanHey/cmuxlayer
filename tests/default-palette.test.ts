import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../src/server.js";
import { REGISTERED_TOOL_NAMES } from "../src/palette.js";

const ENV_KEY = "CMUXLAYER_DEFAULT_PALETTE";
const originalEnv = process.env[ENV_KEY];
const RATIFIED_TOOL_SURFACE = [
  "close_surface",
  "control_health",
  "list_agents",
  "list_surfaces",
  "read_screen",
  "report_to_parent",
  "send_to",
  "spawn_agent",
  "update_surface",
  "wait_for",
] as const;
afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = originalEnv;
  }
  vi.restoreAllMocks();
});

async function connectPaletteServer(value: string) {
  process.env[ENV_KEY] = value;
  const server = createServer({
    skipAgentLifecycle: true,
    exposeInternalToolsForTests: false,
  });
  const client = new Client({ name: "palette-test", version: "0.1.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const listChanged = vi.fn();
  client.setNotificationHandler(ToolListChangedNotificationSchema, listChanged);
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server, listChanged };
}

async function closePaletteServer(
  fixture: Awaited<ReturnType<typeof connectPaletteServer>>,
) {
  await fixture.client.close();
  await fixture.server.close();
}

describe("CMUXLAYER_DEFAULT_PALETTE", () => {
  it("publishes only the ratified Phase 5 surface with an output schema per tool", async () => {
    delete process.env[ENV_KEY];
    const server = createServer({ exposeInternalToolsForTests: false });
    const client = new Client({ name: "tool-cut-test", version: "0.1.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const tools = (await client.listTools()).tools;
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        ...RATIFIED_TOOL_SURFACE,
      ]);
      for (const tool of tools) {
        expect(tool.outputSchema, tool.name).toMatchObject({ type: "object" });
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps the palette validation registry aligned with the full tool surface", async () => {
    delete process.env[ENV_KEY];
    const server = createServer({ exposeInternalToolsForTests: false });
    try {
      const registered = Object.keys(
        (server as unknown as { _registeredTools: Record<string, unknown> })
          ._registeredTools,
      ).sort();
      expect(registered).toEqual([...REGISTERED_TOOL_NAMES].sort());
    } finally {
      await server.close();
    }
  });

  it("lets the env palette override thin-core residency", async () => {
    const fixture = await connectPaletteServer(
      "update_surface,control_health,read_screen",
    );
    try {
      const listed = await fixture.client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "control_health",
        "expand_palette",
        "read_screen",
        "update_surface",
      ]);
      expect(
        listed.tools.find((tool) => tool.name === "update_surface")?._meta
          ?.defer_loading,
      ).not.toBe(true);
    } finally {
      await closePaletteServer(fixture);
    }
  });

  it("expands all eligible tools, emits list_changed, and is idempotent", async () => {
    const fixture = await connectPaletteServer(
      "list_surfaces,control_health,read_screen",
    );
    try {
      expect((await fixture.client.listTools()).tools).toHaveLength(4);

      const first = await fixture.client.callTool({
        name: "expand_palette",
        arguments: {},
      });
      expect(first.structuredContent).toMatchObject({
        ok: true,
        expanded: true,
      });
      const expandedTools = (await fixture.client.listTools()).tools;
      expect(expandedTools.map((tool) => tool.name).sort()).toEqual([
        "close_surface",
        "control_health",
        "expand_palette",
        "list_surfaces",
        "read_screen",
        "update_surface",
      ]);
      expect(
        expandedTools.find((tool) => tool.name === "update_surface")
          ?.outputSchema,
      ).toMatchObject({ type: "object" });
      expect(fixture.listChanged).toHaveBeenCalledTimes(1);

      const notificationCount = fixture.listChanged.mock.calls.length;
      const second = await fixture.client.callTool({
        name: "expand_palette",
        arguments: {},
      });
      expect(second.structuredContent).toMatchObject({
        ok: true,
        expanded: false,
        already_expanded: true,
      });
      expect((await fixture.client.listTools()).tools).toHaveLength(6);
      expect(fixture.listChanged).toHaveBeenCalledTimes(notificationCount);
    } finally {
      await closePaletteServer(fixture);
    }
  });

  it.each([undefined, "", "   \t  "])(
    "uses thin-core defaults when the env is %s",
    async (value) => {
      if (value === undefined) {
        delete process.env[ENV_KEY];
      } else {
        process.env[ENV_KEY] = value;
      }
      const server = createServer({ exposeInternalToolsForTests: false });
      try {
        const names = Object.keys(
          (server as unknown as { _registeredTools: Record<string, unknown> })
            ._registeredTools,
        );
        expect(names).toHaveLength(RATIFIED_TOOL_SURFACE.length);
        expect(names).not.toContain("expand_palette");
        const tools = (
          server as unknown as {
            _registeredTools: Record<
              string,
              { _meta?: Record<string, unknown> }
            >;
          }
        )._registeredTools;
        const resident = Object.entries(tools)
          .filter(([, tool]) => tool._meta?.defer_loading !== true)
          .map(([name]) => name)
          .sort();
        expect(resident).toEqual([...RATIFIED_TOOL_SURFACE].sort());
      } finally {
        await server.close();
      }
    },
  );

  it("keeps deferred lifecycle tools skipped without crashing lifecycle setup", async () => {
    process.env[ENV_KEY] = "list_surfaces,control_health,read_screen";
    const server = createServer({ exposeInternalToolsForTests: false });
    try {
      expect(
        Object.keys(
          (
            server as unknown as {
              _registeredTools: Record<string, unknown>;
            }
          )._registeredTools,
        ).sort(),
      ).toEqual([
        "control_health",
        "expand_palette",
        "list_surfaces",
        "read_screen",
      ]);
    } finally {
      await server.close();
    }
  });

  it("warns about unknown names and keeps the valid subset", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fixture = await connectPaletteServer(
      "list_surfaces,not_a_cmux_tool,read_screen",
    );
    try {
      expect((await fixture.client.listTools()).tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "list_surfaces",
          "read_screen",
          "expand_palette",
        ]),
      );
      expect((await fixture.client.listTools()).tools).toHaveLength(3);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("not_a_cmux_tool"),
      );
    } finally {
      await closePaletteServer(fixture);
    }
  });

  it("returns the standard MCP unknown-tool error before expansion", async () => {
    const fixture = await connectPaletteServer("list_surfaces");
    try {
      const result = await fixture.client.callTool({
        name: "read_screen",
        arguments: { surface: "surface:1" },
      });
      expect(result).toMatchObject({
        isError: true,
        content: [
          {
            type: "text",
            text: "MCP error -32602: Tool read_screen not found",
          },
        ],
      });
    } finally {
      await closePaletteServer(fixture);
    }
  });
});
