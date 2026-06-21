import type { CmuxClient } from "../cmux-client.js";
import type { Policy, SecureToolContext, Redactor } from "../secure/policy-schema.js";
import { isAllowedPrefix } from "../secure/tool-policy.js";
import type { CmuxSurface } from "../types.js";

export interface CmuxToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

function ok(data: Record<string, unknown>): CmuxToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: true, ...data }) }],
  };
}

function err(error: unknown, extra: Record<string, unknown> = {}): CmuxToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ ok: false, error: message, ...extra }),
      },
    ],
    isError: true,
  };
}

function redactScreen(text: string, redactor: Redactor): string {
  return redactor.redact(text);
}

function filterSurfaces(
  surfaces: CmuxSurface[],
  policy: Policy,
): CmuxSurface[] {
  const prefixes = policy.surfaces?.allowed_name_prefixes ?? [];
  if (prefixes.length === 0) {
    return surfaces;
  }
  return surfaces.filter((s) => {
    const name = s.title ?? s.ref ?? "";
    return isAllowedPrefix(name, prefixes);
  });
}

// ─────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────
export interface SecureCmuxTools {
  "cmux.list_surfaces": (
    args: unknown,
    context: SecureToolContext,
  ) => Promise<CmuxToolResult>;
  "cmux.read_screen": (
    args: unknown,
    context: SecureToolContext,
  ) => Promise<CmuxToolResult>;
  "cmux.read_output": (
    args: unknown,
    context: SecureToolContext,
  ) => Promise<CmuxToolResult>;
  "cmux.read_recent_activity": (
    args: unknown,
    context: SecureToolContext,
  ) => Promise<CmuxToolResult>;
  "cmux.get_agent_metadata": (
    args: unknown,
    context: SecureToolContext,
  ) => Promise<CmuxToolResult>;
}

