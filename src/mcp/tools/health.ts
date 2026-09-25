// control_health moved out of createServer's closure (CX-3 S7). The body is
// verbatim; captured closure state arrives as ControlHealthToolDeps.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { join } from "node:path";
import { z } from "zod";
import type { AgentRecord } from "../../agent-types.js";
import { type ControlHealth, formatControlHealth } from "../../control-health.js";
import { canonicalAgentId, resolveWatchOwner, watchOwnerIncludesCanonical, watchRecordOwner } from "../../watch-owner.js";
import { readWatchRegistry } from "../../watch-spec.js";
import type { CmuxServerContext, CreateServerOptions } from "../context.js";
import { ANNOTATIONS } from "../schemas.js";
import { err, okFormatted } from "../tool-result.js";

/** createServer's closure state control_health uses. */
export interface ControlHealthToolDeps {
  appendControlHealthSnapshot: () => Promise<ControlHealth>;
  context: CmuxServerContext;
  opts: CreateServerOptions | undefined;
  resolveCurrentCallerAgent: () => AgentRecord | null;
  snapshotWatchOwnerCandidates: () => AgentRecord[];
  staleBuildWarning: () => string | null;
}

export function registerControlHealthTool(
  server: McpServer,
  deps: ControlHealthToolDeps,
): void {
  const { appendControlHealthSnapshot, context, opts, resolveCurrentCallerAgent, snapshotWatchOwnerCandidates, staleBuildWarning } = deps;
  server.tool(
    "control_health",
    "Report terse control-path health by default; pass detail=full for diagnostics.",
    {
      detail: z.enum(["terse", "full"]).optional().default("terse"),
    },
    ANNOTATIONS.readOnly,
    async (args) => {
      try {
        const health = await appendControlHealthSnapshot();
        const staleWarning = staleBuildWarning();
        const healthWithStale = staleWarning
          ? { ...health, warnings: [...health.warnings, staleWarning] }
          : health;
        if (args.detail === "full") {
          return okFormatted(formatControlHealth(healthWithStale), {
            health: healthWithStale,
          });
        }
        const caller = resolveCurrentCallerAgent();
        const callerCanonicalId = caller
          ? canonicalAgentId(caller.agent_id)
          : null;
        const callerWatchOwnerCandidates = caller
          ? snapshotWatchOwnerCandidates()
          : [];
        const watches = caller
          ? readWatchRegistry({
              registryPath:
                opts?.watchRegistryPath ??
                join(context.stateDir, "watch-specs.json"),
            }).watches
              .filter(
                (watch) => {
                  const ownerResolution = resolveWatchOwner(
                    watchRecordOwner(watch),
                    callerWatchOwnerCandidates,
                  );
                  return (
                    callerCanonicalId !== null &&
                    ownerResolution.kind === "resolved" &&
                    watchOwnerIncludesCanonical(
                      ownerResolution,
                      callerCanonicalId,
                    ) &&
                    (watch.state === "armed" || watch.state === "firing")
                  );
                },
              )
              .map(({ watch_id, target, state }) => ({
                watch_id,
                target,
                state,
              }))
          : [];
        const terse = {
          transport: healthWithStale.selected_transport,
          warnings: healthWithStale.warnings,
          daemon_lifecycle: healthWithStale.daemon_lifecycle,
          self_heal: {
            pane_pty_dead:
              healthWithStale.self_heal.pane_pty_dead.count,
          },
          caller_live_watches: {
            count: watches.length,
            watches,
          },
        };
        return okFormatted(JSON.stringify(terse), { health: terse });
      } catch (e) {
        return err(e);
      }
    },
  );
}
