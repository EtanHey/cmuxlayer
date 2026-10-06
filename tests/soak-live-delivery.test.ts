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
    const evidence = await pollDelivery({ read: () => Promise.resolve({ submitted: false, queued: true }),
      now: () => now, sleep: (ms: number) => { now += ms; return Promise.resolve(); }, timeoutMs: 1000 });
    expect(evidence).toMatchObject({ submitted: false, queued: true, elapsedMs: 1000 });
  });
  it("selects cases without changing the duration floor and rejects typos", () => {
    expect(options(["--agent-id", "scratch", "--private-home", "/private-soak-home", "--cases", "a,f"])).toMatchObject({ cases: ["a", "f"], durationMinutes: 60 });
    expect(() => options(["--agent-id", "scratch", "--private-home", "/private-soak-home", "--cases", "x"])).toThrow(/cases/u);
  });
});

describe("long relay queue correlation", () => {
  const relay = `Read and follow /tmp/SOAK_LONG_RELAY_${"abcdef0123456789".repeat(12)}.md`;
  it("recognizes a three-row queued relay and the alt composer glyph", () => {
    const rows = [relay.slice(0, 80), relay.slice(80, 160), relay.slice(160)];
    expect(deliveryEvidence(frame(`• Queued follow-up inputs\n  ↳ ${rows.join("\n    ")}\n» `), relay))
      .toMatchObject({ readable: true, queued: true, submitted: false });
  });
  it.each(["…", "..."])("correlates a >=40-character prefix ending in %s", (ellipsis) => {
    expect(deliveryEvidence(frame(`• Queued follow-up inputs\n  ↳ ${relay.slice(0, 80)}${ellipsis}\n› `), relay).queued).toBe(true);
    expect(deliveryEvidence(frame(`• Queued follow-up inputs\n  ↳ ${relay.slice(0, 40)}${ellipsis}\n› `), relay).queued).toBe(true);
    expect(deliveryEvidence(frame(`• Queued follow-up inputs\n  ↳ ${relay.slice(0, 39)}${ellipsis}\n› `), relay).queued).toBe(false);
    expect(deliveryEvidence(frame(`• Queued follow-up inputs\n  ↳ ${relay.slice(0, 80)}WRONG${ellipsis}\n› `), relay).queued).toBe(false);
  });
  it("joins a wrapped submitted echo and leaves composer text unsubmitted", () => {
    const rows = [relay.slice(0, 80), relay.slice(80, 160), relay.slice(160)];
    expect(deliveryEvidence(frame(`» ${rows.join("\n  ")}\n• done\n» `), relay).submitted).toBe(true);
    expect(deliveryEvidence(frame(`» ${rows.join("\n  ")}`), relay))
      .toMatchObject({ inComposer: true, submitted: false, queued: false });
  });
  it("selects the new h case", () => {
    expect(options(["--agent-id", "scratch", "--private-home", "/private-soak-home", "--cases", "h"]).cases).toEqual(["h"]);
  });
});

describe("Codex queue layout variants", () => {
  it("keeps both adjacent queue blocks", () => {
    const screen = frame(`• Messages to be submitted after next tool call (press esc to interrupt and send immediately)\n  ↳ ${text}\n\n• Queued follow-up inputs\n  ↳ unrelated later item\n› `);
    expect(deliveryEvidence(screen, text).queued).toBe(true);
  });
  it("recognizes a wrapped heading with its parenthetical suffix", () => {
    const screen = frame(`• Messages to be submitted after next\n  tool call (press esc to interrupt\n  and send immediately)\n  ↳ ${text}\n› `);
    expect(deliveryEvidence(screen, text).queued).toBe(true);
  });
  it.each(["│", "┃", "║", "┆", "┊"])("joins queue rows behind a %s gutter", (gutter) => {
    const screen = frame(`${gutter} • Queued follow-up inputs\n${gutter}  ↳ Reply exactly SOAK_UNIQUE\n${gutter}    then stop.\n› `);
    expect(deliveryEvidence(screen, text).queued).toBe(true);
  });
});

it("does not accept a historical queue block above a later transcript turn", () => {
  const screen = frame(`• Queued follow-up inputs\n  ↳ ${text}\n› Later request\n• Later response\n› `);
  expect(deliveryEvidence(screen, text).queued).toBe(false);
});

it("observes a submission arriving at the queue deadline", async () => {
  let now = 0;
  const evidence = await pollDelivery({
    read: () => Promise.resolve({ submitted: now === 1000 }),
    now: () => now, sleep: (ms: number) => { now += ms; return Promise.resolve(); }, timeoutMs: 1000,
  });
  expect(evidence).toMatchObject({ submitted: true, elapsedMs: 1000 });
});
