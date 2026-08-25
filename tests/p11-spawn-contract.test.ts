/**
 * P11 / U10 — the PRODUCER half of the coordination contract.
 *
 * The consumer half (assessHarvestability) shipped long ago, but nothing ever
 * issued it a contract: spawn_agent never set goal_file, so every spawned
 * worker read `terminal_contract_missing` forever, and leads invented report
 * paths in prose that a regex heuristic then tried to guess back out. These
 * tests pin the fix: the engine authors the contract ONCE, returns it in the
 * receipt, persists it, and tells the worker the same two strings.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../src/server.js";
import type { ExecFn } from "../src/cmux-client.js";
import { withTestSurfaceObserver } from "./helpers/test-surface-observer.js";
import { runWithCallerContext } from "../src/caller-context.js";
import {
  BOOT_INJECTION_CHUNK_THRESHOLD,
  bootContractPointer,
  coordinationContractPath,
  coordinationFooter,
  coordinationFooterBytes,
  issueCoordinationContract,
} from "../src/coordination-paths.js";
import { recommendedMonitorCommand } from "../src/inbox.js";
import { readWatchRegistry } from "../src/watch-spec.js";
import type { AgentRecord } from "../src/agent-types.js";

const STATE_DIR = join(tmpdir(), "cmux-agents-test-p11-spawn");

interface TestSurface {
  id?: string;
  ref: string;
  title: string;
  text: string;
}

function makeExec(
  screenText = "What can I help you with?\n>",
  surfaceTitle = "agent-pane",
  mutableScreen?: { text: string },
  additionalSurfaces: TestSurface[] = [],
  primarySurfaceUuid?: string,
): ExecFn {
  let promptPending = false;
  let promptSurface = "surface:new";
  let pastePending = false;
  let currentScreenText = screenText;
  const surfaces: TestSurface[] = [
    {
      id: primarySurfaceUuid,
      ref: "surface:new",
      title: surfaceTitle,
      text: screenText,
    },
    ...additionalSurfaces,
  ];
  const setScreenText = (text: string, surfaceRef = "surface:new") => {
    const surface = surfaces.find(({ ref }) => ref === surfaceRef);
    if (surface) surface.text = text;
    if (surfaceRef === "surface:new") {
      currentScreenText = text;
      if (mutableScreen) mutableScreen.text = text;
    }
  };
  return vi.fn().mockImplementation(async (_cmd, args) => {
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
              surface_count: surfaces.length,
              surface_refs: surfaces.map(({ ref }) => ref),
              ...(surfaces.every(({ id }) => id)
                ? { surface_ids: surfaces.map(({ id }) => id!) }
                : {}),
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
          surfaces: surfaces.map((surface, index) =>
            ({
              id: surface.id,
              ref: surface.ref,
              title: surface.title,
              type: "terminal",
              index,
              selected: index === 0,
            }),
          ),
        }),
        stderr: "",
      };
    }
    if (args.includes("read-screen")) {
      const surface =
        surfaces.find(({ ref }) => args.includes(ref)) ?? surfaces[0]!;
      return {
        stdout: JSON.stringify({
          surface: surface.ref,
          text:
            surface.ref === "surface:new"
              ? (mutableScreen?.text ?? currentScreenText)
              : surface.text,
          lines: 20,
          scrollback_used: false,
        }),
        stderr: "",
      };
    }
    if (args.includes("send-key") && args.includes("return")) {
      if (promptPending) {
        setScreenText("Claude Code\n✻ Working\n", promptSurface);
        promptPending = false;
      }
      return { stdout: "{}", stderr: "" };
    }
    if (args.includes("set-buffer")) {
      pastePending = String(args.at(-1) ?? "").trim().length > 0;
      return { stdout: "{}", stderr: "" };
    }
    if (args.includes("paste-buffer")) {
      if (pastePending) promptPending = true;
      pastePending = false;
      return { stdout: "{}", stderr: "" };
    }
    if (args.includes("send")) {
      const text = String(args.at(-1) ?? "");
      if (
        text.trim() &&
        (text.includes("cmuxlayer contract for") ||
          !/[A-Za-z0-9_.-]+(?:Claude|Codex|Cursor|Gemini|Kiro)\b/.test(text))
      ) {
        promptPending = true;
        promptSurface =
          surfaces.find(({ ref }) => args.includes(ref))?.ref ?? "surface:new";
        setScreenText(`Claude Code\n❯ ${text}`, promptSurface);
      }
    }
    return {
      stdout: JSON.stringify({
        workspace: "workspace:1",
        surface: "surface:new",
        ...(primarySurfaceUuid ? { surface_id: primarySurfaceUuid } : {}),
        pane: "pane:1",
        title: "",
        type: "terminal",
      }),
      stderr: "",
    };
  });
}

/** Everything typed or pasted at the pane, however it was routed. */
function sentText(exec: ExecFn): string {
  return (exec as unknown as ReturnType<typeof vi.fn>).mock.calls
    .map(([, args]: [string, string[]]) => (args ?? []).join(" "))
    .join("\n");
}

