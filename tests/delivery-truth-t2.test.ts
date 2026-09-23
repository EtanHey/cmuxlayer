import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExecFn } from "../src/cmux-client.js";
import { CLI_READY_PATTERNS } from "../src/pattern-registry.js";
import { bootContractPointer, coordinationContractPath } from "../src/coordination-paths.js";
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

function makeLifecycleExec(readScreenText: () => string, surfaceUuid?: string): ExecFn {
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
              ...(surfaceUuid ? { id: surfaceUuid } : {}),
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
        ...(surfaceUuid ? { surface_id: surfaceUuid } : {}),
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

  it.each([
    // Captured read-only from surface:1144, 2026-09-15; scrollback falsely infers Claude.
    { cli: "codex", live: true, frame: readFileSync(new URL("../docs/fixtures/issue-645-codex-frame.txt", import.meta.url), "utf8") },
    { cli: "codex", frame: "› Ask Codex to do anything" },
    { cli: "codex", frame: "› Ask Codex to do anything\n\n  esc again to edit previous message" },
    { cli: "claude", frame: "Claude Code\n❯ Press up to edit queued messages" },
  ] as const)("#645 shares placeholder classification for text and Return ($cli, $frame)", async (specimen) => {
    const { cli, frame } = specimen;
    const live = "live" in specimen;
    if (live) expect((await import("../src/screen-parser.js")).parseScreen(frame).agent_type).toBe("claude");
    const { createServer, createServerContext } = await loadServerModule();
    let screen = cli === "codex" ? "› " : "Claude Code\n❯ ";
    const surfaceUuid = live ? "D9793BD9-0509-4884-B3D4-5C27BD2D8F57" : undefined;
    const exec = makeLifecycleExec(() => screen, surfaceUuid);
    const context = createServerContext({ exec, stateDir: testDir, disableSpawnPreflight: true, sessionIdentityResolver: () => null });
    try {
      const server = createServer({ context }) as any;
      const targetId = await spawnReadyAgent(server, cli);
      const engine = server._registeredTools.interact._engine;
      const target = { ...engine.getRegistry().get(targetId), cli, state: "ready", ...(surfaceUuid ? { surface_uuid: surfaceUuid } : {}) };
      engine.stateMgr.writeState(target);
      engine.getRegistry().set(targetId, target);
      for (const mode of ["agent", "surface", "key"] as const) {
        screen = frame;
        exec.mockClear();
        const result = parseToolResult(await server._registeredTools.send_to.handler({ mode, ...(mode === "agent" ? { agent_id: targetId } : { surface: "surface:new" }), text: mode === "key" ? "return" : "new message", press_enter: false }, {}));
        if (mode === "key") {
          expect(result).toMatchObject({ ok: false, error_code: "nothing_owned_to_submit", key_dispatched: false, submit_dispatched: false, submitted: false });
          expect(mutatedPane(exec)).toBe(false);
        } else {
          expect(result.ok, JSON.stringify(result)).toBe(true);
          expect(mutatedPane(exec)).toBe(true);
        }
        screen = live ? frame.replace("› Ask Codex to do anything", "› Ask Codex to do anything\n  and also delete the branch") : frame + "\nmy actual second line";
        exec.mockClear();
        const multiline = parseToolResult(await server._registeredTools.send_to.handler({ mode, ...(mode === "agent" ? { agent_id: targetId } : { surface: "surface:new" }), text: mode === "key" ? "return" : "new message", press_enter: false }, {}));
        expect(multiline.error_code).toBe("blocked_by_foreign_draft");
        expect(mutatedPane(exec)).toBe(false);
        screen = live ? frame.replace("› Ask Codex to do anything", "› please merge now") : frame.split("\n").slice(0, -1).concat(cli === "codex" ? "› Write tests for @server.ts" : "❯ Press up to edit queued messages that I wrote").join("\n");
        exec.mockClear();
        const refused = await server._registeredTools.send_to.handler({ mode, ...(mode === "agent" ? { agent_id: targetId } : { surface: "surface:new" }), text: mode === "key" ? "return" : "new message", press_enter: false }, {});
        const data = parseToolResult(refused);
        expect(data.error_code).toBe("blocked_by_foreign_draft");
        expect(data.error).toContain("try again in ~20 s or after your next turn");
        expect(JSON.parse(refused.content[0].text)).toMatchObject({ error: data.error, caller_agent_id: null });
        expect(mutatedPane(exec)).toBe(false);
      }
    } finally { context.dispose(); }
  });

  it.each(["foreign", "picker", "permission", "owned", "changed", "unknown", "other", "whitespace", "argument", "unchanged-space", "quoted-space", "indentation", "wrap", "unreadable", "blank", "unrecognized", "leading-blank", "spent", "auto-spent", "observed-clear", "prefix-read", "session-changed", "leading-blank-unknown", "shell-control", "unknown-cli-control", "spent-ambiguous", "recycled", "shared-owner", "shared-observed-clear", "shared-changed", "shared-other", "shared-inflight"].flatMap(kind => (kind.startsWith("leading-blank") ? ["claude", "cursor", "codex"] : ["claude", "cursor"]).map(cli => ({ kind, cli }))))("#636 key Return draft ownership (%j)", async ({ kind, cli }) => {
    const { createServer, createServerContext } = await loadServerModule();
    const { runWithCallerContext } = await import("../src/caller-context.js");
    const edits: Record<string, [string, string]> = {
      whitespace: ["foo bar", "foobar"],
      argument: ['echo "a b"', 'echo "ab"'],
      "unchanged-space": ["foo bar", "foo bar"],
      "quoted-space": ['echo "a  b"', 'echo "a b"'],
      indentation: ["  keep words", " keep words"],
      wrap: ["foo bar", "foo\nbar"],
    };
    const edit = edits[kind];
    const render = (input: string) => cli === "cursor" ? `Cursor Agent\ncursor> ${input}\nAuto` : cli === "codex" ? `OpenAI Codex\n› ${input}` : `Claude Code\n❯ ${input}`;
    let screen = render("");
    let readUnavailable = false;
    let liveUuid = "11111111-1111-4111-8111-111111111111";
    let returnAttempts = 0;
    let failReturn = false;
    let gateRead = false;
    let releaseRead!: () => void;
    const readBarrier = new Promise<void>(resolve => { releaseRead = resolve; });
    const base = makeLifecycleExec(() => screen);
    const exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
      if (kind === "recycled" && liveUuid.startsWith("2222") && args.includes("list-panes")) {
        const result = await base(cmd, args); const data = JSON.parse(result.stdout);
        data.panes[0].surface_refs.push("surface:kept"); data.panes[0].surface_count = 2;
        return { ...result, stdout: JSON.stringify(data) };
      }
      if (kind === "recycled" && args.includes("list-pane-surfaces")) {
        const result = await base(cmd, args); const data = JSON.parse(result.stdout);
        data.surfaces[0].id = liveUuid;
        if (liveUuid.startsWith("2222")) data.surfaces.push({ ...data.surfaces[0], ref: "surface:kept", id: "11111111-1111-4111-8111-111111111111" });
        return { ...result, stdout: JSON.stringify(data) };
      }
      if (args.includes("send-key") && args.includes("return") && kind === "spent-ambiguous" && failReturn) { returnAttempts++; throw new Error("connection_closed after dispatch"); }
      if (args.includes("read-screen") && gateRead) await readBarrier;
      if (args.includes("read-screen") && readUnavailable) throw new Error("read unavailable");
      if (args.includes("send")) screen = render(String(args.at(-1)));
      if (args.includes("send-key") && args.includes("return") && !["spent", "auto-spent"].includes(kind)) screen = render("");
      return base(cmd, args);
    });
    const context = createServerContext({ exec, stateDir: testDir, disableSpawnPreflight: true, sessionIdentityResolver: () => null });
    try {
      const server = createServer({ context }) as any;
      const targetId = await spawnReadyAgent(server);
      const peer = createServer({ context }) as any;
      const engine = server._registeredTools.interact._engine;
      const target = { ...engine.getRegistry().get(targetId), cli: kind.endsWith("-control") ? undefined : cli };
      engine.stateMgr.writeState(target); engine.getRegistry().set(targetId, target);
      const callerId = "draft-guard-sender";
      const callerUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const caller = { ...engine.getRegistry().get(targetId), agent_id: callerId, surface_id: "surface:caller", surface_uuid: callerUuid, role: "lead" };
      engine.stateMgr.writeState(caller);
      engine.getRegistry().set(callerId, caller);
      let callerSurface = callerUuid;
      const call = (args: Record<string, unknown>, callingServer = server) => runWithCallerContext((kind === "unknown" || kind === "leading-blank-unknown") ? undefined : { surfaceId: callerSurface, workspaceId: "workspace:1" }, () => callingServer._registeredTools.send_to.handler(args, {}));
      if (kind === "owned" || kind === "changed" || kind === "other" || ["spent", "spent-ambiguous", "auto-spent", "observed-clear", "prefix-read", "session-changed", "recycled", "shared-owner", "shared-observed-clear", "shared-changed", "shared-other", "shared-inflight"].includes(kind) || edit) {
        screen = render("");
        const typed = parseToolResult(await call({ mode: "surface", surface: "surface:new", text: edit?.[0] ?? "my undelivered message", press_enter: kind === "auto-spent" }));
        expect(typed.caller_agent_id).toBe(callerId);
        if (kind === "spent-ambiguous") failReturn = true;
        if (kind === "spent" || kind === "spent-ambiguous") await call({ mode: "key", surface: "surface:new", text: "return" });
        if (kind === "spent-ambiguous") expect(returnAttempts).toBe(1);
        if (kind === "recycled") {
          liveUuid = "22222222-2222-4222-8222-222222222222";
          await server._registeredTools.read_screen.handler({ surface: "surface:new" }, {});
          screen = render("");
          await server._registeredTools.read_screen.handler({ surface: "surface:kept" }, {});
          screen = render("my undelivered message");
        }
        if (kind === "shared-changed") {
          screen = render("a different person's prefix");
          await peer._registeredTools.read_screen.handler({ surface: "surface:new" }, {});
          screen = render("my undelivered message");
        }
        if (kind === "observed-clear" || kind === "shared-observed-clear" || kind === "shared-inflight") {
          const inspector = kind === "observed-clear" ? server : peer;
          await inspector._registeredTools.read_screen.handler({ surface: "surface:new" }, {});
          screen = render("");
          if (kind === "shared-inflight") {
            const readCalls = () => (exec as any).mock.calls.filter(([, args]: [string, string[]]) => args.includes("read-screen")).length;
            const beforeReads = readCalls(); gateRead = true;
            const firstRead = inspector._registeredTools.read_screen.handler({ surface: "surface:new" }, {});
            for (let i = 0; i < 100 && context.readScreenInflight.size === 0; i++) await Promise.resolve();
            expect(context.readScreenInflight.size).toBe(1);
            const joinedRead = server._registeredTools.read_screen.handler({ surface: "surface:new" }, {});
            for (let i = 0; i < 100; i++) await Promise.resolve();
            releaseRead(); await Promise.all([firstRead, joinedRead]); gateRead = false;
            expect(readCalls() - beforeReads).toBe(1);
          } else await inspector._registeredTools.read_screen.handler({ surface: "surface:new" }, {});
          screen = render("my undelivered message");
        }
        if (kind === "prefix-read") {
          screen = render("my undeliv");
          await server._registeredTools.read_screen.handler({ surface: "surface:new" }, {});
          screen = render("my undelivered message");
        }
        if (kind === "session-changed") {
          const changed = { ...target, cli_session_id: "new-harness-session" };
          engine.stateMgr.writeState(changed); engine.getRegistry().set(targetId, changed);
        }
        if (edit) screen = render(edit[1]);
        if (kind === "changed") screen = render("my undelivered message and human words");
        if (kind === "other" || kind === "shared-other") {
          callerSurface = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
          const other = { ...caller, agent_id: "other-sender", surface_id: "surface:other", surface_uuid: callerSurface };
          engine.stateMgr.writeState(other);
          engine.getRegistry().set(other.agent_id, other);
        }
      } else screen = kind === "permission" ? "Claude Code\nDo you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel" : kind === "picker" ? "Claude Code\nSelect model\n❯ 1. Sonnet\n  2. Opus\nEnter to confirm · Esc to cancel" : render("private human draft");
      if (kind === "shell-control") screen = "$ ";
      if (kind === "unknown-cli-control") screen = "Unrecognized terminal";
      if (kind === "unreadable") readUnavailable = true;
      if (kind === "blank") screen = "";
      if (kind === "unrecognized") screen = "Claude Code loading unknown layout";
      if (kind.startsWith("leading-blank")) screen = render("\nprivate human draft");
      exec.mockClear();
      const result = parseToolResult(await call({ mode: "key", surface: "surface:new", text: "return", engineSubmitProof: "launcher_pending_command" }, (kind === "shared-owner" || kind === "shared-other") ? peer : server));
      if (kind === "owned" || kind === "unchanged-space" || kind === "prefix-read" || kind === "shared-owner" || (kind === "auto-spent" && cli === "claude") || kind.endsWith("-control") || kind === "picker" || kind === "permission") {
        expect(result.ok).toBe(true);
        expect(mutatedPane(exec)).toBe(true);
        if (kind === "shared-owner") {
          screen = render("my undelivered message"); exec.mockClear();
          const spent = parseToolResult(await call({ mode: "key", surface: "surface:new", text: "return" }));
          expect(spent.error_code).toBe("blocked_by_foreign_draft"); expect(mutatedPane(exec)).toBe(false);
        }
      } else if (kind === "recycled") {
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/stable.*UUID|binding|recycl/i);
        expect(mutatedPane(exec)).toBe(false);
        // Observing B's identical text neither marked A seen nor invalidated A:
        // the pre-seen empty frame on A above must still allow its later text.
        const retained = parseToolResult(await call({ mode: "key", surface: "11111111-1111-4111-8111-111111111111", text: "return" }));
        expect(retained.ok, JSON.stringify(retained)).toBe(true);
      } else {
        const unknown = ["unreadable", "blank", "unrecognized"].includes(kind);
        expect(result.error_code).toBe(unknown ? "draft_ownership_unverified" : "blocked_by_foreign_draft");
        if (!unknown) expect(result.error).toContain("try again in ~20 s or after your next turn");
        expect(mutatedPane(exec)).toBe(false);
        if (!unknown) expect(screen).toContain(edit ? edit[1] : kind === "changed" ? "human words" : ["other", "spent", "spent-ambiguous", "auto-spent", "observed-clear", "shared-observed-clear", "shared-changed", "shared-other", "shared-inflight", "session-changed"].includes(kind) ? "my undelivered message" : "private human draft");
      }
      expect(result.caller_agent_id).toBe((kind === "unknown" || kind === "leading-blank-unknown") ? null : (kind === "other" || kind === "shared-other") ? "other-sender" : callerId);
    } finally { context.dispose(); }
  }, 15_000);

  it.each(["claude", "cursor"].flatMap(cli => [false, true].flatMap(seen => ["Auto", "remaining composer line"].map(partial => ({ cli, seen, partial })))))
    ("#636 partial screen reads are no ownership observation (%j)", async ({ cli, seen, partial }) => {
      const { createServer, createServerContext } = await loadServerModule();
      const { runWithCallerContext } = await import("../src/caller-context.js");
      const render = (input: string) => cli === "cursor" ? `Cursor Agent\ncursor> ${input}\nAuto` : `Claude Code\n❯ ${input}`;
      let screen = render(""); let partialRead = false;
      const base = makeLifecycleExec(() => screen);
      const exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
        if (args.includes("send")) screen = render(String(args.at(-1)));
        const result = await base(cmd, args);
        if (partialRead && args.includes("read-screen")) {
          expect(args[args.indexOf("--lines") + 1]).toBe("1");
          return { ...result, stdout: JSON.stringify({ surface: "surface:new", text: partial, lines: 1, scrollback_used: false }) };
        }
        return result;
      });
      const context = createServerContext({ exec, stateDir: testDir, disableSpawnPreflight: true, sessionIdentityResolver: () => null });
      try {
        const server = createServer({ context }) as any; const peer = createServer({ context }) as any;
        const id = await spawnReadyAgent(server); const engine = server._registeredTools.interact._engine;
        const target = { ...engine.getRegistry().get(id), cli }; engine.stateMgr.writeState(target); engine.getRegistry().set(id, target);
        const callerUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        const caller = { ...target, agent_id: "partial-reader", surface_id: "surface:caller", surface_uuid: callerUuid, role: "lead" };
        engine.stateMgr.writeState(caller); engine.getRegistry().set(caller.agent_id, caller);
        await runWithCallerContext({ surfaceId: callerUuid, workspaceId: "workspace:1" }, async () => {
          screen = render("");
          const typed = parseToolResult(await server._registeredTools.send_to.handler({ mode: "surface", surface: "surface:new", text: "owned partial-read message", press_enter: false }, {}));
          expect(typed).toMatchObject({ ok: true, caller_agent_id: caller.agent_id });
          if (seen) await peer._registeredTools.read_screen.handler({ surface: "surface:new" }, {});
          partialRead = true; await peer._registeredTools.read_screen.handler({ surface: "surface:new", lines: 1 }, {}); partialRead = false;
          exec.mockClear();
          const result = parseToolResult(await server._registeredTools.send_to.handler({ mode: "key", surface: "surface:new", text: "return", verify_submit: false }, {}));
          expect(result, JSON.stringify(result)).toMatchObject({ ok: true, caller_agent_id: caller.agent_id });
          expect(mutatedPane(exec)).toBe(true);
        });
      } finally { context.dispose(); }
    }, 15_000);

  it.each(["agent", "surface", "command", "key"])("#636 attributes even invalid send_to %s receipts", async (mode) => {
    const { createServer, createServerContext } = await loadServerModule();
    const context = createServerContext({ exec: makeLifecycleExec(() => "Claude Code\n❯ "), stateDir: testDir, disableSpawnPreflight: true, sessionIdentityResolver: () => null });
    try {
      const result = await (createServer({ context }) as any)._registeredTools.send_to.handler({ mode }, {});
      expect(parseToolResult(result)).toMatchObject({ ok: false, caller_agent_id: null });
    } finally { context.dispose(); }
  });

  it("submits its exact stranded boot contract before a Claude followup", async () => {
    const { createServer, createServerContext, __submitEvidenceTestHooks } = await loadServerModule();
    let composer = "";
    const submitted: string[] = [];
    let active = false;
    const screen = () => active
      ? ["Claude Code", ...submitted.map((text) => `⏺ ${text}`), "Working", `❯ ${composer}`].join("\n")
      : "Claude Code\n❯ ";
    const base = makeLifecycleExec(screen);
    const exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
      if (active && args.includes("send-key") && args.includes("return")) {
        submitted.push(composer);
        composer = "";
        return { stdout: "{}", stderr: "" };
      }
      if (active && args.includes("send")) {
        composer += String(args.at(-1));
        return { stdout: "{}", stderr: "" };
      }
      return base(cmd, args);
    });
    const context = createServerContext({ exec, stateDir: testDir, inboxBaseDir: testDir, disableSpawnPreflight: true, sessionIdentityResolver: () => null });
    try {
      const server = createServer({ context, inboxBaseDir: testDir }) as any;
      const agentId = await spawnReadyAgent(server);
      const engine = server._registeredTools.interact._engine;
      const record = engine.stateMgr.updateRecord(agentId, { boot_prompt_pending: true, submit_verified: null, prompt_delivered: false });
      engine.getRegistry().set(agentId, record);
      const pointer = bootContractPointer(agentId, coordinationContractPath(agentId, { baseDir: testDir }));
      composer = pointer;
      active = true;
      expect(engine.stateMgr.readState(agentId)?.state).toBe("booting");
      expect(engine.getAgentState(agentId)?.boot_prompt_pending).toBe(true);
      expect(__submitEvidenceTestHooks.screenShowsCompletePendingInput(screen(), pointer)).toBe(true);
      expect(__submitEvidenceTestHooks.composerHoldsForeignDraft(screen(), pointer, { cli: "claude", exact: true })).toBe(false);
      const result = parseToolResult(await server._registeredTools.send_to.handler({ agent_id: agentId, text: "Reply exactly SOAK2_1 then stop.", press_enter: true }, {}));
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(submitted).toEqual([pointer, "Reply exactly SOAK2_1 then stop."]);
      expect(engine.stateMgr.readState(agentId)?.state).toBe("working");
      expect(engine.getAgentState(agentId)?.state).toBe("working");
      // A completed boot no longer owns another copy of this deterministic
      // pointer, even if the composer text happens to match it exactly.
      composer = pointer;
      exec.mockClear();
      const completed = parseToolResult(await server._registeredTools.send_to.handler({ agent_id: agentId, text: "later", press_enter: true }, {}));
      expect(completed.error_code, JSON.stringify({ completed, submitted })).toBe("blocked_by_foreign_draft");
      expect(submitted).toHaveLength(2);
      composer = `${pointer} human edit`;
      const changed = parseToolResult(await server._registeredTools.send_to.handler({ agent_id: agentId, text: "next", press_enter: true }, {}));
      expect(changed.error_code).toBe("blocked_by_foreign_draft");
      expect(submitted).toHaveLength(2);
    } finally { context.dispose(); }
  }, 15_000);

  it("keeps a foreign Claude draft blocked while boot recovery is pending", async () => {
    const { createServer, createServerContext } = await loadServerModule();
    let screenText = "Claude Code\n❯ ";
    const exec = makeLifecycleExec(() => screenText);
    const context = createServerContext({ exec, stateDir: testDir, inboxBaseDir: testDir,
      disableSpawnPreflight: true, sessionIdentityResolver: () => null });
    try {
      const server = createServer({ context, inboxBaseDir: testDir }) as any;
      const agentId = await spawnReadyAgent(server);
      const engine = server._registeredTools.interact._engine;
      const boot = engine.stateMgr.updateRecord(agentId, {
        boot_prompt_pending: true, prompt_delivered: false, submit_verified: null,
      });
      engine.getRegistry().set(agentId, boot);
      const pointer = bootContractPointer(agentId, coordinationContractPath(agentId, { baseDir: testDir }));
      screenText = `Claude Code\nWorking\n❯ ${pointer} human edit`;
      exec.mockClear();

      const result = parseToolResult(await server._registeredTools.send_to.handler({
        agent_id: agentId, text: "followup", press_enter: true,
      }, {}));
      expect(result.error_code, JSON.stringify(result)).toBe("blocked_by_foreign_draft");
      expect(result.submit_dispatched).toBe(false);
      expect(exec.mock.calls.some(([, args]: [string, string[]]) =>
        args.includes("send-key") && args.includes("return"))).toBe(false);
      expect(engine.stateMgr.readState(agentId)?.boot_prompt_pending).toBe(true);
    } finally { context.dispose(); }
  }, 15_000);

  it("does not retry an ambiguously acknowledged boot recovery Return", async () => {
    const { createServer, createServerContext } = await loadServerModule();
    let composer = "";
    let active = false;
    let returnAttempts = 0;
    const followupWrites: string[] = [];
    const screen = () => active ? `Claude Code\nWorking\n❯ ${composer}` : "Claude Code\n❯ ";
    const base = makeLifecycleExec(screen);
    const exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
      if (active && args.includes("send-key") && args.includes("return")) {
        returnAttempts += 1;
        // The pane may have accepted Return; the transport lost its ack and
        // the screen still shows the old composer until the next repaint.
        throw new Error("connection closed");
      }
      if (active && args.includes("send")) {
        followupWrites.push(String(args.at(-1)));
        return { stdout: "{}", stderr: "" };
      }
      return base(cmd, args);
    });
    const context = createServerContext({ exec, stateDir: testDir, inboxBaseDir: testDir, disableSpawnPreflight: true, sessionIdentityResolver: () => null });
    try {
      const server = createServer({ context, inboxBaseDir: testDir }) as any;
      const agentId = await spawnReadyAgent(server);
      const engine = server._registeredTools.interact._engine;
      const record = engine.stateMgr.updateRecord(agentId, { boot_prompt_pending: true, submit_verified: null, prompt_delivered: false });
      engine.getRegistry().set(agentId, record);
      composer = bootContractPointer(agentId, coordinationContractPath(agentId, { baseDir: testDir }));
      active = true;

      const result = parseToolResult(await server._registeredTools.send_to.handler({ agent_id: agentId, text: "later", press_enter: true }, {}));
      expect(result.delivery_state).toBe("pending_verify");
      expect(result.submit_verified).toBeNull();
      expect(result.terminal).toBe(false);
      expect(result.WARNING).toContain("Return may have landed");
      expect(result.WARNING).toContain("followup was not typed");
      expect(returnAttempts).toBe(1);
      expect(followupWrites).toEqual([]);
      expect(result.ok).toBe(false);
      expect(result.submit_verified).not.toBe(true);
      const receipt = engine.getDeliveryReceipt(result.delivery_id);
      expect(receipt?.delivery_state).toBe("pending_verify");
      expect(receipt?.terminal).toBe(false);
      expect(receipt?.text).toBe(composer);
      expect(receipt?.source_event).toBe("boot_prompt");
      expect(receipt?.boot_recovery).toBe(true);
      expect(receipt?.boot_instance_id).toBe(engine.stateMgr.readState(agentId)?.boot_instance_id);
      expect(engine.getAgentState(agentId)?.boot_prompt_pending).toBe(true);
      composer = ""; // Return landed despite its lost acknowledgement.
      await engine.verifyPendingDeliveries();
      expect(engine.getDeliveryReceipt(result.delivery_id)?.delivery_state).toBe("submitted");
      expect(engine.getDeliveryReceipt(result.delivery_id)?.boot_recovery_finalized_at).toBeTruthy();
      expect(engine.stateMgr.readState(agentId)?.boot_prompt_pending).toBe(false);
      expect(engine.getAgentState(agentId)?.boot_prompt_pending).toBe(false);
      expect(engine.stateMgr.readState(agentId)?.prompt_delivered).toBe(true);
      expect(engine.stateMgr.readState(agentId)?.submit_verified).toBe(true);
      expect(engine.stateMgr.readState(agentId)?.state).toBe("working");
      expect(engine.getAgentState(agentId)?.state).toBe("working");
      expect(returnAttempts).toBe(1);
      expect(followupWrites).toEqual([]);
      const rebooted = engine.stateMgr.updateRecord(agentId, {
        state: "booting",
        boot_prompt_pending: true,
        prompt_delivered: false,
        submit_verified: null,
      });
      expect(rebooted.boot_instance_id).not.toBe(receipt?.boot_instance_id);
      engine.getRegistry().set(agentId, rebooted);
      await engine.verifyPendingDeliveries();
      expect(engine.getAgentState(agentId)?.state).toBe("booting");
      expect(engine.getAgentState(agentId)?.boot_prompt_pending).toBe(true);
      expect(returnAttempts).toBe(1);
      expect(followupWrites).toEqual([]);
      // A crash after receipt persistence and flag clearing can still repair
      // this *new* boot; the old receipt remains bound to its prior instance.
      const newReceipt = engine.acceptPendingVerify({
        delivery_id: "new-boot-repair",
        agent_id: agentId,
        text: composer,
        press_enter: true,
        source_event: "boot_prompt",
        retry_count: 0,
        typed: true,
        boot_recovery: true,
        boot_instance_id: rebooted.boot_instance_id,
      });
      engine.resolveDelivery({
        ...newReceipt,
        delivery_state: "submitted",
        terminal: true,
        submit_verified: true,
        error: null,
      });
      const partial = engine.stateMgr.updateRecord(agentId, {
        boot_prompt_pending: false,
        prompt_delivered: true,
        submit_verified: true,
      });
      engine.getRegistry().set(agentId, partial);
      await engine.verifyPendingDeliveries();
      expect(engine.getAgentState(agentId)?.state).toBe("working");
      expect(engine.getDeliveryReceipt(newReceipt.delivery_id)?.boot_recovery_finalized_at).toBeTruthy();
      expect(returnAttempts).toBe(1);
    } finally { context.dispose(); }
  }, 15_000);

  it("reports an acknowledged recovery Return when verification fails before a followup", async () => {
    vi.stubEnv("CMUXLAYER_SUBMIT_VERIFY_TIMEOUT_MS", "100");
    const { createServer, createServerContext } = await loadServerModule();
    let composer = "";
    let active = false;
    let returnAttempts = 0;
    const followupWrites: string[] = [];
    const screen = () => active ? `Claude Code\nWorking\n❯ ${composer}` : "Claude Code\n❯ ";
    const base = makeLifecycleExec(screen);
    const exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
      if (active && args.includes("send-key") && args.includes("return")) {
        returnAttempts += 1;
        return { stdout: "{}", stderr: "" };
      }
      if (active && args.includes("send")) {
        followupWrites.push(String(args.at(-1)));
        return { stdout: "{}", stderr: "" };
      }
      return base(cmd, args);
    });
    const context = createServerContext({ exec, stateDir: testDir, inboxBaseDir: testDir, disableSpawnPreflight: true, sessionIdentityResolver: () => null });
    try {
      const server = createServer({ context, inboxBaseDir: testDir }) as any;
      const agentId = await spawnReadyAgent(server);
      const engine = server._registeredTools.interact._engine;
      const record = engine.stateMgr.updateRecord(agentId, { boot_prompt_pending: true, submit_verified: null, prompt_delivered: false });
      engine.getRegistry().set(agentId, record);
      composer = bootContractPointer(agentId, coordinationContractPath(agentId, { baseDir: testDir }));
      active = true;

      const result = parseToolResult(await server._registeredTools.send_to.handler({ agent_id: agentId, text: "later", press_enter: false }, {}));
      expect(result.delivery_state).toBe("failed");
      expect(result.error_code).toBe("owned_boot_contract_pending");
      expect(result.typed).toBe(false);
      expect(result.submit_attempted).toBe(true);
      expect(result.submit_dispatched).toBe(true);
      expect(returnAttempts).toBe(1);
      expect(followupWrites).toEqual([]);
      expect(engine.getDeliveryReceipt(result.delivery_id)?.submit_dispatched).toBe(true);
    } finally {
      context.dispose();
      vi.unstubAllEnvs();
    }
  }, 15_000);

  it.each(["interact", "targeting", "surface", "background", "queued_nudge"] as const)("tracks a %s recovery Return when its acknowledgement is lost", async (mode) => {
    vi.stubEnv("CMUXLAYER_SUBMIT_VERIFY_TIMEOUT_MS", "100");
    const { createServer, createServerContext } = await loadServerModule();
    let composer = "";
    let active = false;
    let returnAttempts = 0;
    const followupWrites: string[] = [];
    const screen = () => active ? `Claude Code\nWorking\n❯ ${composer}` : "Claude Code\n❯ ";
    const base = makeLifecycleExec(screen);
    const exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
      if (active && args.includes("send-key") && args.includes("return")) {
        returnAttempts += 1;
        throw new Error("lost ack");
      }
      if (active && args.includes("send")) {
        followupWrites.push(String(args.at(-1)));
        return { stdout: "{}", stderr: "" };
      }
      return base(cmd, args);
    });
    const context = createServerContext({ exec, stateDir: testDir, inboxBaseDir: testDir, disableSpawnPreflight: true, sessionIdentityResolver: () => null });
    try {
      const server = createServer({ context, inboxBaseDir: testDir }) as any;
      const agentId = await spawnReadyAgent(server);
      const engine = server._registeredTools.interact._engine;
      const record = engine.stateMgr.updateRecord(agentId, { boot_prompt_pending: true, submit_verified: null, prompt_delivered: false });
      engine.getRegistry().set(agentId, record);
      const ready = engine.stateMgr.transition(agentId, "ready");
      engine.getRegistry().set(agentId, ready);
      composer = bootContractPointer(agentId, coordinationContractPath(agentId, { baseDir: testDir }));
      active = true;

      let result: any;
      if (mode === "queued_nudge") {
        const queued = engine.queueDelivery({ agent_id: agentId, text: "later", press_enter: true,
          source_event: "dispatch_nudge" });
        await engine.drainDeliveryQueue();
        result = { delivery_id: queued.delivery_id };
      } else {
        result = parseToolResult(mode === "interact"
          ? await server._registeredTools.interact.handler({ agent: agentId, action: "send", text: "later" }, {})
          : mode === "targeting"
            ? await server._registeredTools.send_to.handler({ text: "later", press_enter: true,
                targeting: { agent_ids: [agentId] } }, {})
            : mode === "surface"
              ? await server._registeredTools.send_input.handler({ surface: "surface:new", text: "later",
                  press_enter: true }, {})
            : await server._registeredTools.send_input.handler({ surface: "surface:new", text: "later",
                press_enter: true, background: true }, {}));
      }
      let pending = engine.listDeliveryReceipts().filter((receipt: any) => receipt.boot_recovery && receipt.agent_id === agentId);
      for (let attempt = 0; mode === "background" && pending.length === 0 && attempt < 50; attempt += 1) {
        await new Promise((done) => setTimeout(done, 10));
        pending = engine.listDeliveryReceipts().filter((receipt: any) => receipt.boot_recovery && receipt.agent_id === agentId);
      }
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ delivery_state: "pending_verify", terminal: false,
        text: composer, boot_instance_id: engine.stateMgr.readState(agentId)?.boot_instance_id });
      if (mode === "interact" || mode === "surface") {
        expect(result.ok).toBe(false);
        expect(result.delivery_state).toBe("pending_verify");
      } else if (mode === "targeting") {
        expect(result.pending_verify_count).toBe(1);
        expect(result.receipts).toEqual([expect.objectContaining({
          agent_id: agentId, delivery_state: "pending_verify", submit_attempted: true,
          terminal: false, accepted: false,
        })]);
      } else if (mode === "background") {
        const delivery = parseToolResult(await server._registeredTools.read_screen.handler({ surface: "surface:new" }, {}));
        expect(delivery.delivery?.status).toBe("pending_verify");
      } else {
        expect(pending[0].delivery_id).toBe(result.delivery_id);
      }
      expect(returnAttempts).toBe(1);
      expect(followupWrites).toEqual([]);
      composer = ""; // The recovery Return landed despite the lost acknowledgement.
      await engine.verifyPendingDeliveries();
      expect(engine.getDeliveryReceipt(pending[0].delivery_id)?.delivery_state).toBe("submitted");
      expect(engine.getAgentState(agentId)?.boot_prompt_pending).toBe(false);
      expect(returnAttempts).toBe(1);
      expect(followupWrites).toEqual([]);
    } finally {
      context.dispose();
      vi.unstubAllEnvs();
    }
  }, 15_000);

  it("keeps a newer boot pending when a recovered Return loses its ack during restart", async () => {
    const { createServer, createServerContext } = await loadServerModule();
    let composer = "";
    let active = false;
    let returnAttempts = 0;
    let agentId = "";
    let engine: any;
    let newerBootId: string | undefined;
    const followupWrites: string[] = [];
    const screen = () => active ? `Claude Code\nWorking\n❯ ${composer}` : "Claude Code\n❯ ";
    const base = makeLifecycleExec(screen);
    const exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
      if (active && args.includes("send-key") && args.includes("return")) {
        returnAttempts += 1;
        // The old boot's Return may have landed before the transport lost its
        // ack; the same agent ID begins a newer boot during that await.
        const restarted = engine.stateMgr.resetState(agentId, "booting", {
          boot_prompt_pending: true,
          prompt_delivered: false,
          submit_verified: null,
        }, "test_restart_during_return");
        newerBootId = restarted.boot_instance_id;
        engine.getRegistry().set(agentId, restarted);
        throw new Error("connection closed");
      }
      if (active && args.includes("send")) {
        followupWrites.push(String(args.at(-1)));
        return { stdout: "{}", stderr: "" };
      }
      return base(cmd, args);
    });
    const context = createServerContext({ exec, stateDir: testDir, inboxBaseDir: testDir, disableSpawnPreflight: true, sessionIdentityResolver: () => null });
    try {
      const server = createServer({ context, inboxBaseDir: testDir }) as any;
      agentId = await spawnReadyAgent(server);
      engine = server._registeredTools.interact._engine;
      const oldBoot = engine.stateMgr.updateRecord(agentId, { boot_prompt_pending: true, prompt_delivered: false, submit_verified: null });
      engine.getRegistry().set(agentId, oldBoot);
      composer = bootContractPointer(agentId, coordinationContractPath(agentId, { baseDir: testDir }));
      active = true;

      const result = parseToolResult(await server._registeredTools.send_to.handler({ agent_id: agentId, text: "later", press_enter: true }, {}));
      expect(returnAttempts).toBe(1);
      expect(followupWrites).toEqual([]);
      expect(result.delivery_state).toBe("pending_verify");
      const receipt = engine.getDeliveryReceipt(result.delivery_id);
      expect(newerBootId).not.toBe(oldBoot.boot_instance_id);
      expect(receipt?.boot_instance_id).toBe(oldBoot.boot_instance_id);
      expect(engine.getAgentState(agentId)?.boot_instance_id).toBe(newerBootId);
      composer = "";
      await engine.verifyPendingDeliveries();
      expect(engine.getDeliveryReceipt(result.delivery_id)?.delivery_state).toBe("pending_verify");
      expect(engine.getAgentState(agentId)?.state).toBe("booting");
      expect(engine.getAgentState(agentId)?.boot_prompt_pending).toBe(true);
      expect(engine.getAgentState(agentId)?.prompt_delivered).toBe(false);
      expect(returnAttempts).toBe(1);
      expect(followupWrites).toEqual([]);
    } finally { context.dispose(); }
  }, 15_000);

  it("does not submit a changed composer after observing its owned boot pointer", async () => {
    const { createServer, createServerContext } = await loadServerModule();
    let composer = "";
    let active = false;
    let changedAfterRead = false;
    let activeReads = 0;
    const submitted: string[] = [];
    const screen = () => active ? `Claude Code\nWorking\n❯ ${composer}` : "Claude Code\n❯ ";
    const base = makeLifecycleExec(screen);
    const exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
      if (active && args.includes("read-screen")) {
        const snapshot = await base(cmd, args);
        activeReads += 1;
        // Route checks read earlier frames; this is the recovery's owned
        // pointer snapshot, just before its mutation guard and Return.
        if (activeReads === 4) {
          composer = "human draft";
          changedAfterRead = true;
        }
        return snapshot;
      }
      if (active && args.includes("send-key") && args.includes("return")) {
        submitted.push(composer);
        composer = "";
        return { stdout: "{}", stderr: "" };
      }
      if (active && args.includes("send")) {
        composer += String(args.at(-1));
        return { stdout: "{}", stderr: "" };
      }
      return base(cmd, args);
    });
    const context = createServerContext({ exec, stateDir: testDir, inboxBaseDir: testDir, disableSpawnPreflight: true, sessionIdentityResolver: () => null });
    try {
      const server = createServer({ context, inboxBaseDir: testDir }) as any;
      const agentId = await spawnReadyAgent(server);
      const engine = server._registeredTools.interact._engine;
      const record = engine.stateMgr.updateRecord(agentId, { boot_prompt_pending: true, submit_verified: null, prompt_delivered: false });
      engine.getRegistry().set(agentId, record);
      composer = bootContractPointer(agentId, coordinationContractPath(agentId, { baseDir: testDir }));
      active = true;

      const result = parseToolResult(await server._registeredTools.send_to.handler({ agent_id: agentId, text: "later", press_enter: true }, {}));
      expect(changedAfterRead).toBe(true);
      expect(submitted).toEqual([]);
      expect(composer).toBe("human draft");
      expect(result.error_code, JSON.stringify(result)).toBe("blocked_by_foreign_draft");
      expect(result.submit_dispatched, JSON.stringify(result)).toBe(false);
    } finally { context.dispose(); }
  }, 15_000);

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
      { mode: "agent", agent_id: agentId, text: "fleet message", press_enter: true, verbose: true },
      {} as any,
    );

    const parsed = parseToolResult(result);
    expect(result.isError).toBe(true);
    expect(parsed).toMatchObject({
      delivered: false,
      terminal: true,
      delivery_state: "failed",
      submitted: false,
      error_code: "blocked_by_foreign_draft",
    });
    expect(parsed.WARNING).toMatch(/terminal failure/i);
    expect(parsed.error).toMatch(/composer already holds text/i);
    expect(parsed.error).toContain("try again in ~20 s or after your next turn");
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
      { mode: "agent", agent_id: agentId, text: "fleet message", press_enter: true },
      {} as any,
    );

    expect(parseToolResult(result).ok).toBe(true);
    expect(mutatedPane(mockExec)).toBe(true);
    context.dispose();
  });

  it("interact skill refuses a non-empty composer and names its contents", async () => {
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
    screenText = "Claude Code\n❯ keep this human draft\n";
    mockExec.mockClear();

    const result = await (server as any)._registeredTools.interact.handler(
      { agent: agentId, action: "skill", command: "/review" },
      {} as any,
    );
    expect(result.isError).toBe(true);
    expect(parseToolResult(result).error).toContain("keep this human draft");
    expect(mutatedPane(mockExec)).toBe(false);
    context.dispose();
  });

  it("interact skill submits from an empty composer and receipts the screen result", async () => {
    const { createServer, createServerContext } = await loadServerModule();
    let screenText = "Claude Code\n❯ ";
    let submitted = false;
    const baseExec = makeLifecycleExec(() => screenText);
    const mockExec: ExecFn = vi.fn().mockImplementation(
      async (command: string, args: string[]) => {
        if (args.includes("send-key") && args.includes("return")) {
          submitted = true;
        }
        if (
          submitted &&
          args.includes("read-screen") &&
          args.includes("--lines") &&
          args.includes("20")
        ) {
          return {
            stdout: JSON.stringify({
              surface: "surface:new",
              text: "Claude Code\n❯ /review\nCLAUDE_COUNTER:1\n",
              lines: 20,
              scrollback_used: false,
            }),
            stderr: "",
          };
        }
        return baseExec(command, args);
      },
    );
    const context = createServerContext({
      exec: mockExec,
      stateDir: testDir,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
    });
    const server = createServer({ context });
    const agentId = await spawnReadyAgent(server);
    submitted = false;
    screenText = "Claude Code\n❯ \nCLAUDE_COUNTER:1\n";
    mockExec.mockClear();

    const result = await (server as any)._registeredTools.interact.handler(
      { agent: agentId, action: "skill", command: "/review" },
      {} as any,
    );
    expect(parseToolResult(result)).toMatchObject({
      ok: true,
      submit_verified: true,
      screen_result_line: "CLAUDE_COUNTER:1",
    });
    expect(mutatedPane(mockExec)).toBe(true);
    context.dispose();
  });

  it("interact skill does not report terminal chrome as a screen result", async () => {
    const { createServer, createServerContext } = await loadServerModule();
    let screenText = "Claude Code\n❯ ";
    let submitted = false;
    const baseExec = makeLifecycleExec(() => screenText);
    const mockExec: ExecFn = vi.fn().mockImplementation(
      async (command: string, args: string[]) => {
        if (args.includes("send-key") && args.includes("return")) {
          submitted = true;
        }
        if (
          submitted &&
          args.includes("read-screen") &&
          args.includes("--lines") &&
          args.includes("20")
        ) {
          return {
            stdout: JSON.stringify({
              surface: "surface:new",
              text:
                "Claude Code\n⏺ Earlier unrelated answer\n❯ /review\n⏵⏵ bypass permissions on · 2 monitors\n",
              lines: 20,
              scrollback_used: false,
            }),
            stderr: "",
          };
        }
        return baseExec(command, args);
      },
    );
    const context = createServerContext({
      exec: mockExec,
      stateDir: testDir,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
    });
    const server = createServer({ context });
    const agentId = await spawnReadyAgent(server);
    submitted = false;
    screenText = "Claude Code\n❯ \nCLAUDE_COUNTER:1\n";

    const result = await (server as any)._registeredTools.interact.handler(
      { agent: agentId, action: "skill", command: "/review" },
      {} as any,
    );

    expect(parseToolResult(result)).toMatchObject({
      ok: true,
      submit_verified: true,
      screen_result_available: false,
      screen_result_line: null,
    });
    context.dispose();
  });

  it.each([
    "✻ Thinking…",
    "✻ Working…",
    "⏺ Running…",
    "❯ investigate next issue",
  ])(
    "interact skill does not report non-result row %s as a screen result",
    async (nonResultLine) => {
      const { createServer, createServerContext } = await loadServerModule();
      let screenText = "Claude Code\n❯ ";
      let submitted = false;
      const baseExec = makeLifecycleExec(() => screenText);
      const mockExec: ExecFn = vi.fn().mockImplementation(
        async (command: string, args: string[]) => {
          if (args.includes("send-key") && args.includes("return")) {
            submitted = true;
          }
          if (
            submitted &&
            args.includes("read-screen") &&
            args.includes("--lines") &&
            args.includes("20")
          ) {
            return {
              stdout: JSON.stringify({
                surface: "surface:new",
                text: `Claude Code\n❯ /review\n${nonResultLine}\n`,
                lines: 20,
                scrollback_used: false,
              }),
              stderr: "",
            };
          }
          return baseExec(command, args);
        },
      );
      const context = createServerContext({
        exec: mockExec,
        stateDir: testDir,
        disableSpawnPreflight: true,
        sessionIdentityResolver: () => null,
      });
      const server = createServer({ context });
      const agentId = await spawnReadyAgent(server);
      submitted = false;

      const result = await (server as any)._registeredTools.interact.handler(
        { agent: agentId, action: "skill", command: "/review" },
        {} as any,
      );

      expect(parseToolResult(result)).toMatchObject({
        ok: true,
        submit_verified: true,
        screen_result_available: false,
        screen_result_line: null,
      });
      context.dispose();
    },
  );

  it("interact skill does not reuse a historical identical command echo", async () => {
    const { createServer, createServerContext } = await loadServerModule();
    let submitted = false;
    const beforeScreen =
      "Claude Code\n❯ /review\n⏺ Historical review result\n❯ \n";
    const baseExec = makeLifecycleExec(() =>
      submitted ? `${beforeScreen}CLAUDE_COUNTER:1\n` : beforeScreen,
    );
    const mockExec: ExecFn = vi.fn().mockImplementation(
      async (command: string, args: string[]) => {
        if (args.includes("send-key") && args.includes("return")) {
          submitted = true;
        }
        return baseExec(command, args);
      },
    );
    const context = createServerContext({
      exec: mockExec,
      stateDir: testDir,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
    });
    const server = createServer({ context });
    const agentId = await spawnReadyAgent(server);
    submitted = false;

    const result = await (server as any)._registeredTools.interact.handler(
      { agent: agentId, action: "skill", command: "/review" },
      {} as any,
    );

    expect(parseToolResult(result)).toMatchObject({
      ok: true,
      submit_verified: true,
      screen_result_available: false,
      screen_result_line: null,
    });
    context.dispose();
  });

  it("interact skill keeps the successful receipt when only its final observation fails", async () => {
    const { createServer, createServerContext } = await loadServerModule();
    let screenText = "Claude Code\n❯ ";
    let failFinalObservation = false;
    const baseExec = makeLifecycleExec(() => screenText);
    const mockExec: ExecFn = vi.fn().mockImplementation(
      async (command: string, args: string[]) => {
        if (
          failFinalObservation &&
          args.includes("read-screen") &&
          args.includes("--lines") &&
          args.includes("20")
        ) {
          throw new Error("surface disappeared after submitted skill");
        }
        return baseExec(command, args);
      },
    );
    const context = createServerContext({
      exec: mockExec,
      stateDir: testDir,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
    });
    const server = createServer({ context });
    const agentId = await spawnReadyAgent(server);
    screenText = "Claude Code\n> \nCLAUDE_COUNTER:1\n";
    failFinalObservation = true;

    const result = await (server as any)._registeredTools.interact.handler(
      { agent: agentId, action: "skill", command: "/review" },
      {} as any,
    );

    expect(result.isError).not.toBe(true);
    expect(parseToolResult(result)).toMatchObject({
      ok: true,
      submit_verified: true,
      screen_result_available: false,
      screen_result_line: null,
    });
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
      { mode: "agent", agent_id: agentId, text: "fleet message", press_enter: true, verbose: true },
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
      { mode: "agent", agent_id: agentId, text: "fleet message", press_enter: true },
      {} as any,
    );

    expect(result.isError).toBe(true);
    expect(parseToolResult(result)).toMatchObject({
      delivered: false,
      terminal: true,
      delivery_state: "failed",
      error_code: "blocked_by_foreign_draft",
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
      { mode: "agent", agent_id: agentId, text: "fleet message", press_enter: true },
      {} as any,
    );

    expect(parseToolResult(result).ok).toBe(true);
    expect(mutatedPane(mockExec)).toBe(true);
    context.dispose();
  }, 20_000);
});

