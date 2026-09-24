import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { CmuxSocketClient } from "../src/cmux-socket-client.js";
import { CmuxClient } from "../src/cmux-client.js";
import { createCmuxClient } from "../src/cmux-client-factory.js";
import { initializeNewSurfaceRuntime } from "../src/surface-runtime.js";
import { startFakeCmuxSocket, writeFakeCmux } from "../scripts/bench-daemon.mjs";

it("realizes each fake split surface on input demand", async () => {
  const root = mkdtempSync(join(tmpdir(), "cmuxlayer-bench-fixture-"));
  const bin = join(root, "bin");
  const statePath = join(root, "state.json");
  const socketPath = join(root, "cmux.sock");
  mkdirSync(bin);
  await writeFakeCmux(bin);
  const server = await startFakeCmuxSocket(socketPath, statePath, 10);
  const client = new CmuxSocketClient({ socketPath });
  const metadata = () => JSON.parse(execFileSync(join(bin, "cmux"), ["--json", "debug-terminals"], {
    encoding: "utf8",
    env: {
      ...process.env,
      CMUXLAYER_BENCH_STATE: statePath,
      CMUXLAYER_BENCH_SURFACES: "10",
    },
  }));
  try {
    const refs = new Set<string>();
    for (let index = 0; index < 2; index += 1) {
      const split = await client.newSplit("right", { workspace: "workspace:bench", pane: "pane:bench" });
      expect(refs.has(split.surface)).toBe(false);
      refs.add(split.surface);
      expect(split.surface.length).toBe("surface:bench-spawn".length);
      expect(await initializeNewSurfaceRuntime({
        listTerminalMetadata: metadata,
        sendKey: (surface, key, opts) => client.sendKey(surface, key, opts),
      }, split.surface, split.workspace, 500, undefined, split.surface_id)).toBe("input_demand");
      await client.closeSurface(split.surface, { workspace: split.workspace });
    }
  } finally {
    client.disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

it("gives concurrent fake socket splits distinct identities", async () => {
  const root = mkdtempSync(join(tmpdir(), "cmuxlayer-bench-concurrent-"));
  const statePath = join(root, "state.json");
  const socketPath = join(root, "cmux.sock");
  const server = await startFakeCmuxSocket(socketPath, statePath, 10);
  const clients = Array.from({ length: 2 }, () => new CmuxSocketClient({ socketPath }));
  try {
    const splits = await Promise.all(clients.map((client) =>
      client.newSplit("right", { workspace: "workspace:bench", pane: "pane:bench" }),
    ));
    expect(new Set(splits.map((split) => split.surface)).size).toBe(splits.length);
    expect(new Set(splits.map((split) => split.surface_id)).size).toBe(splits.length);
  } finally {
    for (const client of clients) client.disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

it("realizes a split through the benchmark's socket-first transport wrapper", async () => {
  const root = mkdtempSync(join(tmpdir(), "cmuxlayer-bench-wrapper-fixture-"));
  const bin = join(root, "bin");
  const statePath = join(root, "state.json");
  const socketPath = join(root, "cmux.sock");
  mkdirSync(bin);
  await writeFakeCmux(bin);
  vi.stubEnv("CMUXLAYER_BENCH_STATE", statePath);
  vi.stubEnv("CMUXLAYER_BENCH_SURFACES", "10");
  vi.stubEnv("CMUX_SOCKET_PATH", socketPath);
  const server = await startFakeCmuxSocket(socketPath, statePath, 10);
  const client = await createCmuxClient({
    socketPath,
    bin: join(bin, "cmux"),
    logger: { error: () => undefined },
    pingRetryAttempts: 1,
  });
  try {
    const cli = new CmuxClient({
      bin: join(bin, "cmux"),
      env: {
        ...process.env,
        CMUXLAYER_BENCH_STATE: statePath,
        CMUXLAYER_BENCH_SURFACES: "10",
      },
    });
    const split = await cli.newSplit("right", { workspace: "workspace:bench", pane: "pane:bench", focus: false });
    const second = await client.newSplit("right", { workspace: "workspace:bench", pane: "pane:bench", focus: false });
    expect(second.surface).not.toBe(split.surface);
    expect(await initializeNewSurfaceRuntime({
      listTerminalMetadata: () => client.listSurfaceRuntimeMetadata!(),
      sendKey: (surface, key, opts) => client.sendKey(surface, key, opts),
    }, split.surface, split.workspace, 500, undefined, split.surface_id)).toBe("input_demand");
  } finally {
    client.disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});

it("realizes the fake split surface through the CLI fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "cmuxlayer-bench-cli-fixture-"));
  const bin = join(root, "bin");
  const statePath = join(root, "state.json");
  mkdirSync(bin);
  await writeFakeCmux(bin);
  const client = new CmuxClient({
    bin: join(bin, "cmux"),
    env: {
      ...process.env,
      CMUXLAYER_BENCH_STATE: statePath,
      CMUXLAYER_BENCH_SURFACES: "10",
    },
  });
  try {
    const split = await client.newSplit("right", { workspace: "workspace:bench" });
    expect(await initializeNewSurfaceRuntime(client, split.surface, split.workspace, 500, undefined, split.surface_id))
      .toBe("input_demand");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
