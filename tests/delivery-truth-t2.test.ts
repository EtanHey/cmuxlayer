import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExecFn } from "../src/cmux-client.js";
import { withTestSurfaceObserver } from "./helpers/test-surface-observer.js";

let testDir = "";

async function loadServerModule() {
  vi.resetModules();
  const serverModule = await import("../src/server.js");
  return {
    ...serverModule,
    createServerContext: (
      opts: Parameters<typeof serverModule.createServerContext>[0] = {},
    ) => serverModule.createServerContext(withTestSurfaceObserver(opts)),
    createServer: (
      opts: Parameters<typeof serverModule.createServer>[0] = {},
    ) =>
      serverModule.createServer(
        opts.context ? opts : withTestSurfaceObserver(opts),
      ),
  };
}

function parseToolResult(result: any) {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

async function spawnReadyAgent(server: any) {
  const spawn = server._registeredTools["spawn_agent"];
  const spawnResult = await spawn.handler(
    {
      repo: "brainlayer",
      model: "sonnet",
      cli: "claude",
      workspace: "workspace:1",
      boot_prompt_timeout_ms: 100,
    },
    {} as any,
  );
  const agentId = parseToolResult(spawnResult).agent_id;
  const engine = server._registeredTools.interact._engine;
  const registry = engine.getRegistry();
  registry.set(agentId, { ...registry.get(agentId), state: "ready" });
  return agentId;
}

function makeLifecycleExec(readScreenText: () => string): ExecFn {
  return vi.fn().mockImplementation(async (_cmd, args: string[]) => {
    if (args.includes("read-screen")) {
      return {
        stdout: JSON.stringify({
          surface: "surface:new",
          text: readScreenText(),
          lines: 20,
          scrollback_used: false,
        }),
        stderr: "",
      };
    }
    if (args.includes("list-workspaces")) {
      return {
        stdout: JSON.stringify({
          workspaces: [
            {
              ref: "workspace:1",
              title: "Main",
              index: 0,
              selected: true,
              pinned: false,
            },
          ],
        }),
        stderr: "",
      };
    }
    if (args.includes("list-panes")) {
      return {
        stdout: JSON.stringify({
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          panes: [
            {
              ref: "pane:1",
              index: 0,
              focused: true,
              surface_count: 1,
              surface_refs: ["surface:new"],
              selected_surface_ref: "surface:new",
            },
          ],
        }),
        stderr: "",
      };
    }
    if (args.includes("list-pane-surfaces")) {
      return {
        stdout: JSON.stringify({
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          pane_ref: "pane:1",
          surfaces: [
            {
              ref: "surface:new",
              title: "agent-pane",
              type: "terminal",
              index: 0,
              selected: true,
            },
          ],
        }),
        stderr: "",
      };
    }
    return {
      stdout: JSON.stringify({
        workspace: "workspace:1",
        surface: "surface:new",
        pane: "pane:1",
        title: "",
        type: "terminal",
      }),
      stderr: "",
    };
  });
}

const mutatedPane = (mockExec: any): boolean =>
  mockExec.mock.calls.some(([, args]: [string, string[]]) =>
    args.some((arg: string) =>
      ["send", "set-buffer", "paste-buffer", "send-key"].includes(arg),
    ),
  );

describe("T2 delivery truth — composer draft safety (#442)", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cmuxlayer-t2-delivery-truth-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("send_to refuses a composer holding human-typed draft text, before typing anything", async () => {
    const { createServer, createServerContext } = await loadServerModule();
    let screenText = "Claude Code\n❯ ";
    const mockExec = makeLifecycleExec(() => screenText);
    const context = createServerContext({
      exec: mockExec,
      stateDir: testDir,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
    });
    const server = createServer({ context });
    const agentId = await spawnReadyAgent(server);

    // A human left a half-written thought in the composer and never submitted.
    screenText = "Claude Code\n> so about the release, I think we should\n";
    mockExec.mockClear();

    const result = await (server as any)._registeredTools["send_to"].handler(
      { agent_id: agentId, text: "fleet message", press_enter: true },
      {} as any,
    );

    const parsed = parseToolResult(result);
    expect(parsed).toMatchObject({
      delivered: false,
      terminal: false,
      delivery_state: "queued",
    });
    expect(parsed.WARNING).toMatch(/not delivered yet/i);
    expect(parsed.WARNING).toMatch(/composer already holds text/i);
    expect(mutatedPane(mockExec)).toBe(false);
    context.dispose();
  }, 20_000);

  it("send_to still delivers when the composer is empty", async () => {
    const { createServer, createServerContext } = await loadServerModule();
    let screenText = "Claude Code\n❯ ";
    const mockExec = makeLifecycleExec(() => screenText);
    const context = createServerContext({
      exec: mockExec,
      stateDir: testDir,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
    });
    const server = createServer({ context });
    const agentId = await spawnReadyAgent(server);

    screenText = "Claude Code\n> \nCLAUDE_COUNTER:1\n";
    mockExec.mockClear();

    const result = await (server as any)._registeredTools["send_to"].handler(
      { agent_id: agentId, text: "fleet message", press_enter: true },
      {} as any,
    );

    expect(parseToolResult(result).ok).toBe(true);
    expect(mutatedPane(mockExec)).toBe(true);
    context.dispose();
  });
});

