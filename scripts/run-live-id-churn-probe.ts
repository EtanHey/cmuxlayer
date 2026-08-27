#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type Payload = Record<string, any>;
type SpawnedAgent = {
  agent_id: string;
  surface_id: string;
  workspace_id: string;
};

const sleep = (ms: number) => new Promise((settle) => setTimeout(settle, ms));

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function payload(result: Awaited<ReturnType<Client["callTool"]>>): Payload {
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent as Payload;
  }
  const text = result.content.find(
    (item): item is Extract<typeof item, { type: "text" }> =>
      item.type === "text",
  )?.text;
  if (!text) throw new Error("tool returned no structured or text payload");
  try {
    return JSON.parse(text) as Payload;
  } catch {
    return { ok: false, error: text };
  }
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
    name: "cmuxlayer-live-id-churn-probe",
    version: "1",
  });
  await client.connect(transport);
  return client;
}

async function rawCall(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  timeout = 60_000,
): Promise<Payload> {
  return payload(
    await client.callTool(
      { name, arguments: args },
      undefined,
      { timeout },
    ),
  );
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  timeout = 60_000,
): Promise<Payload> {
  const result = await rawCall(client, name, args, timeout);
  if (result.ok !== true) {
    throw new Error(`${name} failed: ${JSON.stringify(result)}`);
  }
  return result;
}

function requireSpawn(result: Payload, label: string): SpawnedAgent {
  const agentId = result.agent_id;
  const surfaceId = result.surface_id;
  const workspaceId = result.workspace_id;
  if (
    typeof agentId !== "string" ||
    typeof surfaceId !== "string" ||
    typeof workspaceId !== "string"
  ) {
    throw new Error(`${label} spawn returned no identity triple: ${JSON.stringify(result)}`);
  }
  return {
    agent_id: agentId,
    surface_id: surfaceId,
    workspace_id: workspaceId,
  };
}

function trackCreatedSurface(
  result: Payload,
  fallbackWorkspace: string,
  surfaces: Map<string, string>,
): void {
  if (typeof result.surface_id !== "string") return;
  surfaces.set(
    result.surface_id,
    typeof result.workspace_id === "string"
      ? result.workspace_id
      : fallbackWorkspace,
  );
}

function readDurableState(agentId: string): Payload {
  const statePath = join(
    homedir(),
    ".local",
    "state",
    "cmux-agents",
    agentId,
    "state.json",
  );
  return JSON.parse(readFileSync(statePath, "utf8")) as Payload;
}

function assertContinuity(
  result: Payload,
  expected: {
    agentId: string;
    sessionId: string;
    parentAgentId: string;
  },
  phase: string,
): void {
  const record = result;
  const failures = [
    record.agent_id === expected.agentId
      ? null
      : `agent_id=${JSON.stringify(record.agent_id)}`,
    record.cli_session_id === expected.sessionId
      ? null
      : `cli_session_id=${JSON.stringify(record.cli_session_id)}`,
    record.parent_agent_id === expected.parentAgentId
      ? null
      : `parent_agent_id=${JSON.stringify(record.parent_agent_id)}`,
  ].filter(Boolean);
  if (failures.length > 0) {
    throw new Error(`${phase} continuity failed: ${failures.join(", ")}`);
  }
  process.stdout.write(
    `GREEN_CONTINUITY phase=${phase} agent=${expected.agentId} session=${expected.sessionId} parent=${expected.parentAgentId}\n`,
  );
}

async function waitFor(
  description: string,
  probe: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started <= timeoutMs) {
    try {
      if (await probe()) return;
      lastError = "";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(1_000);
  }
  throw new Error(
    `${description} timed out after ${timeoutMs}ms${lastError ? `: ${lastError}` : ""}`,
  );
}

function addressResolved(result: Payload): boolean {
  return (
    result.ok === true &&
    result.delivered !== false &&
    !/Agent not found/i.test(String(result.error ?? ""))
  );
}

