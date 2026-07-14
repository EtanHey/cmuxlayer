import * as net from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveCmuxObserverEpoch,
  deriveCmuxObserverIdentity,
  deriveCmuxObserverOwnerId,
} from "../src/cmux-observer-identity.js";

const servers: net.Server[] = [];
const tempDirs: string[] = [];

async function listen(path: string): Promise<net.Server> {
  const server = net.createServer();
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

async function close(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const index = servers.indexOf(server);
  if (index >= 0) servers.splice(index, 1);
}

describe("cmux observer identity", () => {
  afterEach(async () => {
    await Promise.allSettled(servers.splice(0).map(close));
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("changes the owner when cmux rebinds the same socket path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cmux-observer-owner-"));
    tempDirs.push(dir);
    const socketPath = join(dir, "cmux.sock");
    const client = {
      currentSocketPath: () => socketPath,
      currentObserverTransportEpoch: () => "route:0",
    };

    const firstServer = await listen(socketPath);
    const first = deriveCmuxObserverIdentity(client);
    expect(first).not.toBeNull();
    expect(first?.ownerId).toContain(socketPath);
    expect(first?.epoch).toBe(`${first?.ownerId}@route:0`);
    expect(deriveCmuxObserverOwnerId(client)).toBe(first?.ownerId);
    expect(deriveCmuxObserverEpoch(client)).toBe(first?.epoch);

    await close(firstServer);
    const secondServer = await listen(socketPath);
    const second = deriveCmuxObserverIdentity(client);

    expect(second?.ownerId).not.toBe(first?.ownerId);
    expect(second?.epoch).not.toBe(first?.epoch);
    await close(secondServer);
  });

  it("changes only the transient epoch when a client reconnects to the same socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cmux-observer-epoch-"));
    tempDirs.push(dir);
    const socketPath = join(dir, "cmux.sock");
    await listen(socketPath);
    let transportEpoch = "route:0";
    const client = {
      currentSocketPath: () => socketPath,
      currentObserverTransportEpoch: () => transportEpoch,
    };

    const first = deriveCmuxObserverIdentity(client);
    transportEpoch = "route:1";
    const second = deriveCmuxObserverIdentity(client);

    expect(second?.ownerId).toBe(first?.ownerId);
    expect(second?.epoch).not.toBe(first?.epoch);
  });

  it("fails closed when the path is missing, is not a socket, or a client identity hook fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "cmux-observer-invalid-"));
    tempDirs.push(dir);
    const plainFile = join(dir, "not-a-socket");
    writeFileSync(plainFile, "not a socket", "utf8");

    expect(
      deriveCmuxObserverIdentity({ currentSocketPath: () => join(dir, "missing") }),
    ).toBeNull();
    expect(
      deriveCmuxObserverIdentity({ currentSocketPath: () => plainFile }),
    ).toBeNull();
    expect(
      deriveCmuxObserverIdentity({
        currentSocketPath: () => {
          throw new Error("unknown route");
        },
      }),
    ).toBeNull();
  });

  it("treats truthy primitive clients as hook-free instead of applying in to them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cmux-observer-primitive-"));
    tempDirs.push(dir);
    const socketPath = join(dir, "cmux.sock");
    await listen(socketPath);

    for (const client of ["client", 42, true, Symbol("client")]) {
      expect(deriveCmuxObserverIdentity(client, socketPath)).toMatchObject({
        epoch: expect.stringMatching(/@static$/),
      });
    }
  });
});
