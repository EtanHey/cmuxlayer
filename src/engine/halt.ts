/**
 * Halt detection, escalation and prompt resolution, moved verbatim from agent-engine.ts (CX-3 E6).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentEngine } from "../agent-engine.js";
import type { AgentHaltType, AgentRecord } from "../agent-types.js";
import { dispatchOnce, readInbox } from "../inbox.js";
import {
  classifyPromptDisposition,
  cleanScreenText,
  containsPromptApprovalChooser,
  hasVisibleAgentProgress,
  isBlockingPromptChooserScreen,
  isPromptResolutionAuditSafe,
  parseScreen,
  type PromptDisposition,
} from "../screen-parser.js";
import type { ParsedScreenResult } from "../types.js";
import { rawResumeCommandOrNull } from "./launch-command.js";
import {
  BOOT_SESSION_CAPTURE_LINES,
  PROMPT_MOTION_GRACE_MS,
  type HaltSinkResolution,
  type SweepAgentContext,
} from "./types.js";

const execFileAsync = promisify(execFile);

export function screenTextSignature(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return `${text.length}:${hash.toString(16)}`;
}


/**
 * The engine surface these functions read and drive. AgentEngine builds it
 * once (haltHost()); fields are live getters and methods forward to the
 * engine, so spies on the engine still intercept.
 */
export interface HaltHost {
  readonly autoResolvePrompts: AgentEngine["autoResolvePrompts"];
  readonly backgroundChildCpuTimes: AgentEngine["backgroundChildCpuTimes"];
  readonly client: AgentEngine["client"];
  readonly haltAwaitingInputDwellMs: AgentEngine["haltAwaitingInputDwellMs"];
  readonly haltIdleWithoutDoneDwellMs: AgentEngine["haltIdleWithoutDoneDwellMs"];
  readonly haltNow: AgentEngine["haltNow"];
  readonly haltProcessSnapshot: AgentEngine["haltProcessSnapshot"];
  readonly haltWedgedDwellMs: AgentEngine["haltWedgedDwellMs"];
  readonly haltWedgedSweeps: AgentEngine["haltWedgedSweeps"];
  readonly inboxOpts: AgentEngine["inboxOpts"];
  readonly promptMotionObservedAtMs: AgentEngine["promptMotionObservedAtMs"];
  readonly promptMotionScreenSignatures: AgentEngine["promptMotionScreenSignatures"];
  readonly promptResolutionFailures: AgentEngine["promptResolutionFailures"];
  readonly registry: AgentEngine["registry"];
  readonly stateMgr: AgentEngine["stateMgr"];
  sweepBackgroundProcessSnapshot: AgentEngine["sweepBackgroundProcessSnapshot"];
  appendHaltEscalationEvent: AgentEngine["appendHaltEscalationEvent"];
  appendResolvedPromptEvent: AgentEngine["appendResolvedPromptEvent"];
  assertSweepInputCurrent: AgentEngine["assertSweepInputCurrent"];
  backgroundChildUsedCpu: AgentEngine["backgroundChildUsedCpu"];
  clearHaltEpisode: AgentEngine["clearHaltEpisode"];
  fleetHaltSink: AgentEngine["fleetHaltSink"];
  haltDwellMs: AgentEngine["haltDwellMs"];
  haltSinkQuality: AgentEngine["haltSinkQuality"];
  haltUnblockAction: AgentEngine["haltUnblockAction"];
  hasCurrentRecordedOutputDoneEvidence: AgentEngine["hasCurrentRecordedOutputDoneEvidence"];
  hasOutputDoneEvidence: AgentEngine["hasOutputDoneEvidence"];
  hasParentVisibleArtifactSinceIdle: AgentEngine["hasParentVisibleArtifactSinceIdle"];
  isIdleSupervisor: AgentEngine["isIdleSupervisor"];
  isMatureHaltEpisode: AgentEngine["isMatureHaltEpisode"];
  loadGroundTruthSession: AgentEngine["loadGroundTruthSession"];
  maybeResolvePrompt: AgentEngine["maybeResolvePrompt"];
  nearestLiveHaltAncestor: AgentEngine["nearestLiveHaltAncestor"];
  observableHaltProgressSignature: AgentEngine["observableHaltProgressSignature"];
  persistPausedState: AgentEngine["persistPausedState"];
  persistPromptBlockedState: AgentEngine["persistPromptBlockedState"];
  readAgentScreen: AgentEngine["readAgentScreen"];
  readBackgroundProcessSnapshot: AgentEngine["readBackgroundProcessSnapshot"];
  resolveAgentIoRoute: AgentEngine["resolveAgentIoRoute"];
  resolveUnchangedAgentIoRoute: AgentEngine["resolveUnchangedAgentIoRoute"];
  stableSurfaceWriteOptions: AgentEngine["stableSurfaceWriteOptions"];
  transcriptHasSettledDone: AgentEngine["transcriptHasSettledDone"];
}

