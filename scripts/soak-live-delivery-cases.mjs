// One owned scratch Codex seat, two observed caller identities, no GUI control.
import { pollDelivery } from "./soak-live-timeline.mjs";

// Lean spawn receipts omit UUIDs; use only a registry binding matching the saved route.
export function deliveryCaseCaller(seat, state, workspace = "workspace:1") {
  if (!seat?.agentId || !seat.surface || state?.surface_id !== seat.surface ||
    state.workspace_id !== workspace || typeof state.surface_uuid !== "string" || !state.surface_uuid.trim()) {
    throw new Error("case_caller_route_unavailable");
  }
  return { agentId: seat.agentId, surface: state.surface_uuid };
}

export async function runDeliveryCases({ cases, seat, owner, foreign, send, read, settle,
  check, log, opts, now, sleep, relayText }) {
  const requireCase = (condition, code, id) => {
    check("delivery_case", condition ? [] : [code], { case: id });
    if (!condition) throw new Error(code);
  };
  const key = (id, text, extra = {}) => send(seat, { mode: "key", text }, `case:${id}`, extra);
  const draft = (id, text, caller = owner) => send(seat,
    { mode: "surface", text, press_enter: false }, `case:${id}`, { caller, staged: true });
  const message = (id, text, extra = {}) => send(seat,
    { mode: "agent", text }, `case:${id}`, { caller: owner, ...extra });
  const runInterrupted = async (id, text) => {
    const secondText = `Reply exactly SOAK_CASE_${id}_SECOND_${now()} then stop.`;
    let second = null;
    if (id === "g") {
      await draft(id, secondText);
      second = await key(id, "tab", { caller: owner, control: true, text: secondText });
    } else second = await message(id, secondText);
    requireCase(second.evidence.queued, "second_queue_not_exercised", id);
    await key(id, "escape", { caller: owner, control: true });
    if (id === "g") {
      const stalled = await pollDelivery({ read, now, sleep, timeoutMs: opts.timeoutMs,
        until: (e) => !e.busy && e.hasQueue });
      requireCase(!stalled.busy && stalled.hasQueue, "idle_queue_case_not_exercised", id);
      const refused = await message(id, `Reply exactly SOAK_REFUSED_${now()}.`,
        { expectedCode: "queued_stalled_idle" });
      requireCase(refused.receipt.error_code === "queued_stalled_idle" &&
        refused.receipt.typed === false, "idle_queue_not_refused", id);
      await key(id, "Return", { caller: owner, text });
      await settle(seat, text, `case:${id}`);
      await settle(seat, secondText, `case:${id}`);
    } else {
      const moved = await pollDelivery({ read: () => read(text), now, sleep, timeoutMs: opts.timeoutMs,
        until: (e) => e.inComposer });
      requireCase(moved.inComposer && !moved.busy, "interrupted_draft_case_not_exercised", id);
      const refused = await key(id, "Return", { caller: foreign, text,
        expectedCode: "blocked_by_foreign_draft" });
      requireCase(refused.receipt.error_code === "blocked_by_foreign_draft" &&
        refused.evidence.inComposer, "foreign_retry_not_refused", id);
      const retry = await key(id, "return", { caller: owner, text });
      requireCase(retry.receipt.ok === true && retry.evidence.submitted, "owned_retry_failed", id);
      await settle(seat, text, `case:${id}`);
      await settle(seat, secondText, `case:${id}`);
    }
  };
  const runBusyCase = async (id, text) => {
    if (id === "h") requireCase(typeof text === "string" && text.length >= 240, "long_relay_missing", id);
    const seconds = id === "e" ? opts.longTurnMinutes * 60 + 30 : 30;
    const busy = `Run sleep ${seconds} in the terminal, then reply exactly SOAK_BUSY_${id}_${now()}.`;
    const started = await message(id, busy);
    requireCase(started.receipt.ok === true, "busy_turn_send_failed", id);
    const active = await pollDelivery({ read, now, sleep, timeoutMs: opts.timeoutMs,
      until: (e) => e.busy === true });
    requireCase(active.busy, "busy_case_not_exercised", id);
    let first = null;
    if (id === "g") {
      await draft(id, text);
      first = await key(id, "tab", { caller: owner, control: true, text });
    } else first = await message(id, text);
    requireCase(first.receipt.ok === true && first.evidence.queued &&
      (id === "g" || first.receipt.queued_behind_turn === true), "queue_case_not_exercised", id);
    if (id === "h") requireCase(first.evidence.queueRows >= 3 || first.evidence.queueTruncated,
      "wrapped_queue_case_not_exercised", id);
    if (["a", "h"].includes(id)) { await settle(seat, text, `case:${id}`); }
    if (id === "e") {
      await sleep(opts.longTurnMinutes * 60_000);
      const state = await read(text, first.receipt.delivery_id);
      requireCase(state.busy && state.queued, "long_turn_case_not_exercised", id);
      requireCase(state.needsAttention, "long_queue_unsurfaced", id);
      await settle(seat, text, `case:${id}`);
    }
    if (["b", "g"].includes(id)) await runInterrupted(id, text);
  };
  const runIdleCase = async (id, text) => {
    if (id === "c") {
      await draft(id, text, foreign);
      try {
        const refused = await message(id, `Reply exactly SOAK_REFUSED_${now()}.`,
          { expectedCode: "blocked_by_foreign_draft" });
        requireCase(refused.receipt.error_code === "blocked_by_foreign_draft" &&
          refused.receipt.typed === false, "foreign_draft_not_refused", id);
        const state = await read(text, refused.receipt.delivery_id);
        requireCase(state.inComposer && (state.needsAttention || state.draftAttention), "foreign_draft_unsurfaced", id);
      } finally {
        // This caller staged the harmless echo prompt. Submit through its owned
        // route and observe acceptance; Ctrl-U is cursor-position dependent.
        const cleared = await key(id, "Return", { caller: foreign, text });
        requireCase(cleared.receipt.ok === true && cleared.receipt.submit_verified === true &&
          cleared.evidence.submitted && !cleared.evidence.inComposer, "foreign_draft_cleanup_failed", id);
        await settle(seat, text, `case:${id}:cleanup`);
      }
    } else {
      for (const variant of id === "d" ? ["Enter", "enter", "Return", "RETURN"] : ["Return"]) {
        const ownedText = `${text} ${variant}`;
        await draft(id, ownedText);
        const ready = await read(ownedText);
        requireCase(ready.inComposer && !ready.busy, "idle_owned_draft_not_exercised", id);
        const sent = await key(id, variant, { caller: owner, text: ownedText });
        requireCase(sent.receipt.ok === true && sent.receipt.submit_verified === true && sent.evidence.submitted,
          "owned_key_submit_failed", id);
        await settle(seat, ownedText, `case:${id}`);
      }
    }
  };
  for (const id of cases) {
    log({ kind: "delivery_case_start", case: id });
    const text = id === "h" ? relayText : `Reply exactly SOAK_CASE_${id}_${now()} then stop.`;
    try {
      requireCase(owner?.agentId && owner.surface && foreign?.agentId && foreign.surface && owner.agentId !== foreign.agentId,
        "case_callers_unavailable", id);
      if (["a", "b", "e", "g", "h"].includes(id)) await runBusyCase(id, text);
      else await runIdleCase(id, text);
      // Do not carry an unobserved draft/queue into the next case.
      const clean = await pollDelivery({ read, now, sleep, timeoutMs: opts.timeoutMs,
        until: (e) => e.readable && !e.hasQueue && !e.hasDraft && !e.busy });
      requireCase(clean.readable && !clean.hasQueue && !clean.hasDraft && !clean.busy, "case_left_pending_input", id);
      log({ kind: "delivery_case_done", case: id });
    } catch (error) {
      check("delivery_case", ["delivery_case_failed"], { case: id, error: String(error) });
      for (const remaining of cases.slice(cases.indexOf(id) + 1)) {
        check("delivery_case", ["delivery_case_not_run"], { case: remaining });
      }
      break;
    }
  }
}
