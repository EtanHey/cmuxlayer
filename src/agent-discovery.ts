import { parseScreen } from "./screen-parser.js";
import type { AgentState, CliType } from "./agent-types.js";
import type {
  CmuxReadScreenResult,
  CmuxSurface,
  ParsedScreenStatus,
} from "./types.js";

export interface DiscoveredAgent {
  surface_id: string;
  surface_title: string;
  workspace_id?: string | null;
  cli: CliType | "unknown";
  parsed_status: ParsedScreenStatus | null;
  model: string | null;
  token_count: number | null;
  context_pct: number | null;
  has_agent: boolean;
  read_error: boolean;
}

export interface DiscoveryDeps {
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
      return "error";
    default:
      return "ready";
  }
}

export function makeAutoAgentId(cli: CliType, surfaceId: string): string {
  return `auto-${cli}-${surfaceId.replace(/[^a-zA-Z0-9-]/g, "-")}`;
}

export class AgentDiscovery {
  private cache: { at: number; result: DiscoveredAgent[] } | null = null;
  private deps: DiscoveryDeps;
  private ttlMs: number;

  constructor(deps: DiscoveryDeps, ttlMs: number = 2000) {
    this.deps = deps;
    this.ttlMs = ttlMs;
  }

  invalidate(): void {
    this.cache = null;
  }

  async scan(force = false): Promise<DiscoveredAgent[]> {
    if (!force && this.cache && Date.now() - this.cache.at < this.ttlMs) {
      return this.cache.result;
    }

    const surfaces = (await this.deps.listSurfaces()).filter(
      (surface) => surface.type === "terminal",
    );
    const result = await Promise.all(
      surfaces.map(async (surface): Promise<DiscoveredAgent> => {
        const workspaceId =
          typeof surface.workspace_ref === "string" ? surface.workspace_ref : null;
        try {
          const screen = await this.deps.readScreen(surface.ref, {
            lines: 30,
            workspace: workspaceId ?? undefined,
          });
          const parsed = parseScreen(screen.text);
          const cli =
            parsed.agent_type === "unknown"
              ? "unknown"
              : (parsed.agent_type as CliType);

          return {
            surface_id: surface.ref,
            surface_title: surface.title,
            workspace_id: workspaceId,
            cli,
            parsed_status: parsed.status,
            model: parsed.model,
            token_count: parsed.token_count,
            context_pct: parsed.context_pct,
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
            surface_title: surface.title,
            workspace_id: workspaceId,
            cli: "unknown",
            parsed_status: null,
            model: null,
            token_count: null,
            context_pct: null,
            has_agent: false,
            read_error: true,
          };
        }
      }),
    );

    this.cache = { at: Date.now(), result };
    return result;
  }
}
