import { homedir } from "node:os";

export type BridgeHandshakeState = "waiting_for_initialize" | "waiting_for_initialized" | "ready";

export interface BridgeThread {
  threadId: string;
  agentId: string;
  cwd: string;
  model: string | null;
  createdAt: number;
  sessionId: string | null;
}

export interface BridgeScreenSnapshot {
  text: string;
  status: string;
  agentType: string;
}

export interface AppServerBridgeRuntime {
  startThread(input: {
    cwd: string;
    model?: string;
  }): Promise<BridgeThread>;
  readThread(threadId: string): Promise<BridgeThread | null>;
  sendTurn(input: {
    threadId: string;
    text: string;
  }): Promise<void>;
  interruptTurn(threadId: string): Promise<void>;
  readScreen(threadId: string): Promise<BridgeScreenSnapshot>;
}

type JsonRpcId = string | number;

export interface JsonRpcNotification {
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcRequest extends JsonRpcNotification {
  id?: JsonRpcId;
}

export interface JsonRpcResponse {
  id: JsonRpcId;
  result?: Record<string, unknown>;
  error?: {
    code: number;
    message: string;
  };
}

interface ActiveTurn {
  turnId: string;
  threadId: string;
  interrupted: boolean;
}

export interface CodexAppServerBridgeOptions {
  runtime: AppServerBridgeRuntime;
  emitNotification: (notification: JsonRpcNotification) => void;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  turnCompletionTimeoutMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_TURN_COMPLETION_TIMEOUT_MS = 30_000;

function makeError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return {
    id,
    error: {
      code,
      message,
    },
  };
}

function threadToWire(thread: BridgeThread): Record<string, unknown> {
  return {
    id: thread.threadId,
    preview: "",
    createdAt: thread.createdAt,
    cwd: thread.cwd,
    model: thread.model,
    modelProvider: "cmuxlayer",
    sessionId: thread.sessionId,
    status: "active",
  };
}

function extractTurnText(input: unknown): string {
  if (!Array.isArray(input)) {
    throw new Error("turn/start requires an input array.");
  }

  const parts = input
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const record = item as Record<string, unknown>;
      if (
        (record.type === "text" || record.type === "inputText") &&
        typeof record.text === "string"
      ) {
        return record.text.trim();
      }
      return null;
    })
    .filter((value): value is string => !!value);

  if (parts.length === 0) {
    throw new Error("turn/start currently supports only text input items.");
  }

  return parts.join("\n\n");
}

export class CodexAppServerBridge {
  private runtime: AppServerBridgeRuntime;
  private emitNotification: (notification: JsonRpcNotification) => void;
  private sleep: (ms: number) => Promise<void>;
  private pollIntervalMs: number;
  private turnCompletionTimeoutMs: number;
  private handshakeState: BridgeHandshakeState = "waiting_for_initialize";
  private nextTurnCounter = 1;
  private activeTurns = new Map<string, ActiveTurn>();

  constructor(opts: CodexAppServerBridgeOptions) {
    this.runtime = opts.runtime;
    this.emitNotification = opts.emitNotification;
    this.sleep =
      opts.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.turnCompletionTimeoutMs =
      opts.turnCompletionTimeoutMs ?? DEFAULT_TURN_COMPLETION_TIMEOUT_MS;
  }

