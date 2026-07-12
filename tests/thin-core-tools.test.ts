import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createServer } from "../src/server.js";
import type { ExecFn } from "../src/cmux-client.js";

const CORE_TOOL_NAMES = [
  "spawn_agent",
  "send_to",
  "wait_for",
  "read_screen",
  "my_agents",
  "list_agents",
  "broadcast",
  "close_surface",
  "dispatch_to_agent",
  "list_surfaces",
  "control_health",
  "stop_agent",
] as const;

// The signed-off prose says 9 legacy names, but its exhaustive mapping names 8.
const LEGACY_TOOL_NAMES = [
  "send_to_agent",
  "send_input",
  "send_command",
  "send_key",
  "new_worktree_split",
  "spawn_in_workspace",
  "new_split",
  "wait_for_all",
] as const;

function makeExec(): ExecFn {
  return vi.fn().mockImplementation(async (_cmd, args: string[]) => {
    if (args.includes("list-workspaces")) {
      return {
        stdout: JSON.stringify({
          workspaces: [
            {
              ref: "workspace:1",
              title: "Thin core",
              index: 0,
              selected: true,
              pinned: false,
            },
          ],
        }),
        stderr: "",
      };
    }
    if (args.includes("list-panes")) {
      return {
        stdout: JSON.stringify({
          panes: [
            {
              ref: "pane:1",
              workspace: "workspace:1",
              focused: true,
            },
          ],
        }),
        stderr: "",
      };
    }
    if (args.includes("list-pane-surfaces")) {
      return {
        stdout: JSON.stringify({
          pane: "pane:1",
          surfaces: [
            {
              ref: "surface:1",
              pane: "pane:1",
              workspace: "workspace:1",
              title: "unregistered shell",
              type: "terminal",
              selected: true,
            },
          ],
        }),
        stderr: "",
      };
    }
    if (args.includes("read-screen")) {
      return {
        stdout: JSON.stringify({
          surface: "surface:1",
          text: "$ ",
          lines: 20,
          scrollback_used: false,
        }),
        stderr: "",
      };
    }
    return { stdout: "{}", stderr: "" };
  });
}

function parseResult(result: {
  structuredContent?: Record<string, unknown>;
  content: Array<{ text: string }>;
}): Record<string, unknown> {
  return (
    result.structuredContent ?? JSON.parse(result.content[0]?.text ?? "{}")
  );
}

describe("thin-core tool palette", () => {
  it("lists exactly 12 signed core tools, defers interact, and deletes reorder_surface", () => {
    const server = createServer({
      exec: makeExec(),
      disableSpawnPreflight: true,
      controlHealthIntervalMs: 0,
    }) as any;
    const tools = server._registeredTools as Record<
      string,
      { _meta?: Record<string, unknown>; handler?: unknown }
    >;

    expect(Object.keys(tools)).toHaveLength(42);
    expect(tools.reorder_surface).toBeUndefined();
    const immediate = Object.entries(tools)
      .filter(([, tool]) => tool._meta?.defer_loading !== true)
      .map(([name]) => name)
      .sort();
    expect(immediate).toEqual([...CORE_TOOL_NAMES].sort());
    expect(tools.interact?._meta).toMatchObject({
      defer_loading: true,
      "cmuxlayer/interim": true,
    });

    for (const [name, tool] of Object.entries(tools)) {
      if (!CORE_TOOL_NAMES.includes(name as (typeof CORE_TOOL_NAMES)[number])) {
        expect(tool._meta, `${name} must be ToolSearch-deferred`).toMatchObject({
          defer_loading: true,
          "cmuxlayer/interim": true,
        });
      }
      expect(tool.handler, `${name} remains callable`).toBeTypeOf("function");
    }
  });

  it("marks all one-release legacy aliases as deferred deprecations", () => {
    const server = createServer({
      exec: makeExec(),
      disableSpawnPreflight: true,
      controlHealthIntervalMs: 0,
    }) as any;
    const tools = server._registeredTools as Record<
      string,
      { _meta?: Record<string, unknown> }
    >;

    for (const name of LEGACY_TOOL_NAMES) {
      expect(tools[name]?._meta).toMatchObject({
        defer_loading: true,
        deprecated: true,
        "cmuxlayer/interim": true,
      });
    }
  });
});

