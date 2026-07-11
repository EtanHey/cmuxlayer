import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../src/server.js";
import type { ExecFn } from "../src/cmux-client.js";
import { inboxPath, monitorAlive, readInbox } from "../src/inbox.js";

const STATE_DIR = join(tmpdir(), "cmuxlayer-spawn-monitor-boot-state");

function makeExec(): ExecFn {
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
    if (args.includes("read-screen")) {
      return {
        stdout: JSON.stringify({
          surface: "surface:new",
          text: "Claude Code\n>",
          lines: 20,
          scrollback_used: false,
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

function parseToolResult(result: any): Record<string, any> {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

function sendCalls(exec: ExecFn): string[][] {
  return (exec as ReturnType<typeof vi.fn>).mock.calls
    .filter(([, args]: [string, string[]]) => args.includes("send"))
    .map(([, args]: [string, string[]]) => args);
}

describe("spawn monitor boot", () => {
  let inboxDir: string;
  let exec: ExecFn;
  let server: any;

  beforeEach(() => {
    rmSync(STATE_DIR, { recursive: true, force: true });
    mkdirSync(STATE_DIR, { recursive: true });
    inboxDir = mkdtempSync(join(tmpdir(), "cmux-monitor-boot-"));
    exec = makeExec();
    server = createServer({
      exec,
      stateDir: STATE_DIR,
      disableSpawnPreflight: true,
      inboxBaseDir: inboxDir,
    });
  });

  afterEach(() => {
    rmSync(STATE_DIR, { recursive: true, force: true });
    rmSync(inboxDir, { recursive: true, force: true });
  });

  it("returns monitor boot metadata without marking the monitor alive", async () => {
    const spawn = server._registeredTools["spawn_agent"];

    const result = await spawn.handler(
      {
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        role: "orchestrator",
        verbose: true,
      },
      {} as any,
    );

    const parsed = parseToolResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.monitor_boot).toEqual({
      status: "bootstrapped",
      heartbeat_written: true,
      heartbeat_source: "server_boot",
      monitor_command: expect.stringContaining(parsed.agent_id),
    });
    expect(parsed.monitor_boot.monitor_command).toContain("tail -n0 -F");
    expect(existsSync(inboxPath(parsed.agent_id, { baseDir: inboxDir }))).toBe(
      true,
    );
    expect(monitorAlive(parsed.agent_id, 1_000, { baseDir: inboxDir })).toBe(
      false,
    );
  });

  it("does not monitor-boot worker spawns", async () => {
    const spawn = server._registeredTools["spawn_agent"];

    const result = await spawn.handler(
      {
        repo: "cmuxlayer",
        model: "gpt-5.4",
        cli: "codex",
        role: "worker",
      },
      {} as any,
    );

    const parsed = parseToolResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.monitor_boot).toBeUndefined();
    expect(monitorAlive(parsed.agent_id, 1_000, { baseDir: inboxDir })).toBe(
      false,
    );
  });

  it("does not fail orchestrator spawn when monitor boot cannot write", async () => {
    const blockedInboxBase = join(
      tmpdir(),
      `cmux-monitor-boot-blocked-${process.pid}-${Date.now()}`,
    );
    writeFileSync(blockedInboxBase, "not a directory");
    const blockedExec = makeExec();
    const blockedServer = createServer({
      exec: blockedExec,
      stateDir: STATE_DIR,
      disableSpawnPreflight: true,
      inboxBaseDir: blockedInboxBase,
    });

    try {
      const spawn = blockedServer._registeredTools["spawn_agent"];
      const result = await spawn.handler(
        {
          repo: "brainlayer",
          model: "sonnet",
          cli: "claude",
          role: "orchestrator",
          verbose: true,
        },
        {} as any,
      );

      const parsed = parseToolResult(result);
      expect(parsed.ok).toBe(true);
      expect(parsed.monitor_boot).toEqual({
        status: "monitor-not-ready",
        heartbeat_written: false,
        heartbeat_source: "server_boot",
        monitor_command: expect.stringContaining(parsed.agent_id),
        error: expect.stringContaining("ENOTDIR"),
      });
    } finally {
      rmSync(blockedInboxBase, { force: true });
    }
  });

  it("nudges the first orchestrator dispatch until the agent heartbeats", async () => {
    const spawn = server._registeredTools["spawn_agent"];
    const dispatch = server._registeredTools["dispatch_to_agent"];

    const spawnResult = await spawn.handler(
      {
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        role: "orchestrator",
      },
      {} as any,
    );
    const agentId = parseToolResult(spawnResult).agent_id as string;
    const beforeDispatchSendCount = sendCalls(exec).length;

    const result = await dispatch.handler(
      {
        agent_id: agentId,
        task: "GO",
        from: "orc",
        tag: "dispatch",
        persist: false,
      },
      {} as any,
    );

    const parsed = parseToolResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.monitor_alive).toBe(false);
    expect(parsed.health.issue_codes).toContain("inbox_monitor_not_alive");
    expect(parsed.nudge.attempted).toBe(true);
    expect(parsed.nudge.sent).toBe(true);
    expect(sendCalls(exec)).toHaveLength(beforeDispatchSendCount + 1);
    expect(readInbox(agentId, { baseDir: inboxDir }).map((m) => m.task)).toEqual(
      ["GO"],
    );
  });
});
