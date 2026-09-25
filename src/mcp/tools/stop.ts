// stop_agent: formerly an internally dispatched MCP registration, now a plain
// function called directly by close_surface scope="agent" (CX-3 S7). The body
// is verbatim; captured agent-lifecycle state arrives as StopAgentDeps.

import { z } from "zod";
import type { AgentEngine } from "../../agent-engine.js";
import type { AgentRecord, CloseTelemetryEvent } from "../../agent-types.js";
import { formatOk } from "../../format.js";
import { type InboxOpts, reapInboxTail } from "../../inbox.js";
import { type ToolReturn, err, okFormatted } from "../tool-result.js";
import { OWNED_AGENT_CLOSE_ON_UNKNOWN_PID } from "./surface.js";

/** createServer's agent-lifecycle state stop_agent uses. */
export interface StopAgentDeps {
  appendCloseEvent: (event: Omit<CloseTelemetryEvent, "ts" | "event_type">) => void;
  assertSurfaceMutationAllowed: (toolName: string, surface: string, workspace?: string) => Promise<void>;
  engine: AgentEngine;
  inboxOpts: InboxOpts;
  pruneChildReportWatchesFor: (agentId: string) => void;
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- the inferred type
  reapTailAfterConfirmedExit: (target: AgentRecord | null) => Promise<{}>;
  resolveCloseCaller: (toolName: string) => string;
}

// stop_agent: formerly an internally dispatched MCP registration. Its callers
// call it directly now; like the old by-name dispatch, the arguments are not
// re-parsed, so the shape below is the args type only.
const stopAgentArgsShape = z.object({
    agent_id: z.string().describe("Agent ID to stop"),
    force: z
      .boolean()
      .optional()
      .default(false)
      .describe("Force kill instead of graceful Ctrl+C"),
  });
export type StopAgentArgs = z.input<typeof stopAgentArgsShape>;
/** close_surface scope="agent" may also set the owned-close symbol flag. */
export type StopAgentCallArgs = StopAgentArgs & {
  [OWNED_AGENT_CLOSE_ON_UNKNOWN_PID]?: boolean;
};

export async function stopAgent(
  deps: StopAgentDeps,
  input: StopAgentCallArgs,
): Promise<ToolReturn> {
  // Callers pass unparsed input, as the by-name dispatch did; the body was
  // written against the parsed shape, so name that contract here.
  const args = input as z.infer<typeof stopAgentArgsShape> & StopAgentCallArgs;
  const { appendCloseEvent, assertSurfaceMutationAllowed, engine, inboxOpts, pruneChildReportWatchesFor, reapTailAfterConfirmedExit, resolveCloseCaller } = deps;
  const target = engine.getAgentState(args.agent_id);
  try {
    await engine.stopAgent(args.agent_id, args.force, {
      allowUnknownPidOwnedSurfaceClose:
        (args as typeof args & {
          [OWNED_AGENT_CLOSE_ON_UNKNOWN_PID]?: boolean;
        })[OWNED_AGENT_CLOSE_ON_UNKNOWN_PID] === true,
      beforeSurfaceMutation: (route) =>
        assertSurfaceMutationAllowed(
          "stop_agent",
          route.surface_id,
          route.workspace_id ?? undefined,
        ),
    });
    const tailOutcome = await reapInboxTail(target?.agent_id ?? args.agent_id, inboxOpts);
    pruneChildReportWatchesFor(args.agent_id);
    const state = engine.getAgentState(args.agent_id);
    appendCloseEvent({
      event: "stop_agent",
      target: args.agent_id,
      caller: resolveCloseCaller("stop_agent"),
      force: args.force ?? false,
      reason: `state after stop: ${state?.state ?? "done"}`,
      refused: false,
    });
    const data = {
      agent_id: args.agent_id,
      state: state?.state ?? "done",
      ...tailOutcome,
    };
    return okFormatted(formatOk("stop_agent", data), data);
  } catch (e) {
    const tailOutcome = await reapTailAfterConfirmedExit(target).catch(() => ({}));
    return err(e, tailOutcome);
  }
}
