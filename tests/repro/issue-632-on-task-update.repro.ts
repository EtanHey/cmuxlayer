import { expect, it } from "vitest";

it(
  "keeps task-update RPC valid across a 61-second synchronous wait",
  () => {
    const cell = new Int32Array(new SharedArrayBuffer(4));

    expect(Atomics.wait(cell, 0, 0, 61_000)).toBe("timed-out");
  },
  70_000,
);
