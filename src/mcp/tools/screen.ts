// read_screen moved out of createServer's closure (CX-3 S7). The body is
// verbatim; captured closure state arrives as ReadScreenToolDeps.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentRecord } from "../../agent-types.js";
import type { CodexRolloutFill } from "../../codex-rollout-fill.js";
import type { DeliveryEngine } from "../../delivery/engine.js";
import { enrichParsedScreen, pickLatestSurfaceModel, resolveHarnessStateForSurface } from "../../delivery/surface-state.js";
import { formatReadScreen } from "../../format.js";
import { applyHarnessState } from "../../harness-session.js";
import { cleanScreenText, parseScreen } from "../../screen-parser.js";
import type { StateManager } from "../../state-manager.js";
import { EMPTY_SURFACE_TOPOLOGY, type SurfaceTopologySnapshot } from "../../surface-topology.js";
import type { ParsedScreenResult } from "../../types.js";
import type { ReadScreenSnapshot } from "../context.js";
import { ANNOTATIONS } from "../schemas.js";
import type { RawSurfaceMutationRoute } from "../shared-types.js";
import { err, okFormatted } from "../tool-result.js";

/** createServer's closure state read_screen uses. */
export interface ReadScreenToolDeps {
  applyCodexRolloutFill: (parsed: ParsedScreenResult, fill: CodexRolloutFill | null) => ParsedScreenResult;
  collectSurfaceTopology: (workspace?: string) => Promise<SurfaceTopologySnapshot | null>;
  getSurfaceDelivery: DeliveryEngine["getSurfaceDelivery"];
  readCodexRolloutFill: (agent: AgentRecord | null) => Promise<CodexRolloutFill | null>;
  readScreenSnapshot: (opts: { surface: string; workspace?: string; lines?: number; scrollback?: boolean }) => Promise<ReadScreenSnapshot>;
  remapFields: (route: RawSurfaceMutationRoute) => Pick<RawSurfaceMutationRoute, "remapped_from" | "remapped_to">;
  resolveCodexAgentForSurface: (surfaceRef: string, topology: SurfaceTopologySnapshot | null) => AgentRecord | null;
  resolveRawSurfaceMutationRoute: (requestedSurface: string, requestedWorkspace: string | undefined, operation: string, trustedAgentScopedClose?: boolean) => Promise<RawSurfaceMutationRoute>;
  sameCodexSessionBinding: (before: AgentRecord | null, after: AgentRecord | null) => AgentRecord | null;
  stateMgr: StateManager;
  validateCodexRolloutFill: (agent: AgentRecord | null, expectedSurfaceRef: string | null, fill: CodexRolloutFill | null) => Promise<CodexRolloutFill | null>;
}

