import type { AgentEngine } from "../../src/agent-engine.js";
import { engineForTests } from "../../src/server.js";

export type ToolCallResult = {
  structuredContent?: unknown;
  content: Array<{ text: string }>;
  isError?: boolean;
};

export type RegisteredTool = {
  handler(
    args: Record<string, unknown>,
    extra: Record<string, unknown>,
  ): Promise<ToolCallResult>;
};

export type ServerWithRegisteredTools = {
  close?: () => Promise<void>;
  _registeredTools: Record<string, RegisteredTool | undefined>;
};

export function asToolServer(server: unknown): ServerWithRegisteredTools {
  return server as ServerWithRegisteredTools;
}

export function getTool(server: unknown, name: string): RegisteredTool {
  const tool = asToolServer(server)._registeredTools[name];
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool;
}

export function getEngine(server: unknown): AgentEngine {
  const engine = engineForTests(server);
  if (!engine) throw new Error("Lifecycle engine not registered");
  return engine;
}

function parsePayload<T>(result: ToolCallResult): T {
  return (result.structuredContent ?? JSON.parse(result.content[0]!.text)) as T;
}

export function parseToolResult<T>(result: ToolCallResult): T {
  if (result.isError) {
    throw new Error(
      result.content.map((entry) => entry.text).join("\n") ||
        "Tool returned an error",
    );
  }
  return parsePayload<T>(result);
}

export function parseErroredToolResult<T>(result: ToolCallResult): T {
  if (!result.isError) {
    throw new Error("Tool result was expected to be an error");
  }
  return parsePayload<T>(result);
}

export async function closeToolServer(server: unknown): Promise<void> {
  const close = asToolServer(server).close;
  if (!close) throw new Error("Tool server does not expose close()");
  await close();
}

/**
 * The retired get_agent_state tool's view of one agent, read through the
 * public list_agents tool at detail=full (CX-3 S8a-2): the full registry
 * record plus harvestability, health and Codex fill, or a not-found error.
 */
export function agentStateTool(server: unknown): RegisteredTool {
  return {
    async handler(args, extra) {
      const agentId = String(args.agent_id);
      const result = await getTool(server, "list_agents").handler(
        { agent_ids: [agentId], detail: "full" },
        extra,
      );
      if (result.isError) return result;
      const payload = parsePayload<{
        agents?: Array<Record<string, unknown>>;
      }>(result);
      const row = payload.agents?.find((agent) => agent.agent_id === agentId);
      if (!row) {
        const error = `Agent not found: ${agentId}`;
        return {
          isError: true,
          content: [{ text: error }],
          structuredContent: { ok: false, error },
        };
      }
      const state = {
        ok: true,
        ...(row.detail as Record<string, unknown>),
        health: row.health,
        token_count: row.token_count ?? null,
        context_window: row.context_window ?? null,
        context_pct: row.context_pct ?? null,
      };
      return {
        content: [{ text: JSON.stringify(state) }],
        structuredContent: state,
      };
    },
  };
}
