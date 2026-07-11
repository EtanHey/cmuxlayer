import net from "node:net";
import type { Readable, Writable } from "node:stream";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CreateServerOptions } from "./server.js";
import {
  CmuxLayerProxy,
  runProxy as runProxyRuntime,
  type CmuxLayerProxyOptions,
} from "./proxy.js";
import { defaultDaemonSocketPath as resolveDefaultDaemonSocketPath } from "./daemon-socket-path.js";
import {
  spawnDaemonProcess,
  type SpawnDaemonOptions,
} from "./daemon-spawn.js";

const DEFAULT_AUTOSTART_TIMEOUT_MS = 5_000;
const DEFAULT_AUTOSTART_POLL_MS = 50;

export { resolveDefaultDaemonSocketPath as defaultDaemonSocketPath };

export { spawnDaemonProcess, type SpawnDaemonOptions } from "./daemon-spawn.js";

export interface StartInProcessOptions {
  fallbackWarnings?: string[];
}

export type ExitFn = (code: number) => void;

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
  exit?: ExitFn;
}

function isEnabled(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function terminateSpawnedDaemon(
  spawnedDaemon: unknown,
  logger: Pick<Console, "error">,
): void {
  const kill =
    spawnedDaemon &&
    typeof spawnedDaemon === "object" &&
    "kill" in spawnedDaemon &&
    typeof spawnedDaemon.kill === "function"
      ? spawnedDaemon.kill
      : null;
  if (!kill) {
    return;
  }
  try {
    kill.call(spawnedDaemon, "SIGTERM");
  } catch (error) {
    logger.error(
      "[cmuxlayer] failed to terminate timed-out daemon autostart",
      error,
    );
  }
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

export function bindProxyStdioLifecycle(opts: {
  input: Readable;
  proxy: Pick<CmuxLayerProxy, "stop">;
  logger: Pick<Console, "error">;
  exit: ExitFn;
}): void {
  let shutdownStarted = false;
  const shutdown = (reason: string) => {
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;
    const forceExit = setTimeout(() => {
      opts.logger.error(
        `[cmuxlayer-proxy] forced stdio shutdown after ${reason}`,
      );
      opts.exit(0);
    }, 1_000);
    forceExit.unref?.();
    void opts.proxy.stop().then(
      () => {
        clearTimeout(forceExit);
        opts.exit(0);
      },
      (error) => {
        clearTimeout(forceExit);
        opts.logger.error("[cmuxlayer-proxy] stdio shutdown failed", error);
        opts.exit(1);
      },
    );
  };

  opts.input.once("end", () => shutdown("stdin end"));
  opts.input.once("close", () => shutdown("stdin close"));
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
  const exit = opts.exit ?? ((code) => process.exit(code));
  const autostartTimeoutMs =
    opts.autostartTimeoutMs ?? DEFAULT_AUTOSTART_TIMEOUT_MS;
  const autostartPollMs = opts.autostartPollMs ?? DEFAULT_AUTOSTART_POLL_MS;

  const startProxy = async (): Promise<EntryRuntime> => {
    const input = opts.input ?? process.stdin;
    const proxy = await runProxy({
      socketPath,
      input,
      output: opts.output,
      logger,
      spawnDaemonForVersionBump: spawnDaemon,
    });
    bindProxyStdioLifecycle({ input, proxy, logger, exit });
    return {
      mode: "daemon-proxy",
      proxy,
    };
  };

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

  let spawnedDaemon: unknown;
  try {
    spawnedDaemon = await spawnDaemon({
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

  if (await probeDaemon(socketPath)) {
    return startProxy();
  }

  terminateSpawnedDaemon(spawnedDaemon, logger);
  return fallback(
    `daemon unavailable; using heavy in-process runtime after daemon autostart timeout at ${socketPath}`,
  );
}
