import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
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

interface AncestorProcess {
  parentPid: number;
  environment: string;
}

function readAncestorProcess(pid: number): AncestorProcess | null {
  try {
    // Read only our own process ancestry. Never log the output: `ps eww`
    // includes the ancestor's complete environment, including secrets.
    const parentPid = Number(execFileSync("ps", ["-p", String(pid), "-o", "ppid="], {
      encoding: "utf8", timeout: 500, maxBuffer: 64 * 1024,
    }).trim());
    if (!Number.isSafeInteger(parentPid) || parentPid < 1) return null;
    const environment = execFileSync("ps", ["eww", "-p", String(pid), "-o", "command="], {
      encoding: "utf8", timeout: 500, maxBuffer: 256 * 1024,
    });
    return { parentPid, environment };
  } catch {
    return null;
  }
}

/** Recover pane identity from the MCP proxy's parent when a CLI filters env. */
export function callerContextFromAncestry(
  startPid: number = process.ppid,
  readProcess: (pid: number) => AncestorProcess | null = readAncestorProcess,
): CallerContext | undefined {
  let pid = startPid;
  const seen = new Set<number>();
  for (let depth = 0; depth < 6 && pid > 1 && !seen.has(pid); depth++) {
    seen.add(pid);
    const ancestor = readProcess(pid);
    if (!ancestor) break;
    const value = (name: string): string | undefined => {
      const match = ancestor.environment.match(new RegExp(`(?:^|\\s)${name}=([A-Za-z0-9_-]+)`));
      return match?.[1];
    };
    const context: CallerContext = {
      workspaceId: value("CMUX_WORKSPACE_ID"),
      tabId: value("CMUX_TAB_ID"),
      surfaceId: value("CMUX_SURFACE_ID"),
    };
    if (context.surfaceId) return context;
    pid = ancestor.parentPid;
  }
  return undefined;
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