describe("send_to consolidated modes", () => {
  it("keeps raw modes callable when an env palette defers their legacy handlers", async () => {
    const exec = makeExec();
    const server = createServer({
      exec,
      defaultPalette: "send_to",
      disableSpawnPreflight: true,
      controlHealthIntervalMs: 0,
    }) as any;

    expect(Object.keys(server._registeredTools).sort()).toEqual([
      "expand_palette",
      "send_to",
    ]);

    const result = await server._registeredTools.send_to.handler(
      {
        mode: "surface",
        target: "surface:1",
        text: "env override escape hatch",
        press_enter: false,
      },
      {},
    );

    expect(result.isError).toBeUndefined();
    expect(exec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["send", "--surface", "surface:1"]),
    );
  });

  it("delivers to a raw surface ref with no registry entry", async () => {
    const exec = makeExec();
    const server = createServer({
      exec,
      disableSpawnPreflight: true,
      controlHealthIntervalMs: 0,
    }) as any;
    const sendTo = server._registeredTools.send_to;

    const result = await sendTo.handler(
      {
        mode: "surface",
        target: "surface:1",
        text: "fleet escape hatch",
        press_enter: false,
      },
      {},
    );

    expect(result.isError).toBeUndefined();
    expect(parseResult(result)).toMatchObject({ ok: true, surface: "surface:1" });
    expect(exec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["send", "--surface", "surface:1"]),
    );
  });

  it("routes command mode through atomic raw-surface command delivery", async () => {
    const exec = makeExec();
    const server = createServer({ exec, controlHealthIntervalMs: 0 }) as any;

    const result = await server._registeredTools.send_to.handler(
      {
        mode: "command",
        target: "surface:1",
        command: "pwd",
      },
      {},
    );

    expect(result.isError).toBeUndefined();
    expect(exec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["send", "--surface", "surface:1", "pwd"]),
    );
  });

  it("routes key mode through raw-surface key delivery", async () => {
    const exec = makeExec();
    const server = createServer({ exec, controlHealthIntervalMs: 0 }) as any;

    const result = await server._registeredTools.send_to.handler(
      { mode: "key", surface: "surface:1", key: "escape" },
      {},
    );

    expect(result.isError).toBeUndefined();
    expect(exec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["send-key", "--surface", "surface:1", "escape"]),
    );
  });
});

describe("consolidated compatibility", () => {
  it("wait_for accepts ids and uses the multi-agent wait path", async () => {
    const server = createServer({
      exec: makeExec(),
      disableSpawnPreflight: true,
      controlHealthIntervalMs: 0,
    }) as any;
    const engine = server._registeredTools.interact._engine;
    const waitForAll = vi.spyOn(engine, "waitForAll").mockResolvedValue([]);

    const result = await server._registeredTools.wait_for.handler(
      { ids: ["agent-a", "agent-b"], target_state: "done", timeout_ms: 1234 },
      {},
    );

    expect(result.isError).toBeUndefined();
    expect(waitForAll).toHaveBeenCalledWith(
      ["agent-a", "agent-b"],
      "done",
      1234,
    );
    expect(parseResult(result)).toMatchObject({ ok: true, results: [] });
  });

  it("legacy aliases emit a runtime deprecation warning", async () => {
    const server = createServer({
      exec: makeExec(),
      disableSpawnPreflight: true,
      controlHealthIntervalMs: 0,
    }) as any;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await server._registeredTools.send_input.handler(
      { surface: "surface:1", text: "legacy", press_enter: false },
      {},
    );

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("send_input is deprecated"),
    );
    expect(parseResult(result)).toMatchObject({
      deprecation_warning: expect.stringContaining("send_to(mode=surface)"),
    });
    warn.mockRestore();
  });
});

describe("legacy-name drift", () => {
  it("keeps active operator docs on the consolidated verbs", () => {
    const activeDocs = [
      "../docs/agent-routing-and-handling.md",
      "../docs/metacommlayer-inbox.md",
      "../docs/inbox-hook-transport.md",
    ];
    const legacyName =
      /\b(send_to_agent|send_input|send_command|send_key|new_worktree_split|spawn_in_workspace|new_split|wait_for_all)\b/;

    for (const relativePath of activeDocs) {
      const body = readFileSync(new URL(relativePath, import.meta.url), "utf8");
      expect(body, `${relativePath} contains a retired tool name`).not.toMatch(
        legacyName,
      );
    }
  });
});
