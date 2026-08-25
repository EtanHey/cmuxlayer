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
import { CLI_READY_PATTERNS } from "../src/pattern-registry.js";
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

async function spawnReadyAgent(
  server: any,
  cli: "claude" | "codex" = "claude",
) {
  const spawn = server._registeredTools["spawn_agent"];
  const spawnResult = await spawn.handler(
    {
      repo: "brainlayer",
      model: "sonnet",
      cli,
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
    if (args.includes("list-windows")) {
      return {
        stdout: JSON.stringify({
          windows: [{ ref: "window:1", workspace_count: 1 }],
        }),
        stderr: "",
      };
    }
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

  it("send_to delivers through a rotating Codex placeholder", async () => {
    const { createServer, createServerContext } = await loadServerModule();
    let screenText =
      ">_ OpenAI Codex\n› Implement {feature}\n" +
      "gpt-5.6-sol high · ~/Gits/cmuxlayer\n";
    const mockExec = makeLifecycleExec(() => screenText);
    const context = createServerContext({
      exec: mockExec,
      stateDir: testDir,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
    });
    const server = createServer({ context });
    const agentId = await spawnReadyAgent(server, "codex");

    screenText =
      ">_ OpenAI Codex\n› Ask Codex to do anything\n" +
      "gpt-5.6-sol high · ~/Gits/cmuxlayer\n";
    mockExec.mockClear();

    const result = await (server as any)._registeredTools["send_to"].handler(
      { agent_id: agentId, text: "fleet message", press_enter: true },
      {} as any,
    );

    expect(parseToolResult(result)).toMatchObject({
      ok: true,
      delivered: true,
      delivery_state: "submitted",
    });
    expect(mutatedPane(mockExec)).toBe(true);
    context.dispose();
  }, 20_000);

  it("does not mistake a Codex-shaped human draft for a placeholder", async () => {
    const { createServer, createServerContext } = await loadServerModule();
    let screenText =
      ">_ OpenAI Codex\n› Implement {feature}\n" +
      "gpt-5.6-sol high · ~/Gits/cmuxlayer\n";
    const mockExec = makeLifecycleExec(() => screenText);
    const context = createServerContext({
      exec: mockExec,
      stateDir: testDir,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
    });
    const server = createServer({ context });
    const agentId = await spawnReadyAgent(server, "codex");

    screenText =
      ">_ OpenAI Codex\n› Write tests for @server.ts\n" +
      "gpt-5.6-sol high · ~/Gits/cmuxlayer\n";
    mockExec.mockClear();

    const result = await (server as any)._registeredTools["send_to"].handler(
      { agent_id: agentId, text: "fleet message", press_enter: true },
      {} as any,
    );

    expect(parseToolResult(result)).toMatchObject({
      delivered: false,
      terminal: false,
      delivery_state: "queued",
    });
    expect(mutatedPane(mockExec)).toBe(false);
    context.dispose();
  }, 20_000);
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
    const submitted = buildPublicDeliveryReceipt({
      delivery_state: "submitted",
      typed: true,
      submit_attempted: true,
      submit_verified: true,
      submit_evidence: "status_only",
      retry_count: 0,
    });
    expect(submitted.WARNING).toBeUndefined();
    expect(submitted.submit_evidence).toBe("status_only");
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

  it("keeps nonterminal retry attention visible in public receipts", async () => {
    const { buildPublicDeliveryReceipt } = await loadServerModule();
    expect(
      buildPublicDeliveryReceipt({
        delivery_state: "queued",
        delivery_id: "d-attention",
        typed: false,
        submit_attempted: false,
        submit_verified: null,
        retry_count: 3,
        needs_attention: true,
        attention_reason:
          "Delivery remains queued after 3 retryable refusals on a byte-identical target screen",
      }),
    ).toMatchObject({
      delivery_state: "queued",
      terminal: false,
      needs_attention: true,
      attention_reason: expect.stringMatching(/byte-identical/i),
    });
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
  let returnPressed = false;
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
    if (args.includes("send-key") && args.includes("return")) {
      returnPressed = true;
      return { stdout: "{}", stderr: "" };
    }
    if (args.includes("read-screen")) {
      return {
        stdout: JSON.stringify({
          surface: "surface:2",
          text: promptSent
            ? returnPressed
              ? postReturnScreen
              : "Claude Code\n> Read and follow the brief"
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

    // The spawn reports the truth as a nonterminal receipt for a prompt the
    // agent never consumed; callers may verify later without respawning.
    expect(parsed.ok).toBe(true);
    expect(parsed.boot_prompt_receipt).toMatchObject({
      terminal: false,
      delivered: false,
      delivery_state: "pending_verify",
      submit_verified: null,
    });
  }, 20_000);

  it("still verifies a boot prompt once the CLI has consumed tokens", async () => {
    const { createServer } = await loadServerModule();
    const mockExec = makeBootSplitExec(
      [
        "Claude Code",
        "> ",
        "  1,200 tokens",
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
    expect(parsed.boot_prompt_receipt.submit_evidence).toBe("token_delta");
    expect(parsed.boot_prompt_receipt.delivered).toBe(true);
  }, 20_000);
});

describe("boot-submit readiness and attributable evidence", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cmuxlayer-boot-readiness-"));
  });
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    vi.resetModules();
  });

  const codexReady = [
    ">_ OpenAI Codex",
    "› Ask Codex to do anything",
    "gpt-5.6-sol high · ~/Gits/cmuxlayer",
  ].join("\n");

  const writeBootPrompt = () => {
    const promptPath = join(testDir, "boot.md");
    writeFileSync(promptPath, "Read and follow the brief", "utf8");
    return promptPath;
  };

  function makeCodexBootExec(opts: {
    payloadAppears: boolean;
    submitAfterReturn?: number | null;
    staleReadyAfterReturn?: boolean;
    frontMatterReads?: number;
    blankAfterFrontMatter?: boolean;
    staleInterruptBeforeType?: boolean;
    interruptAfterReturn?: boolean;
    interruptBeforeEchoAfterReturn?: boolean;
    cli?: "codex" | "claude";
  }): {
    exec: ExecFn;
    returnPresses: () => number;
    promptSentAfterRead: () => number | null;
  } {
    let promptSent = false;
    let promptSentAfterRead: number | null = null;
    let returnPresses = 0;
    let screenReads = 0;
    let postReturnReads = 0;
    const exec: ExecFn = vi.fn().mockImplementation(
      async (_cmd, args: string[]) => {
        if (args.includes("new-split")) {
          const cli = opts.cli ?? "codex";
          return {
            stdout: JSON.stringify({
              workspace: "workspace:1",
              surface: "surface:2",
              pane: "pane:1",
              title: cli === "claude" ? "cmuxlayerClaude" : "cmuxlayerCodex",
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
                  title: "cmuxlayerCodex",
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
          promptSentAfterRead = screenReads;
          return { stdout: "{}", stderr: "" };
        }
        if (args.includes("send-key") && args.includes("return")) {
          returnPresses += 1;
          return { stdout: "{}", stderr: "" };
        }
        if (args.includes("read-screen")) {
          screenReads += 1;
          if (returnPresses > 0) {
            postReturnReads += 1;
          }
          const cli = opts.cli ?? "codex";
          const frontMatterActive =
            cli === "codex" && screenReads <= (opts.frontMatterReads ?? 0);
          const liveWorkingCodexScreen = [
            " ",
            "• Ran 6 commands · ctrl + t to view transcript",
            " ",
            "Working (19s • esc to interrupt)",
            " ",
            " ",
            "›",
            " ",
            " ",
            "  tab to queue message                                                    88% context left",
          ].join("\n");
          const readyScreen =
            cli === "claude"
              ? ["Claude Code", "What can I help you with?", "❯"].join("\n")
              : frontMatterActive
                ? liveWorkingCodexScreen
                : opts.blankAfterFrontMatter && !promptSent
                  ? ""
                  : opts.staleInterruptBeforeType && !promptSent
                    ? ["Conversation interrupted", codexReady].join("\n")
                    : codexReady;
          const submitted =
            opts.submitAfterReturn !== null &&
            opts.submitAfterReturn !== undefined &&
            returnPresses >= opts.submitAfterReturn;
          const text = !promptSent
            ? readyScreen
            : opts.staleReadyAfterReturn && returnPresses > 0
              ? readyScreen
            : opts.interruptBeforeEchoAfterReturn && postReturnReads === 1
              ? [
                  ">_ OpenAI Codex",
                  "■ Conversation interrupted - tell the model what to do differently. Something went wrong? Hit `/",
                  "  feedback` to report the issue.",
                  "",
                  "› Ask Codex to do anything",
                  "",
                  "gpt-5.6-sol high · ~/Gits/cmuxlayer",
                ].join("\n")
            : submitted
              ? cli === "claude"
                ? [
                    "Claude Code",
                    "Read and follow the brief",
                    "Working",
                    "❯",
                  ].join("\n")
                : [
                    ">_ OpenAI Codex",
                    ...(opts.interruptAfterReturn
                      ? ["Conversation interrupted"]
                      : []),
                    "• Read and follow the brief",
                    "Working (1s • esc to interrupt)",
                    "gpt-5.6-sol high · ~/Gits/cmuxlayer",
                  ].join("\n")
              : opts.payloadAppears
                ? cli === "claude"
                  ? ["Claude Code", "❯ Read and follow the brief"].join("\n")
                  : [
                      ">_ OpenAI Codex",
                      "» Read and follow the brief",
                      "gpt-5.6-sol high · ~/Gits/cmuxlayer",
                    ].join("\n")
                : cli === "claude"
                  ? ["Claude Code", "Working", "❯"].join("\n")
                  : [
                      ">_ OpenAI Codex",
                      "› Ask Codex to do anything",
                      "Working (1s • esc to interrupt)",
                      "gpt-5.6-sol high · ~/Gits/cmuxlayer",
                    ].join("\n");
          return {
            stdout: JSON.stringify({
              surface: "surface:2",
              text,
              lines: 80,
              scrollback_used: false,
            }),
            stderr: "",
          };
        }
        return { stdout: "{}", stderr: "" };
      },
    );
    return {
      exec,
      returnPresses: () => returnPresses,
      promptSentAfterRead: () => promptSentAfterRead,
    };
  }

  it("correlates the complete multi-paragraph Codex composer including blank lines and the » glyph", async () => {
    const { __submitEvidenceTestHooks } = await loadServerModule();
    const submitted = [
      "Read and follow /tmp/brief.md",
      "",
      "cmuxlayer contract for agent-1: Read and follow /tmp/contract.md",
    ].join("\n");
    const screen = [
      ">_ OpenAI Codex",
      "» Read and follow /tmp/brief.md",
      "",
      "  cmuxlayer contract for agent-1: Read and follow /tmp/contract.md",
      "gpt-5.6-sol high · ~/Gits/cmuxlayer",
    ].join("\n");

    expect(
      __submitEvidenceTestHooks.extractComposerInputRegion(screen, submitted),
    ).toContain("cmuxlayer contract for agent-1");
    expect(
      __submitEvidenceTestHooks.screenShowsCompletePendingInput(
        screen,
        submitted,
      ),
    ).toBe(true);
    expect(
      __submitEvidenceTestHooks.screenShowsCompletePendingInput(
        screen.replace("» Read and follow /tmp/brief.md", "» unrelated tail"),
        submitted,
      ),
    ).toBe(false);
  });

  it("requires multiple boot observations for a modern Codex ready composer without changing the global registry", async () => {
    const { __submitEvidenceTestHooks } = await loadServerModule();
    expect(CLI_READY_PATTERNS.codex.consecutive).toBe(1);
    expect(
      (__submitEvidenceTestHooks as any).requiredBootReadyObservations(
        "codex",
        codexReady,
      ),
    ).toBeGreaterThanOrEqual(2);
  });

  it("does not treat the combined Codex queue/context footer as composer content", async () => {
    const { __submitEvidenceTestHooks } = await loadServerModule();
    const screen = [
      ">_ OpenAI Codex",
      "› Ask Codex to do anything",
      "",
      "  tab to queue message                                      100% context left",
      "gpt-5.6-sol high · ~/Gits/cmuxlayer",
    ].join("\n");

    expect(
      __submitEvidenceTestHooks.extractComposerInputRegion(screen),
    ).toBe("");
  });

  it("waits for the front-matter turn to become idle before typing the boot prompt", async () => {
    const { createServer } = await loadServerModule();
    const harness = makeCodexBootExec({
      payloadAppears: true,
      submitAfterReturn: 1,
      frontMatterReads: 1,
    });
    const server = createServer({ exec: harness.exec, skipAgentLifecycle: true });

    const result = await (server as any)._registeredTools.new_split.handler(
      {
        direction: "right",
        workspace: "workspace:1",
        boot_prompt_path: writeBootPrompt(),
        boot_prompt_timeout_ms: 5_000,
      },
      {} as any,
    );
    const parsed = parseToolResult(result);

    expect(parsed.ok).toBe(true);
    expect(harness.promptSentAfterRead()).toBeGreaterThan(1);
    expect(parsed.boot_prompt_receipt.submit_verified).toBe(true);
  }, 20_000);

  it("returns banner-independent queued state by deadline without typing or pressing Return", async () => {
    const { createServer } = await loadServerModule();
    const harness = makeCodexBootExec({
      payloadAppears: true,
      submitAfterReturn: 1,
      frontMatterReads: 100,
    });
    const server = createServer({ exec: harness.exec, skipAgentLifecycle: true });

    const result = await (server as any)._registeredTools.new_split.handler(
      {
        direction: "right",
        workspace: "workspace:1",
        boot_prompt_path: writeBootPrompt(),
        boot_prompt_timeout_ms: 250,
      },
      {} as any,
    );
    const parsed = parseToolResult(result);

    expect(parsed.boot_prompt_receipt).toMatchObject({
      delivery_state: "queued",
      terminal: false,
      delivered: false,
      typed: false,
      submit_attempted: false,
      submit_verified: null,
      observation: {
        status: "working",
        composer_empty: true,
        prompt_echoed: false,
      },
    });
    expect(harness.promptSentAfterRead()).toBeNull();
    expect(harness.returnPresses()).toBe(0);
  }, 20_000);

  it("drops queued evidence when the live working frame is followed by a blank frame", async () => {
    const { createServer } = await loadServerModule();
    const harness = makeCodexBootExec({
      payloadAppears: true,
      submitAfterReturn: 1,
      frontMatterReads: 1,
      blankAfterFrontMatter: true,
    });
    const server = createServer({ exec: harness.exec, skipAgentLifecycle: true });

    const result = await (server as any)._registeredTools.new_split.handler(
      {
        direction: "right",
        workspace: "workspace:1",
        boot_prompt_path: writeBootPrompt(),
        boot_prompt_timeout_ms: 600,
      },
      {} as any,
    );
    const parsed = parseToolResult(result);

    expect(parsed.ok).toBe(false);
    expect(parsed.boot_prompt_receipt).toBeUndefined();
    expect(harness.promptSentAfterRead()).toBeNull();
    expect(harness.returnPresses()).toBe(0);
  }, 20_000);

  it("classifies transcript echo after a new interrupt as rescued, never verified", async () => {
    const { createServer } = await loadServerModule();
    const harness = makeCodexBootExec({
      payloadAppears: true,
      submitAfterReturn: 1,
      interruptAfterReturn: true,
    });
    const server = createServer({ exec: harness.exec, skipAgentLifecycle: true });

    const result = await (server as any)._registeredTools.new_split.handler(
      {
        direction: "right",
        workspace: "workspace:1",
        boot_prompt_path: writeBootPrompt(),
        boot_prompt_timeout_ms: 1_000,
      },
      {} as any,
    );
    const parsed = parseToolResult(result);

    expect(parsed.boot_prompt_receipt).toMatchObject({
      delivery_state: "rescued",
      terminal: true,
      delivered: false,
      submit_verified: false,
      submit_evidence: "transcript_echo",
    });
  }, 20_000);

  it("classifies a new interrupt as rescued when an older marker scrolled off before Return", async () => {
    const { createServer } = await loadServerModule();
    const harness = makeCodexBootExec({
      payloadAppears: true,
      submitAfterReturn: 1,
      staleInterruptBeforeType: true,
      interruptAfterReturn: true,
    });
    const server = createServer({ exec: harness.exec, skipAgentLifecycle: true });

    const result = await (server as any)._registeredTools.new_split.handler(
      {
        direction: "right",
        workspace: "workspace:1",
        boot_prompt_path: writeBootPrompt(),
        boot_prompt_timeout_ms: 1_000,
      },
      {} as any,
    );
    const parsed = parseToolResult(result);

    expect(parsed.boot_prompt_receipt).toMatchObject({
      delivery_state: "rescued",
      terminal: true,
      delivered: false,
      submit_verified: false,
      submit_evidence: "transcript_echo",
    });
  }, 20_000);

  it("latches a new interrupt that appears before the transcript echo frame", async () => {
    const { createServer } = await loadServerModule();
    const harness = makeCodexBootExec({
      payloadAppears: true,
      submitAfterReturn: 1,
      interruptBeforeEchoAfterReturn: true,
    });
    const server = createServer({ exec: harness.exec, skipAgentLifecycle: true });

    const result = await (server as any)._registeredTools.new_split.handler(
      {
        direction: "right",
        workspace: "workspace:1",
        boot_prompt_path: writeBootPrompt(),
        boot_prompt_timeout_ms: 1_000,
      },
      {} as any,
    );
    const parsed = parseToolResult(result);

    expect(parsed.boot_prompt_receipt).toMatchObject({
      delivery_state: "rescued",
      terminal: true,
      delivered: false,
      submit_verified: false,
      submit_evidence: "transcript_echo",
    });
  }, 20_000);

  it("does not press Return or certify status plus token_count:null before observing the payload", async () => {
    const { createServer } = await loadServerModule();
    const harness = makeCodexBootExec({
      payloadAppears: false,
      submitAfterReturn: null,
    });
    const server = createServer({
      exec: harness.exec,
      skipAgentLifecycle: true,
    });

    const result = await (server as any)._registeredTools.new_split.handler(
      {
        direction: "right",
        workspace: "workspace:1",
        boot_prompt_path: writeBootPrompt(),
        boot_prompt_timeout_ms: 500,
      },
      {} as any,
    );
    const parsed = parseToolResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.boot_prompt_receipt).toMatchObject({
      terminal: false,
      delivered: false,
      delivery_state: "pending_verify",
      submit_verified: null,
      retry_count: 0,
    });
    expect(harness.returnPresses()).toBe(0);
  }, 20_000);

  it("requires attributable pre-Return payload evidence for non-Codex boot prompts too", async () => {
    const { createServer } = await loadServerModule();
    const harness = makeCodexBootExec({
      cli: "claude",
      payloadAppears: false,
      submitAfterReturn: null,
    });
    const server = createServer({
      exec: harness.exec,
      skipAgentLifecycle: true,
    });

    const result = await (server as any)._registeredTools.new_split.handler(
      {
        direction: "right",
        workspace: "workspace:1",
        cli: "claude",
        boot_prompt_path: writeBootPrompt(),
        boot_prompt_timeout_ms: 500,
      },
      {} as any,
    );
    const parsed = parseToolResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.boot_prompt_receipt).toMatchObject({
      terminal: false,
      delivered: false,
      delivery_state: "pending_verify",
      submit_verified: null,
      retry_count: 0,
    });
    expect(harness.returnPresses()).toBe(0);
  }, 20_000);

  it("does not certify a stale pre-type ready frame after Return", async () => {
    const { createServer } = await loadServerModule();
    const harness = makeCodexBootExec({
      payloadAppears: true,
      submitAfterReturn: null,
      staleReadyAfterReturn: true,
    });
    const server = createServer({
      exec: harness.exec,
      skipAgentLifecycle: true,
    });

    const result = await (server as any)._registeredTools.new_split.handler(
      {
        direction: "right",
        workspace: "workspace:1",
        boot_prompt_path: writeBootPrompt(),
        boot_prompt_timeout_ms: 750,
      },
      {} as any,
    );
    const parsed = parseToolResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.boot_prompt_receipt).toMatchObject({
      terminal: false,
      delivered: false,
      delivery_state: "pending_verify",
      submit_verified: null,
      retry_count: 0,
    });
    expect(harness.returnPresses()).toBe(1);
  }, 20_000);

  it("uses one bounded recovery Return after the observed payload survives the first Return", async () => {
    const { createServer } = await loadServerModule();
    const harness = makeCodexBootExec({
      payloadAppears: true,
      submitAfterReturn: 2,
    });
    const server = createServer({
      exec: harness.exec,
      skipAgentLifecycle: true,
    });

    const result = await (server as any)._registeredTools.new_split.handler(
      {
        direction: "right",
        workspace: "workspace:1",
        boot_prompt_path: writeBootPrompt(),
        boot_prompt_timeout_ms: 1_500,
      },
      {} as any,
    );
    const parsed = parseToolResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.boot_prompt_receipt).toMatchObject({
      terminal: true,
      delivered: true,
      delivery_state: "submitted",
      submit_verified: true,
      submit_evidence: "transcript_echo",
      retry_count: 1,
    });
    expect(harness.returnPresses()).toBe(2);
  }, 20_000);

  it("returns nonterminal pending_verify when one recovery Return still leaves the observed payload pending", async () => {
    const { createServer } = await loadServerModule();
    const harness = makeCodexBootExec({
      payloadAppears: true,
      submitAfterReturn: null,
    });
    const server = createServer({
      exec: harness.exec,
      skipAgentLifecycle: true,
    });

    const result = await (server as any)._registeredTools.new_split.handler(
      {
        direction: "right",
        workspace: "workspace:1",
        boot_prompt_path: writeBootPrompt(),
        boot_prompt_timeout_ms: 1_500,
      },
      {} as any,
    );
    const parsed = parseToolResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.boot_prompt_receipt).toMatchObject({
      terminal: false,
      delivered: false,
      delivery_state: "pending_verify",
      submit_verified: null,
      retry_count: 1,
    });
    expect(harness.returnPresses()).toBe(2);
  }, 20_000);
});
