import { homedir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CmuxClient } from "./cmux-client.js";
import type { CmuxSocketClient } from "./cmux-socket-client.js";
import { AgentEngine, resolveSweepTiming } from "./agent-engine.js";
import { AgentRegistry } from "./agent-registry.js";
import { StateManager } from "./state-manager.js";
import { parseScreen } from "./screen-parser.js";
import { sanitizeTerminalInput } from "./sanitize.js";
import { matchReadyPattern } from "./pattern-registry.js";
import { partitionPaneSurfacesByMembership } from "./pane-surfaces.js";
import type {
  AppServerBridgeRuntime,
  BridgeScreenSnapshot,
  BridgeThread,
} from "./app-server-bridge.js";

const SEND_INPUT_CHUNK_THRESHOLD = 500;
const SEND_INPUT_CHUNK_DELAY_MS = 5;
const THREAD_READY_TIMEOUT_MS = 30_000;
const THREAD_READY_POLL_MS = 250;
const LAUNCH_SHELL_READY_TIMEOUT_MS = 10_000;
const LAUNCH_SHELL_READY_POLL_MS = 100;

type CmuxLikeClient = CmuxClient | CmuxSocketClient;

function chunkTerminalInput(text: string, chunkSize: number): string[] {
  const rawChunks: string[] = [];
  let remaining = text;

  while (remaining.length > chunkSize) {
    const newlineIndex = remaining.lastIndexOf("\n", chunkSize);
    const splitAt = newlineIndex >= 0 ? newlineIndex + 1 : chunkSize;
    rawChunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  if (remaining.length > 0) {
    rawChunks.push(remaining);
  }

  const chunks: string[] = [];
  let whitespaceCarry = "";
  for (const chunk of rawChunks) {
    if (chunk.trim().length === 0) {
      whitespaceCarry += chunk;
      continue;
    }

    if (!whitespaceCarry) {
      chunks.push(chunk);
      continue;
    }

    let candidate = whitespaceCarry + chunk;
    whitespaceCarry = "";
    while (candidate.length > chunkSize) {
      const firstTextIndex = candidate.search(/\S/);
      const splitAt =
        firstTextIndex >= chunkSize ? firstTextIndex + 1 : chunkSize;
      chunks.push(candidate.slice(0, splitAt));
      candidate = candidate.slice(splitAt);
    }
    if (candidate.trim().length === 0) {
      whitespaceCarry = candidate;
    } else {
      chunks.push(candidate);
    }
  }

  if (whitespaceCarry && chunks.length > 0) {
    chunks[chunks.length - 1] += whitespaceCarry;
  }

  return chunks;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function matchesShellPrompt(text: string): boolean {
  return /(?:^|\n)[^\n]*[$%#]\s*$/.test(text);
}

function deriveRepoFromCwd(cwd: string): string {
  const repo = basename(cwd.trim());
  if (!repo || repo === "." || repo === "/" || repo === "..") {
    throw new Error(`Cannot derive repo name from cwd: ${cwd}`);
  }
  return repo;
}

function toBridgeThread(
  cwd: string,
  createdAt: number,
  agent: {
    agent_id: string;
    model: string;
    cli_session_id: string | null;
  },
): BridgeThread {
  return {
    threadId: agent.agent_id,
    agentId: agent.agent_id,
    cwd,
    model: agent.model,
    createdAt,
    sessionId: agent.cli_session_id,
  };
}

export interface CmuxAppServerRuntimeOptions {
  client: CmuxLikeClient;
  stateDir?: string;
}

export class CmuxAppServerRuntime implements AppServerBridgeRuntime {
  private client: CmuxLikeClient;
  private stateMgr: StateManager;
  private registry: AgentRegistry;
  private engine: AgentEngine;
  private activeSurfaceWrites = new Map<string, string>();
  private threadCwds = new Map<string, string>();

  constructor(opts: CmuxAppServerRuntimeOptions) {
    this.client = opts.client;
    this.stateMgr = new StateManager(
      opts.stateDir ?? join(homedir(), ".local", "state", "cmux-agents"),
    );

    const surfaceProvider = async () => {
      const workspaces = await this.client.listWorkspaces();
      const panesByWorkspace = await Promise.all(
        workspaces.workspaces.map(async (ws) => ({
          ref: ws.ref,
          panes: await this.client.listPanes({ workspace: ws.ref }),
        })),
      );
      const surfaceGroupsByWorkspace = await Promise.all(
        panesByWorkspace.map(async ({ ref, panes }) => {
          const rawGroups = await Promise.all(
            panes.panes.map((pane) =>
              this.client.listPaneSurfaces({ workspace: ref, pane: pane.ref }),
            ),
          );
          return partitionPaneSurfacesByMembership(panes.panes, rawGroups, {
            workspace_ref: panes.workspace_ref ?? ref,
            window_ref: panes.window_ref,
          });
        }),
      );
      const surfaceGroups = surfaceGroupsByWorkspace.flat();
      return surfaceGroups.flatMap((group) =>
        group.surfaces.map((surface) => ({
          ...surface,
          workspace_ref: group.workspace_ref,
          pane_ref: group.pane_ref,
        })),
      );
    };

    this.registry = new AgentRegistry(this.stateMgr, surfaceProvider);
    this.engine = new AgentEngine(this.stateMgr, this.registry, {
      log: async () => {},
      listWorkspaces: () => this.client.listWorkspaces(),
      setStatus: async () => {},
      clearStatus: async () => {},
      readScreen: (surface, readOpts) => this.client.readScreen(surface, readOpts),
      send: (surface, text, sendOpts) =>
        this.withSurfaceWrite(surface, () => this.client.send(surface, text, sendOpts)),
      sendKey: (surface, key, keyOpts) =>
        this.withSurfaceWrite(surface, () => this.client.sendKey(surface, key, keyOpts)),
      setProgress: async () => {},
      newSplit: (direction, splitOpts) => this.client.newSplit(direction, splitOpts),
      newSurface: (surfaceOpts) => this.client.newSurface(surfaceOpts),
      selectWorkspace: (workspace) => this.client.selectWorkspace(workspace),
      listPanes: (paneOpts) => this.client.listPanes(paneOpts),
      listPaneSurfaces: (surfaceOpts) => this.client.listPaneSurfaces(surfaceOpts),
      closeSurface: (surface, closeOpts) =>
        this.withSurfaceWrite(surface, () =>
          this.client.closeSurface(surface, closeOpts),
        ),
      notify: (notifyOpts) => this.client.notify(notifyOpts),
      notifyLifecycleEvent: async () => {},
    }, {
      launchCommandSender: async ({ surface, workspace, command }) => {
        await this.waitForShellReady(surface, workspace);
        await this.sendCommand(surface, command, workspace);
      },
    });
  }

  async initialize(): Promise<void> {
    await this.registry.reconstitute();
    this.engine.enableStartupPurge();
    this.engine.startSweep(resolveSweepTiming());
  }

  dispose(): void {
    this.engine.dispose();
  }

  async startThread(input: {
    cwd: string;
    model?: string;
  }): Promise<BridgeThread> {
    const repo = deriveRepoFromCwd(input.cwd);
    const createdAt = Math.floor(Date.now() / 1000);
    const result = await this.engine.spawnAgent({
      repo,
      model: input.model ?? "codex",
      cli: "codex",
      prompt: `App Server bridge session for ${repo}`,
    });

    this.threadCwds.set(result.agent_id, input.cwd);
    await this.waitForCodexPrompt(result.agent_id);

    const agent = this.engine.getAgentState(result.agent_id);
    if (!agent) {
      throw new Error(`Agent disappeared after spawn: ${result.agent_id}`);
    }

    return toBridgeThread(input.cwd, createdAt, agent);
  }

  async readThread(threadId: string): Promise<BridgeThread | null> {
    const agent = this.engine.getAgentState(threadId);
    if (!agent) {
      return null;
    }

    const cwd = this.threadCwds.get(threadId) ?? join(homedir(), "Gits", agent.repo);
    const createdAt = Math.floor(new Date(agent.created_at).getTime() / 1000);
    return toBridgeThread(cwd, createdAt, agent);
  }

  async sendTurn(input: {
    threadId: string;
    text: string;
  }): Promise<void> {
    const route = this.engine.resolveAgentRoute(input.threadId);
    await this.sendCommand(
      route.surface_id,
      input.text,
      route.workspace_id ?? undefined,
    );
  }

  private async sendCommand(
    surface: string,
    text: string,
    workspace?: string,
  ): Promise<void> {
    const sanitizedText = sanitizeTerminalInput(text);
    const chunks = chunkTerminalInput(sanitizedText, SEND_INPUT_CHUNK_THRESHOLD);

    await this.withSurfaceWrite(surface, async () => {
      for (const [index, chunk] of chunks.entries()) {
        await this.client.send(surface, chunk, { workspace });
        if (index < chunks.length - 1) {
          await delay(SEND_INPUT_CHUNK_DELAY_MS);
        }
      }
      await delay(50);
      await this.client.sendKey(surface, "return", { workspace });
    });
  }

  async interruptTurn(threadId: string): Promise<void> {
    const route = this.engine.resolveAgentRoute(threadId);
    await this.withSurfaceWrite(route.surface_id, () =>
      this.client.sendKey(route.surface_id, "c-c", {
        workspace: route.workspace_id ?? undefined,
      }),
    );
  }

  async readScreen(threadId: string): Promise<BridgeScreenSnapshot> {
    const route = this.engine.resolveAgentRoute(threadId);
    const screen = await this.client.readScreen(route.surface_id, {
      workspace: route.workspace_id ?? undefined,
      lines: 40,
    });
    const text = typeof screen === "string" ? screen : (screen.text ?? "");
    const parsed = parseScreen(text);

    return {
      text,
      status: parsed.status,
      agentType: parsed.agent_type,
    };
  }

  private async waitForCodexPrompt(threadId: string): Promise<void> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < THREAD_READY_TIMEOUT_MS) {
      const snapshot = await this.readScreen(threadId);
      if (
        snapshot.agentType === "codex" &&
        (snapshot.status === "idle" || snapshot.status === "working")
      ) {
        return;
      }
      await delay(THREAD_READY_POLL_MS);
    }

    throw new Error(`Timed out waiting for Codex prompt on thread ${threadId}`);
  }

  private async waitForShellReady(
    surface: string,
    workspace?: string,
  ): Promise<void> {
    const startedAt = Date.now();
    let lastText = "";

    while (Date.now() - startedAt < LAUNCH_SHELL_READY_TIMEOUT_MS) {
      try {
        const screen = await this.client.readScreen(surface, {
          workspace,
          lines: 30,
          scrollback: false,
        });
        const text = typeof screen === "string" ? screen : (screen.text ?? "");
        lastText = text;
        if (matchesShellPrompt(text) || matchReadyPattern("codex", text).matched) {
          return;
        }
      } catch (error) {
        lastText = error instanceof Error ? error.message : String(error);
      }

      const remaining = LAUNCH_SHELL_READY_TIMEOUT_MS - (Date.now() - startedAt);
      if (remaining <= 0) {
        break;
      }
      await delay(Math.min(LAUNCH_SHELL_READY_POLL_MS, remaining));
    }

    throw new Error(
      `Timed out waiting for shell readiness on ${surface}: ${lastText}`,
    );
  }

  private async withSurfaceWrite<T>(
    surface: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const owner = `app-server:${randomUUID()}`;
    const existing = this.activeSurfaceWrites.get(surface);
    if (existing) {
      throw new Error(`surface ${surface} is busy`);
    }

    this.activeSurfaceWrites.set(surface, owner);
    try {
      return await fn();
    } finally {
      if (this.activeSurfaceWrites.get(surface) === owner) {
        this.activeSurfaceWrites.delete(surface);
      }
    }
  }
}
