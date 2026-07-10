/**
 * Bidirectional transport self-healing for createCmuxClient.
 * When startup socket probes fail, the daemon runs degraded on CLI and
 * periodically re-probes. When an active socket breaks, failed payloads are
 * replayed through the CLI fallback and the same re-probe path upgrades later.
 */

import { CmuxClient } from "./cmux-client.js";
import { CmuxSocketClient } from "./cmux-socket-client.js";
import { CmuxSocketError } from "./cmux-socket-error.js";
import type { CreateCmuxClientOptions } from "./cmux-client-factory.js";
import {
  candidateSocketPathsForOpts,
  probeSocketHealth,
  probeUsableSocket,
  resolveSocketPath,
  type SocketProbeResult,
} from "./cmux-socket-probe.js";

export const DEFAULT_PING_RETRY_ATTEMPTS = 3;
export const DEFAULT_PING_RETRY_BACKOFF_MS = [100, 250, 500] as const;
export const DEFAULT_TRANSPORT_REPROBE_MS = 5_000;
export const DEFAULT_TRANSPORT_REPROBE_CAP_MS = 30_000;

export interface TransportHealthSignal {
  mode: "socket" | "cli";
  degraded: boolean;
  current_socket_path?: string | null;
  denied_reason?: "access-control";
  last_error?: string;
}

export interface TransportDenialSignal {
  denied_reason: "access-control";
  socketPath: string;
  error: string;
}

export interface CmuxSelfHealingClientOptions {
  cli: CmuxClient;
  /** Initial socket transport. Omit when starting degraded on CLI. */
  socket?: CmuxSocketClient;
  /** Primary socket path to re-probe for upgrade; may be null when unpinned and all dead. */
  socketPath: string | null;
  factoryOpts?: CreateCmuxClientOptions;
  reprobeIntervalMs?: number;
  reprobeCapMs?: number;
  random?: () => number;
  initialDenial?: TransportDenialSignal;
  logger?: Pick<Console, "error">;
  sleep?: (ms: number) => Promise<void>;
  probeUsable?: typeof probeUsableSocket;
  probeSocketHealth?: typeof probeSocketHealth;
  resolvePath?: typeof resolveSocketPath;
}

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

type CmuxLayerClient = CmuxClient | CmuxSocketClient;
type ForwardedAsyncMethod = (typeof FORWARDED_ASYNC_METHODS)[number];

interface FailedPayload {
  method: ForwardedAsyncMethod;
  args: unknown[];
}

interface QueuedFailedPayload {
  payload: FailedPayload;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export function decorrelatedJitterDelayMs(opts: {
  baseMs: number;
  previousMs: number;
  capMs: number;
  random?: () => number;
}): number {
  const base = Math.max(0, Math.floor(opts.baseMs));
  const cap = Math.max(base, Math.floor(opts.capMs));
  const previous = Math.max(base, Math.floor(opts.previousMs));
  const random = opts.random ?? Math.random;
  const upper = Math.max(base, previous * 3);
  const next = base + random() * (upper - base);
  return Math.min(cap, Math.max(base, Math.round(next)));
}

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
  private previousReprobeDelayMs = 0;
  private upgrading = false;
  private stopped = false;
  private failedPayloadQueue: QueuedFailedPayload[] = [];
  private flushingFailedPayloadQueue: Promise<void> | null = null;
  private transportDenial: TransportDenialSignal | null = null;

  constructor(private readonly opts: CmuxSelfHealingClientOptions) {
    this.socketClient = opts.socket ?? null;
    this.delegate = opts.socket ?? opts.cli;
    this.transportDenial = opts.initialDenial ?? null;
    if (this.socketClient) {
      this.pinCliToSocket(this.socketClient);
    }
    for (const method of FORWARDED_ASYNC_METHODS) {
      (this as Record<string, unknown>)[method] = (...args: unknown[]) =>
        this.invokeForwarded(method, args);
    }
    if (!this.socketClient) {
      opts.logger?.error(
        "[cmuxlayer] transport degraded: cli (periodic socket re-probe active)",
      );
      this.startReprobe();
    }
  }

