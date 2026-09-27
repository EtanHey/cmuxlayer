import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { containReportPath, readReportTail } from "../src/coordination-paths.js";

// #906: Codex Sol's uninstrumented race (docs.local/lanes/2026-09-27-review-903-r2-race.ts)
// as a regression. A worker thread keeps swapping the report's parent dir for a
// symlink to an outside fixture and back, with no mocks and no coordination;
// the reader runs the real containment + read. The #903 r2 pathname recheck
// leaked 5 outside reads in 1,937 attempts; the secure open must leak none.

const TOGGLER = `
const { workerData, parentPort } = require("node:worker_threads");
const fs = require("node:fs");
const stop = new Int32Array(workerData.stop);
const p = workerData.nested;
const old = p + "-old";
let cycles = 0;
parentPort.postMessage("ready");
while (!Atomics.load(stop, 0)) {
  fs.renameSync(p, old);
  fs.symlinkSync(workerData.outside, p);
  fs.unlinkSync(p);
  fs.renameSync(old, p);
  cycles++;
}
parentPort.postMessage({ cycles });
`;

describe("#906 report open under a concurrent parent re-swap", () => {
  const savedHome = process.env.HOME;
  let root = "";

  afterEach(() => {
    process.env.HOME = savedHome;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("reads the outside file 0 times in at least 2,000 attempts", async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cmuxlayer-open-race-")));
    process.env.HOME = root;
    const nested = join(root, ".cmux", "agents", "race-agent", "nested");
    const outside = join(root, "outside");
    mkdirSync(nested, { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(nested, "report.md"), "INSIDE\n");
    writeFileSync(join(outside, "report.md"), "OUTSIDE_SENTINEL_906\n");

    const stop = new Int32Array(new SharedArrayBuffer(4));
    const worker = new Worker(TOGGLER, { eval: true, workerData: { nested, outside, stop: stop.buffer } });
    let cycles = 0;
    const exited = new Promise((resolve, reject) => {
      worker.on("error", reject);
      worker.on("exit", resolve);
    });
    worker.on("message", (m) => {
      if (m?.cycles) cycles = m.cycles;
    });
    await new Promise((resolve) => worker.once("message", resolve));

    let attempts = 0;
    let contained = 0;
    let insideReads = 0;
    let escaped = 0;
    try {
      const started = Date.now();
      while (attempts < 10_000 && Date.now() - started < 12_000) {
        attempts += 1;
        const c = await containReportPath(join(nested, "report.md"), "race-agent");
        if (!c.ok) continue;
        contained += 1;
        const r = await readReportTail(c.resolved);
        if (r.ok && r.text?.includes("OUTSIDE_SENTINEL_906")) escaped += 1;
        if (r.ok && r.text?.includes("INSIDE")) insideReads += 1;
      }
    } finally {
      Atomics.store(stop, 0, 1);
      await exited;
    }
    console.log(`#906 race: ${JSON.stringify({ attempts, contained, insideReads, escaped, cycles })}`);

    expect(attempts).toBeGreaterThanOrEqual(2_000);
    expect(cycles).toBeGreaterThan(0);
    expect(contained).toBeGreaterThan(0);
    // Not vacuous: the read path really opens the report while it races.
    expect(insideReads).toBeGreaterThan(0);
    expect(escaped).toBe(0);
  }, 30_000);
});
