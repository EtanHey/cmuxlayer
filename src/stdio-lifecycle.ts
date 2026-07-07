import type { EventEmitter } from "node:events";

export type StdioShutdownReason =
  | "stdin:end"
  | "stdin:close"
  | "stdin:error"
  | "transport:close";

export interface StdioLifecycleOptions {
  stdin: EventEmitter;
  transport: Partial<EventEmitter> & { onclose?: () => void };
  shutdown: (reason: StdioShutdownReason) => void;
}

export function bindStdioLifecycle(opts: StdioLifecycleOptions): void {
  let shuttingDown = false;
  const shutdown = (reason: StdioShutdownReason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    opts.shutdown(reason);
  };

  opts.stdin.once("end", () => shutdown("stdin:end"));
  opts.stdin.once("close", () => shutdown("stdin:close"));
  opts.stdin.once("error", () => shutdown("stdin:error"));

  const previousOnClose = opts.transport.onclose;
  opts.transport.onclose = () => {
    previousOnClose?.();
    shutdown("transport:close");
  };
  opts.transport.once?.("close", () => shutdown("transport:close"));
}
