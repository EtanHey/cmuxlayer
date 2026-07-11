import { spawn, type ChildProcess } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface SpawnDaemonOptions {
  socketPath: string;
  env: NodeJS.ProcessEnv;
  daemonScriptPath?: string;
  logger: Pick<Console, "error">;
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
  const child = spawn(process.execPath, [daemonScriptPath], {
    detached: true,
    env,
    stdio: ["ignore", "ignore", "inherit"],
  });
  child.once("error", (error) => {
    opts.logger.error(
      `[cmuxlayer-proxy] spawned daemon failed (pid=${child.pid ?? "unknown"}): ${error.message}`,
    );
  });
  child.once("exit", (code, signal) => {
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
