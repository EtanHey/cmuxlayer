import { afterEach, expect, it, vi } from "vitest";
import { initializeNewSurfaceRuntime } from "../src/surface-runtime.js";
import { CmuxSelfHealingClient } from "../src/cmux-transport-self-heal.js";

afterEach(() => vi.useRealTimers());

it.each([undefined, null, "nil"])("#636 D4 partial cold pointer %s gets one input demand", async ptr => {
  const sendKey = vi.fn();
  const client = { sendKey, listTerminalMetadata: vi.fn().mockResolvedValueOnce({ terminals: [{ surface_ref: "surface:1", runtime_surface_ready: false, ghostty_surface_ptr: ptr }] }).mockResolvedValue({ terminals: [{ surface_ref: "surface:1", runtime_surface_ready: true, ghostty_surface_ptr: "0x123" }] }) };
  await initializeNewSurfaceRuntime(client, "surface:1", "workspace:1");
  expect(sendKey).toHaveBeenCalledExactlyOnceWith("surface:1", "ctrl-u", { workspace: "workspace:1" });
});

it.each(["empty", "reject", "hang"])("#636 D4 capable metadata %s is unknown then fails closed", async mode => {
  vi.useFakeTimers();
  const sendKey = vi.fn();
  const client = { sendKey, listTerminalMetadata: vi.fn().mockImplementation(async () => mode === "hang" ? new Promise(() => {}) : mode === "reject" ? Promise.reject(new Error("read failed")) : { terminals: [] }) };
  const result = initializeNewSurfaceRuntime(client, "surface:1", undefined, 20).then(() => null, error => error);
  await vi.advanceTimersByTimeAsync(100);
  expect((await result)?.message).toContain("surface_runtime_not_started");
  expect(sendKey).toHaveBeenCalledTimes(1);
});

it("#636 D4 cold UUID-only metadata uses the stable surface identity", async () => {
  const client = { sendKey: vi.fn(), listTerminalMetadata: vi.fn().mockResolvedValueOnce({ terminals: [{ surface_id: "uuid-1", runtime_surface_ready: false, ghostty_surface_ptr: "nil" }] }).mockResolvedValue({ terminals: [{ surface_id: "uuid-1", runtime_surface_ready: true, ghostty_surface_ptr: "0x123" }] }) };
  await initializeNewSurfaceRuntime(client, "surface:1", undefined, 20, undefined, "uuid-1");
  expect(client.sendKey).toHaveBeenCalledTimes(1);
});

it("#636 D4 production socket wrapper reads explicit runtime metadata through its pinned CLI", async () => {
  const terminals = [{ surface_ref: "surface:1", runtime_surface_ready: false, ghostty_surface_ptr: "nil" }];
  const cli = { setEnv: vi.fn(), listTerminalMetadata: vi.fn().mockResolvedValue({ terminals }) };
  const socket = { currentSocketPath: () => "/tmp/636-test.sock", listTerminalMetadata: vi.fn().mockResolvedValue({ terminals: [] }) };
  const client = new CmuxSelfHealingClient({ cli: cli as any, socket: socket as any, socketPath: "/tmp/636-test.sock" });
  try {
    expect(await (client as any).listSurfaceRuntimeMetadata()).toEqual({ terminals });
    expect(cli.listTerminalMetadata).toHaveBeenCalledTimes(1);
    expect(socket.listTerminalMetadata).not.toHaveBeenCalled();
  } finally { client.stop(); }
});
