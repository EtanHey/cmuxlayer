import { afterEach, describe, expect, it, vi } from "vitest";
import { checkControlHealthSample, checkSoakSession } from "../scripts/soak-live-checks.mjs";
import { runSoakCycles, soakSessionRecord, startSoakHealthClock, withHealthTimeout } from "../scripts/soak-live-timeline.mjs";

const response = { ok: true, isError: false, health: { warnings: [],
  selected_transport: { transport_mode: "socket", transport_degraded: false } } };

async function runCase(durationMs: number, sampleLatencyMs: number, cleanupMs = 0) {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
  const samples: Array<{ atMs: number; label: string; healthy: boolean }> = [];
  let cyclesCompleted = 0;
  const sampleHealth = async (label: string, atMs = Date.now()) => {
    const sample = { atMs, label, healthy: false };
    samples.push(sample);
    const result = await withHealthTimeout(async () => { await sleep(sampleLatencyMs); return response; },
      setTimeout, clearTimeout).catch((error: unknown) =>
      ({ ok: false, isError: true, error: String(error) }));
    sample.healthy = checkControlHealthSample(result, 123, 123).length === 0;
  };
  const starting = startSoakHealthClock({ sampleHealth, now: Date.now,
    schedule: setTimeout, cancel: clearTimeout, minDurationMs: durationMs,
    minimumCyclesComplete: () => cyclesCompleted >= 40,
    onError: (error: unknown) => { throw error; } });
  await vi.advanceTimersByTimeAsync(Math.min(sampleLatencyMs, 20_000));
  const clock = await starting;
  const running = runSoakCycles({ completed: () => cyclesCompleted, minCycles: 40,
    minDurationMs: durationMs, now: Date.now, startedAtMs: clock.startedAtMs,
    sleep, currentPid: () => 123, startPid: 123,
    runBatch: async () => { cyclesCompleted += 2; clock.refresh(); } });
  let finished = false;
  void running.then(() => { finished = true; });
  for (let step = 0; step < 400 && !finished; step += 1) {
    await vi.advanceTimersToNextTimerAsync();
  }
  expect(finished).toBe(true);
  await running;
  await vi.advanceTimersByTimeAsync(cleanupMs);
  clock.stop();
  const endedAtMs = Date.now();
  const ending = sampleHealth("end");
  await vi.advanceTimersByTimeAsync(Math.min(sampleLatencyMs, 20_000));
  await ending;
  const session = soakSessionRecord({ startPid: 123, endPid: 123,
    startedAtMs: clock.startedAtMs, endedAtMs,
    minDurationMs: durationMs, minCycles: 40, cyclesCompleted, healthSamples: samples,
    rssStartKb: 100_000, rssEndKb: 190_000 });
  expect(samples[0].label).toBe("start");
  expect(samples.some((sample) => sample.label === "end")).toBe(true);
  expect(cyclesCompleted).toBe(40);
  return { session, samples };
}

describe("live soak health timeline", () => {
  afterEach(() => { vi.useRealTimers(); });

  it.each([60 * 60_000, 60 * 60_000 + 500, 61 * 60_000 + 30_000]
    .flatMap((durationMs) => [0, 2_500, 5_000]
      .map((sampleLatencyMs) => ({ durationMs, sampleLatencyMs }))))(
    "passes the real pacing loop at $durationMs ms with $sampleLatencyMs ms health latency",
    async ({ durationMs, sampleLatencyMs }) => {
      const { session } = await runCase(durationMs, sampleLatencyMs);
      expect(checkSoakSession(session)).toEqual([]);
    });

  it.each([25_000, 65_000])("records an unhealthy bounded sample after %i ms health latency", async (latency) => {
    const { session, samples } = await runCase(60 * 60_000 + 500, latency);
    expect(samples.some((sample) => !sample.healthy)).toBe(true);
    expect(checkSoakSession(session)).toContain("unhealthy_control_sample");
  });

  it("keeps healthy minute coverage through 90 seconds of final cleanup", async () => {
    const { session } = await runCase(60 * 60_000, 5_000, 90_000);
    expect(checkSoakSession(session)).toEqual([]);
  });

  it("keeps an endpoint request when a minute sample is still pending", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const labels: string[] = [];
    const sampleHealth = async (label: string) => {
      labels.push(label);
      await new Promise<void>((done) => setTimeout(done, label === "minute" ? 5_000 : 0));
    };
    const starting = startSoakHealthClock({ sampleHealth, now: Date.now,
      schedule: setTimeout, cancel: clearTimeout, minDurationMs: 60_000,
      minimumCyclesComplete: () => false, onError: (error: unknown) => { throw error; } });
    await vi.advanceTimersByTimeAsync(0);
    const clock = await starting;
    await vi.advanceTimersByTimeAsync(60_000);
    clock.stop();
    const ending = sampleHealth("end");
    await vi.advanceTimersByTimeAsync(0);
    await ending;
    expect(labels).toEqual(["start", "minute", "end"]);
  });
});
