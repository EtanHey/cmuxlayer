import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProcessLiveness } from "../src/util/pid-alive.js";

// The reservation probe must go through util/pid-alive (one liveness policy:
// only ESRCH proves absence). The mock stands in for the kernel's answer.
const liveness = vi.hoisted(() => ({ value: "alive" as ProcessLiveness }));
vi.mock("../src/util/pid-alive.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/util/pid-alive.js")>()),
  processLiveness: () => liveness.value,
}));

const { reserveWatchReportPath } = await import("../src/watch-spec.js");

const TEST_DIR = join(tmpdir(), `cmuxlayer-watch-spec-pid-alive-${process.pid}`);
const registryPath = () => join(TEST_DIR, "watches.json");
const STARTED_AT_MS = 5_000;

function writeReservation(target: string): void {
  writeFileSync(
    `${registryPath()}.report-path-reservations.json`,
    `${JSON.stringify({
      version: 2,
      reservations: [
        {
          reservation_id: "held",
          owner: "lead-a",
          target,
          subject_agent_id: "child-old",
          // A live PID whose start time matches the row: only the liveness
          // probe decides whether the reservation still holds.
          pid: process.ppid,
          created_at_ms: 1_000,
          process_started_at_ms: STARTED_AT_MS,
        },
      ],
    })}\n`,
    "utf8",
  );
}

describe("watch report-path reservation liveness (util/pid-alive)", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it.each([
    ["gone", true],
    ["unknown", false],
    ["alive", false],
  ] as const)("a %s owner frees the reservation: %s", async (observed, reclaimed) => {
    liveness.value = observed;
    const target = join(TEST_DIR, `report-${observed}.md`);
    writeFileSync(target, "", "utf8");
    writeReservation(target);

    const result = await reserveWatchReportPath(
      { owner: "lead-a", target, subject_agent_id: "child-new" },
      {
        registryPath: registryPath(),
        reservationProcessStartedAtMs: () => STARTED_AT_MS,
      },
    );

    expect(result.ok).toBe(reclaimed);
  });
});
