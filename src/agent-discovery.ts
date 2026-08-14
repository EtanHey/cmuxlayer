import { parseScreen } from "./screen-parser.js";
import type { AgentState, CliType } from "./agent-types.js";
import type {
  CmuxReadScreenResult,
  CmuxSurface,
  ParsedControlPlaneState,
  ParsedScreenStatus,
} from "./types.js";

export interface DiscoveredAgent {
  surface_id: string;
  /** Stable cmux surface UUID paired with the mutable `surface_id` ref. */
  surface_uuid?: string | null;
  surface_title: string;
  workspace_id?: string | null;
  cli: CliType | "unknown";
  control_state: ParsedControlPlaneState;
  parsed_status: ParsedScreenStatus | null;
  model: string | null;
  token_count: number | null;
  context_pct: number | null;
  actions?: string[];
  has_agent: boolean;
  read_error: boolean;
}

export interface DiscoveryDeps {
  /** Resolve the cmux topology identity that produced a discovery snapshot. */
  observerIdProvider?: () => string | null | undefined;
  listSurfaces: () => Promise<CmuxSurface[]>;
  readScreen: (
    surface: string,
    opts: { lines: number; workspace?: string },
  ) => Promise<CmuxReadScreenResult>;
}

function stripKnownAgentSuffixes(title: string): string {
  return title
    .trim()
    .replace(/-(?:resync|audit|worker|review)$/i, "")
    .replace(/(?:Claude|Codex|Gemini|Cursor|Kiro)$/i, "")
    .trim();
}

export function inferRepoFromTitle(title: string): string {
  const stripped = stripKnownAgentSuffixes(title);
  if (!stripped) return "";
  return stripped.replace(/^[A-Z]/, (match) => match.toLowerCase());
}

function inferCliFromLauncherTitle(title: string): CliType | "unknown" {
  const launcherTitle = title.trim().split(":", 1)[0] ?? "";
  const match = launcherTitle.match(/(?:Claude|Codex|Cursor|Gemini|Kiro)$/i);
  return (match?.[0]?.toLowerCase() as CliType | undefined) ?? "unknown";
}

export function discoveredStatusToAgentState(
  status: ParsedScreenStatus | null,
): AgentState {
  switch (status) {
    case "thinking":
    case "working":
      return "working";
    case "idle":
      return "idle";
    case "done":
      return "done";
    case "frozen":
      return "idle";
    default:
      return "ready";
  }
}

export function makeAutoAgentId(cli: CliType, surfaceId: string): string {
  return `auto-${cli}-${surfaceId.replace(/[^a-zA-Z0-9-]/g, "-")}`;
}

export class SurfaceBindingChangedDuringDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SurfaceBindingChangedDuringDiscoveryError";
  }
}

export class AgentDiscovery {
  private cache: {
    at: number;
    observerId: string | null;
    result: DiscoveredAgent[];
  } | null = null;
  private deps: DiscoveryDeps;
  private ttlMs: number;

  constructor(deps: DiscoveryDeps, ttlMs: number = 2000) {
    this.deps = deps;
    this.ttlMs = ttlMs;
  }

  invalidate(): void {
    this.cache = null;
  }

  private getObserverId(): string | null {
    return this.deps.observerIdProvider?.()?.trim() || null;
  }

  private async scanSurface(surface: CmuxSurface): Promise<DiscoveredAgent> {
    const workspaceId =
      typeof surface.workspace_ref === "string" ? surface.workspace_ref : null;
    try {
      const screen = await this.deps.readScreen(surface.ref, {
        lines: 30,
        workspace: workspaceId ?? undefined,
      });
      const parsed = parseScreen(screen.text);
      const titleCli = inferCliFromLauncherTitle(surface.title);
      const cli =
        parsed.agent_type === "unknown"
          ? (parsed.control_state === "permission_prompt" ||
              parsed.control_state === "interactive_overlay") &&
            titleCli !== "unknown"
            ? titleCli
            : "unknown"
          : (parsed.agent_type as CliType);

      return {
        surface_id: surface.ref,
        surface_uuid: surface.id ?? null,
        surface_title: surface.title,
        workspace_id: workspaceId,
        cli,
        control_state: parsed.control_state,
        parsed_status: parsed.status,
        model: parsed.model,
        token_count: parsed.token_count,
        context_pct: parsed.context_pct,
        actions: parsed.actions ?? [],
        has_agent: cli !== "unknown",
        read_error: false,
      };
    } catch (error) {
      console.warn(
        `[AgentDiscovery] Failed to scan surface ${surface.ref} (${surface.title})`,
        error,
      );
      return {
        surface_id: surface.ref,
        surface_uuid: surface.id ?? null,
        surface_title: surface.title,
        workspace_id: workspaceId,
        cli: "unknown",
        control_state: "unknown",
        parsed_status: null,
        model: null,
        token_count: null,
        context_pct: null,
        has_agent: false,
        read_error: true,
      };
    }
  }

