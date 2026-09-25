/**
 * Input delivery policy: send/boot/launch timing constants, terminal input
 * chunking and UTF-8 batching, paste policy, and the inline/multiline/dense/
 * spawn-prompt/broadcast input guards. Moved verbatim from server.ts (CX-2 S4);
 * imports nothing from the server.
 */

import { AGENT_HEALTH_MONITOR_MAX_AGE_MS } from "../agent-health-input.js";
import type {
  AgentRecord,
  AgentRole,
  CliType,
} from "../agent-types.js";
import {
  inferAgentRole,
  inferRecordRoleOrNull,
  isAgentRoleInferenceError,
  launcherNameForCli,
} from "../layout-policy.js";
import { hasInlinePrompt } from "./composer-screen.js";
import type { BroadcastRole } from "./receipts.js";

export const SEND_INPUT_CHUNK_THRESHOLD = 500;

export const DENSE_INLINE_POLICY_MAX_UNBROKEN_CHARS =
  3 * SEND_INPUT_CHUNK_THRESHOLD;

export const BOOT_PROMPT_PATH_WARNING_CHARS = 500;

export const DEFAULT_SEND_INPUT_MAX_INLINE_CHARS = 1_800;

export const PANE_INPUT_BREAKAGE_GUIDANCE =
  "Max 2-3 short lines. Longer payloads BREAK the receiving pane — write the payload to a file and send one line: `Read and follow <path>`.";

export const ZSH_BANG_INLINE_WARNING =
  "WARNING — a `!` in an inline brief may be consumed by zsh history expansion before it reaches the worker, leaving the worker idle with no task; file-backed payloads avoid that shell interpretation.";

export const SEND_INPUT_PASTE_BATCH_MAX_BYTES = 16_000;

export const SEND_INPUT_CHUNK_DELAY_MS = 5;

export const SEND_INPUT_RETRY_ATTEMPTS = 3;

export const SEND_INPUT_RETRY_DELAY_MS = 25;

export const SEND_INPUT_ENTER_DELAY_MS = 50;

export const SEND_INPUT_RECOVERY_ENTER_DELAY_MS = 150;

export const DEFAULT_SEND_INPUT_SUBMIT_VERIFY_TIMEOUT_MS = 5000;

// CLI fallback paste acknowledgement can precede the Claude composer repaint.
// Keep a short budget for surfaces that never paint the owned payload.
export const BOOT_PAYLOAD_OBSERVE_TIMEOUT_MS = 250;

export const BOOT_PAYLOAD_OBSERVE_AGY_TIMEOUT_MS = 3_000;

export const BOOT_PAYLOAD_OBSERVE_AGY_POLL_MS = 250;