export function haltDwellMs(this: HaltHost, type: AgentHaltType): number {
  switch (type) {
    case "awaiting_input":
    case "paused":
      return this.haltAwaitingInputDwellMs;
    case "idle_without_done":
      return this.haltIdleWithoutDoneDwellMs;
    case "wedged":
      return this.haltWedgedDwellMs;
    case "harness_api_error":
      return 0;
  }
}

export function haltUnblockAction(this: HaltHost, agent: AgentRecord, type: AgentHaltType): string {
  switch (type) {
    case "awaiting_input":
      return (
        `read_screen(surface: "${agent.surface_id}", raw: true); after reviewing the prompt, ` +
        `send_to({mode: "key", surface: "${agent.surface_id}", text: "return"})`
      );
    case "idle_without_done":
      return `send_to({agent_id: "${agent.agent_id}", text: "Continue and report status."})`;
    case "wedged":
      return `send_to({mode: "key", surface: "${agent.surface_id}", text: "escape"})`;
    case "paused":
      return (
        `read_screen(surface: "${agent.surface_id}", parsed_only: true); ` +
        `the child is paused and cannot act — unpause the pane before send_to, ` +
        `or send_to({mode: "key", surface: "${agent.surface_id}", text: "return"}) if the screen says to resume`
      );
    case "harness_api_error":
      return `inspect the harness API error and request ID on surface ${agent.surface_id}, then retry or resume the harness turn`;
  }
}

export function hasParentVisibleArtifactSinceIdle(this: HaltHost, agent: AgentRecord): boolean {
  if (!agent.parent_agent_id || !agent.halt_last_active_at) return false;
  const idleBoundaryMs = Date.parse(agent.halt_last_active_at);
  if (!Number.isFinite(idleBoundaryMs)) return false;
  return readInbox(agent.parent_agent_id, this.inboxOpts).some(
    (message) =>
      message.reply_to === agent.agent_id && message.ts_ms >= idleBoundaryMs,
  );
}

export function isIdleSupervisor(this: HaltHost, agent: AgentRecord, _screenText: string): boolean {
  return agent.role === "orchestrator";
}

export function observableHaltProgressSignature(
  this: HaltHost,
  agent: AgentRecord,
  screenText: string,
  parsed: ParsedScreenResult,
): string {
  const materialScreen = cleanScreenText(
    screenText,
    BOOT_SESSION_CAPTURE_LINES,
  );
  const transcriptMtime = this.loadGroundTruthSession(agent)?.mtime_ms ?? 0;
  // The wait timer advances even when the background command is blocked in
  // an editor. Screen output, transcript updates, and token activity are
  // observable progress; elapsed time alone is not.
  return `${screenTextSignature(materialScreen)}:${transcriptMtime}:tokens=${parsed.token_count ?? "unknown"}`;
}

export async function readBackgroundProcessSnapshot(this: HaltHost): Promise<string | null> {
  try {
    if (this.haltProcessSnapshot) return await this.haltProcessSnapshot();
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,time=,command="], {
      encoding: "utf8",
      timeout: 250,
      maxBuffer: 2_000_000,
    });
    return stdout;
  } catch {
    return null;
  }
}

