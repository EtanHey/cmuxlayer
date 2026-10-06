import { expect, it } from "vitest";
import { deliveryCaseCaller, runDeliveryCases } from "../scripts/soak-live-delivery-cases.mjs";

async function run(cases: string[], frame = {}) {
  const violations: string[] = [];
  const sends: string[] = [];
  const logs: Array<{ kind: string; case: string }> = [];
  let now = 0;
  await runDeliveryCases({ cases, seat: {}, owner: { agentId: "owner", surface: "uuid-1" },
    foreign: { agentId: "foreign", surface: "uuid-2" }, opts: { timeoutMs: 1000 },
    now: () => now, sleep: (ms: number) => { now += ms; return Promise.resolve(); },
    read: () => Promise.resolve(frame), settle: () => Promise.resolve(),
    send: (_seat: unknown, args: { text: string }) => {
      sends.push(args.text);
      return Promise.resolve({ receipt: { ok: true, submit_verified: true }, evidence: frame });
    }, check: (_name: string, failures: string[]) => violations.push(...failures),
    log: (row: { kind: string; case: string }) => logs.push(row) });
  return { violations, sends, logs };
}

it("cannot pass a busy case that never became busy, and marks the rest unrun", async () => {
  const result = await run(["a", "b", "e"]);
  expect(result.violations).toContain("busy_case_not_exercised");
  expect(result.violations.filter((v) => v === "delivery_case_not_run")).toHaveLength(2);
  expect(result.sends).toHaveLength(1);
  expect(result.logs.some((l) => l.kind === "delivery_case_done")).toBe(false);
});

it("cannot pass the key matrix without a visible idle owned draft", async () => {
  const result = await run(["d"], { inComposer: false, busy: false });
  expect(result.violations).toContain("idle_owned_draft_not_exercised");
  expect(result.sends).toHaveLength(1);
});

it("does not count a key success without independently observed submission", async () => {
  const result = await run(["f"], { inComposer: true, busy: false });
  expect(result.violations).toContain("owned_key_submit_failed");
});

it("sends a long h relay only while busy and requires wrapped queue evidence before settling", async () => {
  const relayText = `Read and follow /tmp/SOAK_RELAY_${"x".repeat(220)}.md`;
  const sends: string[] = [], settled: string[] = [], violations: string[] = [], logs: unknown[] = [];
  let reads = 0;
  await runDeliveryCases({ cases: ["h"], seat: {}, relayText,
    owner: { agentId: "owner", surface: "uuid-1" }, foreign: { agentId: "foreign", surface: "uuid-2" },
    opts: { timeoutMs: 1000 }, now: () => 0, sleep: () => Promise.resolve(),
    read: () => Promise.resolve(reads++ === 0 ? { busy: true } : { readable: true }),
    send: (_seat: unknown, args: { text: string }) => {
      sends.push(args.text);
      return Promise.resolve({ receipt: { ok: true, queued_behind_turn: true }, evidence: { queued: true, queueRows: 3 } });
    }, settle: (_seat: unknown, text: string) => { settled.push(text); return Promise.resolve(); },
    check: (_name: string, failures: string[]) => violations.push(...failures), log: (entry: unknown) => { logs.push(entry); } });
  expect(violations).toEqual([]);
  expect(sends[0]).toMatch(/^Run sleep 30/u);
  expect(sends[1]).toBe(relayText);
  expect(settled).toEqual([relayText]);
});

it("resolves a lean spawn's caller from its matching registered stable route", () => {
  expect(deliveryCaseCaller({ agentId: "scratch", surface: "surface:7" },
    { surface_id: "surface:7", surface_uuid: "scratch-uuid", workspace_id: "workspace:1" }))
    .toEqual({ agentId: "scratch", surface: "scratch-uuid" });
});

it.each([
  { surface_id: "surface:8", surface_uuid: "other-uuid", workspace_id: "workspace:1" },
  { surface_id: "surface:7", surface_uuid: null, workspace_id: "workspace:1" },
  { surface_id: "surface:7", surface_uuid: "scratch-uuid", workspace_id: "workspace:2" },
])("refuses an unbound, moved, or mismatched caller route: %j", (state) => {
  expect(() => deliveryCaseCaller({ agentId: "scratch", surface: "surface:7" }, state))
    .toThrow("case_caller_route_unavailable");
});

it.each([true, false])("case c clears its foreign draft through the drafting caller even when attention=%s", async (attention) => {
  const sends: Array<{ text: string; caller?: string }> = [], violations: string[] = [];
  let hasDraft = false, clock = 0, settled = false;
  await runDeliveryCases({ cases: ["c"], seat: {},
    owner: { agentId: "owner", surface: "uuid-1" }, foreign: { agentId: "foreign", surface: "uuid-2" },
    opts: { timeoutMs: 1000 }, now: () => clock,
    sleep: async (ms: number) => { clock += ms; },
    read: async () => ({ readable: true, inComposer: hasDraft, hasDraft, draftAttention: attention }),
    send: async (_seat: unknown, args: { text: string; press_enter?: boolean }, _cycle: string, policy: { caller?: { agentId: string } }) => {
      sends.push({ text: args.text, caller: policy.caller?.agentId });
      if (args.press_enter === false) { hasDraft = true; return { receipt: { ok: true }, evidence: { inComposer: true } }; }
      if (args.text === "Return" && policy.caller?.agentId === "foreign") {
        hasDraft = false;
        return { receipt: { ok: true, submit_verified: true }, evidence: { submitted: true } };
      }
      return { receipt: { ok: false, typed: false, error_code: "blocked_by_foreign_draft" }, evidence: { inComposer: true } };
    },
    settle: async () => { settled = true; }, check: (_name: string, failures: string[]) => violations.push(...failures), log: () => {} });
  expect(sends.at(-1)).toEqual({ text: "Return", caller: "foreign" });
  expect(hasDraft).toBe(false);
  expect(settled).toBe(true);
  expect(violations).toEqual(attention ? [] : ["foreign_draft_unsurfaced", "delivery_case_failed"]);
});
