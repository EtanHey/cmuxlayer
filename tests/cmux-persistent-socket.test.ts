import net from "node:net";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CmuxPersistentSocket } from "../src/cmux-persistent-socket.js";

const TEST_ROOT = join("/tmp", "cmux-persistent-socket-test");
const servers: net.Server[] = [];

function socketPath(name: string): string {
  return join(TEST_ROOT, `${name}-${process.pid}-${Date.now()}.sock`);
}

function stopServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function startLineServer(
  path: string,
  onLine: (line: string, conn: net.Socket) => void,
): Promise<net.Server> {
  rmSync(path, { force: true });
  const server = net.createServer((conn) => {
    let buffer = "";
    conn.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim()) {
          onLine(line, conn);
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  servers.push(server);
  return server;
}

describe("CmuxPersistentSocket V1 demux", () => {
  afterEach(async () => {
    await Promise.allSettled(servers.splice(0).map(stopServer));
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("rejects a JSON-like malformed frame instead of resolving the pending V1 request", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("malformed-v1");
    const received: string[] = [];
    await startLineServer(path, (line, conn) => {
      received.push(line);
      if (received.length === 1) {
        conn.write('{"id":\n');
        return;
      }
      conn.write("OK\n");
    });

    const socket = new CmuxPersistentSocket({
      socketPath: path,
      timeoutMs: 500,
    });

    try {
      await expect(socket.sendLine("set_status first active")).rejects.toMatchObject(
        { code: "protocol_error" },
      );
      const second = socket.sendLine("set_status second active");

      await expect(second).resolves.toBe("OK");
      expect(received).toEqual([
        "set_status first active",
        "set_status second active",
      ]);
    } finally {
      socket.disconnect();
    }
  });

  it("rejects malformed object frames as V2 errors before unrelated queued V1 commands", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("malformed-v2");
    const received: string[] = [];
    await startLineServer(path, (line, conn) => {
      received.push(line);
      if (received.length === 2) {
        conn.write('{"id":\n');
        conn.write("OK\n");
      }
    });

    const socket = new CmuxPersistentSocket({
      socketPath: path,
      timeoutMs: 500,
    });

    try {
      const v1 = socket.sendLine("set_status first active");
      const v2 = socket.call("list_panes");

      await expect(v2).rejects.toMatchObject({ code: "protocol_error" });
      await expect(v1).resolves.toBe("OK");
      expect(received).toHaveLength(2);
      expect(received).toContain("set_status first active");
      const v2Request = received.find((line) => line.startsWith("{"));
      expect(JSON.parse(v2Request ?? "")).toMatchObject({
        method: "list_panes",
      });
    } finally {
      socket.disconnect();
    }
  });

  it("passes through bracket-prefixed plain V1 replies", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("bracket-v1");
    await startLineServer(path, (_line, conn) => {
      conn.write("[busy] retry later\n");
    });

    const socket = new CmuxPersistentSocket({
      socketPath: path,
      timeoutMs: 500,
    });

    try {
      await expect(socket.sendLine("set_status first active")).resolves.toBe(
        "[busy] retry later",
      );
    } finally {
      socket.disconnect();
    }
  });

  it("rejects every pending V2 request when an uncorrelatable object frame is malformed", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("malformed-v2-only");
    const received: string[] = [];
    await startLineServer(path, (line, conn) => {
      received.push(line);
      if (received.length === 2) {
        conn.write('{"id":\n');
      }
    });

    const socket = new CmuxPersistentSocket({
      socketPath: path,
      timeoutMs: 500,
    });

    try {
      const first = socket.call("list_workspaces");
      const second = socket.call("list_panes");

      const results = await Promise.allSettled([first, second]);
      expect(results).toEqual([
        expect.objectContaining({
          status: "rejected",
          reason: expect.objectContaining({ code: "protocol_error" }),
        }),
        expect.objectContaining({
          status: "rejected",
          reason: expect.objectContaining({ code: "protocol_error" }),
        }),
      ]);
      expect(received).toHaveLength(2);
    } finally {
      socket.disconnect();
    }
  });

  it("does not let late V2 responses complete a queued V1 request after malformed V2 rejection", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("late-v2-after-malformed");
    const v2Ids: string[] = [];
    await startLineServer(path, (line, conn) => {
      if (line.startsWith("{")) {
        const parsed = JSON.parse(line) as { id: string };
        v2Ids.push(parsed.id);
        if (v2Ids.length === 2) {
          conn.write('{"id":\n');
        }
        return;
      }
      conn.write(
        `${JSON.stringify({ id: v2Ids[0], ok: true, result: { stale: true } })}\n`,
      );
      conn.write("OK\n");
    });

    const socket = new CmuxPersistentSocket({
      socketPath: path,
      timeoutMs: 500,
    });

    try {
      const first = socket.call("list_workspaces");
      const second = socket.call("list_panes");
      const results = await Promise.allSettled([first, second]);
      expect(results).toEqual([
        expect.objectContaining({
          status: "rejected",
          reason: expect.objectContaining({ code: "protocol_error" }),
        }),
        expect.objectContaining({
          status: "rejected",
          reason: expect.objectContaining({ code: "protocol_error" }),
        }),
      ]);

      await expect(socket.sendLine("set_status after malformed")).resolves.toBe(
        "OK",
      );
    } finally {
      socket.disconnect();
    }
  });

  it("attaches a socket error listener before writing each V2 payload", async () => {
    const events: string[] = [];
    let capturedPayload = "";
    class FakeSocket extends EventEmitter {
      destroyed = false;

      once(event: string, listener: (...args: unknown[]) => void): this {
        if (event === "error") events.push("once:error");
        return super.once(event, listener);
      }

      write(payload: string, callback?: () => void): boolean {
        events.push("write");
        capturedPayload = payload;
        callback?.();
        return true;
      }

      destroy(): void {
        this.destroyed = true;
      }
    }

    const socket = new CmuxPersistentSocket({ timeoutMs: 500 });
    (socket as unknown as { connected: boolean }).connected = true;
    (socket as unknown as { socket: FakeSocket }).socket = new FakeSocket();

    const result = socket.call("system.ping");
    await Promise.resolve();
    expect(capturedPayload).toContain("system.ping");
    expect(events.slice(0, 2)).toEqual(["once:error", "write"]);
    const request = JSON.parse(capturedPayload.trim()) as { id: string };
    (
      socket as unknown as {
        buffer: string;
        processBuffer: () => void;
      }
    ).buffer = `${JSON.stringify({
      id: request.id,
      ok: true,
      result: { pong: true },
    })}\n`;
    (
      socket as unknown as {
        processBuffer: () => void;
      }
    ).processBuffer();
    await expect(result).resolves.toEqual({ pong: true });
    socket.disconnect();
  });

  it("rejects and clears pending V2 state when a write throws EPIPE", async () => {
    class ThrowingSocket extends EventEmitter {
      destroyed = false;

      write(): boolean {
        const error = new Error("write EPIPE");
        (error as NodeJS.ErrnoException).code = "EPIPE";
        throw error;
      }

      destroy(): void {
        this.destroyed = true;
      }
    }

    const socket = new CmuxPersistentSocket({ timeoutMs: 500 });
    (socket as unknown as { connected: boolean }).connected = true;
    (socket as unknown as { socket: ThrowingSocket }).socket =
      new ThrowingSocket();

    await expect(socket.call("system.ping")).rejects.toMatchObject({
      name: "CmuxSocketError",
      code: "connection_error",
    });
    expect(
      (socket as unknown as { pending: Map<string, unknown> }).pending.size,
    ).toBe(0);
    socket.disconnect();
  });
});
