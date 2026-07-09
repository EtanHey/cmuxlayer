import { AsyncLocalStorage } from "node:async_hooks";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export const CALLER_CONTEXT_META_KEY = "cmuxlayer/callerContext";

export interface CallerContext {
  workspaceId?: string;
  tabId?: string;
  surfaceId?: string;
}

const callerContextStore = new AsyncLocalStorage<CallerContext>();

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function hasCallerContext(
  context: CallerContext | undefined,
): context is CallerContext {
  return Boolean(context?.workspaceId || context?.tabId || context?.surfaceId);
}

export function callerContextFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CallerContext | undefined {
  const context: CallerContext = {
    workspaceId: nonEmptyString(env.CMUX_WORKSPACE_ID),
    tabId: nonEmptyString(env.CMUX_TAB_ID),
    surfaceId: nonEmptyString(env.CMUX_SURFACE_ID),
  };
  return hasCallerContext(context) ? context : undefined;
}

export function currentCallerContext(): CallerContext | undefined {
  return callerContextStore.getStore();
}

export function runWithCallerContext<T>(
  context: CallerContext | undefined,
  callback: () => T,
): T {
  if (!hasCallerContext(context)) {
    return callback();
  }
  return callerContextStore.run(context, callback);
}

function callerContextFromUnknown(value: unknown): CallerContext | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const context: CallerContext = {
    workspaceId:
      nonEmptyString(record.workspaceId) ??
      nonEmptyString(record.CMUX_WORKSPACE_ID),
    tabId: nonEmptyString(record.tabId) ?? nonEmptyString(record.CMUX_TAB_ID),
    surfaceId:
      nonEmptyString(record.surfaceId) ??
      nonEmptyString(record.CMUX_SURFACE_ID),
  };
  return hasCallerContext(context) ? context : undefined;
}

export function callerContextFromMessage(
  message: JSONRPCMessage,
): CallerContext | undefined {
  if (
    typeof message !== "object" ||
    message === null ||
    !("method" in message) ||
    message.method !== "tools/call" ||
    !("params" in message) ||
    typeof message.params !== "object" ||
    message.params === null
  ) {
    return undefined;
  }
  const params = message.params as { _meta?: Record<string, unknown> };
  const meta = params._meta;
  if (!meta) {
    return undefined;
  }
  return callerContextFromUnknown(meta[CALLER_CONTEXT_META_KEY]);
}

export function attachCallerContextToMessage<T extends JSONRPCMessage>(
  message: T,
  context: CallerContext | undefined,
): T {
  if (
    !hasCallerContext(context) ||
    typeof message !== "object" ||
    message === null ||
    !("method" in message) ||
    message.method !== "tools/call"
  ) {
    return message;
  }

  const record = message as Record<string, unknown>;
  const params =
    typeof record.params === "object" && record.params !== null
      ? { ...(record.params as Record<string, unknown>) }
      : {};
  const existingMeta =
    typeof params._meta === "object" && params._meta !== null
      ? (params._meta as Record<string, unknown>)
      : {};
  record.params = {
    ...params,
    _meta: {
      ...existingMeta,
      [CALLER_CONTEXT_META_KEY]: context,
    },
  };
  return message;
}
