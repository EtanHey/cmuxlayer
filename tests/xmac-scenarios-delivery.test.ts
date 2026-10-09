import { describe, expect, it, vi } from "vitest";
import lead from "../scripts/xmac/scenarios/lead_spawn_role_worker.mjs";
import busy from "../scripts/xmac/scenarios/busy_codex_steer_vs_queue.mjs";
import wrapper from "../scripts/xmac/scenarios/codex_launch_under_cmux_wrapper.mjs";

function context() {
  let prompt = "", mode = "", token = "", hold = false, consumed = false;
  const ctx: any = {
    runId: "unit", target: { host: "mbp", cmux: "nightly", codexWrapper: "/private/cmux-nightly/bin/codex" },
    spawn: vi.fn(async (args: any) => { prompt = args.prompt; return { ok: true, agent_id: "owned", surface_id: "surface:owned" }; }),
    spawnLeadSeat: vi.fn(async (args: any) => { prompt = args.prompt; return { ok: true, agent_id: "owned", surface_id: "surface:owned" }; }),
    leadSend: vi.fn(async (_id: string, text: string) => { prompt = text; return { ok: true }; }),
    busy: vi.fn(async () => { hold = true; }),
    send: vi.fn(async (args: any) => {
      token = args.text.match(/XMAC_\w+/)[0]; mode = args.codex_busy_mode;
      return { ok: true, delivery_id: mode, delivery_state: mode === "queue" ? "queued" : "steer_pending", submitted: false };
    }),
    call: vi.fn(async (name: string) => {
      if (name === "list_agents") return { ok: true, agents: [{ agent_id: "child", surface_id: "surface:child", parent_agent_id: "owned", role: "worker" }] };
      consumed = true; hold = false;
      return { ok: true, delivery_state: "submitted", submitted: true };
    }),
    close: vi.fn(async () => ({ ok: true, agent_stopped: true, surface_closed: true })),
    readScreen: vi.fn(async (surface: string) => ({ text: hold
      ? `OpenAI Codex\nWorking (2s • esc to interrupt)\n${mode === "queue" ? "Queued follow-up inputs" : "Messages to be submitted after next tool call"}\n  ↳ Reply exactly ${token}. Use no tools.\n› \nGPT-6-Luna low`
      : `OpenAI Codex\n› ${consumed ? `Reply exactly ${token}. Use no tools.` : prompt}\n• ${consumed ? token : (surface === "surface:child" ? prompt.match(/XMAC_\w+/)?.[0] : prompt.match(/Reply exactly (XMAC_\w+) after/)?.[1] ?? prompt.match(/XMAC_\w+/)?.[0])}\n› \nGPT-6-Luna low`, column: 1, column_count: 2 })),
    waitScreen: vi.fn(async (surface: string, predicate: Function) => {
      const screen = await ctx.readScreen(surface);
      if (!predicate(screen)) throw new Error("screen deadline");
      return screen;
    }),
    processArgs: vi.fn(async () => "codex --profile synthetic --dangerously-bypass-approvals-and-sandbox"),
    receipt: vi.fn(), artifact: vi.fn(async (name: string) => `/evidence/${name}.json`),
  };
  return ctx;
}