  getTransportHealth(): TransportHealthSignal {
    if (this.socketClient) {
      return {
        mode: "socket",
        degraded: false,
        current_socket_path: this.socketClient.currentSocketPath(),
      };
    }
    const denial = this.transportDenial
      ? {
          denied_reason: this.transportDenial.denied_reason,
          last_error: this.transportDenial.error,
        }
      : {};
    return {
      mode: "cli",
      degraded: true,
      current_socket_path: this.opts.socketPath,
      ...denial,
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
      clearTimeout(this.reprobeTimer);
      this.reprobeTimer = null;
    }
    this.disconnect();
  }

  private async trackInFlight<T>(fn: () => Promise<T>): Promise<T> {
    this.inFlight += 1;
    try {
      return await fn();
    } catch (error) {
      if (this.shouldDowngrade(error)) {
        this.downgradeToCli();
      }
      throw error;
    } finally {
      this.inFlight -= 1;
    }
  }

  private async invokeForwarded(
    method: ForwardedAsyncMethod,
    args: unknown[],
  ): Promise<unknown> {
    const delegate = this.delegate;
    const startedOnSocket =
      this.socketClient !== null && delegate === this.socketClient;
    this.inFlight += 1;
    try {
      return await this.callDelegate(method, args, delegate);
    } catch (error) {
      const replay = this.recoverFailedPayload(
        error,
        method,
        args,
        startedOnSocket,
      );
      if (replay) {
        return replay;
      }
      throw error;
    } finally {
      this.inFlight -= 1;
    }
  }

  private callDelegate(
    method: ForwardedAsyncMethod,
    args: unknown[],
    delegate: CmuxLayerClient = this.delegate,
  ): Promise<unknown> {
    return (
      delegate as unknown as Record<
        ForwardedAsyncMethod,
        (...inner: unknown[]) => Promise<unknown>
      >
    )[method](...args);
  }

  private startReprobe(): void {
    if (this.reprobeTimer || this.stopped || this.socketClient) {
      return;
    }
    const delayMs = this.nextReprobeDelayMs();
    this.reprobeTimer = setTimeout(() => {
      this.reprobeTimer = null;
      void this.tryUpgrade();
    }, delayMs);
    this.reprobeTimer.unref?.();
  }

  private nextReprobeDelayMs(): number {
    const baseMs = this.opts.reprobeIntervalMs ?? DEFAULT_TRANSPORT_REPROBE_MS;
    const previousMs = this.previousReprobeDelayMs || baseMs;
    const delayMs = decorrelatedJitterDelayMs({
      baseMs,
      previousMs,
      capMs: this.opts.reprobeCapMs ?? DEFAULT_TRANSPORT_REPROBE_CAP_MS,
      random: this.opts.random,
    });
    this.previousReprobeDelayMs = delayMs;
    return delayMs;
  }

  private shouldDowngrade(error: unknown): boolean {
    if (!this.socketClient) {
      return false;
    }

    return this.isRecoverableSocketError(error);
  }

  private isRecoverableSocketError(error: unknown): boolean {
    const isTransportError =
      error instanceof CmuxSocketError &&
      (error.code === "connection_error" ||
        error.code === "connection_closed");
    const message = error instanceof Error ? error.message : String(error);
    const hasBrokenPipeSignal = /\b(?:EPIPE|ECONNRESET|broken pipe)\b/i.test(
      message,
    );
    return isTransportError || hasBrokenPipeSignal;
  }

  private recoverFailedPayload(
    error: unknown,
    method: ForwardedAsyncMethod,
    args: unknown[],
    startedOnSocket: boolean,
  ): Promise<unknown> | null {
    if (!startedOnSocket || !this.isRecoverableSocketError(error)) {
      return null;
    }

    const replay = this.enqueueFailedPayload({ method, args });
    if (this.socketClient) {
      this.downgradeToCli();
    }
    void this.flushFailedPayloadQueue();
    return replay;
  }