export async function backgroundChildUsedCpu(
  this: HaltHost,
  agent: AgentRecord,
  screenText: string,
  ctx: SweepAgentContext = {},
): Promise<boolean> {
  if (!/\bWait(?:ing|ed) for background terminal\s*\(/i.test(screenText) || !agent.pid) {
    this.backgroundChildCpuTimes.delete(agent.agent_id);
    return false;
  }
  const visibleLines = screenText.split(/\r?\n/).slice(-24);
  // An editor waiting for input is a known blocked command. Other busy
  // descendants of the harness cannot make that command progress.
  if (visibleLines.some((line) =>
    /^\s*(?:└\s*)?(?:git\s+commit\s+-e\b|(?:vi|vim|nvim|nano)\b|(?:EDITOR|VISUAL)\s*=)/i.test(line),
  )) {
    this.backgroundChildCpuTimes.delete(agent.agent_id);
    return false;
  }
  const waitingCommand = visibleLines
    .map((line) => line.match(/^\s*└\s*(.+)$/)?.[1]?.trim())
    .find((command): command is string => Boolean(command));
  if (!waitingCommand) return false;
  try {
    const output = ctx.sweep
      ? await (this.sweepBackgroundProcessSnapshot ??= this.readBackgroundProcessSnapshot())
      : await this.readBackgroundProcessSnapshot();
    if (output === null) return false;
    const rows = output.split("\n").map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      return match ? { pid: Number(match[1]), ppid: Number(match[2]), time: match[3], command: match[4] } : null;
    }).filter((row): row is { pid: number; ppid: number; time: string; command: string } => row !== null);
    const descendants = new Set<number>([agent.pid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
          descendants.add(row.pid);
          changed = true;
        }
      }
    }
    const commandRoot = rows.find((row) =>
      row.pid !== agent.pid &&
      descendants.has(row.pid) &&
      row.command.includes(waitingCommand),
    );
    const commandTree = new Set<number>(commandRoot ? [commandRoot.pid] : []);
    changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (commandTree.has(row.ppid) && !commandTree.has(row.pid)) {
          commandTree.add(row.pid);
          changed = true;
        }
      }
    }
    const times = new Map(rows
      .filter((row) => commandTree.has(row.pid))
      .map((row) => [row.pid, row.time] as const));
    const previous = this.backgroundChildCpuTimes.get(agent.agent_id);
    this.backgroundChildCpuTimes.set(agent.agent_id, times);
    return [...times].some(([pid, time]) =>
      previous?.has(pid)
        ? previous.get(pid) !== time
        : previous !== undefined && /[1-9]/.test(time),
    );
  } catch {
    return false;
  }
}

export function isMatureHaltEpisode(this: HaltHost, agent: AgentRecord, nowMs: number): boolean {
  if (!agent.halt_episode_type) return false;
  const startedAtMs = Date.parse(agent.halt_episode_started_at ?? "");
  return (
    Number.isFinite(startedAtMs) &&
    nowMs - startedAtMs >= this.haltDwellMs(agent.halt_episode_type) &&
    (agent.halt_episode_type !== "wedged" ||
      (agent.halt_episode_observations ?? 0) >= this.haltWedgedSweeps)
  );
}

export function clearHaltEpisode(
  this: HaltHost,
  agent: AgentRecord,
  patch: Partial<AgentRecord> = {},
): AgentRecord {
  const hasEpisodeState = Boolean(
    agent.halt_episode_type ||
    agent.halt_episode_started_at ||
    agent.halt_notification_sent_at ||
    agent.halt_notified_ancestor_id,
  );
  if (!hasEpisodeState && Object.keys(patch).length === 0) return agent;
  const updated = this.stateMgr.updateRecord(agent.agent_id, {
    halt_episode_type: null,
    halt_episode_started_at: null,
    halt_episode_observations: 0,
    halt_notification_sent_at: null,
    halt_notified_ancestor_id: null,
    halt_last_observable_action: null,
    ...patch,
  });
  this.registry.set(agent.agent_id, updated);
  return updated;
}

export function persistPromptBlockedState(
  this: HaltHost,
  agent: AgentRecord,
  blocked: boolean,
  nowIso: string,
): AgentRecord {
  if (blocked && agent.blocked_on_prompt === true) {
    return agent;
  }
  if (
    !blocked &&
    agent.blocked_on_prompt !== true &&
    agent.blocked_on_prompt_since == null
  ) {
    return agent;
  }
  const updated = this.stateMgr.updateRecord(agent.agent_id, {
    blocked_on_prompt: blocked,
    blocked_on_prompt_since: blocked
      ? (agent.blocked_on_prompt_since ?? nowIso)
      : null,
  });
  this.registry.set(agent.agent_id, updated);
  return updated;
}

export function persistPausedState(
  this: HaltHost,
  agent: AgentRecord,
  paused: boolean,
  nowIso: string,
): AgentRecord {
  const source = paused ? "inferred" : null;
  if (
    paused &&
    agent.paused === true &&
    agent.paused_source === "inferred" &&
    agent.paused_since != null
  ) {
    return agent;
  }
  if (
    !paused &&
    agent.paused !== true &&
    agent.paused_source == null &&
    agent.paused_since == null
  ) {
    return agent;
  }
  const updated = this.stateMgr.updateRecord(agent.agent_id, {
    paused,
    paused_source: source,
    paused_since: paused ? (agent.paused_since ?? nowIso) : null,
  });
  this.registry.set(agent.agent_id, updated);
  return updated;
}

