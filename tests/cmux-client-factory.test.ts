/**
 * Tests for createCmuxClient instance selection:
 *  - CMUX_SOCKET_PATH is an authoritative pin (never fall through to another
 *    live cmux instance — the "panes opened in a different cmux app" bug).
 *  - When unpinned, warn only when more than one cmux instance is actually
 *    LIVE, so the warning means real ambiguity, not just a multi-path list.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCmuxClient } from "../src/cmux-client-factory.js";
import { stateSocketPath } from "../src/cmux-socket-path.js";
import { getTransportHealth } from "../src/cmux-transport-self-heal.js";

const CAN_BIND_MOCK_SOCKET = process.env.CODEX_SANDBOX !== "seatbelt";

function startPingServer(socketPath: string): Promise<net.Server> {
  return new Promise((resolve) => {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      /* ignore */
    }
    const connections = new Set<net.Socket>();
    const server = net.createServer((conn) => {
      connections.add(conn);
      conn.on("close", () => connections.delete(conn));
      let buffer = "";
      conn.on("data", (chunk) => {
        buffer += chunk.toString("utf-8");
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (!line.trim()) continue;
          const req = JSON.parse(line);
          conn.write(
            JSON.stringify({ id: req.id, ok: true, result: { pong: true } }) +
              "\n",
          );
        }
      });
    });
    (server as unknown as { _conns: Set<net.Socket> })._conns = connections;
    server.listen(socketPath, () => resolve(server));
  });
}

function stopPingServer(server: net.Server, socketPath: string): Promise<void> {
  return new Promise((resolve) => {
    const conns = (server as unknown as { _conns: Set<net.Socket> })._conns;
    for (const conn of conns ?? []) conn.destroy();
    server.close(() => {
      try {
        fs.unlinkSync(socketPath);
      } catch {
        /* ignore */
      }
      resolve();
    });
  });
}

