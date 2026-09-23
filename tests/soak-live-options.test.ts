import { describe, expect, it } from "vitest";
import { options, cycleAssignment, isPoolSeatDead } from "../scripts/soak-live-options.mjs";

describe("soak runner options", () => {
  const base = ["--agent-id", "scratch"];

  it("keeps the original fresh-seat defaults", () => {
    expect(options(base)).toMatchObject({ pool: 0, freshEvery: 0,
      claudeModel: null, codexModel: "gpt-6-sol", codexEffort: "low" });
  });

  it("accepts low-drain model and pool settings", () => {
    expect(options([...base, "--claude-model", "haiku", "--codex-model", "gpt-6-luna",
      "--codex-effort", "low", "--pool", "4"])).toMatchObject({
      claudeModel: "haiku", codexModel: "gpt-6-luna", codexEffort: "low",
      pool: 4, freshEvery: 5,
    });
  });

  it("rejects a pool smaller than concurrency and unusable fresh intervals", () => {
    expect(() => options([...base, "--pool", "1"])).toThrow(/pool/);
    expect(() => options([...base, "--pool", "4", "--fresh-every", "0"])).toThrow(/fresh-every/);
  });
});

describe("pool and fresh scheduling", () => {
  it("keeps old alternating fresh cycles when pooling is off", () => {
    expect([1, 2, 3].map((cycle) => cycleAssignment(cycle, 0, 0))).toEqual([
      { kind: "fresh", cli: "claude" }, { kind: "fresh", cli: "codex" },
      { kind: "fresh", cli: "claude" },
    ]);
  });

  it("round-robins pool slots without counting scheduled fresh cycles", () => {
    expect(Array.from({ length: 10 }, (_, i) => cycleAssignment(i + 1, 4, 5))).toEqual([
      { kind: "pool", slot: 0, cli: "claude" },
      { kind: "pool", slot: 1, cli: "codex" },
      { kind: "pool", slot: 2, cli: "claude" },
      { kind: "pool", slot: 3, cli: "codex" },
      { kind: "fresh", cli: "claude" },
      { kind: "pool", slot: 0, cli: "claude" },
      { kind: "pool", slot: 1, cli: "codex" },
      { kind: "pool", slot: 2, cli: "claude" },
      { kind: "pool", slot: 3, cli: "codex" },
      { kind: "fresh", cli: "codex" },
    ]);
  });
});

describe("pool seat liveness", () => {
  it("reuses a done seat after its exact-marker reply", () => {
    expect(isPoolSeatDead({ state: "done" })).toBe(false);
    expect(isPoolSeatDead({ state: "ready" })).toBe(false);
  });

  it("replaces only an error seat or a missing row", () => {
    expect(isPoolSeatDead({ state: "error" })).toBe(true);
    expect(isPoolSeatDead(null)).toBe(true);
  });
});