describe("T2 delivery truth — draft guard must not fire on chrome (B1)", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cmuxlayer-t2-delivery-truth-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    vi.resetModules();
  });

  // Every frame below has an EMPTY composer. The line under it is ordinary
  // Claude chrome that `isComposerFooterOrChromeLine` does not happen to
  // whitelist -- and a whitelist miss must never cost a ready pane a refusal.
  const EMPTY_COMPOSER_FRAMES: Array<[string, string]> = [
    [
      "shortcut hint",
      ["Claude Code", "", "\u23fa Compared both approaches.", "", "\u276f", "? for shortcuts"].join(
        "\n",
      ),
    ],
    [
      "accept-edits mode",
      ["Claude Code", "> ", "\u23f5\u23f5 accept edits on (shift+tab to cycle)"].join("\n"),
    ],
    [
      "busy spinner",
      ["Claude Code", "\u23fa Done.", "> ", "Working (2s \u2022 esc to interrupt)"].join("\n"),
    ],
    ["interrupt hint", ["Claude Code", "> ", "  esc to interrupt"].join("\n")],
  ];

  it.each(EMPTY_COMPOSER_FRAMES)(
    "treats an empty composer under %s as deliverable",
    async (_label, screen) => {
      const { __submitEvidenceTestHooks } = await loadServerModule();
      expect(
        __submitEvidenceTestHooks.composerHoldsForeignDraft(
          screen,
          "fleet message",
        ),
      ).toBe(false);
    },
  );

  it("still refuses when the prompt line itself carries someone else's text", async () => {
    const { __submitEvidenceTestHooks } = await loadServerModule();
    expect(
      __submitEvidenceTestHooks.composerHoldsForeignDraft(
        ["Claude Code", "> so about the release, I think we", "? for shortcuts"].join(
          "\n",
        ),
        "fleet message",
      ),
    ).toBe(true);
  });

  it("send_to delivers to a busy Claude pane whose composer is empty", async () => {
    const { createServer, createServerContext } = await loadServerModule();
    let screenText = "Claude Code\n\u276f ";
    const mockExec = makeLifecycleExec(() => screenText);
    const context = createServerContext({
      exec: mockExec,
      stateDir: testDir,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
    });
    const server = createServer({ context });
    const agentId = await spawnReadyAgent(server);

    screenText = [
      "Claude Code",
      "\u23fa Done.",
      "> ",
      "Working (2s \u2022 esc to interrupt)",
    ].join("\n");
    mockExec.mockClear();

    const result = await (server as any)._registeredTools["send_to"].handler(
      { agent_id: agentId, text: "fleet message", press_enter: true },
      {} as any,
    );

    expect(parseToolResult(result).ok).toBe(true);
    expect(mutatedPane(mockExec)).toBe(true);
    context.dispose();
  }, 20_000);
});

