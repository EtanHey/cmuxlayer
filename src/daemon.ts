#!/usr/bin/env node

import net from "node:net";
import { readFileSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname } from "node:path";
import { serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createCmuxClient,
  type CreateCmuxClientOptions,
} from "./cmux-client-factory.js";
import { createServer, createServerContext } from "./server.js";
import { makeSelfRegistrationSessionResolver } from "./self-registration.js";
import { drainOutbox, httpDeliver } from "./outbox-drainer.js";
import {
  defaultMonitorRegistryPath,
  httpNotifyMonitorDeadman,
  reconcileMonitorRegistry,
} from "./monitor-registry.js";
import { defaultWatchRegistryPath, httpNotifyWatch } from "./watch-spec.js";
import {
  ackedIds,
  dispatchOnce,
  formatInboxPing,
  inboxPath,
  monitorAlive,
  readLastAgentHeartbeat,
  type InboxOpts,
} from "./inbox.js";
import type { ExecFn } from "./cmux-client.js";
import type { CmuxSocketClient } from "./cmux-socket-client.js";
import type { CmuxClient } from "./cmux-client.js";
import type { CmuxServerContext, CreateServerOptions } from "./server.js";
import {
  DAEMON_SOCKET_FILENAME,
  NIGHTLY_DAEMON_SOCKET_FILENAME,
  defaultDaemonSocketPath,
} from "./daemon-socket-path.js";
import { ensureNodeMaxOldSpaceEnv, installHeapGuard } from "./heap-guard.js";
import { JsonRpcLineBuffer } from "./json-rpc-line-buffer.js";
import {
  callerContextFromMessage,
  runWithCallerContext,
} from "./caller-context.js";
import {
  detectStaleBuild,
  type DetectStaleBuildDeps,
  type StaleBuildResult,
} from "./version.js";
import { isMainModule } from "./is-main.js";
import {
  daemonSocketOwnerAlive,
  daemonSocketOwnerPath,
  daemonSocketOwnerReceiptText,
  readDaemonSocketOwnerReceipt,
  readDaemonSocketOwnerReceiptAt,
  type DaemonSocketOwnerReceipt,
} from "./daemon-socket-owner.js";
import {
  DaemonSocketInUseError,
  DaemonSocketPathOccupiedError,
  recordDaemonLifecycleError,
  recordDaemonSocketInUse,
  recordDaemonSocketReap,
  type DaemonSocketProbe,
} from "./daemon-lifecycle-state.js";
import { loadCmuxlayerConfigFile } from "./config-file.js";
import { FleetSidebarPublisher } from "./fleet-sidebar.js";

const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_CHECK_INTERVAL_MS = 30_000;
const DEFAULT_MONITOR_RECONCILE_INTERVAL_MS = 15_000;
const DEFAULT_NOTIFY_URL = "http://127.0.0.1:3847/notify";
const MONITOR_REARM_INBOX_HEARTBEAT_MAX_AGE_MS = 60_000;
const LISTEN_FD_START = 3;

/**
 * TODO(phase3-hot-reload): After Gemini research, implement drain→swap→resume on
 * daemon version bump: pause accepts, drain in-flight MCP requests, hand off the
 * listen socket to a successor process (launchd activation prior art), and
 * resume proxy children without losing registry state.
 */
export interface DaemonHotReloadPlan {
  readonly kind: "drain-swap-resume";
  targetVersion: string;
}

export type DaemonHotReloadHandler = (
  plan: DaemonHotReloadPlan,
) => Promise<"not_implemented">;

export interface MonitorOwnerCollapseNotification {
  title: string;
  body: string;
  source: string;
  priority: "high";
  dedupe_key: string;
}

export type MonitorOwnerPtyDeadNotification = MonitorOwnerCollapseNotification;

type CmuxLayerClient = CmuxClient | CmuxSocketClient;
export type DaemonRetirementReason = "stale-build" | "irrecoverable-transport";
export type DaemonShutdownReason =
  NodeJS.Signals | "manual" | DaemonRetirementReason;

export class SocketJsonRpcTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  onRequestObserved?: (message: JSONRPCMessage) => void;
  onSend?: (message: JSONRPCMessage) => void;

  private readBuffer = new JsonRpcLineBuffer();
  private started = false;
  private closed = false;

  private readonly onData = (chunk: Buffer) => {
    this.readBuffer.append(chunk);
    this.processReadBuffer();
  };

  private readonly onError = (error: Error) => {
    this.onerror?.(error);
  };

  private readonly onClose = () => {
    this.finishClose();
  };

  constructor(private readonly socket: net.Socket) {}

  async start(): Promise<void> {
    if (this.started) {
      throw new Error("SocketJsonRpcTransport already started");
    }
    if (this.closed) {
      throw new Error("SocketJsonRpcTransport is closed");
    }
    this.started = true;
    this.socket.on("data", this.onData);
    this.socket.on("error", this.onError);
    this.socket.on("close", this.onClose);
    this.socket.resume();
  }

  async send(
    message: JSONRPCMessage,
    _options?: TransportSendOptions,
  ): Promise<void> {
    if (this.closed) {
      throw new Error("SocketJsonRpcTransport is closed");
    }
    const payload = serializeMessage(message);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onError = (error: Error) => {
        settle(error);
      };
      const onClose = () => {
        settle(
          new Error("SocketJsonRpcTransport closed before write completed"),
        );
      };
      const cleanup = () => {
        this.socket.off("error", onError);
        this.socket.off("close", onClose);
      };
      const settle = (error?: Error | null) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (error) {
          reject(error);
          return;
        }
        resolve();
      };

      this.socket.once("error", onError);
      this.socket.once("close", onClose);
      try {
        this.socket.write(payload, settle);
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.onSend?.(message);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.finishClose();
    if (!this.socket.destroyed) {
      this.socket.resume();
      this.socket.end();
    }
  }

  pauseInput(): void {
    if (!this.closed) {
      this.socket.pause();
    }
  }

  destroy(): void {
    this.finishClose();
    if (!this.socket.destroyed) {
      this.socket.destroy();
    }
  }

  private processReadBuffer(): void {
    while (true) {
      try {
        const message = this.readBuffer.readMessage();
        if (message === null) {
          break;
        }
        if (isJsonRpcRequest(message)) {
          this.onRequestObserved?.(message);
        }
        runWithCallerContext(callerContextFromMessage(message), () => {
          this.onmessage?.(message);
        });
      } catch (error) {
        this.onerror?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
  }

  private finishClose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onError);
    this.socket.off("close", this.onClose);
    this.readBuffer.clear();
    this.onclose?.();
  }
}

export interface CmuxLayerDaemonOptions extends Omit<
  CreateServerOptions,
  "context" | "client"
