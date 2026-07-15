import { homedir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CmuxClient } from "./cmux-client.js";
import type { CmuxSocketClient } from "./cmux-socket-client.js";
import { AgentEngine, resolveSweepTiming } from "./agent-engine.js";
import type { AgentRoute } from "./agent-types.js";
import { createDefaultCloseForensicsRunner } from "./close-forensics.js";
import { drainOutbox, httpDeliver } from "./outbox-drainer.js";
import {
  defaultMonitorRegistryPath,
  httpNotifyMonitorDeadman,
} from "./monitor-registry.js";
import { AgentRegistry } from "./agent-registry.js";
import {
  deriveCmuxObserverEpoch,
  deriveCmuxObserverOwnerId,
} from "./cmux-observer-identity.js";
import { AgentDiscovery } from "./agent-discovery.js";
import { StateManager } from "./state-manager.js";
import { parseScreen } from "./screen-parser.js";
import { sanitizeTerminalInput } from "./sanitize.js";
import { matchReadyPattern } from "./pattern-registry.js";
import { assertMutationAllowed } from "./mode-policy.js";
import { findWorkspaceRefForRepo } from "./repo-workspace.js";
import { partitionPaneSurfacesByMembership } from "./pane-surfaces.js";
import {
  captureSurfaceObserverEpoch,
  enrichSurfaceIdsFromPanes,
  isSurfaceObserverEpochCurrent,
  type SurfaceObserverEpoch,
} from "./surface-topology.js";
import {
  FleetSidebarPublisher,
  type FleetSidebarPublisherLike,
} from "./fleet-sidebar.js";
import type {
  AppServerBridgeRuntime,
  BridgeScreenSnapshot,
  BridgeThread,
} from "./app-server-bridge.js";
import type {
  CmuxPane,
  CmuxPaneSurfaces,
  CmuxStatusEntry,
  ControlMode,
} from "./types.js";

const SEND_INPUT_CHUNK_THRESHOLD = 500;
const SEND_INPUT_CHUNK_DELAY_MS = 5;
const THREAD_READY_TIMEOUT_MS = 30_000;
const THREAD_READY_POLL_MS = 250;
const LAUNCH_SHELL_READY_TIMEOUT_MS = 10_000;
const LAUNCH_SHELL_READY_POLL_MS = 100;

type CmuxLikeClient = CmuxClient | CmuxSocketClient;

function controlModeFromStatusEntries(entries: unknown): ControlMode {
  if (!Array.isArray(entries)) return "autonomous";
  const entry = entries.find((candidate): candidate is CmuxStatusEntry => {
    if (typeof candidate !== "object" || candidate === null) return false;
    return (candidate as Partial<CmuxStatusEntry>).key === "mode.control";
  });
  return entry?.value === "manual" || entry?.value === "autonomous"
    ? entry.value
    : "autonomous";
}

function assertCompletePaneSurfaceEnumeration(
  panes: readonly CmuxPane[],
  groups: readonly CmuxPaneSurfaces[],
  workspace: string,
): void {
  for (const pane of panes) {
    const expectedRefs = new Set(pane.surface_refs);
    const observed = groups.find((group) => group.pane_ref === pane.ref);
    const observedRefs = observed?.surfaces.map((surface) => surface.ref) ?? [];
    const observedRefSet = new Set(observedRefs);
    if (
      pane.surface_count !== pane.surface_refs.length ||
      expectedRefs.size !== pane.surface_refs.length ||
      observedRefSet.size !== observedRefs.length ||
      observedRefSet.size !== expectedRefs.size ||
      [...expectedRefs].some((surfaceRef) => !observedRefSet.has(surfaceRef))
    ) {
      throw new Error(
        `Incomplete app-server surface enumeration for ${workspace}/${pane.ref}`,
      );
    }
  }
}

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
  fleetSidebarPublisher?: FleetSidebarPublisherLike;
  surfaceObserverOwnerIdProvider?: () => string | null | undefined;
  surfaceObserverEpochProvider?: () => string | null | undefined;
}