describe("T2 delivery truth — a blocked composer is not a terminal verdict (B1a)", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cmuxlayer-t2-delivery-truth-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("queues instead of terminally failing when the composer holds unflushed text", async () => {
    const { createServer, createServerContext } = await loadServerModule();
    let screenText = "Claude Code\n\u276f ";
    const mockExec = makeLifecycleExec(() => screenText);
    const context = createServerContext({
      exec: mockExec,
      stateDir: testDir,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
    });
    const server = createServer({ context });
    const agentId = await spawnReadyAgent(server);

    // This delivery's OWN prior message, still sitting unflushed in the
    // composer (the queued_followup shape). The guard cannot tell it from a
    // human draft -- and must not, because the right answer for both is
    // "wait for the composer to flush", never a terminal failure.
    screenText = "Claude Code\n> an earlier message that has not flushed yet\n";
    mockExec.mockClear();

    const result = await (server as any)._registeredTools["send_to"].handler(
      { agent_id: agentId, text: "second message", press_enter: true },
      {} as any,
    );

    const parsed = parseToolResult(result);
    expect(parsed).toMatchObject({
      ok: true,
      delivered: false,
      delivery_state: "queued",
      terminal: false,
    });
    expect(parsed.WARNING).toMatch(/not delivered yet/i);
    expect(parsed.WARNING).toMatch(/composer already holds text/i);
    // Still the property #442 exists for: nothing was typed.
    expect(mutatedPane(mockExec)).toBe(false);
    context.dispose();
  }, 20_000);
});

describe("T2 delivery truth — unmissable non-delivery (#445)", () => {
  it("attaches a plain-language WARNING to every nonterminal receipt", async () => {
    const { buildPublicDeliveryReceipt } = await loadServerModule();
    for (const state of ["pending_verify", "queued", "queued_followup"] as const) {
      const receipt = buildPublicDeliveryReceipt({
        delivery_state: state,
        delivery_id: "d-1",
        typed: true,
        submit_attempted: true,
        submit_verified: null,
        retry_count: 0,
      });
      expect(receipt).toMatchObject({ delivered: false, terminal: false });
      expect(receipt.WARNING).toMatch(/NOT DELIVERED YET/);
      expect(receipt.WARNING).toMatch(/do not relay as sent/i);
    }
  });

  it("attaches a terminal-failure WARNING to failed and failed_confirmed receipts", async () => {
    const { buildPublicDeliveryReceipt } = await loadServerModule();
    for (const state of ["failed", "failed_confirmed"] as const) {
      const receipt = buildPublicDeliveryReceipt({
        delivery_state: state,
        typed: true,
        submit_attempted: true,
        submit_verified: false,
        retry_count: 0,
      });
      expect(receipt).toMatchObject({ delivered: false, terminal: true });
      expect(receipt.WARNING).toMatch(/NOT DELIVERED/);
      expect(receipt.WARNING).toMatch(/do not relay as sent/i);
    }
  });

  it("leaves a verified submitted receipt unwarned and keeps an explicit WARNING", async () => {
    const { buildPublicDeliveryReceipt, pausedTargetWarning } =
      await loadServerModule();
    expect(
      buildPublicDeliveryReceipt({
        delivery_state: "submitted",
        typed: true,
        submit_attempted: true,
        submit_verified: true,
        retry_count: 0,
      }).WARNING,
    ).toBeUndefined();
    expect(
      buildPublicDeliveryReceipt({
        delivery_state: "queued",
        typed: false,
        submit_attempted: false,
        submit_verified: null,
        retry_count: 0,
        WARNING: pausedTargetWarning("registry"),
      }).WARNING,
    ).toBe(pausedTargetWarning("registry"));
  });
});

describe("T2 delivery truth — CLI-fallback hang guard (#450)", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cmuxlayer-t2-cli-timeout-"));
  });
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("kills a wedged cmux subprocess instead of awaiting it forever", async () => {
    const { CmuxClient, CMUX_CLI_EXEC_TIMEOUT_MS } = await import(
      "../src/cmux-client.js"
    );
    // The default ceiling matches the socket transport's request budget.
    expect(CMUX_CLI_EXEC_TIMEOUT_MS).toBe(10_000);

    // A `cmux` that never exits, whatever arguments it is handed.
    const wedged = join(testDir, "wedged-cmux");
    writeFileSync(wedged, "#!/bin/sh\nsleep 600\n", "utf8");
    chmodSync(wedged, 0o755);

    const client = new CmuxClient({ bin: wedged, execTimeoutMs: 150 });
    const startedAt = Date.now();

    await expect(client.listWorkspaces()).rejects.toThrow();

    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 20_000);
});

