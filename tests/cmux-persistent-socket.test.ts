import net from "node:net";
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

      await expect(first).rejects.toMatchObject({ code: "protocol_error" });
      await expect(second).rejects.toMatchObject({ code: "protocol_error" });
      expect(received).toHaveLength(2);
    } finally {
      socket.disconnect();
    }
  });
});