export async function haltSinkQuality(
  this: HaltHost,
  candidate: AgentRecord,
  nowMs: number,
): Promise<"healthy" | "fallback" | "dead"> {
  try {
    const screen = await this.readAgentScreen(candidate, {
      lines: BOOT_SESSION_CAPTURE_LINES,
    });
    const parsed = parseScreen(screen.text);
    if (
      parsed.control_state === "shell" ||
      parsed.control_state === "dead" ||
      parsed.control_state === "stale_surface"
    ) {
      return "dead";
    }
    if (
      parsed.agent_type === "unknown" ||
      parsed.control_state === "permission_prompt" ||
      parsed.control_state === "interactive_overlay" ||
      parsed.paused === true ||
      this.isMatureHaltEpisode(candidate, nowMs)
    ) {
      return "fallback";
    }
    return "healthy";
  } catch {
    // A known agent inbox remains a best-effort sink even when screen proof
    // is unavailable. Registry observability does not depend on this write.
    return "fallback";
  }
}

export async function fleetHaltSink(
  this: HaltHost,
  agent: AgentRecord,
  nowMs: number,
  visited: ReadonlySet<string>,
): Promise<AgentRecord | null> {
  const candidates = this.registry
    .list()
    .filter(
      (candidate) =>
        candidate.agent_id !== agent.agent_id &&
        !visited.has(candidate.agent_id) &&
        !candidate.parent_agent_id,
    )
    .sort((left, right) => {
      const leftScore =
        (left.role === "orchestrator" ? 2 : 0) +
        (left.surface_provenance === "cmuxlayer_spawn" ? 1 : 0);
      const rightScore =
        (right.role === "orchestrator" ? 2 : 0) +
        (right.surface_provenance === "cmuxlayer_spawn" ? 1 : 0);
      return (
        rightScore - leftScore || left.agent_id.localeCompare(right.agent_id)
      );
    });
  const bestSink = async (
    scoped: AgentRecord[],
  ): Promise<AgentRecord | null> => {
    let fallback: AgentRecord | null = null;
    for (const candidate of scoped) {
      const quality = await this.haltSinkQuality(candidate, nowMs);
      if (quality === "healthy") return candidate;
      if (quality === "fallback" && !fallback) fallback = candidate;
    }
    return fallback;
  };
  const sameWorkspace = candidates.filter(
    (candidate) => candidate.workspace_id === agent.workspace_id,
  );
  const scopedSink = await bestSink(sameWorkspace);
  if (scopedSink) return scopedSink;
  return bestSink(
    candidates.filter(
      (candidate) => candidate.workspace_id !== agent.workspace_id,
    ),
  );
}

export async function nearestLiveHaltAncestor(
  this: HaltHost,
  agent: AgentRecord,
  nowMs: number,
): Promise<HaltSinkResolution> {
  const visited = new Set<string>([agent.agent_id]);
  let fallback: AgentRecord | null = null;
  let ancestorId = agent.parent_agent_id;
  while (ancestorId && !visited.has(ancestorId)) {
    visited.add(ancestorId);
    const ancestor =
      this.registry.get(ancestorId) ?? this.stateMgr.readState(ancestorId);
    if (!ancestor) break;
    const quality = await this.haltSinkQuality(ancestor, nowMs);
    if (quality === "healthy") return { sink: ancestor, fallback: false };
    if (quality === "fallback") fallback = ancestor;
    ancestorId = ancestor.parent_agent_id;
  }
  if (fallback) return { sink: fallback, fallback: true };
  return {
    sink: await this.fleetHaltSink(agent, nowMs, visited),
    fallback: true,
  };
}

export function appendHaltEscalationEvent(
  this: HaltHost,
  agent: AgentRecord,
  haltType: AgentHaltType,
  outcome:
    | "ancestor_dispatched"
    | "fallback_dispatched"
    | "undeliverable"
    | "dispatch_failed",
  sinkAgentId: string | null,
  error: string | null,
  nowIso: string,
): void {
  try {
    this.stateMgr.getEventLog().appendAgentHaltEscalation({
      ts: nowIso,
      event_type: "agent_halt_escalation",
      agent_id: agent.agent_id,
      surface_id: agent.surface_id,
      parent_agent_id: agent.parent_agent_id,
      halt_type: haltType,
      outcome,
      sink_agent_id: sinkAgentId,
      missing_ancestor_count: agent.halt_missing_ancestor_count ?? 0,
      delivery_failure_count: agent.halt_delivery_failure_count ?? 0,
      error,
    });
  } catch (eventError) {
    console.error(
      "[cmuxlayer] failed to log halt escalation outcome:",
      eventError,
    );
  }
}