  async handleMessage(message: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    if (message.method === "initialized") {
      if (this.handshakeState === "waiting_for_initialized") {
        this.handshakeState = "ready";
      }
      return null;
    }

    if (message.method === "initialize") {
      if (this.handshakeState !== "waiting_for_initialize") {
        return makeError(message.id ?? 0, -32003, "Already initialized");
      }

      this.handshakeState = "waiting_for_initialized";
      return {
        id: message.id ?? 0,
        result: {
          userAgent: "cmuxlayer-app-server/0.1.0",
          codexHome: process.env.CODEX_HOME ?? `${homedir()}/.codex`,
          platformFamily: process.platform,
          platformOs: process.platform,
        },
      };
    }

    if (this.handshakeState !== "ready") {
      return makeError(message.id ?? 0, -32002, "Not initialized");
    }

    if (message.id === undefined) {
      return null;
    }

    try {
      switch (message.method) {
        case "model/list":
          return {
            id: message.id,
            result: {
              models: [
                {
                  id: "codex",
                  title: "Codex via cmuxlayer bridge",
                  hidden: false,
                },
              ],
            },
          };
        case "account/read":
          return {
            id: message.id,
            result: {
              account: {
                type: "unknown",
                planType: null,
                sparkEnabled: true,
              },
            },
          };
        case "thread/start":
          return await this.handleThreadStart(message.id, message.params ?? {});
        case "thread/read":
          return await this.handleThreadRead(message.id, message.params ?? {});
        case "thread/resume":
          return await this.handleThreadResume(message.id, message.params ?? {});
        case "turn/start":
          return await this.handleTurnStart(message.id, message.params ?? {});
        case "turn/interrupt":
          return await this.handleTurnInterrupt(message.id, message.params ?? {});
        default:
          return makeError(message.id, -32601, `Method not found: ${message.method}`);
      }
    } catch (error) {
      return makeError(
        message.id,
        -32602,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async handleThreadStart(
    id: JsonRpcId,
    params: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    const cwd = typeof params.cwd === "string" ? params.cwd : "";
    if (!cwd) {
      throw new Error("thread/start requires params.cwd.");
    }

    const model = typeof params.model === "string" ? params.model : undefined;
    const thread = await this.runtime.startThread({ cwd, model });
    const wireThread = threadToWire(thread);

    this.emitNotification({
      method: "thread/started",
      params: { thread: wireThread },
    });

    return {
      id,
      result: {
        thread: wireThread,
      },
    };
  }

  private async handleThreadRead(
    id: JsonRpcId,
    params: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    const threadId = typeof params.threadId === "string" ? params.threadId : "";
    if (!threadId) {
      throw new Error("thread/read requires params.threadId.");
    }

    const thread = await this.runtime.readThread(threadId);
    if (!thread) {
      throw new Error(`Unknown thread: ${threadId}`);
    }

    return {
      id,
      result: {
        thread: threadToWire(thread),
      },
    };
  }

  private async handleThreadResume(
    id: JsonRpcId,
    params: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    const threadId = typeof params.threadId === "string" ? params.threadId : "";
    if (!threadId) {
      throw new Error("thread/resume requires params.threadId.");
    }

    const thread = await this.runtime.readThread(threadId);
    if (!thread) {
      throw new Error(`Unknown thread: ${threadId}`);
    }

    const wireThread = threadToWire(thread);
    this.emitNotification({
      method: "thread/started",
      params: { thread: wireThread },
    });

    return {
      id,
      result: {
        thread: wireThread,
      },
    };
  }

  private async handleTurnStart(
    id: JsonRpcId,
    params: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    const threadId = typeof params.threadId === "string" ? params.threadId : "";
    if (!threadId) {
      throw new Error("turn/start requires params.threadId.");
    }

    const text = extractTurnText(params.input);
    await this.runtime.sendTurn({ threadId, text });

    const turnId = `turn-${threadId}-${this.nextTurnCounter++}`;
    const turn = {
      id: turnId,
      threadId,
      status: "inProgress",
    };
    this.activeTurns.set(threadId, {
      turnId,
      threadId,
      interrupted: false,
    });

    this.emitNotification({
      method: "turn/started",
      params: { turn },
    });

    void this.monitorTurnCompletion(threadId, turnId);

    return {
      id,
      result: {
        turn,
      },
    };
  }

  private async handleTurnInterrupt(
    id: JsonRpcId,
    params: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    const threadId = typeof params.threadId === "string" ? params.threadId : "";
    if (!threadId) {
      throw new Error("turn/interrupt requires params.threadId.");
    }

    const active = this.activeTurns.get(threadId);
    if (active) {
      active.interrupted = true;
    }
    await this.runtime.interruptTurn(threadId);

    if (active) {
      this.activeTurns.delete(threadId);
      this.emitNotification({
        method: "turn/completed",
        params: {
          turn: {
            id: active.turnId,
            threadId,
            status: "interrupted",
          },
        },
      });
    }

    return {
      id,
      result: {},
    };
  }

  private async monitorTurnCompletion(
    threadId: string,
    turnId: string,
  ): Promise<void> {
    const startedAt = Date.now();
    let sawActive = false;

    while (Date.now() - startedAt < this.turnCompletionTimeoutMs) {
      const active = this.activeTurns.get(threadId);
      if (!active || active.turnId !== turnId) {
        return;
      }
      if (active.interrupted) {
        return;
      }

      const snapshot = await this.runtime.readScreen(threadId);
      if (snapshot.status === "working" || snapshot.status === "thinking") {
        sawActive = true;
      }

      if (sawActive && (snapshot.status === "idle" || snapshot.status === "done")) {
        this.activeTurns.delete(threadId);
        this.emitNotification({
          method: "turn/completed",
          params: {
            turn: {
              id: turnId,
              threadId,
              status: "completed",
            },
          },
        });
        return;
      }

      await this.sleep(this.pollIntervalMs);
    }

    const active = this.activeTurns.get(threadId);
    if (!active || active.turnId !== turnId || active.interrupted) {
      return;
    }

    this.activeTurns.delete(threadId);
    this.emitNotification({
      method: "turn/completed",
      params: {
        turn: {
          id: turnId,
          threadId,
          status: "failed",
        },
      },
    });
  }
}
