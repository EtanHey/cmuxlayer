import { spawn } from "node:child_process";
import net from "node:net";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CreateServerOptions } from "./server.js";
import {
  CmuxLayerProxy,
  runProxy as runProxyRuntime,
  type CmuxLayerProxyOptions,
} from "./proxy.js";
import { defaultDaemonSocketPath as resolveDefaultDaemonSocketPath } from "./daemon-socket-path.js";

const DEFAULT_AUTOSTART_TIMEOUT_MS = 5_000;
const DEFAULT_AUTOSTART_POLL_MS = 50;

export { resolveDefaultDaemonSocketPath as defaultDaemonSocketPath };

export interface SpawnDaemonOptions {
  socketPath: string;
  env: NodeJS.ProcessEnv;
  daemonScriptPath?: string;
  logger: Pick<Console, "error">;
}

export interface StartInProcessOptions {
  fallbackWarnings?: string[];
}

export type EntryRuntime =
  | { mode: "daemon-proxy"; proxy: CmuxLayerProxy }
  | { mode: "in-process"; server: McpServer; fallbackWarnings: string[] };

export interface DaemonFirstEntryOptions {
  env?: NodeJS.ProcessEnv;
  input?: Readable;
  output?: Writable;
  logger?: Pick<Console, "error">;
  probeDaemon?: (socketPath: string) => Promise<boolean>;
  spawnDaemon?: (opts: SpawnDaemonOptions) => Promise<unknown> | unknown;
  runProxy?: (opts: CmuxLayerProxyOptions) => Promise<CmuxLayerProxy>;
  startInProcess?: (opts: StartInProcessOptions) => Promise<McpServer>;
  sleep?: (ms: number) => Promise<void>;
  daemonScriptPath?: string;
  autostartTimeoutMs?: number;
  autostartPollMs?: number;
}

function isEnabled(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultDaemonScriptPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "daemon.js");
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function probeDaemonSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const settle = (connected: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.removeAllListeners();
      socket.on("error", () => {});
      socket.destroy();
      resolveProbe(connected);
    };
    socket.setTimeout(250, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

export async function spawnDaemonProcess(
  opts: SpawnDaemonOptions,
): Promise<ChildProcess> {
  await mkdir(dirname(opts.socketPath), { recursive: true });
  const daemonScriptPath = opts.daemonScriptPath ?? defaultDaemonScriptPath();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...opts.env,
    CMUXLAYER_DAEMON_SOCKET: opts.socketPath,
  };
  const nodeOptions = env.NODE_OPTIONS ?? "";
  if (!/(^|\s)--max-old-space-size(=|\s)/.test(nodeOptions)) {
    env.NODE_OPTIONS = `${nodeOptions} --max-old-space-size=${
      env.CMUXLAYER_NODE_MAX_OLD_SPACE_MB ?? "1536"
    }`.trim();
  }
  const child = spawn(process.execPath, [daemonScriptPath], {
    detached: true,
    env,
    stdio: ["ignore", "ignore", "inherit"],
  });
  child.unref();
  return child;
}

async function waitForDaemon(
  socketPath: string,
  opts: Required<
    Pick<
      DaemonFirstEntryOptions,
      "probeDaemon" | "sleep" | "autostartTimeoutMs" | "autostartPollMs"
    >
  >,
): Promise<boolean> {
  const deadline = Date.now() + opts.autostartTimeoutMs;
  do {
    if (await opts.probeDaemon(socketPath)) {
      return true;
    }
    if (opts.autostartTimeoutMs === 0) {
      return false;
    }
    await opts.sleep(opts.autostartPollMs);
  } while (Date.now() < deadline);

  return opts.probeDaemon(socketPath);
}