export function appendResolvedPromptEvent(this: HaltHost, input: {
  agent: AgentRecord;
  disposition: Extract<PromptDisposition, { kind: "resolve" }>;
  beforeControlState: ParsedScreenResult["control_state"];
  afterControlState: ParsedScreenResult["control_state"] | null;
  screenText: string;
  outcome: "recovered" | "failed";
  error: string | null;
  nowIso: string;
}): boolean {
  const excerptSource = cleanScreenText(input.screenText, 8);
  if (
    !isPromptResolutionAuditSafe(input.screenText, input.agent.cli) ||
    containsPromptApprovalChooser(excerptSource)
  ) {
    return false;
  }
  const excerpt = excerptSource.replace(/\s+/g, " ").trim().slice(0, 240);
  this.stateMgr.getEventLog().appendResolvedPrompt({
    ts: input.nowIso,
    event_type: "resolved_prompt",
    agent_id: input.agent.agent_id,
    surface_id: input.agent.surface_id,
    workspace_id: input.agent.workspace_id ?? null,
    prompt_type: input.disposition.prompt_type,
    key_sent: input.disposition.key,
    outcome: input.outcome,
    before_control_state: input.beforeControlState,
    after_control_state: input.afterControlState,
    screen_signature: screenTextSignature(input.screenText),
    screen_excerpt: excerpt,
    error: input.error,
  });
  return true;
}

export async function maybeResolvePrompt(
  this: HaltHost,
  agent: AgentRecord,
  screenText: string,
  disposition: Extract<PromptDisposition, { kind: "resolve" }>,
  nowIso: string,
  ctx: SweepAgentContext = {},
): Promise<{ agent: AgentRecord; recovered: boolean }> {
  if (!this.assertSweepInputCurrent(ctx)) return { agent, recovered: false };
  const signature = screenTextSignature(screenText);
  if (this.promptResolutionFailures.get(agent.agent_id) === signature) {
    return { agent, recovered: false };
  }
  if (
    !isPromptResolutionAuditSafe(screenText, agent.cli) ||
    containsPromptApprovalChooser(cleanScreenText(screenText, 8))
  ) {
    this.promptResolutionFailures.set(agent.agent_id, signature);
    return { agent, recovered: false };
  }

  const before = parseScreen(screenText);
  let afterControlState: ParsedScreenResult["control_state"] | null = null;
  let error: string | null = null;
  try {
    const route = await this.resolveAgentIoRoute(agent.agent_id);
    if (!this.assertSweepInputCurrent(ctx))
      return { agent, recovered: false };
    const assertSurfaceBindingCurrent = async (): Promise<void> => {
      await this.resolveUnchangedAgentIoRoute(
        agent.agent_id,
        route,
        "prompt resolution",
      );
    };
    if (!this.assertSweepInputCurrent(ctx)) {
      return { agent, recovered: false };
    }
    await this.client.sendKey(route.surface_id, disposition.key, {
      workspace: route.workspace_id ?? undefined,
      ...this.stableSurfaceWriteOptions(route.surface_uuid),
      beforeMutation: assertSurfaceBindingCurrent,
    });
    await assertSurfaceBindingCurrent();
    const afterScreen = await this.client.readScreen(route.surface_id, {
      lines: BOOT_SESSION_CAPTURE_LINES,
      workspace: route.workspace_id ?? undefined,
    });
    await assertSurfaceBindingCurrent();
    if (!this.assertSweepInputCurrent(ctx)) {
      return { agent, recovered: false };
    }
    const after = parseScreen(afterScreen.text);
    afterControlState = after.control_state;
    const recovered =
      after.control_state === "ready" || after.control_state === "busy";
    if (!recovered) {
      error = `prompt remained ${after.control_state} after Escape`;
      this.promptResolutionFailures.set(agent.agent_id, signature);
    } else {
      this.promptResolutionFailures.delete(agent.agent_id);
    }
    const auditWritten = this.appendResolvedPromptEvent({
      agent,
      disposition,
      beforeControlState: before.control_state,
      afterControlState,
      screenText,
      outcome: recovered ? "recovered" : "failed",
      error,
      nowIso,
    });
    if (!auditWritten) {
      this.promptResolutionFailures.set(agent.agent_id, signature);
      return { agent, recovered: false };
    }
    if (!recovered) return { agent, recovered: false };

    agent = this.persistPromptBlockedState(agent, false, nowIso);
    return { agent: this.clearHaltEpisode(agent), recovered: true };
  } catch (cause) {
    if (!this.assertSweepInputCurrent(ctx)) {
      return { agent, recovered: false };
    }
    error = cause instanceof Error ? cause.message : String(cause);
    this.promptResolutionFailures.set(agent.agent_id, signature);
    this.appendResolvedPromptEvent({
      agent,
      disposition,
      beforeControlState: before.control_state,
      afterControlState,
      screenText,
      outcome: "failed",
      error,
      nowIso,
    });
    return { agent, recovered: false };
  }
}

