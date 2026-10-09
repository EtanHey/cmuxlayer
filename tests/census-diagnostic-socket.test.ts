import { describe, expect, it, vi } from "vitest";
import { CmuxSocketClient } from "../src/cmux-socket-client.js";
import { CmuxPersistentSocket } from "../src/cmux-persistent-socket.js";

describe("census diagnostic socket ownership", () => {
  it("uses only explicit diagnostic socket RPCs and retains their connection generation", async () => {
    const call = vi.spyOn(CmuxPersistentSocket.prototype, "call").mockResolvedValue({ count: 27 });
    const generation = vi.spyOn(CmuxPersistentSocket.prototype, "currentConnectionGeneration").mockReturnValue(9);
    try {
      const client = new CmuxSocketClient();
      expect(await client.readCensusDiagnostic("debug.terminals")).toEqual({ value: { count: 27 }, generation: "0:9" });
      expect(call).toHaveBeenCalledWith("debug.terminals", {}, { polling: false });
      await expect(client.readCensusDiagnostic("surface.close" as any)).rejects.toThrow("Unsupported census diagnostic");
      call.mockRejectedValueOnce(new Error("connection closed"));
      await expect(client.readCensusDiagnostic("system.tree", { all_windows: true })).rejects.toThrow("connection closed");
      expect(call).toHaveBeenCalledTimes(2);
    } finally { call.mockRestore(); generation.mockRestore(); }
  });
  it("rejects an old response settled before transport replacement, without replay", async () => {
    const client = new CmuxSocketClient();
    const internal = client as unknown as { transport: CmuxPersistentSocket; transportSerial: number };
    const old = internal.transport;
    let settle!: (value: object) => void, enter!: () => void;
    const started = new Promise<void>(resolve => { enter = resolve; });
    const response = new Promise<object>(resolve => { settle = resolve; });
    const call = vi.spyOn(old, "call").mockImplementation(() => { enter(); return response; });
    const generation = vi.spyOn(old, "currentConnectionGeneration").mockReturnValue(7);
    try {
      const reading = client.readCensusDiagnostic("system.tree");
      const rejected = expect(reading).rejects.toMatchObject({ code: "census_transport_changed" });
      await started; settle({ from: "old" });
      internal.transport = new CmuxPersistentSocket(); internal.transportSerial = 1;
      await rejected; expect(call).toHaveBeenCalledTimes(1);
    } finally { call.mockRestore(); generation.mockRestore(); }
  });
  it.each([[7, 8, false], [0, 2, false], [0, 1, true]])("qualifies connection generation %i→%i only when owned", async (before, after, allowed) => {
    const generation = vi.spyOn(CmuxPersistentSocket.prototype, "currentConnectionGeneration").mockReturnValueOnce(before).mockReturnValue(after);
    const call = vi.spyOn(CmuxPersistentSocket.prototype, "call").mockResolvedValue({ observed: true });
    try {
      const result = new CmuxSocketClient().readCensusDiagnostic("system.tree");
      if (allowed) expect(await result).toEqual({ value: { observed: true }, generation: `0:${after}` });
      else await expect(result).rejects.toMatchObject({ code: "census_transport_changed" });
      expect(call).toHaveBeenCalledTimes(1);
    } finally { call.mockRestore(); generation.mockRestore(); }
  });
});
