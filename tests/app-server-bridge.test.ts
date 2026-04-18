import { describe, expect, it, vi } from "vitest";
import {
  CodexAppServerBridge,
  type AppServerBridgeRuntime,
  type BridgeThread,
} from "../src/app-server-bridge.js";

function makeThread(overrides?: Partial<BridgeThread>): BridgeThread {
  return {
    threadId: "agent-1",
    agentId: "agent-1",
    cwd: "/Users/etanheyman/Gits/brainlayer",
    model: "gpt-5.4",
    createdAt: 1_776_484_800,
    sessionId: "session-1",
    ...overrides,
  };
}

function createRuntime(
  overrides?: Partial<AppServerBridgeRuntime>,
): AppServerBridgeRuntime {
  return {
    startThread: vi.fn().mockResolvedValue(makeThread()),
    readThread: vi.fn().mockResolvedValue(makeThread()),
    sendTurn: vi.fn().mockResolvedValue(undefined),
    interruptTurn: vi.fn().mockResolvedValue(undefined),
    readScreen: vi
      .fn()
      .mockResolvedValue({ text: "codex>\n", status: "idle", agentType: "codex" }),
    ...overrides,
  };
}

describe("CodexAppServerBridge handshake", () => {
  it("rejects requests before initialize + initialized", async () => {
    const bridge = new CodexAppServerBridge({
      runtime: createRuntime(),
      emitNotification: () => {},
      sleep: async () => {},
      pollIntervalMs: 0,
    });

    const beforeInit = await bridge.handleMessage({
      id: 1,
      method: "thread/start",
      params: {},
    });

    expect(beforeInit).toEqual({
      id: 1,
      error: expect.objectContaining({
        code: -32002,
        message: "Not initialized",
      }),
    });

    const initialized = await bridge.handleMessage({
      id: 2,
      method: "initialize",
      params: {
        clientInfo: { name: "test-client", title: "Test Client", version: "0.1.0" },
      },
    });

    expect(initialized).toEqual({
      id: 2,
      result: expect.objectContaining({
        userAgent: expect.stringContaining("cmuxlayer-app-server"),
        platformOs: expect.any(String),
      }),
    });

    const beforeAck = await bridge.handleMessage({
      id: 3,
      method: "thread/start",
      params: {},
    });

    expect(beforeAck).toEqual({
      id: 3,
      error: expect.objectContaining({
        code: -32002,
        message: "Not initialized",
      }),
    });

    const ack = await bridge.handleMessage({
      method: "initialized",
    });

    expect(ack).toBeNull();
  });

  it("rejects repeated initialize requests", async () => {
    const bridge = new CodexAppServerBridge({
      runtime: createRuntime(),
      emitNotification: () => {},
      sleep: async () => {},
      pollIntervalMs: 0,
    });

    await bridge.handleMessage({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "test-client", title: "Test Client", version: "0.1.0" },
      },
    });

    const repeated = await bridge.handleMessage({
      id: 2,
      method: "initialize",
      params: {
        clientInfo: { name: "test-client", title: "Test Client", version: "0.1.0" },
      },
    });

    expect(repeated).toEqual({
      id: 2,
      error: expect.objectContaining({
        code: -32003,
        message: "Already initialized",
      }),
    });
  });
});

describe("CodexAppServerBridge thread lifecycle", () => {
  it("starts a thread and emits thread/started", async () => {
    const notifications: Array<Record<string, unknown>> = [];
    const runtime = createRuntime();
    const bridge = new CodexAppServerBridge({
      runtime,
      emitNotification: (message) => notifications.push(message),
      sleep: async () => {},
      pollIntervalMs: 0,
    });

    await bridge.handleMessage({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "test-client", title: "Test Client", version: "0.1.0" },
      },
    });
    await bridge.handleMessage({ method: "initialized" });

    const started = await bridge.handleMessage({
      id: 2,
      method: "thread/start",
      params: {
        cwd: "/Users/etanheyman/Gits/brainlayer",
        model: "gpt-5.4",
      },
    });

    expect(runtime.startThread).toHaveBeenCalledWith({
      cwd: "/Users/etanheyman/Gits/brainlayer",
      model: "gpt-5.4",
    });
    expect(started).toEqual({
      id: 2,
      result: {
        thread: expect.objectContaining({
          id: "agent-1",
          modelProvider: "cmuxlayer",
          cwd: "/Users/etanheyman/Gits/brainlayer",
        }),
      },
    });
    expect(notifications).toContainEqual({
      method: "thread/started",
      params: {
        thread: expect.objectContaining({
          id: "agent-1",
        }),
      },
    });
  });

  it("resumes a known thread", async () => {
    const runtime = createRuntime({
      readThread: vi.fn().mockResolvedValue(makeThread({ threadId: "agent-42" })),
    });
    const bridge = new CodexAppServerBridge({
      runtime,
      emitNotification: () => {},
      sleep: async () => {},
      pollIntervalMs: 0,
    });

    await bridge.handleMessage({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "test-client", title: "Test Client", version: "0.1.0" },
      },
    });
    await bridge.handleMessage({ method: "initialized" });

    const resumed = await bridge.handleMessage({
      id: 2,
      method: "thread/resume",
      params: { threadId: "agent-42" },
    });

    expect(runtime.readThread).toHaveBeenCalledWith("agent-42");
    expect(resumed).toEqual({
      id: 2,
      result: {
        thread: expect.objectContaining({
          id: "agent-42",
        }),
      },
    });
  });
});