export async function startInProcessRuntime(
  opts: StartInProcessOptions = {},
): Promise<McpServer> {
  const [
    { StdioServerTransport },
    { bindStdioLifecycle },
    { createCmuxClient },
    { createServer },
    { drainOutbox, httpDeliver },
    { defaultMonitorRegistryPath, httpNotifyMonitorDeadman },
    { ensureNodeMaxOldSpaceEnv, installHeapGuard },
  ] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    import("./stdio-lifecycle.js"),
    import("./cmux-client-factory.js"),
    import("./server.js"),
    import("./outbox-drainer.js"),
    import("./monitor-registry.js"),
    import("./heap-guard.js"),
  ]);

  ensureNodeMaxOldSpaceEnv();
  installHeapGuard();
  const client = await createCmuxClient();
  const serverOpts: CreateServerOptions = {
    client,
    outboxDrain: () => drainOutbox({ deliver: httpDeliver }),
    monitorRegistryPath: defaultMonitorRegistryPath(),
    monitorRegistryNotify: httpNotifyMonitorDeadman,
    enableCloseForensics: true,
    ...(opts.fallbackWarnings
      ? { controlHealthWarnings: opts.fallbackWarnings }
      : {}),
  };
  const server = createServer(serverOpts);
  const transport = new StdioServerTransport();
  let shutdownStarted = false;
  bindStdioLifecycle({
    stdin: process.stdin,
    transport: transport as any,
    shutdown: (reason) => {
      if (shutdownStarted) return;
      shutdownStarted = true;
      const forceExit = setTimeout(() => {
        console.error(`[cmuxlayer] forced stdio shutdown after ${reason}`);
        process.exit(0);
      }, 1_000);
      forceExit.unref();
      void server
        .close()
        .catch((error) => {
          console.error("[cmuxlayer] stdio shutdown failed", error);
        })
        .finally(() => {
          clearTimeout(forceExit);
          process.exit(0);
        });
    },
  });
  await server.connect(transport);
  return server;
}

export async function runDaemonFirstEntry(
  opts: DaemonFirstEntryOptions = {},
): Promise<EntryRuntime> {
  const env = opts.env ?? process.env;
  const logger = opts.logger ?? console;
  const socketPath = resolveDefaultDaemonSocketPath(env);
  const probeDaemon = opts.probeDaemon ?? probeDaemonSocket;
  const runProxy = opts.runProxy ?? runProxyRuntime;
  const spawnDaemon = opts.spawnDaemon ?? spawnDaemonProcess;
  const startInProcess = opts.startInProcess ?? startInProcessRuntime;
  const sleep = opts.sleep ?? defaultSleep;
  const autostartTimeoutMs =
    opts.autostartTimeoutMs ?? DEFAULT_AUTOSTART_TIMEOUT_MS;
  const autostartPollMs = opts.autostartPollMs ?? DEFAULT_AUTOSTART_POLL_MS;

  const startProxy = async (): Promise<EntryRuntime> => ({
    mode: "daemon-proxy",
    proxy: await runProxy({
      socketPath,
      input: opts.input,
      output: opts.output,
      logger,
    }),
  });

  const fallback = async (warning: string): Promise<EntryRuntime> => {
    logger.error(`[cmuxlayer] WARNING: ${warning}`);
    return {
      mode: "in-process",
      server: await startInProcess({ fallbackWarnings: [warning] }),
      fallbackWarnings: [warning],
    };
  };

  if (isEnabled(env.CMUXLAYER_FORCE_INPROCESS)) {
    return fallback(
      "CMUXLAYER_FORCE_INPROCESS=1; using heavy in-process runtime instead of daemon proxy",
    );
  }

  if (await probeDaemon(socketPath)) {
    return startProxy();
  }

  try {
    await spawnDaemon({
      socketPath,
      env,
      daemonScriptPath: opts.daemonScriptPath,
      logger,
    });
  } catch (error) {
    return fallback(
      `daemon unavailable; using heavy in-process runtime after daemon autostart failed at ${socketPath}: ${errorText(
        error,
      )}`,
    );
  }

  const available = await waitForDaemon(socketPath, {
    probeDaemon,
    sleep,
    autostartTimeoutMs,
    autostartPollMs,
  });
  if (available) {
    return startProxy();
  }

  return fallback(
    `daemon unavailable; using heavy in-process runtime after daemon autostart timeout at ${socketPath}`,
  );
}
