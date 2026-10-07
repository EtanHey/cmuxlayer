import { expect, it } from "vitest";
import { runCodexResolutionProbe } from "../scripts/xmac/startup-probe.mjs";
import { productionChanges } from "../scripts/xmac/production-guard.mjs";

const token = "aaaaaaaa-bbbb-cccc-dddd-ffffffffffff";
const workspace = "11111111-bbbb-cccc-dddd-eeeeeeeeeeee", surface = "22222222-bbbb-cccc-dddd-eeeeeeeeeeee";
function fixture() {
  const runtime: any = { cwd: "/scratch/repo", workspace: "33333333-bbbb-cccc-dddd-eeeeeeeeeeee",
    env: { CMUX_SOCKET_PATH: "/tmp/cmux-soak-stable.sock" }, receipt: {
      host: "M1.local", target: "m1-gate", launch_token: token,
      app_target: { executable: "/Applications/cmux.app/Contents/MacOS/cmux" },
      app_process: { pid: 77, saved: "77 exact-start /Applications/cmux.app/Contents/MacOS/cmux", launch_token: token },
      workspace: { workspace_id: "33333333-bbbb-cccc-dddd-eeeeeeeeeeee" } } };
  const owner: any = { host: "M1.local", saved: runtime.receipt.app_process.saved,
    executable: runtime.receipt.app_target.executable, token, socket: runtime.env.CMUX_SOCKET_PATH,
    socketIdentity: "1:2:3", socketOwned: true };
  const calls: any[] = []; let reads = 0;
  const rpc = async (_socket: string, method: string, params: any) => {
    calls.push({ method, params });
    if (method === "workspace.create") return { workspace_id: workspace, surface_id: surface, window_id: "44444444-bbbb-cccc-dddd-eeeeeeeeeeee" };
    if (method === "surface.read_text") return { text: `XMAC_CODEX_${token}:/scratch/bin/codex\n${++reads > 2 ? `XMAC_IDLE_${token}` : "initializing"}\n` };
    if (method === "surface.health") return { workspace_id: workspace, surfaces: [{ id: surface, socket_binding: "bound", render_health: "rendering" }] };
    if (method === "surface.list") return { workspace_id: workspace, surfaces: [{ id: surface }] };
    if (method === "workspace.list") return { workspaces: [] };
    return {};
  };
  return { runtime, owner, calls, deps: { rpc, observe: () => ({ ...owner }), sleep: async () => {} } };
}
const run = (f: ReturnType<typeof fixture>) => runCodexResolutionProbe(f.runtime, null, f.deps);
it.each(["/tmp/cmux.sock", "/Users/operator/.local/state/cmux/cmux-501.sock"])("refuses production socket %s before creation", async socket => {
  const f = fixture(); f.runtime.env.CMUX_SOCKET_PATH = socket;
  await expect(run(f)).rejects.toThrow(); expect(f.calls).toEqual([]);
});
it.each(["app_process", "launch_token", "host", "target"])("refuses incomplete owner receipt %s", async key => {
  const f = fixture(); delete f.runtime.receipt[key];
  await expect(run(f)).rejects.toThrow(); expect(f.calls).toEqual([]);
});
it("waits for the run-specific idle shell prompt and bound renderer before normal close", async () => {
  const f = fixture(); await run(f);
  expect(f.calls.filter(c => c.method === "surface.read_text").length).toBeGreaterThanOrEqual(3);
  expect(f.calls.some(c => c.method === "surface.health")).toBe(true);
  expect(f.calls.find(c => c.method === "workspace.create").params.initial_command).not.toContain("/bin/cat");
  expect(f.calls.filter(c => c.method === "workspace.close")).toEqual([{ method: "workspace.close", params: { workspace_id: workspace } }]);
  expect(f.runtime.receipt.startup_probe.closed).toBe(true);
});
it.each(["saved", "token", "executable", "host", "socket", "socketIdentity", "socketOwned"])("refuses ownership drift in %s during startup", async key => {
  const f = fixture(), original = f.deps.rpc;
  f.deps.rpc = async (...args: Parameters<typeof original>) => {
    const value = await original(...args);
    if (args[1] === "surface.read_text") f.owner[key] = key === "socketOwned" ? false : "foreign";
    return value;
  };
  await expect(run(f)).rejects.toThrow(); expect(f.calls.some(c => c.method === "workspace.close")).toBe(false);
});
it.each(["surface.read_text", "surface.health", "surface.list"])("refuses absent or foreign %s evidence without closing", async method => {
  const f = fixture(), original = f.deps.rpc;
  f.deps.rpc = async (...args: Parameters<typeof original>) => args[1] === method ?
    method === "surface.read_text" ? { text: "foreign" } : { workspace_id: "foreign", surfaces: [{ id: surface }] } : original(...args);
  await expect(run(f)).rejects.toThrow(); expect(f.calls.some(c => c.method === "workspace.close")).toBe(false);
});
it("does not bypass a captured 0.65 running-process confirmation", async () => {
  const f = fixture(), original = f.deps.rpc;
  f.deps.rpc = async (...args: Parameters<typeof original>) => {
    const value = await original(...args);
    if (args[1] === "workspace.close") throw new Error(JSON.stringify({ ok: false, error: {
      code: "confirmation_required", message: "Workspace has a running process; retry with --force", data: { workspace_id: workspace } } }));
    return value;
  };
  await expect(run(f)).rejects.toThrow("confirmation_required");
  expect(f.calls.filter(c => c.method === "workspace.close")).toHaveLength(1);
  expect(f.calls.some(c => c.params.force || c.method === "surface.send_key")).toBe(false);
});
it("requires raw enumeration to prove normal close completed", async () => {
  const f = fixture(), original = f.deps.rpc;
  f.deps.rpc = async (...args: Parameters<typeof original>) => args[1] === "workspace.list" ? { workspaces: [{ id: workspace }] } : original(...args);
  await expect(run(f)).rejects.toThrow("close unverified");
});
it("keeps real-home marker changes as strict failures for both targets", () => {
  const path = ".local/state/cmux/last-socket-path";
  const before = { home: "/synthetic/operator", files: {}, agents: [], socket_pointers: { [path]: "/tmp/old.sock\n" } };
  for (const socket of ["/tmp/cmux-soak-stable.sock", "/tmp/cmux-nightly.sock"]) {
    expect(productionChanges(before, { ...before, socket_pointers: { [path]: `${socket}\n` } }, [socket], [])).toEqual([path]);
  }
});
