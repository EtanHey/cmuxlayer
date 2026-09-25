// Surface/harness state helpers shared by the delivery engine and the MCP
// tool handlers (moved out of server.ts, CX-3b S9).

import { StateManager } from "../state-manager.js";
import type { AgentRecord } from "../agent-types.js";
import { inferContextWindow } from "../screen-parser.js";
import {
  harnessJsonlEnabled,
  loadHarnessSession,
  type Harness,
} from "../harness-session.js";
import type { ParsedScreenResult } from "../types.js";

export function pickLatestSurfaceModel(
  stateMgr: StateManager,
  surfaceRef: string,
): string | null {
  const matches = stateMgr
    .listStates()
    .filter((record) => record.surface_id === surfaceRef && record.model);

  if (matches.length === 0) {
    return null;
  }

  matches.sort((a, b) => {
    if (b.version !== a.version) return b.version - a.version;
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });

  return matches[0]?.model ?? null;
}

export const JSONL_HARNESSES = new Set<Harness>(["claude", "codex", "cursor"]);

// AIDEV-NOTE: P2 — real agent state from the harness JSONL (the sterile read channel).
// Flag-gated (CMUXLAYER_HARNESS_JSONL=1); screen-parser is the fallback. Resolves the
// surface's cli + cli_session_id from the in-memory state cache, then loads the
// transcript by sessionId (no cwd needed — the id is unique). Returns null whenever the
// flag is off, the harness is unsupported, or no session file is found → screen values stand.
export function resolveHarnessStateForSurface(
  stateMgr: StateManager,
  surfaceRef: string,
  authorizedRecord?: AgentRecord | null,
): ReturnType<typeof loadHarnessSession> {
  if (!harnessJsonlEnabled()) return null;
  const matches = stateMgr
    .listStates()
    .filter((record) => record.surface_id === surfaceRef)
    .sort((a, b) => {
      if (b.version !== a.version) return b.version - a.version;
      return (
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      );
    });
  const record = authorizedRecord ?? matches[0];
  const cli = record?.cli as Harness | undefined;
  const sessionId = record?.cli_session_id ?? null;
  // Codex fill is handled asynchronously from the exact self-registration
  // session path. Never fall back to the legacy synchronous sessions-dir scan.
  if (cli === "codex") return null;
  if (!cli || !sessionId || !JSONL_HARNESSES.has(cli)) return null;
  // Honor CODEX_HOME (already used by app-server-bridge) and a test-only home override.
  const opts = {
    ...(process.env.CMUXLAYER_HARNESS_HOME
      ? { home: process.env.CMUXLAYER_HARNESS_HOME }
      : {}),
    ...(process.env.CODEX_HOME ? { codexHome: process.env.CODEX_HOME } : {}),
  };
  return loadHarnessSession(cli, sessionId, opts);
}

export function resolveLatestSurfaceAgentRecord(
  stateMgr: StateManager,
  surfaceRef: string,
  stableSurfaceIdentity?: string | null,
): AgentRecord | undefined {
  const stableUuid = stableSurfaceIdentity?.trim().toLowerCase() ?? null;
  return stateMgr
    .listStates()
    .filter((record) =>
      stableUuid
        ? record.surface_uuid?.trim().toLowerCase() === stableUuid
        : record.surface_id === surfaceRef,
    )
    .sort((a, b) => {
      if (b.version !== a.version) return b.version - a.version;
      return (
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      );
    })[0];
}

export function enrichParsedScreen(
  parsed: ParsedScreenResult,
  rawText: string,
  fallbackModel: string | null,
): ParsedScreenResult {
  const model = parsed.model ?? fallbackModel;
  const contextWindow =
    parsed.context_window ??
    inferContextWindow(model, parsed.token_count, rawText);

  let contextPct = parsed.context_pct;
  if (
    contextPct === null &&
    parsed.agent_type !== "codex" &&
    parsed.token_count !== null &&
    contextWindow !== null
  ) {
    contextPct = Math.min(
      100,
      Math.round((parsed.token_count / contextWindow) * 100),
    );
  }

  return {
    ...parsed,
    model,
    context_window: contextWindow,
    context_pct: contextPct,
  };
}