export class CmuxAppServerRuntime implements AppServerBridgeRuntime {
  private client: CmuxLikeClient;
  private stateMgr: StateManager;
  private registry: AgentRegistry;
  private engine: AgentEngine;
  private discovery: AgentDiscovery;
  private observerOwnerIdProvider: () => string | null | undefined;
  private observerEpochProvider: () => string | null | undefined;
  private activeSurfaceWrites = new Map<string, string>();
  private threadCwds = new Map<string, string>();

  constructor(opts: CmuxAppServerRuntimeOptions) {
    this.client = opts.client;
    this.observerOwnerIdProvider =
      opts.surfaceObserverOwnerIdProvider ??
      (() => deriveCmuxObserverOwnerId(this.client));
    this.observerEpochProvider =
      opts.surfaceObserverEpochProvider ??
      (() => deriveCmuxObserverEpoch(this.client));
    this.stateMgr = new StateManager(
      opts.stateDir ?? join(homedir(), ".local", "state", "cmux-agents"),
    );

    const surfaceProvider = async () => {
      const observerEpoch = this.captureSurfaceObserverEpoch();
      this.assertSurfaceObserverEpochCurrent(
        observerEpoch,
        "app-server surface enumeration",
      );
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
          const groups = partitionPaneSurfacesByMembership(panes.panes, rawGroups, {
            workspace_ref: panes.workspace_ref ?? ref,
            window_ref: panes.window_ref,
          });
          assertCompletePaneSurfaceEnumeration(panes.panes, groups, ref);
          return groups;
        }),
      );
      const surfaceGroups = surfaceGroupsByWorkspace.flat();
      const surfaces = enrichSurfaceIdsFromPanes(
        panesByWorkspace,
        surfaceGroups,
      );
      this.assertSurfaceObserverEpochCurrent(
        observerEpoch,
        "app-server surface enumeration",
      );
      return surfaces;
    };

    this.registry = new AgentRegistry(this.stateMgr, surfaceProvider, {
      observerIdProvider: () => this.getSurfaceObserverOwnerId(),
      observerEpochProvider: () => this.getSurfaceObserverEpoch(),
    });
    this.discovery = new AgentDiscovery({
      observerIdProvider: () => this.getSurfaceObserverEpoch(),
      listSurfaces: surfaceProvider,
      readScreen: (surface, readOpts) =>
        this.client.readScreen(surface, readOpts),
    });
    this.engine = new AgentEngine(
      this.stateMgr,
      this.registry,
      {
        log: async () => {},
        listWorkspaces: () => this.client.listWorkspaces(),
        setStatus: async () => {},
        setStatuses: async () => {},
        clearStatus: async () => {},
        readScreen: (surface, readOpts) =>
          this.client.readScreen(surface, readOpts),
        send: (surface, text, sendOpts) =>
          this.runWorkspaceMutation("send_command", sendOpts?.workspace, () =>
            this.withSurfaceWrite(surface, () =>
              this.client.send(surface, text, sendOpts),
            ),
          ),
        sendKey: (surface, key, keyOpts) =>
          this.runWorkspaceMutation("send_key", keyOpts?.workspace, () =>
            this.withSurfaceWrite(surface, () =>
              this.client.sendKey(surface, key, keyOpts),
            ),
          ),
        setProgress: async () => {},
        clearProgress: async () => {},
        newSplit: (direction, splitOpts) => {
          const {
            beforeMutation,
            stableSurfaceIdentity,
            ...clientOpts
          } = splitOpts ?? {};
          return this.runWorkspaceMutation(
            "new_split",
            splitOpts?.workspace,
            () => {
              const mutate = async () => {
                await beforeMutation?.();
                return this.client.newSplit(direction, clientOpts);
              };
              return splitOpts?.surface
                ? this.withSurfaceWrite(
                    stableSurfaceIdentity
                      ? `uuid:${stableSurfaceIdentity.toLowerCase()}`
                      : splitOpts.surface,
                    mutate,
                  )
                : mutate();
            },
          );
        },
        newSurface: (surfaceOpts) =>
          this.runWorkspaceMutation("new_surface", surfaceOpts?.workspace, () =>
            this.client.newSurface(surfaceOpts),
          ),
        renameTab: (surface, title, renameOpts) =>
          this.runWorkspaceMutation("rename_tab", renameOpts?.workspace, () =>
            this.client.renameTab(surface, title, renameOpts),
          ),
        selectWorkspace: (workspace) =>
          this.runWorkspaceMutation("select_workspace", workspace, () =>
            this.client.selectWorkspace(workspace),
          ),
        listPanes: (paneOpts) => this.client.listPanes(paneOpts),
        listPaneSurfaces: (surfaceOpts) =>
          this.client.listPaneSurfaces(surfaceOpts),
        closeSurface: (surface, closeOpts) => {
          const {
            beforeMutation,
            stableSurfaceIdentity,
            ...clientOpts
          } = closeOpts ?? {};
          return this.runWorkspaceMutation(
            "close_surface",
            closeOpts?.workspace,
            () =>
              this.withSurfaceWrite(
                stableSurfaceIdentity
                  ? `uuid:${stableSurfaceIdentity.toLowerCase()}`
                  : surface,
                async () => {
                  await beforeMutation?.();
                  return this.client.closeSurface(surface, clientOpts);
                },
              ),
          );
        },
        moveSurface: (moveOpts) => {
          const {
            beforeMutation,
            stableSurfaceIdentity,
            ...clientOpts
          } = moveOpts;
          return this.runWorkspaceMutation(
            "move_surface",
            moveOpts.workspace,
            () =>
              this.withSurfaceWrite(
                stableSurfaceIdentity
                  ? `uuid:${stableSurfaceIdentity.toLowerCase()}`
                  : moveOpts.surface,
                async () => {
                  await beforeMutation?.();
                  return this.client.moveSurface(clientOpts);
                },
              ),
          );
        },
        notify: (notifyOpts) => this.client.notify(notifyOpts),
        notifyLifecycleEvent: async () => {},
      },
      {
        launchCommandSender: async ({ surface, workspace, command }) => {
          const agentId = this.findLaunchingAgentId(surface, workspace);
          if (!agentId) {
            throw new Error(
              `Cannot bind app-server launch surface ${surface} to one booting agent`,
            );
          }
          await this.waitForAgentShellReady(agentId);
          await this.sendAgentCommand(agentId, command);
        },
        outboxDrain: () => drainOutbox({ deliver: httpDeliver }),
        monitorRegistryPath: defaultMonitorRegistryPath(),
        monitorRegistryNotify: httpNotifyMonitorDeadman,
        closeForensicsRunner: createDefaultCloseForensicsRunner({
          stateMgr: this.stateMgr,
          listSurfacesForRefMap: surfaceProvider,
        }),
        fleetSidebarPublisher:
          opts.fleetSidebarPublisher ?? new FleetSidebarPublisher(),
      },
    );
  }

  async initialize(): Promise<void> {
    await this.engine.initialize(this.discovery);
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
    const observerEpoch = this.captureSurfaceObserverEpoch();
    this.assertSurfaceObserverEpochCurrent(
      observerEpoch,
      "app-server thread start",
    );
    const workspaces = await this.client.listWorkspaces();
    this.assertSurfaceObserverEpochCurrent(
      observerEpoch,
      "app-server thread start",
    );
    const workspace =
      findWorkspaceRefForRepo(workspaces.workspaces, repo) ??
      workspaces.workspaces.find((candidate) => candidate.selected)?.ref;
    await this.assertWorkspaceMutationAllowed("spawn_agent", workspace);
    this.assertSurfaceObserverEpochCurrent(
      observerEpoch,
      "app-server thread start",
    );
    const result = await this.engine.spawnAgent({
      repo,
      model: input.model ?? "codex",
      cli: "codex",
      prompt: `App Server bridge session for ${repo}`,
      ...(workspace ? { workspace } : {}),
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

    const cwd =
      this.threadCwds.get(threadId) ?? join(homedir(), "Gits", agent.repo);
    const createdAt = Math.floor(new Date(agent.created_at).getTime() / 1000);
    return toBridgeThread(cwd, createdAt, agent);
  }

  async sendTurn(input: { threadId: string; text: string }): Promise<void> {
    await this.sendAgentCommand(input.threadId, input.text);
  }

  private async sendAgentCommand(agentId: string, text: string): Promise<void> {
    const sanitizedText = sanitizeTerminalInput(text);
    const chunks = chunkTerminalInput(
      sanitizedText,
      SEND_INPUT_CHUNK_THRESHOLD,
    );

    const lockedRoute = await this.resolveFreshMutationRoute(
      agentId,
      "send_command",
    );
    const resolveLockedRoute = async (toolName: string) => {
      const route = await this.resolveFreshMutationRoute(agentId, toolName);
      const lockedUuid = lockedRoute.surface_uuid?.toLowerCase() ?? null;
      const routeUuid = route.surface_uuid?.toLowerCase() ?? null;
      const bindingChanged = lockedUuid
        ? routeUuid !== lockedUuid
        : route.surface_id !== lockedRoute.surface_id ||
          (route.workspace_id ?? null) !== (lockedRoute.workspace_id ?? null);
      if (bindingChanged) {
        throw new Error(
          `Agent ${agentId} changed surface binding during ${toolName}; ` +
            "refusing to continue outside the locked surface.",
        );
      }
      return route;
    };

    const lockKey = lockedRoute.surface_uuid
      ? `uuid:${lockedRoute.surface_uuid.toLowerCase()}`
      : lockedRoute.surface_id;
    await this.withSurfaceWrite(lockKey, async () => {
      await resolveLockedRoute("send_command");
      for (const [index, chunk] of chunks.entries()) {
        const route = await resolveLockedRoute("send_command");
        await this.client.send(route.surface_id, chunk, {
          workspace: route.workspace_id ?? undefined,
        });
        if (index < chunks.length - 1) {
          await delay(SEND_INPUT_CHUNK_DELAY_MS);
        }
      }
      await delay(50);
      const route = await resolveLockedRoute("send_key");
      await this.client.sendKey(route.surface_id, "return", {
        workspace: route.workspace_id ?? undefined,
      });
      this.engine.markAgentWorking(agentId);
    });
  }

  async interruptTurn(threadId: string): Promise<void> {
    const lockedRoute = await this.resolveFreshMutationRoute(
      threadId,
      "send_key",
    );
    const lockKey = lockedRoute.surface_uuid
      ? `uuid:${lockedRoute.surface_uuid.toLowerCase()}`
      : lockedRoute.surface_id;
    await this.withSurfaceWrite(lockKey, async () => {
      const route = await this.resolveFreshMutationRoute(threadId, "send_key");
      if (
        route.surface_id !== lockedRoute.surface_id ||
        (route.surface_uuid ?? null) !== (lockedRoute.surface_uuid ?? null)
      ) {
        throw new Error(
          `Agent ${threadId} changed surface binding during interrupt; refusing stale surface I/O.`,
        );
      }
      await this.client.sendKey(route.surface_id, "c-c", {
        workspace: route.workspace_id ?? undefined,
      });
    });
  }

  async readScreen(threadId: string): Promise<BridgeScreenSnapshot> {
    const route = await this.engine.resolveAgentIoRoute(threadId);
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

  private async waitForAgentShellReady(agentId: string): Promise<void> {
    const startedAt = Date.now();
    let lastText = "";
    let lastSurface = agentId;

    while (Date.now() - startedAt < LAUNCH_SHELL_READY_TIMEOUT_MS) {
      try {
        const route = await this.engine.resolveAgentIoRoute(agentId);
        lastSurface = route.surface_id;
        const screen = await this.client.readScreen(route.surface_id, {
          workspace: route.workspace_id ?? undefined,
          lines: 30,
          scrollback: false,
        });
        const text = typeof screen === "string" ? screen : (screen.text ?? "");
        lastText = text;
        if (
          matchesShellPrompt(text) ||
          matchReadyPattern("codex", text).matched
        ) {
          return;
        }
      } catch (error) {
        lastText = error instanceof Error ? error.message : String(error);
      }

      const remaining =
        LAUNCH_SHELL_READY_TIMEOUT_MS - (Date.now() - startedAt);
      if (remaining <= 0) {
        break;
      }
      await delay(Math.min(LAUNCH_SHELL_READY_POLL_MS, remaining));
    }

    throw new Error(
      `Timed out waiting for shell readiness on ${lastSurface}: ${lastText}`,
    );
  }

  private captureSurfaceObserverEpoch(): SurfaceObserverEpoch {
    return captureSurfaceObserverEpoch(() => this.getSurfaceObserverEpoch());
  }

  private assertSurfaceObserverEpochCurrent(
    observerEpoch: SurfaceObserverEpoch,
    operation: string,
  ): void {
    const provider = () => this.getSurfaceObserverEpoch();
    if (isSurfaceObserverEpochCurrent(observerEpoch, provider)) return;
    const currentObserverEpoch = captureSurfaceObserverEpoch(provider);
    throw new Error(
      `Surface observer changed or became unavailable during ${operation} ` +
        `(${observerEpoch ?? "unknown"} -> ${currentObserverEpoch ?? "unknown"}); ` +
        `refusing to mutate a different cmux instance.`,
    );
  }

  private getSurfaceObserverOwnerId(): string | null {
    try {
      return this.observerOwnerIdProvider()?.trim() || null;
    } catch {
      return null;
    }
  }

  private getSurfaceObserverEpoch(): string | null {
    try {
      return this.observerEpochProvider()?.trim() || null;
    } catch {
      return null;
    }
  }

  private async assertWorkspaceMutationAllowed(
    toolName: string,
    workspace?: string | null,
  ): Promise<void> {
    let entries: CmuxStatusEntry[];
    try {
      entries = await this.client.listStatus(
        workspace ? { workspace } : undefined,
      );
    } catch {
      // Match the MCP server's compatibility behavior: older cmux builds may
      // not expose status listing, so only an observed manual mode can block.
      return;
    }
    assertMutationAllowed(toolName, controlModeFromStatusEntries(entries));
  }

  private async runWorkspaceMutation<T>(
    toolName: string,
    workspace: string | null | undefined,
    mutate: () => Promise<T>,
  ): Promise<T> {
    const observerEpoch = this.captureSurfaceObserverEpoch();
    this.assertSurfaceObserverEpochCurrent(observerEpoch, toolName);
    await this.assertWorkspaceMutationAllowed(toolName, workspace);
    this.assertSurfaceObserverEpochCurrent(observerEpoch, toolName);
    return mutate();
  }

  private async resolveFreshMutationRoute(
    agentId: string,
    toolName: string,
  ): Promise<AgentRoute> {
    const observerEpoch = this.captureSurfaceObserverEpoch();
    this.assertSurfaceObserverEpochCurrent(observerEpoch, toolName);
    const gatedRoute = await this.engine.resolveAgentIoRoute(agentId);
    this.assertSurfaceObserverEpochCurrent(observerEpoch, toolName);
    await this.assertWorkspaceMutationAllowed(
      toolName,
      gatedRoute.workspace_id,
    );
    this.assertSurfaceObserverEpochCurrent(observerEpoch, toolName);

    // Status lookup is asynchronous. Resolve the stable identity again after
    // that await so the actual I/O never uses the ref that preceded the gate.
    const route = await this.engine.resolveAgentIoRoute(agentId);
    this.assertSurfaceObserverEpochCurrent(observerEpoch, toolName);
    const gatedUuid = gatedRoute.surface_uuid?.trim().toLowerCase() || null;
    const routeUuid = route.surface_uuid?.trim().toLowerCase() || null;
    if (
      gatedUuid !== routeUuid ||
      (gatedRoute.workspace_id ?? null) !== (route.workspace_id ?? null) ||
      (!routeUuid && gatedRoute.surface_id !== route.surface_id)
    ) {
      throw new Error(
        `Agent ${agentId} changed surface binding during ${toolName}; ` +
          `refusing terminal I/O after a stale manual-mode check.`,
      );
    }
    return route;
  }

  private findLaunchingAgentId(
    surface: string,
    workspace?: string,
  ): string | null {
    const candidates = this.registry
      .list()
      .filter(
        (agent) => agent.state === "booting" && agent.surface_id === surface,
      );
    const workspaceCandidates = workspace
      ? candidates.filter((agent) => (agent.workspace_id ?? null) === workspace)
      : candidates;
    const resolved =
      workspaceCandidates.length > 0 ? workspaceCandidates : candidates;
    return resolved.length === 1 ? resolved[0]!.agent_id : null;
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