> {
  socketPath?: string;
  listenFd?: number;
  drainTimeoutMs?: number;
  context?: CmuxServerContext;
  client?: CmuxLayerClient;
  createClient?: (
    opts: Pick<CreateCmuxClientOptions, "onIrrecoverableTransport">,
  ) => Promise<CmuxLayerClient>;
  detectStaleBuild?: (deps?: DetectStaleBuildDeps) => StaleBuildResult | null;
  staleCheckIntervalMs?: number;
  monitorReconcile?: (options?: {
    rearmClaimTimeoutMs?: number;
    monitorIds?: readonly string[];
  }) => Promise<unknown> | unknown;
  monitorReconcileIntervalMs?: number;
  monitorOwnerPtyDeadNotify?: (
    notification: MonitorOwnerPtyDeadNotification,
  ) => Promise<unknown> | unknown;
  monitorOwnerWedgedNotify?: (
    notification: MonitorOwnerCollapseNotification,
  ) => Promise<unknown> | unknown;
  logger?: Pick<Console, "error">;
  onRetire?: (
    reason: DaemonRetirementReason,
    result: DaemonShutdownResult,
  ) => Promise<void> | void;
  serverFactory?: (
    connectionListener: (socket: net.Socket) => void,
  ) => net.Server;
}

export interface DaemonShutdownResult {
  forced: boolean;
  activeConnections: number;
  inFlightRequests: number;
}

export function daemonExitCode(
  reason: DaemonShutdownReason,
  result: DaemonShutdownResult,
): number {
  if (reason === "stale-build" || reason === "irrecoverable-transport") {
    return 0;
  }
  return result.forced ? 1 : 0;
}

function parseListenFd(env: NodeJS.ProcessEnv): number | undefined {
  const explicit = env.CMUXLAYER_DAEMON_FD;
  if (explicit) {
    const fd = Number(explicit);
    if (!Number.isInteger(fd) || fd < 0) {
      throw new Error(`Invalid CMUXLAYER_DAEMON_FD: ${explicit}`);
    }
    return fd;
  }

  const listenFds = Number(env.LISTEN_FDS ?? 0);
  if (Number.isInteger(listenFds) && listenFds > 0) {
    return LISTEN_FD_START;
  }

  return undefined;
}

function isJsonRpcRequest(
  message: JSONRPCMessage,
): message is JSONRPCMessage & { id: RequestId; method: string } {
  return (
    typeof message === "object" &&
    message !== null &&
    "id" in message &&
    "method" in message &&
    typeof message.method === "string"
  );
}

function isJsonRpcResponse(
  message: JSONRPCMessage,
): message is JSONRPCMessage & { id: RequestId } {
  return (
    typeof message === "object" &&
    message !== null &&
    "id" in message &&
    ("result" in message || "error" in message)
  );
}

const DAEMON_SOCKET_PROBE_TIMEOUT_MS = 250;

/**
 * connect(2) failures that mean NOTHING ANSWERED. ENOTSOCK is the reboot shape:
 * `detachOwnedSocketPath()` leaves an empty regular file at the socket path on
 * every clean shutdown, so a SIGTERM at logout/reboot leaves a leftover no
 * daemon can own (#529).
 *
 * These are NOT proof that the path is free. ECONNRESET and EPIPE in particular
 * require a peer that accepted and reset — a live daemon draining or destroying
 * the connection produces exactly that (CodeRabbit, #530). `unlinkStaleSocket`
 * therefore consults the owner receipt on this path too, and a live owner wins.
 */
const DEAD_OWNER_CONNECT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTSOCK",
  "ENOTCONN",
  "EPIPE",
]);

export {
  daemonSocketOwnerPath,
  daemonSocketOwnerReceiptText,
  readDaemonSocketOwnerReceipt,
  readDaemonSocketOwnerPid,
  daemonSocketOwnerAlive,
  type DaemonSocketOwnerReceipt,
} from "./daemon-socket-owner.js";

/**
 * Put a sheltered object back at its well-known path WITHOUT clobbering
 * whatever may have taken that path meanwhile (#530, Codex P1).
 *
 * POSIX `rename` always replaces, so restoring with it can overwrite a
 * successor that bound the briefly-vacant path — leaving a live daemon
 * unreachable. `link(2)` refuses with EEXIST instead, which is exactly the
 * no-replace semantic needed here (verified on macOS and Linux: link works on
 * socket files and returns EEXIST on an occupied name).
 *
 * When the path is taken, the sheltered object is deliberately LEFT in place
 * rather than deleted: an orphaned socket is recoverable, a deleted live one is
 * not.
 */
