import type { AgentRecord, AgentState } from "./agent-types.js";
import type {
  ParsedControlPlaneState,
  ParsedScreenStatus,
} from "./types.js";

/**
 * AIDEV-NOTE (F1): THE single source of live agent-state truth.
 *
 * The registry record is a cache, and a known-broken one: #408 flips live
 * agents to `done` within minutes. Every consumer that read `agent.state` as
 * primary truth inherited that lie — caller identity resolved to null (U6),
 * `send_to` returned a terminal `failed` receipt to an agent sitting at a live
 * prompt, and P11 closure read `artifact_missing` on a working agent.
 *
 * So: derive state from the LIVE screen observation, and fall back to the
 * registry record only as provenance when no screen evidence exists. This
 * module owns the rule; `agent-health.ts` and the server consumers import it
 * rather than each re-deriving one.
 */

/** Agent states that are safe to close without `force`: the task is over. */
export const TERMINAL_AGENT_STATES: ReadonlySet<AgentState> = new Set<AgentState>([
  "done",
  "error",
]);

/** Agent states that accept unforced interactive delivery. */
export const INTERACTIVE_AGENT_STATES: ReadonlySet<AgentState> =
  new Set<AgentState>(["ready", "idle"]);

export type ScreenStateObservation = {
  status?: ParsedScreenStatus | string | null;
  agent_type?: string | null;
  control_state?: ParsedControlPlaneState | string | null;
};

export type LiveAgentState = {
  /** Live-derived state: what the agent IS, not what the registry remembers. */
  state: AgentState;
  /** `screen` when live evidence decided it; `registry` when it is a fallback. */
  source: "screen" | "registry";
  /** The record's own value, kept for provenance and drift reporting. */
  registry_state: AgentState;
  /** Raw screen verdict, whether or not it was strong enough to override. */
  screen_state: AgentState | null;
  /** Live evidence contradicts the record — #408 poisoning, observable. */
  stale_registry_state: boolean;
};

/**
 * The one screen→state rule. Returns null when the screen says nothing
 * conclusive, which is a real answer: absence of evidence is not evidence the
 * record is right, it just leaves the record unchallenged.
 */
export function screenConfirmedAgentState(
  screen: ScreenStateObservation | null | undefined,
): AgentState | null {
  if (!screen) return null;
  const status = screen.status ?? null;
  const agentType = screen.agent_type ?? null;
  const controlState = screen.control_state ?? null;
  // A tracked agent surface that has fallen back to a bare shell has no agent
  // process left; that is an error regardless of how idle the prompt looks.
  if (controlState === "shell" && agentType === "unknown") return "error";
  if (status === "frozen") return "error";
  if (status === "working" || status === "thinking") return "working";
  if (
    controlState === "ready" &&
    agentType !== null &&
    agentType !== undefined &&
    agentType !== "unknown"
  ) {
    return "ready";
  }
  if (status === "done") return "done";
  return null;
}

/**
 * Whether a screen verdict is strong enough to overturn the recorded state.
 *
 * AIDEV-NOTE (F1): `ready` is the weak one, and getting this wrong breaks the
 * opposite contract. A worker that genuinely finished ALSO sits at a ready
 * prompt — the screen cannot tell "done, at prompt" from "idle, never
 * started", while the record can (it carries done-marker/transcript
 * detection). So `ready` may clear a stale `error` or a mid-boot state, but it
 * must never overturn `done`, or done-detection dies for every agent that
 * returns to its prompt. Positive evidence of ACTIVITY (`working`) or of a
 * dead process (bare `shell`) always wins: those contradict the record with
 * something the record cannot know.
 */
function screenOverridesRecord(
  screenState: AgentState,
  registryState: AgentState,
): boolean {
  if (screenState === registryState) return false;
  if (screenState === "working" || screenState === "error") return true;
  if (screenState === "done") return true;
  // screenState === "ready"
  return registryState !== "done";
}

export function resolveLiveAgentState(
  record: Pick<AgentRecord, "state">,
  screen: ScreenStateObservation | null | undefined,
): LiveAgentState {
  const registryState = record.state;
  const screenState = screenConfirmedAgentState(screen);
  if (screenState === null) {
    return {
      state: registryState,
      source: "registry",
      registry_state: registryState,
      screen_state: null,
      stale_registry_state: false,
    };
  }
  const overrides = screenOverridesRecord(screenState, registryState);
  const state = overrides ? screenState : registryState;
  return {
    state,
    // The screen is the source when it decided the answer — by overriding the
    // record, or by corroborating it. When the record won a disagreement, the
    // record is the source, and the raw screen verdict stays visible below.
    source: screenState === state ? "screen" : "registry",
    registry_state: registryState,
    screen_state: screenState,
    stale_registry_state: overrides,
  };
}

export function isLiveTerminal(live: LiveAgentState): boolean {
  return TERMINAL_AGENT_STATES.has(live.state);
}

/**
 * Positive live evidence that the agent is still doing the work. The ONLY
 * observation strong enough to overturn a recorded `done`: a ready prompt is
 * also where a finished worker sits, and a dead pane says nothing about
 * whether the task completed.
 */
export function isLiveActive(live: LiveAgentState): boolean {
  return live.state === "working" && live.source === "screen";
}

export function isLiveInteractive(live: LiveAgentState): boolean {
  return INTERACTIVE_AGENT_STATES.has(live.state);
}

/**
 * Whether unforced input may be delivered right now.
 *
 * AIDEV-NOTE (F1): delivery asks a DIFFERENT question from closure. Closure
 * asks "did the task finish?", which a ready prompt cannot answer. Delivery
 * asks "will this surface accept a message?", which a ready prompt answers
 * definitively — so a live agent prompt is deliverable even while its record
 * says `done`. Gating this on the record is what returned `delivery:"failed"`,
 * `terminal:true` to an agent sitting at a live prompt (ledger row 4).
 *
 * A target-scoped live ready prompt is authoritative for this question even
 * when the registry still says `working`: the prompt proves the composer can
 * accept input, while the record only describes an earlier turn. The
 * bare-shell and picker/overlay guards run before this decision.
 */
export function isLiveDeliverable(live: LiveAgentState): boolean {
  if (INTERACTIVE_AGENT_STATES.has(live.registry_state)) return true;
  return live.registry_state !== "booting" && live.screen_state === "ready";
}
