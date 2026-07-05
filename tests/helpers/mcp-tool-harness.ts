import type { AgentEngine } from "../../src/agent-engine.js";

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
  _engine?: AgentEngine;
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
  const engine = getTool(server, "interact")._engine;
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
