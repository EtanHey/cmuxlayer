import { nextSoakDelayMs, shouldContinueSoak } from "./soak-live-checks.mjs";

export async function startSoakHealthClock({ sampleHealth, now, schedule, cancel, onError }) {
  await sampleHealth("start");
  const startedAtMs = now();
  let minute = 1;
  let timer = null;
  let pending = null;
  let stopped = false;
  const scheduleNext = () => {
    timer = schedule(() => {
      timer = null;
      minute += 1;
      pending = Promise.resolve().then(() => sampleHealth("minute")).catch(onError).finally(() => {
        pending = null;
        if (!stopped) scheduleNext();
      });
    }, Math.max(0, startedAtMs + minute * 60_000 - now()));
  };
  scheduleNext();
  return { startedAtMs, async stop() {
    stopped = true;
    if (timer !== null) cancel(timer);
    if (pending) await pending;
    while (startedAtMs + minute * 60_000 <= now()) {
      minute += 1;
      await sampleHealth("minute").catch(onError);
    }
  } };
}

export async function runSoakCycles({ completed, minCycles, minDurationMs, now, startedAtMs,
  sleep, currentPid, startPid, runBatch }) {
  while (shouldContinueSoak(completed(), minCycles, now() - startedAtMs, minDurationMs)) {
    if (currentPid() !== startPid) break;
    const delayMs = nextSoakDelayMs(completed(), minCycles, now() - startedAtMs, minDurationMs);
    if (delayMs > 0) { await sleep(delayMs); continue; }
    await runBatch();
  }
}

export function soakSessionRecord({ startPid, endPid, startedAtMs, now, minCycles,
  minDurationMs, cyclesCompleted, healthSamples, rssStartKb, rssEndKb }) {
  return { startPid, endPid, elapsedMs: startedAtMs ? now() - startedAtMs : 0,
    minCycles, minDurationMs, cyclesCompleted, healthSamples, rssStartKb, rssEndKb };
}