describe.skipIf(!CAN_BIND_MOCK_SOCKET)(
  "createCmuxClient instance selection",
  () => {
    let savedEnv: string | undefined;
    let savedBundleEnv: string | undefined;
    const servers: Array<{ server: net.Server; path: string }> = [];

    afterEach(async () => {
      if (savedEnv === undefined) {
        delete process.env.CMUX_SOCKET_PATH;
      } else {
        process.env.CMUX_SOCKET_PATH = savedEnv;
      }
      savedEnv = undefined;
      if (savedBundleEnv === undefined) {
        delete process.env.CMUX_BUNDLE_ID;
      } else {
        process.env.CMUX_BUNDLE_ID = savedBundleEnv;
      }
      savedBundleEnv = undefined;
      for (const { server, path } of servers.splice(0)) {
        await stopPingServer(server, path);
      }
    });

    function track(server: net.Server, path: string): void {
      servers.push({ server, path });
    }

    it("pins to CMUX_SOCKET_PATH and never falls through to another live instance", async () => {
      const stateDir = mkdtempSync(join(tmpdir(), "cmux-factory-"));
      const otherInstance = join(stateDir, "cmux-other.sock");
      fs.writeFileSync(
        join(stateDir, "last-socket-path"),
        `${otherInstance}\n`,
        "utf-8",
      );
      track(await startPingServer(otherInstance), otherInstance);

      savedEnv = process.env.CMUX_SOCKET_PATH;
      // Pin points at the instance we run under, but it is down right now.
      process.env.CMUX_SOCKET_PATH = join(stateDir, "cmux-mine-down.sock");
      const logger = { error: vi.fn() };

      const client = await createCmuxClient({
        socketStateDir: stateDir,
        logger,
      });

      // Authoritative pin: a down pin falls back to CLI, NOT the other live one.
      expect(getTransportHealth(client)).toMatchObject({
        mode: "cli",
        degraded: true,
      });
      expect(logger.error).not.toHaveBeenCalledWith(
        expect.stringContaining(otherInstance),
      );
      fs.rmSync(stateDir, { recursive: true, force: true });
    });

    it("binds to the pinned instance when it is live", async () => {
      const stateDir = mkdtempSync(join(tmpdir(), "cmux-factory-"));
      const mine = join(stateDir, "cmux-mine.sock");
      track(await startPingServer(mine), mine);
      savedEnv = process.env.CMUX_SOCKET_PATH;
      process.env.CMUX_SOCKET_PATH = mine;
      const logger = { error: vi.fn() };

      const client = await createCmuxClient({
        socketStateDir: stateDir,
        logger,
      });

      expect(getTransportHealth(client)).toMatchObject({
        mode: "socket",
        degraded: false,
        current_socket_path: mine,
      });
      // Pinned: no ambiguity warning even though it bound to a socket.
      expect(logger.error).not.toHaveBeenCalledWith(
        expect.stringContaining("live cmux sockets found"),
      );
      fs.rmSync(stateDir, { recursive: true, force: true });
    });

    it("uses the Nightly upstream marker for an unpinned Nightly bundle", async () => {
      const stateDir = mkdtempSync(join(tmpdir(), "cmux-factory-nightly-"));
      const production = join(stateDir, "cmux-production.sock");
      const nightly = join(stateDir, "cmux-nightly.sock");
      fs.writeFileSync(
        join(stateDir, "last-socket-path"),
        `${production}\n`,
        "utf-8",
      );
      fs.writeFileSync(
        join(stateDir, "nightly-last-socket-path"),
        `${nightly}\n`,
        "utf-8",
      );
      track(await startPingServer(production), production);
      track(await startPingServer(nightly), nightly);
      savedEnv = process.env.CMUX_SOCKET_PATH;
      savedBundleEnv = process.env.CMUX_BUNDLE_ID;
      delete process.env.CMUX_SOCKET_PATH;
      process.env.CMUX_BUNDLE_ID = "com.cmuxterm.app.nightly";

      const client = await createCmuxClient({ socketStateDir: stateDir });

      expect(getTransportHealth(client)).toMatchObject({
        mode: "socket",
        degraded: false,
        current_socket_path: nightly,
      });
      if ("stop" in client && typeof client.stop === "function") {
        client.stop();
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    });

    it("warns when more than one cmux instance is live and nothing is pinned", async () => {
      const stateDir = mkdtempSync(join(tmpdir(), "cmux-factory-"));
      const first = join(stateDir, "cmux-first.sock");
      fs.writeFileSync(
        join(stateDir, "last-socket-path"),
        `${first}\n`,
        "utf-8",
      );
      track(await startPingServer(first), first);
      // A second, independently live instance reachable via stateSocketPath.
      const second = stateSocketPath(stateDir);
      track(await startPingServer(second), second);

      savedEnv = process.env.CMUX_SOCKET_PATH;
      delete process.env.CMUX_SOCKET_PATH;
      const logger = { error: vi.fn() };

      const client = await createCmuxClient({
        socketStateDir: stateDir,
        logger,
      });

      expect(getTransportHealth(client)).toMatchObject({
        mode: "socket",
        degraded: false,
        current_socket_path: first,
      });
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("live cmux sockets found"),
      );
      // Bound to the first (highest-priority) live candidate, and named it.
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(first));
      fs.rmSync(stateDir, { recursive: true, force: true });
    });

    it("does not warn when only one cmux instance is live and unpinned", async () => {
      const stateDir = mkdtempSync(join(tmpdir(), "cmux-factory-"));
      const only = join(stateDir, "cmux-only.sock");
      fs.writeFileSync(
        join(stateDir, "last-socket-path"),
        `${only}\n`,
        "utf-8",
      );
      track(await startPingServer(only), only);

      savedEnv = process.env.CMUX_SOCKET_PATH;
      delete process.env.CMUX_SOCKET_PATH;
      const logger = { error: vi.fn() };

      const client = await createCmuxClient({
        socketStateDir: stateDir,
        logger,
      });

      expect(getTransportHealth(client)).toMatchObject({
        mode: "socket",
        degraded: false,
        current_socket_path: only,
      });
      expect(logger.error).not.toHaveBeenCalledWith(
        expect.stringContaining("live cmux sockets found"),
      );
      fs.rmSync(stateDir, { recursive: true, force: true });
    });
  },
);
