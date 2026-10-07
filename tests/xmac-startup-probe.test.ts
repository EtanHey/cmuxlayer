import { expect, it } from "vitest";
import { runCodexResolutionProbe } from "../scripts/xmac/startup-probe.mjs";
import { productionChanges } from "../scripts/xmac/production-guard.mjs";

const token = "aaaaaaaa-bbbb-cccc-dddd-ffffffffffff";
const workspace = "11111111-bbbb-cccc-dddd-eeeeeeeeeeee", surface = "22222222-bbbb-cccc-dddd-eeeeeeeeeeee";
const window = "44444444-bbbb-cccc-dddd-eeeeeeeeeeee";
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
it("requires exact run-owned fixture trap equality, not merely an absolute CLI", async () => {
  const f=fixture();f.runtime.receipt.fixtures={row:"contract",binaries:{codex:"/private/run/bin/codex"}};
  await expect(run(f)).rejects.toThrow(/resolution mismatch/);
  expect(f.calls.some(c=>c.method==="workspace.close")).toBe(false);
  const valid=fixture();valid.runtime.receipt.fixtures={row:"contract",binaries:{codex:"/scratch/bin/codex"}};
  await run(valid);expect(valid.runtime.receipt.startup_probe.closed).toBe(true);
});
it("retains the separate generic xmac bundle-wrapper expectation", async () => {
  const f=fixture();f.runtime.receipt.fixtures={binaries:{codex:"/different/private/bin/codex"}};
  await runCodexResolutionProbe(f.runtime,"/scratch/bin/codex",f.deps);
  expect(f.runtime.receipt.startup_probe.closed).toBe(true);
});
it("keeps real-home marker changes as strict failures for both targets", () => {
  const path = ".local/state/cmux/last-socket-path";
  const before = { home: "/synthetic/operator", files: {}, agents: [], socket_pointers: { [path]: "/tmp/old.sock\n" } };
  for (const socket of ["/tmp/cmux-soak-stable.sock", "/tmp/cmux-nightly.sock"]) {
    expect(productionChanges(before, { ...before, socket_pointers: { [path]: `${socket}\n` } }, [socket], [])).toEqual([path]);
  }
});

it.each([
  ["marker", "\ninitializing\n", "bound", "rendering", true, "marker_present"],
  ["idle", `\nXMAC_CODEX_${token}:/scratch/bin/codex\n`, "bound", "rendering", true, "idle"],
  ["binding", `XMAC_CODEX_${token}:/scratch/bin/codex\nXMAC_IDLE_${token}\n`, "unavailable", "rendering", true, "bound"],
  ["rendering", `XMAC_CODEX_${token}:/scratch/bin/codex\nXMAC_IDLE_${token}\n`, "bound", "awaiting_frame", true, "rendering"],
  ["attachment", `XMAC_CODEX_${token}:/scratch/bin/codex\nXMAC_IDLE_${token}\n`, "bound", "not_started", false, "in_window"],
])("retains bounded admission diagnostics for absent %s", async (_name, text, binding, rendering, attached, failedPredicate) => {
  const f = fixture(), original = f.deps.rpc;
  f.deps.rpc = async (...args: Parameters<typeof original>) => {
    if (["surface.read_text", "surface.health", "workspace.current"].includes(args[1])) f.calls.push({ method: args[1], params: args[2] });
    if (args[1] === "surface.read_text") return { text };
    if (args[1] === "surface.health") return { workspace_id: workspace, window_id: window,
      surfaces: [{ id: surface, socket_binding: binding, render_health: rendering, in_window: attached }] };
    if (args[1] === "workspace.current") return { window_id: window, workspace_id: f.runtime.workspace, workspace: { title: "DO_NOT_CAPTURE" } };
    return original(...args);
  };
  let clock = 1000;
  await expect(runCodexResolutionProbe(f.runtime, null, { ...f.deps, now: () => clock++ })).rejects.toThrow("bound rendering idle prompt");
  const probe = f.runtime.receipt.startup_probe, diag = probe.diagnostics;
  expect(probe).toMatchObject({ window_id: window, workspace_id: workspace, surface_id: surface, close: "pending" });
  expect(diag, "failure admission receipt must survive the throw").toBeDefined();
  expect(diag.status).toBe("FAIL"); expect(diag.error.value).toContain("bound rendering idle prompt");
  expect(diag.attempts).toHaveLength(100);
  const first = diag.attempts[0];
  expect(first.text.value).toBe(text); // Keep blank lines and framing, not trim().
  expect(first.predicates[failedPredicate as string]).toBe(false);
  expect(first.health.surface).toMatchObject({ id: surface, socket_binding: binding, render_health: rendering, in_window: attached });
  expect(first.selection).toMatchObject({ status: "available", window_id: window, selected_workspace_id: f.runtime.workspace, probe_selected: false });
  expect(first.started_at_ms).toBeGreaterThanOrEqual(1000); expect(first.elapsed_ms).toBeGreaterThan(0);
  expect(f.calls.filter(c => c.method === "surface.health")).toHaveLength(100);
  expect(f.calls.some(c => c.method === "workspace.close")).toBe(false);
  expect(JSON.stringify(diag)).not.toContain("DO_NOT_CAPTURE");
});

