import { spawn, type ChildProcess } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  daemonStderrExcerpt,
  recordDaemonExit,
  recordDaemonLifecycleError,
  recordDaemonSpawnAttempt,
} from "./daemon-lifecycle-state.js";

export interface SpawnDaemonOptions {
  socketPath: string;
  env: NodeJS.ProcessEnv;
  daemonScriptPath?: string;
  logger: Pick<Console, "error">;
  /**
   * Capture the daemon's stderr so a startup failure can be reported to the
   * readiness waiters instead of vanishing (#529). Defaults to true; the
   * captured text is still forwarded to this process's stderr.
   */
  captureStderr?: boolean;
  /** Test seam for the stderr forwarder. */
  stderrSink?: (chunk: string) => void;
}

const STDERR_BUFFER_LIMIT = 8_000;
const capturedStderr = new WeakMap<object, { text: string }>();

/** Bounded excerpt of what a spawned daemon printed on stderr. */
export function capturedDaemonStderr(child: unknown): string {
  if (!child || typeof child !== "object") return "";
  return daemonStderrExcerpt(capturedStderr.get(child as object)?.text ?? "");
}

let parentStderrGuardInstalled = false;

/**
 * Install exactly ONE `error` listener on this process's stderr. Async EPIPE
 * (the MCP client going away while the daemon is still writing) would
 * otherwise surface as an unhandled 'error' event and kill the spawner. Guarded
 * by a module flag so repeated spawns cannot leak listeners.
 */
function installParentStderrErrorGuard(): void {
  if (parentStderrGuardInstalled) return;
  parentStderrGuardInstalled = true;
  process.stderr.on("error", () => {});
}

function defaultDaemonScriptPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "daemon.js");
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
  const captureStderr = opts.captureStderr !== false;
  const child = spawn(process.execPath, [daemonScriptPath], {
    detached: true,
    env,
    stdio: ["ignore", "ignore", captureStderr ? "pipe" : "inherit"],
  });
  recordDaemonSpawnAttempt({
    socketPath: opts.socketPath,
    pid: child.pid ?? null,
  });

  const buffer = { text: "" };
  capturedStderr.set(child, buffer);
  if (captureStderr && child.stderr) {
    const stderrStream = child.stderr;
    // #530 review P2-5: EPIPE on process.stderr arrives ASYNCHRONOUSLY, so a
    // try/catch around write() never sees it. Guard the stream itself, once.
    installParentStderrErrorGuard();
    const sink =
      opts.stderrSink ??
      ((chunk: string) => {
        try {
          if (!process.stderr.write(chunk)) {
            // Honor backpressure rather than buffering the daemon's output
            // without bound: pause the child until the parent drains.
            stderrStream.pause();
            process.stderr.once("drain", () => {
              if (!stderrStream.destroyed) stderrStream.resume();
            });
          }
        } catch {
          // A closed stderr must never take the spawning process down.
        }
      });
    stderrStream.setEncoding("utf8");
    stderrStream.on("data", (chunk: string) => {
      buffer.text = `${buffer.text}${chunk}`.slice(-STDERR_BUFFER_LIMIT);
      sink(chunk);
    });
    stderrStream.on("error", () => {});
    (stderrStream as unknown as { unref?: () => void }).unref?.();
  }

  child.once("error", (error) => {
    recordDaemonLifecycleError(error.message);
    opts.logger.error(
      `[cmuxlayer-proxy] spawned daemon failed (pid=${child.pid ?? "unknown"}): ${error.message}`,
    );
  });
  child.once("exit", (code, signal) => {
    recordDaemonExit({
      code,
      signal,
      pid: child.pid ?? null,
      stderrExcerpt: buffer.text,
    });
    opts.logger.error(
      `[cmuxlayer-proxy] spawned daemon exited (pid=${child.pid ?? "unknown"}, code=${code ?? "none"}, signal=${signal ?? "none"})`,
    );
  });
  const pidReceipt = env.CMUXLAYER_DAEMON_PID_RECEIPT?.trim();
  if (pidReceipt && child.pid) {
    try {
      await mkdir(dirname(pidReceipt), { recursive: true });
      await appendFile(pidReceipt, `${child.pid}\n`, "utf8");
    } catch (error) {
      child.kill("SIGKILL");
      throw error;
    }
  }
  child.unref();
  return child;
}