export function parsePositiveIntegerMs(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const SEND_INPUT_SUBMIT_VERIFY_TIMEOUT_MS = parsePositiveIntegerMs(
  process.env.CMUXLAYER_SUBMIT_VERIFY_TIMEOUT_MS,
  DEFAULT_SEND_INPUT_SUBMIT_VERIFY_TIMEOUT_MS,
);

export function parseMaxInlineChars(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= SEND_INPUT_CHUNK_THRESHOLD
    ? parsed
    : fallback;
}

export const SEND_INPUT_MAX_INLINE_CHARS = parseMaxInlineChars(
  process.env.CMUXLAYER_MAX_INLINE_CHARS,
  DEFAULT_SEND_INPUT_MAX_INLINE_CHARS,
);

export const SEND_INPUT_SUBMIT_VERIFY_POLL_MS = 100;

export const SHORT_POINTER_MAX_CHARS = 200;

export const SHORT_POINTER_SUBMIT_VERIFY_TIMEOUT_MS = 750;

// A bare submit key either takes effect on the next render or it did not take
// effect at all -- there is no chunked typing to wait out, so the key path uses
// a much shorter verification window than the text path (#484).
export const SEND_KEY_SUBMIT_VERIFY_TIMEOUT_MS = 1500;

// Busy relays are interjections into an already-running UI. Observe several
// repaint frames, accept a correlated TUI queue, and bound exact-composer
// recovery so fleet fan-out does not inherit the general 5s timeout.
export const BUSY_AGENT_SUBMIT_VERIFY_TIMEOUT_MS = 1_000;

export const CODEX_PENDING_COMPOSER_RETRY_OBSERVE_MS = 250;

export const CLAUDE_PENDING_COMPOSER_RETRY_OBSERVE_MS = 4_000;

export const CURSOR_FOLLOWUP_RETRY_OBSERVE_MS = 250;

export const SEND_INPUT_SAFE_RETRY_OBSERVE_MS = 2500;

export const SEND_INPUT_POST_RETRY_VERIFY_GRACE_MS = 300;

export const BOOT_PROMPT_READY_POLL_MS = 250;

export const BOOT_PROMPT_UPDATE_MAX_MS = 120_000;

export const BOOT_PROMPT_UPDATE_RELAUNCH_MAX = 2;

export const BOOT_PROMPT_UPDATE_MENU_DISMISS_GRACE_MS = BOOT_PROMPT_READY_POLL_MS * 3;

export const BOOT_PROMPT_POST_UPDATE_READY_GRACE_MS = BOOT_PROMPT_READY_POLL_MS * 3;

export function bootPromptUpdateMaxMs(): number {
  const raw = Number(process.env.CMUXLAYER_BOOT_PROMPT_UPDATE_MAX_MS);
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : BOOT_PROMPT_UPDATE_MAX_MS;
}

export const LAUNCH_SHELL_READY_TIMEOUT_MS = 10_000;

export const LAUNCH_SHELL_READY_POLL_MS = 100;

export const LAUNCH_SHELL_JUNK_CLEAR_INTERVAL_MS = 2_500;

export const LAUNCH_SHELL_JUNK_CLEAR_MAX = 3;

export const LAUNCH_SUBMIT_READY_TIMEOUT_MS = 15_000;

export const LAUNCHER_LINE_CORRUPTION_RECOVERY_ATTEMPTS = 2;

export const LAUNCHER_LINE_CORRUPTION_ERROR =
  "launcher line corrupted by external input; manual Enter may have executed a modified command";

/** Heartbeat freshness window before dispatch_to_agent falls back to a surface nudge. */
export const INBOX_NUDGE_HEARTBEAT_MAX_AGE_MS = AGENT_HEALTH_MONITOR_MAX_AGE_MS;

export const READY_PATTERN_CLIS: CliType[] = [
  "claude",
  "codex",
  "gemini",
  "kiro",
  "cursor",
];

export function chunkTerminalInput(text: string, chunkSize: number): string[] {
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

export function limitInputChunksByUtf8ByteSize(
  chunks: string[],
  maxBytes = SEND_INPUT_PASTE_BATCH_MAX_BYTES,
): string[] {
  return chunks.flatMap((chunk) =>
    Buffer.byteLength(chunk, "utf-8") > maxBytes
      ? splitTextByUtf8ByteLimit(chunk, maxBytes)
      : [chunk],
  );
}

export interface InputDeliveryBatch {
  text: string;
  firstChunkNumber: number;
  deliveredChunkCounts: number[];
}

export function splitTextByUtf8ByteLimit(
  text: string,
  maxBytes: number,
): string[] {
  if (text.length === 0) {
    return [text];
  }

  const parts: string[] = [];
  let current = "";
  let currentBytes = 0;

  for (const char of text) {
    const charBytes = Buffer.byteLength(char, "utf-8");
    if (current && currentBytes + charBytes > maxBytes) {
      parts.push(current);
      current = char;
      currentBytes = charBytes;
      continue;
    }

    current += char;
    currentBytes += charBytes;
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}

export function buildInputDeliveryBatches(
  chunks: string[],
  maxPasteBytes = SEND_INPUT_PASTE_BATCH_MAX_BYTES,
): InputDeliveryBatch[] {
  const batches: InputDeliveryBatch[] = [];
  let pendingText = "";
  let pendingBytes = 0;
  let pendingFirstChunkNumber = 1;
  let pendingDeliveredChunkCounts: number[] = [];

  const flushPending = () => {
    if (pendingDeliveredChunkCounts.length === 0) {
      return;
    }

    batches.push({
      text: pendingText,
      firstChunkNumber: pendingFirstChunkNumber,
      deliveredChunkCounts: pendingDeliveredChunkCounts,
    });
    pendingText = "";
    pendingBytes = 0;
    pendingDeliveredChunkCounts = [];
  };

  for (const [index, chunk] of chunks.entries()) {
    const chunkNumber = index + 1;
    const chunkBytes = Buffer.byteLength(chunk, "utf-8");

    if (chunkBytes > maxPasteBytes) {
      flushPending();
      const parts = splitTextByUtf8ByteLimit(chunk, maxPasteBytes);
      for (const [partIndex, part] of parts.entries()) {
        batches.push({
          text: part,
          firstChunkNumber: chunkNumber,
          deliveredChunkCounts:
            partIndex === parts.length - 1 ? [chunkNumber] : [],
        });
      }
      continue;
    }

    if (
      pendingDeliveredChunkCounts.length > 0 &&
      pendingBytes + chunkBytes > maxPasteBytes
    ) {
      flushPending();
    }

    if (pendingDeliveredChunkCounts.length === 0) {
      pendingFirstChunkNumber = chunkNumber;
    }
    pendingText += chunk;
    pendingBytes += chunkBytes;
    pendingDeliveredChunkCounts.push(chunkNumber);
  }

  flushPending();
  return batches;
}

export function shouldPasteInputChunk(text: string, totalChunks: number): boolean {
  return totalChunks > 1 || /[\n\r\t]|\\[nrt]/.test(text);
}

export function shouldPasteInputDelivery(
  chunks: string[],
  deliveryBatchCount: number,
): boolean {
  return (
    chunks.length > 1 ||
    deliveryBatchCount > 1 ||
    chunks.some((chunk) => shouldPasteInputChunk(chunk, 1))
  );
}

export function isMethodNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    String((error as { code?: unknown }).code) === "method_not_found"
  );
}

export function pasteRequiredError(reason: string): Error {
  if (reason.startsWith("paste delivery is required")) {
    return new Error(reason);
  }
  return new Error(
    `paste delivery is required for chunked or multiline input: ${reason}. No Return key was sent. Write the payload to a file and send "Read and follow <path>"; for launcher boot prompts, pass boot_prompt_path.`,
  );
}

export const MULTILINE_INLINE_AGENT_CLIS = new Set<CliType>([
  "codex",
  "claude",
  "cursor",
  "gemini",
]);

export function assertInteractiveMultilineInputAllowed(opts: {
  tool:
    | "send_input"
    | "send_to"
    | "send_to_agent"
    | "spawn_agent"
    | "new_worktree_split"
    | "spawn_in_workspace";
  arg?: "text" | "prompt";
  value: string | undefined;
  cli: CliType | undefined;
  allowLongInline?: boolean;
  allowLongInlineSupported?: boolean;
}): void {
  if (
    opts.allowLongInline ||
    !opts.value ||
    !opts.cli ||
    !MULTILINE_INLINE_AGENT_CLIS.has(opts.cli) ||
    !/\r?\n[\t ]*\r?\n/.test(opts.value)
  ) {
    return;
  }

  const overrideGuidance =
    opts.allowLongInlineSupported === false
      ? ""
      : " To deliberately bypass this guard, pass allow_long_inline:true.";
  throw new Error(
    `${opts.tool}${opts.arg ? `.${opts.arg}` : ""} refuses multi-paragraph inline text for an interactive ${opts.cli} composer because paragraph breaks can become separate submitted messages. Write the payload to a file and send "Read and follow <path>" instead; for launcher boot prompts, pass boot_prompt_path.${overrideGuidance}`,
  );
}

export function getBootPromptPath(value: string | null | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function assertInlineInputAllowed(opts: {
  tool:
    | "send_input"
    | "send_command"
    | "spawn_agent"
    | "new_worktree_split"
    | "spawn_in_workspace"
    | "send_to"
    | "send_to_agent";
  arg: "text" | "command" | "prompt";
  value: string | undefined;
  allowLongInline?: boolean;
  allowLongInlineSupported?: boolean;
}): void {
  if (
    opts.allowLongInline ||
    opts.value === undefined ||
    opts.value.length <= SEND_INPUT_MAX_INLINE_CHARS
  ) {
    return;
  }

  const argName = `${opts.tool}.${opts.arg}`;
  const promptPathGuidance =
    opts.arg === "prompt" || opts.tool === "send_command"
      ? " For launcher boot prompts, put the full prompt in a file and pass boot_prompt_path."
      : " For launchers, put the full boot prompt in a file and pass boot_prompt_path.";
  const overrideGuidance =
    opts.allowLongInlineSupported === false
      ? ""
      : " To deliberately send raw inline text, pass allow_long_inline:true.";
  throw new Error(
    `${argName} is ${opts.value.length} characters, above CMUXLAYER_MAX_INLINE_CHARS=${SEND_INPUT_MAX_INLINE_CHARS}. Pane keystrokes are capped to one-line pointers: write the payload to a file and send "Read and follow <path>" instead.${promptPathGuidance}${overrideGuidance} CMUXLAYER_MAX_INLINE_CHARS may be set to a positive integer >= ${SEND_INPUT_CHUNK_THRESHOLD}.`,
  );
}

export function assertDenseInlineInputAllowed(opts: {
  tool:
    | "send_input"
    | "send_command"
    | "spawn_agent"
    | "new_worktree_split"
    | "spawn_in_workspace"
    | "send_to"
    | "send_to_agent"
    | "broadcast";
  arg: "text" | "command" | "prompt";
  value: string | undefined;
  allowLongInline?: boolean;
  allowLongInlineSupported?: boolean;
}): void {
  if (opts.allowLongInline || opts.value === undefined) {
    return;
  }

  const inputCharacterCount = Array.from(opts.value).length;
  const longestUnbrokenRun = opts.value
    .split(/\r?\n/)
    .reduce((longest, line) => Math.max(longest, Array.from(line).length), 0);
  if (longestUnbrokenRun <= DENSE_INLINE_POLICY_MAX_UNBROKEN_CHARS) {
    return;
  }

  const argName = `${opts.tool}.${opts.arg}`;
  const overrideGuidance =
    opts.tool === "broadcast" || opts.allowLongInlineSupported === false
      ? ""
      : " To deliberately send raw inline text, pass allow_long_inline:true.";
  throw new Error(
    `${argName} is ${inputCharacterCount} characters and its longest unbroken run is ${longestUnbrokenRun}, above the dense inline routing policy threshold ${DENSE_INLINE_POLICY_MAX_UNBROKEN_CHARS}. Long dense payloads belong in a file: write the payload to a file and send one line: "Read and follow <path>".` +
      overrideGuidance,
  );
}

export function assertSpawnPromptInputAllowed(opts: {
  tool: "spawn_agent" | "new_worktree_split" | "spawn_in_workspace";
  value: string | undefined;
  cli: CliType;
  allowLongInline?: boolean;
  allowLongInlineSupported?: boolean;
}): void {
  assertInlineInputAllowed({
    tool: opts.tool,
    arg: "prompt",
    value: opts.value,
    allowLongInline: opts.allowLongInline,
    allowLongInlineSupported: opts.allowLongInlineSupported,
  });
  assertDenseInlineInputAllowed({
    tool: opts.tool,
    arg: "prompt",
    value: opts.value,
    allowLongInline: opts.allowLongInline,
    allowLongInlineSupported: opts.allowLongInlineSupported,
  });
  assertInteractiveMultilineInputAllowed({
    tool: opts.tool,
    arg: "prompt",
    value: opts.value,
    cli: opts.cli,
    allowLongInline: opts.allowLongInline,
    allowLongInlineSupported: opts.allowLongInlineSupported,
  });
}

export function assertBroadcastInlineInputAllowed(text: string): void {
  if (text.length > SEND_INPUT_MAX_INLINE_CHARS) {
    throw new Error(
      `broadcast.text is ${text.length} characters, above CMUXLAYER_MAX_INLINE_CHARS=${SEND_INPUT_MAX_INLINE_CHARS}. ` +
        `Broadcasts are capped to one-line pointers: write the payload to a file and broadcast "Read and follow <path>" instead. ` +
        `CMUXLAYER_MAX_INLINE_CHARS may be set to a positive integer >= ${SEND_INPUT_CHUNK_THRESHOLD}.`,
    );
  }

  assertDenseInlineInputAllowed({
    tool: "broadcast",
    arg: "text",
    value: text,
  });
}

export function broadcastRoleMatches(
  requestedRole: BroadcastRole,
  agentRole: AgentRole | null,
): boolean {
  if (requestedRole === "all") return true;
  if (requestedRole === "workers") return agentRole === "worker";
  return agentRole === "orchestrator";
}

export function inferBroadcastRecordRole(agent: AgentRecord): AgentRole | null {
  try {
    return inferAgentRole({
      role: agent.role,
      cli: agent.cli,
      launcherName:
        agent.launcher_name ?? launcherNameForCli(agent.repo, agent.cli),
      title: agent.task_summary,
    });
  } catch (error) {
    if (isAgentRoleInferenceError(error)) {
      return inferRecordRoleOrNull(agent);
    }
    throw error;
  }
}

export function assertBootPromptMode(
  prompt: string | undefined,
  bootPromptPath: string | null,
): void {
  if (hasInlinePrompt(prompt) && bootPromptPath) {
    throw new Error("prompt and boot_prompt_path are mutually exclusive");
  }
}
