import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createServer as createProductionServer,
  createServerContext as createProductionServerContext,
  type CreateServerOptions,
} from "../src/server.js";
import type { ExecFn } from "../src/cmux-client.js";
import { StateManager } from "../src/state-manager.js";
import type { AgentRecord } from "../src/agent-types.js";
import type { SeatRegistry } from "../src/seat-identity.js";
import { SURFACE_EVICTION_CONFIRMATION_MS } from "../src/agent-registry.js";

const TEST_DIR = join(tmpdir(), "cmux-agents-test-resync-tool");
const TEST_OBSERVER_OWNER = "cmux:/tmp/cmuxlayer-resync-test.sock";

function withTestObserver<T extends Omit<CreateServerOptions, "context">>(
  opts: T,
): T & Omit<CreateServerOptions, "context"> {
  return {
    ...opts,
    sessionIdentityResolver: opts.sessionIdentityResolver ?? (() => null),
    surfaceObserverOwnerIdProvider:
      opts.surfaceObserverOwnerIdProvider ?? (() => TEST_OBSERVER_OWNER),
    surfaceObserverEpochProvider:
      opts.surfaceObserverEpochProvider ??
      (() => `${TEST_OBSERVER_OWNER}@test`),
  };
}

function createServerContext(
  opts: Omit<CreateServerOptions, "context"> = {},
) {
  return createProductionServerContext(withTestObserver(opts));
}

function createServer(opts: CreateServerOptions = {}) {
  return createProductionServer(
    opts.context ? opts : withTestObserver(opts),
  );
}

function parseResult(result: any): any {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

function makeAgentRecord(overrides: Partial<AgentRecord>): AgentRecord {
  return {
    agent_id: "agent",
    surface_id: "surface:agent",
    surface_observer_id: TEST_OBSERVER_OWNER,
    workspace_id: "workspace:1",
    state: "working",
    repo: "brainlayer",
    model: "sonnet",
    cli: "claude",
    cli_session_id: null,
    task_summary: "test agent",
    pid: null,
    version: 1,
    created_at: "2026-04-19T20:00:00.000Z",
    updated_at: "2026-04-19T20:00:00.000Z",
    error: null,
    parent_agent_id: null,
    spawn_depth: 0,
    deletion_intent: false,
    quality: "unknown",
    max_cost_per_agent: null,
    crash_recover: false,
    respawn_attempts: 0,
    user_killed: false,
    ...overrides,
  };
}

function writeProgrammaticLeftWorker(
  overrides: Partial<AgentRecord> = {},
): void {
  new StateManager(TEST_DIR).writeState(
    makeAgentRecord({
      agent_id: "programmatic-left-worker",
      surface_id: "surface:worker-left",
      surface_uuid: "11111111-2222-4333-8444-555555555555",
      workspace_id: "workspace:1",
      state: "working",
      role: "worker",
      cli: "codex",
      surface_provenance: "cmuxlayer_spawn",
      ...overrides,
    }),
  );
}

function markProgrammaticLeftWorkerIdle(
  agentId = "programmatic-left-worker",
): void {
  new StateManager(TEST_DIR).transition(agentId, "idle");
}

function makeDiscoveryExec(): ExecFn {
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
              surface_count: 2,
              surface_refs: ["surface:1", "surface:2"],
              selected_surface_ref: "surface:1",
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
              ref: "surface:1",
              title: "brainlayerClaude",
              type: "terminal",
              index: 0,
              selected: true,
            },
            {
              ref: "surface:2",
              title: "notes",
              type: "terminal",
              index: 1,
              selected: false,
            },
          ],
        }),
        stderr: "",
      };
    }

    if (args.includes("read-screen")) {
      const surface = args[args.indexOf("--surface") + 1];
      if (surface === "surface:1") {
        return {
          stdout: JSON.stringify({
            surface,
            text: `
✻ Working…
  Reading files
🤖 Sonnet 4.6 | 💰 $0.50 | ⏱️  41s
`,
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }

      return {
        stdout: JSON.stringify({
          surface,
          text: "$ ",
          lines: 20,
          scrollback_used: false,
        }),
        stderr: "",
      };
    }

    return {
      stdout: JSON.stringify({}),
      stderr: "",
    };
  });
}

function makeMovedManagedSurfaceExec(): ExecFn {
  return vi.fn().mockImplementation(async (_cmd, args) => {
    if (args.includes("list-workspaces")) {
      return {
        stdout: JSON.stringify({
          workspaces: [
            {
              ref: "workspace:1",
              title: "Collab",
              index: 0,
              selected: true,
              pinned: false,
            },
            {
              ref: "workspace:5",
              title: "SkillCreator",
              index: 1,
              selected: false,
              pinned: false,
            },
          ],
        }),
        stderr: "",
      };
    }

    if (args.includes("list-panes")) {
      const workspace = args.includes("--workspace")
        ? args[args.indexOf("--workspace") + 1]
        : "workspace:1";
      return {
        stdout: JSON.stringify({
          workspace_ref: workspace,
          window_ref: workspace === "workspace:1" ? "window:1" : "window:5",
          panes:
            workspace === "workspace:1"
              ? [
                  {
                    ref: "pane:6",
                    index: 1,
                    focused: true,
                    surface_count: 1,
                    surface_refs: ["surface:315"],
                    selected_surface_ref: "surface:315",
                  },
                ]
              : [],
        }),
        stderr: "",
      };
    }

    if (args.includes("list-pane-surfaces")) {
      const workspace = args.includes("--workspace")
        ? args[args.indexOf("--workspace") + 1]
        : "workspace:1";
      return {
        stdout: JSON.stringify({
          workspace_ref: workspace,
          window_ref: workspace === "workspace:1" ? "window:1" : "window:5",
          pane_ref: workspace === "workspace:1" ? "pane:6" : null,
          surfaces:
            workspace === "workspace:1"
              ? [
                  {
                    ref: "surface:315",
                    title: "skillcreatorCodex",
                    type: "terminal",
                    index: 0,
                    selected: true,
                  },
                ]
              : [],
        }),
        stderr: "",
      };
    }

    if (args.includes("read-screen")) {
      return {
        stdout: JSON.stringify({
          surface: "surface:315",
          text: "gpt-5.5 · 82% left · ~/Gits/skillcreator\nWorking (1m 03s • esc to interrupt)",
          lines: 20,
          scrollback_used: false,
        }),
        stderr: "",
      };
    }

    return {
      stdout: JSON.stringify({}),
      stderr: "",
    };
  });
}

function makeIdleDiscoveryExec(): ExecFn {
  const base = makeDiscoveryExec();
  return vi.fn().mockImplementation(async (cmd, args) => {
    if (args.includes("read-screen")) {
      const surface = args[args.indexOf("--surface") + 1];
      if (surface === "surface:1") {
        return {
          stdout: JSON.stringify({
            surface,
            text: `
✻ Working…
  Reading src/server.ts

No idle agents to reassign right now. Everything is either done or Codex is handling the last task.

Token usage: total=356,835
🤖 Sonnet 4.6
CLAUDE_COUNTER: 92
`,
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
    }

    return base(cmd, args);
  });
}

function makeReadErrorExec(): ExecFn {
  const base = makeDiscoveryExec();
  return vi.fn().mockImplementation(async (cmd, args) => {
    if (args.includes("read-screen")) {
      throw new Error("cmux read failed");
    }
    return base(cmd, args);
  });
}

function makeShellPromptExec(): ExecFn {
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
              surface_refs: ["surface:999"],
              selected_surface_ref: "surface:999",
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
              ref: "surface:999",
              title: "shell",
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
          surface: "surface:999",
          text: "$ ",
          lines: 20,
          scrollback_used: false,
        }),
        stderr: "",
      };
    }

    return {
      stdout: JSON.stringify({}),
      stderr: "",
    };
  });
}

function makeAmbiguousLiveAgentExec(): ExecFn {
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
              surface_refs: ["surface:777"],
              selected_surface_ref: "surface:777",
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
              ref: "surface:777",
              title: "Codex",
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
          surface: "surface:777",
          text: "gpt-5.5 · 82% left · ~/Gits/unknown\nWorking (1m 03s • esc to interrupt)",
          lines: 20,
          scrollback_used: false,
        }),
        stderr: "",
      };
    }

    return {
      stdout: JSON.stringify({}),
      stderr: "",
    };
  });
}

function makeOrphanLeadExec(): ExecFn {
  const base = makeShellPromptExec();
  return vi.fn().mockImplementation(async (cmd, args) => {
    if (args.includes("list-pane-surfaces")) {
      return {
        stdout: JSON.stringify({
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          pane_ref: "pane:1",
          surfaces: [
            {
              ref: "surface:325",
              title: "M1 LEAD VoiceLayer",
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
          surface: "surface:325",
          text: "$ ",
          lines: 20,
          scrollback_used: false,
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
              surface_refs: ["surface:325"],
              selected_surface_ref: "surface:325",
            },
          ],
        }),
        stderr: "",
      };
    }

    return base(cmd, args);
  });
}