  async scanTarget(target: {
    surface_id: string;
    surface_uuid?: string | null;
  }): Promise<DiscoveredAgent | null> {
    const observerId = this.getObserverId();
    const uuidKey = (value: string | null | undefined): string | null =>
      value?.trim().toLowerCase() || null;
    const expectedUuid = uuidKey(target.surface_uuid);
    const matchesTarget = (surface: CmuxSurface): boolean =>
      expectedUuid
        ? uuidKey(surface.id) === expectedUuid
        : surface.ref === target.surface_id;

    const initialMatches = (await this.deps.listSurfaces())
      .filter((surface) => surface.type === "terminal")
      .filter(matchesTarget);
    if (initialMatches.length !== 1) return null;

    const initial = initialMatches[0];
    const result = await this.scanSurface(initial);
    const completedObserverId = this.getObserverId();
    if (completedObserverId !== observerId) {
      throw new Error(
        `Surface observer changed during target discovery (${observerId ?? "unknown"} -> ${completedObserverId ?? "unknown"})`,
      );
    }

    const completedMatches = (await this.deps.listSurfaces())
      .filter((surface) => surface.type === "terminal")
      .filter(matchesTarget);
    const completed = completedMatches[0];
    if (
      completedMatches.length !== 1 ||
      completed?.ref !== initial.ref ||
      (completed.workspace_ref ?? null) !== (initial.workspace_ref ?? null)
    ) {
      throw new SurfaceBindingChangedDuringDiscoveryError(
        `Target surface binding changed during discovery for ${initial.ref}` +
          `${initial.id ? ` (UUID ${initial.id})` : ""}; refusing stale screen evidence`,
      );
    }

    const validatedObserverId = this.getObserverId();
    if (validatedObserverId !== observerId) {
      throw new Error(
        `Surface observer changed during target discovery (${observerId ?? "unknown"} -> ${validatedObserverId ?? "unknown"})`,
      );
    }
    return result;
  }

  async scan(force = false): Promise<DiscoveredAgent[]> {
    const observerScoped =
      typeof this.deps.observerIdProvider === "function";
    const observerId = this.getObserverId();
    const canCache = !observerScoped || observerId !== null;
    if (!canCache || (this.cache && this.cache.observerId !== observerId)) {
      this.cache = null;
    }
    if (!force && this.cache && Date.now() - this.cache.at < this.ttlMs) {
      return this.cache.result;
    }

    const surfaces = (await this.deps.listSurfaces()).filter(
      (surface) => surface.type === "terminal",
    );
    const result = await Promise.all(
      surfaces.map((surface) => this.scanSurface(surface)),
    );

    const completedObserverId = this.getObserverId();
    if (completedObserverId !== observerId) {
      this.cache = null;
      throw new Error(
        `Surface observer changed during discovery (${observerId ?? "unknown"} -> ${completedObserverId ?? "unknown"})`,
      );
    }

    const completedSurfaces = (await this.deps.listSurfaces()).filter(
      (surface) => surface.type === "terminal",
    );
    const uuidKey = (value: string | null | undefined): string | null =>
      value?.trim().toLowerCase() || null;
    for (const surface of surfaces) {
      const expectedUuid = uuidKey(surface.id);
      const currentMatches = expectedUuid
        ? completedSurfaces.filter(
            (candidate) => uuidKey(candidate.id) === expectedUuid,
          )
        : completedSurfaces.filter(
            (candidate) =>
              candidate.ref === surface.ref && uuidKey(candidate.id) === null,
          );
      const current = currentMatches[0];
      if (
        currentMatches.length !== 1 ||
        current?.ref !== surface.ref ||
        (current.workspace_ref ?? null) !== (surface.workspace_ref ?? null)
      ) {
        this.cache = null;
        throw new SurfaceBindingChangedDuringDiscoveryError(
          `Surface binding changed during discovery for ${surface.ref}` +
            `${surface.id ? ` (UUID ${surface.id})` : ""}; refusing stale screen evidence`,
        );
      }
    }

    const validatedObserverId = this.getObserverId();
    if (validatedObserverId !== observerId) {
      this.cache = null;
      throw new Error(
        `Surface observer changed during discovery (${observerId ?? "unknown"} -> ${validatedObserverId ?? "unknown"})`,
      );
    }

    this.cache = canCache ? { at: Date.now(), observerId, result } : null;
    return result;
  }
}
