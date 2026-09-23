import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { CmuxSocketClient } from "../src/cmux-socket-client.js";
import { CmuxClient } from "../src/cmux-client.js";
import { createCmuxClient } from "../src/cmux-client-factory.js";
import { initializeNewSurfaceRuntime } from "../src/surface-runtime.js";
import { measureFakeCmuxPing, startFakeCmuxSocket, writeFakeCmux } from "../scripts/bench-daemon.mjs";

it("reports actual fake-socket timer overrun without counting connection time", async () => {
  const root = mkdtempSync(join(tmpdir(), "cmuxlayer-bench-control-"));
  const server = await startFakeCmuxSocket(join(root, "cmux.sock"), join(root, "state.json"), 10);
  try {
    const ping = await measureFakeCmuxPing(join(root, "cmux.sock"));
    expect(ping.total_ms).toBeGreaterThanOrEqual(1);
    expect(ping.timer_due_at_ms - ping.timer_started_at_ms).toBe(1);
    expect(ping.timer_fired_at_ms).toBeGreaterThanOrEqual(ping.timer_due_at_ms);
    expect(ping.timer_overrun_ms).toBeCloseTo(
      ping.timer_fired_at_ms - ping.timer_due_at_ms, 5);
    expect(ping.started_at_ms).toBeGreaterThan(0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

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
      const panes = (await client.listPanes({ workspace: split.workspace })).panes;
      expect(panes).toHaveLength(2);
      expect(new Set(panes.map((pane) => pane.pixel_frame?.x)).size).toBe(2);
      expect(panes.find((pane) => pane.ref === split.pane)?.surface_refs).toContain(split.surface);
      expect(panes.find((pane) => pane.ref === "pane:bench")?.surface_refs).not.toContain(split.surface);
      expect(await initializeNewSurfaceRuntime({
        listTerminalMetadata: metadata,
        sendKey: (surface, key, opts) => client.sendKey(surface, key, opts),
      }, split.surface, split.workspace, 500, undefined, split.surface_id)).toBe("input_demand");
      await client.closeSurface(split.surface, { workspace: split.workspace });
      expect((await client.listPanes({ workspace: split.workspace })).panes).toHaveLength(1);
    }
  } finally {
    client.disconnect();
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

it("allocates distinct fake identities for concurrent socket splits", async () => {
  const root = mkdtempSync(join(tmpdir(), "cmuxlayer-bench-concurrent-fixture-"));
  const statePath = join(root, "state.json");
  const socketPath = join(root, "cmux.sock");
  const server = await startFakeCmuxSocket(socketPath, statePath, 10);
  const client = new CmuxSocketClient({ socketPath });
  try {
    const splits = await Promise.all(Array.from({ length: 4 }, () =>
      client.newSplit("right", { workspace: "workspace:bench", pane: "pane:bench" }),
    ));
    expect(new Set(splits.map((split) => split.surface)).size).toBe(splits.length);
    expect(new Set(splits.map((split) => split.surface_id)).size).toBe(splits.length);
    const listed = await client.listPaneSurfaces({ workspace: "workspace:bench" });
    for (const split of splits) {
      expect(listed.surfaces).toContainEqual(expect.objectContaining({
        ref: split.surface,
        id: split.surface_id,
      }));
    }
  } finally {
    client.disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
    const panes = (await client.listPanes({ workspace: split.workspace })).panes;
    expect(panes).toHaveLength(2);
    expect(new Set(panes.map((pane) => pane.pixel_frame?.x)).size).toBe(2);
    expect(panes.find((pane) => pane.ref === split.pane)?.surface_refs).toContain(split.surface);
    expect((await client.listPaneSurfaces({ workspace: split.workspace, pane: split.pane })).surfaces)
      .toContainEqual(expect.objectContaining({ ref: split.surface, id: split.surface_id }));
    expect(await initializeNewSurfaceRuntime(client, split.surface, split.workspace, 500, undefined, split.surface_id))
      .toBe("input_demand");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