function parentRecord(
  surfaceUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
): AgentRecord {
  return {
    agent_id: "lead-parent",
    surface_id: "surface:new",
    surface_uuid: surfaceUuid,
    workspace_id: "workspace:1",
    state: "ready",
    repo: "cmuxlayer",
    model: "claude-sonnet-4-5",
    cli: "claude",
    cli_session_id: null,
    cli_session_path: null,
    task_summary: "parent fixture",
    pid: null,
    version: 1,
    created_at: "2026-08-23T00:00:00.000Z",
    updated_at: "2026-08-23T00:00:00.000Z",
    error: null,
    parent_agent_id: null,
    spawn_depth: 0,
    role: "orchestrator",
    auto_archive_on_done: false,
    deletion_intent: false,
    quality: "unknown",
    max_cost_per_agent: null,
    crash_recover: true,
    respawn_attempts: 0,
    user_killed: false,
    boot_prompt_pending: false,
    launch_cwd: null,
    mcp_profile: null,
    worktree_path: null,
    worktree_branch: null,
  };
}

describe("P11 spawn_agent issues the coordination contract", () => {
  let inboxDir: string;
  let exec: ExecFn;
  let server: any;
  let watchRegistryPath: string;

  beforeEach(() => {
    rmSync(STATE_DIR, { recursive: true, force: true });
    mkdirSync(STATE_DIR, { recursive: true });
    inboxDir = mkdtempSync(join(tmpdir(), "p11-inbox-"));
    watchRegistryPath = join(inboxDir, "watch-specs.json");
    exec = makeExec();
    server = createServer(
      withTestSurfaceObserver({
        exec,
        stateDir: STATE_DIR,
        disableSpawnPreflight: true,
        inboxBaseDir: inboxDir,
        watchRegistryPath,
      }),
    );
  });

  afterEach(() => {
    rmSync(STATE_DIR, { recursive: true, force: true });
    rmSync(inboxDir, { recursive: true, force: true });
  });

  async function spawn(extra: Record<string, unknown> = {}) {
    const tool = server._registeredTools["spawn_agent"];
    const result = await runWithCallerContext({ workspaceId: "workspace:1" }, () =>
      tool.handler(
        {
          repo: "brainlayer",
          model: "sonnet",
          cli: "claude",
          role: "worker",
          prompt: "task",
          ...extra,
        },
        {} as any,
      ),
    );
    return result.structuredContent ?? JSON.parse(result.content[0].text);
  }

  it("returns report_path and done_marker in the LEAN receipt", async () => {
    const parsed = await spawn();
    expect(parsed.ok).toBe(true);
    const expected = issueCoordinationContract(parsed.agent_id as string, {
      baseDir: inboxDir,
    });
    expect(parsed.report_path).toBe(expected.report_path);
    expect(parsed.done_marker).toBe(expected.done_marker);
  });

  it("persists the contract on the record, so the consumer reads what was issued", async () => {
    const parsed = await spawn();
    const getState = server._registeredTools["get_agent_state"];
    const state = await getState.handler({ agent_id: parsed.agent_id }, {} as any);
    const detail = state.structuredContent ?? JSON.parse(state.content[0].text);
    expect(detail.report_path).toBe(parsed.report_path);
    expect(detail.done_marker).toBe(parsed.done_marker);
  });

  it("wakes the parent for every report revision even when the terminal marker is unchanged", async () => {
    await server.close();
    const parentUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const childUuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const baseExec = makeExec(
      "Claude Code\nWhat can I help you with?\n❯ ",
      "parent-pane",
      undefined,
      [
        {
          id: childUuid,
          ref: "surface:child",
          title: "child-pane",
          text: "Claude Code\nWhat can I help you with?\n❯ ",
        },
      ],
      parentUuid,
    );
    exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
      if (args.includes("new-split")) {
        return {
          stdout: JSON.stringify({
            workspace: "workspace:1",
            surface: "surface:child",
            surface_id: childUuid,
            pane: "pane:1",
            title: "",
            type: "terminal",
          }),
          stderr: "",
        };
      }
      return baseExec(cmd, args);
    });
    server = createServer(
      withTestSurfaceObserver({
        exec,
        stateDir: STATE_DIR,
        disableSpawnPreflight: true,
        inboxBaseDir: inboxDir,
        watchRegistryPath,
      }),
    );
    let engine = server._registeredTools.interact._engine;
    const parent = parentRecord(parentUuid);
    engine.stateMgr.writeState(parent);
    engine.getRegistry().set(parent.agent_id, parent);
    const child = await spawn({ parent_agent_id: parent.agent_id });

    expect(child.ok, JSON.stringify(child)).toBe(true);
    expect(child.parent_agent_id).toBe(parent.agent_id);
    expect(existsSync(child.report_path)).toBe(true);
    expect(readWatchRegistry({ registryPath: watchRegistryPath }).watches).toEqual([
      expect.objectContaining({
        owner: parent.agent_id,
        target: child.report_path,
        change: "content",
        state: "armed",
      }),
    ]);

    await server.close();
    server = createServer(
      withTestSurfaceObserver({
        exec,
        stateDir: STATE_DIR,
        disableSpawnPreflight: true,
        inboxBaseDir: inboxDir,
        watchRegistryPath,
      }),
    );
    await server._registeredTools.list_agents.handler({}, {} as any);
    engine = server._registeredTools.interact._engine;
    const before = (exec as ReturnType<typeof vi.fn>).mock.calls.length;
    writeFileSync(
      child.report_path,
      `STATUS: DONE\nfirst stop\n${child.done_marker}\n`,
      "utf8",
    );
    await engine.sweepWatchesBestEffort();
    const afterCalls = (exec as ReturnType<typeof vi.fn>).mock.calls.slice(before);
    expect(
      afterCalls.some(([, args]: [string, string[]]) =>
        args.some(
          (arg) =>
            arg.includes("[report]") && arg.includes(child.report_path),
        ),
      ),
    ).toBe(true);

    const afterFirstWake = (exec as ReturnType<typeof vi.fn>).mock.calls.length;
    writeFileSync(
      child.report_path,
      `STATUS: DONE\nfirst stop\n${child.done_marker}\n`,
      "utf8",
    );
    await engine.sweepWatchesBestEffort();
    const secondWakeCalls = (exec as ReturnType<typeof vi.fn>).mock.calls.slice(
      afterFirstWake,
    );
    expect(
      secondWakeCalls.some(([, args]: [string, string[]]) =>
        args.some(
          (arg) => arg.includes("[report]") && arg.includes(child.report_path),
        ),
      ),
    ).toBe(true);

    expect(readWatchRegistry({ registryPath: watchRegistryPath }).watches).toEqual([
      expect.objectContaining({
        owner: parent.agent_id,
        target: child.report_path,
        change: "content",
        state: "armed",
        notification_pending: false,
      }),
    ]);
  });

  it("does not describe a missing report target as a done marker and preserves the reason-aware notifier", async () => {
    await server.close();
    const externalNotify = vi.fn().mockResolvedValue(true);
    const parentUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    exec = makeExec(
      "Claude Code\nWhat can I help you with?\n❯ ",
      "parent-pane",
      undefined,
      [],
      parentUuid,
    );
    server = createServer(
      withTestSurfaceObserver({
        exec,
        stateDir: STATE_DIR,
        disableSpawnPreflight: true,
        inboxBaseDir: inboxDir,
        watchRegistryPath,
        watchNotify: externalNotify,
      }),
    );
    const engine = server._registeredTools.interact._engine;
    const parent = parentRecord(parentUuid);
    engine.stateMgr.writeState(parent);
    engine.getRegistry().set(parent.agent_id, parent);
    const reportPath = join(inboxDir, "reaped-child", "report.md");
    mkdirSync(join(inboxDir, "reaped-child"), { recursive: true });
    writeFileSync(reportPath, "", "utf8");
    await engine.armWatch({
      owner: parent.agent_id,
      target: reportPath,
      marker: "DONE_REAPED_CHILD",
      deadline: Number.MAX_SAFE_INTEGER,
    });

    rmSync(reportPath);
    await engine.sweepWatchesBestEffort();

    expect(sentText(exec)).not.toContain("done marker observed");
    expect(sentText(exec)).toContain("target missing");
    expect(externalNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: parent.agent_id,
        target: reportPath,
        target_kind: "file",
        reason: "target_missing",
      }),
    );
  });

  it("keeps an already-created child spawn successful when its report watch cannot be armed", async () => {
    await server.close();
    const parentUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const childUuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const baseExec = makeExec(
      "Claude Code\nWhat can I help you with?\n❯ ",
      "parent-pane",
      undefined,
      [
        {
          id: childUuid,
          ref: "surface:child",
          title: "child-pane",
          text: "Claude Code\nWhat can I help you with?\n❯ ",
        },
      ],
      parentUuid,
    );
    exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
      if (args.includes("new-split")) {
        return {
          stdout: JSON.stringify({
            workspace: "workspace:1",
            surface: "surface:child",
            surface_id: childUuid,
            pane: "pane:1",
            title: "",
            type: "terminal",
          }),
          stderr: "",
        };
      }
      return baseExec(cmd, args);
    });
    server = createServer(
      withTestSurfaceObserver({
        exec,
        stateDir: STATE_DIR,
        disableSpawnPreflight: true,
        inboxBaseDir: inboxDir,
        watchRegistryPath,
      }),
    );
    const engine = server._registeredTools.interact._engine;
    const parent = parentRecord(parentUuid);
    engine.stateMgr.writeState(parent);
    engine.getRegistry().set(parent.agent_id, parent);
    const blockingFile = join(inboxDir, "not-a-directory");
    writeFileSync(blockingFile, "blocks mkdir", "utf8");

    const child = await spawn({
      parent_agent_id: parent.agent_id,
      report_path: join(blockingFile, "report.md"),
    });

    expect(child.ok, JSON.stringify(child)).toBe(true);
    expect(child.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/report watch was not armed/i),
      ]),
    );
    expect(engine.getAgentState(child.agent_id)).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // P11b: the boot prompt carries a POINTER, not the contract.
  // -------------------------------------------------------------------------

  it("P11b: the contract file exists and carries the mailbox contract AND the issued report contract", async () => {
    const parsed = await spawn();
    expect(parsed.contract_path).toBe(
      coordinationContractPath(parsed.agent_id as string, {
        baseDir: inboxDir,
      }),
    );
    const file = readFileSync(parsed.contract_path, "utf8");
    // Mailbox half -- the ~479 chars that used to ride the wire.
    expect(file).toContain(recommendedMonitorCommand(parsed.agent_id, {
      baseDir: inboxDir,
    }));
    expect(file).toContain("CMUX_INBOX_MSG_ID=<handled-message-id>");
    expect(file).toContain(`cmuxlayer inbox-cursor '${parsed.agent_id}'`);
    // Report half -- the #454-issued contract that never fit inline. Byte-equal
    // to the receipt, which is the whole P11 invariant.
    expect(file).toContain(parsed.report_path);
    expect(file).toContain(parsed.done_marker);
  });

  it("P11b: the boot prompt is a one-line pointer, and it points at the file", async () => {
    const parsed = await spawn();
    const injection = bootContractPointer(
      parsed.agent_id as string,
      parsed.contract_path as string,
    );
    expect(injection).not.toMatch(/[\r\n]/);
    expect(sentText(exec)).toContain(injection);
    // The instructions themselves are NOT on the wire any more.
    expect(sentText(exec)).not.toContain("monitor with tail -n0 -F");
  });

  it("P11b: the composed boot prompt stays under SEND_INPUT_CHUNK_THRESHOLD for a real-length agent id", async () => {
    // This is the regression that took the suite 10 red at 618 chars. Asserted
    // on the delivered text, not on the injection alone: what crosses the
    // threshold is caller prompt + injection joined, and that is what splits.
    await spawn();
    const deliveries = (exec as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map(([, args]: [string, string[]]) => String((args ?? []).at(-1) ?? ""))
      .filter((text) => text.includes("cmuxlayer contract for"));
    expect(deliveries.length).toBeGreaterThan(0);
    for (const text of deliveries) {
      expect(text.length).toBeLessThan(BOOT_INJECTION_CHUNK_THRESHOLD);
    }

    // And on the pure function, for an agent id at the long end of the real
    // range -- the spawned id is short, so it alone would not catch a widening.
    const longId = "cmuxlayerClaude-d2fc302f";
    const longPointer = bootContractPointer(
      longId,
      coordinationContractPath(longId, {
        baseDir: "/Users/someone-with-a-long-name/.cmux/agents",
      }),
    );
    expect(longPointer.length).toBeLessThan(BOOT_INJECTION_CHUNK_THRESHOLD);
  });

  it("P11b: boot delivery is not SPLIT -- the whole composed prompt lands in one write", async () => {
    // Splitting is the hazard, not pasting: the composed boot prompt (caller
    // text + injection, newline-joined) has always gone through the composer
    // paste, but at 618 chars it CHUNKED, and multi-chunk boot delivery is the
    // most incident-prone route in this repo (#434/#438). So assert one write
    // carrying BOTH halves -- two writes would mean the split came back.
    await spawn();
    const writes = (exec as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter(([, args]: [string, string[]]) =>
        (args ?? []).some((arg) => String(arg).includes("cmuxlayer contract for")),
      )
      .map(([, args]: [string, string[]]) => String((args ?? []).at(-1) ?? ""));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("task");
    expect(writes[0]!.length).toBeLessThan(BOOT_INJECTION_CHUNK_THRESHOLD);
  });

  it("P11b R4: an unwritable contract file falls back to inline WITHOUT emitting a dangling pointer", async () => {
    // The adversarial case: if the write fails, the boot prompt must not point
    // at a file that does not exist. The inline-mode test reaches the same
    // OUTCOME by a different route, so this branch needs its own pin -- a
    // regression that emitted the pointer before the write, or let the throw
    // escape and fail the spawn, would otherwise stay green.
    const blockedBase = join(tmpdir(), `p11b-blocked-${process.pid}-inbox`);
    rmSync(blockedBase, { recursive: true, force: true });
    // A FILE where the base dir should be: every channel-dir mkdir under it
    // fails, so the contract write cannot succeed.
    writeFileSync(blockedBase, "not a directory");
    const blockedExec = makeExec();
    const blockedStateDir = mkdtempSync(join(tmpdir(), "p11b-blocked-state-"));
    const blockedServer: any = createServer(
      withTestSurfaceObserver({
        exec: blockedExec,
        stateDir: blockedStateDir,
        disableSpawnPreflight: true,
        inboxBaseDir: blockedBase,
      }),
    );
    try {
      const parsed = await runWithCallerContext(
        { workspaceId: "workspace:1" },
        async () => {
          const result = await blockedServer._registeredTools[
            "spawn_agent"
          ].handler(
            {
              repo: "brainlayer",
              model: "sonnet",
              cli: "claude",
              role: "worker",
              prompt: "task",
            },
            {} as any,
          );
          return result.structuredContent ?? JSON.parse(result.content[0].text);
        },
      );

      // The spawn still succeeds -- a contract-file failure is not a spawn
      // failure.
      expect(parsed.ok).toBe(true);
      expect(parsed.contract_path).toBeUndefined();
      // No dangling pointer on the wire, and the mailbox contract still got
      // through: the worker loses the report half, not its inbox.
      const wire = sentText(blockedExec);
      expect(wire).not.toContain("Read and follow");
      expect(wire).toContain("cmuxlayer mailbox contract for");
      // And the receipt says the lead must relay.
      expect(parsed.coordination_footer_delivered).toBe(false);
      expect(parsed.coordination_footer_note).toMatch(/not_wired/);
      expect(parsed.coordination_footer_note).toMatch(/LEAD must relay/i);
    } finally {
      rmSync(blockedBase, { recursive: true, force: true });
      rmSync(blockedStateDir, { recursive: true, force: true });
    }
  });

  it("P11b: CMUXLAYER_BOOT_CONTRACT=inline restores the pre-P11b inline contract", async () => {
    process.env.CMUXLAYER_BOOT_CONTRACT = "inline";
    try {
      const parsed = await spawn();
      expect(sentText(exec)).toContain("cmuxlayer mailbox contract for");
      expect(parsed.contract_path).toBeUndefined();
      // Provenance follows the mode: inline cannot carry the report contract,
      // so the receipt must say so rather than claiming delivery.
      expect(parsed.coordination_footer_delivered).toBe(false);
      expect(parsed.coordination_footer_note).toMatch(/not_wired/);
      expect(sentText(exec)).not.toContain(parsed.report_path);
    } finally {
      delete process.env.CMUXLAYER_BOOT_CONTRACT;
    }
  });

  it("declares the footer's own byte cost (Constraint 1, #424/#425)", async () => {
    const parsed = await spawn();
    expect(parsed.coordination_footer_bytes).toBe(
      coordinationFooterBytes({
        report_path: parsed.report_path,
        done_marker: parsed.done_marker,
      }),
    );
    // One line, so the injected boot prompt stays single-line and typed.
    expect(
      coordinationFooter({
        report_path: parsed.report_path,
        done_marker: parsed.done_marker,
      }),
    ).not.toMatch(/[\r\n]/);
    expect(parsed.coordination_footer_bytes).toBeLessThan(240);
  });

  it("REGISTRY-OPTIONAL PARITY (#453): the contract does not depend on the launcher", async () => {
    // The contract is derived from agent_id and applied ABOVE launchMode, so a
    // raw-CLI spawn cannot get a different (or missing) contract. Asserted on
    // real receipts from two independent servers, not on the derivation fn.
    const registered = await spawn();

    const rawInboxDir = mkdtempSync(join(tmpdir(), "p11-inbox-raw-"));
    const rawStateDir = mkdtempSync(join(tmpdir(), "p11-state-raw-"));
    const previousRegistry = process.env.CMUXLAYER_LAUNCHER_REGISTRY_PATH;
    process.env.CMUXLAYER_LAUNCHER_REGISTRY_PATH = join(
      rawInboxDir,
      "no-such-launcher-registry.zsh",
    );
    try {
      const rawExec = makeExec();
      const rawServer: any = createServer(
        withTestSurfaceObserver({
          exec: rawExec,
          stateDir: rawStateDir,
          disableSpawnPreflight: true,
          inboxBaseDir: rawInboxDir,
        }),
      );
      const rawResult = await runWithCallerContext(
        { workspaceId: "workspace:1" },
        () =>
          rawServer._registeredTools["spawn_agent"].handler(
            {
              repo: "brainlayer",
              cli: "claude",
              role: "worker",
              prompt: "task",
            },
            {} as any,
          ),
      );
      const raw =
        rawResult.structuredContent ?? JSON.parse(rawResult.content[0].text);

      expect(raw.ok).toBe(true);
      expect(raw.report_path).toBe(
        issueCoordinationContract(raw.agent_id as string, {
          baseDir: rawInboxDir,
        }).report_path,
      );
      expect(raw.done_marker).toBeTruthy();
      // Assert both are actually defined -- the earlier ternary compared `raw`
      // to itself when `registered` was undefined, which proved nothing.
      expect(typeof registered.coordination_footer_bytes).toBe("number");
      expect(raw.coordination_footer_bytes).toBe(
        coordinationFooterBytes({
          report_path: raw.report_path,
          done_marker: raw.done_marker,
        }),
      );
      // P11b: provenance travels on both doors, and both now actually DELIVER
      // the contract -- the pointer file is written above launchMode, so a
      // raw-CLI spawn cannot end up as the one door that tells its worker
      // nothing.
      for (const receipt of [registered, raw]) {
        expect(receipt.coordination_footer_delivered).toBe(true);
        expect(receipt.contract_path).toMatch(/^\/.+\/contract\.md$/);
      }
      // Same contract SHAPE on both doors: issued, absolute, marker present.
      for (const receipt of [registered, raw]) {
        expect(receipt.report_path).toMatch(/^\/.+\/report\.md$/);
        expect(receipt.done_marker).toMatch(/^DONE_[A-Z0-9_:-]+$/);
      }
    } finally {
      if (previousRegistry === undefined) {
        delete process.env.CMUXLAYER_LAUNCHER_REGISTRY_PATH;
      } else {
        process.env.CMUXLAYER_LAUNCHER_REGISTRY_PATH = previousRegistry;
      }
      rmSync(rawInboxDir, { recursive: true, force: true });
      rmSync(rawStateDir, { recursive: true, force: true });
    }
  });

  it("FINDING 3: never reports contract bytes without reporting how they were sent", async () => {
    const parsed = await spawn();
    // The v0.4.41 `paused` hazard: an authoritative number with no provenance.
    // P11b keeps the rule and flips the answer -- the note must now say the
    // contract went via the file, and must not oversell it.
    expect(parsed.coordination_footer_bytes).toBeGreaterThan(0);
    expect(parsed.coordination_footer_delivered).toBe(true);
    expect(parsed.coordination_footer_note).toMatch(
      /delivered_via_contract_file/,
    );
    expect(parsed.coordination_footer_note).not.toMatch(/not_wired/);
    // The honest cost is stated in the receipt, not just the PR body -- and
    // stated at the strength the build actually provides: nothing detects an
    // unread contract file today, so the note must not claim it does.
    expect(parsed.coordination_footer_note).toMatch(/ignores the pointer/i);
    expect(parsed.coordination_footer_note).toMatch(/observable in principle/i);
    // R3: the byte count describes the UNSENT inline rendering, and must say so
    // rather than reading as a measure of what went on the wire.
    expect(parsed.coordination_footer_note).toMatch(/NOT what was sent/i);
  });

  it("FINDING 2: a relative report_path is rejected BEFORE anything launches", async () => {
    const tool = server._registeredTools["spawn_agent"];
    const before = (exec as unknown as ReturnType<typeof vi.fn>).mock.calls
      .length;
    let rejected = false;
    let message = "";
    try {
      const result = await runWithCallerContext(
        { workspaceId: "workspace:1" },
        () =>
          tool.handler(
            {
              repo: "brainlayer",
              cli: "claude",
              role: "worker",
              prompt: "task",
              report_path: "reports/worker.md",
            },
            {} as any,
          ),
      );
      const parsed =
        result.structuredContent ?? JSON.parse(result.content[0].text);
      rejected = parsed.ok === false;
      message = String(parsed.error ?? "");
    } catch (error) {
      rejected = true;
      message = error instanceof Error ? error.message : String(error);
    }
    expect(rejected).toBe(true);
    expect(message).toMatch(/absolute/i);
    // The real defect: no pane, no worktree, no launch on a validation error.
    expect(
      (exec as unknown as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(before);
  });

  it("echoes and persists an explicit absolute report_path override", async () => {
    const override = join(inboxDir, "collab", "worker-report.md");
    const parsed = await spawn({ report_path: override });
    expect(parsed.report_path).toBe(override);
    const getState = server._registeredTools["get_agent_state"];
    const state = await getState.handler({ agent_id: parsed.agent_id }, {} as any);
    const detail = state.structuredContent ?? JSON.parse(state.content[0].text);
    expect(detail.report_path).toBe(override);
  });
});
