import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultDeliveryIssueFiler,
  fileDeliveryFailureGithubIssue,
  writeDeliveryFailureTicket,
  type DeliveryFailureTicket,
} from "../src/delivery-failure-tickets.js";

const TEST_DIR = join(tmpdir(), "cmux-delivery-failure-tickets-test");

function makeTicket(
  overrides?: Partial<DeliveryFailureTicket>,
): DeliveryFailureTicket {
  return {
    signature: "deadbeef12345678",
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

  it("uses a colon-free GitHub search marker", async () => {
    const searches: string[] = [];
    const ticket = makeTicket();
    await fileDeliveryFailureGithubIssue(ticket, {
      runner: async (_file, args) => {
        const searchAt = args.indexOf("--search");
        if (searchAt >= 0) {
          searches.push(String(args[searchAt + 1]));
        }
        return { stdout: "[]", stderr: "" };
      },
    });

    expect(searches).toHaveLength(1);
    expect(searches[0]).toBe(`cmuxlayer-delivery-failure-${ticket.signature}`);
    expect(searches[0]).not.toMatch(/:/);
  });

  it.each([undefined, "0", "true", " 1"])("keeps evidence local with filing flag %s", async (flag) => {
    const runner = vi.fn();
    const ticket = makeTicket({ evidence: { text: "synthetic local receipt" } });
    const written = writeDeliveryFailureTicket(ticket, { dir: TEST_DIR });
    const filer = defaultDeliveryIssueFiler(
      { CMUXLAYER_FILE_DELIVERY_TICKETS: flag }, { runner },
    );
    await filer?.(ticket);
    expect(filer).toBeUndefined();
    expect(runner).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(written.path, "utf8")).occurrences[0]).toEqual(ticket);
  });

  it.each([false, true])("allowlists all public arguments for recurrence=%s", async (recurrence) => {
    const planted = [
      "synthetic receipt secret", "/Users/synthetic/private.txt",
      "SYNTHETIC_KEY=private", "12345678-1234-4234-8234-123456789abc",
    ];
    const raw = planted.join(" ");
    const ticket = makeTicket({
      what_happened: raw, what_fixed_it: raw,
      evidence: { receipt: { text: raw }, screen: raw },
    });
    const runner = vi.fn(async (_file: string, args: string[]) => ({
      stdout: args[1] === "list"
        ? (recurrence ? '[{"number":42,"url":"https://example.test/42"}]' : "[]")
        : "https://example.test/42",
      stderr: "",
    }));
    await fileDeliveryFailureGithubIssue(ticket, { runner });
    expect(runner.mock.calls[1][1][1]).toBe(recurrence ? "comment" : "create");
    const args = runner.mock.calls[1][1];
    expect(args[args.indexOf("--body") + 1]).toContain(`local ticket ${ticket.signature}`);
    for (const secret of planted) expect(JSON.stringify(runner.mock.calls)).not.toContain(secret);
    runner.mockClear();
    const filer = defaultDeliveryIssueFiler(
      { CMUXLAYER_FILE_DELIVERY_TICKETS: "1" }, { runner },
    );
    expect(filer).toBeTypeOf("function");
    await filer?.({ ...ticket, signature: raw, reason: raw, cli: raw });
    for (const secret of planted) expect(JSON.stringify(runner.mock.calls)).not.toContain(secret);
  });
});