describe("X2 lead, busy delivery and NIGHTLY launcher", () => {
  it.each([lead, busy, wrapper])("$id passes a fixed observed run", async scenario => {
    const ctx = context();
    expect((await scenario.run(ctx)).status).toBe("PASS");
    expect(ctx.readScreen).toHaveBeenCalled();
    expect(ctx.artifact).toHaveBeenCalled();
  });
  it("runs the role omission inside a real lead seat and closes discovered children", async () => {
    const ctx = context(); await lead.run(ctx);
    expect(ctx.spawnLeadSeat.mock.calls[0][0]).toMatchObject({ cli: "claude", model: "haiku", authority: "lead", role: "implementor", placement: "left" });
    expect(ctx.leadSend.mock.calls[0][1]).toContain("omit role");
    expect(ctx.leadSend.mock.calls[0][1]).toContain("one Claude");
    expect(ctx.close).toHaveBeenCalledWith("child");
  });
  it("rejects wrong child role, missing child and left-column child", async () => {
    for (const child of [null, { agent_id: "child", surface_id: "surface:child", role: "lead", parent_agent_id: "owned" }]) {
      const ctx = context(); ctx.call = async () => ({ ok: true, agents: child ? [child] : [] });
      expect((await lead.run(ctx)).status).toBe("FAIL");
    }
    const ctx = context(); ctx.readScreen.mockImplementation(async () => ({ text: "OpenAI Codex\n› \nGPT-6-Luna low", column: 0, column_count: 2 }));
    expect((await lead.run(ctx)).status).toBe("FAIL");
  });
  it("exercises queue and steer independently and waits for both to be consumed", async () => {
    const ctx = context(); await busy.run(ctx);
    expect(ctx.send.mock.calls.map(([args]: any[]) => args.codex_busy_mode)).toEqual(["steer", "queue"]);
    expect(ctx.busy).toHaveBeenCalledTimes(2);
    expect(ctx.call.mock.calls.filter(([name]: any[]) => name === "wait_for")).toHaveLength(2);
  });
  it("checks child placement after a proven lead and child reply", async () => {
    const ctx = context(), read = ctx.readScreen;
    ctx.readScreen = async (surface: string) => ({ ...await read(surface), column: surface === "surface:child" ? 0 : 1 });
    expect((await lead.run(ctx)).notes).toContain("lead_child_wrong_column");
  });
  it("rejects queued receipt falsely claiming submitted", async () => {
    const ctx = context(); const send = ctx.send;
    ctx.send = async (args: any) => ({ ...await send(args), submitted: true });
    expect((await busy.run(ctx)).notes).toContain("pending_claimed_consumed");
  });
  it("rejects missing queue evidence, nonbusy setup and unconsumed terminal receipt", async () => {
    const noQueue = context(); noQueue.readScreen = async () => ({ text: "OpenAI Codex\nWorking (1s • esc to interrupt)\n› \nGPT-6-Luna low" });
    const idle = context(); idle.busy = async () => {};
    const stuck = context(); stuck.call = async () => ({ ok: true, matched: true, delivery_state: "queued", submitted: false });
    for (const ctx of [noQueue, idle, stuck]) expect((await busy.run(ctx)).status).toBe("FAIL");
  });
  it("does not count a queued or echoed marker as an authored consumed reply", async () => {
    const ctx = context(), read = ctx.readScreen;
    ctx.readScreen = async (surface: string) => {
      const screen = await read(surface);
      return ctx.call.mock.calls.length ? { ...screen, text: screen.text.replace(/^• .*$/gm, "") } : screen;
    };
    expect((await busy.run(ctx)).status).toBe("FAIL");
  });
  it("refuses production before spawning a wrapper seat", async () => {
    const ctx = context(); ctx.target = { host: "m1", cmux: "prod-0.64.22" };
    expect((await wrapper.run(ctx)).notes).toContain("unsupported_target");
    expect(ctx.spawn).not.toHaveBeenCalled();
  });
  it("requires the pinned NIGHTLY wrapper path before spawning", async () => {
    const ctx = context(); ctx.target.codexWrapper = null;
    expect((await wrapper.run(ctx)).notes).toContain("wrapper_path_unavailable");
    expect(ctx.spawn).not.toHaveBeenCalled();
  });
  it("detects duplicate profile flags, missing actual argv, and a shell error screen", async () => {
    for (const args of ["codex --profile one -ptwo", "", "codex --profile=one --profile=two",
      "codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-approvals-and-sandbox"]) {
      const ctx = context(); ctx.processArgs = async () => args;
      expect((await wrapper.run(ctx)).status).toBe("FAIL");
    }
    const ctx = context(); ctx.readScreen = async () => ({ text: "error: --profile cannot be used multiple times\n$ " });
    expect((await wrapper.run(ctx)).status).toBe("FAIL");
  });
});