export async function maybeEscalateLiveHalt(
  this: HaltHost,
  agent: AgentRecord,
  screenText: string,
  ctx: SweepAgentContext = {},
): Promise<AgentRecord> {
  if (!this.assertSweepInputCurrent(ctx)) return agent;
  const nowMs = this.haltNow();
  const nowIso = new Date(nowMs).toISOString();
  const parsed = parseScreen(screenText);
  let disposition = classifyPromptDisposition(screenText, agent.cli);
  if (disposition.kind === "resolve" && this.autoResolvePrompts) {
    const resolution = await this.maybeResolvePrompt(
      agent,
      screenText,
      disposition,
      nowIso,
      ctx,
    );
    if (!this.assertSweepInputCurrent(ctx)) return agent;
    agent = resolution.agent;
    if (resolution.recovered) return agent;
    disposition = {
      kind: "escalate",
      prompt_type: "human_or_unknown_chooser",
    };
  } else if (disposition.kind === "resolve") {
    disposition = {
      kind: "escalate",
      prompt_type: "human_or_unknown_chooser",
    };
  } else {
    this.promptResolutionFailures.delete(agent.agent_id);
  }
  const progressSignature = this.observableHaltProgressSignature(
    agent,
    screenText,
    parsed,
  );
  const backgroundChildUsedCpu = await this.backgroundChildUsedCpu(agent, screenText, ctx);
  const hasVisibleProgress = hasVisibleAgentProgress(screenText, agent.cli);
  const canObservePromptMotion =
    disposition.kind === "escalate" &&
    disposition.prompt_type === "human_or_unknown_chooser" &&
    isBlockingPromptChooserScreen(screenText) &&
    hasVisibleProgress;
  const promptScreenSignature = /\bWait(?:ing|ed) for background terminal\s*\(/i.test(screenText)
    ? `${progressSignature}:${backgroundChildUsedCpu ? nowMs : ""}`
    : screenTextSignature(screenText);
  const previousPromptScreenSignature = this.promptMotionScreenSignatures.get(
    agent.agent_id,
  );
  const promptScreenChanged =
    canObservePromptMotion &&
    previousPromptScreenSignature !== undefined &&
    previousPromptScreenSignature !== promptScreenSignature;
  if (canObservePromptMotion) {
    this.promptMotionScreenSignatures.set(
      agent.agent_id,
      promptScreenSignature,
    );
  } else {
    this.promptMotionScreenSignatures.delete(agent.agent_id);
  }
  if (promptScreenChanged) {
    this.promptMotionObservedAtMs.set(agent.agent_id, nowMs);
  } else if (!canObservePromptMotion) {
    this.promptMotionObservedAtMs.delete(agent.agent_id);
  }
  const motionObservedAt = this.promptMotionObservedAtMs.get(agent.agent_id);
  const hasObservedPromptMotion =
    disposition.kind === "escalate" &&
    disposition.prompt_type === "human_or_unknown_chooser" &&
    isBlockingPromptChooserScreen(screenText) &&
    hasVisibleProgress &&
    motionObservedAt !== undefined &&
    nowMs - motionObservedAt < PROMPT_MOTION_GRACE_MS;
  if (hasObservedPromptMotion) {
    agent = this.persistPromptBlockedState(agent, false, nowIso);
    return this.clearHaltEpisode(agent, {
      halt_last_active_at: nowIso,
      halt_last_progress_at_ms: nowMs,
      halt_last_progress_signature: progressSignature,
    });
  }
  agent = this.persistPromptBlockedState(
    agent,
    disposition.kind === "escalate",
    nowIso,
  );
  agent = this.persistPausedState(agent, parsed.paused === true, nowIso);
  if (agent.halt_escalation === false) return agent;
  const hasHarnessApiError = parsed.errors.some((error) =>
    error.startsWith("harness_api_error:"),
  );
  if (
    !hasHarnessApiError &&
    parsed.paused !== true &&
    (parsed.control_state === "shell" ||
      parsed.control_state === "dead" ||
      parsed.control_state === "stale_surface" ||
      this.hasOutputDoneEvidence(agent.cli, screenText) ||
      this.hasCurrentRecordedOutputDoneEvidence(agent) ||
      (agent.cli === "codex" && this.transcriptHasSettledDone(agent)) ||
      (parsed.status === "idle" &&
        parsed.control_state === "ready" &&
        this.hasParentVisibleArtifactSinceIdle(agent)))
  ) {
    const hasProgressMemory = Boolean(
      agent.halt_last_active_at ||
      agent.halt_last_progress_at_ms ||
      agent.halt_last_progress_signature,
    );
    return this.clearHaltEpisode(
      agent,
      hasProgressMemory
        ? {
            halt_last_active_at: null,
            halt_last_progress_at_ms: null,
            halt_last_progress_signature: null,
          }
        : {},
    );
  }

  const screenActive =
    parsed.status === "working" || parsed.status === "thinking";
  let haltType: AgentHaltType | null = null;
  let episodeStartedAtMs = nowMs;
  if (hasHarnessApiError) {
    haltType = "harness_api_error";
  } else if (
    parsed.control_state === "permission_prompt" ||
    parsed.control_state === "interactive_overlay"
  ) {
    haltType = "awaiting_input";
  } else if (parsed.paused === true) {
    haltType = "paused";
  } else if (screenActive) {
    const previousSignature = agent.halt_last_progress_signature;
    const signatureWithoutTokens = (signature: string) =>
      signature.replace(/:tokens=(?:\d+|unknown)$/, "");
    const previousTokenCount = previousSignature?.match(/:tokens=(\d+)$/)?.[1];
    const tokenGrowth =
      parsed.token_count !== null &&
      previousTokenCount !== undefined &&
      parsed.token_count > Number(previousTokenCount);
    if (
      !previousSignature ||
      signatureWithoutTokens(previousSignature) !==
        signatureWithoutTokens(progressSignature) ||
      tokenGrowth ||
      backgroundChildUsedCpu
    ) {
      return this.clearHaltEpisode(agent, {
        halt_last_active_at: nowIso,
        halt_last_progress_at_ms: nowMs,
        halt_last_progress_signature: progressSignature,
      });
    } else {
      haltType = "wedged";
      episodeStartedAtMs = agent.halt_last_progress_at_ms ?? nowMs;
    }
  } else if (
    parsed.status === "idle" &&
    parsed.control_state === "ready" &&
    parsed.agent_type !== "unknown" &&
    !this.isIdleSupervisor(agent, screenText) &&
    agent.halt_last_active_at
  ) {
    haltType = "idle_without_done";
  }
  if (!haltType) return this.clearHaltEpisode(agent);
  const harnessApiError = parsed.errors.find((error) =>
    error.startsWith("harness_api_error:"),
  );
  const haltObservableAction =
    haltType === "harness_api_error"
      ? (harnessApiError ?? parsed.current_action ?? haltType)
      : (parsed.current_action ?? harnessApiError ?? haltType);
  const harnessRequestId = (value: string | null | undefined): string | null =>
    value?.match(/\brequest_id=(req_[A-Za-z0-9]+)/i)?.[1] ?? null;

  let episode = agent;
  if (!agent.halt_episode_type) {
    episode = this.stateMgr.updateRecord(agent.agent_id, {
      halt_episode_type: haltType,
      halt_episode_started_at: new Date(episodeStartedAtMs).toISOString(),
      halt_episode_observations: 1,
      halt_notification_sent_at: null,
      halt_notified_ancestor_id: null,
      halt_fallback_sink_id: null,
      halt_last_delivery_error: null,
      halt_last_observable_action: haltObservableAction,
    });
    this.registry.set(agent.agent_id, episode);
    if (haltType !== "harness_api_error") return episode;
    agent = episode;
  }
  if (agent.halt_episode_type !== haltType) {
    episode = this.stateMgr.updateRecord(agent.agent_id, {
      halt_episode_type: haltType,
      halt_episode_started_at: nowIso,
      halt_episode_observations: 1,
      halt_notification_sent_at: null,
      halt_notified_ancestor_id: null,
      halt_fallback_sink_id: null,
      halt_last_delivery_error: null,
      halt_last_observable_action: haltObservableAction,
    });
    this.registry.set(agent.agent_id, episode);
    if (haltType !== "harness_api_error") return episode;
    agent = episode;
  }
  if (haltType === "wedged") {
    episode = this.stateMgr.updateRecord(agent.agent_id, {
      halt_episode_observations: (agent.halt_episode_observations ?? 0) + 1,
      halt_last_observable_action: haltObservableAction,
    });
    this.registry.set(agent.agent_id, episode);
  } else if (
    haltType === "harness_api_error" &&
    agent.halt_last_observable_action !== haltObservableAction
  ) {
    const sameRequestId =
      harnessRequestId(agent.halt_last_observable_action) !== null &&
      harnessRequestId(agent.halt_last_observable_action) ===
        harnessRequestId(haltObservableAction);
    episode = this.stateMgr.updateRecord(
      agent.agent_id,
      sameRequestId
        ? { halt_last_observable_action: haltObservableAction }
        : {
            halt_episode_started_at: nowIso,
            halt_episode_observations: 1,
            halt_notification_sent_at: null,
            halt_notified_ancestor_id: null,
            halt_fallback_sink_id: null,
            halt_last_delivery_error: null,
            halt_last_observable_action: haltObservableAction,
          },
    );
    this.registry.set(agent.agent_id, episode);
  }
  if (episode.halt_notification_sent_at) return episode;

  const startedAtMs = Date.parse(episode.halt_episode_started_at ?? "");
  if (
    !Number.isFinite(startedAtMs) ||
    nowMs - startedAtMs < this.haltDwellMs(haltType) ||
    (haltType === "wedged" &&
      (episode.halt_episode_observations ?? 0) < this.haltWedgedSweeps)
  ) {
    return episode;
  }
  const resolution = await this.nearestLiveHaltAncestor(episode, nowMs);
  if (!this.assertSweepInputCurrent(ctx)) return agent;
  if (resolution.fallback) {
    episode = this.stateMgr.updateRecord(episode.agent_id, {
      halt_missing_ancestor_count:
        (episode.halt_missing_ancestor_count ?? 0) + 1,
      halt_fallback_sink_id: resolution.sink?.agent_id ?? null,
      halt_last_delivery_error: resolution.sink
        ? null
        : "no halt escalation sink available",
    });
    this.registry.set(episode.agent_id, episode);
  }
  const ancestor = resolution.sink;
  if (!ancestor) {
    this.appendHaltEscalationEvent(
      episode,
      haltType,
      "undeliverable",
      null,
      episode.halt_last_delivery_error ?? "no halt escalation sink available",
      nowIso,
    );
    return episode;
  }
  const resumeCommand = episode.cli_session_id
    ? (rawResumeCommandOrNull(
        episode.cli,
        episode.repo,
        episode.cli_session_id,
      ) ?? `no raw ${episode.cli} resume form; inspect the live surface`)
    : "no captured session; inspect the live surface";
  const durationSeconds = Math.max(
    0,
    Math.floor((nowMs - startedAtMs) / 1_000),
  );
  const unblockAction = this.haltUnblockAction(episode, haltType);
  try {
    dispatchOnce(
      ancestor.agent_id,
      {
        id: `agent-halt:${episode.agent_id}:${episode.halt_episode_started_at}`,
        from: "cmuxlayer:lifecycle",
        to: ancestor.agent_id,
        tag: `agent_halt_${haltType}`,
        task:
          `Agent ${episode.agent_id} in surface ${episode.surface_id} has remained ` +
          `${haltType} for ${durationSeconds}s. Last observable action: ` +
          `${episode.halt_last_observable_action ?? "unknown"}. ` +
          `Exact unblock action: ${unblockAction}. ` +
          `Session resume fallback: ${resumeCommand}`,
      },
      this.inboxOpts,
    );
    const notified = this.stateMgr.updateRecord(episode.agent_id, {
      halt_notification_sent_at: nowIso,
      halt_notified_ancestor_id: ancestor.agent_id,
      halt_last_delivery_error: null,
    });
    this.registry.set(episode.agent_id, notified);
    this.appendHaltEscalationEvent(
      notified,
      haltType,
      resolution.fallback ? "fallback_dispatched" : "ancestor_dispatched",
      ancestor.agent_id,
      null,
      nowIso,
    );
    return notified;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = this.stateMgr.updateRecord(episode.agent_id, {
      halt_delivery_failure_count:
        (episode.halt_delivery_failure_count ?? 0) + 1,
      halt_last_delivery_error: message,
    });
    this.registry.set(episode.agent_id, failed);
    this.appendHaltEscalationEvent(
      failed,
      haltType,
      "dispatch_failed",
      ancestor.agent_id,
      message,
      nowIso,
    );
    return failed;
  }
}
