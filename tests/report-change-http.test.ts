import { describe, expect, it, vi } from "vitest";
import {
  formatBoundedReportNotification,
  REPORT_NOTIFICATION_BODY_LIMIT,
} from "../src/report-notification-format.js";
import { httpNotifyWatch } from "../src/watch-spec.js";
const owner = "cmuxlayerCodex-b012b093";
const base = {
  watch_id: "watch-a",
  owner,
  notify: true as const,
  target: "/tmp/report.md",
  target_kind: "file" as const,
  reason: "target_changed" as const,
  observed_value: "same-content-digest",
};
describe("report change HTTP notifications", () => {
  it("serializes report details and gives successive batches distinct dedupe keys", async () => {
    const deliver = vi.fn().mockResolvedValue(true);
    const send = (event: Parameters<typeof httpNotifyWatch>[0]) =>
      httpNotifyWatch(event, "http://notify.invalid", deliver);
    const firstBatch = {
      ...base,
      observed_at_ms: 1_000,
      report_headers: ["### worker-a → lead — first"],
    };
    await send(firstBatch);
    await send(firstBatch);
    await send({
      ...base,
      observed_at_ms: 61_000,
      report_headers: ["### worker-b → lead — second"],
    });
    await send({
      ...base,
      observed_at_ms: 62_000,
      report_lost_header_count: 1,
      report_lost_headers: ["### worker-c → lead — lost"],
    });
    await send({ ...base, observed_at_ms: 63_000 });
    const payloads = deliver.mock.calls.map(([payload]) => payload);
    expect(payloads[0]?.body).toBe(
      [
        `Watch watch-a for ${owner}: report changed (1); target=/tmp/report.md`,
        "New entries:",
        "- ### worker-a → lead — first",
      ].join("\n"),
    );
    expect(payloads[3]).toMatchObject({
      body: [
        `Watch watch-a for ${owner}: report entries disappeared (1); target=/tmp/report.md`,
        "Missing entries:",
        "- ### worker-c → lead — lost",
      ].join("\n"),
      priority: "high",
    });
    expect(payloads[4]).toMatchObject({
      body: `Watch watch-a for ${owner}: target_changed; target=/tmp/report.md`,
      dedupe_key: "watch-a:target_changed:same-content-digest",
      priority: "normal",
    });
    expect(payloads.map((payload) => payload.dedupe_key)).toEqual([
      "watch-a:target_changed:report:1000:same-content-digest",
      "watch-a:target_changed:report:1000:same-content-digest",
      "watch-a:target_changed:report:61000:same-content-digest",
      "watch-a:target_changed:report:62000:same-content-digest",
      "watch-a:target_changed:same-content-digest",
    ]);
  });
  it("bounds a real-path long-header body while retaining the exact total", async () => {
    const deliver = vi.fn().mockResolvedValue(true);
    const target =
      "/Users/etanheyman/Gits/orchestrator/collab/2026-09-15-cmuxlayer-636.md";
    const headers = Array.from(
      { length: 25 },
      (_, index) => `### worker-${index} → lead — ${"x".repeat(240)}`,
    );
    await httpNotifyWatch(
      {
        ...base,
        target,
        observed_at_ms: 1_000,
        report_lost_header_count: 25,
        report_lost_headers: headers,
      },
      "http://notify.invalid",
      deliver,
    );
    const httpBody = deliver.mock.calls[0]?.[0].body as string;
    const localBody = formatBoundedReportNotification({
      firstLine: `[report] entries disappeared (25) — inspect ${target}`,
      truncatedFirstLine:
        "[report] entries disappeared (25) — target truncated",
      label: "Missing entries:",
      headers,
      totalCount: 25,
    });
    for (const body of [httpBody, localBody]) {
      const lines = body.split("\n");
      const listed = lines.filter((line) => line.startsWith("- "));
      expect(lines[0]).toContain("entries disappeared (25)");
      expect(body.length).toBeLessThanOrEqual(REPORT_NOTIFICATION_BODY_LIMIT);
      expect(listed.length).toBeLessThanOrEqual(20);
      expect(listed.every((line) => line.length <= 200)).toBe(true);
      expect(lines.at(-1)).toBe(`…and ${25 - listed.length} more`);
    }
  });
  it("uses an explicit count-preserving fallback for an oversized prefix", async () => {
    const deliver = vi.fn().mockResolvedValue(true);
    await httpNotifyWatch(
      {
        ...base,
        target: `/tmp/${"x".repeat(4_000)}/report.md`,
        observed_at_ms: 1_000,
        report_lost_header_count: 25,
        report_lost_headers: ["### worker-a → lead — lost"],
      },
      "http://notify.invalid",
      deliver,
    );
    const body = deliver.mock.calls[0]?.[0].body as string;
    expect(body.length).toBeLessThanOrEqual(REPORT_NOTIFICATION_BODY_LIMIT);
    expect(body).toContain("Report entries disappeared (25)");
    expect(body).toContain("watch metadata and target truncated");
    expect(body).not.toContain("/tmp/");
  });
  it("degrades instead of throwing when even the fallback prefix is oversized", () => {
    const body = formatBoundedReportNotification({
      firstLine: "x".repeat(4_000),
      truncatedFirstLine: `Report entries disappeared (25); ${"x".repeat(4_000)}`,
      label: "Missing entries:",
      headers: [],
      totalCount: 25,
    });
    expect(body).toHaveLength(REPORT_NOTIFICATION_BODY_LIMIT);
    expect(body).toMatch(/^Report entries disappeared \(25\);/);
    expect(body).toMatch(/… \(truncated\)$/);
  });
});
