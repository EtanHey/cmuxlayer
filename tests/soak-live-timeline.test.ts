import { afterEach, describe, expect, it, vi } from "vitest";
import { checkControlHealthSample, checkSoakSession } from "../scripts/soak-live-checks.mjs";
import { runSoakCycles, soakSessionRecord, startSoakHealthClock } from "../scripts/soak-live-timeline.mjs";

describe("live soak health timeline", () => {
  afterEach(() => { vi.useRealTimers(); });

  it.each([60 * 60_000, 60 * 60_000 + 500, 61 * 60_000 + 30_000]
    .flatMap((durationMs) => [0, 2_500, 5_000]
      .map((sampleLatencyMs) => ({ durationMs, sampleLatencyMs }))))(
    "passes the real pacing loop at $durationMs ms with $sampleLatencyMs ms health latency",
    async ({ durationMs, sampleLatencyMs }) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
      const samples: boolean[] = [];
      const labels: string[] = [];
      const sampleHealth = async (label: string) => {
        await sleep(sampleLatencyMs);
        const response = { ok: true, isError: false, health: { warnings: [],
          selected_transport: { transport_mode: "socket", transport_degraded: false } } };
        samples.push(checkControlHealthSample(response, 123, 123).length === 0);
        labels.push(label);
      };
      const starting = startSoakHealthClock({ sampleHealth, now: Date.now,
        schedule: setTimeout, cancel: clearTimeout, onError: (error: unknown) => { throw error; } });
      await vi.advanceTimersByTimeAsync(sampleLatencyMs);
      const clock = await starting;
      let cyclesCompleted = 0;
      const running = runSoakCycles({ completed: () => cyclesCompleted, minCycles: 40,
        minDurationMs: durationMs, now: Date.now, startedAtMs: clock.startedAtMs,
        sleep, currentPid: () => 123, startPid: 123,
        runBatch: async () => { cyclesCompleted += 2; } });
      let finished = false;
      void running.then(() => { finished = true; });
      for (let step = 0; step < 300 && !finished; step += 1) {
        await vi.advanceTimersToNextTimerAsync();
      }
      expect(finished).toBe(true);
      await running;
      const stopping = clock.stop();
      await vi.advanceTimersByTimeAsync(sampleLatencyMs);
      await stopping;
      const ending = sampleHealth("end");
      await vi.advanceTimersByTimeAsync(sampleLatencyMs);
      await ending;
      const session = soakSessionRecord({ startPid: 123, endPid: 123,
        startedAtMs: clock.startedAtMs, now: Date.now,
        minDurationMs: durationMs, minCycles: 40, cyclesCompleted, healthSamples: samples,
        rssStartKb: 100_000, rssEndKb: 190_000 });
      expect(labels[0]).toBe("start");
      expect(labels.at(-1)).toBe("end");
      expect(cyclesCompleted).toBe(40);
      expect(checkSoakSession(session)).toEqual([]);
    });
});