describe("T2 delivery truth — a blocked composer is a terminal refusal (B1a)", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cmuxlayer-t2-delivery-truth-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("refuses instead of accepting a send when the composer holds unflushed text", async () => {
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

    // The guard cannot prove who owns this existing draft. It can prove that
    // appending and pressing Return is unsafe, so this invocation must refuse.
    screenText = "Claude Code\n> an earlier message that has not flushed yet\n";
    mockExec.mockClear();

    const result = await (server as any)._registeredTools["send_to"].handler(
      { mode: "agent", agent_id: agentId, text: "second message", press_enter: true },
      {} as any,
    );

    const parsed = parseToolResult(result);
    expect(result.isError).toBe(true);
    expect(parsed).toMatchObject({
      ok: false,
      delivered: false,
      delivery_state: "failed",
      terminal: true,
      error_code: "blocked_by_foreign_draft",
    });
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
        typed: false,
        submit_attempted: true,
        submit_verified: false,
        retry_count: 0,
      });
      expect(receipt).toMatchObject({ delivered: false, terminal: true });
      expect(receipt.WARNING).toMatch(/NOT DELIVERED/);
      expect(receipt.WARNING).toMatch(/do not relay as sent/i);
    }
  });

  it.each([
    [["surface.send_text"]],
    [["surface.send_text", "surface.send_key"]],
  ] as const)(
    "warns against resending when a failed delivery already used %j",
    async (rpcMethods) => {
      const { buildPublicDeliveryReceipt } = await loadServerModule();
      const receipt = buildPublicDeliveryReceipt({
        delivery_state: "failed",
        delivery_id: "d-partial",
        typed: true,
        submit_attempted: true,
        submit_verified: false,
        retry_count: 0,
        rpc_methods: [...rpcMethods],
      });

      expect(receipt.WARNING).toMatch(/PARTIALLY DELIVERED/);
      expect(receipt.WARNING).toMatch(/text reached the target/i);
      expect(receipt.WARNING).toMatch(/do not resend/i);
      expect(receipt.WARNING).not.toMatch(/message did not land/i);
    },
  );

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
    payloadAppearsAfterPostPasteReads?: number;
    firstPostPasteReadDelayMs?: number;
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
    let postPasteReads = 0;
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
          if (promptSent && returnPresses === 0) {
            postPasteReads += 1;
            if (postPasteReads === 1 && opts.firstPostPasteReadDelayMs) {
              await new Promise((resolve) => setTimeout(resolve, opts.firstPostPasteReadDelayMs));
            }
          }
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
            : opts.payloadAppears &&
                postPasteReads >= (opts.payloadAppearsAfterPostPasteReads ?? 1)
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

  it("recognizes the full wrapped Claude brief and contract pointers before Return", async () => {
    const { __submitEvidenceTestHooks } = await loadServerModule();
    const submitted = [
      "Read and follow /tmp/brief.md",
      "",
      "cmuxlayer contract for agent-1: Read and follow /tmp/contract.md",
    ].join("\n");
    const screen = [
      "Claude Code",
      "❯ Read and follow /tmp/brief.md",
      "  ",
      "  cmuxlayer contract for agent-1: Read and follow",
      "  /tmp/contract.md",
      "────────────────────────────────────────────────────────────────",
      "🤖 Opus 5.5 (1M context) | 💰 $0.00",
    ].join("\n");

    expect(__submitEvidenceTestHooks.screenShowsCompletePendingInput(screen, submitted)).toBe(true);
  });

  it("keeps a single-line Claude brief and engine contract pointer in one submit", async () => {
    const { __submitEvidenceTestHooks } = await loadServerModule();
    const brief = "Reply exactly SOAK_OK_1 then stop.";
    const pointer = "cmuxlayer contract for cmuxlayerClaude-160e1e30: Read and follow /tmp/contract.md";
    const delivered = __submitEvidenceTestHooks.composeBootDeliveryText(brief, pointer, "claude");
    expect(delivered).toContain(brief);
    expect(delivered).toContain(pointer);
    expect(delivered).not.toMatch(/[\r\n]/);
  });

  it("keeps a two-line Claude brief and contract pointer in one submit", async () => {
    const { __submitEvidenceTestHooks } = await loadServerModule();
    const brief = "Line one\nLine two";
    const pointer = "cmuxlayer contract for agent-1: Read and follow /tmp/contract.md";
    expect(__submitEvidenceTestHooks.composeBootDeliveryText(brief, pointer, "claude"))
      .toBe(`${brief} ; ${pointer}`);
  });

  it("delivers an injected-only boot contract without a leading paragraph break", async () => {
    const { __submitEvidenceTestHooks } = await loadServerModule();
    const pointer = "cmuxlayer contract for agent-1: Read and follow /tmp/contract.md";
    expect(__submitEvidenceTestHooks.composeBootDeliveryText("", pointer, "codex")).toBe(pointer);
    expect(__submitEvidenceTestHooks.composeBootDeliveryText("", pointer, "claude")).toBe(pointer);
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

  it("submits a Claude boot prompt when CLI fallback renders the owned draft after the first 250ms", async () => {
    const { createServer } = await loadServerModule();
    const harness = makeCodexBootExec({
      cli: "claude",
      payloadAppears: true,
      payloadAppearsAfterPostPasteReads: 2,
      firstPostPasteReadDelayMs: 400,
      submitAfterReturn: 1,
    });
    const server = createServer({ exec: harness.exec, skipAgentLifecycle: true });

    const result = await (server as any)._registeredTools.new_split.handler(
      {
        direction: "right",
        workspace: "workspace:1",
        cli: "claude",
        boot_prompt_path: writeBootPrompt(),
        boot_prompt_timeout_ms: 2_000,
      },
      {} as any,
    );
    const parsed = parseToolResult(result);

    expect(parsed.boot_prompt_receipt).toMatchObject({
      typed: true,
      submit_attempted: true,
      submit_dispatched: true,
      submit_verified: true,
      delivered: true,
      delivery_state: "submitted",
    });
    expect(harness.returnPresses()).toBe(1);
  }, 20_000);

  it("takes another Claude composer read after one slow stale CLI frame exceeds the observe deadline", async () => {
    const { createServer } = await loadServerModule();
    const harness = makeCodexBootExec({
      cli: "claude",
      payloadAppears: true,
      payloadAppearsAfterPostPasteReads: 2,
      firstPostPasteReadDelayMs: 800,
      submitAfterReturn: 1,
    });
    const server = createServer({ exec: harness.exec, skipAgentLifecycle: true });

    const result = await (server as any)._registeredTools.new_split.handler(
      {
        direction: "right",
        workspace: "workspace:1",
        cli: "claude",
        boot_prompt_path: writeBootPrompt(),
        boot_prompt_timeout_ms: 2_000,
      },
      {} as any,
    );
    const parsed = parseToolResult(result);

    expect(parsed.boot_prompt_receipt).toMatchObject({
      typed: true,
      submit_dispatched: true,
      submit_verified: true,
      delivery_state: "submitted",
    });
    expect(harness.returnPresses()).toBe(1);
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

  it("fails honestly when one recovery Return still leaves the observed boot payload pending", async () => {
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

    expect(parsed.ok).toBe(false);
    expect(parsed.delivered_chars).toBeGreaterThan(0);
    expect(parsed.error).toMatch(
      /boot prompt delivery failed.*submit could not be verified/i,
    );
    expect(harness.returnPresses()).toBe(2);
  }, 20_000);
});