  private enqueueFailedPayload(payload: FailedPayload): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.failedPayloadQueue.push({ payload, resolve, reject });
    });
  }

  private flushFailedPayloadQueue(): Promise<void> {
    if (this.flushingFailedPayloadQueue) {
      return this.flushingFailedPayloadQueue;
    }

    this.flushingFailedPayloadQueue = (async () => {
      while (this.failedPayloadQueue.length > 0) {
        const entry = this.failedPayloadQueue[0]!;
        try {
          const result = await this.callDelegate(
            entry.payload.method,
            entry.payload.args,
          );
          entry.resolve(result);
        } catch (error) {
          entry.reject(error);
        } finally {
          this.failedPayloadQueue.shift();
        }
      }
    })().finally(() => {
      this.flushingFailedPayloadQueue = null;
    });

    return this.flushingFailedPayloadQueue;
  }

  private downgradeToCli(): void {
    if (!this.socketClient) {
      return;
    }

    try {
      this.socketClient.disconnect();
    } catch {
      // The socket is already unusable; the CLI fallback is the recovery path.
    }
    this.socketClient = null;
    this.delegate = this.opts.cli;
    this.transportDenial = null;
    this.opts.logger?.error(
      "[cmuxlayer] transport downgraded: socket -> cli (periodic socket re-probe active)",
    );
    this.startReprobe();
  }

  private pinCliToSocket(socket: CmuxSocketClient): void {
    try {
      this.opts.cli.setEnv({
        ...process.env,
        CMUX_SOCKET_PATH: socket.currentSocketPath(),
      });
    } catch {
      // Keep the socket transport active; CLI pinning will be retried after any
      // downgrade/upgrade that has a resolved socket path.
    }
  }

  private async tryUpgrade(): Promise<void> {
    if (this.stopped || this.socketClient || this.upgrading) {
      return;
    }
    if (this.inFlight > 0) {
      this.startReprobe();
      return;
    }

    const factoryOpts = this.opts.factoryOpts;
    const sleep = this.opts.sleep ?? defaultSleep;
    const resolvePath = this.opts.resolvePath ?? resolveSocketPath;

    let socketPath = this.opts.socketPath;
    if (!socketPath) {
      socketPath = await resolvePath(factoryOpts);
    }
    if (!socketPath) {
      this.startReprobe();
      return;
    }
    const probeResult = await this.checkSocketHealth(socketPath, factoryOpts);
    if (probeResult.denied_reason === "access-control") {
      this.recordAccessControlDenial(probeResult);
      this.startReprobe();
      return;
    }
    if (!probeResult.usable) {
      this.startReprobe();
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
      this.pinCliToSocket(client);
      this.socketClient = client;
      this.delegate = client;
      this.transportDenial = null;
      this.clearReprobe();
      this.previousReprobeDelayMs = 0;
      this.opts.logger?.error("[cmuxlayer] transport upgraded: cli -> socket");
    } catch {
      // Stay on CLI until the next re-probe tick.
    } finally {
      this.upgrading = false;
      if (!this.socketClient && !this.stopped) {
        this.startReprobe();
      }
    }
  }

  private async checkSocketHealth(
    socketPath: string,
    factoryOpts?: CreateCmuxClientOptions,
  ): Promise<SocketProbeResult> {
    if (this.opts.probeSocketHealth) {
      return this.opts.probeSocketHealth(socketPath, factoryOpts);
    }
    if (this.opts.probeUsable) {
      return {
        usable: await this.opts.probeUsable(socketPath, factoryOpts),
        socketPath,
      };
    }
    return probeSocketHealth(socketPath, factoryOpts);
  }

  private recordAccessControlDenial(result: SocketProbeResult): void {
    this.transportDenial = {
      denied_reason: "access-control",
      socketPath: result.socketPath,
      error: result.error ?? "Access denied",
    };
    this.opts.logger?.error(
      `[cmuxlayer] transport denied: access-control (${result.socketPath}): ${this.transportDenial.error}`,
    );
  }

  private clearReprobe(): void {
    if (this.reprobeTimer) {
      clearTimeout(this.reprobeTimer);
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

export function wrapSocketWithSelfHeal(
  socket: CmuxSocketClient,
  cli: CmuxClient,
  opts: Omit<CmuxSelfHealingClientOptions, "cli" | "socket">,
): CmuxSelfHealingClient {
  return new CmuxSelfHealingClient({ cli, socket, ...opts });
}

export function primaryCandidateSocketPath(
  factoryOpts?: CreateCmuxClientOptions,
): string | null {
  const paths = candidateSocketPathsForOpts(factoryOpts);
  return paths[0] ?? null;
}
