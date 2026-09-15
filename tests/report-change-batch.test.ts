import { describe, expect, it } from "vitest";
import {
  advanceReportChangeBatch as advance,
  createReportChangeBatchState as create,
  settleReportChangeBatch as settle,
} from "../src/report-change-batch.js";
const owner = "cmuxlayerCodex-b012b093";
const step = (state: ReturnType<typeof create>, content: string, at: number) =>
  advance(state, { content, owner, observedAtMs: at });
describe("report change batching", () => {
  it("coalesces only new non-owner headers after 60 quiet seconds", () => {
    const old = "### old-worker → lead — historical\n";
    const first = old + "### worker-a → lead — first\n";
    let result = step(create(old), first, 1_000);
    expect(result.action).toEqual({ kind: "defer", retryAtMs: 61_000 });
    const mixed =
      first +
      `### ${owner} → reviewer — self\n` +
      `### reviewer-b → ${owner} — second\n`;
    result = step(result.state, mixed, 30_000);
    expect(result.state.pendingHeaders).toEqual([
      "### worker-a → lead — first",
      `### reviewer-b → ${owner} — second`,
    ]);
    expect(step(result.state, mixed, 89_999).action.kind).toBe("defer");
    expect(step(result.state, mixed, 90_000).action).toEqual({
      kind: "deliver",
      headers: [
        "### worker-a → lead — first",
        `### reviewer-b → ${owner} — second`,
      ],
    });
  });
  it("handles rewrites by header-set difference and reports loss immediately", () => {
    const old =
      "### worker-a → lead — keep\n### worker-b → lead — lost\n";
    let result = step(
      create(old),
      "rewritten preface\n" + old + "### worker-c → lead — new\n",
      1_000,
    );
    expect(result.state.pendingHeaders).toEqual([
      "### worker-c → lead — new",
    ]);
    result = step(
      result.state,
      "### worker-a → lead — keep\n### worker-c → lead — new\n",
      2_000,
    );
    expect(result.action).toEqual({
      kind: "lost",
      count: 1,
      headers: ["### worker-b → lead — lost"],
    });
  });
  it("suppresses ID-bearing authors, not ambiguous roles or recipients", () => {
    const result = step(
      create(""),
      `### cmuxlayer lead ${owner} → reviewer — self\n` +
        `### ${owner} → reviewer — self exact\n` +
        "### cmuxlayer lead → reviewer — ambiguous\n" +
        `### worker-a → ${owner} — recipient\n`,
      1_000,
    );
    expect(result.state.pendingHeaders).toEqual([
      "### cmuxlayer lead → reviewer — ambiguous",
      `### worker-a → ${owner} — recipient`,
    ]);
    expect(
      step(create(""), `### ${owner} → reviewer — self\n`, 1_000).action,
    ).toEqual({ kind: "none" });
  });
  it("persists pending state across restart and ignores fenced headings", () => {
    const content =
      "```md\n### fake → lead — quoted\n```\n### real → lead — pending\n";
    const first = step(create(""), content, 1_000);
    const restored = JSON.parse(JSON.stringify(first.state));
    expect(step(restored, content, 61_000).action).toEqual({
      kind: "deliver",
      headers: ["### real → lead — pending"],
    });
  });
  it("passes plain changes through and bounds continuous batches/history", () => {
    expect(step(create("plain\n"), "plain changed\n", 1_000).action).toEqual({
      kind: "passthrough",
    });
    let content = "";
    let state = create(content);
    for (let at = 0; at <= 110_000; at += 10_000) {
      content += `### worker-${at} → lead — update\n`;
      const result = step(state, content, at);
      expect(result.action.kind).toBe("defer");
      state = result.state;
    }
    const due = step(state, content, 120_000);
    expect(due.action.kind).toBe("deliver");
    state = settle(due.state, 120_000);
    content += "### worker-next → lead — next\n";
    expect(step(state, content, 121_000).action).toEqual({
      kind: "defer",
      retryAtMs: 181_000,
    });
    const large = Array.from(
      { length: 4_100 },
      (_, index) => `### worker-${index} → lead — update`,
    ).join("\n");
    expect(create(large).seenHeaderHashes).toHaveLength(4_096);
  });
});
