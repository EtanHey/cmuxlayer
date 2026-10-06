import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, WaitTimeout } from "../scripts/xmac/ctx.mjs";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "xmac-ctx-test-"));
  const driver = {
    target: { host: "m1", cmux: "prod-0.64.22", cmuxVersion: "0.64.22", cmuxlayerSha: "abc" },
    call: vi.fn(async () => ({ structuredContent: { agent_id: "seat", surface_id: "surface:1" } })),
    readScreen: vi.fn(async () => ({ text: "header\n\n› draft\n", column: 1, column_count: 2 })),
    sweepChildren: vi.fn(async () => ({ ok: true })), spawnLeadSeat: vi.fn(async () => ({ structuredContent: { agent_id: "lead" } })),
    verifyClosed: vi.fn(async () => true),
    focusedSurface: vi.fn(async () => "surface:2"), processArgs: vi.fn(async () => "codex --worker"),
  };
  const ctx = createContext({ driver, evidenceDir: dir, parseScreen: (text: string) => ({ state: "idle", text }) });
  return { dir, driver, ctx, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("cross-Mac ctx v1", () => {
  it("unwraps structured receipts, forces verbose, and tracks failed spawns for final cleanup", async () => {
    const f = fixture();
    try {
      f.driver.call.mockResolvedValueOnce({ structuredContent: { agent_id: "seat", ok: false } });
      expect(await f.ctx.spawn({ cli: "codex", verbose: false })).toEqual({ agent_id: "seat", ok: false });
      expect(f.driver.call).toHaveBeenCalledWith("spawn_agent", { cli: "codex", model: "gpt-6-luna", effort: "low", verbose: true });
      await f.ctx.close("seat");
      await f.ctx.dispose();
      expect(f.driver.call.mock.calls.filter(([name]) => name === "close_surface")).toHaveLength(2);
    } finally { f.cleanup(); }
  });
  it("owns direct call and resume spawns, preserves send options and cheap model limits", async () => {
    const f = fixture();
    try {
      await f.ctx.call("spawn_agent", { cli: "claude", model: "haiku" });
      await f.ctx.resume("old", { cli: "codex", resume_agent_id: "override" });
      expect(f.driver.call).toHaveBeenLastCalledWith("spawn_agent", expect.objectContaining({ resume_agent_id: "old", verbose: true }));
      await f.ctx.send({ agent_id: "seat", text: "hi", submit: false });
      expect(f.driver.call).toHaveBeenLastCalledWith("send_to", { mode: "agent", agent_id: "seat", text: "hi", submit: false, verbose: true });
      await expect(f.ctx.spawn({ cli: "codex", model: "expensive" })).rejects.toThrow("cheapest");
      await f.ctx.key("surface:1", "Return");
      expect(f.driver.call).toHaveBeenLastCalledWith("send_to", { mode: "key", surface: "surface:1", text: "Return" });
    } finally { f.cleanup(); }
  });
  it("uses independent raw screen text, preserves blank/composer rows and timeout last frame", async () => {
    const f = fixture();
    try {
      const screen = await f.ctx.readScreen("surface:1");
      expect(screen.text).toBe("header\n\n› draft\n");
      expect(screen.parsed.text).toBe(screen.text);
      expect(f.driver.call).not.toHaveBeenCalled();
      await expect(f.ctx.waitScreen("surface:1", () => false, 0)).rejects.toMatchObject({ name: "WaitTimeout", last: screen });
      expect(WaitTimeout).toBeDefined();
      expect(await f.ctx.focusedSurface()).toBe("surface:2");
      expect(await f.ctx.processArgs("seat")).toBe("codex --worker");
      const path = await f.ctx.artifact("frame.txt", screen.text);
      expect(readFileSync(path, "utf8")).toBe(screen.text);
      await expect(f.ctx.artifact("../escape", "x")).rejects.toThrow("artifact name");
    } finally { f.cleanup(); }
  });
  it("sweeps all seats despite close errors and retains evidence of cleanup failure", async () => {
    const f = fixture();
    try {
      await f.ctx.spawn({ cli: "codex" });
      f.driver.call.mockResolvedValueOnce({ structuredContent: { agent_id: "second" } });
      await f.ctx.spawn({ cli: "claude" });
      f.driver.call.mockRejectedValueOnce(new Error("close failed"));
      await expect(f.ctx.dispose()).rejects.toThrow("seat cleanup");
      expect(f.driver.call).toHaveBeenLastCalledWith("close_surface", { agent_id: "second", scope: "agent", force: true });
      expect(readFileSync(join(f.dir, "cleanup.json"), "utf8")).toContain("close failed");
    } finally { f.cleanup(); }
  });
  it("does not reinterpret error envelopes as passing tool results", async () => {
    const f = fixture();
    try {
      f.driver.call.mockResolvedValueOnce({ content: [{ type: "text", text: '{"ok":false,"reason":"draft"}' }] } as any);
      expect(await f.ctx.call("send_to", {})).toEqual({ ok: false, reason: "draft" });
      f.driver.call.mockResolvedValueOnce({ isError: true, content: [{ type: "text", text: "bad transport" }] } as any);
      await expect(f.ctx.call("list_agents", {})).rejects.toThrow("bad transport");
    } finally { f.cleanup(); }
  });
});

it("v1.1 forces a private-MCP Haiku lead and sweeps children before owned seats", async () => {
  const f = fixture();
  try {
    await f.ctx.spawnLeadSeat({ model: "opus", placement: "right", authority: "worker" });
    expect(f.driver.spawnLeadSeat).toHaveBeenCalledWith(expect.objectContaining({ model: "haiku", cli: "claude", role: "lead", authority: "lead", placement: "left", verbose: true }));
    await f.ctx.leadSend("lead", "Spawn one cheap worker.");
    expect(f.driver.call).toHaveBeenLastCalledWith("send_to", expect.objectContaining({ agent_id: "lead", text: "Spawn one cheap worker." }));
    await f.ctx.dispose();
    expect(f.driver.sweepChildren).toHaveBeenCalledOnce();
    expect(f.driver.verifyClosed).toHaveBeenCalledWith("lead");
  } finally { f.cleanup(); }
});
