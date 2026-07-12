#!/usr/bin/env node

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type ToolPayload = Record<string, unknown>;

function requiredArg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function payload(result: Awaited<ReturnType<Client["callTool"]>>): ToolPayload {
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent as ToolPayload;
  }
  const text = result.content.find(
    (item): item is Extract<typeof item, { type: "text" }> =>
      item.type === "text",
  )?.text;
  if (!text) throw new Error("tool returned no structured or text payload");
  return JSON.parse(text) as ToolPayload;
}

async function connect(
  entry: string,
  caller?: { workspace: string; surface: string },
): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: process.cwd(),
    env: stringEnv({
      ...process.env,
      CMUXLAYER_DEV: "1",
      CMUXLAYER_FORCE_INPROCESS: "1",
      ...(caller
        ? {
            CMUX_WORKSPACE_ID: caller.workspace,
            CMUX_SURFACE_ID: caller.surface,
          }
        : {}),
    }),
    stderr: "inherit",
  });
  const client = new Client({
    name: "cmuxlayer-live-worker-placement-repro",
    version: "1",
  });
  await client.connect(transport);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolPayload> {
  const result = await client.callTool(
    { name, arguments: args },
    undefined,
    { timeout: 30_000 },
  );
  const parsed = payload(result);
  if (parsed.ok !== true) {
    throw new Error(`${name} failed: ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

function surfacesIn(
  topology: ToolPayload,
  workspace: string,
): Array<Record<string, unknown>> {
  const surfaces = Array.isArray(topology.surfaces) ? topology.surfaces : [];
  return surfaces.filter(
    (surface): surface is Record<string, unknown> =>
      typeof surface === "object" &&
      surface !== null &&
      surface.workspace_ref === workspace,
  );
}

async function main(): Promise<void> {
  const entry = resolve(requiredArg("--entry"));
  if (!existsSync(entry)) throw new Error(`entry does not exist: ${entry}`);
  if (!process.env.CMUX_SOCKET_PATH) {
    throw new Error("CMUX_SOCKET_PATH must pin the real cmux instance");
  }

  const cleanup: Array<{ surface: string; workspace: string }> = [];
  let cleanupSink: { pane: string; workspace: string } | null = null;
  let setupClient: Client | null = null;
  let callerClient: Client | null = null;
  let receipt: Record<string, unknown> | null = null;
  try {
    setupClient = await connect(entry);
    const baseline = await call(setupClient, "list_surfaces", {});
    const baselineSurface = Array.isArray(baseline.surfaces)
      ? baseline.surfaces.find(
          (surface): surface is Record<string, unknown> =>
            typeof surface === "object" &&
            surface !== null &&
            typeof surface.pane_ref === "string" &&
            typeof surface.workspace_ref === "string",
        )
      : undefined;
    if (baselineSurface) {
      cleanupSink = {
        pane: String(baselineSurface.pane_ref),
        workspace: String(baselineSurface.workspace_ref),
      };
    }
    const occupiedWorkspaces = new Set(
      (Array.isArray(baseline.surfaces) ? baseline.surfaces : []).flatMap(
        (surface) =>
          typeof surface === "object" &&
          surface !== null &&
          typeof surface.workspace_ref === "string"
            ? [surface.workspace_ref]
            : [],
      ),
    );
    const reusableWorkspace = (
      Array.isArray(baseline.workspaces) ? baseline.workspaces : []
    ).find(
      (workspace): workspace is Record<string, unknown> =>
        typeof workspace === "object" &&
        workspace !== null &&
        typeof workspace.ref === "string" &&
        typeof workspace.title === "string" &&
        workspace.title.startsWith("placement-reopen-") &&
        !occupiedWorkspaces.has(workspace.ref),
    );
    const workspace = reusableWorkspace && cleanupSink
      ? String(reusableWorkspace.ref)
      : String(
          (
            await call(setupClient, "create_workspace", {
              title: `placement-reopen-${process.pid}`,
            })
          ).workspace,
        );
    let initial = surfacesIn(
      await call(setupClient, "list_surfaces", {}),
      workspace,
    )[0];
    if (!initial) {
      if (!cleanupSink) {
        throw new Error("cannot seed an empty fixture workspace without a sink pane");
      }
      const seeded = await call(setupClient, "new_surface", {
        pane: cleanupSink.pane,
        workspace: cleanupSink.workspace,
        title: "placement-fixture-left-shell",
      });
      const moved = await call(setupClient, "move_surface", {
        surface: seeded.surface,
        workspace,
        focus: true,
      });
      initial = {
        ref: moved.surface,
        pane_ref: moved.pane,
      };
    }
    const initialSurface = String(initial.ref);
    const leftPane = String(initial.pane_ref);
    cleanup.push({ surface: initialSurface, workspace });
    await call(setupClient, "rename_tab", {
      surface: initialSurface,
      workspace,
      title: "placement-fixture-leftClaude",
    });

    const right = await call(setupClient, "new_split", {
      direction: "right",
      workspace,
      surface: initialSurface,
      title: "placement-fixture-right-shell",
    });
    const rightSurface = String(right.surface);
    cleanup.unshift({ surface: rightSurface, workspace });
    await call(setupClient, "rename_tab", {
      surface: rightSurface,
      workspace,
      title: "placement-fixture-rightClaude",
    });

    const caller = await call(setupClient, "new_surface", {
      pane: leftPane,
      workspace,
      title: "placement-fixture-callerClaude",
    });
    const callerSurface = String(caller.surface);
    cleanup.unshift({ surface: callerSurface, workspace });
    callerClient = await connect(entry, {
      workspace,
      surface: callerSurface,
    });
    await setupClient.close();
    setupClient = null;
    const before = await call(callerClient, "list_surfaces", {});
    const spawn = await call(callerClient, "new_split", {
      direction: "right",
      workspace,
      role: "worker",
      title: "placement-reopen-live-worker",
    });
    const workerSurface = String(spawn.surface);
    cleanup.unshift({ surface: workerSurface, workspace });
    const after = await call(callerClient, "list_surfaces", {});
    const worker = surfacesIn(after, workspace).find(
      (surface) => surface.ref === workerSurface,
    );
    if (!worker) throw new Error("spawned worker missing from immediate topology");

    const callerColumn = surfacesIn(before, workspace).find(
      (surface) => surface.ref === callerSurface,
    )?.column;
    const workerColumn = worker.column;
    if (
      typeof callerColumn !== "number" ||
      typeof workerColumn !== "number"
    ) {
      throw new Error("caller or worker topology is missing a numeric column");
    }
    const passed = workerColumn === callerColumn + 1;

    receipt = {
      entry,
      workspace,
      caller_surface: callerSurface,
      caller_column: callerColumn,
      column_count_before: before.column_count,
      spawn,
      worker_surface: workerSurface,
      worker_column_at_spawn: workerColumn,
      passed,
    };
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    if (!passed) {
      throw new Error(
        `worker landed in column ${workerColumn}; expected ${callerColumn + 1}`,
      );
    }
  } finally {
    const cleanupClient = callerClient ?? setupClient;
    if (cleanupClient) {
      for (const target of cleanup) {
        try {
          await call(cleanupClient, "close_surface", target);
        } catch (closeError) {
          if (!cleanupSink) {
            console.error("surface cleanup failed", target, closeError);
            process.exitCode = 1;
            continue;
          }
          try {
            await call(cleanupClient, "move_surface", {
              surface: target.surface,
              pane: cleanupSink.pane,
              workspace: cleanupSink.workspace,
              focus: false,
            });
            await call(cleanupClient, "close_surface", {
              surface: target.surface,
              workspace: cleanupSink.workspace,
            });
          } catch (fallbackError) {
            console.error("fallback cleanup failed", target, fallbackError);
            process.exitCode = 1;
          }
        }
      }
      await cleanupClient.close().catch((error) => {
        console.error("cleanup client close failed", error);
        process.exitCode = 1;
      });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
