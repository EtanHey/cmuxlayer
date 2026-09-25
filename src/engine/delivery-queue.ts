/**
 * The delivery queue: durable receipts, the retry drain, and background
 * verify. Moved verbatim from agent-engine.ts (CX-3 E4); the engine keeps
 * thin delegating methods and owns agent state, which the queue reaches only
 * through DeliveryQueueDeps.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { AgentRegistry } from "../agent-registry.js";
import type { AgentRecord, DeliveryEventType } from "../agent-types.js";
import {
  deliveryFailureSignature,
  writeDeliveryFailureTicket,
  type DeliveryFailureTicket,
} from "../delivery-failure-tickets.js";
import type { StateManager } from "../state-manager.js";
import {
  DEFAULT_DELIVERY_QUEUE_DEADLINE_MS,
  DEFAULT_DELIVERY_VERIFY_DEADLINE_MS,
  DELIVERY_COMPACTION_GRACE_MS,
  DELIVERY_QUEUED_IDLE_MIN_MS,
  DELIVERY_TARGET_GONE_CONFIRM_MISSES,
  DELIVERY_UNCHANGED_SCREEN_ATTENTION_ATTEMPTS,
  DELIVERY_WAIT_POLL_MS,
  RetryableDeliveryError,
  type AgentDeliveryReceipt,
  type AgentEngineOptions,
  type DeliveryIssueFiler,
  type DeliverySnapshotReader,
  type DeliverySubmitter,
  type DeliveryVerifier,
  type DeliveryVerifyObservation,
  type DeliveryVerifySnapshot,
} from "./types.js";

/** What the queue needs from the engine that owns agent state. */
export interface DeliveryQueueDeps {
  stateMgr: StateManager;
  registry: AgentRegistry;
  getAgentState(agentId: string): AgentRecord | null;
  markAgentWorking(
    agentId: string,
    opts?: { verifiedDelivery?: boolean },
  ): AgentRecord | null;
}

export type DeliveryQueueOptions = Pick<
  AgentEngineOptions,
  | "deliverySubmitTimeoutMs"
  | "deliveryVerifyTimeoutMs"
  | "deliveryVerifyDeadlineMs"
  | "deliveryQueueDeadlineMs"
  | "deliveryTicketDir"
  | "deliveryIssueFiler"
  | "deliveryVerifier"
  | "deliverySnapshotReader"
>;

function snapshotDeliveryReceipt(
  receipt: AgentDeliveryReceipt,
): AgentDeliveryReceipt {
  const { rpc_methods: rpcMethods, ...snapshot } = receipt;
  return {
    ...snapshot,
    ...(Array.isArray(rpcMethods) ? { rpc_methods: [...rpcMethods] } : {}),
  };
}

export class DeliveryQueue {
  private readonly deps: DeliveryQueueDeps;
  private readonly stateMgr: StateManager;
  private readonly registry: AgentRegistry;
  private deliveryReceipts = new Map<string, AgentDeliveryReceipt>();
  private deliveryReceiptsPath: string;
  private deliverySubmitter: DeliverySubmitter | null = null;
  private deliveryVerifier: DeliveryVerifier | null = null;
  private deliverySnapshotReader: DeliverySnapshotReader | null = null;
  private deliveryDrainInFlight = false;
  private deliveryVerifyInFlight = false;
  private deliverySubmitTimeoutMs: number;
  private deliveryVerifyTimeoutMs: number;
  private deliveryVerifyDeadlineMs: number;
  private deliveryQueueDeadlineMs: number;
  private deliveryTicketDir: string | null;
  private deliveryIssueFiler: DeliveryIssueFiler | null = null;

  constructor(deps: DeliveryQueueDeps, opts?: DeliveryQueueOptions) {
    this.deps = deps;
    this.stateMgr = deps.stateMgr;
    this.registry = deps.registry;
    this.deliveryReceiptsPath = join(
      deps.stateMgr.getBaseDir(),
      "delivery-receipts.json",
    );
    this.deliverySubmitTimeoutMs = Math.max(
      1,
      opts?.deliverySubmitTimeoutMs ?? 30_000,
    );
    this.deliveryVerifyTimeoutMs = Math.max(
      1,
      opts?.deliveryVerifyTimeoutMs ?? this.deliverySubmitTimeoutMs,
    );
    this.deliveryVerifyDeadlineMs = Math.max(
      1,
      opts?.deliveryVerifyDeadlineMs ?? DEFAULT_DELIVERY_VERIFY_DEADLINE_MS,
    );
    this.deliveryQueueDeadlineMs = Math.max(
      1,
      opts?.deliveryQueueDeadlineMs ?? DEFAULT_DELIVERY_QUEUE_DEADLINE_MS,
    );
    this.deliveryTicketDir = opts?.deliveryTicketDir ?? null;
    this.deliveryIssueFiler = opts?.deliveryIssueFiler ?? null;
    this.deliveryVerifier = opts?.deliveryVerifier ?? null;
    this.deliverySnapshotReader = opts?.deliverySnapshotReader ?? null;
    this.loadDeliveryReceipts();
  }

