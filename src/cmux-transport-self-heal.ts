/**
 * CLI→socket transport self-healing for createCmuxClient.
 * When startup socket probes fail, the daemon runs degraded on CLI but
 * periodically re-probes and upgrades without a process restart.
 */

import { CmuxClient } from "./cmux-client.js";
import { CmuxSocketClient } from "./cmux-socket-client.js";
import type { CreateCmuxClientOptions } from "./cmux-client-factory.js";
import {
  candidateSocketPathsForOpts,
  probeUsableSocket,
  resolveSocketPath,
} from "./cmux-socket-probe.js";

export const DEFAULT_PING_RETRY_ATTEMPTS = 3;
export const DEFAULT_PING_RETRY_BACKOFF_MS = [100, 250, 500] as const;
export const DEFAULT_TRANSPORT_REPROBE_MS = 5_000;

export interface TransportHealthSignal {
  mode: "socket" | "cli";
  degraded: boolean;
  current_socket_path?: string | null;
}

export interface CmuxSelfHealingClientOptions {
  cli: CmuxClient;
  /** Primary socket path to re-probe for upgrade; may be null when unpinned and all dead. */
  socketPath: string | null;
  factoryOpts?: CreateCmuxClientOptions;
  reprobeIntervalMs?: number;
  logger?: Pick<Console, "error">;
  sleep?: (ms: number) => Promise<void>;
  probeUsable?: typeof probeUsableSocket;
  resolvePath?: typeof resolveSocketPath;
}

type CmuxLayerClient = CmuxClient | CmuxSocketClient;

const FORWARDED_ASYNC_METHODS = [
  "listWorkspaces",
  "listPaneSurfaces",
  "listPanes",
  "listTerminalMetadata",
  "newSplit",
  "newSurface",
  "moveSurface",
  "reorderSurface",
  "send",
  "pasteText",
  "sendKey",
  "selectWorkspace",
  "createWorkspace",
  "readScreen",
  "renameTab",
  "notify",
  "setStatus",
  "clearStatus",
  "setProgress",
  "clearProgress",
  "log",
  "closeSurface",
  "listStatus",
  "identify",
  "browser",
] as const;

export function getTransportHealth(
  client: unknown,
): TransportHealthSignal | null {
  if (
    client &&
    typeof client === "object" &&
    "getTransportHealth" in client &&
    typeof (client as { getTransportHealth: unknown }).getTransportHealth ===
      "function"
  ) {
    return (
      client as { getTransportHealth: () => TransportHealthSignal }
    ).getTransportHealth();
  }
  if (client instanceof CmuxSocketClient) {
    return {
      mode: "socket",
      degraded: false,
      current_socket_path: client.currentSocketPath(),
    };
  }
  if (client instanceof CmuxClient) {
    return {
      mode: "cli",
      degraded: true,
      current_socket_path: null,
    };
  }
  return null;
}

export class CmuxSelfHealingClient {
  private delegate: CmuxLayerClient;
  private socketClient: CmuxSocketClient | null = null;
  private inFlight = 0;
  private reprobeTimer: NodeJS.Timeout | null = null;
  private upgrading = false;
  private stopped = false;

  constructor(private readonly opts: CmuxSelfHealingClientOptions) {
    this.delegate = opts.cli;
    for (const method of FORWARDED_ASYNC_METHODS) {
      (this as Record<string, unknown>)[method] = (...args: unknown[]) =>
        this.trackInFlight(() =>
          (
            this.delegate as unknown as Record<
              string,
              (...inner: unknown[]) => Promise<unknown>
            >
          )[method](...args),
        );
    }
    opts.logger?.error(
      "[cmuxlayer] transport degraded: cli (periodic socket re-probe active)",
    );
    this.startReprobe();
  }

  getTransportHealth(): TransportHealthSignal {
    if (this.socketClient) {
      return {
        mode: "socket",
        degraded: false,
        current_socket_path: this.socketClient.currentSocketPath(),
      };
    }
    return {
      mode: "cli",
      degraded: true,
      current_socket_path: this.opts.socketPath,
    };
  }

  setEnv(env: NodeJS.ProcessEnv | undefined): void {
    this.opts.cli.setEnv(env);
  }

  currentSocketPath(): string | null {
    if (
      "currentSocketPath" in this.delegate &&
      typeof this.delegate.currentSocketPath === "function"
    ) {
      return this.delegate.currentSocketPath();
    }
    return this.opts.socketPath;
  }

  async ping(): Promise<boolean> {
    if (
      !("ping" in this.delegate) ||
      typeof this.delegate.ping !== "function"
    ) {
      return false;
    }
    return this.trackInFlight(async () => {
      const delegate = this.delegate as CmuxSocketClient;
      return delegate.ping();
    });
  }

  disconnect(): void {
    if (
      "disconnect" in this.delegate &&
      typeof this.delegate.disconnect === "function"
    ) {
      this.delegate.disconnect();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.reprobeTimer) {
      clearInterval(this.reprobeTimer);
      this.reprobeTimer = null;
    }
    this.disconnect();
  }

  private async trackInFlight<T>(fn: () => Promise<T>): Promise<T> {
    this.inFlight += 1;
    try {
      return await fn();
    } finally {
      this.inFlight -= 1;
    }
  }

  private startReprobe(): void {
    const interval =
      this.opts.reprobeIntervalMs ?? DEFAULT_TRANSPORT_REPROBE_MS;
    this.reprobeTimer = setInterval(() => {
      void this.tryUpgrade();
    }, interval);
    this.reprobeTimer.unref?.();
  }

  private async tryUpgrade(): Promise<void> {
    if (this.stopped || this.socketClient || this.upgrading) {
      return;
    }
    if (this.inFlight > 0) {
      return;
    }

    const sleep = this.opts.sleep ?? defaultSleep;
    const probe = this.opts.probeUsable ?? probeUsableSocket;
    const factoryOpts = this.opts.factoryOpts;
    const resolvePath = this.opts.resolvePath ?? resolveSocketPath;

    let socketPath = this.opts.socketPath;
    if (!socketPath) {
      socketPath = await resolvePath(factoryOpts);
    }
    if (!socketPath) {
      return;
    }
    if (!(await probe(socketPath, factoryOpts))) {
      return;
    }

    this.upgrading = true;
    try {
      while (this.inFlight > 0) {
        await sleep(10);
      }

      const cliFallback = this.opts.cli;
      const client = new CmuxSocketClient({
        socketPath,
        timeoutMs: factoryOpts?.timeoutMs,
        password: factoryOpts?.password,
        cliFallback,
        socketPathResolver: () => resolvePath(factoryOpts),
      });
      await client.ping();
      this.socketClient = client;
      this.delegate = client;
      this.clearReprobe();
      this.opts.logger?.error("[cmuxlayer] transport upgraded: cli -> socket");
    } catch {
      // Stay on CLI until the next re-probe tick.
    } finally {
      this.upgrading = false;
    }
  }

  private clearReprobe(): void {
    if (this.reprobeTimer) {
      clearInterval(this.reprobeTimer);
      this.reprobeTimer = null;
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function wrapCliWithSelfHeal(
  cli: CmuxClient,
  opts: Omit<CmuxSelfHealingClientOptions, "cli">,
): CmuxSelfHealingClient {
  return new CmuxSelfHealingClient({ cli, ...opts });
}

export function primaryCandidateSocketPath(
  factoryOpts?: CreateCmuxClientOptions,
): string | null {
  const paths = candidateSocketPathsForOpts(factoryOpts);
  return paths[0] ?? null;
}