it.each(["surface.read_text", "surface.health"])("saves the primary %s error before throwing", async method => {
  const f = fixture(), original = f.deps.rpc, primary = new Error(`primary ${method}`);
  f.deps.rpc = async (...args: Parameters<typeof original>) => {
    if (args[1] === "surface.read_text") {
      if (method === args[1]) throw primary;
      return { text: `XMAC_CODEX_${token}:/scratch/bin/codex\nXMAC_IDLE_${token}\n` };
    }
    if (args[1] === method) throw primary;
    return original(...args);
  };
  await expect(run(f)).rejects.toBe(primary);
  const diag = f.runtime.receipt.startup_probe.diagnostics;
  expect(diag.error.value).toBe(String(primary)); expect(diag.status).toBe("FAIL");
  expect(diag.attempts[0][method === "surface.read_text" ? "read_error" : "health_error"].value).toBe(String(primary));
  expect(f.calls.some(c => c.method === "workspace.close")).toBe(false);
});

it("keeps optional diagnostic RPC errors from replacing the admission failure", async () => {
  const f = fixture(), original = f.deps.rpc;
  f.deps.rpc = async (...args: Parameters<typeof original>) => {
    if (args[1] === "surface.read_text") return { text: "\ninitializing\n" };
    if (["surface.health", "workspace.current"].includes(args[1])) throw new Error(`unavailable ${args[1]}`);
    return original(...args);
  };
  await expect(run(f)).rejects.toThrow("bound rendering idle prompt");
  const diag = f.runtime.receipt.startup_probe.diagnostics;
  expect(diag.attempts[0].health_error.value).toContain("unavailable surface.health");
  expect(diag.attempts[0].selection.status).toBe("unavailable");
  expect(diag.error.value).toContain("bound rendering idle prompt");
});

it.each(["surface.read_text", "surface.health", "workspace.current"])("guards ownership after awaited %s before further RPCs", async method => {
  const f = fixture(), original = f.deps.rpc;
  f.deps.rpc = async (...args: Parameters<typeof original>) => {
    const response = await original(...args);
    if (args[1] === method) f.owner.socketIdentity = "replaced";
    return response;
  };
  await expect(run(f)).rejects.toThrow("ownership changed");
  expect(f.calls.at(-1)?.method).toBe(method);
  expect(f.runtime.receipt.startup_probe.diagnostics.error.value).toContain("ownership changed");
});

it("retains the read error when its rejection also reveals ownership drift", async () => {
  const f = fixture(), original = f.deps.rpc, primary = new Error("read failed first");
  f.deps.rpc = async (...args: Parameters<typeof original>) => {
    if (args[1] === "surface.read_text") { f.owner.socketIdentity = "replaced"; throw primary; }
    return original(...args);
  };
  await expect(run(f)).rejects.toBe(primary);
  const diag = f.runtime.receipt.startup_probe.diagnostics;
  expect(diag.error.value).toBe(String(primary)); expect(diag.ownership_error.value).toContain("ownership changed");
  expect(f.calls.some(c => c.method === "surface.health")).toBe(false);
});

it("bounds UTF-8 text and health/error fields with explicit truncation", async () => {
  const f = fixture(), original = f.deps.rpc, text = "\n" + "אב🙂".repeat(20000) + "\n";
  f.deps.rpc = async (...args: Parameters<typeof original>) => {
    if (args[1] === "surface.read_text") return { text };
    if (args[1] === "surface.health") return { workspace_id: workspace, surfaces: [{ id: surface,
      socket_binding: "b".repeat(5000), render_health: "r".repeat(5000), in_window: false }], secret: "DO_NOT_CAPTURE" };
    if (args[1] === "workspace.current") throw new Error("e".repeat(10000));
    return original(...args);
  };
  await expect(run(f)).rejects.toThrow("bound rendering idle prompt");
  const diag = f.runtime.receipt.startup_probe.diagnostics, first = diag.attempts[0];
  expect(diag.attempts).toHaveLength(diag.limits.max_attempts);
  expect(diag.total_text_bytes).toBeLessThanOrEqual(diag.limits.text_total_bytes);
  expect(first.text.truncated).toBe(true); expect(first.text.original_bytes).toBe(Buffer.byteLength(text));
  expect(first.text.value.startsWith("\n")).toBe(true); expect(first.text.value).not.toContain("�");
  for (const attempt of diag.attempts) expect(attempt.text.stored_bytes).toBeLessThanOrEqual(diag.limits.text_per_attempt_bytes);
  expect(first.health.truncated_fields).toEqual(["socket_binding", "render_health"]);
  expect(Buffer.byteLength(first.health.surface.render_health)).toBeLessThanOrEqual(diag.limits.health_field_bytes);
  expect(first.selection.error.truncated).toBe(true);
  expect(first.selection.error.stored_bytes).toBeLessThanOrEqual(diag.limits.error_bytes);
  expect(JSON.stringify(diag)).not.toContain("DO_NOT_CAPTURE");
});