async function restoreSheltered(
  shelterPath: string,
  path: string,
  logger: Pick<Console, "error">,
): Promise<void> {
  try {
    await link(shelterPath, path);
    await unlinkIfPresent(shelterPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      // #530 (Codex P1): a third racer bound the path while we were sheltering.
      // We will NOT clobber it, and we cannot terminate the sheltered owner —
      // killing another daemon mid-drain is worse than either alternative. So
      // the sheltered owner may keep serving its existing connections while new
      // clients route to the newer daemon. That residual is accepted (see the
      // follow-up issue) but it is NOT silent: it is recorded and warned on.
      const detail =
        `stranded daemon socket: ${shelterPath} could not be restored to ${path} ` +
        "because another owner bound it first; two backends may be serving";
      logger.error(`[cmuxlayer-daemon] ${detail}`);
      recordDaemonLifecycleError(detail);
      return;
    }
    logger.error(
      `[cmuxlayer-daemon] failed to restore ${shelterPath} to ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Reap the EXACT object we classified, using rename(2) as the arbitration
 * primitive (#530, Codex P1).
 *
 * A dev/ino check followed by a separate `unlink(2)` cannot be made safe: two
 * successors can both validate the old inode, and the loser then deletes the
 * winner's live socket. `rename` is atomic, so exactly one racer can move the
 * object out of the well-known path; everyone else gets ENOENT and simply finds
 * the path free. Identity is then verified on a name no other process knows,
 * and anything we did not mean to move is put back rather than destroyed.
 *
 * Returns true when the path is ours to bind, false when we moved something
 * that turned out to belong to a successor (restored, and the caller refuses).
 */
async function reapClassifiedSocket(
  path: string,
  observedIdentity: DaemonSocketIdentity | null,
  readIdentity: (path: string) => Promise<DaemonSocketIdentity | null>,
  logger: Pick<Console, "error">,
): Promise<boolean> {
  const reapingPath = `${path}.reaping-${process.pid}-${Date.now()}`;
  try {
    await rename(path, reapingPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // Another racer moved it first; the path is free either way.
      return true;
    }
    throw error;
  }

  const moved = await readIdentity(reapingPath).catch(() => null);
  const stillOurs =
    observedIdentity !== null && sameIdentity(moved, observedIdentity);

  // Last line of defence, independent of identity entirely: a socket that
  // ANSWERS has a live listener behind it, whatever its dev/ino say. The
  // listener is bound to the inode, so it still answers on the sheltered name.
  // This catches the residual socket-to-socket inode-reuse case that the kind
  // check cannot (#530 CI).
  const answersNow =
    moved?.kind === "socket" &&
    (await probeDaemonSocketPath(reapingPath)) === "live";

  if (!stillOurs || answersNow) {
    await restoreSheltered(reapingPath, path, logger);
    return false;
  }

  await unlinkIfPresent(reapingPath);
  return true;
}

/**
 * Remove the owner receipt only when it is still the one we classified, with
 * validation and deletion made ATOMIC by the same shelter trick (#530, Codex).
 *
 * Comparing then unlinking left a window in which a successor could rewrite the
 * receipt and have its brand-new one deleted — which later removes the
 * live-owner evidence that protects that successor's own shutdown placeholder.
 */
async function unlinkOwnerReceiptIfUnchanged(
  path: string,
  expected: DaemonSocketOwnerReceipt | null,
  logger: Pick<Console, "error">,
): Promise<void> {
  // No receipt at classification time also covers the absent-then-present case:
  // a successor's brand-new receipt is never ours to delete.
  if (expected === null) {
    return;
  }
  const receiptPath = daemonSocketOwnerPath(path);
  const shelterPath = `${receiptPath}.reaping-${process.pid}-${Date.now()}`;
  try {
    await rename(receiptPath, shelterPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  const moved = readDaemonSocketOwnerReceiptAt(shelterPath);
  if (
    moved !== null &&
    moved.pid === expected.pid &&
    moved.startedAtMs === expected.startedAtMs
  ) {
    await unlinkIfPresent(shelterPath);
    return;
  }
  // A successor rewrote it between classification and now. Put it back.
  await restoreSheltered(shelterPath, receiptPath, logger);
}

async function unlinkIfPresent(path: string): Promise<void> {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
}

export type DaemonSocketPathKind = "socket" | "file" | "directory" | "other";

export interface DaemonSocketIdentity {
  dev: number;
  ino: number;
  /**
   * #530 (CI, Linux): dev/ino ALONE cannot identify an object across a
   * delete-and-recreate. Linux hands the freed inode number straight back, so a
   * successor's brand-new SOCKET can carry the exact dev/ino of the
   * regular-file placeholder we classified — and the reap then deleted a LIVE
   * socket. macOS happened to allocate a different inode, which is why this
   * passed on the laptop and failed in CI. The node type is stable across
   * rename(2) and can never collide, so it is part of identity.
   */
  kind: DaemonSocketPathKind;
}

function statsKind(stats: {
  isSocket(): boolean;
  isFile(): boolean;
  isDirectory(): boolean;
}): DaemonSocketPathKind {
  if (stats.isSocket()) return "socket";
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  return "other";
}

/**
 * dev/ino of the path right now, or null when it genuinely does not exist.
 *
 * #530 final pass F2: swallowing EVERY lstat error meant EIO/EACCES read as
 * "absent", which silently disabled the superseded guard and let
 * `unlinkStaleSocket` report "reaped" without deleting anything. Only ENOENT is
 * absence; every other errno is a real failure and must propagate.
 */
async function socketIdentity(
  path: string,
): Promise<DaemonSocketIdentity | null> {
  try {
    const stats = await lstat(path);
    return { dev: stats.dev, ino: stats.ino, kind: statsKind(stats) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function sameIdentity(
  a: DaemonSocketIdentity | null,
  b: DaemonSocketIdentity | null,
): boolean {
  return (
    a !== null &&
    b !== null &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.kind === b.kind
  );
}

/**
 * Classify the daemon socket path WITHOUT ever collapsing "someone is
 * listening" into "something is in the way". A path that exists but is not a
 * socket can never have a live owner, so it is stale by construction; an
 * inconclusive probe stays `unknown` and is resolved against the owner receipt
 * rather than being guessed either way.
 */
export async function probeDaemonSocketPath(
  path: string,
  opts: { timeoutMs?: number } = {},
): Promise<DaemonSocketProbe> {
  try {
    const stats = await lstat(path);
    if (!stats.isSocket()) {
      // #530 (Codex P1): only cmuxlayer's OWN artifact shape is reapable. The
      // shutdown placeholder is an empty regular file
      // (`writeFile(path, "", { flag: "wx" })`), so anything with content — or
      // any other node type — is the operator's data at a mistyped socket path
      // and must fail loudly instead of being deleted.
      return stats.isFile() && stats.size === 0 ? "stale" : "occupied";
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "missing";
    }
    // Anything else (EACCES on a parent dir, races) falls through to connect.
  }

  return new Promise<DaemonSocketProbe>((resolve) => {
    const socket = net.createConnection(path);
    let settled = false;
    const ignoreLateError = () => {};
    const settle = (value: DaemonSocketProbe) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.removeAllListeners();
      socket.on("error", ignoreLateError);
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(opts.timeoutMs ?? DAEMON_SOCKET_PROBE_TIMEOUT_MS, () =>
      settle("unknown"),
    );
    socket.once("connect", () => settle("live"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        settle("missing");
        return;
      }
      if (error.code && DEAD_OWNER_CONNECT_CODES.has(error.code)) {
        settle("stale");
        return;
      }
      // Never re-throw out of the probe: an unexpected errno used to reject and
      // fatal the daemon, which is exactly the silent deadlock this fixes.
      settle("unknown");
    });
  });
}

/**
 * Weak ownership evidence for a receiptless EMPTY file (#530, Macroscope).
 *
 * Nothing intrinsic distinguishes cmuxlayer's placeholder from an operator's
 * empty lock file — that is the honest shape of the problem. The name is the
 * only signal available, so:
 *
 * - cmuxlayer's own canonical filenames always qualify;
 * - so does any `*.sock`, because a path configured as a SOCKET is a path the
 *   operator handed to cmuxlayer for that purpose. Custom
 *   `CMUXLAYER_DAEMON_SOCKET` names are supported and must keep working, and a
 *   0.4.56 leftover has no receipt to fall back on.
 *
 * A mistyped path at a document, config, or `.lock` fails this and is refused.
 */
function hasDaemonSocketOwnershipEvidence(path: string): boolean {
  const name = basename(path);
  return (
    name === DAEMON_SOCKET_FILENAME ||
    name === NIGHTLY_DAEMON_SOCKET_FILENAME ||
    name.endsWith(".sock")
  );
}

export type UnlinkStaleSocketOutcome = "absent" | "reaped";

export interface UnlinkStaleSocketOptions {
  probe?: (path: string) => Promise<DaemonSocketProbe>;
  readOwnerReceipt?: (path: string) => DaemonSocketOwnerReceipt | null;
  ownerAlive?: (receipt: DaemonSocketOwnerReceipt) => boolean;
  /**
   * Test seam for path identity, so inode REUSE — which only occurs naturally
   * on some filesystems — can be reproduced deterministically on any platform
   * (#530 CI).
   */
  readIdentity?: (path: string) => Promise<DaemonSocketIdentity | null>;
  logger?: Pick<Console, "error">;
}

/**
 * Reap a genuinely dead-owner leftover; refuse anything a live daemon owns.
 *
 * The owner receipt OUTRANKS the connect probe whenever it names a process
 * that is still alive:
 *
 * - `missing`  -> nothing to do.
 * - `live`     -> a daemon is accepting connections. Refuse.
 * - `stale`    -> nothing answered. #530 final pass F3 (Codex P1): that is NOT
 *                 sufficient. `closeListener()` parks a regular-file
 *                 placeholder BEFORE `waitForDrain()`, so a daemon that is
 *                 still draining in-flight requests presents exactly this
 *                 shape for up to 5s. CodeRabbit's ECONNRESET/EPIPE finding is
 *                 the same hole from the other side: both errnos require a
 *                 peer that reset, i.e. a live owner. So consult the receipt
 *                 here too, and only reap when no live owner claims the path.
 * - `unknown`  -> inconclusive; the receipt decides, and no receipt fails closed.
 *
 * On refusal the daemon fatals, its readiness rejects, and the ENTRY layer
 * re-probes and attaches to the live owner (or falls back in-process). The
 * "connect to it" outcome belongs to that layer, not to this function.
 */
export async function unlinkStaleSocket(
  path: string,
  opts: UnlinkStaleSocketOptions = {},
): Promise<UnlinkStaleSocketOutcome> {
  const probe = opts.probe ?? probeDaemonSocketPath;
  const readOwnerReceipt =
    opts.readOwnerReceipt ?? readDaemonSocketOwnerReceipt;
  const ownerAlive = opts.ownerAlive ?? daemonSocketOwnerAlive;
  const readIdentity = opts.readIdentity ?? socketIdentity;
  const logger = opts.logger ?? console;

  const refuse = (
    observedProbe: DaemonSocketProbe,
    receipt: DaemonSocketOwnerReceipt | null,
  ): never => {
    const ownerPid = receipt?.pid ?? null;
    recordDaemonSocketInUse({ path, ownerPid });
    throw new DaemonSocketInUseError({
      socketPath: path,
      ownerPid,
      probe: observedProbe,
    });
  };

  // #530 review P2-2: capture what we are about to classify so the reap can
  // prove it is still deleting THAT object and not a successor's.
  const observedIdentity = await readIdentity(path);
  const observedReceipt = readOwnerReceipt(path);

  const status = await probe(path);
  if (status === "missing") {
    return "absent";
  }
  if (status === "occupied") {
    // Not a daemon artifact at all. Never reaped — see the probe's note.
    throw new DaemonSocketPathOccupiedError({
      socketPath: path,
      detail: "a file cmuxlayer did not create",
    });
  }
  if (status === "live") {
    refuse(status, readOwnerReceipt(path));
  }

  // #530 (Macroscope): an EMPTY regular file is cmuxlayer's placeholder shape,
  // but it is also the shape of an operator's lock/sentinel file. Reaping one
  // with no receipt is only safe where cmuxlayer owns the NAME. A mistyped
  // CMUXLAYER_DAEMON_SOCKET pointing at someone's empty file does not match,
  // and is refused; the canonical filename still reaps, which preserves the
  // #529 upgrade path from builds that never wrote receipts at all.
  if (
    status === "stale" &&
    observedReceipt === null &&
    observedIdentity?.kind === "file" &&
    !hasDaemonSocketOwnershipEvidence(path)
  ) {
    throw new DaemonSocketPathOccupiedError({
      socketPath: path,
      detail:
        "an empty file cmuxlayer cannot prove it created (no owner receipt, and the name is not a socket path)",
    });
  }

  const liveOwner = observedReceipt !== null && ownerAlive(observedReceipt);
  if (liveOwner) {
    refuse(status, observedReceipt);
  }
  if (status === "unknown") {
    // An inconclusive probe is NEVER sufficient evidence that the path is safe
    // to reap, receipt or no receipt (Macroscope, #530). The receipt write is
    // best-effort, and an fd-activated daemon never writes one at all, so a
    // stale receipt naming a dead pid can coexist with a live owner — reaping
    // on that combination orphans a running daemon and lets a second one bind.
    // Failing closed costs a fallback to the in-process runtime, which is
    // degraded but correct, and control_health now says why.
    refuse(status, observedReceipt);
  }
  const reason =
    observedReceipt === null
      ? "dead-owner-leftover"
      : `owner-receipt-pid-${observedReceipt.pid}-gone`;

  const current = await readIdentity(path);
  if (current === null) {
    // It vanished on its own between classification and reap. Nothing left to
    // delete, and the path is free for us to bind.
    await unlinkOwnerReceiptIfUnchanged(path, observedReceipt, logger);
    recordDaemonSocketReap({ path, reason: `${reason}-vanished` });
    return "reaped";
  }
  // #530 final pass F8 (Codex addendum): when the path was ABSENT at
  // classification, `observedIdentity` is null and the identity comparison used
  // to be skipped entirely — so a successor that bound DURING classification
  // was unlinked. Absent-then-present is a successor, never a leftover.
  if (observedIdentity === null || !sameIdentity(current, observedIdentity)) {
    refuse("superseded", readOwnerReceipt(path));
  }

  if (
    !(await reapClassifiedSocket(path, observedIdentity, readIdentity, logger))
  ) {
    refuse("superseded", readOwnerReceipt(path));
  }
  await unlinkOwnerReceiptIfUnchanged(path, observedReceipt, logger);
  recordDaemonSocketReap({ path, reason });
  return "reaped";
}

function positiveEnvMs(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export class CmuxLayerDaemon {
  private server: net.Server | null = null;
  private context: CmuxServerContext | null;
  private contextPromise: Promise<CmuxServerContext> | null = null;
  private readonly socketPath: string;
  private readonly listenFd?: number;
  private readonly drainTimeoutMs: number;
  private readonly activeTransports = new Set<SocketJsonRpcTransport>();
  private readonly activeServers = new Set<McpServer>();
  private readonly pendingBootSockets = new Set<net.Socket>();
  private readonly drainWaiters = new Set<() => void>();
  private inFlightRequests = 0;
  private draining = false;
  private shutdownPromise: Promise<DaemonShutdownResult> | null = null;
  private staleCheckTimer: NodeJS.Timeout | null = null;
  private monitorReconcileTimer: NodeJS.Timeout | null = null;
  private monitorReconcileInFlight = false;
  private monitorRelayReadyPending = false;
  private readonly monitorReconcileFailedIds = new Set<string>();
  private monitorReconcileFn:
    | ((options?: {
        rearmClaimTimeoutMs?: number;
        monitorIds?: readonly string[];
      }) => Promise<unknown> | unknown)
    | null;
  private readonly monitorRelayReadyListener = () => {
    void this.retryFailedMonitorRearmsWhenRelayReady();
  };
  private retirementPromise: Promise<void> | null = null;
  private readonly detectStaleBuildFn: (
    deps?: DetectStaleBuildDeps,
  ) => StaleBuildResult | null;
  private readonly staleCheckIntervalMs: number;
  private readonly monitorReconcileIntervalMs: number;
  private readonly logger: Pick<Console, "error">;
  private ownedSocketIdentity: { dev: number; ino: number } | null = null;

  constructor(private readonly opts: CmuxLayerDaemonOptions = {}) {
    this.context = opts.context ?? null;
    this.socketPath = opts.socketPath ?? defaultDaemonSocketPath(process.env);
    this.listenFd = opts.listenFd ?? parseListenFd(process.env);
    this.drainTimeoutMs = opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    this.detectStaleBuildFn = opts.detectStaleBuild ?? detectStaleBuild;
    this.staleCheckIntervalMs =
      opts.staleCheckIntervalMs ??
      positiveEnvMs(process.env.CMUXLAYER_STALE_CHECK_INTERVAL_MS) ??
      DEFAULT_STALE_CHECK_INTERVAL_MS;
    this.monitorReconcileIntervalMs =
      opts.monitorReconcileIntervalMs ?? DEFAULT_MONITOR_RECONCILE_INTERVAL_MS;
    this.monitorReconcileFn = opts.monitorReconcile ?? null;
    this.logger = opts.logger ?? console;
  }

  async start(): Promise<void> {
    if (this.server) {
      throw new Error("cmuxlayer daemon already started");
    }

    if (this.listenFd === undefined) {
      await mkdir(dirname(this.socketPath), { recursive: true });
      await unlinkStaleSocket(this.socketPath);
    }

    const context = await this.getContext();
    if (!this.monitorReconcileFn && this.opts.monitorRegistryPath) {
      this.monitorReconcileFn = this.createDefaultMonitorReconciler(context);
    }
    context.lifecycleAgentInputDelivererReadyListeners.add(
      this.monitorRelayReadyListener,
    );

    this.server = (this.opts.serverFactory ?? net.createServer)(
      (socket) => void this.acceptConnection(socket),
    );
    this.server.on("error", (error) => {
      if (!this.draining) {
        console.error("[cmuxlayer-daemon] server error", error);
      }
    });

    if (this.listenFd !== undefined) {
      await this.listen({ fd: this.listenFd });
    } else {
      await this.listen(this.socketPath);
      const stats = await lstat(this.socketPath);
      this.ownedSocketIdentity = { dev: stats.dev, ino: stats.ino };
      // #529: publish the owner pid next to the socket so a successor can tell
      // "a live daemon owns this" from "a dead process left this behind" even
      // when the connect probe is inconclusive.
      await writeFile(
        daemonSocketOwnerPath(this.socketPath),
        daemonSocketOwnerReceiptText(),
        "utf8",
      ).catch(() => {});
    }
    void this.runMonitorReconcile();
    this.startMonitorReconcileWatcher();
    this.startStaleBuildWatcher();
  }

  async shutdown(
    signal: DaemonShutdownReason = "manual",
  ): Promise<DaemonShutdownResult> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.clearStaleBuildWatcher();
    this.clearMonitorReconcileWatcher();
    this.shutdownPromise = this.doShutdown(signal);
    return this.shutdownPromise;
  }

  activeConnectionCount(): number {
    return this.activeTransports.size;
  }

  inFlightRequestCount(): number {
    return this.inFlightRequests;
  }

  private async getContext(): Promise<CmuxServerContext> {
    if (this.context) {
      return this.context;
    }
    if (!this.contextPromise) {
      this.contextPromise = (async () => {
        const client =
          this.opts.client ??
          (this.opts.createClient
            ? await this.opts.createClient({
                onIrrecoverableTransport: () =>
                  this.requestRetirement("irrecoverable-transport"),
              })
            : this.opts.exec || this.opts.bin
              ? undefined
              : await createCmuxClient({
                  onIrrecoverableTransport: () =>
                    this.requestRetirement("irrecoverable-transport"),
                }));
        this.context = createServerContext({
          exec: this.opts.exec,
          bin: this.opts.bin,
          client,
          stateDir: this.opts.stateDir,
          skipAgentLifecycle: this.opts.skipAgentLifecycle,
          enableClaudeChannels: this.opts.enableClaudeChannels,
          spawnPreflight: this.opts.spawnPreflight,
          disableSpawnPreflight: this.opts.disableSpawnPreflight,
          selfRegistrationSessionResolver:
            this.opts.selfRegistrationSessionResolver ??
            makeSelfRegistrationSessionResolver(),
          surfaceObserverOwnerIdProvider:
            this.opts.surfaceObserverOwnerIdProvider,
          surfaceObserverEpochProvider: this.opts.surfaceObserverEpochProvider,
        });
        return this.context;
      })();
    }
    return this.contextPromise;
  }

  private async acceptConnection(socket: net.Socket): Promise<void> {
    if (this.draining) {
      socket.destroy();
      return;
    }
    socket.pause();
    this.pendingBootSockets.add(socket);
    const clearPendingSocket = () => {
      this.pendingBootSockets.delete(socket);
      socket.off("close", clearPendingSocket);
      socket.off("error", onPendingSocketError);
    };
    const onPendingSocketError = () => {
      // The connection is not live yet; cleanup is completed after the gate.
    };
    socket.once("close", clearPendingSocket);
    socket.on("error", onPendingSocketError);

    let context: CmuxServerContext;
    try {
      context = await this.getContext();
    } catch {
      clearPendingSocket();
      socket.destroy();
      return;
    }

    const mcpServer = createServer({
      context,
      outboxDrain: this.opts.outboxDrain,
      monitorRegistryPath: this.opts.monitorRegistryPath,
      monitorRegistryNow: this.opts.monitorRegistryNow,
      monitorRegistryNotify: this.opts.monitorRegistryNotify,
      watchRegistryPath: this.opts.watchRegistryPath,
      watchRegistryNow: this.opts.watchRegistryNow,
      watchNotify: this.opts.watchNotify,
      fleetSidebarPublisher: this.opts.fleetSidebarPublisher,
    });
    try {
      await (context.lifecycleStartPromise ?? Promise.resolve());
      if (context.lifecycleStartError) {
        throw context.lifecycleStartError;
      }
    } catch {
      clearPendingSocket();
      socket.destroy();
      await mcpServer.close().catch(() => {});
      return;
    }
    if (this.draining || socket.destroyed || !socket.readable) {
      clearPendingSocket();
      socket.destroy();
      await mcpServer.close().catch(() => {});
      return;
    }
    clearPendingSocket();
    const transport = new SocketJsonRpcTransport(socket);
    const pendingRequestIds = new Set<RequestId>();
    this.activeTransports.add(transport);
    this.activeServers.add(mcpServer);

    transport.onRequestObserved = (message) => {
      if (!isJsonRpcRequest(message)) {
        return;
      }
      pendingRequestIds.add(message.id);
      this.inFlightRequests += 1;
    };
    transport.onSend = (message) => {
      if (!isJsonRpcResponse(message)) {
        return;
      }
      if (pendingRequestIds.delete(message.id)) {
        this.inFlightRequests -= 1;
        this.resolveDrainWaiters();
      }
    };
    transport.onclose = () => {
      if (pendingRequestIds.size > 0) {
        this.inFlightRequests -= pendingRequestIds.size;
        pendingRequestIds.clear();
      }
      this.activeTransports.delete(transport);
      this.activeServers.delete(mcpServer);
      this.resolveDrainWaiters();
      void mcpServer.close().catch((error) => {
        if (!this.draining) {
          console.error("[cmuxlayer-daemon] MCP server close failed", error);
        }
      });
    };
    transport.onerror = (error) => {
      if (!this.draining) {
        console.error("[cmuxlayer-daemon] transport error", error);
      }
    };

    try {
      await mcpServer.connect(transport);
    } catch (error) {
      transport.onerror?.(
        error instanceof Error ? error : new Error(String(error)),
      );
      transport.destroy();
    }
  }

  private async doShutdown(
    reason: DaemonShutdownReason,
  ): Promise<DaemonShutdownResult> {
    this.draining = true;
    for (const socket of this.pendingBootSockets) {
      socket.destroy();
    }
    this.pendingBootSockets.clear();
    this.pauseActiveTransports();
    const listenerClosed = this.closeListener();

    const retiring =
      reason === "stale-build" || reason === "irrecoverable-transport";
    if (retiring) {
      const forced = this.inFlightRequests > 0;
      for (const transport of [...this.activeTransports]) {
        transport.destroy();
      }
      for (const server of [...this.activeServers]) {
        await server.close().catch(() => {});
      }
      await listenerClosed;
      this.context?.dispose();
      return {
        forced,
        activeConnections: this.activeTransports.size,
        inFlightRequests: this.inFlightRequests,
      };
    }

    const forced = !(await this.waitForDrain());
    for (const server of [...this.activeServers]) {
      await server.close().catch(() => {});
    }
    for (const transport of [...this.activeTransports]) {
      if (forced) {
        transport.destroy();
      } else {
        await transport.close().catch(() => {});
      }
    }
    await listenerClosed;
    this.context?.dispose();

    return {
      forced,
      activeConnections: this.activeTransports.size,
      inFlightRequests: this.inFlightRequests,
    };
  }

  private startStaleBuildWatcher(): void {
    this.staleCheckTimer = setInterval(() => {
      const stale = this.detectStaleBuildFn();
      if (stale?.stale) {
        this.requestRetirement("stale-build", stale);
      }
    }, this.staleCheckIntervalMs);
    this.staleCheckTimer.unref?.();
  }

  private createDefaultMonitorReconciler(
    context: CmuxServerContext,
  ): (options?: {
    rearmClaimTimeoutMs?: number;
    monitorIds?: readonly string[];
  }) => Promise<unknown> {
    const registryPath =
      this.opts.monitorRegistryPath ?? defaultMonitorRegistryPath();
    const findOwner = (ownerSeat: string) =>
      context.stateMgr
        .listStates()
        .find(
          (record) =>
            record.agent_id === ownerSeat || record.seat_id === ownerSeat,
        ) ?? null;

    type ResolvedOwnerSurface = {
      surfaceId: string;
      stableSurfaceIdentity: string | null;
      surfaceObserverIdentity: string | null;
      workspaceId: string | null;
    };
    const resolveOwnerSurface = async (
      ownerSeat: string,
    ): Promise<ResolvedOwnerSurface | null | undefined> => {
      const owner = findOwner(ownerSeat);
      if (!owner) return null;

      const engine = context.lifecycleSweepEngine;
      if (engine) {
        try {
          const route = await engine.resolveAgentIoRoute(owner.agent_id);
          return {
            surfaceId: route.surface_id,
            stableSurfaceIdentity: route.surface_uuid ?? null,
            surfaceObserverIdentity: context.surfaceObserverId,
            workspaceId: route.workspace_id ?? null,
          };
        } catch {
          // A UUID-backed owner that is absent, ambiguous, or only visible in
          // incomplete topology is not safely addressable. Preserve its
          // monitor until lifecycle routing can establish authoritative
          // presence or absence instead of converting uncertainty to death.
          return undefined;
        }
      }

      // Lifecycle-disabled compatibility is restricted to UUID-less legacy
      // records explicitly owned by the current known observer. Active
      // unowned rows stay quarantined because their mutable ref may belong to
      // a replacement cmux instance. A known UUID likewise requires fresh
      // lifecycle resolution.
      const observerId = context.surfaceObserverId;
      if (
        owner.surface_uuid ||
        !observerId ||
        owner.surface_observer_id !== observerId
      ) {
        return undefined;
      }
      return {
        surfaceId: owner.surface_id,
        stableSurfaceIdentity: null,
        surfaceObserverIdentity: observerId,
        workspaceId: owner.workspace_id ?? null,
      };
    };

    return (options) =>
      reconcileMonitorRegistry({
        registryPath,
        now: this.opts.monitorRegistryNow,
        rearmAckTimeoutMs:
          (this.monitorReconcileIntervalMs > 0
            ? this.monitorReconcileIntervalMs
            : DEFAULT_MONITOR_RECONCILE_INTERVAL_MS) * 2,
        ...(options?.rearmClaimTimeoutMs !== undefined
          ? { rearmClaimTimeoutMs: options.rearmClaimTimeoutMs }
          : {}),
        ...(options?.monitorIds ? { monitorIds: options.monitorIds } : {}),
        ownerPtyDead: async (ownerSeat) => {
          const route = await resolveOwnerSurface(ownerSeat);
          return (
            route != null &&
            context.surfaceWriteLiveness.observe(
              route.surfaceId,
              route.stableSurfaceIdentity,
              route.surfaceObserverIdentity,
            )?.pty_dead === true
          );
        },
        ownerAlive: async (ownerSeat) => {
          const owner = findOwner(ownerSeat);
          if (!owner || owner.state === "done" || owner.state === "error") {
            return false;
          }
          const route = await resolveOwnerSurface(ownerSeat);
          if (route === undefined) return null;
          if (route === null) return false;
          try {
            await context.client.readScreen(route.surfaceId, {
              ...(route.workspaceId ? { workspace: route.workspaceId } : {}),
            });
            return true;
          } catch {
            return false;
          }
        },
        ownerProgressedSince: (record) => {
          const owner = findOwner(record.owner_seat);
          if (!owner || !record.rearm_claimed_at) return false;
          const inboxOpts: InboxOpts = {
            ...(this.opts.inboxBaseDir
              ? { baseDir: this.opts.inboxBaseDir }
              : {}),
            ...(this.opts.monitorRegistryNow
              ? { now: this.opts.monitorRegistryNow }
              : {}),
          };
          const messageId = `monitor-rearm:${record.monitor_id}:${record.last_signal_at}`;
          if (ackedIds(owner.agent_id, inboxOpts).has(messageId)) return true;
          const heartbeat = readLastAgentHeartbeat(owner.agent_id, inboxOpts);
          return (
            heartbeat !== null &&
            heartbeat.ts_ms > Date.parse(record.rearm_claimed_at)
          );
        },
        rearm: async (record) => {
          const owner = findOwner(record.owner_seat);
          if (!owner || !record.rearm_command || !record.rearm_claimed_at) {
            throw new Error(
              `Monitor re-arm owner or command missing: ${record.monitor_id}`,
            );
          }
          const inboxOpts: InboxOpts = {
            ...(this.opts.inboxBaseDir
              ? { baseDir: this.opts.inboxBaseDir }
              : {}),
            ...(this.opts.monitorRegistryNow
              ? { now: this.opts.monitorRegistryNow }
              : {}),
          };
          const message = dispatchOnce(
            owner.agent_id,
            {
              id: `monitor-rearm:${record.monitor_id}:${record.last_signal_at}`,
              from: "cmuxlayer-daemon",
              tag: "monitor-rearm",
              task: `Re-arm monitor ${record.monitor_id} with this exact command, then signal_monitor after the watcher is live:\n${record.rearm_command}`,
            },
            inboxOpts,
          );
          if (
            monitorAlive(
              owner.agent_id,
              MONITOR_REARM_INBOX_HEARTBEAT_MAX_AGE_MS,
              inboxOpts,
            )
          ) {
            return;
          }
          const guardedRelay = context.lifecycleAgentInputDeliverer;
          if (!guardedRelay) {
            throw new Error("guarded agent relay is not ready");
          }
          await guardedRelay({
            agent_id: owner.agent_id,
            text: formatInboxPing(
              message,
              inboxPath(owner.agent_id, inboxOpts),
            ),
            press_enter: true,
            allow_busy: true,
            source_event: "dispatch_nudge",
          });
        },
        escalate: async (record) => {
          const ownerWedged = record.collapsed_reason === "owner-wedged";
          const notify = ownerWedged
            ? (this.opts.monitorOwnerWedgedNotify ?? (async () => false))
            : (this.opts.monitorOwnerPtyDeadNotify ?? (async () => false));
          await notify({
            title: ownerWedged
              ? "Monitor owner wedged"
              : "Monitor owner PTY dead",
            body: ownerWedged
              ? `Monitor ${record.monitor_id} collapsed because pane-alive owner ${record.owner_seat} did not acknowledge re-arm; watch_targets=${record.watch_targets.join(", ")}`
              : `Monitor ${record.monitor_id} collapsed because owner ${record.owner_seat} cannot accept terminal writes; watch_targets=${record.watch_targets.join(", ")}`,
            source: "cmuxlayer-monitor-registry",
            priority: "high",
            dedupe_key: `${record.monitor_id}:${record.collapsed_reason}`,
          });
        },
      });
  }

  private async retryFailedMonitorRearmsWhenRelayReady(): Promise<void> {
    if (this.monitorReconcileInFlight) {
      this.monitorRelayReadyPending = true;
      return;
    }
    const monitorIds = [...this.monitorReconcileFailedIds];
    if (monitorIds.length === 0) return;
    await this.runMonitorReconcile({
      rearmClaimTimeoutMs: 0,
      monitorIds,
    });
  }

  private async runMonitorReconcile(options?: {
    rearmClaimTimeoutMs?: number;
    monitorIds?: readonly string[];
  }): Promise<void> {
    if (!this.monitorReconcileFn) return;
    if (this.monitorReconcileInFlight) return;
    this.monitorReconcileInFlight = true;
    let reconcileResult: unknown;
    try {
      reconcileResult = await this.monitorReconcileFn(options);
    } catch (error) {
      this.logger.error(
        "[cmuxlayer-daemon] monitor reconciliation failed",
        error,
      );
    } finally {
      this.monitorReconcileInFlight = false;
      if (typeof reconcileResult === "object" && reconcileResult !== null) {
        const result = reconcileResult as Record<string, unknown>;
        if (Array.isArray(result.failed)) {
          for (const monitorId of result.failed) {
            if (typeof monitorId === "string") {
              this.monitorReconcileFailedIds.add(monitorId);
            }
          }
        }
        for (const key of ["rearmed", "collapsed", "reaped"] as const) {
          const outcomes = result[key];
          if (Array.isArray(outcomes)) {
            for (const outcome of outcomes) {
              const monitorId =
                typeof outcome === "string"
                  ? outcome
                  : typeof outcome === "object" &&
                      outcome !== null &&
                      "monitor_id" in outcome &&
                      typeof outcome.monitor_id === "string"
                    ? outcome.monitor_id
                    : null;
              if (monitorId) this.monitorReconcileFailedIds.delete(monitorId);
            }
          }
        }
      }
      if (this.monitorRelayReadyPending && !this.draining) {
        this.monitorRelayReadyPending = false;
        void this.retryFailedMonitorRearmsWhenRelayReady();
      }
    }
  }

  private startMonitorReconcileWatcher(): void {
    if (!this.monitorReconcileFn || this.monitorReconcileIntervalMs <= 0)
      return;
    this.monitorReconcileTimer = setInterval(() => {
      void this.runMonitorReconcile();
    }, this.monitorReconcileIntervalMs);
    this.monitorReconcileTimer.unref?.();
  }

  private clearMonitorReconcileWatcher(): void {
    if (!this.monitorReconcileTimer) return;
    clearInterval(this.monitorReconcileTimer);
    this.monitorReconcileTimer = null;
  }

  private clearStaleBuildWatcher(): void {
    if (this.staleCheckTimer) {
      clearInterval(this.staleCheckTimer);
      this.staleCheckTimer = null;
    }
  }

  private requestRetirement(
    reason: DaemonRetirementReason,
    stale?: StaleBuildResult,
  ): void {
    if (this.retirementPromise) {
      return;
    }
    if (reason === "stale-build" && stale) {
      this.logger.error(
        `[cmuxlayer-daemon] installed version bump detected (running v${stale.running}, installed v${stale.installed}); retiring`,
      );
    } else {
      this.logger.error(
        "[cmuxlayer-daemon] upstream cmux transport remained unreachable; retiring so a pane-descended respawn can reconnect",
      );
    }
    this.retirementPromise = this.shutdown(reason)
      .then(async (result) => {
        await this.opts.onRetire?.(reason, result);
      })
      .catch((error) => {
        this.logger.error("[cmuxlayer-daemon] retirement failed", error);
      });
  }

  private pauseActiveTransports(): void {
    for (const transport of this.activeTransports) {
      transport.pauseInput();
    }
  }

  private listen(options: string | { fd: number }): Promise<void> {
    const server = this.server;
    if (!server) {
      throw new Error("daemon server was not created");
    }
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      if (typeof options === "string") {
        server.listen(options, onListening);
      } else {
        server.listen(options, onListening);
      }
    });
  }

  private async closeListener(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }
    const detachedSocket = await this.detachOwnedSocketPath();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    if (detachedSocket?.restore) {
      await rename(detachedSocket.path, this.socketPath);
      return;
    }
    if (detachedSocket) {
      await unlink(detachedSocket.path).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") {
            throw error;
          }
        },
      );
    }
    await this.removeOwnedSocketPlaceholder();
  }

  /**
   * #529: `detachOwnedSocketPath()` parks an empty REGULAR FILE at the socket
   * path so a racing daemon cannot bind mid-shutdown. Nothing ever removed it,
   * so every clean shutdown (a reboot's SIGTERM included) left a leftover that
   * connect(2) answers with ENOTSOCK. Remove the placeholder once the listener
   * is closed, and never touch a real socket some successor already bound.
   */
  private async removeOwnedSocketPlaceholder(): Promise<void> {
    if (this.listenFd !== undefined || !this.ownedSocketIdentity) {
      return;
    }
    // #530 review P2-2: revalidate dev/ino immediately before the unlink, and
    // never delete an owner receipt a successor may have just written.
    let observed: DaemonSocketIdentity | null;
    try {
      const stats = await lstat(this.socketPath);
      if (stats.isSocket()) {
        // A successor already bound a real socket here. Leave it, and leave
        // its receipt, entirely alone.
        return;
      }
      observed = { dev: stats.dev, ino: stats.ino, kind: statsKind(stats) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return;
      }
      observed = null;
    }

    if (observed !== null) {
      if (!sameIdentity(await socketIdentity(this.socketPath), observed)) {
        // Replaced under us between the check and the unlink.
        return;
      }
      await unlinkIfPresent(this.socketPath).catch(() => {});
    }

    if (readDaemonSocketOwnerReceipt(this.socketPath)?.pid === process.pid) {
      await unlinkIfPresent(daemonSocketOwnerPath(this.socketPath)).catch(
        () => {},
      );
    }
  }

  private async detachOwnedSocketPath(): Promise<{
    path: string;
    restore: boolean;
  } | null> {
    if (this.listenFd !== undefined || !this.ownedSocketIdentity) {
      return null;
    }

    let current: Awaited<ReturnType<typeof lstat>>;
    try {
      current = await lstat(this.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await writeFile(this.socketPath, "", { flag: "wx" });
        return null;
      }
      throw error;
    }

    if (
      current.dev !== this.ownedSocketIdentity.dev ||
      current.ino !== this.ownedSocketIdentity.ino
    ) {
      const shelteredPath = `${this.socketPath}.foreign-${process.pid}-${Date.now()}`;
      await rename(this.socketPath, shelteredPath);
      await writeFile(this.socketPath, "", { flag: "wx" });
      return { path: shelteredPath, restore: true };
    }

    const detachedPath = `${this.socketPath}.closing-${process.pid}-${Date.now()}`;
    await rename(this.socketPath, detachedPath);
    await writeFile(this.socketPath, "", { flag: "wx" });
    return { path: detachedPath, restore: false };
  }

  private waitForDrain(): Promise<boolean> {
    if (this.inFlightRequests === 0) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.drainWaiters.delete(onDrained);
        resolve(false);
      }, this.drainTimeoutMs);

      const onDrained = () => {
        clearTimeout(timeout);
        resolve(true);
      };
      this.drainWaiters.add(onDrained);
    });
  }

  private resolveDrainWaiters(): void {
    if (this.inFlightRequests !== 0) {
      return;
    }
    for (const waiter of this.drainWaiters) {
      waiter();
    }
    this.drainWaiters.clear();
  }
}

export async function runDaemon(
  opts: CmuxLayerDaemonOptions = {},
): Promise<CmuxLayerDaemon> {
  ensureNodeMaxOldSpaceEnv();
  installHeapGuard();
  const testProcess =
    process.env.VITEST === "true" || process.env.NODE_ENV === "test";
  let exitStarted = false;
  const exitAfterShutdown = (
    reason: DaemonShutdownReason,
    result: DaemonShutdownResult,
  ) => {
    if (exitStarted) return;
    exitStarted = true;
    process.exit(daemonExitCode(reason, result));
  };
  const daemon = new CmuxLayerDaemon({
    ...opts,
    outboxDrain:
      opts.outboxDrain ??
      (testProcess
        ? async () => undefined
        : () => drainOutbox({ deliver: httpDeliver })),
    monitorRegistryNotify:
      opts.monitorRegistryNotify ??
      (testProcess ? async () => undefined : httpNotifyMonitorDeadman),
    monitorRegistryPath:
      opts.monitorRegistryPath ?? defaultMonitorRegistryPath(),
    watchRegistryPath: opts.watchRegistryPath ?? defaultWatchRegistryPath(),
    watchNotify:
      opts.watchNotify ??
      (testProcess ? async () => undefined : httpNotifyWatch),
    fleetSidebarPublisher:
      opts.fleetSidebarPublisher ??
      (testProcess ? undefined : new FleetSidebarPublisher()),
    monitorOwnerPtyDeadNotify:
      opts.monitorOwnerPtyDeadNotify ??
      (testProcess
        ? async () => false
        : (notification) => httpDeliver(notification, DEFAULT_NOTIFY_URL)),
    monitorOwnerWedgedNotify:
      opts.monitorOwnerWedgedNotify ??
      (testProcess
        ? async () => false
        : (notification) => httpDeliver(notification, DEFAULT_NOTIFY_URL)),
    onRetire: async (reason, result) => {
      await opts.onRetire?.(reason, result);
      exitAfterShutdown(reason, result);
    },
  });
  const shutdownThenExit = (signal: NodeJS.Signals) => {
    daemon
      .shutdown(signal)
      .then((result) => exitAfterShutdown(signal, result))
      .catch((error) => {
        console.error("[cmuxlayer-daemon] shutdown failed", error);
        process.exit(1);
      });
  };

  process.once("SIGTERM", shutdownThenExit);
  process.once("SIGINT", shutdownThenExit);
  await daemon.start();
  return daemon;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  // A GUI-launched client starts the daemon without a login shell, so the
  // config file is read here too rather than only in the CLI entrypoint.
  loadCmuxlayerConfigFile();
  // #529: the spawning proxy now PIPES daemon stderr so a startup failure can
  // be reported to its waiters. A piped stderr breaks when that parent exits;
  // an unhandled EPIPE there would kill an otherwise healthy shared daemon.
  process.stderr.on("error", () => {});
  runDaemon().catch((error) => {
    // #530 (Codex P1): the spawning entry reads this stderr to tell "another
    // owner holds the socket, wait for it" apart from a genuine startup
    // failure. Print the structured code so that decision is not string
    // matching on prose.
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === "string") {
      console.error(`[cmuxlayer-daemon] fatal code=${code}`);
    }
    console.error("[cmuxlayer-daemon] fatal", error);
    process.exit(1);
  });
}
