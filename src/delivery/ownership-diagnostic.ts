import type { AgentRecord } from "../agent-types.js";
import type { AgentDeliveryReceipt } from "../engine/types.js";
import type { TypedDraftOwner } from "../mcp/context.js";

export type OwnershipPredicate = boolean | "unavailable" | "not_applicable";
export interface OwnershipDiagnosticDeps {
  resolveCaller: () => AgentRecord | null;
  getReceipt: (id: string) => AgentDeliveryReceipt | null;
  getTarget: (id: string) => AgentRecord | null;
  getFingerprintTarget: (target: AgentRecord) => AgentRecord | undefined;
  getBootInstance: (id: string) => string | undefined;
  owners: ReadonlyMap<string, TypedDraftOwner>;
  baselines: ReadonlyMap<string, string>;
}

const identity = (agent: AgentRecord | null | undefined) => agent ? {
  agent_id: agent.agent_id, cli: agent.cli ?? null,
  session_id: agent.cli_session_id ?? null, surface: agent.surface_id,
  surface_uuid: agent.surface_uuid ?? null, workspace: agent.workspace_id ?? null,
} : null;

/** Local evidence only. Never call the ownership guard: it pins boot tokens.
 * wait_for already exposes receipt identity to callers. This branch requires
 * resolved attribution and examines only that caller's entries, including a
 * displaced key for this ID. Absence says nothing about another caller's token.
 */
export function diagnoseDeliveryOwnership(id: string, deps: OwnershipDiagnosticDeps) {
  const caller = deps.resolveCaller()?.agent_id ?? null;
  if (!caller) return {
    diagnostic: "ownership" as const, delivery_id: id, status: "caller_unresolved",
    caller_agent_id: null, ownership_match: "unavailable" as OwnershipPredicate,
    predicates: { caller_resolved: false, receipt_present: "unavailable" as OwnershipPredicate,
      owner_present: "unavailable" as OwnershipPredicate },
  };
  const capture = () => {
    const receipt = deps.getReceipt(id);
    const target = receipt ? deps.getTarget(receipt.agent_id) : null;
    const fingerprint = target ? deps.getFingerprintTarget(target) : undefined;
    const key = target ? JSON.stringify([target.workspace_id ?? null,
      target.surface_uuid ?? target.surface_id, caller]) : null;
    // Filter BEFORE inspecting delivery IDs. Never return other callers' data.
    const own = [...deps.owners].filter(([, owner]) => owner.caller === caller);
    const keyed = key ? own.find(([candidate]) => candidate === key) : undefined;
    const displaced = own.filter(([, owner]) => owner.deliveryIds?.includes(id));
    const entry = keyed ?? (displaced.length === 1 ? displaced[0] : undefined);
    const owner = entry?.[1];
    return {
      caller: deps.resolveCaller()?.agent_id ?? null, receipt,
      target: identity(target), fingerprint: identity(fingerprint), key,
      entry: entry ? [entry[0], { ...owner, texts: owner?.texts?.slice(), deliveryIds: owner?.deliveryIds?.slice() }] as const : null,
      ambiguous: !keyed && displaced.length > 1,
      boot: owner?.bootAgentId ? deps.getBootInstance(owner.bootAgentId) ?? null : null,
      baseline: owner ? deps.baselines.has(id) : "unavailable",
    };
  };
  // Disk-backed target records may change between reads. Never present that as
  // a failed predicate. No await occurs; daemon-local maps cannot interleave.
  const first = capture();
  const snapshot = capture();
  if (snapshot.caller !== caller || JSON.stringify(first) !== JSON.stringify(snapshot)) return {
    diagnostic: "ownership" as const, delivery_id: id, status: "uncertain",
    caller_agent_id: caller, ownership_match: "unavailable" as OwnershipPredicate,
    reason: "evidence_changed_during_read",
  };
  const { receipt, target, fingerprint, entry } = snapshot;
  const owner = entry?.[1];
  let fp: unknown[] | null = null;
  try {
    const parsed: unknown = owner ? JSON.parse(owner.fp!) : null;
    if (Array.isArray(parsed) && parsed.length === 3 && parsed.every(v => v === null || typeof v === "string")) fp = parsed;
  } catch { /* Missing/malformed evidence is unavailable, never inferred. */ }
  const compare = (stored: unknown, current: unknown): OwnershipPredicate =>
    stored == null || current == null ? "unavailable" : stored === current;
  const firstCapture = Boolean(owner?.bootAgentId && fp && fp[2] === null &&
    fp[0] === owner.bootAgentId && fingerprint?.agent_id === fp[0] && fingerprint.cli === fp[1]);
  const predicates: Record<string, OwnershipPredicate> = {
    caller_resolved: true,
    receipt_present: receipt !== null,
    owner_present: snapshot.ambiguous ? "unavailable" : Boolean(owner),
    owner_key_match: owner && snapshot.key ? entry![0] === snapshot.key : "unavailable",
    caller_match: owner ? owner.caller === caller : "unavailable",
    draft_complete: owner ? !owner.incomplete : "unavailable",
    route_surface_match: owner && target ? owner.ref === target.surface : "unavailable",
    route_uuid_match: owner && target ? compare(owner.uuid, target.surface_uuid) : "unavailable",
    route_workspace_match: owner && target ? owner.workspace === target.workspace : "unavailable",
    target_agent_match: fp && fingerprint ? compare(fp[0], fingerprint.agent_id) : "unavailable",
    target_cli_match: fp && fingerprint ? compare(fp[1], fingerprint.cli) : "unavailable",
    target_session_match: fp && fingerprint ? (firstCapture ? "not_applicable" : compare(fp[2], fingerprint.session_id)) : "unavailable",
    boot_instance_match: !owner ? "unavailable" : !owner.bootAgentId || !owner.bootInstanceId ? "not_applicable" : compare(owner.bootInstanceId, snapshot.boot),
    text_delivery_pair_match: owner && receipt ? (owner.texts ?? [owner.text!]).some((text, i) => text === receipt.text && owner.deliveryIds?.[i] === id) : "unavailable",
  };
  // Mirror the guard's fingerprint semantics without its first-capture pin.
  const fpMatch: OwnershipPredicate = !owner || !fingerprint || !fp ? "unavailable"
    : JSON.stringify(fp) === JSON.stringify([fingerprint.agent_id, fingerprint.cli, fingerprint.session_id]) || firstCapture;
  predicates.target_fingerprint_match = fpMatch;
  const gate = [predicates.owner_present, predicates.owner_key_match, predicates.caller_match,
    predicates.draft_complete, fpMatch, predicates.boot_instance_match, predicates.text_delivery_pair_match];
  const match: OwnershipPredicate = gate.includes(false) ? false : gate.includes("unavailable") ? "unavailable" : true;
  return {
    diagnostic: "ownership" as const, delivery_id: id, status: snapshot.ambiguous ? "uncertain" : receipt ? "available" : "unavailable",
    caller_agent_id: caller, ownership_match: match,
    receipt: receipt ? { agent_id: receipt.agent_id, delivery_state: receipt.delivery_state, terminal: receipt.terminal } : null,
    target, predicates,
    evidence: { scope: "current_context_only", baseline_present: snapshot.baseline,
      boot_token: Boolean(owner?.bootAgentId),
      boot_bound: Boolean(owner?.bootAgentId && owner.bootInstanceId),
      boot_first_capture_compatible: firstCapture, historical_loss_reason: "unavailable",
      live_route: "unavailable", composer: "unavailable" },
  };
}