async function main(): Promise<void> {
  const entry = resolve(process.argv[2] ?? "dist/index.js");
  if (!existsSync(entry)) throw new Error(`branch entry does not exist: ${entry}`);
  if (!process.env.CMUX_SOCKET_PATH) {
    throw new Error("CMUX_SOCKET_PATH must pin the real cmux instance");
  }
  const callerWorkspace = process.env.CMUX_WORKSPACE_ID;
  if (!callerWorkspace) {
    throw new Error("CMUX_WORKSPACE_ID is required; run from a cmux pane");
  }

  const surfaces = new Map<string, string>();
  let client: Client | null = null;
  try {
    client = await connect(entry);
    const parentResult = await rawCall(
      client,
      "spawn_agent",
      {
        repo: "cmuxlayer",
        cli: "claude",
        model: "opus",
        role: "orchestrator",
        placement: "left",
        workspace: callerWorkspace,
        force_new: true,
        focus: false,
        prompt:
          "Issue #416 live acceptance parent fixture. Do not modify files and do not spawn agents. Wait for further instructions.",
      },
      120_000,
    );
    trackCreatedSurface(parentResult, callerWorkspace, surfaces);
    if (parentResult.ok !== true) {
      throw new Error(`spawn_agent failed: ${JSON.stringify(parentResult)}`);
    }
    const parent = requireSpawn(parentResult, "parent");
    process.stdout.write(`spawned parent ${parent.agent_id} ${parent.surface_id}\n`);
    await client.close();
    client = null;

    client = await connect(entry, {
      workspace: parent.workspace_id,
      surface: parent.surface_id,
    });
    const childResult = await rawCall(
      client,
      "spawn_agent",
      {
        repo: "cmuxlayer",
        cli: "claude",
        model: "opus",
        role: "worker",
        placement: "right",
        workspace: parent.workspace_id,
        force_new: true,
        focus: false,
        parent_agent_id: parent.agent_id,
        prompt:
          "Issue #416 live acceptance fixture. Do not modify files and do not spawn agents. Immediately use AskUserQuestion with one question and two choices, then after the answer reply briefly and become idle.",
      },
      120_000,
    );
    trackCreatedSurface(childResult, parent.workspace_id, surfaces);
    if (childResult.ok !== true) {
      throw new Error(`spawn_agent failed: ${JSON.stringify(childResult)}`);
    }
    const child = requireSpawn(childResult, "child");
    process.stdout.write(`spawned child ${child.agent_id} ${child.surface_id}\n`);

    const initial = readDurableState(child.agent_id);
    const sessionId = initial.cli_session_id;
    if (typeof sessionId !== "string" || !sessionId) {
      throw new Error(`child has no cli_session_id: ${JSON.stringify(initial)}`);
    }
    assertContinuity(initial, {
      agentId: child.agent_id,
      sessionId,
      parentAgentId: parent.agent_id,
    }, "spawn");

    await waitFor(
      "interactive overlay",
      async () => {
        const screen = await call(client!, "read_screen", {
          surface: child.surface_id,
          workspace: child.workspace_id,
          lines: 80,
        });
        const parsed =
          screen.parsed && typeof screen.parsed === "object"
            ? screen.parsed
            : screen;
        return (
          parsed.control_state === "interactive_overlay" ||
          (Array.isArray(parsed.errors) &&
            parsed.errors.includes("interactive_prompt"))
        );
      },
      120_000,
    );
    process.stdout.write(`observed interactive_overlay ${child.agent_id}\n`);
    assertContinuity(
      readDurableState(child.agent_id),
      { agentId: child.agent_id, sessionId, parentAgentId: parent.agent_id },
      "overlay-frozen",
    );

    await call(client, "send_to", {
      mode: "key",
      surface: child.surface_id,
      workspace: child.workspace_id,
      text: "down",
    });
    await call(client, "send_to", {
      mode: "key",
      surface: child.surface_id,
      workspace: child.workspace_id,
      text: "return",
    });
    const afterOverlaySend = await rawCall(client, "send_to", {
      mode: "agent",
      agent_id: child.agent_id,
      text: "Issue #416 addressability check after overlay; acknowledge briefly.",
      allow_busy: true,
    });
    if (!addressResolved(afterOverlaySend)) {
      throw new Error(
        `original id failed after overlay: ${JSON.stringify(afterOverlaySend)}`,
      );
    }
    process.stdout.write(`GREEN_ADDRESS phase=overlay agent=${child.agent_id}\n`);
    assertContinuity(
      readDurableState(child.agent_id),
      { agentId: child.agent_id, sessionId, parentAgentId: parent.agent_id },
      "overlay",
    );

    await waitFor(
      "child idle after overlay",
      async () => {
        const record = readDurableState(child.agent_id);
        return record.state === "idle" || record.state === "ready";
      },
      120_000,
    );
    process.stdout.write("waiting 35s across two idle sweep intervals\n");
    await sleep(35_000);
    const afterIdleSend = await rawCall(client, "send_to", {
      mode: "agent",
      agent_id: child.agent_id,
      text: "Issue #416 addressability check after idle; acknowledge briefly.",
      allow_busy: true,
    });
    if (!addressResolved(afterIdleSend)) {
      throw new Error(`original id failed after idle: ${JSON.stringify(afterIdleSend)}`);
    }
    process.stdout.write(`GREEN_ADDRESS phase=idle agent=${child.agent_id}\n`);
    assertContinuity(
      readDurableState(child.agent_id),
      { agentId: child.agent_id, sessionId, parentAgentId: parent.agent_id },
      "idle",
    );

    await client.close();
    client = null;
    client = await connect(entry);
    const afterRestartSend = await rawCall(client, "send_to", {
      mode: "agent",
      agent_id: child.agent_id,
      text: "Issue #416 addressability check after cmuxlayer restart; acknowledge briefly.",
      allow_busy: true,
    });
    if (!addressResolved(afterRestartSend)) {
      throw new Error(
        `original id failed after restart: ${JSON.stringify(afterRestartSend)}`,
      );
    }
    process.stdout.write(`GREEN_ADDRESS phase=restart agent=${child.agent_id}\n`);
    assertContinuity(
      readDurableState(child.agent_id),
      { agentId: child.agent_id, sessionId, parentAgentId: parent.agent_id },
      "restart",
    );

    await call(client, "close_surface", {
      surface: child.surface_id,
      workspace: child.workspace_id,
      force: true,
    });
    surfaces.delete(child.surface_id);
    const deadSend = await rawCall(client, "send_to", {
      mode: "agent",
      agent_id: child.agent_id,
      text: "This send must fail because the child surface is dead.",
      allow_busy: true,
    });
    if (
      deadSend.ok === true &&
      deadSend.delivered !== false
    ) {
      throw new Error(`dead id falsely resolved: ${JSON.stringify(deadSend)}`);
    }
    process.stdout.write(
      `GREEN_DEAD_NEGATIVE agent=${child.agent_id} receipt=${JSON.stringify(deadSend)}\n`,
    );
    process.stdout.write(`GREEN_ID_CHURN agent=${child.agent_id}\n`);
  } finally {
    let cleanupClient = client;
    if (!cleanupClient && surfaces.size > 0) {
      try {
        cleanupClient = await connect(entry);
      } catch {
        // The exact surface refs remain in the failure output for manual cleanup.
      }
    }
    if (cleanupClient) {
      for (const [surface, workspace] of surfaces) {
        try {
          await rawCall(cleanupClient, "close_surface", {
            surface,
            workspace,
            force: true,
          });
        } catch {
          // Best-effort cleanup is scoped to exact surface refs created above.
        }
      }
      await cleanupClient.close();
    }
  }
}

main().catch((error) => {
  process.stderr.write(
    `RED_ID_CHURN ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
