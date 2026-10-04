import { describe, expect, it } from "vitest";
import { deliveryEvidence, checkPostSend, checkDeliveryDeadline } from "../scripts/soak-live-checks.mjs";
import { pollDelivery } from "../scripts/soak-live-timeline.mjs";
import { options } from "../scripts/soak-live-options.mjs";

const text = "Reply exactly SOAK_UNIQUE then stop.";
const frame = (body: string) => ({ ok: true, content: body, parsed: {} });
const submitted = { ok: true, submitted: true, delivery_state: "submitted" };
const queued = { ok: true, queue_verified: true, queued_behind_turn: true, delivery_state: "queued" };

describe("delivery stop rule", () => {
  it("rejects an ok receipt with text still in the composer or absent", () => {
    for (const content of [`› ${text}\n  100% context left`, "› \n  100% context left"]) {
      expect(checkPostSend(submitted, deliveryEvidence(frame(content), text))).toContain("false_positive_receipt");
    }
  });
  it("accepts transcript proof but never a queue or tool echo as transcript", () => {
    expect(checkPostSend(submitted, deliveryEvidence(frame(`› ${text}\n• SOAK_UNIQUE\n› \n  100% context left`), text))).toEqual([]);
    const evidence = deliveryEvidence(frame(`• Queued follow-up inputs\n  ↳ ${text}\n› \n  100% context left`), text);
    expect(evidence).toMatchObject({ queued: true, submitted: false, inComposer: false });
    expect(checkPostSend(queued, evidence)).toEqual([]);
    expect(checkPostSend(submitted, evidence)).toContain("false_positive_receipt");
    expect(deliveryEvidence(frame(`• Output:\n  ${text}\n› `), text).submitted).toBe(false);
  });
  it("rejects tool output after an older user prompt as submission proof", () => {
    expect(deliveryEvidence(frame(`› Earlier request\n• Output:\n  ${text}\n› `), text).submitted).toBe(false);
  });
  it("does not report an unchanged pre-existing queue as a false negative", () => {
    expect(checkPostSend({ ok: false, error_code: "submit_unverified" },
      { readable: true, queued: true, submitted: false, newAccepted: false })).toEqual([]);
  });
  it("recognizes a wrapped queue row without borrowing another item", () => {
    expect(deliveryEvidence(frame("• Queued follow-up inputs\n  ↳ Reply exactly SOAK_UNIQUE\n    then stop.\n› "), text).queued).toBe(true);
  });
  it("records false negatives separately, including newly queued text", () => {
    const receipt = { ok: false, error_code: "submit_unverified" };
    for (const body of [`› ${text}\n• done\n› `, `• Queued follow-up inputs\n  ↳ ${text}\n› `]) {
      expect(checkPostSend(receipt, deliveryEvidence(frame(body), text))).toContain("false_negative_receipt");
    }
    expect(checkPostSend(receipt, deliveryEvidence(frame(`› ${text}`), text))).toEqual([]);
  });
  it("requires readable proof and checks no-enter staging separately", () => {
    expect(checkPostSend(submitted, deliveryEvidence({}, text))).toContain("delivery_observation_unavailable");
    expect(checkPostSend({ ok: true }, deliveryEvidence(frame(`› ${text}`), text), { staged: true })).toEqual([]);
    expect(checkPostSend({ ok: true }, deliveryEvidence(frame("› "), text), { staged: true })).toContain("draft_not_staged");
  });
  it("fails stuck queues even when surfaced and accepts eventual submission", () => {
    expect(checkDeliveryDeadline({ submitted: false, queued: true }, 1000, 1000)).toEqual(["stuck_delivery"]);
    expect(checkDeliveryDeadline({ submitted: true }, 1000, 1000)).toEqual([]);
  });
  it("polls through a queue and retains the final deadline evidence", async () => {
    let now = 0;
    const evidence = await pollDelivery({ read: async () => ({ submitted: false, queued: true }),
      now: () => now, sleep: async (ms: number) => { now += ms; }, timeoutMs: 1000 });
    expect(evidence).toMatchObject({ submitted: false, queued: true, elapsedMs: 1000 });
  });
  it("selects cases without changing the duration floor and rejects typos", () => {
    expect(options(["--agent-id", "scratch", "--cases", "a,f"])).toMatchObject({ cases: ["a", "f"], durationMinutes: 60 });
    expect(() => options(["--agent-id", "scratch", "--cases", "x"])).toThrow(/cases/);
  });
});