export function registerReadScreenTool(
  server: McpServer,
  deps: ReadScreenToolDeps,
): void {
  const { applyCodexRolloutFill, collectSurfaceTopology, getSurfaceDelivery, readCodexRolloutFill, readScreenSnapshot, remapFields, resolveCodexAgentForSurface, resolveRawSurfaceMutationRoute, sameCodexSessionBinding, stateMgr, validateCodexRolloutFill } = deps;
  // 9. read_screen
  server.tool(
    "read_screen",
    "Read a terminal screen and parsed harness status. Use raw=true for full text or parsed_only=true for monitoring.",
    {
      surface: z.string().optional().describe("Target surface ref"),
      // AIDEV-NOTE (#611): `surface_id` is accepted because WE taught it. Our
      // own spawn_agent output schema and every list_agents row EMIT
      // `surface_id`, so the natural workflow -- list_agents, then read the
      // surface it named -- hands that key straight back and got a validation
      // error. The value was always right; only the name was, and the tool that
      // taught the wrong name was ours. This is an alias for that reason, not
      // for backwards compatibility.
      surface_id: z
        .string()
        .optional()
        .describe("Alias for `surface`, as emitted by list_agents/spawn_agent."),
      workspace: z.string().optional().describe("Target workspace ref"),
      lines: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .default(20)
        .describe("Number of lines to read"),
      scrollback: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include scrollback buffer"),
      parsed_only: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "If true, return only parsed fields (omit screen content). Best for agent monitoring.",
        ),
      raw: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "If true, include the full untrimmed terminal content (separators, status-bar art, all lines). Default false returns a compact de-chromed screen_preview instead.",
        ),
    },
    ANNOTATIONS.readOnly,
    async (args) => {
      try {
        // #611: accept either spelling, then use one resolved value below.
        const surfaceRef = args.surface ?? args.surface_id;
        if (!surfaceRef) {
          throw new Error(
            'read_screen requires a surface. Example: read_screen({ surface: "surface:122" }) -- the surface_id from list_agents is accepted too.',
          );
        }
        let codexAgentBeforeRead: AgentRecord | null = null;
        const hasCodexRolloutCandidate = stateMgr
          .listStates()
          .some(
            (agent) =>
              agent.cli === "codex" &&
              Boolean(agent.surface_uuid?.trim()) &&
              Boolean(agent.cli_session_path),
          );
        if (hasCodexRolloutCandidate) {
          const topologyBeforeRead = await collectSurfaceTopology(
            args.workspace,
          ).catch(() => null);
          codexAgentBeforeRead = resolveCodexAgentForSurface(
            surfaceRef,
            topologyBeforeRead,
          );
        }
        let result: ReadScreenSnapshot["result"];
        let topology: ReadScreenSnapshot["topology"];
        let screenRemap: Pick<
          RawSurfaceMutationRoute,
          "remapped_from" | "remapped_to"
        > = {};
        const snapshotOpts = {
          surface: surfaceRef,
          workspace: args.workspace,
          lines: Math.max(args.lines ?? 20, 80),
          scrollback: args.scrollback,
        };
        try {
          ({ result, topology } = await readScreenSnapshot(snapshotOpts));
        } catch (readError) {
          const route = await resolveRawSurfaceMutationRoute(
            surfaceRef,
            args.workspace,
            "read_screen",
          );
          if (
            route.surface === surfaceRef &&
            (route.workspace ?? null) === (args.workspace ?? null)
          ) {
            throw readError;
          }
          screenRemap = remapFields(route);
          ({ result, topology } = await readScreenSnapshot({
            ...snapshotOpts,
            surface: route.surface,
            workspace: route.workspace ?? args.workspace,
          }));
          if (hasCodexRolloutCandidate) {
            codexAgentBeforeRead = resolveCodexAgentForSurface(
              route.surface,
              topology,
            );
          }
        }
        const requestedIsLive =
          topology?.workspaceBySurface.has(surfaceRef) === true ||
          topology?.surfaceIdByRef.has(surfaceRef) === true;
        if (
          topology?.complete === true &&
          !requestedIsLive &&
          !screenRemap.remapped_from
        ) {
          const route = await resolveRawSurfaceMutationRoute(
            surfaceRef,
            args.workspace,
            "read_screen",
          );
          screenRemap = remapFields(route);
          if (route.surface !== surfaceRef) {
            const remapped = await readScreenSnapshot({
              ...snapshotOpts,
              surface: route.surface,
              workspace: route.workspace ?? args.workspace,
            });
            result = remapped.result;
            topology = remapped.topology;
            if (hasCodexRolloutCandidate) {
              codexAgentBeforeRead = resolveCodexAgentForSurface(
                route.surface,
                topology,
              );
            }
          }
        }
        const title = topology?.titleBySurface.get(result.surface) ?? null;
        const { column, column_count } =
          topology?.topologyBySurface.get(result.surface) ??
          EMPTY_SURFACE_TOPOLOGY;
        const codexAgent = sameCodexSessionBinding(
          codexAgentBeforeRead,
          resolveCodexAgentForSurface(result.surface, topology),
        );
        const codexFill = await validateCodexRolloutFill(
          codexAgent,
          result.surface,
          await readCodexRolloutFill(codexAgent),
        );
        const parsed = applyCodexRolloutFill(
          applyHarnessState(
            enrichParsedScreen(
              parseScreen(result.text),
              result.text,
              pickLatestSurfaceModel(stateMgr, result.surface),
            ),
            resolveHarnessStateForSurface(stateMgr, result.surface, codexAgent),
          ),
          codexFill,
        );
        // The lean and parsed-only variants are separate reads. A caller may
        // compare parsed fields only when these hashes identify the same frame.
        const snapshot_hash = createHash("sha256").update(result.text).digest("hex");

        if (args.parsed_only) {
          const data = {
            surface: result.surface,
            snapshot_hash,
            title,
            column,
            column_count,
            parsed,
            delivery: getSurfaceDelivery(result.surface),
            ...screenRemap,
          };
          const formatted = formatReadScreen(
            result.surface,
            title,
            null,
            parsed,
            false,
            0,
            column,
            column_count,
          );
          return okFormatted(formatted, data);
        }

        if (args.raw) {
          // Full untrimmed terminal content on explicit request.
          const rawText = result.text
            .split("\n")
            .slice(-(args.lines ?? 20))
            .join("\n");
          const data = {
            surface: result.surface,
            snapshot_hash,
            title,
            column,
            column_count,
            lines: rawText.split("\n").length,
            content: rawText,
            scrollback_used: result.scrollback_used,
            parsed,
            delivery: getSurfaceDelivery(result.surface),
            ...screenRemap,
          };
          const formatted = formatReadScreen(
            result.surface,
            title,
            rawText,
            parsed,
            result.scrollback_used,
            rawText.split("\n").length,
            column,
            column_count,
          );
          return okFormatted(formatted, data);
        }

        // LEAN DEFAULT: response returned once (parsed.response); no raw dump. Show a
        // compact de-chromed preview ONLY when there's no response, so non-agent panes
        // (shell prompts, menus) still surface something without duplicating the response.
        const screenPreview = parsed.response
          ? null
          : cleanScreenText(result.text, 12) || null;
        const data = {
          surface: result.surface,
          snapshot_hash,
          title,
          column,
          column_count,
          parsed,
          ...(screenPreview ? { screen_preview: screenPreview } : {}),
          delivery: getSurfaceDelivery(result.surface),
          ...screenRemap,
        };
        const formatted = formatReadScreen(
          result.surface,
          title,
          screenPreview,
          parsed,
          false,
          screenPreview ? screenPreview.split("\n").length : 0,
          column,
          column_count,
        );
        return okFormatted(formatted, data);
      } catch (e) {
        return err(e);
      }
    },
  );
}
