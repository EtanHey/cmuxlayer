import { describe, expect, it, vi } from "vitest";
import stray from "../scripts/xmac/scenarios/stray_newline.mjs";
import stale from "../scripts/xmac/scenarios/resume_stale_done.mjs";
import focus from "../scripts/xmac/scenarios/resume_focus.mjs";
import worker from "../scripts/xmac/scenarios/resume_keeps_worker_role.mjs";

function context(overrides: Record<string, any> = {}) {
  let prompt = "";
  const ctx: any = {
    runId: "unit", target: { host: "m1", cmux: "prod-0.64.22" },
    spawn: vi.fn(async (args: any) => {
      prompt = args.prompt;
      return { ok: true, agent_id: "owned", surface_id: "surface:owned",
        report_path: "/private/owned/report.md", done_marker: "DONE_OWNED" };
    }),
    resume: vi.fn(async () => ({ ok: true, resumed: true, agent_id: "owned", surface_id: "surface:resumed" })),
    close: vi.fn(async () => ({ ok: true, agent_stopped: true, surface_closed: true })),
    readScreen: vi.fn(async () => ({ text: `OpenAI Codex\n› ${prompt}\n• ${prompt.match(/XMAC_\w+/)?.[0]}\n› \nGPT-6-Luna low`, column: 1, column_count: 2 })),
    waitScreen: vi.fn(async (surface: string, predicate: Function) => {
      const screen = await ctx.readScreen(surface);
      if (!predicate(screen)) throw new Error("screen deadline");
      return screen;
    }),
    call: vi.fn(async () => ({ ok: true, matched: true, state: "ready" })),
    focusedSurface: vi.fn(async () => "surface:anchor"),
    inspectAgent: vi.fn(async () => ({ role: "worker" })),
    send: vi.fn(async (args: any) => { prompt = args.text; return { ok: true }; }),
    processArgs: vi.fn(async () => "codex -c features.apps=false resume synthetic-session"),
    receipt: vi.fn(), artifact: vi.fn(async (name: string) => `/evidence/${name}.json`),
    ...overrides,
  };
  return ctx;
}

describe("X2 spawn whitespace and resume scenarios", () => {
  it.each([stray, stale, focus, worker])("$id passes an observed fixed run with runner-owned seats", async scenario => {
    const ctx = context();
    expect((await scenario.run(ctx)).status).toBe("PASS");
    expect(ctx.readScreen).toHaveBeenCalled();
    if (scenario !== stray) expect(ctx.close).toHaveBeenCalledWith("owned");
    expect(ctx.artifact).toHaveBeenCalled();
    expect(ctx.spawn.mock.calls[0][0]).toMatchObject({ cli: "codex", model: "gpt-6-luna", effort: "low" });
  });
  it("rejects a leading blank prompt row even with a successful receipt", async () => {
    const ctx = context();
    ctx.readScreen.mockImplementation(async () => ({ text: `OpenAI Codex\n›\n  ${ctx.spawn.mock.calls[0][0].prompt}\n• XMAC_stray_newline_unit\n› \nGPT-6-Luna low` }));
    expect((await stray.run(ctx)).notes).toContain("leading_newline");
  });
  it("does not pass whitespace on missing or echoed-only response evidence", async () => {
    for (const content of ["", "OpenAI Codex\n› Reply exactly XMAC_stray_newline_unit. Use no tools.\n› \nGPT-6-Luna low"]) {
      expect((await stray.run(context({ readScreen: async () => ({ text: content }) }))).status).toBe("FAIL");
    }
  });
  it("requires stale report evidence and catches the false terminal-done wait", async () => {
    const ctx = context({ call: async (_name: string, args: any) => args.report_path ? { ok: true, matched: true } : { ok: true, matched: false, state: "done", screen_confirmed_state: "ready" } });
    expect((await stale.run(ctx)).notes).toContain("stale_done_wait");
    expect(ctx.send.mock.calls[0][0].text).toContain("DONE_OWNED");
    expect((await stale.run(context({ send: undefined }))).status).toBe("FAIL");
  });
  it("requires successful close before resume and an actual resume receipt", async () => {
    expect((await stale.run(context({ close: async () => ({ ok: false }) }))).status).toBe("FAIL");
    const ctx = context({ resume: async () => ({ ok: true, agent_id: "owned", surface_id: "surface:new" }) });
    expect((await stale.run(ctx)).status).toBe("FAIL");
  });
  it("detects focus steal and never asks resume to focus", async () => {
    const ctx = context({ focusedSurface: vi.fn().mockResolvedValueOnce("surface:anchor").mockResolvedValue("surface:resumed") });
    expect((await focus.run(ctx)).notes).toContain("focus_stolen");
    expect(ctx.resume).toHaveBeenCalledWith("owned", { force: true, focus: false });
    expect((await focus.run(context({ focusedSurface: async () => null }))).status).toBe("FAIL");
  });
  it("detects stripped worker argv, wrong registry role, and wrong pane column independently", async () => {
    for (const overrides of [
      { processArgs: vi.fn().mockResolvedValueOnce("codex -c features.apps=false").mockResolvedValue("codex resume synthetic") },
      { inspectAgent: async () => ({ role: "lead" }) },
      { readScreen: async () => ({ text: "OpenAI Codex\n• XMAC_resume_worker_unit\n› \nGPT-6-Luna low", column: 0, column_count: 2 }) },
    ]) expect((await worker.run(context(overrides))).status).toBe("FAIL");
  });
  it("requires independent raw screen evidence even when parsed state says ready", async () => {
    expect((await stale.run(context({ readScreen: async () => ({ parsed: { control_state: "ready" } }) }))).status).toBe("FAIL");
  });
  it("makes artifact failures fail the run", async () => {
    expect((await stray.run(context({ artifact: async () => { throw new Error("disk full"); } }))).status).toBe("FAIL");
  });
});
