import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  writeDeliveryFailureTicket,
  type DeliveryFailureTicket,
} from "../src/delivery-failure-tickets.js";

const TEST_DIR = join(tmpdir(), "cmux-delivery-failure-tickets-test");

function makeTicket(
  overrides?: Partial<DeliveryFailureTicket>,
): DeliveryFailureTicket {
  return {
    signature: "sigdeadbeef1234",
    delivery_id: "delivery-1",
    agent_id: "agent-1",
    reason: "verify_deadline_elapsed",
    cli: "cursor",
    what_happened: "verify timed out",
    what_fixed_it: "do not blind-retry",
    evidence: { n: 1 },
    observed_at: "2026-08-17T20:00:00.000Z",
    ...overrides,
  };
}

describe("delivery failure tickets", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("caps stored occurrences to the last N while keeping the total count", () => {
    const cap = 10;
    const extra = 3;
    const total = cap + extra;
    let written = writeDeliveryFailureTicket(
      makeTicket({ delivery_id: "delivery-0" }),
      { dir: TEST_DIR },
    );
    for (let i = 1; i < total; i++) {
      written = writeDeliveryFailureTicket(
        makeTicket({ delivery_id: `delivery-${i}` }),
        { dir: TEST_DIR },
      );
    }

    const record = JSON.parse(
      readFileSync(written.path, "utf8"),
    ) as typeof written.record;
    expect(record.occurrence_count).toBe(total);
    expect(record.occurrences).toHaveLength(cap);
    expect(record.occurrences[0]?.delivery_id).toBe(`delivery-${extra}`);
    expect(record.occurrences.at(-1)?.delivery_id).toBe(
      `delivery-${total - 1}`,
    );
  });
});
