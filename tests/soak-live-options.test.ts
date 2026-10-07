import { describe, expect, it } from "vitest";
import { options, cycleAssignment, isPoolSeatDead } from "../scripts/soak-live-options.mjs";

describe("soak runner options", () => {
  const base = ["--agent-id", "scratch", "--private-home", "/private-soak-home"];

  it("keeps the duration gate with a small cheap pool", () => {
    expect(options(base)).toMatchObject({ pool: 2, freshEvery: 5, cycles: 40, durationMinutes: 60,
      claudeModel: "haiku", codexModel: "gpt-6-luna", codexEffort: "low" });
  });

  it("accepts low-drain model and pool settings", () => {
    expect(options([...base, "--claude-model", "haiku", "--codex-model", "gpt-6-luna",
      "--codex-effort", "low", "--pool", "2"])).toMatchObject({
      claudeModel: "haiku", codexModel: "gpt-6-luna", codexEffort: "low",
      pool: 2, freshEvery: 5,
    });
  });

  it("rejects expensive models, oversized pools, and production inbox reads", () => {
    for (const args of [["--codex-model", "gpt-6-sol"], ["--codex-effort", "high"],
      ["--claude-model", "opus"], ["--pool", "4"], ["--lead-agent-id", "production-lead"]]) {
      expect(() => options([...base, ...args])).toThrow(/soak/);
    }
  });

  it("refuses reduced-duration or incomplete M1 release gates", () => {
    expect(() => options([...base, "--target", "m1-gate", "--cases", "a,b,c"])).toThrow(/release gate/);
    expect(() => options([...base, "--target", "m1-gate", "--cases", "a,b,c,d,e,f,g", "--duration-minutes", "0"])).toThrow(/release gate/);
    expect(options([...base, "--target", "m1-gate", "--cases", "a,b,c,d,e,f,g,h"])).toMatchObject({ cycles: 40, durationMinutes: 60 });
    expect(options(["--agent-id", "scratch", "--dry-run", "true"])).toMatchObject({ dryRun: true });
    expect(() => options(["--agent-id", "scratch"])).toThrow(/private-home/);
  });

  it("rejects a pool smaller than concurrency and unusable fresh intervals", () => {
    expect(() => options([...base, "--pool", "1"])).toThrow(/pool/);
    expect(() => options([...base, "--pool", "2", "--fresh-every", "0"])).toThrow(/fresh-every/);
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

it("M1 real runs do not require private-home; NIGHTLY real runs do", () => {
  expect(options(["--agent-id", "scratch", "--target", "m1-gate", "--cases", "a,b,c,d,e,f,g"]))
    .toMatchObject({ target: "m1-gate", privateHome: "" });
  expect(() => options(["--agent-id", "scratch"])).toThrow(/private-home/);
});
