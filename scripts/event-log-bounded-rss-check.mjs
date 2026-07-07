#!/usr/bin/env node

import { createWriteStream, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i], process.argv[i + 1]);
}

const sizeMb = Number(args.get("--size-mb") ?? 256);
const maxRssDeltaMb = Number(args.get("--max-rss-delta-mb") ?? 128);
if (!Number.isFinite(sizeMb) || sizeMb <= 0) {
  throw new Error("--size-mb must be a positive number");
}
if (!Number.isFinite(maxRssDeltaMb) || maxRssDeltaMb <= 0) {
  throw new Error("--max-rss-delta-mb must be a positive number");
}

const { EventLog } = await import("../dist/event-log.js");
const dir = mkdtempSync(join(tmpdir(), "cmux-event-log-rss-"));
const filePath = join(dir, "events.jsonl");

try {
  await writeFixture(filePath, Math.floor(sizeMb * 1024 * 1024));
  global.gc?.();
  const before = process.memoryUsage().rss;
  const closes = new EventLog(dir).readCloseEvents();
  global.gc?.();
  const after = process.memoryUsage().rss;
  const delta = after - before;
  const maxDelta = maxRssDeltaMb * 1024 * 1024;

  console.log(
    JSON.stringify(
      {
        file: filePath,
        file_bytes: statSync(filePath).size,
        close_events: closes.length,
        rss_before: before,
        rss_after: after,
        rss_delta: delta,
        max_rss_delta: maxDelta,
      },
      null,
      2,
    ),
  );

  if (!closes.some((entry) => entry.target === "surface:recent")) {
    throw new Error("recent close event was not returned from the bounded tail");
  }
  if (delta > maxDelta) {
    throw new Error(`RSS delta ${delta} exceeded limit ${maxDelta}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

async function writeFixture(path, targetBytes) {
  const stream = createWriteStream(path, { encoding: "utf8" });
  const filler = {
    ts: "2026-07-06T12:00:00Z",
    agent_id: "agent-filler",
    event: "transition",
    from_state: "ready",
    to_state: "working",
    surface_id: "surface:filler",
    source: "fixture",
    error: null,
    payload: "x".repeat(4096),
  };
  let written = 0;
  while (written < targetBytes) {
    const line = JSON.stringify({
      ...filler,
      agent_id: `agent-${written}`,
    }) + "\n";
    written += Buffer.byteLength(line);
    if (!stream.write(line)) await waitForStreamEvent(stream, "drain");
  }

  const recentClose =
    JSON.stringify({
      ts: "2026-07-06T12:05:00Z",
      event_type: "close",
      event: "close_surface",
      target: "surface:recent",
      caller: "bounded-rss-fixture",
      force: false,
      reason: null,
      refused: false,
    }) + "\n";
  if (!stream.write(recentClose)) await waitForStreamEvent(stream, "drain");
  stream.end();
  await waitForStreamEvent(stream, "finish");
}

async function waitForStreamEvent(stream, event) {
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off(event, onEvent);
      stream.off("error", onError);
    };
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    stream.once(event, onEvent);
    stream.once("error", onError);
  });
}
