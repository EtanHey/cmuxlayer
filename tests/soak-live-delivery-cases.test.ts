import { expect, it } from "vitest";
import { runDeliveryCases } from "../scripts/soak-live-delivery-cases.mjs";

async function run(cases: string[], frame = {}) {
  const violations: string[] = [];
  const sends: string[] = [];
  const logs: Array<{ kind: string; case: string }> = [];
  let now = 0;
  await runDeliveryCases({ cases, seat: {}, owner: { agentId: "owner", surface: "uuid-1" },
    foreign: { agentId: "foreign", surface: "uuid-2" }, opts: { timeoutMs: 1000 },
    now: () => now, sleep: async (ms: number) => { now += ms; },
    read: async () => frame, settle: async () => {},
    send: async (_seat: unknown, args: { text: string }) => {
      sends.push(args.text);
      return { receipt: { ok: true, submit_verified: true }, evidence: frame };
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
  const sends: string[] = [], settled: string[] = [], violations: string[] = [];
  let reads = 0;
  await runDeliveryCases({ cases: ["h"], seat: {}, relayText,
    owner: { agentId: "owner", surface: "uuid-1" }, foreign: { agentId: "foreign", surface: "uuid-2" },
    opts: { timeoutMs: 1000 }, now: () => 0, sleep: async () => {},
    read: async () => reads++ === 0 ? { busy: true } : { readable: true },
    send: async (_seat: unknown, args: { text: string }) => {
      sends.push(args.text);
      return { receipt: { ok: true, queued_behind_turn: true }, evidence: { queued: true, queueRows: 3 } };
    }, settle: async (_seat: unknown, text: string) => { settled.push(text); },
    check: (_name: string, failures: string[]) => violations.push(...failures), log: () => {} });
  expect(violations).toEqual([]);
  expect(sends[0]).toMatch(/^Run sleep 30/);
  expect(sends[1]).toBe(relayText);
  expect(settled).toEqual([relayText]);
});