function makeBootSplitExec(postReturnScreen: string): ExecFn {
  let promptSent = false;
  return vi.fn().mockImplementation(async (_cmd, args: string[]) => {
    if (args.includes("new-split")) {
      return {
        stdout: JSON.stringify({
          workspace: "workspace:1",
          surface: "surface:2",
          pane: "pane:1",
          title: "New",
          type: "terminal",
        }),
        stderr: "",
      };
    }
    if (args.includes("list-panes")) {
      return {
        stdout: JSON.stringify({
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          panes: [
            {
              ref: "pane:1",
              index: 0,
              focused: true,
              surface_count: 1,
              surface_refs: ["surface:2"],
              selected_surface_ref: "surface:2",
            },
          ],
        }),
        stderr: "",
      };
    }
    if (args.includes("list-pane-surfaces")) {
      return {
        stdout: JSON.stringify({
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          pane_ref: "pane:1",
          surfaces: [
            {
              ref: "surface:2",
              title: "mimirClaude",
              type: "terminal",
              index: 0,
              selected: true,
            },
          ],
        }),
        stderr: "",
      };
    }
    if (args.includes("send") && !args.includes("send-key")) {
      promptSent = true;
      return { stdout: "{}", stderr: "" };
    }
    if (args.includes("read-screen")) {
      return {
        stdout: JSON.stringify({
          surface: "surface:2",
          text: promptSent
            ? postReturnScreen
            : "previous shell output: bun install\nClaude Code\n> ",
          lines: 80,
          scrollback_used: false,
        }),
        stderr: "",
      };
    }
    return { stdout: "{}", stderr: "" };
  });
}

describe("T2 delivery truth — boot consumption evidence (#427)", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cmuxlayer-t2-boot-tokens-"));
  });
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    vi.resetModules();
  });

  const writePrompt = () => {
    const promptPath = join(testDir, "boot.md");
    mkdirSync(testDir, { recursive: true });
    writeFileSync(promptPath, "Read and follow the brief", "utf8");
    return promptPath;
  };

  it("refuses submit_verified:true while the booted CLI reports 0 tokens", async () => {
    const { createServer } = await loadServerModule();
    // #427's race: the CLI is still initialising, so the screen already reads
    // as a working agent while the boot prompt has been consumed by nothing --
    // 0 tokens, $0.00, 0m.
    const mockExec = makeBootSplitExec(
      [
        "Claude Code",
        "> ",
        "  0 tokens",
        "  Opus 5 | $0.00 | 0m",
        "Working (1s - esc to interrupt)",
      ].join("\n"),
    );
    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });

    const result = await (server as any)._registeredTools[
      "new_split"
    ].handler(
      {
        direction: "right",
        workspace: "workspace:1",
        boot_prompt_path: writePrompt(),
        boot_prompt_timeout_ms: 50,
      },
      {} as any,
    );
    const parsed = parseToolResult(result);

    // The spawn reports the truth instead of a fully-verified receipt for a
    // prompt the agent never consumed.
    expect(parsed.ok).toBe(false);
    expect(parsed.submit_verified).not.toBe(true);
    expect(parsed.delivered).not.toBe(true);
    expect(parsed.boot_prompt_delivered).not.toBe(true);
    expect(parsed.error).toMatch(/boot prompt submit evidence/i);
  }, 20_000);

  it("still verifies a boot prompt once the CLI has consumed tokens", async () => {
    const { createServer } = await loadServerModule();
    const mockExec = makeBootSplitExec(
      [
        "Claude Code",
        "> ",
        "  1.2k tokens",
        "  Opus 5 | $0.03 | 1m",
        "Working (1s - esc to interrupt)",
      ].join("\n"),
    );
    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });

    const result = await (server as any)._registeredTools[
      "new_split"
    ].handler(
      {
        direction: "right",
        workspace: "workspace:1",
        boot_prompt_path: writePrompt(),
        boot_prompt_timeout_ms: 50,
      },
      {} as any,
    );
    const parsed = parseToolResult(result);

    expect(parsed.boot_prompt_receipt.submit_verified).toBe(true);
    expect(parsed.boot_prompt_receipt.delivered).toBe(true);
  }, 20_000);
});
