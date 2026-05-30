import { homedir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CmuxClient } from "./cmux-client.js";
import type { CmuxSocketClient } from "./cmux-socket-client.js";
import { AgentEngine } from "./agent-engine.js";
import { AgentRegistry } from "./agent-registry.js";
import { StateManager } from "./state-manager.js";
import { parseScreen } from "./screen-parser.js";
import { sanitizeTerminalInput } from "./sanitize.js";
import type {
  AppServerBridgeRuntime,
  BridgeScreenSnapshot,
  BridgeThread,
} from "./app-server-bridge.js";

const SEND_INPUT_CHUNK_THRESHOLD = 500;
const SEND_INPUT_CHUNK_DELAY_MS = 5;
const THREAD_READY_TIMEOUT_MS = 30_000;
const THREAD_READY_POLL_MS = 250;

type CmuxLikeClient = CmuxClient | CmuxSocketClient;

function chunkTerminalInput(text: string, chunkSize: number): string[] {
  if (!text || text.length <= chunkSize) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > chunkSize) {
    const newlineIndex = remaining.lastIndexOf("\n", chunkSize);
    const splitAt = newlineIndex >= 0 ? newlineIndex + 1 : chunkSize;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
      try {
        const workspaces = await this.client.listWorkspaces();
        const panesByWorkspace = await Promise.all(
          workspaces.workspaces.map(async (ws) => ({
            ref: ws.ref,
            panes: await this.client.listPanes({ workspace: ws.ref }),
          })),
        );
        const surfaceGroups = await Promise.all(
          panesByWorkspace.flatMap(({ ref, panes }) =>
            panes.panes.map((pane) =>
              this.client.listPaneSurfaces({ workspace: ref, pane: pane.ref }),
            ),
          ),
        );
        return surfaceGroups.flatMap((group) => group.surfaces);
      } catch {
        return [];
      }
    };

    this.registry = new AgentRegistry(this.stateMgr, surfaceProvider);
    this.engine = new AgentEngine(this.stateMgr, this.registry, {
      log: async () => {},
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
      notifyLifecycleEvent: async () => {},
    });
  }

  async initialize(): Promise<void> {
    await this.registry.reconstitute();
    this.engine.enableStartupPurge();
    this.engine.startSweep(5000);
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
    const sanitizedText = sanitizeTerminalInput(input.text);
    const chunks = chunkTerminalInput(sanitizedText, SEND_INPUT_CHUNK_THRESHOLD);

    await this.withSurfaceWrite(route.surface_id, async () => {
      for (const [index, chunk] of chunks.entries()) {
        await this.client.send(route.surface_id, chunk, {});
        if (index < chunks.length - 1) {
          await delay(SEND_INPUT_CHUNK_DELAY_MS);
        }
      }
      await delay(50);
      await this.client.sendKey(route.surface_id, "return", {});
    });
  }

  async interruptTurn(threadId: string): Promise<void> {
    const route = this.engine.resolveAgentRoute(threadId);
    await this.withSurfaceWrite(route.surface_id, () =>
      this.client.sendKey(route.surface_id, "c-c", {}),
    );
  }

  async readScreen(threadId: string): Promise<BridgeScreenSnapshot> {
    const route = this.engine.resolveAgentRoute(threadId);
    const screen = await this.client.readScreen(route.surface_id, {
      lines: 40,
      scrollback: true,
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