function makeMultiWorkspaceExec(): ExecFn {
  return vi.fn().mockImplementation(async (_cmd, args) => {
    if (args.includes("list-workspaces")) {
      return {
        stdout: JSON.stringify({
          workspaces: [
            {
              ref: "workspace:1",
              title: "Active",
              index: 0,
              selected: true,
              pinned: false,
            },
            {
              ref: "workspace:12",
              title: "Other",
              index: 1,
              selected: false,
              pinned: false,
            },
          ],
        }),
        stderr: "",
      };
    }

    if (args.includes("list-panes")) {
      const workspace = args.includes("--workspace")
        ? args[args.indexOf("--workspace") + 1]
        : "workspace:1";
      return {
        stdout: JSON.stringify({
          workspace_ref: workspace,
          window_ref:
            workspace === "workspace:12" ? "window:12" : "window:1",
          panes:
            workspace === "workspace:12"
              ? [
                  {
                    ref: "pane:12",
                    index: 0,
                    focused: false,
                    surface_count: 2,
                    surface_refs: ["surface:286", "surface:287"],
                    selected_surface_ref: "surface:287",
                  },
                ]
              : [
                  {
                    ref: "pane:1",
                    index: 0,
                    focused: true,
                    surface_count: 1,
                    surface_refs: ["surface:1"],
                    selected_surface_ref: "surface:1",
                  },
                ],
        }),
        stderr: "",
      };
    }

    if (args.includes("list-pane-surfaces")) {
      const workspace = args.includes("--workspace")
        ? args[args.indexOf("--workspace") + 1]
        : "workspace:1";
      return {
        stdout: JSON.stringify({
          workspace_ref: workspace,
          window_ref:
            workspace === "workspace:12" ? "window:12" : "window:1",
          pane_ref: workspace === "workspace:12" ? "pane:12" : "pane:1",
          surfaces:
            workspace === "workspace:12"
              ? [
                  {
                    ref: "surface:286",
                    title: "orchestratorCursor",
                    type: "terminal",
                    index: 0,
                    selected: false,
                  },
                  {
                    ref: "surface:287",
                    title: "brainlayerClaude",
                    type: "terminal",
                    index: 1,
                    selected: true,
                  },
                ]
              : [
                  {
                    ref: "surface:1",
                    title: "notes",
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
      const surface = args[args.indexOf("--surface") + 1];
      if (surface === "surface:287") {
        return {
          stdout: JSON.stringify({
            surface,
            text: `
✻ Working…
  Reading files
🤖 Sonnet 4.6 | 💰 $0.50 | ⏱️  41s
`,
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }

      if (surface === "surface:286") {
        return {
          stdout: JSON.stringify({
            surface,
            text: "cursor> ",
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }

      return {
        stdout: JSON.stringify({
          surface,
          text: "$ ",
          lines: 20,
          scrollback_used: false,
        }),
        stderr: "",
      };
    }

    return {
      stdout: JSON.stringify({}),
      stderr: "",
    };
  });
}

function makeEmptySurfaceExec(): ExecFn {
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
          panes: [],
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
          surfaces: [],
        }),
        stderr: "",
      };
    }

    return {
      stdout: JSON.stringify({}),
      stderr: "",
    };
  });
}

const REGISTRY_REPAIR_SEATS: SeatRegistry = {
  coachClaude: {
    repo: "coach",
    launchers: {
      claude: "coachClaude",
    },
    lane: "coach",
    role: "lead",
  },
  golemsCodex: {
    repo: "golems",
    launchers: {
      codex: "golemsCodex",
    },
    lane: "golems",
    role: "worker",
  },
  orcClaude: {
    repo: "orc",
    launchers: {
      claude: "orcClaude",
      codex: "orcCodex",
      cursor: "orcCursor",
      gemini: "orcGemini",
      kiro: "orcKiro",
    },
    lane: "orc",
    role: "orc",
  },
  cmuxlayerLead: {
    repo: "cmuxlayer",
    launchers: {
      claude: "cmuxlayerClaude",
      codex: "cmuxlayerCodex",
      cursor: "cmuxlayerCursor",
      gemini: "cmuxlayerGemini",
      kiro: "cmuxlayerKiro",
    },
    lane: "cmuxlayer",
    role: "lead",
  },
  cmuxlayerClaude: {
    repo: "cmuxlayer",
    launchers: {
      claude: "cmuxlayerClaude",
      codex: "cmuxlayerCodex",
      cursor: "cmuxlayerCursor",
      gemini: "cmuxlayerGemini",
      kiro: "cmuxlayerKiro",
    },
    lane: "cmuxlayer",
    role: "worker",
  },
  brainClaude: {
    repo: "brainlayer",
    launchers: {
      claude: "brainlayerClaude",
      codex: "brainlayerCodex",
      cursor: "brainlayerCursor",
      gemini: "brainlayerGemini",
      kiro: "brainlayerKiro",
    },
    lane: "brainlayer",
    role: "lead",
  },
};

function makeRegistryRepairExec(
  opts: { liveBrainSibling?: boolean } = {},
): ExecFn {
  return vi.fn().mockImplementation(async (_cmd, args) => {
    if (args.includes("list-workspaces")) {
      return {
        stdout: JSON.stringify({
          workspaces: [
            {
              ref: "workspace:1",
              title: "Active",
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
              ref: "pane:left",
              index: 0,
              focused: true,
              surface_count: 2,
              surface_refs: ["surface:4", "surface:35"],
              selected_surface_ref: "surface:35",
              pixel_frame: { x: 0, y: 0, width: 500, height: 900 },
            },
            {
              ref: "pane:right",
              index: 1,
              focused: false,
              surface_count: opts.liveBrainSibling ? 2 : 1,
              surface_refs: opts.liveBrainSibling
                ? ["surface:27", "surface:28"]
                : ["surface:27"],
              selected_surface_ref: "surface:27",
              pixel_frame: { x: 500, y: 0, width: 500, height: 900 },
            },
          ],
        }),
        stderr: "",
      };
    }

    if (args.includes("list-pane-surfaces")) {
      const pane = args.includes("--pane")
        ? args[args.indexOf("--pane") + 1]
        : "pane:left";
      return {
        stdout: JSON.stringify({
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          pane_ref: pane,
          surfaces:
            pane === "pane:left"
              ? [
                  {
                    ref: "surface:4",
                    title: "🎯 orc-driver",
                    type: "terminal",
                    index: 0,
                    selected: false,
                  },
                  {
                    ref: "surface:35",
                    title: "cmuxlayerClaude",
                    type: "terminal",
                    index: 1,
                    selected: true,
                  },
                ]
              : [
                  {
                    ref: "surface:27",
                    title: "brainlayerClaude",
                    type: "terminal",
                    index: 0,
                    selected: true,
                  },
                  ...(opts.liveBrainSibling
                    ? [
                        {
                          ref: "surface:28",
                          title: "brainlayerClaude",
                          type: "terminal",
                          index: 1,
                          selected: false,
                        },
                      ]
                    : []),
                ],
        }),
        stderr: "",
      };
    }

    if (args.includes("read-screen")) {
      const surface = args[args.indexOf("--surface") + 1];
      return {
        stdout: JSON.stringify({
          surface,
          text:
            surface === "surface:27"
              ? "✻ Working…\n  Reading files\n🤖 Sonnet 4.6 | 💰 $0.50 | ⏱️ 41s\n"
              : "Claude Code\n✻ Working…\n  Coordinating agents\n🤖 Opus 4.8 | 💰 $1.25 | ⏱️ 2m\n",
          lines: 20,
          scrollback_used: false,
        }),
        stderr: "",
      };
    }

    return {
      stdout: JSON.stringify({}),
      stderr: "",
    };
  });
}

function makeSeatRecordRepairExec(): ExecFn & {
  showCoachAgent(): void;
  showCoachShell(): void;
} {
  let coachHasAgent = true;
  const exec = vi.fn().mockImplementation(async (_cmd, args) => {
    if (args.includes("list-workspaces")) {
      return {
        stdout: JSON.stringify({
          workspaces: [
            {
              ref: "workspace:1",
              title: "Active",
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
              ref: "pane:left",
              index: 0,
              focused: true,
              surface_count: 1,
              surface_refs: ["surface:coach"],
              selected_surface_ref: "surface:coach",
              pixel_frame: { x: 0, y: 0, width: 500, height: 900 },
            },
            {
              ref: "pane:right",
              index: 1,
              focused: false,
              surface_count: 1,
              surface_refs: ["surface:golems"],
              selected_surface_ref: "surface:golems",
              pixel_frame: { x: 500, y: 0, width: 500, height: 900 },
            },
          ],
        }),
        stderr: "",
      };
    }

    if (args.includes("list-pane-surfaces")) {
      const pane = args.includes("--pane")
        ? args[args.indexOf("--pane") + 1]
        : "pane:left";
      return {
        stdout: JSON.stringify({
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          pane_ref: pane,
          surfaces:
            pane === "pane:left"
              ? [
                  {
                    ref: "surface:coach",
                    title: "coachClaude",
                    type: "terminal",
                    index: 0,
                    selected: true,
                  },
                ]
              : [
                  {
                    ref: "surface:golems",
                    title: "golemsCodex",
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
      const surface = args[args.indexOf("--surface") + 1];
      return {
        stdout: JSON.stringify({
          surface,
          text:
            surface === "surface:coach"
              ? coachHasAgent
                ? "Claude Code\n✻ Working…\n  Coaching session\n🤖 Opus 4.8 | 💰 $0.40 | ⏱️ 2m\n"
                : "$ "
              : "gpt-5.5 · 82% left · ~/Gits/golems\nWorking (1m 03s • esc to interrupt)",
          lines: 20,
          scrollback_used: false,
        }),
        stderr: "",
      };
    }

    return {
      stdout: JSON.stringify({}),
      stderr: "",
    };
  });
  exec.showCoachAgent = () => {
    coachHasAgent = true;
  };
  exec.showCoachShell = () => {
    coachHasAgent = false;
  };
  return exec;
}

function makeLeftColumnWorkerExec(
  opts: {
    singleColumn?: boolean;
    failPostMoveTopologyOnce?: boolean;
    stableIds?: boolean;
    workerScreen?: string;
    workerTitle?: string;
    zeroAreaPhantom?: boolean;
  } = {},
): ExecFn & { recycleSeedSurfaceRef(): void } {
  let workerPane = "pane:left";
  let rightPaneExists = !opts.singleColumn;
  let seedSurfaceOpen = false;
  let postMoveTopologyFailed = false;
  let seedSurfaceRef = "surface:worker-column-seed";
  let seedSurfaceRefRecycled = false;
  const leadUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const workerUuid = "11111111-2222-4333-8444-555555555555";
  const shellUuid = "22222222-3333-4444-8555-666666666666";
  const seedUuid = "33333333-4444-4555-8666-777777777777";
  const recycledSeedRefUuid = "44444444-5555-4666-8777-888888888888";

  const exec = vi.fn().mockImplementation(async (_cmd, args) => {
    if (args.includes("new-split")) {
      rightPaneExists = true;
      seedSurfaceOpen = true;
      return {
        stdout: JSON.stringify({
          workspace: "workspace:1",
          pane: "pane:right",
          surface: seedSurfaceRef,
          ...(opts.stableIds ? { surface_id: seedUuid } : {}),
          title: "",
          type: "terminal",
        }),
        stderr: "",
      };
    }

    if (args.includes("move-surface")) {
      workerPane = String(args[args.indexOf("--pane") + 1]);
      return {
        stdout: JSON.stringify({
          workspace: "workspace:1",
          pane: workerPane,
          surface: "surface:worker-left",
        }),
        stderr: "",
      };
    }

    if (args.includes("close-surface")) {
      const surface = String(args[args.indexOf("--surface") + 1]);
      if (surface === seedSurfaceRef) {
        seedSurfaceOpen = false;
      }
      return { stdout: JSON.stringify({ ok: true }), stderr: "" };
    }

    if (args.includes("list-workspaces")) {
      return {
        stdout: JSON.stringify({
          workspaces: [
            {
              ref: "workspace:1",
              title: "Active",
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
      if (
        opts.failPostMoveTopologyOnce &&
        workerPane === "pane:right" &&
        !postMoveTopologyFailed
      ) {
        postMoveTopologyFailed = true;
        throw new Error("transient pane topology failure");
      }
      return {
        stdout: JSON.stringify({
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          panes: [
            ...(opts.zeroAreaPhantom
              ? [
                  {
                    ref: "pane:phantom",
                    index: 0,
                    focused: false,
                    surface_count: 1,
                    surface_refs: ["surface:phantom"],
                    surface_ids: ["55555555-6666-4777-8888-999999999999"],
                    selected_surface_ref: "surface:phantom",
                    pixel_frame: { x: -500, y: 0, width: 0, height: 0 },
                  },
                ]
              : []),
            {
              ref: "pane:left",
              index: opts.zeroAreaPhantom ? 1 : 0,
              focused: true,
              surface_count: workerPane === "pane:left" ? 2 : 1,
              surface_refs:
                workerPane === "pane:left"
                  ? ["surface:lead", "surface:worker-left"]
                  : ["surface:lead"],
              ...(opts.stableIds
                ? {
                    surface_ids:
                      workerPane === "pane:left"
                        ? [leadUuid, workerUuid]
                        : [leadUuid],
                  }
                : {}),
              selected_surface_ref: "surface:lead",
              pixel_frame: { x: 0, y: 0, width: 500, height: 900 },
            },
            ...(rightPaneExists
              ? [
                  {
                    ref: "pane:right",
                    index: opts.zeroAreaPhantom ? 2 : 1,
                    focused: false,
                    surface_count:
                      (seedSurfaceOpen
                        ? seedSurfaceRefRecycled
                          ? 2
                          : 1
                        : 0) +
                      Number(workerPane === "pane:right") ||
                      1,
                    surface_refs: [
                      ...(seedSurfaceOpen
                        ? [
                            ...(seedSurfaceRefRecycled
                              ? ["surface:worker-column-seed"]
                              : []),
                            seedSurfaceRef,
                          ]
                        : []),
                      ...(workerPane === "pane:right"
                        ? ["surface:worker-left"]
                        : []),
                      ...(!seedSurfaceOpen && workerPane !== "pane:right"
                        ? ["surface:shell"]
                        : []),
                    ],
                    ...(opts.stableIds
                      ? {
                          surface_ids: [
                            ...(seedSurfaceOpen
                              ? [
                                  ...(seedSurfaceRefRecycled
                                    ? [recycledSeedRefUuid]
                                    : []),
                                  seedUuid,
                                ]
                              : []),
                            ...(workerPane === "pane:right"
                              ? [workerUuid]
                              : []),
                            ...(!seedSurfaceOpen && workerPane !== "pane:right"
                              ? [shellUuid]
                              : []),
                          ],
                        }
                      : {}),
                    selected_surface_ref: seedSurfaceOpen
                      ? seedSurfaceRef
                      : workerPane === "pane:right"
                        ? "surface:worker-left"
                        : "surface:shell",
                    pixel_frame: { x: 500, y: 0, width: 500, height: 900 },
                  },
                ]
              : []),
          ],
        }),
        stderr: "",
      };
    }

    if (args.includes("list-pane-surfaces")) {
      const pane = String(args[args.indexOf("--pane") + 1]);
      const base =
        pane === "pane:phantom"
          ? [
              {
                ref: "surface:phantom",
                id: "55555555-6666-4777-8888-999999999999",
                title: "operator phantom",
                type: "terminal" as const,
                index: 0,
                selected: true,
              },
            ]
          : pane === "pane:left"
          ? [
              {
                ref: "surface:lead",
                ...(opts.stableIds ? { id: leadUuid } : {}),
                title: "cmuxlayerClaude-LEAD",
                type: "terminal",
                index: 0,
                selected: true,
              },
            ]
          : [
              ...(seedSurfaceOpen
                ? [
                    ...(seedSurfaceRefRecycled
                      ? [
                          {
                            ref: "surface:worker-column-seed",
                            ...(opts.stableIds
                              ? { id: recycledSeedRefUuid }
                              : {}),
                            title: "replacement",
                            type: "terminal" as const,
                            index: 0,
                            selected: false,
                          },
                        ]
                      : []),
                    {
                      ref: seedSurfaceRef,
                      ...(opts.stableIds ? { id: seedUuid } : {}),
                      title: "",
                      type: "terminal",
                      index: 0,
                      selected: true,
                    },
                  ]
                : []),
              ...(!seedSurfaceOpen && workerPane !== "pane:right"
                ? [
                    {
                      ref: "surface:shell",
                      ...(opts.stableIds ? { id: shellUuid } : {}),
                      title: "notes",
                      type: "terminal",
                      index: 0,
                      selected: true,
                    },
                  ]
                : []),
            ];
      return {
        stdout: JSON.stringify({
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          pane_ref: pane,
          surfaces:
            workerPane === pane
              ? [
                  ...base,
                  {
                    ref: "surface:worker-left",
                    ...(opts.stableIds ? { id: workerUuid } : {}),
                    title: opts.workerTitle ?? "stalkerCodex",
                    type: "terminal",
                    index: 1,
                    selected: false,
                  },
                ]
              : base,
        }),
        stderr: "",
      };
    }

    if (args.includes("read-screen")) {
      const surface = String(args[args.indexOf("--surface") + 1]);
      return {
        stdout: JSON.stringify({
          surface,
          text:
            surface === "surface:worker-left"
              ? (opts.workerScreen ??
                "gpt-5.5 · Working (1m 03s • esc to interrupt)")
              : "Claude Code\n✻ Working…\n🤖 Opus 4.8",
          lines: 20,
          scrollback_used: false,
        }),
        stderr: "",
      };
    }

    return { stdout: JSON.stringify({}), stderr: "" };
  });

  const controllable = exec as unknown as ExecFn & {
    recycleSeedSurfaceRef(): void;
  };
  controllable.recycleSeedSurfaceRef = () => {
    seedSurfaceRef = "surface:worker-column-seed-moved";
    seedSurfaceRefRecycled = true;
  };
  return controllable;
}

function afterNextPaneSnapshot(
  base: ExecFn,
  pane: string,
  onSnapshot: () => void,
): { exec: ExecFn; arm(): void } {
  let armed = false;
  const exec: ExecFn = vi.fn().mockImplementation(async (cmd, args) => {
    const result = await base(cmd, args);
    if (
      armed &&
      args.includes("list-pane-surfaces") &&
      String(args[args.indexOf("--pane") + 1]) === pane
    ) {
      armed = false;
      queueMicrotask(onSnapshot);
    }
    return result;
  });
  return {
    exec,
    arm() {
      armed = true;
    },
  };
}

function armAfterSecondResyncMerge(
  registry: {
    listMerged: (...args: any[]) => Promise<any>;
  },
  arm: () => void,
): void {
  const originalListMerged = registry.listMerged.bind(registry);
  let listMergedCalls = 0;
  vi.spyOn(registry, "listMerged").mockImplementation(async (...args: any[]) => {
    const merged = await originalListMerged(...args);
    listMergedCalls += 1;
    if (listMergedCalls === 2) arm();
    return merged;
  });
}

function makeMovedUuidReflowExec(): {
  exec: ExecFn;
  moveStableUuidToRight(): void;
} {
  const stableUuid = "11111111-2222-4333-8444-555555555555";
  let moved = false;
  const exec: ExecFn = vi.fn().mockImplementation(async (_cmd, args) => {
    if (args.includes("list-workspaces")) {
      return {
        stdout: JSON.stringify({
          workspaces: [
            {
              ref: "workspace:1",
              title: "Active",
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
              ref: "pane:left",
              index: 0,
              focused: true,
              surface_count: 1,
              surface_refs: ["surface:old"],
              surface_ids: [moved ? "uuid-recycled" : stableUuid],
              selected_surface_ref: "surface:old",
              pixel_frame: { x: 0, y: 0, width: 500, height: 900 },
            },
            {
              ref: "pane:right",
              index: 1,
              focused: false,
              surface_count: 1,
              surface_refs: [moved ? "surface:new" : "surface:shell"],
              surface_ids: [moved ? stableUuid : "uuid-shell"],
              selected_surface_ref: moved ? "surface:new" : "surface:shell",
              pixel_frame: { x: 500, y: 0, width: 500, height: 900 },
            },
          ],
        }),
        stderr: "",
      };
    }

    if (args.includes("list-pane-surfaces")) {
      const pane = String(args[args.indexOf("--pane") + 1]);
      const surface =
        pane === "pane:left"
          ? {
              ref: "surface:old",
              id: moved ? "uuid-recycled" : stableUuid,
              title: moved ? "foreignCodex" : "cmuxlayerCodex",
            }
          : {
              ref: moved ? "surface:new" : "surface:shell",
              id: moved ? stableUuid : "uuid-shell",
              title: moved ? "cmuxlayerCodex" : "notes",
            };
      return {
        stdout: JSON.stringify({
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          pane_ref: pane,
          surfaces: [
            {
              ...surface,
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
      const surface = String(args[args.indexOf("--surface") + 1]);
      return {
        stdout: JSON.stringify({
          surface,
          text:
            surface === "surface:shell"
              ? "$ "
              : "gpt-5.5 · Working (1m 03s • esc to interrupt)",
          lines: 20,
          scrollback_used: false,
        }),
        stderr: "",
      };
    }

    if (args.includes("move-surface")) {
      return {
        stdout: JSON.stringify({
          workspace: "workspace:1",
          pane: String(args[args.indexOf("--pane") + 1]),
          surface: String(args[args.indexOf("--surface") + 1]),
        }),
        stderr: "",
      };
    }

    return { stdout: JSON.stringify({}), stderr: "" };
  });

  return {
    exec,
    moveStableUuidToRight() {
      moved = true;
    },
  };
}

describe("resync_agents tool", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("registers resync_agents alongside the lifecycle tools", () => {
    const mockExec: ExecFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ workspaces: [] }),
      stderr: "",
    });
    const server = createServer({
      exec: mockExec,
      stateDir: TEST_DIR,
    });

    expect((server as any)._registeredTools["resync_agents"]).toBeDefined();
  });

  it("discovers and publishes the first fleet once for a shared server context", async () => {
    const exec = makeDiscoveryExec();
    const publisher = {
      publish: vi.fn(),
      dispose: vi.fn(),
    };
    const context = createServerContext({
      exec,
      stateDir: TEST_DIR,
      controlHealthIntervalMs: 0,
    });
    const first = createServer({ context, fleetSidebarPublisher: publisher });

    try {
      await context.lifecycleStartPromise;
      const discoveryReadCount = () =>
        (exec as ReturnType<typeof vi.fn>).mock.calls.filter(([, args]) => {
          const linesIndex = args.indexOf("--lines");
          return (
            args.includes("read-screen") &&
            linesIndex >= 0 &&
            args[linesIndex + 1] === "30"
          );
        }).length;
      const readsAfterFirstInitialize = discoveryReadCount();
      const second = createServer({
        context,
        fleetSidebarPublisher: publisher,
      });
      await context.lifecycleStartPromise;

      expect(readsAfterFirstInitialize).toBeGreaterThan(0);
      expect(discoveryReadCount()).toBe(readsAfterFirstInitialize);
      expect(publisher.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          state: "populated",
          snapshot: expect.objectContaining({
            seatCount: 1,
            lanes: [
              expect.objectContaining({
                key: "other",
              }),
            ],
          }),
        }),
      );
      await second.close();
    } finally {
      await first.close();
      context.dispose();
    }
  });

  it("list_agents discovers live agents from surfaces even with an empty registry", async () => {
    const server = createServer({
      exec: makeDiscoveryExec(),
      stateDir: TEST_DIR,
    });

    const result = await (server as any)._registeredTools["list_agents"].handler(
      {},
      {} as any,
    );
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(1);
    expect(parsed.agents[0].state).toBe("working");
  });

  it("my_agents returns discovered root agents even when no parent_agent_id is provided", async () => {
    const server = createServer({
      exec: makeDiscoveryExec(),
      stateDir: TEST_DIR,
    });

    const result = await (server as any)._registeredTools["my_agents"].handler(
      {},
      {} as any,
    );
    const parsed = parseResult(result);

    expect(parsed.count).toBe(1);
    expect(parsed.parent_agent_id).toBeNull();
    expect(parsed.agents[0].state).toBe("working");
  });

  it("resync_agents force-refreshes discovery and reports added agents", async () => {
    const server = createServer({
      exec: makeDiscoveryExec(),
      stateDir: TEST_DIR,
    });

    const tool = (server as any)._registeredTools["resync_agents"];
    const result = await tool.handler({}, {} as any);
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.diff.added).toHaveLength(1);
    expect(parsed.count).toBe(1);
  });

  it("resync_agents never moves an auto-discovered unknown-provenance worker", async () => {
    const exec = makeLeftColumnWorkerExec();
    const server = createServer({ exec, stateDir: TEST_DIR });

    const result = await (server as any)._registeredTools["resync_agents"].handler(
      {},
      {} as any,
    );
    const parsed = parseResult(result);

    expect(exec).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "move-surface",
        "--surface",
        "surface:worker-left",
        "--pane",
        "pane:right",
      ]),
    );
    expect(parsed.diff.reflowed).toEqual([]);
  });

  it("resync_agents never reflows a UUID-less worker owned by another observer", async () => {
    const stateMgr = new StateManager(TEST_DIR);
    stateMgr.writeState(
      makeAgentRecord({
        agent_id: "foreign-observer-reflow-worker",
        surface_id: "surface:worker-left",
        surface_uuid: null,
        surface_observer_id: "cmux:/tmp/foreign.sock",
        workspace_id: "workspace:1",
        role: "worker",
        cli: "codex",
      }),
    );
    const exec = makeLeftColumnWorkerExec({
      singleColumn: true,
      workerScreen: "$ ",
      workerTitle: "notes",
    });
    const context = createServerContext({
      exec,
      stateDir: TEST_DIR,
      controlHealthIntervalMs: 0,
    });
    const server = createServer({ context });
    await context.lifecycleStartPromise;
    const result = await (server as any)._registeredTools["resync_agents"].handler(
      {},
      {} as any,
    );
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(exec).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["new-split"]),
    );
    expect(exec).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "move-surface",
        "--surface",
        "surface:worker-left",
      ]),
    );
    expect(parsed.diff.reflowed).toEqual([]);
  });

  it("resync_agents never reflows a recycled ref after the worker UUID moves", async () => {
    const stateMgr = new StateManager(TEST_DIR);
    const stableUuid = "11111111-2222-4333-8444-555555555555";
    stateMgr.writeState(
      makeAgentRecord({
        agent_id: "uuid-reflow-worker",
        surface_id: "surface:old",
        surface_uuid: stableUuid,
        workspace_id: "workspace:1",
        role: "worker",
        cli: "codex",
      }),
    );
    const route = makeMovedUuidReflowExec();
    const context = createServerContext({
      exec: route.exec,
      stateDir: TEST_DIR,
      controlHealthIntervalMs: 0,
    });
    const server = createServer({ context });
    await context.lifecycleStartPromise;
    const engine = (server as any)._registeredTools["interact"]._engine;
    const registry = engine.getRegistry();
    const originalListMerged = registry.listMerged.bind(registry);
    let listMergedCalls = 0;
    vi.spyOn(registry, "listMerged").mockImplementation(async (...args: any[]) => {
      const merged = await originalListMerged(...args);
      listMergedCalls += 1;
      if (listMergedCalls === 2) {
        route.moveStableUuidToRight();
      }
      return merged;
    });

    const result = await (server as any)._registeredTools["resync_agents"].handler(
      {},
      {} as any,
    );
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(route.exec).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "move-surface",
        "--surface",
        "surface:old",
      ]),
    );
    expect(parsed.diff.reflowed).toEqual([]);
  });

  it("resync_agents refuses a seed split when the observer changes after its topology snapshot", async () => {
    writeProgrammaticLeftWorker({
      surface_observer_id: "cmux:/tmp/cmux-primary.sock",
    });
    const base = makeLeftColumnWorkerExec({
      singleColumn: true,
      stableIds: true,
    });
    let currentObserverId = "cmux:/tmp/cmux-primary.sock";
    const context = createServerContext({
      exec: base,
      stateDir: TEST_DIR,
      controlHealthIntervalMs: 0,
      surfaceObserverOwnerIdProvider: () => currentObserverId,
      surfaceObserverEpochProvider: () => `${currentObserverId}@test`,
    });
    const server = createServer({ context });
    await context.lifecycleStartPromise;
    markProgrammaticLeftWorkerIdle();
    const registry = (server as any)._registeredTools["interact"]._engine.getRegistry() as any;
    let switchOnNextBindingAuthorization = false;
    const originalCanUseObservedBinding =
      registry.canUseObservedBinding.bind(registry);
    vi.spyOn(registry, "canUseObservedBinding").mockImplementation(
      (...args: any[]) => {
        const allowed = originalCanUseObservedBinding(...args);
        if (allowed && switchOnNextBindingAuthorization) {
          switchOnNextBindingAuthorization = false;
          currentObserverId = "cmux:/tmp/cmux-secondary.sock";
        }
        return allowed;
      },
    );
    armAfterSecondResyncMerge(registry, () => {
      switchOnNextBindingAuthorization = true;
    });

    try {
      const result = await (server as any)._registeredTools["resync_agents"].handler(
        {},
        {} as any,
      );
      const parsed = parseResult(result);

      expect(parsed.ok).toBe(true);
      expect(base).not.toHaveBeenCalledWith(
        "cmux",
        expect.arrayContaining(["new-split"]),
      );
      expect(base).not.toHaveBeenCalledWith(
        "cmux",
        expect.arrayContaining(["move-surface"]),
      );
      expect(parsed.diff.reflowed).toEqual([]);
      expect(parsed.diff.reflow_skipped).toEqual([
        expect.objectContaining({
          operation: "new_split",
          reason: expect.stringMatching(/observer.*changed/i),
        }),
      ]);
    } finally {
      await server.close();
      context.dispose();
    }
  });

  it("resync_agents fresh-checks a worker UUID before moving and never moves its recycled ref", async () => {
    const stateMgr = new StateManager(TEST_DIR);
    const stableUuid = "11111111-2222-4333-8444-555555555555";
    stateMgr.writeState(
      makeAgentRecord({
        agent_id: "uuid-reflow-worker-after-snapshot",
        surface_id: "surface:old",
        surface_uuid: stableUuid,
        workspace_id: "workspace:1",
        role: "worker",
        cli: "codex",
        state: "working",
        surface_provenance: "cmuxlayer_spawn",
      }),
    );
    const route = makeMovedUuidReflowExec();
    const snapshot = afterNextPaneSnapshot(
      route.exec,
      "pane:right",
      route.moveStableUuidToRight,
    );
    const context = createServerContext({
      exec: snapshot.exec,
      stateDir: TEST_DIR,
      controlHealthIntervalMs: 0,
    });
    const server = createServer({ context });
    await context.lifecycleStartPromise;
    stateMgr.transition("uuid-reflow-worker-after-snapshot", "idle");
    const registry = (server as any)._registeredTools["interact"]._engine.getRegistry();
    armAfterSecondResyncMerge(registry, snapshot.arm);

    try {
      const result = await (server as any)._registeredTools["resync_agents"].handler(
        {},
        {} as any,
      );
      const parsed = parseResult(result);

      expect(parsed.ok).toBe(true);
      expect(snapshot.exec).not.toHaveBeenCalledWith(
        "cmux",
        expect.arrayContaining(["move-surface"]),
      );
      expect(parsed.diff.reflowed).toEqual([]);
      expect(parsed.diff.reflow_skipped).toEqual([
        expect.objectContaining({
          operation: "move_surface",
          surface_id: "surface:old",
          reason: expect.stringMatching(/binding.*changed|stable.*uuid/i),
        }),
      ]);
    } finally {
      await server.close();
      context.dispose();
    }
  });

  it("resync_agents never moves an idle worker that starts working before mutation", async () => {
    const stateMgr = new StateManager(TEST_DIR);
    const agentId = "idle-worker-starts-working";
    stateMgr.writeState(
      makeAgentRecord({
        agent_id: agentId,
        surface_id: "surface:worker-left",
        surface_uuid: "11111111-2222-4333-8444-555555555555",
        workspace_id: "workspace:1",
        state: "working",
        role: "worker",
        cli: "codex",
        surface_provenance: "cmuxlayer_spawn",
      }),
    );
    const base = makeLeftColumnWorkerExec({ stableIds: true });
    let registry: any;
    const snapshot = afterNextPaneSnapshot(base, "pane:right", () => {
      const working = stateMgr.transition(agentId, "working");
      registry.set(agentId, working);
    });
    const context = createServerContext({
      exec: snapshot.exec,
      stateDir: TEST_DIR,
      controlHealthIntervalMs: 0,
    });
    const server = createServer({ context });
    await context.lifecycleStartPromise;
    const idle = stateMgr.transition(agentId, "idle");
    registry = (server as any)._registeredTools["interact"]._engine.getRegistry();
    registry.set(agentId, idle);
    armAfterSecondResyncMerge(registry, snapshot.arm);

    try {
      const result = await (server as any)._registeredTools["resync_agents"].handler(
        {},
        {} as any,
      );
      const parsed = parseResult(result);

      expect(parsed.ok).toBe(true);
      expect(snapshot.exec).not.toHaveBeenCalledWith(
        "cmux",
        expect.arrayContaining(["move-surface"]),
      );
      expect(parsed.diff.reflowed).toEqual([]);
      expect(parsed.diff.reflow_skipped).toEqual([
        expect.objectContaining({
          agent_id: agentId,
          operation: "move_surface",
          reason: expect.stringMatching(/state|busy/i),
        }),
      ]);
    } finally {
      await server.close();
      context.dispose();
    }
  });

  it("resync_agents fresh-resolves a seeded surface UUID before cleanup instead of closing a recycled ref", async () => {
    writeProgrammaticLeftWorker();
    const base = makeLeftColumnWorkerExec({
      singleColumn: true,
      stableIds: true,
    });
    let recycleAfterMove = false;
    const exec: ExecFn = vi.fn().mockImplementation(async (cmd, args) => {
      const result = await base(cmd, args);
      if (args.includes("move-surface")) {
        recycleAfterMove = true;
      } else if (
        recycleAfterMove &&
        args.includes("list-pane-surfaces") &&
        String(args[args.indexOf("--pane") + 1]) === "pane:right"
      ) {
        recycleAfterMove = false;
        queueMicrotask(() => base.recycleSeedSurfaceRef());
      }
      return result;
    });
    const server = createServer({ exec, stateDir: TEST_DIR });
    markProgrammaticLeftWorkerIdle();

    const result = await (server as any)._registeredTools["resync_agents"].handler(
      {},
      {} as any,
    );
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(exec).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "close-surface",
        "--surface",
        "surface:worker-column-seed",
      ]),
    );
    expect(exec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "close-surface",
        "--surface",
        "surface:worker-column-seed-moved",
      ]),
    );
    expect(parsed.diff.reflowed).toHaveLength(1);
  });

  it("resync_agents reports and skips a seed split in a manual workspace", async () => {
    writeProgrammaticLeftWorker();
    const base = makeLeftColumnWorkerExec({
      singleColumn: true,
      stableIds: true,
    });
    const exec: ExecFn = vi.fn().mockImplementation(async (cmd, args) => {
      if (args.includes("list-status")) {
        return {
          stdout: JSON.stringify([{ key: "mode.control", value: "manual" }]),
          stderr: "",
        };
      }
      return base(cmd, args);
    });
    const server = createServer({ exec, stateDir: TEST_DIR });
    markProgrammaticLeftWorkerIdle();

    const result = await (server as any)._registeredTools["resync_agents"].handler(
      {},
      {} as any,
    );
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(exec).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["new-split"]),
    );
    expect(exec).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["move-surface"]),
    );
    expect(parsed.diff.reflow_skipped).toEqual([
      expect.objectContaining({
        operation: "new_split",
        reason: expect.stringMatching(/manual mode/i),
      }),
    ]);
  });

  it("resync_agents reports and skips moving a manual surface", async () => {
    writeProgrammaticLeftWorker();
    const base = makeLeftColumnWorkerExec({ stableIds: true });
    const exec: ExecFn = vi.fn().mockImplementation(async (cmd, args) => {
      if (args.includes("list-status")) {
        return {
          stdout: JSON.stringify([{ key: "mode.control", value: "manual" }]),
          stderr: "",
        };
      }
      return base(cmd, args);
    });
    const server = createServer({ exec, stateDir: TEST_DIR });
    markProgrammaticLeftWorkerIdle();

    const result = await (server as any)._registeredTools["resync_agents"].handler(
      {},
      {} as any,
    );
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(exec).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["move-surface"]),
    );
    expect(parsed.diff.reflow_skipped).toEqual([
      expect.objectContaining({
        operation: "move_surface",
        reason: expect.stringMatching(/manual mode/i),
      }),
    ]);
  });

  it("resync_agents reports and skips seed cleanup when the seed becomes manual", async () => {
    writeProgrammaticLeftWorker();
    const base = makeLeftColumnWorkerExec({
      singleColumn: true,
      stableIds: true,
    });
    let workerMoved = false;
    const exec: ExecFn = vi.fn().mockImplementation(async (cmd, args) => {
      if (args.includes("list-status")) {
        return {
          stdout: JSON.stringify(
            workerMoved
              ? [{ key: "mode.control", value: "manual" }]
              : [],
          ),
          stderr: "",
        };
      }
      const result = await base(cmd, args);
      if (args.includes("move-surface")) workerMoved = true;
      return result;
    });
    const server = createServer({ exec, stateDir: TEST_DIR });
    markProgrammaticLeftWorkerIdle();

    const result = await (server as any)._registeredTools["resync_agents"].handler(
      {},
      {} as any,
    );
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(exec).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["close-surface"]),
    );
    expect(parsed.diff.reflowed).toHaveLength(1);
    expect(parsed.diff.reflow_skipped).toEqual([
      expect.objectContaining({
        operation: "close_surface",
        reason: expect.stringMatching(/manual mode/i),
      }),
    ]);
  });

  it("resync_agents rechecks workspace mode after its final seed topology read", async () => {
    writeProgrammaticLeftWorker();
    const base = makeLeftColumnWorkerExec({
      singleColumn: true,
      stableIds: true,
    });
    let armModeFlip = false;
    let manual = false;
    const exec: ExecFn = vi.fn().mockImplementation(async (cmd, args) => {
      if (args.includes("list-status")) {
        const result = {
          stdout: JSON.stringify(
            manual ? [{ key: "mode.control", value: "manual" }] : [],
          ),
          stderr: "",
        };
        armModeFlip = true;
        return result;
      }
      const result = await base(cmd, args);
      if (
        armModeFlip &&
        !manual &&
        args.includes("list-pane-surfaces") &&
        String(args[args.indexOf("--pane") + 1]) === "pane:left"
      ) {
        manual = true;
      }
      return result;
    });
    const server = createServer({ exec, stateDir: TEST_DIR });
    markProgrammaticLeftWorkerIdle();

    const result = await (server as any)._registeredTools["resync_agents"].handler(
      {},
      {} as any,
    );
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(exec).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["new-split"]),
    );
    expect(parsed.diff.reflow_skipped).toEqual([
      expect.objectContaining({
        operation: "new_split",
        reason: expect.stringMatching(/manual mode/i),
      }),
    ]);
  });

  it("resync_agents rechecks surface mode after its final move topology read", async () => {
    writeProgrammaticLeftWorker();
    const base = makeLeftColumnWorkerExec({ stableIds: true });
    let armModeFlip = false;
    let manual = false;
    const exec: ExecFn = vi.fn().mockImplementation(async (cmd, args) => {
      if (args.includes("list-status")) {
        const result = {
          stdout: JSON.stringify(
            manual ? [{ key: "mode.control", value: "manual" }] : [],
          ),
          stderr: "",
        };
        armModeFlip = true;
        return result;
      }
      const result = await base(cmd, args);
      if (
        armModeFlip &&
        !manual &&
        args.includes("list-pane-surfaces") &&
        String(args[args.indexOf("--pane") + 1]) === "pane:left"
      ) {
        manual = true;
      }
      return result;
    });
    const server = createServer({ exec, stateDir: TEST_DIR });
    markProgrammaticLeftWorkerIdle();

    const result = await (server as any)._registeredTools["resync_agents"].handler(
      {},
      {} as any,
    );
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(exec).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["move-surface"]),
    );
    expect(parsed.diff.reflow_skipped).toEqual([
      expect.objectContaining({
        operation: "move_surface",
        reason: expect.stringMatching(/manual mode/i),
      }),
    ]);
  });

  it("resync_agents rechecks seed mode after its final cleanup topology read", async () => {
    writeProgrammaticLeftWorker();
    const base = makeLeftColumnWorkerExec({
      singleColumn: true,
      stableIds: true,
    });
    let workerMoved = false;
    let postMoveRightSnapshots = 0;
    let manual = false;
    const exec: ExecFn = vi.fn().mockImplementation(async (cmd, args) => {
      if (args.includes("list-status")) {
        return {
          stdout: JSON.stringify(
            manual ? [{ key: "mode.control", value: "manual" }] : [],
          ),
          stderr: "",
        };
      }
      const result = await base(cmd, args);
      if (args.includes("move-surface")) {
        workerMoved = true;
      } else if (
        workerMoved &&
        args.includes("list-pane-surfaces") &&
        String(args[args.indexOf("--pane") + 1]) === "pane:right"
      ) {
        postMoveRightSnapshots += 1;
        if (postMoveRightSnapshots === 3) manual = true;
      }
      return result;
    });
    const server = createServer({ exec, stateDir: TEST_DIR });
    markProgrammaticLeftWorkerIdle();

    const result = await (server as any)._registeredTools["resync_agents"].handler(
      {},
      {} as any,
    );
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(exec).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["close-surface"]),
    );
    expect(parsed.diff.reflowed).toHaveLength(1);
    expect(parsed.diff.reflow_skipped).toEqual([
      expect.objectContaining({
        operation: "close_surface",
        reason: expect.stringMatching(/manual mode/i),
      }),
    ]);
  });

  it("resync_agents seeds a right column for a single-column programmatic worker", async () => {
    writeProgrammaticLeftWorker();
    const exec = makeLeftColumnWorkerExec({
      singleColumn: true,
      stableIds: true,
    });
    const server = createServer({ exec, stateDir: TEST_DIR });
    markProgrammaticLeftWorkerIdle();

    const result = await (server as any)._registeredTools["resync_agents"].handler(
      {},
      {} as any,
    );
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(exec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "new-split",
        "right",
        "--surface",
        "surface:worker-left",
      ]),
    );
    expect(exec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "move-surface",
        "--surface",
        "surface:worker-left",
        "--pane",
        "pane:right",
      ]),
    );
    expect(parsed.diff.reflowed).toEqual([
      expect.objectContaining({
        surface_id: "surface:worker-left",
        from_column: 0,
        to_column: 1,
      }),
    ]);
  });

  it("resync_agents ignores a zero-area phantom before the two rendered role columns", async () => {
    writeProgrammaticLeftWorker();
    const exec = makeLeftColumnWorkerExec({
      stableIds: true,
      zeroAreaPhantom: true,
    });
    const server = createServer({ exec, stateDir: TEST_DIR });
    markProgrammaticLeftWorkerIdle();

    const result = await (server as any)._registeredTools["resync_agents"].handler(
      {},
      {} as any,
    );
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(exec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "move-surface",
        "--surface",
        "surface:worker-left",
        "--pane",
        "pane:right",
      ]),
    );
    expect(parsed.diff.reflowed).toEqual([
      expect.objectContaining({
        from_column: 0,
        to_column: 1,
      }),
    ]);
  });

  it("resync_agents keeps its normal diff when post-move topology is transiently unavailable", async () => {
    const exec = makeLeftColumnWorkerExec({ failPostMoveTopologyOnce: true });
    const server = createServer({ exec, stateDir: TEST_DIR });

    const result = await (server as any)._registeredTools["resync_agents"].handler(
      {},
      {} as any,
    );
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.diff).toEqual(
      expect.objectContaining({
        added: expect.any(Array),
        evicted: expect.any(Array),
        repaired: expect.any(Array),
        orphaned: expect.any(Array),
        reflowed: [],
      }),
    );
  });

  it("list_agents persists live state updates for existing auto-discovered agents", async () => {
    const stateMgr = new StateManager(TEST_DIR);
    stateMgr.writeState({
      agent_id: "auto-claude-surface-1",
      surface_id: "surface:1",
      surface_observer_id: TEST_OBSERVER_OWNER,
      workspace_id: null,
      state: "working",
      repo: "brainlayer",
      model: "Sonnet 4.6",
      cli: "claude",
      cli_session_id: null,
      task_summary: "(auto-discovered)",
      pid: null,
      version: 1,
      created_at: "2026-04-19T20:00:00.000Z",
      updated_at: "2026-04-19T20:00:00.000Z",
      error: null,
      parent_agent_id: null,
      spawn_depth: 0,
      deletion_intent: false,
      quality: "unknown",
      max_cost_per_agent: null,
      crash_recover: false,
      respawn_attempts: 0,
      user_killed: false,
    });

    const server = createServer({
      exec: makeIdleDiscoveryExec(),
      stateDir: TEST_DIR,
    });

    const listResult = await (server as any)._registeredTools["list_agents"].handler(
      {},
      {} as any,
    );
    const parsed = parseResult(listResult);

    expect(parsed.count).toBe(1);
    expect(parsed.agents[0].state).toBe("idle");
    expect(stateMgr.readState("auto-claude-surface-1")?.state).toBe("idle");
  });

  it("resync_agents reconciles managed record workspace_id after a surface move", async () => {
    const stateMgr = new StateManager(TEST_DIR);
    stateMgr.writeState(
      makeAgentRecord({
        agent_id: "skillcreatorCodex-019fmove",
        surface_id: "surface:315",
        workspace_id: "workspace:5",
        state: "working",
        repo: "skillcreator",
        model: "gpt-5.5",
        cli: "codex",
        cli_session_id: "019f0001-1111-7222-8333-444455556666",
        role: "worker",
      }),
    );

    const server = createServer({
      exec: makeMovedManagedSurfaceExec(),
      stateDir: TEST_DIR,
    });

    const result = await (server as any)._registeredTools["resync_agents"].handler(
      {},
      {} as any,
    );
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(stateMgr.readState("skillcreatorCodex-019fmove")?.workspace_id).toBe(
      "workspace:1",
    );
  });

  it("get_agent_state refreshes managed workspace_id after a surface move", async () => {
    const stateMgr = new StateManager(TEST_DIR);
    stateMgr.writeState(
      makeAgentRecord({
        agent_id: "skillcreatorCodex-019fdirect",
        surface_id: "surface:315",
        workspace_id: "workspace:5",
        state: "working",
        repo: "skillcreator",
        model: "gpt-5.5",
        cli: "codex",
        cli_session_id: "019f0001-1111-7222-8333-444455556666",
        role: "worker",
      }),
    );

    const server = createServer({
      exec: makeMovedManagedSurfaceExec(),
      stateDir: TEST_DIR,
    });

    const result = await (server as any)._registeredTools[
      "get_agent_state"
    ].handler({ agent_id: "skillcreatorCodex-019fdirect" }, {} as any);
    const parsed = parseResult(result);

    expect(parsed.workspace_id).toBe("workspace:1");
    expect(stateMgr.readState("skillcreatorCodex-019fdirect")?.workspace_id).toBe(
      "workspace:1",
    );
    expect(parsed.health.issue_codes).not.toContain("workspace_mismatch");
  });

  it("resync_agents keeps existing auto agents when discovery hits read-screen errors", async () => {
    const stateMgr = new StateManager(TEST_DIR);
    stateMgr.writeState({
      agent_id: "auto-claude-surface-1",
      surface_id: "surface:1",
      workspace_id: null,
      state: "working",
      repo: "brainlayer",
      model: "Sonnet 4.6",
      cli: "claude",
      cli_session_id: null,
      task_summary: "(auto-discovered)",
      pid: null,
      version: 1,
      created_at: "2026-04-19T20:00:00.000Z",
      updated_at: "2026-04-19T20:00:00.000Z",
      error: null,
      parent_agent_id: null,
      spawn_depth: 0,
      deletion_intent: false,
      quality: "unknown",
      max_cost_per_agent: null,
      crash_recover: false,
      respawn_attempts: 0,
      user_killed: false,
    });

    const server = createServer({
      exec: makeReadErrorExec(),
      stateDir: TEST_DIR,
    });

    const resyncResult = await (server as any)._registeredTools["resync_agents"].handler(
      {},
      {} as any,
    );
    const parsed = parseResult(resyncResult);

    expect(parsed.ok).toBe(true);
    expect(parsed.diff.evicted).not.toContain("auto-claude-surface-1");
    expect(stateMgr.readState("auto-claude-surface-1")?.state).toBe("working");

    const listResult = await (server as any)._registeredTools["list_agents"].handler(
      {},
      {} as any,
    );
    const listed = parseResult(listResult);
    expect(listed.count).toBe(1);
    expect(listed.agents[0].agent_id).toBe("auto-claude-surface-1");
  });

  it("resync_agents does not mutate an active record on its first partial omission", async () => {
    const stateMgr = new StateManager(TEST_DIR);
    stateMgr.writeState(
      makeAgentRecord({
        agent_id: "transient-resync-agent",
        surface_id: "surface:transient",
        state: "working",
      }),
    );
    const server = createServer({
      exec: makeDiscoveryExec(),
      stateDir: TEST_DIR,
    });

    const result = await (server as any)._registeredTools[
      "resync_agents"
    ].handler({}, {} as any);
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.diff.evicted).not.toContain("transient-resync-agent");
    expect(stateMgr.readState("transient-resync-agent")).toMatchObject({
      state: "working",
      error: null,
    });
  });

  it("resync_agents evicts ghost booting agents whose surface no longer exists", async () => {
    const firstObservedAt = Date.parse("2026-07-14T07:00:00.000Z");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(firstObservedAt);
    const stateMgr = new StateManager(TEST_DIR);
    stateMgr.writeState({
      agent_id: "ghost-agent",
      surface_id: "surface:999",
      surface_observer_id: TEST_OBSERVER_OWNER,
      workspace_id: "workspace:1",
      state: "booting",
      repo: "skill-creator",
      model: "sonnet",
      cli: "claude",
      cli_session_id: null,
      task_summary: "stuck boot",
      pid: null,
      version: 1,
      created_at: "2026-04-19T20:00:00.000Z",
      updated_at: "2026-04-19T20:00:00.000Z",
      error: null,
      parent_agent_id: null,
      spawn_depth: 0,
      deletion_intent: false,
      quality: "unknown",
      max_cost_per_agent: null,
      crash_recover: false,
      respawn_attempts: 0,
      user_killed: false,
    });

    const server = createServer({
      exec: makeDiscoveryExec(),
      stateDir: TEST_DIR,
    });

    const tool = (server as any)._registeredTools["resync_agents"];
    const firstResult = parseResult(await tool.handler({}, {} as any));

    expect(firstResult.ok).toBe(true);
    expect(firstResult.diff.evicted).not.toContain("ghost-agent");
    expect(stateMgr.readState("ghost-agent")?.state).toBe("booting");

    nowSpy.mockReturnValue(
      firstObservedAt + SURFACE_EVICTION_CONFIRMATION_MS + 1,
    );
    const parsed = parseResult(await tool.handler({}, {} as any));

    expect(parsed.ok).toBe(true);
    expect(parsed.diff.evicted).toContain("ghost-agent");
    expect(parsed.count).toBe(1);
  });

  it("resync_agents evicts surfaceless error agents with resumable sessions", async () => {
    const firstObservedAt = Date.parse("2026-07-14T07:00:00.000Z");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(firstObservedAt);
    const stateMgr = new StateManager(TEST_DIR);
    stateMgr.writeState(
      makeAgentRecord({
        agent_id: "surfaceless-error-agent",
        surface_id: "surface:ghost",
        state: "error",
        cli_session_id: "019ec0e6-1111-2222-3333-444455556666",
        role: "orchestrator",
        error: "Surface surface:ghost disappeared",
        crash_recover: false,
      }),
    );

    const server = createServer({
      exec: makeDiscoveryExec(),
      stateDir: TEST_DIR,
    });

    const tool = (server as any)._registeredTools["resync_agents"];
    const firstResult = parseResult(await tool.handler({}, {} as any));

    expect(firstResult.ok).toBe(true);
    expect(firstResult.diff.evicted).not.toContain("surfaceless-error-agent");
    expect(stateMgr.readState("surfaceless-error-agent")?.state).toBe("error");

    nowSpy.mockReturnValue(
      firstObservedAt + SURFACE_EVICTION_CONFIRMATION_MS + 1,
    );
    const parsed = parseResult(await tool.handler({}, {} as any));

    expect(parsed.ok).toBe(true);
    expect(parsed.diff.evicted).toContain("surfaceless-error-agent");
    expect(stateMgr.readState("surfaceless-error-agent")).toBeNull();

    const listed = parseResult(
      await (server as any)._registeredTools["list_agents"].handler({}, {} as any),
    );
    expect(
      listed.agents.map((agent: { agent_id: string }) => agent.agent_id),
    ).not.toContain("surfaceless-error-agent");
  });

  it("resync_agents evicts dead-PTY agents even when their surface still lingers", async () => {
    const stateMgr = new StateManager(TEST_DIR);
    stateMgr.writeState(
      makeAgentRecord({
        agent_id: "dead-pty-agent",
        surface_id: "surface:1",
        state: "working",
        pid: 424242,
      }),
    );
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
        if (pid === 424242 && (signal ?? 0) === 0) {
          const error = new Error("No such process") as NodeJS.ErrnoException;
          error.code = "ESRCH";
          throw error;
        }
        return true;
      }) as typeof process.kill);

    try {
      const server = createServer({
        exec: makeDiscoveryExec(),
        stateDir: TEST_DIR,
      });

      const result = await (server as any)._registeredTools[
        "resync_agents"
      ].handler({}, {} as any);
      const parsed = parseResult(result);

      expect(parsed.ok).toBe(true);
      expect(parsed.diff.evicted).toContain("dead-pty-agent");
      expect(stateMgr.readState("dead-pty-agent")).toBeNull();
    } finally {
      killSpy.mockRestore();
    }
  });

  it("resync_agents never evicts a live registered agent with a healthy surface", async () => {
    const stateMgr = new StateManager(TEST_DIR);
    stateMgr.writeState(
      makeAgentRecord({
        agent_id: "healthy-live-agent",
        surface_id: "surface:1",
        state: "working",
        pid: 31337,
      }),
    );
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
        if (pid === 31337 && (signal ?? 0) === 0) {
          return true;
        }
        return true;
      }) as typeof process.kill);

    try {
      const server = createServer({
        exec: makeDiscoveryExec(),
        stateDir: TEST_DIR,
      });

      const result = await (server as any)._registeredTools[
        "resync_agents"
      ].handler({}, {} as any);
      const parsed = parseResult(result);

      expect(parsed.ok).toBe(true);
      expect(parsed.diff.evicted).not.toContain("healthy-live-agent");
      expect(stateMgr.readState("healthy-live-agent")).not.toBeNull();
    } finally {
      killSpy.mockRestore();
    }
  });

  it("resync_agents does not evict terminal records when surface enumeration is empty", async () => {
    const stateMgr = new StateManager(TEST_DIR);
    stateMgr.writeState(
      makeAgentRecord({
        agent_id: "lead-agent-during-empty-layout",
        surface_id: "surface:lead",
        state: "error",
        role: "orchestrator",
        pid: null,
        error: "temporary layout read",
      }),
    );

    const server = createServer({
      exec: makeEmptySurfaceExec(),
      stateDir: TEST_DIR,
    });

    const result = await (server as any)._registeredTools[
      "resync_agents"
    ].handler({}, {} as any);
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.diff.evicted).not.toContain("lead-agent-during-empty-layout");
    expect(stateMgr.readState("lead-agent-during-empty-layout")).not.toBeNull();
  });

  it("resync_agents keeps recoverable crash-recovery errors for respawn", async () => {
    const stateMgr = new StateManager(TEST_DIR);
    stateMgr.writeState(
      makeAgentRecord({
        agent_id: "recoverable-crash-agent",
        surface_id: "surface:missing-recoverable",
        state: "error",
        cli_session_id: "019ec0e6-1111-2222-3333-444455556666",
        error: "Surface surface:missing-recoverable disappeared",
        crash_recover: true,
        user_killed: false,
      }),
    );

    const server = createServer({
      exec: makeDiscoveryExec(),
      stateDir: TEST_DIR,
    });

    const result = await (server as any)._registeredTools[
      "resync_agents"
    ].handler({}, {} as any);
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.diff.evicted).not.toContain("recoverable-crash-agent");
    expect(stateMgr.readState("recoverable-crash-agent")).not.toBeNull();
  });

  it("resync_agents evicts the exact exhausted Cursor ghost even when its stale surface is in a non-active workspace", async () => {
    const stateMgr = new StateManager(TEST_DIR);
    stateMgr.writeState(
      makeAgentRecord({
        agent_id: "orchestratorCursor-2ec13c6e",
        surface_id: "surface:286",
        workspace_id: "workspace:12",
        state: "error",
        repo: "orchestrator",
        model: "cursor",
        cli: "cursor",
        cli_session_id: null,
        task_summary: "exact registry ghost repro",
        pid: null,
        error: "Max crash recoveries exceeded: 10",
        role: "orchestrator",
        crash_recover: true,
        respawn_attempts: 10,
        user_killed: true,
      }),
    );

    const server = createServer({
      exec: makeMultiWorkspaceExec(),
      stateDir: TEST_DIR,
    });

    const result = await (server as any)._registeredTools[
      "resync_agents"
    ].handler({}, {} as any);
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.diff.evicted).toContain("orchestratorCursor-2ec13c6e");
    expect(stateMgr.readState("orchestratorCursor-2ec13c6e")).toBeNull();
  });

  it("resync_agents keeps pidless terminal records with live surfaces and no dead evidence", async () => {
    const stateMgr = new StateManager(TEST_DIR);
    stateMgr.writeState(
      makeAgentRecord({
        agent_id: "inspectable-terminal-agent",
        surface_id: "surface:287",
        workspace_id: "workspace:12",
        state: "done",
        pid: null,
        user_killed: false,
        respawn_attempts: 0,
      }),
    );

    const server = createServer({
      exec: makeMultiWorkspaceExec(),
      stateDir: TEST_DIR,
    });

    const result = await (server as any)._registeredTools[
      "resync_agents"
    ].handler({}, {} as any);
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.diff.evicted).not.toContain("inspectable-terminal-agent");
    expect(stateMgr.readState("inspectable-terminal-agent")).not.toBeNull();
  });

  it("resync_agents never evicts a healthy agent whose surface is in a non-active workspace", async () => {
    const stateMgr = new StateManager(TEST_DIR);
    stateMgr.writeState(
      makeAgentRecord({
        agent_id: "healthy-other-workspace-agent",
        surface_id: "surface:287",
        workspace_id: "workspace:12",
        state: "working",
        pid: 31338,
      }),
    );
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
        if (pid === 31338 && (signal ?? 0) === 0) {
          return true;
        }
        return true;
      }) as typeof process.kill);

    try {
      const server = createServer({
        exec: makeMultiWorkspaceExec(),
        stateDir: TEST_DIR,
      });

      const result = await (server as any)._registeredTools[
        "resync_agents"
      ].handler({}, {} as any);
      const parsed = parseResult(result);

      expect(parsed.ok).toBe(true);
      expect(parsed.diff.evicted).not.toContain("healthy-other-workspace-agent");
      expect(stateMgr.readState("healthy-other-workspace-agent")).not.toBeNull();
    } finally {
      killSpy.mockRestore();
    }
  });

  it("resync_agents evicts booting ghosts when the surface is alive but no agent is detected", async () => {
    const stateMgr = new StateManager(TEST_DIR);
    stateMgr.writeState({
      agent_id: "booting-ghost",
      surface_id: "surface:999",
      surface_observer_id: TEST_OBSERVER_OWNER,
      workspace_id: "workspace:1",
      state: "booting",
      repo: "skill-creator",
      model: "sonnet",
      cli: "claude",
      cli_session_id: null,
      task_summary: "failed launcher",
      pid: null,
      version: 1,
      created_at: "2026-04-19T19:00:00.000Z",
      updated_at: "2026-04-19T19:00:00.000Z",
      error: null,
      parent_agent_id: null,
      spawn_depth: 0,
      deletion_intent: false,
      quality: "unknown",
      max_cost_per_agent: null,
      crash_recover: false,
      respawn_attempts: 0,
      user_killed: false,
    });

    const server = createServer({
      exec: makeShellPromptExec(),
      stateDir: TEST_DIR,
    });

    const tool = (server as any)._registeredTools["resync_agents"];
    const result = await tool.handler({}, {} as any);
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.diff.evicted).toContain("booting-ghost");
    expect(parsed.count).toBe(0);
  });

  it("resync_agents reports agent-less terminal surfaces as orphaned instead of clean", async () => {
    const server = createServer({
      exec: makeShellPromptExec(),
      stateDir: TEST_DIR,
    });

    const result = await (server as any)._registeredTools["resync_agents"].handler(
      {},
      {} as any,
    );
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.diff.added).toEqual([]);
    expect(parsed.diff.evicted).toEqual([]);
    expect(parsed.diff.mismatches).toEqual([]);
    expect(parsed.diff.orphaned).toEqual(["surface:999"]);
    expect(parsed.count).toBe(0);
  });

  it("resync_agents reports unresolved live-agent surfaces whose title has no repo label", async () => {
    const stateMgr = new StateManager(TEST_DIR);
    const server = createServer({
      exec: makeAmbiguousLiveAgentExec(),
      stateDir: TEST_DIR,
      seatRegistry: REGISTRY_REPAIR_SEATS,
    });

    const result = await (server as any)._registeredTools["resync_agents"].handler(
      {},
      {} as any,
    );
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.diff.repaired).toEqual([]);
    expect(parsed.diff.orphaned).toEqual(["surface:777"]);
    expect(parsed.diff.orphaned_health).toEqual([
      expect.objectContaining({
        surface_id: "surface:777",
        surface_title: "Codex",
        status: "degraded",
        issue_codes: ["auto_discovered_agent"],
        issue_severities: { auto_discovered_agent: "info" },
      }),
    ]);
    expect(
      stateMgr.listStates().some((record) => record.agent_id === "Codex"),
    ).toBe(false);
  });

  it("resync_agents reports orphan lead surfaces as health failures", async () => {
    const server = createServer({
      exec: makeOrphanLeadExec(),
      stateDir: TEST_DIR,
    });

    const result = await (server as any)._registeredTools["resync_agents"].handler(
      {},
      {} as any,
    );
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.diff.orphaned).toEqual(["surface:325"]);
    expect(parsed.diff.health_failures).toEqual([]);
    expect(parsed.diff.orphaned_health).toEqual([
      expect.objectContaining({
        surface_id: "surface:325",
        surface_title: "M1 LEAD VoiceLayer",
        status: "degraded",
        issue_codes: ["missing_managed_lead_agent_id"],
        issue_severities: { missing_managed_lead_agent_id: "degraded" },
      }),
    ]);
  });

  it("resync_agents repairs orphaned launcher surfaces into seat registrations and evicts pending ghosts", async () => {
    const stateMgr = new StateManager(TEST_DIR);
    stateMgr.writeState(
      makeAgentRecord({
        agent_id: "auto-claude-surface-35",
        surface_id: "surface:35",
        workspace_id: "workspace:1",
        repo: "cmuxlayer",
        cli: "claude",
        role: "orchestrator",
        task_summary: "(auto-discovered)",
      }),
    );
    stateMgr.writeState(
      makeAgentRecord({
        agent_id: "brainlayerClaude-pending-1710000000-abcd",
        surface_id: "surface:27",
        workspace_id: "workspace:1",
        repo: "brainlayer",
        cli: "claude",
        role: "orchestrator",
      }),
    );
    stateMgr.writeState(
      makeAgentRecord({
        agent_id: "cmuxlayerCodex-pending-1710000000-dead",
        surface_id: "surface:missing",
        workspace_id: "workspace:1",
        repo: "cmuxlayer",
        cli: "codex",
        role: "worker",
      }),
    );

    const server = createServer({
      exec: makeRegistryRepairExec(),
      stateDir: TEST_DIR,
      seatRegistry: REGISTRY_REPAIR_SEATS,
    });

    const result = await (server as any)._registeredTools["resync_agents"].handler(
      {},
      {} as any,
    );
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.diff.repaired).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          surface_id: "surface:4",
          agent_id: "orcClaude",
          seat_id: "orcClaude",
        }),
        expect.objectContaining({
          surface_id: "surface:35",
          agent_id: "cmuxlayerClaude",
          seat_id: null,
        }),
        expect.objectContaining({
          surface_id: "surface:27",
          agent_id: "brainClaude",
          seat_id: "brainClaude",
        }),
      ]),
    );
    expect(parsed.diff.evicted).toEqual(
      expect.arrayContaining([
        "auto-claude-surface-35",
        "brainlayerClaude-pending-1710000000-abcd",
        "cmuxlayerCodex-pending-1710000000-dead",
      ]),
    );
    expect(parsed.diff.orphaned).toEqual([]);
    expect(stateMgr.readState("auto-claude-surface-35")).toBeNull();
    expect(stateMgr.readState("brainlayerClaude-pending-1710000000-abcd")).toBeNull();
    expect(stateMgr.readState("cmuxlayerCodex-pending-1710000000-dead")).toBeNull();
    expect(stateMgr.readState("cmuxlayerClaude")).toMatchObject({
      agent_id: "cmuxlayerClaude",
      surface_id: "surface:35",
      workspace_id: "workspace:1",
      repo: "cmuxlayer",
      cli: "claude",
      role: "orchestrator",
      launcher_name: "cmuxlayerClaude",
      seat_id: null,
      seat_lane: null,
      seat_role: null,
      seat_identity_status: "unknown",
    });
    expect(
      stateMgr.readState("cmuxlayerClaude")?.seat_identity_error,
    ).toContain("ambiguous seat registry match");
    expect(stateMgr.readState("brainClaude")).toMatchObject({
      agent_id: "brainClaude",
      surface_id: "surface:27",
      role: "orchestrator",
      launcher_name: "brainlayerClaude",
      seat_id: "brainClaude",
    });
  });

  it("resync_agents repairs live coach and golems records in place while evicting only a confirmed dead ghost", async () => {
    const firstObservedAt = Date.parse("2026-07-15T10:00:00.000Z");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(firstObservedAt);
    const stateMgr = new StateManager(TEST_DIR);
    stateMgr.writeState(
      makeAgentRecord({
        agent_id: "coach-drifted-record",
        surface_id: "surface:coach",
        workspace_id: "workspace:1",
        repo: "legacy-coach",
        cli: "codex",
        launcher_name: "legacyCoachCodex",
        role: "worker",
        state: "working",
        cli_session_id: "coach-session-id",
        task_summary: "live coaching session",
        pid: 4242,
        surface_provenance: "unknown",
      }),
    );
    stateMgr.writeState(
      makeAgentRecord({
        agent_id: "golems-drifted-record",
        surface_id: "surface:golems",
        workspace_id: "workspace:1",
        repo: "legacy-golems",
        cli: "claude",
        launcher_name: "legacyGolemsClaude",
        role: "orchestrator",
        state: "working",
        cli_session_id: "golems-session-id",
        task_summary: "live golems work",
        pid: 5252,
        surface_provenance: "unknown",
      }),
    );
    stateMgr.writeState(
      makeAgentRecord({
        agent_id: "coachClaude",
        surface_id: "surface:gone",
        workspace_id: "workspace:1",
        repo: "coach",
        cli: "claude",
        launcher_name: "coachClaude",
        seat_id: "coachClaude",
        seat_lane: "coach",
        seat_role: "lead",
        seat_identity_status: "ok",
        role: "orchestrator",
        state: "error",
        error: "Surface surface:gone disappeared",
        cli_session_id: "coach-ghost-session-id",
        crash_recover: true,
        surface_provenance: "unknown",
      }),
    );
    vi.spyOn(process, "kill").mockImplementation(() => true);
    const exec = makeSeatRecordRepairExec();
    const server = createServer({
      exec,
      stateDir: TEST_DIR,
      seatRegistry: REGISTRY_REPAIR_SEATS,
    });
    const tool = (server as any)._registeredTools["resync_agents"];

    const first = parseResult(await tool.handler({}, {} as any));
    expect(first.ok).toBe(true);
    expect(first.diff.repaired).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent_id: "coach-drifted-record",
          surface_id: "surface:coach",
          seat_id: "coachClaude",
        }),
        expect.objectContaining({
          agent_id: "golems-drifted-record",
          surface_id: "surface:golems",
          seat_id: "golemsCodex",
        }),
      ]),
    );
    expect(first.diff.evicted).not.toEqual(
      expect.arrayContaining([
        "coach-drifted-record",
        "golems-drifted-record",
      ]),
    );
    expect(first.diff.repair_skipped).toEqual([]);
    expect(first.diff.mismatches).toEqual([]);
    expect(first.diff.orphaned).toEqual([]);
    expect(stateMgr.readState("coachClaude")).toMatchObject({
      surface_id: "surface:gone",
      state: "error",
      crash_recover: true,
    });
    expect(stateMgr.readState("golemsCodex")).toBeNull();
    expect(stateMgr.readState("coach-drifted-record")).toMatchObject({
      agent_id: "coach-drifted-record",
      surface_id: "surface:coach",
      repo: "coach",
      cli: "claude",
      launcher_name: "coachClaude",
      role: "orchestrator",
      state: "working",
      cli_session_id: "coach-session-id",
      task_summary: "live coaching session",
      pid: 4242,
    });
    expect(stateMgr.readState("golems-drifted-record")).toMatchObject({
      agent_id: "golems-drifted-record",
      surface_id: "surface:golems",
      repo: "golems",
      cli: "codex",
      launcher_name: "golemsCodex",
      role: "worker",
      state: "working",
      cli_session_id: "golems-session-id",
      task_summary: "live golems work",
      pid: 5252,
    });
    expect(first.diff.evicted).not.toContain("coachClaude");

    const registry = (server as any)._registeredTools[
      "interact"
    ]._engine.getRegistry();
    const originalRepair = registry.repairFromDiscovery.bind(registry);
    let replaceAgentAfterRepair = true;
    vi.spyOn(registry, "repairFromDiscovery").mockImplementation(
      (...args: any[]) => {
        const result = originalRepair(...args);
        if (replaceAgentAfterRepair) {
          replaceAgentAfterRepair = false;
          exec.showCoachShell();
        }
        return result;
      },
    );
    nowSpy.mockReturnValue(
      firstObservedAt + SURFACE_EVICTION_CONFIRMATION_MS + 1,
    );
    const second = parseResult(await tool.handler({}, {} as any));

    expect(second.ok).toBe(true);
    expect(second.diff.evicted).not.toContain("coachClaude");
    expect(stateMgr.readState("coachClaude")).toMatchObject({
      cli_session_id: "coach-ghost-session-id",
      crash_recover: true,
    });

    exec.showCoachAgent();
    const third = parseResult(await tool.handler({}, {} as any));

    expect(third.ok).toBe(true);
    expect(third.diff.evicted).toContain("coachClaude");
    expect(stateMgr.readState("coachClaude")).toBeNull();
    const mutationCommands = new Set([
      "new-split",
      "move-surface",
      "close-surface",
      "send",
      "send-key",
      "paste-text",
    ]);
    const observedMutations = (exec as any).mock.calls.flatMap(
      ([, args]: [unknown, string[]]) =>
        args.filter((arg) => mutationCommands.has(arg)),
    );
    expect(observedMutations).toEqual([]);
  });

  it("resync_agents skips a missing-state seat and continues repairs and ghost eviction", async () => {
    const stateMgr = new StateManager(TEST_DIR);
    stateMgr.writeState(
      makeAgentRecord({
        agent_id: "brainlayerClaude-pending-1710000000-live",
        surface_id: "surface:27",
        workspace_id: "workspace:1",
        repo: "brainlayer",
        cli: "claude",
        role: "orchestrator",
      }),
    );
    stateMgr.writeState(
      makeAgentRecord({
        agent_id: "cmuxlayerCodex-pending-1710000000-dead",
        surface_id: "surface:missing",
        workspace_id: "workspace:1",
        repo: "cmuxlayer",
        cli: "codex",
        role: "worker",
      }),
    );

    const context = createServerContext({
      exec: makeRegistryRepairExec(),
      stateDir: TEST_DIR,
      controlHealthIntervalMs: 0,
    });
    const server = createServer({
      context,
      seatRegistry: REGISTRY_REPAIR_SEATS,
    });

    try {
      await context.lifecycleStartPromise;
      const registry = (server as any)._registeredTools[
        "interact"
      ]._engine.getRegistry();
      registry.set(
        "orcClaude",
        makeAgentRecord({
          agent_id: "orcClaude",
          surface_id: "surface:4",
          workspace_id: "workspace:1",
          repo: "stale-orc-metadata",
          cli: "claude",
          launcher_name: "staleOrcClaude",
          role: "worker",
        }),
      );

      const result = await (server as any)._registeredTools[
        "resync_agents"
      ].handler({}, {} as any);
      const parsed = parseResult(result);

      expect(parsed.ok).toBe(true);
      expect(parsed.diff.repair_skipped).toEqual([
        {
          surface_id: "surface:4",
          surface_title: "🎯 orc-driver",
          agent_id: "orcClaude",
          seat_id: "orcClaude",
          reason: "Agent not found: orcClaude",
        },
      ]);
      expect(parsed.diff.repaired).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            surface_id: "surface:27",
            agent_id: "brainClaude",
            seat_id: "brainClaude",
          }),
        ]),
      );
      expect(parsed.diff.evicted).toContain(
        "cmuxlayerCodex-pending-1710000000-dead",
      );
      expect(stateMgr.readState("brainClaude")).toMatchObject({
        agent_id: "brainClaude",
        surface_id: "surface:27",
      });
    } finally {
      await server.close();
      context.dispose();
    }
  });

  it("resync_agents aborts on a same-text repair failure when state exists", async () => {
    const stateMgr = new StateManager(TEST_DIR);
    const staleRecord = makeAgentRecord({
      agent_id: "orcClaude",
      surface_id: "surface:4",
      workspace_id: "workspace:1",
      repo: "stale-orc-metadata",
      cli: "claude",
      launcher_name: "staleOrcClaude",
      role: "worker",
    });
    stateMgr.writeState(staleRecord);

    const context = createServerContext({
      exec: makeRegistryRepairExec(),
      stateDir: TEST_DIR,
      controlHealthIntervalMs: 0,
    });
    const server = createServer({
      context,
      seatRegistry: REGISTRY_REPAIR_SEATS,
    });

    try {
      await context.lifecycleStartPromise;
      const registry = (server as any)._registeredTools[
        "interact"
      ]._engine.getRegistry();
      registry.set("orcClaude", staleRecord);
      vi.spyOn(context.stateMgr, "updateRecord").mockImplementation(() => {
        throw new Error("Agent not found: orcClaude");
      });

      const result = await (server as any)._registeredTools[
        "resync_agents"
      ].handler({}, {} as any);
      const parsed = parseResult(result);

      expect(parsed).toMatchObject({
        ok: false,
        error: "Agent not found: orcClaude",
      });
      expect(parsed.diff).toBeUndefined();
    } finally {
      await server.close();
      context.dispose();
    }
  });

  it("resync_agents aborts when state presence cannot be resolved", async () => {
    const stateMgr = new StateManager(TEST_DIR);
    const staleRecord = makeAgentRecord({
      agent_id: "orcClaude",
      surface_id: "surface:4",
      workspace_id: "workspace:1",
      repo: "stale-orc-metadata",
      cli: "claude",
      launcher_name: "staleOrcClaude",
      role: "worker",
    });
    stateMgr.writeState(staleRecord);

    const context = createServerContext({
      exec: makeRegistryRepairExec(),
      stateDir: TEST_DIR,
      controlHealthIntervalMs: 0,
    });
    const server = createServer({
      context,
      seatRegistry: REGISTRY_REPAIR_SEATS,
    });

    try {
      await context.lifecycleStartPromise;
      const statePath = join(TEST_DIR, "orcClaude", "state.json");
      rmSync(statePath);
      symlinkSync("state.json", statePath);

      const result = await (server as any)._registeredTools[
        "resync_agents"
      ].handler({}, {} as any);
      const parsed = parseResult(result);

      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("ELOOP");
      expect(parsed.diff).toBeUndefined();
    } finally {
      await server.close();
      context.dispose();
    }
  });

  it("RC4: resync_agents keeps a live pending sibling registered and addressable", async () => {
    const stateMgr = new StateManager(TEST_DIR);
    const siblingId = "brainlayerClaude-pending-1710000000-sibling";
    stateMgr.writeState(
      makeAgentRecord({
        agent_id: siblingId,
        surface_id: "surface:28",
        workspace_id: "workspace:1",
        repo: "brainlayer",
        cli: "claude",
        role: "orchestrator",
        launcher_name: "brainlayerClaude",
        state: "error",
      }),
    );
    const exec = makeRegistryRepairExec({ liveBrainSibling: true });
    const server = createServer({
      exec,
      stateDir: TEST_DIR,
      seatRegistry: REGISTRY_REPAIR_SEATS,
    });

    const result = await (server as any)._registeredTools["resync_agents"].handler(
      {},
      {} as any,
    );
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.diff.evicted).not.toContain(siblingId);
    expect(parsed.diff.orphaned).not.toContain("surface:28");
    expect(stateMgr.readState(siblingId)).toMatchObject({
      agent_id: siblingId,
      surface_id: "surface:28",
    });

    const sendResult = await (server as any)._registeredTools["send_to"].handler(
      {
        agent_id: siblingId,
        text: "still addressable",
        press_enter: false,
      },
      {} as any,
    );
    expect(sendResult.isError).toBeFalsy();
    expect(parseResult(sendResult)).toMatchObject({
      ok: true,
      agent_id: siblingId,
    });
  });

  it("resync_agents clears ambiguous seat labels without guessing a lead identity", async () => {
    const stateMgr = new StateManager(TEST_DIR);
    stateMgr.writeState(
      makeAgentRecord({
        agent_id: "stale-left-worker",
        surface_id: "surface:35",
        workspace_id: "workspace:1",
        repo: "cmuxlayer",
        cli: "codex",
        role: "worker",
        launcher_name: "cmuxlayerCodex",
        task_summary: "stale left-column label",
      }),
    );

    const server = createServer({
      exec: makeRegistryRepairExec(),
      stateDir: TEST_DIR,
      seatRegistry: REGISTRY_REPAIR_SEATS,
    });

    const resyncResult = await (server as any)._registeredTools[
      "resync_agents"
    ].handler({}, {} as any);
    const resynced = parseResult(resyncResult);
    expect(resynced.ok).toBe(true);
    expect(resynced.diff.repaired).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent_id: "stale-left-worker",
          surface_id: "surface:35",
          seat_id: null,
        }),
      ]),
    );

    const repaired = stateMgr.readState("stale-left-worker");
    expect(repaired).toMatchObject({
      agent_id: "stale-left-worker",
      surface_id: "surface:35",
      repo: "cmuxlayer",
      cli: "claude",
      role: "orchestrator",
      launcher_name: "cmuxlayerClaude",
      seat_identity_status: "unknown",
    });
    expect(repaired?.seat_id ?? null).toBeNull();
    expect(repaired?.seat_lane ?? null).toBeNull();
    expect(repaired?.seat_role ?? null).toBeNull();
    expect(repaired?.seat_identity_error).toContain(
      "ambiguous seat registry match",
    );

    const stateResult = await (server as any)._registeredTools[
      "get_agent_state"
    ].handler({ agent_id: "stale-left-worker" }, {} as any);
    const parsedState = parseResult(stateResult);
    expect(parsedState.health.issue_codes).not.toContain(
      "worker_in_leftmost_column",
    );
  }, 10_000);

  it("resync_agents evicts registry-only phantom agents instead of failing", async () => {
    const firstObservedAt = Date.parse("2026-07-14T07:00:00.000Z");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(firstObservedAt);
    const context = createServerContext({
      exec: makeDiscoveryExec(),
      stateDir: TEST_DIR,
      controlHealthIntervalMs: 0,
    });
    const server = createServer({
      context,
    });
    await context.lifecycleStartPromise;

    const engine = (server as any)._registeredTools["interact"]._engine;
    const registry = engine.getRegistry();
    registry.set("gpt-5.4-mcplayer-1776645230-hmep", {
      agent_id: "gpt-5.4-mcplayer-1776645230-hmep",
      surface_id: "surface:phantom",
      surface_observer_id: TEST_OBSERVER_OWNER,
      workspace_id: "workspace:1",
      state: "ready",
      repo: "mcplayer",
      model: "gpt-5.4",
      cli: "codex",
      cli_session_id: null,
      task_summary: "phantom",
      pid: null,
      version: 1,
      created_at: "2026-04-21T00:00:00.000Z",
      updated_at: "2026-04-21T00:00:00.000Z",
      error: null,
      parent_agent_id: null,
      spawn_depth: 0,
      deletion_intent: false,
      quality: "unknown",
      max_cost_per_agent: null,
      crash_recover: false,
      respawn_attempts: 0,
      user_killed: false,
    });

    const tool = (server as any)._registeredTools["resync_agents"];
    const firstResult = parseResult(await tool.handler({}, {} as any));

    expect(firstResult.ok).toBe(true);
    expect(firstResult.diff.evicted).not.toContain(
      "gpt-5.4-mcplayer-1776645230-hmep",
    );
    expect(
      registry.get("gpt-5.4-mcplayer-1776645230-hmep")?.agent_id,
    ).toBe("gpt-5.4-mcplayer-1776645230-hmep");

    nowSpy.mockReturnValue(
      firstObservedAt + SURFACE_EVICTION_CONFIRMATION_MS + 1,
    );
    const parsed = parseResult(await tool.handler({}, {} as any));

    expect(parsed.ok).toBe(true);
    expect(parsed.diff.evicted).toContain("gpt-5.4-mcplayer-1776645230-hmep");
    expect(parsed.count).toBe(1);
  });
});
