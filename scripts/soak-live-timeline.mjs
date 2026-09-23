import { nextSoakDelayMs, shouldContinueSoak } from "./soak-live-checks.mjs";

export async function startSoakHealthClock({ sampleHealth, now, schedule, cancel, onError,
  minDurationMs, minimumCyclesComplete }) {
  const startedAtMs = now();
  await sampleHealth("start", startedAtMs);
  let timer = null;
  let stopped = false;
  let sampling = false;
  let lastSampleStartMs = startedAtMs;
  const scheduleNext = (lastSampleStartMs) => {
    const endpointMarginMs = 25_000; // Leaves room for the 20s bounded sample.
    const latestStartMs = startedAtMs + minDurationMs - endpointMarginMs;
    const nearEndpoint = minimumCyclesComplete();
    if (nearEndpoint && lastSampleStartMs >= latestStartMs) return;
    const dueMs = nearEndpoint
      ? Math.min(lastSampleStartMs + 60_000, latestStartMs) : lastSampleStartMs + 60_000;
    timer = schedule(() => {
      timer = null;
      if (stopped) return;
      const sampleStartMs = now();
      sampling = true;
      void Promise.resolve().then(() => { if (!stopped) return sampleHealth("minute", sampleStartMs); })
        .catch(onError).finally(() => {
        sampling = false;
        lastSampleStartMs = sampleStartMs;
        if (!stopped) scheduleNext(sampleStartMs);
      });
    }, Math.max(0, dueMs - now()));
  };
  scheduleNext(startedAtMs);
  return { startedAtMs, refresh() {
    if (stopped || sampling) return;
    if (timer !== null) cancel(timer);
    scheduleNext(lastSampleStartMs);
  }, stop() {
    stopped = true;
    if (timer !== null) cancel(timer);
  } };
}

export async function withHealthTimeout(request, schedule, cancel, timeoutMs = 20_000) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(request),
      new Promise((_, reject) => { timer = schedule(() => reject(new Error("control_health_timeout")), timeoutMs); }),
    ]);
  } finally {
    if (timer !== null) cancel(timer);
  }
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

export function soakSessionRecord({ startPid, endPid, startedAtMs, endedAtMs, minCycles,
  minDurationMs, cyclesCompleted, healthSamples, rssStartKb, rssEndKb }) {
  return { startPid, endPid, startedAtMs, endedAtMs,
    elapsedMs: startedAtMs && endedAtMs ? endedAtMs - startedAtMs : 0,
    minCycles, minDurationMs, cyclesCompleted, healthSamples, rssStartKb, rssEndKb };
}