  private getAgentState(agentId: string): AgentRecord | null {
    return this.deps.getAgentState(agentId);
  }

  private markAgentWorking(
    agentId: string,
    opts: { verifiedDelivery?: boolean } = {},
  ): AgentRecord | null {
    return this.deps.markAgentWorking(agentId, opts);
  }

  setDeliverySubmitter(submitter: DeliverySubmitter | null): void {
    this.deliverySubmitter = submitter;
  }

  setDeliveryVerifier(verifier: DeliveryVerifier | null): void {
    this.deliveryVerifier = verifier;
  }

  setDeliverySnapshotReader(reader: DeliverySnapshotReader | null): void {
    this.deliverySnapshotReader = reader;
  }

  setDeliveryIssueFiler(filer: DeliveryIssueFiler | null): void {
    this.deliveryIssueFiler = filer;
  }

  private loadDeliveryReceipts(): void {
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(this.deliveryReceiptsPath, "utf8"),
      );
      if (!Array.isArray(parsed)) return;
      let repairedReceipts = false;
      for (const candidate of parsed) {
        if (
          candidate &&
          typeof candidate === "object" &&
          typeof (candidate as AgentDeliveryReceipt).delivery_id === "string"
        ) {
          const receipt: AgentDeliveryReceipt = {
            submission_started_at: null,
            next_attempt_at: null,
            ...(candidate as AgentDeliveryReceipt),
          };
          if (
            receipt.delivery_state === "queued" &&
            receipt.submission_started_at &&
            receipt.composer_accepted !== true
          ) {
            receipt.delivery_state = "failed";
            receipt.terminal = true;
            receipt.resolved_at = new Date().toISOString();
            receipt.error =
              "Delivery outcome uncertain after process restart; refusing automatic replay";
            repairedReceipts = true;
          }
          const deadlineWatched =
            receipt.delivery_state === "pending_verify" ||
            (receipt.delivery_state === "queued" &&
              receipt.composer_accepted === true);
          if (
            deadlineWatched &&
            !receipt.terminal &&
            (receipt.verify_deadline_at == null ||
              receipt.verify_deadline_at === "")
          ) {
            receipt.verify_deadline_at = new Date(
              Date.now() + this.deliveryVerifyDeadlineMs,
            ).toISOString();
            repairedReceipts = true;
          }
          this.deliveryReceipts.set(receipt.delivery_id, receipt);
        }
      }
      if (repairedReceipts) {
        try {
          this.persistDeliveryReceipts();
        } catch {
          // In-memory terminal state still prevents replay in this process.
        }
      }
    } catch {
      // Missing or corrupt legacy state must not prevent lifecycle startup.
    }
  }

  private persistDeliveryReceipts(): void {
    mkdirSync(dirname(this.deliveryReceiptsPath), { recursive: true });
    const tempPath = `${this.deliveryReceiptsPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(
        tempPath,
        `${JSON.stringify([...this.deliveryReceipts.values()], null, 2)}\n`,
        "utf8",
      );
      renameSync(tempPath, this.deliveryReceiptsPath);
    } finally {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    }
  }

  queueDelivery(input: {
    delivery_id?: string;
    agent_id: string;
    text: string;
    press_enter: boolean;
    source_event: DeliveryEventType;
  }): AgentDeliveryReceipt {
    const existing = input.delivery_id
      ? this.deliveryReceipts.get(input.delivery_id)
      : undefined;
    const receipt: AgentDeliveryReceipt = {
      delivery_id: input.delivery_id ?? existing?.delivery_id ?? randomUUID(),
      agent_id: input.agent_id,
      text: input.text,
      press_enter: input.press_enter,
      source_event: input.source_event,
      delivery_state: "queued",
      terminal: false,
      created_at: existing?.created_at ?? new Date().toISOString(),
      resolved_at: null,
      retry_count: existing?.retry_count ?? 0,
      rpc_methods: existing?.rpc_methods ? [...existing.rpc_methods] : [],
      submit_verified: null,
      error: null,
      submission_started_at: null,
      next_attempt_at: null,
      verify_deadline_at: null,
      needs_attention: false,
      attention_reason: null,
      unchanged_screen_retry_count: 0,
      retry_screen_fingerprint: null,
    };
    this.deliveryReceipts.set(receipt.delivery_id, receipt);
    try {
      // Acceptance is not returned until the full replay payload is durable.
      this.persistDeliveryReceipts();
    } catch (error) {
      this.deliveryReceipts.delete(receipt.delivery_id);
      throw error;
    }
    this.appendDeliveryReceiptEventBestEffort(receipt);
    return snapshotDeliveryReceipt(receipt);
  }

  registerExternalDelivery(input: {
    delivery_id: string;
    agent_id: string;
    text: string;
    press_enter: boolean;
    source_event: DeliveryEventType;
    rpc_methods?: Array<"surface.send_text" | "surface.send_key">;
  }): AgentDeliveryReceipt {
    const now = new Date().toISOString();
    const receipt: AgentDeliveryReceipt = {
      ...input,
      delivery_state: "queued",
      terminal: false,
      created_at: now,
      resolved_at: null,
      retry_count: 0,
      rpc_methods: input.rpc_methods ? [...input.rpc_methods] : [],
      submit_verified: null,
      error: null,
      submission_started_at: now,
      next_attempt_at: null,
      composer_accepted: false,
      verify_deadline_at: null,
      externally_managed: true,
    };
    this.deliveryReceipts.set(receipt.delivery_id, receipt);
    try {
      this.persistDeliveryReceipts();
    } catch (error) {
      this.deliveryReceipts.delete(receipt.delivery_id);
      throw error;
    }
    return snapshotDeliveryReceipt(receipt);
  }

  acceptComposerQueue(input: {
    delivery_id: string;
    agent_id: string;
    text: string;
    press_enter: boolean;
    source_event: DeliveryEventType;
    retry_count: number;
    rpc_methods?: Array<"surface.send_text" | "surface.send_key">;
    typed?: boolean;
    submit_dispatched?: boolean;
    delivery_state?: "queued" | "queued_followup";
  }): AgentDeliveryReceipt {
    const acceptedAt = new Date().toISOString();
    const existing = this.deliveryReceipts.get(input.delivery_id);
    const queuedFollowup =
      (input.delivery_state ?? "queued") === "queued_followup";
    const receipt: AgentDeliveryReceipt = {
      ...input,
      delivery_state: input.delivery_state ?? "queued",
      terminal: false,
      created_at: existing?.created_at ?? acceptedAt,
      resolved_at: null,
      submit_verified: null,
      error: null,
      rpc_methods: input.rpc_methods
        ? [...input.rpc_methods]
        : existing?.rpc_methods
          ? [...existing.rpc_methods]
          : [],
      submission_started_at: existing?.submission_started_at ?? acceptedAt,
      next_attempt_at: null,
      composer_accepted: true,
      verify_deadline_at: queuedFollowup
        ? null
        : (existing?.verify_deadline_at ??
          new Date(Date.now() + this.deliveryVerifyDeadlineMs).toISOString()),
    };
    this.deliveryReceipts.set(receipt.delivery_id, receipt);
    try {
      this.persistDeliveryReceipts();
    } catch (error) {
      this.deliveryReceipts.delete(receipt.delivery_id);
      throw error;
    }
    return snapshotDeliveryReceipt(receipt);
  }

  resolveDelivery(
    input: Omit<AgentDeliveryReceipt, "created_at" | "resolved_at"> & {
      created_at?: string;
    },
    opts?: { appendFailureEvent?: boolean },
  ): AgentDeliveryReceipt {
    const existing = this.deliveryReceipts.get(input.delivery_id);
    const receipt: AgentDeliveryReceipt = {
      ...input,
      rpc_methods: input.rpc_methods
        ? [...input.rpc_methods]
        : existing?.rpc_methods
          ? [...existing.rpc_methods]
          : [],
      created_at: input.created_at ?? new Date().toISOString(),
      resolved_at: new Date().toISOString(),
    };
    this.deliveryReceipts.set(receipt.delivery_id, receipt);
    this.persistDeliveryReceipts();
    if (
      (receipt.delivery_state === "failed" ||
        receipt.delivery_state === "failed_confirmed") &&
      opts?.appendFailureEvent
    ) {
      this.appendDeliveryReceiptEventBestEffort(receipt);
    }
    return snapshotDeliveryReceipt(receipt);
  }

  getDeliveryReceipt(deliveryId: string): AgentDeliveryReceipt | null {
    const receipt = this.deliveryReceipts.get(deliveryId);
    return receipt ? snapshotDeliveryReceipt(receipt) : null;
  }

  listDeliveryReceipts(): AgentDeliveryReceipt[] {
    return [...this.deliveryReceipts.values()].map(snapshotDeliveryReceipt);
  }

  findOpenDuplicate(input: {
    agent_id: string;
    text: string;
    press_enter: boolean;
  }): AgentDeliveryReceipt | null {
    for (const receipt of this.deliveryReceipts.values()) {
      if (
        (receipt.delivery_state === "pending_verify" ||
          receipt.delivery_state === "queued" ||
          receipt.delivery_state === "queued_followup") &&
        receipt.agent_id === input.agent_id &&
        receipt.text === input.text &&
        receipt.press_enter === input.press_enter
      ) {
        return snapshotDeliveryReceipt(receipt);
      }
    }
    return null;
  }

  acceptPendingVerify(input: {
    delivery_id: string;
    agent_id: string;
    text: string;
    press_enter: boolean;
    source_event: DeliveryEventType;
    retry_count: number;
    rpc_methods?: Array<"surface.send_text" | "surface.send_key">;
    typed?: boolean;
    submit_dispatched?: boolean;
    boot_recovery?: boolean;
    boot_instance_id?: string;
    created_at?: string;
  }): AgentDeliveryReceipt {
    const now = new Date().toISOString();
    const existing = this.deliveryReceipts.get(input.delivery_id);
    const receipt: AgentDeliveryReceipt = {
      ...input,
      delivery_state: "pending_verify",
      terminal: false,
      created_at: input.created_at ?? existing?.created_at ?? now,
      resolved_at: null,
      submit_verified: null,
      error: null,
      rpc_methods: input.rpc_methods
        ? [...input.rpc_methods]
        : existing?.rpc_methods
          ? [...existing.rpc_methods]
          : [],
      submission_started_at: existing?.submission_started_at ?? now,
      next_attempt_at: null,
      verify_deadline_at:
        existing?.verify_deadline_at ??
        new Date(Date.now() + this.deliveryVerifyDeadlineMs).toISOString(),
    };
    this.deliveryReceipts.set(receipt.delivery_id, receipt);
    this.persistDeliveryReceipts();
    return snapshotDeliveryReceipt(receipt);
  }

  async waitForDelivery(
    deliveryId: string,
    timeoutMs: number,
  ): Promise<AgentDeliveryReceipt & { timed_out?: boolean }> {
    const start = Date.now();
    const existing = this.getDeliveryReceipt(deliveryId);
    if (!existing) {
      throw new Error(`Delivery not found: ${deliveryId}`);
    }
    if (existing.terminal) {
      return existing;
    }
    return new Promise<AgentDeliveryReceipt & { timed_out?: boolean }>(
      (resolve, reject) => {
        const finish = (
          receipt: AgentDeliveryReceipt & { timed_out?: boolean },
        ) => {
          clearInterval(timer);
          resolve(receipt);
        };
        const timer = setInterval(() => {
          const elapsed = Date.now() - start;
          const current = this.getDeliveryReceipt(deliveryId);
          if (!current) {
            clearInterval(timer);
            reject(new Error(`Delivery not found: ${deliveryId}`));
            return;
          }
          if (current.terminal) {
            finish(current);
            return;
          }
          if (elapsed >= timeoutMs) {
            finish({ ...current, timed_out: true });
          }
        }, DELIVERY_WAIT_POLL_MS);
      },
    );
  }

  async verifyPendingDeliveries(): Promise<void> {
    if (this.deliveryVerifyInFlight || !this.deliveryVerifier) return;
    this.deliveryVerifyInFlight = true;
    try {
      const snapshots = new Map<string, DeliveryVerifySnapshot | null>();
      for (const receipt of this.deliveryReceipts.values()) {
        if (receipt.boot_recovery && !receipt.boot_recovery_finalized_at &&
          receipt.delivery_state === "submitted" &&
          receipt.submit_verified === true) {
          // Repair a crash between persisting the confirmed receipt and the
          // managed state transition. This is idempotent on later sweeps.
          this.finalizeConfirmedBootRecovery(receipt);
          continue;
        }
        const watching =
          receipt.delivery_state === "pending_verify" ||
          receipt.delivery_state === "queued_followup" ||
          (receipt.delivery_state === "queued" &&
            receipt.composer_accepted === true);
        if (!watching || receipt.terminal) continue;
        const deadlineApplies = receipt.delivery_state !== "queued_followup";
        const deadlineMs = receipt.verify_deadline_at
          ? Date.parse(receipt.verify_deadline_at)
          : Date.parse(receipt.created_at) + this.deliveryVerifyDeadlineMs;
        const now = Date.now();
        const timedOut = deadlineApplies && now >= deadlineMs;
        const skipRead = this.shouldSkipVerifyRead(receipt, now);
        let observation: DeliveryVerifyObservation = { outcome: "pending" };
        if (skipRead && !timedOut) continue;
        if (!skipRead && this.deliveryVerifier) {
          const agent = this.getAgentState(receipt.agent_id);
          const snapshotKey = agent?.surface_id ?? receipt.agent_id;
          let snapshot: DeliveryVerifySnapshot | null | undefined;
          if (this.deliverySnapshotReader) {
            if (!snapshots.has(snapshotKey)) {
              // AIDEV-NOTE (T2 #450): the snapshot read must be inside the
              // hang guard, not before it. SF8 hoisted the surface read out of
              // the verifier and awaited it OUTSIDE SF7's race; the CLI
              // fallback path has no subprocess timeout, so one wedged `cmux`
              // held deliveryVerifyInFlight forever and every later verify
              // pass short-circuited -- exactly the stall SF7 exists to
              // prevent. A timed-out read yields a null snapshot, which the
              // verifier already treats as "no evidence, stay pending".
              snapshots.set(
                snapshotKey,
                await this.withDeliveryVerifyTimeout(
                  this.deliverySnapshotReader(receipt),
                  "Delivery snapshot read",
                ).catch(() => null),
              );
            }
            snapshot = snapshots.get(snapshotKey) ?? null;
          }
          try {
            observation = await this.withDeliveryVerifyTimeout(
              this.deliveryVerifier(receipt, snapshot),
              "Delivery verify",
            );
          } catch (error) {
            observation = {
              outcome: "pending",
              reason: error instanceof Error ? error.message : String(error),
            };
          }
          receipt.verify_last_attempt_at = new Date().toISOString();
          this.persistDeliveryReceipts();
        }
        if (observation.outcome === "delivered") {
          receipt.delivery_state = "submitted";
          receipt.terminal = true;
          receipt.resolved_at = new Date().toISOString();
          receipt.submit_verified = observation.submit_verified ?? true;
          receipt.error = null;
          receipt.verify_miss_count = 0;
          this.persistDeliveryReceipts();
          if (receipt.press_enter && receipt.submit_verified === true) {
            this.markAgentWorking(receipt.agent_id, {
              verifiedDelivery: receipt.source_event === "send_to",
            });
          }
          this.appendDeliveryReceiptEventBestEffort(receipt);
          this.finalizeConfirmedBootRecovery(receipt);
          continue;
        }
        const compactionVisible =
          observation.reason === "queued_compaction_busy" ||
          observation.reason === "queued_compaction_idle";
        if (compactionVisible && !receipt.queue_compaction_seen_at) {
          receipt.queue_compaction_seen_at = new Date().toISOString();
          this.persistDeliveryReceipts();
        } else if (!compactionVisible && receipt.queue_compaction_seen_at) {
          receipt.queue_compaction_seen_at = null;
          this.persistDeliveryReceipts();
        }
        const compactionIdleExpired =
          observation.reason === "queued_compaction_idle" &&
          receipt.queue_compaction_seen_at !== null &&
          receipt.queue_compaction_seen_at !== undefined &&
          Date.now() - Date.parse(receipt.queue_compaction_seen_at) >=
            DELIVERY_COMPACTION_GRACE_MS;
        if (observation.reason === "queued_idle" || compactionIdleExpired) {
          receipt.queue_idle_since_at ??= new Date().toISOString();
          receipt.queue_idle_observations =
            (receipt.queue_idle_observations ?? 0) + 1;
          if (
            receipt.queue_idle_observations >= 2 &&
            Date.now() - new Date(receipt.queue_idle_since_at).getTime() >=
              DELIVERY_QUEUED_IDLE_MIN_MS
          ) {
            receipt.delivery_state = "stalled_queue";
            receipt.terminal = true;
            receipt.resolved_at = new Date().toISOString();
            receipt.submit_verified = false;
            receipt.error =
              "Target is idle but the message remains queued. Inspect the queued " +
              "message on the target pane and verify whether a tool call is still " +
              "in flight before intervening or retrying.";
            receipt.needs_attention = true;
            receipt.attention_reason = receipt.error;
            this.persistDeliveryReceipts();
            this.appendDeliveryReceiptEventBestEffort(receipt);
            continue;
          }
          this.persistDeliveryReceipts();
        } else if ((receipt.queue_idle_observations ?? 0) > 0 || receipt.queue_idle_since_at) {
          receipt.queue_idle_observations = 0;
          receipt.queue_idle_since_at = null;
          this.persistDeliveryReceipts();
        }
        if (observation.reason === "target_gone") {
          receipt.verify_miss_count = (receipt.verify_miss_count ?? 0) + 1;
          this.persistDeliveryReceipts();
        } else if ((receipt.verify_miss_count ?? 0) > 0) {
          receipt.verify_miss_count = 0;
          this.persistDeliveryReceipts();
        }
        const confirmedGone =
          observation.reason === "target_gone" &&
          (receipt.verify_miss_count ?? 0) >=
            DELIVERY_TARGET_GONE_CONFIRM_MISSES;
        if (
          observation.outcome === "failed_confirmed" ||
          confirmedGone ||
          timedOut
        ) {
          const reason =
            observation.reason ??
            (timedOut ? "verify_deadline_elapsed" : "failed_confirmed");
          receipt.delivery_state = "failed_confirmed";
          receipt.terminal = true;
          receipt.resolved_at = new Date().toISOString();
          receipt.submit_verified = false;
          receipt.error = reason;
          this.persistDeliveryReceipts();
          this.appendDeliveryReceiptEventBestEffort(receipt);
          await this.fileConfirmedFailureTicket(receipt, reason, observation);
        }
      }
    } finally {
      this.deliveryVerifyInFlight = false;
    }
  }

  private finalizeConfirmedBootRecovery(receipt: AgentDeliveryReceipt): void {
    if (!receipt.boot_recovery || receipt.boot_recovery_finalized_at ||
      receipt.delivery_state !== "submitted" ||
      receipt.submit_verified !== true || !receipt.boot_instance_id) return;
    let agent = this.stateMgr.readState(receipt.agent_id);
    if (!agent || agent.boot_instance_id !== receipt.boot_instance_id ||
      !["booting", "ready", "working"].includes(agent.state)) return;
    if (agent.boot_prompt_pending !== false || agent.prompt_delivered !== true ||
      agent.submit_verified !== true) {
      agent = this.stateMgr.updateRecord(agent.agent_id, {
        boot_prompt_pending: false,
        prompt_delivered: true,
        submit_verified: true,
      });
    }
    if (agent.state === "booting") {
      agent = this.stateMgr.transition(agent.agent_id, "ready");
    }
    if (agent.state === "ready") {
      agent = this.stateMgr.transition(agent.agent_id, "working");
    }
    this.registry.set(agent.agent_id, agent);
    receipt.boot_recovery_finalized_at = new Date().toISOString();
    this.persistDeliveryReceipts();
  }

  /** Bound one delivery-verify side quest to the verify timeout. */
  private withDeliveryVerifyTimeout<T>(
    work: Promise<T>,
    label: string,
  ): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    return Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `${label} timed out after ${this.deliveryVerifyTimeoutMs}ms`,
              ),
            ),
          this.deliveryVerifyTimeoutMs,
        );
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
  }

  private verifyReadIntervalMs(
    receipt: AgentDeliveryReceipt,
    now: number,
  ): number {
    if (
      receipt.delivery_state === "queued_followup" ||
      !receipt.verify_deadline_at
    ) {
      const ageMs = Math.max(0, now - Date.parse(receipt.created_at));
      const minutes = Math.floor(ageMs / 60_000);
      return Math.min(60_000, 5_000 * 2 ** Math.min(minutes, 3));
    }
    const remaining = Math.max(0, Date.parse(receipt.verify_deadline_at) - now);
    const created = Date.parse(receipt.created_at);
    const total = Math.max(1, Date.parse(receipt.verify_deadline_at) - created);
    const remainingRatio = remaining / total;
    if (remainingRatio > 0.5) return 5_000;
    if (remainingRatio > 0.2) return 15_000;
    return 30_000;
  }

  private shouldSkipVerifyRead(
    receipt: AgentDeliveryReceipt,
    now: number,
  ): boolean {
    if (!receipt.verify_last_attempt_at) return false;
    const since = now - Date.parse(receipt.verify_last_attempt_at);
    return since > 0 && since < this.verifyReadIntervalMs(receipt, now);
  }

  /**
   * A confirmed-failure verdict is worth an issue only when something was
   * actually observed to go wrong with the message.
   *
   * AIDEV-NOTE (T2 #471/#443): `verify_deadline_elapsed` means the ENGINE
   * stopped looking, and `target_gone` means there was nothing left to look
   * at. Neither is evidence the message was lost, and auto-filing them
   * produced issues #471 and #443 -- tracker noise describing cmuxlayer's own
   * timers, not a defect. The local evidence ticket is still written either
   * way, so the verdict keeps citing its evidence; only the escalation stops.
   */
  private deliveryFailureEscalationDecline(reason: string): string | null {
    if (reason === "verify_deadline_elapsed") {
      return (
        "background verify ran out of deadline before observing an outcome; " +
        "no evidence the message was lost"
      );
    }
    if (reason === "target_gone") {
      return (
        "the target agent disappeared before an outcome could be observed; " +
        "no evidence the message was lost"
      );
    }
    return null;
  }

  private async fileConfirmedFailureTicket(
    receipt: AgentDeliveryReceipt,
    reason: string,
    observation: DeliveryVerifyObservation,
  ): Promise<void> {
    if (receipt.ticket_filed) return;
    const ticketDir = this.deliveryTicketDir;
    if (!ticketDir) return;
    const agent = this.getAgentState(receipt.agent_id);
    const signature = deliveryFailureSignature({
      reason,
      cli: agent?.cli ?? null,
    });
    const ticket: DeliveryFailureTicket = {
      signature,
      delivery_id: receipt.delivery_id,
      agent_id: receipt.agent_id,
      reason,
      cli: agent?.cli ?? null,
      what_happened: `Delivery ${receipt.delivery_id} to ${receipt.agent_id} reached failed_confirmed (${reason}) after background verify.`,
      what_fixed_it:
        "Do not blind-retry. Identical send_to while pending_verify/queued/queued_followup returns duplicate_of. Query wait_for({delivery_id}) or list_agents detail=full.",
      evidence: {
        receipt,
        observation,
        target_state: agent?.state ?? null,
        surface_id: agent?.surface_id ?? null,
      },
      observed_at: new Date().toISOString(),
    };
    const written = writeDeliveryFailureTicket(ticket, {
      dir: ticketDir,
    });
    receipt.ticket_filed = true;

    // AIDEV-NOTE (T2 B2): both fields are written from the SAME resolved
    // outcome, at every exit, and never before the escalation is known.
    // Stamping `escalated: true` up front and then returning early -- deduped
    // signature, no filer configured, filer threw -- left receipts asserting
    // an escalation that never happened. That is this lane's own disease: a
    // receipt reporting something the engine did not observe.
    const settleEscalation = (declined: string | null): void => {
      receipt.ticket_escalated = declined === null;
      receipt.ticket_escalation_declined_reason = declined;
      this.persistDeliveryReceipts();
    };

    const declineReason = this.deliveryFailureEscalationDecline(reason);
    if (declineReason !== null) return settleEscalation(declineReason);
    if (!written.created) {
      return settleEscalation(
        "an issue for this failure signature was already filed; " +
          "this occurrence was appended to the existing ticket",
      );
    }
    if (!this.deliveryIssueFiler) {
      return settleEscalation("no issue filer is configured");
    }
    try {
      await this.deliveryIssueFiler(ticket);
      settleEscalation(null);
    } catch (error) {
      // Local ticket is authoritative; GitHub is best-effort -- but the
      // receipt must say the escalation did not land.
      settleEscalation(
        `issue filer failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async drainDeliveryQueue(): Promise<void> {
    if (this.deliveryDrainInFlight || !this.deliverySubmitter) return;
    this.deliveryDrainInFlight = true;
    try {
      for (const receipt of this.deliveryReceipts.values()) {
        if (receipt.delivery_state !== "queued") continue;
        if (receipt.externally_managed === true) continue;
        if (receipt.composer_accepted === true) continue;
        const agent = this.getAgentState(receipt.agent_id);
        if (!agent) {
          receipt.delivery_state = "failed";
          receipt.terminal = true;
          receipt.resolved_at = new Date().toISOString();
          receipt.error = `Delivery target ${receipt.agent_id} is gone or no longer exists`;
          this.persistDeliveryReceipts();
          this.appendDeliveryReceiptEventBestEffort(receipt);
          continue;
        }
        // AIDEV-NOTE (T2 N1): a paused target deliberately does NOT age out.
        // #467's bounded lifetime exists for a target that is failing to
        // become interactive on its own; pausing is a human's resumable act,
        // and expiring queued work under it would discard the message the
        // pause was protecting. The receipt stays nonterminal, and the
        // paused-target WARNING already tells the caller it is not delivered.
        if (agent.paused === true) {
          continue;
        }
        // AIDEV-NOTE (T2 #467): a retryable refusal is nonterminal, but it is
        // not unbounded. Without this, a target stuck `booting` retried behind
        // a 30s-capped backoff forever and the caller's receipt never resolved
        // -- a lead could wait on it indefinitely. The lifetime is stamped on
        // the first retryable requeue below; when it elapses the caller gets a
        // terminal answer that cites the gate reason that kept refusing.
        if (
          receipt.queue_deadline_at &&
          Date.now() >= Date.parse(receipt.queue_deadline_at)
        ) {
          // AIDEV-NOTE (#500): an unchanged screen proves a retry stall, not
          // that the payload failed. Keep the explicit attention state and
          // start a fresh bounded retry epoch instead of either inventing a
          // terminal verdict or freezing a receipt that still says `queued`.
          // The existing capped backoff below keeps attempts slow, while a
          // later-cleared composer can still recover and deliver the payload.
          if (receipt.needs_attention === true) {
            receipt.queue_deadline_at = null;
            this.persistDeliveryReceipts();
          } else {
            const gateReason = receipt.error ?? "no gate reason recorded";
            receipt.delivery_state = "failed_confirmed";
            receipt.terminal = true;
            receipt.submit_verified = false;
            receipt.resolved_at = new Date().toISOString();
            receipt.next_attempt_at = null;
            receipt.error = `queue_deadline_elapsed after ${receipt.retry_count} retryable refusals; last gate reason: ${gateReason}`;
            this.persistDeliveryReceipts();
            this.appendDeliveryReceiptEventBestEffort(receipt);
            continue;
          }
        }
        if (
          receipt.next_attempt_at &&
          Date.parse(receipt.next_attempt_at) > Date.now()
        ) {
          continue;
        }
        try {
          receipt.submission_started_at = new Date().toISOString();
          // This is the no-replay boundary. A crash after this write leaves an
          // uncertain terminal receipt instead of re-sending terminal input.
          this.persistDeliveryReceipts();
          let timeout: ReturnType<typeof setTimeout> | null = null;
          const result = await Promise.race([
            this.deliverySubmitter(receipt),
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(
                () =>
                  reject(
                    new Error(
                      `Delivery submission timed out after ${this.deliverySubmitTimeoutMs}ms; outcome uncertain and will not be retried`,
                    ),
                  ),
                this.deliverySubmitTimeoutMs,
              );
            }),
          ]).finally(() => {
            if (timeout) clearTimeout(timeout);
          });
          receipt.retry_count += result.retry_count;
          if (Array.isArray(result.rpc_methods)) {
            receipt.rpc_methods = [...result.rpc_methods];
          }
          receipt.typed = result.typed === true;
          receipt.submit_dispatched = result.submit_dispatched === true;
          receipt.error = null;
          receipt.next_attempt_at = null;
          receipt.needs_attention = false;
          receipt.attention_reason = null;
          receipt.unchanged_screen_retry_count = 0;
          receipt.retry_screen_fingerprint = null;
          if (
            result.delivery === "queued" ||
            result.delivery === "queued_followup"
          ) {
            receipt.delivery_state = result.delivery;
            receipt.terminal = false;
            receipt.resolved_at = null;
            receipt.submit_verified = null;
            receipt.composer_accepted = true;
            if (result.delivery === "queued") {
              receipt.verify_deadline_at ??= new Date(
                Date.now() + this.deliveryVerifyDeadlineMs,
              ).toISOString();
            } else {
              receipt.verify_deadline_at = null;
            }
          } else if (result.delivery === "pending_verify") {
            receipt.delivery_state = "pending_verify";
            receipt.terminal = false;
            receipt.resolved_at = null;
            receipt.submit_verified = null;
            receipt.verify_deadline_at ??= new Date(
              Date.now() + this.deliveryVerifyDeadlineMs,
            ).toISOString();
          } else if (result.delivery === "rescued") {
            receipt.delivery_state = "rescued";
            receipt.terminal = true;
            receipt.resolved_at = new Date().toISOString();
            receipt.submit_verified = false;
            receipt.error = "Prompt appeared only after an external interrupt";
            receipt.verify_deadline_at = null;
          } else {
            receipt.delivery_state = "submitted";
            receipt.terminal = true;
            receipt.resolved_at = new Date().toISOString();
            receipt.submit_verified = result.submit_verified;
          }
        } catch (error) {
          const errorRpcMethods =
            error &&
            typeof error === "object" &&
            "rpc_methods" in error &&
            Array.isArray((error as { rpc_methods?: unknown }).rpc_methods)
              ? [
                  ...(error as {
                    rpc_methods: Array<
                      "surface.send_text" | "surface.send_key"
                    >;
                  }).rpc_methods,
                ]
              : [];
          const errorTyped = Boolean(
            error &&
              typeof error === "object" &&
              "typed" in error &&
              (error as { typed?: unknown }).typed === true,
          );
          const errorSubmitDispatched = Boolean(
            error &&
              typeof error === "object" &&
              "submit_dispatched" in error &&
              (error as { submit_dispatched?: unknown }).submit_dispatched ===
                true,
          );
          if (errorRpcMethods.length > 0) {
            receipt.rpc_methods = errorRpcMethods;
          }
          receipt.typed = errorTyped;
          receipt.submit_dispatched = errorSubmitDispatched;
          if (
            error instanceof RetryableDeliveryError &&
            errorRpcMethods.length === 0 &&
            !errorTyped &&
            !errorSubmitDispatched
          ) {
            receipt.submission_started_at = null;
            receipt.retry_count += 1;
            // The submitter proved that no mutation occurred. Persist that
            // replay-safe boundary before the diagnostic snapshot awaits so a
            // crash cannot resurrect the old "submission started" marker and
            // terminalize a delivery that is safe to retry.
            this.persistDeliveryReceipts();
            await this.recordRetryScreenAttention(receipt);
            receipt.queue_deadline_at ??= new Date(
              Date.now() + this.deliveryQueueDeadlineMs,
            ).toISOString();
            const backoffMs = Math.min(
              30_000,
              250 * 2 ** Math.min(receipt.retry_count - 1, 16),
            );
            receipt.next_attempt_at = new Date(
              Date.now() + backoffMs,
            ).toISOString();
            receipt.error = error.message;
          } else {
            receipt.delivery_state = "failed";
            receipt.terminal = true;
            receipt.resolved_at = new Date().toISOString();
            receipt.error =
              error instanceof Error ? error.message : String(error);
          }
        }
        this.persistDeliveryReceipts();
        // Successful delivery already emitted the correlated source event;
        // failures have no such event and need an explicit terminal transition.
        if (receipt.delivery_state === "failed") {
          this.appendDeliveryReceiptEventBestEffort(receipt);
        }
      }
    } finally {
      this.deliveryDrainInFlight = false;
    }
  }

  private async recordRetryScreenAttention(
    receipt: AgentDeliveryReceipt,
  ): Promise<void> {
    if (!this.deliverySnapshotReader) return;
    const snapshot = await this.withDeliveryVerifyTimeout(
      this.deliverySnapshotReader(receipt),
      "Delivery retry snapshot read",
    ).catch(() => null);
    if (!snapshot) return;

    const fingerprint = createHash("sha256")
      .update(snapshot.text, "utf8")
      .digest("hex");
    if (receipt.retry_screen_fingerprint === fingerprint) {
      receipt.unchanged_screen_retry_count =
        (receipt.unchanged_screen_retry_count ?? 0) + 1;
    } else {
      receipt.retry_screen_fingerprint = fingerprint;
      receipt.unchanged_screen_retry_count = 1;
      receipt.needs_attention = false;
      receipt.attention_reason = null;
    }

    if (
      receipt.unchanged_screen_retry_count >=
      DELIVERY_UNCHANGED_SCREEN_ATTENTION_ATTEMPTS
    ) {
      receipt.needs_attention = true;
      receipt.attention_reason =
        `Delivery remains queued after ${receipt.unchanged_screen_retry_count} ` +
        "retryable refusals on a byte-identical target screen; human inspection required";
    }
  }

  private appendDeliveryReceiptEvent(receipt: AgentDeliveryReceipt): void {
    const agent = this.getAgentState(receipt.agent_id);
    this.stateMgr.getEventLog().appendDelivery({
      ts: receipt.resolved_at ?? receipt.created_at,
      event_type: receipt.source_event,
      source_agent: null,
      target_surface: agent?.surface_id ?? "unknown",
      target_agent: receipt.agent_id,
      bytes: Buffer.byteLength(receipt.text),
      press_enter: receipt.press_enter,
      submit_verified: receipt.submit_verified,
      retry_count: receipt.retry_count,
      delivery_id: receipt.delivery_id,
      delivery_state: receipt.delivery_state,
    });
  }

  private appendDeliveryReceiptEventBestEffort(
    receipt: AgentDeliveryReceipt,
  ): void {
    try {
      this.appendDeliveryReceiptEvent(receipt);
    } catch {
      // Receipt persistence is authoritative; telemetry must not invalidate
      // acceptance or tempt a caller to duplicate terminal input.
    }
  }
}