describe("CodexAppServerBridge turn lifecycle", () => {
  it("sends a turn and emits turn/started then turn/completed when the codex prompt returns", async () => {
    const notifications: Array<Record<string, unknown>> = [];
    const runtime = createRuntime({
      readScreen: vi
        .fn()
        .mockResolvedValueOnce({
          text: "Working (1s • esc to interrupt)\n",
          status: "working",
          agentType: "codex",
        })
        .mockResolvedValueOnce({
          text: "codex>\n",
          status: "idle",
          agentType: "codex",
        }),
    });
    const bridge = new CodexAppServerBridge({
      runtime,
      emitNotification: (message) => notifications.push(message),
      sleep: async () => {},
      pollIntervalMs: 0,
      turnCompletionTimeoutMs: 10,
    });

    await bridge.handleMessage({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "test-client", title: "Test Client", version: "0.1.0" },
      },
    });
    await bridge.handleMessage({ method: "initialized" });

    const response = await bridge.handleMessage({
      id: 2,
      method: "turn/start",
      params: {
        threadId: "agent-1",
        input: [
          { type: "text", text: "First line" },
          { type: "text", text: "Second line" },
        ],
      },
    });

    expect(runtime.sendTurn).toHaveBeenCalledWith({
      threadId: "agent-1",
      text: "First line\n\nSecond line",
    });
    expect(response).toEqual({
      id: 2,
      result: {
        turn: expect.objectContaining({
          id: expect.stringMatching(/^turn-agent-1-/),
          status: "inProgress",
          threadId: "agent-1",
        }),
      },
    });
    expect(notifications).toContainEqual({
      method: "turn/started",
      params: {
        turn: expect.objectContaining({
          threadId: "agent-1",
          status: "inProgress",
        }),
      },
    });

    await vi.waitFor(() =>
      expect(notifications).toContainEqual({
        method: "turn/completed",
        params: {
          turn: expect.objectContaining({
            threadId: "agent-1",
            status: "completed",
          }),
        },
      }),
    );
  });

  it("interrupts the active turn and emits an interrupted completion", async () => {
    const notifications: Array<Record<string, unknown>> = [];
    const runtime = createRuntime({
      readScreen: vi.fn().mockResolvedValue({
        text: "Working (1s • esc to interrupt)\n",
        status: "working",
        agentType: "codex",
      }),
    });
    const bridge = new CodexAppServerBridge({
      runtime,
      emitNotification: (message) => notifications.push(message),
      sleep: async () => {},
      pollIntervalMs: 0,
      turnCompletionTimeoutMs: 50,
    });

    await bridge.handleMessage({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "test-client", title: "Test Client", version: "0.1.0" },
      },
    });
    await bridge.handleMessage({ method: "initialized" });

    await bridge.handleMessage({
      id: 2,
      method: "turn/start",
      params: {
        threadId: "agent-1",
        input: [{ type: "text", text: "interrupt me" }],
      },
    });

    const interrupt = await bridge.handleMessage({
      id: 3,
      method: "turn/interrupt",
      params: {
        threadId: "agent-1",
      },
    });

    expect(runtime.interruptTurn).toHaveBeenCalledWith("agent-1");
    expect(interrupt).toEqual({
      id: 3,
      result: {},
    });

    await vi.waitFor(() =>
      expect(notifications).toContainEqual({
        method: "turn/completed",
        params: {
          turn: expect.objectContaining({
            threadId: "agent-1",
            status: "interrupted",
          }),
        },
      }),
    );
  });
});
