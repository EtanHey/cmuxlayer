import { describe, expect, it, vi } from "vitest";
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
    await send({
      ...base,
      observed_at_ms: 1_000,
      report_headers: ["### worker-a → lead — first"],
    });
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
        `Watch watch-a for ${owner}: report changed; target=/tmp/report.md`,
        "New entries:",
        "- ### worker-a → lead — first",
      ].join("\n"),
    );
    expect(payloads[2]?.body).toBe(
      [
        `Watch watch-a for ${owner}: report entries disappeared (1); target=/tmp/report.md`,
        "Missing entries:",
        "- ### worker-c → lead — lost",
      ].join("\n"),
    );
    expect(payloads[3]).toMatchObject({
      body: `Watch watch-a for ${owner}: target_changed; target=/tmp/report.md`,
      dedupe_key: "watch-a:target_changed:same-content-digest",
    });
    expect(payloads.map((payload) => payload.dedupe_key)).toEqual([
      "watch-a:target_changed:report:1000:same-content-digest",
      "watch-a:target_changed:report:61000:same-content-digest",
      "watch-a:target_changed:report:62000:same-content-digest",
      "watch-a:target_changed:same-content-digest",
    ]);
  });
});
