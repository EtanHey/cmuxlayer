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

interface Settled {
  promise: Promise<void>;
  resolve: () => void;
}

function createSettled(): Settled {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const stderrDrained = new WeakMap<object, Promise<void>>();

/**
 * Wait, briefly, for a dead child's stderr to finish arriving (#530).
 *
 * A daemon that refuses the socket prints its marker and calls
 * `process.exit(1)` immediately, so `exit` can beat the pipe and leave the
 * excerpt empty. `close` fires only once stdio is done — this waits for that,
 * bounded, so a child that never closes cannot stall readiness.
 */
export async function awaitDaemonStderrDrained(
  child: unknown,
  timeoutMs = 300,
): Promise<void> {
  if (!child || typeof child !== "object") return;
  const drained = stderrDrained.get(child as object);
  if (!drained) return;
  let timer: NodeJS.Timeout | null = null;
  await Promise.race([
    drained,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
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
  const stderrSettled = createSettled();
  stderrDrained.set(child, stderrSettled.promise);
  if (captureStderr && child.stderr) {
    const stderrStream = child.stderr;
    // #530 review P2-5: EPIPE on process.stderr arrives ASYNCHRONOUSLY, so a
    // try/catch around write() never sees it. Guard the stream itself, once.
    installParentStderrErrorGuard();
    // #530 final pass F1: pausing on backpressure and resuming ONLY on `drain`
    // introduced a NEW hang. An errored writable never emits `drain`, and the
    // error guard swallows the error — so the child stayed paused forever, its
    // 64KB stderr pipe filled, and the daemon blocked in write(2). Resume on
    // `error` and `close` too, and stop forwarding once the destination is
    // broken (capture is unaffected: the excerpt buffer is fed separately).
    let forwardingBroken = false;
    const resumeStderr = () => {
      if (!stderrStream.destroyed) stderrStream.resume();
    };
    const breakForwarding = () => {
      forwardingBroken = true;
      resumeStderr();
    };
    process.stderr.once("error", breakForwarding);
    process.stderr.once("close", breakForwarding);
    // #530 (CodeRabbit): these fire only on a BROKEN destination, so after a
    // normal child exit they would stay attached forever. runDaemonFirstEntry
    // can spawn several times (autostart, handoff respawn, version bump), and
    // ten spawns would trip MaxListenersExceededWarning on the very stderr
    // channel that carries daemon diagnostics. Detach when the child's stderr
    // closes.
    const detachParentStderrListeners = () => {
      process.stderr.off("error", breakForwarding);
      process.stderr.off("close", breakForwarding);
      process.stderr.off("drain", resumeStderr);
    };
    stderrStream.once("close", detachParentStderrListeners);
    stderrStream.once("end", detachParentStderrListeners);
    const sink =
      opts.stderrSink ??
      ((chunk: string) => {
        if (forwardingBroken) return;
        try {
          if (!process.stderr.write(chunk)) {
            // Honor backpressure rather than buffering the daemon's output
            // without bound: pause the child until the parent drains.
            stderrStream.pause();
            process.stderr.once("drain", resumeStderr);
          }
        } catch {
          // A closed stderr must never take the spawning process down.
          breakForwarding();
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
  // #536 review (Macroscope): the lifecycle record used to be written from the
  // `exit` handler, which snapshots `buffer.text` BEFORE the stderr pipe has
  // drained — so a daemon that printed its fatal and died immediately left an
  // empty `stderr_excerpt`, losing exactly the evidence #529 needed. `close`
  // fires only after stdio is complete, so the record is written there.
  //
  // #537 review (Codex P2): the fallback below must be PROVISIONAL. If the
  // child's stream is paused by backpressure, `exit` can fire while `close` is
  // still pending on unread pipe data — and a fallback that marked the exit
  // permanently recorded would refuse to let `close` replace a partial excerpt
  // with the fully drained one, dropping exactly the fatal tail this exists to
  // keep. `close` always upgrades a provisional record.
  let exitRecordState: "none" | "provisional" | "final" = "none";
  const recordExitOnce = (
    code: number | null,
    signal: NodeJS.Signals | null,
    final: boolean,
  ) => {
    if (exitRecordState === "final") return;
    if (exitRecordState === "provisional" && !final) return;
    exitRecordState = final ? "final" : "provisional";
    recordDaemonExit({
      code,
      signal,
      pid: child.pid ?? null,
      stderrExcerpt: buffer.text,
    });
  };
  child.once("close", (code, signal) => {
    stderrSettled.resolve();
    recordExitOnce(code ?? child.exitCode, signal ?? child.signalCode, true);
  });
  child.once("exit", (code, signal) => {
    // `close` never fires when stderr was inherited rather than piped, so the
    // exit path still records — bounded, and de-duplicated by the flag above.
    if (!captureStderr) {
      recordExitOnce(code, signal, true);
    } else {
      setTimeout(() => recordExitOnce(code, signal, false), 300).unref?.();
    }
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