it("keeps healthy admission/normal close and treats absent selection metadata as unavailable", async () => {
  const f = fixture(); await run(f);
  const diag = f.runtime.receipt.startup_probe.diagnostics;
  expect(diag.status).toBe("PASS"); expect(diag.attempts).toHaveLength(3);
  expect(diag.attempts[0].selection.status).toBe("unavailable");
  expect(diag.attempts[2].predicates).toMatchObject({ absolute_resolution: true, idle: true, bound: true, rendering: true });
  expect(f.calls.filter(c => c.method === "workspace.close")).toHaveLength(1);
  expect(f.runtime.receipt.startup_probe.closed).toBe(true);
  expect(f.calls.some(c => c.params.focus || c.params.force || c.method === "surface.send_key")).toBe(false);
});

it("bounds a healthy oversized screen without changing admission or retaining extra health/selection data", async () => {
  const f = fixture(), original = f.deps.rpc;
  const text = `XMAC_CODEX_${token}:/scratch/bin/codex\n` + "x".repeat(50000) + `\nXMAC_IDLE_${token}\n`;
  f.deps.rpc = async (...args: Parameters<typeof original>) => {
    if (args[1] === "surface.read_text") return { text };
    if (args[1] === "surface.health") return { workspace_id: workspace, window_id: window,
      surfaces: [{ id: surface, socket_binding: "bound", render_health: "rendering", in_window: false, secret: "DO_NOT_CAPTURE" }], secret: "DO_NOT_CAPTURE" };
    if (args[1] === "workspace.current") {
      expect(args[2]).toEqual({ window_id: window });
      return { window_id: window, workspace_id: "55555555-bbbb-cccc-dddd-eeeeeeeeeeee", workspace: { title: "DO_NOT_CAPTURE" } };
    }
    return original(...args);
  };
  await run(f);
  const receipt = f.runtime.receipt;
  expect(receipt.startup_probe.closed).toBe(true); // in_window is observational; keep the existing rendering gate.
  expect(receipt.codex_probe_screen_capture.truncated).toBe(true);
  expect(Buffer.byteLength(receipt.codex_probe_screen)).toBeLessThanOrEqual(receipt.startup_probe.diagnostics.limits.success_text_bytes);
  expect(receipt.startup_probe.diagnostics.attempts[0].selection.selected_workspace_id).toBeNull();
  expect(JSON.stringify(receipt)).not.toContain("DO_NOT_CAPTURE");
});

it("does not let optional selection failure replace a later confirmation refusal", async () => {
  const f = fixture(), original = f.deps.rpc, primary = new Error("confirmation_required");
  let closes = 0;
  f.deps.rpc = async (...args: Parameters<typeof original>) => {
    if (args[1] === "workspace.current") throw new Error("optional diagnostics unavailable");
    if (args[1] === "workspace.close") { closes++; throw primary; }
    return original(...args);
  };
  await expect(run(f)).rejects.toBe(primary);
  expect(f.runtime.receipt.startup_probe.diagnostics.error.value).toBe(String(primary)); expect(closes).toBe(1);
});

it.each(["workspace.create", "surface.list", "workspace.close", "workspace.list"])("guards after awaited %s without retrying mutation", async method => {
  const f = fixture(), original = f.deps.rpc;
  f.deps.rpc = async (...args: Parameters<typeof original>) => {
    const response = await original(...args);
    if (args[1] === method) f.owner.socketIdentity = "replaced";
    return response;
  };
  await expect(run(f)).rejects.toThrow("ownership changed");
  expect(f.calls.at(-1)?.method).toBe(method);
  expect(f.calls.filter(c => c.method === "workspace.create")).toHaveLength(1);
  expect(f.calls.filter(c => c.method === "workspace.close").length).toBeLessThanOrEqual(1);
  expect(f.runtime.receipt.startup_probe.diagnostics.error.value).toContain("ownership changed");
});

it("keeps the primary exception even if describing it fails", async () => {
  const f = fixture(), original = f.deps.rpc;
  const primary = { toString() { throw new Error("diagnostic stringify failed"); } };
  f.deps.rpc = async (...args: Parameters<typeof original>) => {
    if (args[1] === "surface.read_text") throw primary;
    return original(...args);
  };
  await expect(run(f)).rejects.toBe(primary);
  expect(f.runtime.receipt.startup_probe.diagnostics.error.unavailable).toBe(true);
});

it("checks ownership immediately before and after every awaited RPC", async () => {
  const f = fixture(), original = f.deps.rpc, events: string[] = [];
  f.deps.observe = () => { events.push("guard"); return { ...f.owner }; };
  f.deps.rpc = async (...args: Parameters<typeof original>) => {
    events.push("request"); const response = await original(...args); events.push("response"); return response;
  };
  await run(f);
  for (let i = 0; i < events.length; i++) {
    if (events[i] === "request") expect(events[i - 1]).toBe("guard");
    if (events[i] === "response") expect(events[i + 1]).toBe("guard");
  }
  expect(f.runtime.receipt.startup_probe.closed).toBe(true);
});