export function createSecureCmuxTools(
  client: CmuxClient,
  _policy: Policy,
): SecureCmuxTools {
  // ─────────────────────────────────────────────────────────
  // cmux.list_surfaces
  // ─────────────────────────────────────────────────────────
  async function listSurfaces(
    args: unknown,
    context: SecureToolContext,
  ): Promise<CmuxToolResult> {
    const params = args as Record<string, unknown>;
    const workspaceFilter =
      typeof params.workspace === "string" ? params.workspace : undefined;

    try {
      // Get workspaces
      const { workspaces } = await client.listWorkspaces();

      // Get all surfaces across all workspaces
      const allSurfaces: Array<{
        surface: CmuxSurface;
        workspace_ref: string;
      }> = [];

      const targetWorkspaces = workspaceFilter
        ? workspaces
          .filter((w) => w.ref === workspaceFilter)
          .map((w) => w.ref)
        : workspaces.map((w) => w.ref);

      for (const wsRef of targetWorkspaces) {
        try {
          const paneSurfaces = await client.listPaneSurfaces({
            workspace: wsRef,
          });
          for (const surface of paneSurfaces.surfaces) {
            allSurfaces.push({
              surface,
              workspace_ref: paneSurfaces.workspace_ref ?? wsRef,
            });
          }
        } catch {
          // Skip inaccessible workspaces
        }
      }

      // Filter surfaces by allowed_name_prefixes
      const filtered = filterSurfaces(
        allSurfaces.map((s) => s.surface),
        context.policy,
      );

      const surfaceList = filtered.map((s) => ({
        ref: s.ref,
        title: s.title,
        type: s.type,
        workspace_ref:
          allSurfaces.find((as) => as.surface.ref === s.ref)?.workspace_ref ??
          "",
      }));

      return ok({
        workspaces: workspaces.map((w) => ({
          ref: w.ref,
          title: w.title,
        })),
        surfaces: surfaceList,
        count: surfaceList.length,
      });
    } catch (e) {
      return err(e);
    }
  }

  // ─────────────────────────────────────────────────────────
  // cmux.read_screen
  // ─────────────────────────────────────────────────────────
  async function readScreen(
    args: unknown,
    context: SecureToolContext,
  ): Promise<CmuxToolResult> {
    const params = args as Record<string, unknown>;
    const surface = typeof params.surface === "string" ? params.surface : "";
    const lines = typeof params.lines === "number" ? params.lines : 30;

    if (!surface) {
      return err("Missing required 'surface' argument");
    }

    try {
      const result = await client.readScreen(surface, { lines });
      const redactedText = redactScreen(result.text, context.redactor);

      // Parse the screen for structured data
      const { parseScreen } = await import("../screen-parser.js");
      const parsed = parseScreen(result.text);

      return ok({
        surface: result.surface,
        lines: result.lines,
        text: redactedText,
        parsed: {
          agent_type: parsed.agent_type,
          status: parsed.status,
          token_count: parsed.token_count,
          context_pct: parsed.context_pct,
          context_window: parsed.context_window,
          done_signal: parsed.done_signal,
          model: parsed.model,
          cost: parsed.cost,
        },
        delivery: {
          scrollback_used: result.scrollback_used,
        },
      });
    } catch (e) {
      return err(e);
    }
  }

  // ─────────────────────────────────────────────────────────
  // cmux.read_output
  // ─────────────────────────────────────────────────────────
  async function readOutput(
    args: unknown,
    context: SecureToolContext,
  ): Promise<CmuxToolResult> {
    const params = args as Record<string, unknown>;
    const surface = typeof params.surface === "string" ? params.surface : "";
    const lines = typeof params.lines === "number" ? params.lines : 20;

    if (!surface) {
      return err("Missing required 'surface' argument");
    }

    try {
      const result = await client.readScreen(surface, { lines });
      const redactedText = redactScreen(result.text, context.redactor);

      return ok({
        surface: result.surface,
        text: redactedText,
        lines: result.lines,
        scrollback_used: result.scrollback_used,
      });
    } catch (e) {
      return err(e);
    }
  }

  // ─────────────────────────────────────────────────────────
  // cmux.read_recent_activity
  // ─────────────────────────────────────────────────────────
  async function readRecentActivity(
    args: unknown,
    context: SecureToolContext,
  ): Promise<CmuxToolResult> {
    const params = args as Record<string, unknown>;
    const surface = typeof params.surface === "string" ? params.surface : "";
    const lines = typeof params.lines === "number" ? params.lines : 50;
    const sinceSeconds =
      typeof params.since_seconds === "number" ? params.since_seconds : 300;

    if (!surface) {
      return err("Missing required 'surface' argument");
    }

    try {
      const result = await client.readScreen(surface, { lines });
      const redactedText = redactScreen(result.text, context.redactor);

      // Parse screen for time-filter logic — we can't get true timestamps
      // from the screen, so we return the most recent content and metadata
      const { parseScreen } = await import("../screen-parser.js");
      const parsed = parseScreen(result.text);

      // Look for timestamp-like patterns in the text
      const timestampMatches = redactedText.match(
        /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/g,
      );

      return ok({
        surface: result.surface,
        text: redactedText,
        since_seconds: sinceSeconds,
        lines: result.lines,
        parsed: {
          agent_type: parsed.agent_type,
          status: parsed.status,
          model: parsed.model,
        },
        timestamps_found: timestampMatches ?? [],
      });
    } catch (e) {
      return err(e);
    }
  }

  // ─────────────────────────────────────────────────────────
  // cmux.get_agent_metadata
  // ─────────────────────────────────────────────────────────
  async function getAgentMetadata(
    args: unknown,
    context: SecureToolContext,
  ): Promise<CmuxToolResult> {
    const params = args as Record<string, unknown>;
    const surface = typeof params.surface === "string" ? params.surface : "";

    if (!surface) {
      return err("Missing required 'surface' argument");
    }

    try {
      const result = await client.readScreen(surface, { lines: 30 });
      const redactedText = redactScreen(result.text, context.redactor);

      const { parseScreen } = await import("../screen-parser.js");
      const parsed = parseScreen(result.text);

      // Infer model from screen text
      const modelMatch = result.text.match(
        /(?:model|using|with)\s*:?\s*(gpt-[\w-]+|claude-[\w-]+|gemini-[\w-]+|cursor)/i,
      );

      // Look for cost info
      const costMatch = result.text.match(/\$[\d.]+|cost[:\s]*[\d.]+/i);

      // Detect context window info
      const contextMatch = result.text.match(
        /(\d+)\s*\/\s*(\d+)\s*(?:tokens?|context)/i,
      );

      return ok({
        surface: result.surface,
        agent_type: parsed.agent_type,
        status: parsed.status,
        model: parsed.model ?? (modelMatch ? modelMatch[1]! : null),
        token_count: parsed.token_count,
        context_pct: parsed.context_pct,
        context_window: parsed.context_window,
        cost:
          parsed.cost ?? (costMatch ? costMatch[0]! : null),
        done_signal: parsed.done_signal,
        inferred_model_from_text: modelMatch ? modelMatch[1]! : null,
        inferred_context_from_text: contextMatch
          ? `${contextMatch[1]!} / ${contextMatch[2]!}`
          : null,
        text_preview: redactedText.slice(0, 500),
      });
    } catch (e) {
      return err(e);
    }
  }

  return {
    "cmux.list_surfaces": listSurfaces,
    "cmux.read_screen": readScreen,
    "cmux.read_output": readOutput,
    "cmux.read_recent_activity": readRecentActivity,
    "cmux.get_agent_metadata": getAgentMetadata,
  };
}
