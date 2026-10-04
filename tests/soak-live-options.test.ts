import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { options, cycleAssignment, isPoolSeatDead, targetSeatOptions } from "../scripts/soak-live-options.mjs";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "soak-model-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("CMUXLAYER_SOAK_CODEX_MODEL", "");
  vi.stubEnv("CMUXLAYER_MODEL_ROLES", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("soak runner options", () => {
  const base = ["--agent-id", "scratch"];

  it("keeps the original fresh-seat defaults", () => {
    expect(options(base)).toMatchObject({ pool: 0, freshEvery: 0,
      claudeModel: null, codexModel: null, codexEffort: "low" });
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

describe("soak Codex target model resolution", () => {
  const base = ["--agent-id", "scratch"];
  function roles(content: string, defaultPath = false) {
    const path = defaultPath ? join(home, "Gits/golems/standards/model-roles.json")
      : join(home, "roles.json");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
    if (!defaultPath) vi.stubEnv("CMUXLAYER_MODEL_ROLES", path);
    return path;
  }
  const valid = JSON.stringify({ roles: { "codex.subagent.mechanical": { model: "test-mechanical" } } });

  it("prefers the flag over environment and roles without warning", () => {
    roles(valid);
    vi.stubEnv("CMUXLAYER_SOAK_CODEX_MODEL", "test-env");
    expect(options([...base, "--codex-model", "test-flag"]).codexModel).toBe("test-flag");
    expect(console.error).not.toHaveBeenCalled();
  });
  it("prefers environment over roles without warning", () => {
    roles(valid);
    vi.stubEnv("CMUXLAYER_SOAK_CODEX_MODEL", "test-env");
    expect(options(base).codexModel).toBe("test-env");
    expect(console.error).not.toHaveBeenCalled();
  });
  it("reads the mechanical role from the configured file", () => {
    roles(valid);
    expect(options(base).codexModel).toBe("test-mechanical");
    expect(console.error).not.toHaveBeenCalled();
  });
  it("reads the default roles path under a scratch home", () => {
    roles(valid, true);
    expect(options(base).codexModel).toBe("test-mechanical");
    expect(console.error).not.toHaveBeenCalled();
  });
  it("leaves the target unpinned with one warning when no roles file exists", () => {
    expect(options(base)).toMatchObject({ codexModel: null, codexEffort: "low", claudeModel: null });
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/target model is unpinned/));
  });
  it("does not fall back to the home file when the configured path is absent", () => {
    roles(valid, true);
    vi.stubEnv("CMUXLAYER_MODEL_ROLES", join(home, "absent.json"));
    expect(options(base).codexModel).toBeNull();
    expect(console.error).toHaveBeenCalledTimes(1);
  });
  it.each(["{", "null", "{}", '{"roles":{"codex.subagent.mechanical":{}}}',
    '{"roles":{"codex.subagent.mechanical":{"model":42}}}',
    '{"roles":{"codex.subagent.mechanical":{"model":" "}}}'])
    ("falls back with one explanatory warning for invalid roles: %s", (content) => {
      roles(content);
      expect(options(base).codexModel).toBeNull();
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/target model is unpinned.*roles/i));
    });
});

describe("soak target spawn payload", () => {
  it("omits an unpinned model while retaining Codex effort", () => {
    expect(targetSeatOptions("codex", { codexModel: null, codexEffort: "low" }))
      .toEqual({ effort: "low" });
    expect(targetSeatOptions("claude", { claudeModel: null })).toEqual({});
  });
  it("passes resolved models to their target harness", () => {
    expect(targetSeatOptions("codex", { codexModel: "test-model", codexEffort: "low" }))
      .toEqual({ model: "test-model", effort: "low" });
    expect(targetSeatOptions("claude", { claudeModel: "test-claude" }))
      .toEqual({ model: "test-claude" });
  });
});
