import { describe, expect, it } from "vitest";
import {
  MODEL_OVERRIDE_ENV,
  MODEL_POLICY_CONTRACT,
  resolveModelAlias,
  resolveSpawnModelPolicy,
} from "../src/model-policy.js";

describe("model policy contract", () => {
  it("declares per-CLI defaults and override rules", () => {
    expect(MODEL_POLICY_CONTRACT.cli.cursor).toMatchObject({
      defaultModel: "auto",
      allowModelOverrideByDefault: false,
    });
    expect(MODEL_POLICY_CONTRACT.cli.gemini.defaultModel).toBe("pro");
    expect(MODEL_POLICY_CONTRACT.cli.claude.defaultModel).toBe(
      "opus-4-8[1m]",
    );
    expect(MODEL_POLICY_CONTRACT.cli.codex.defaultModel).toBe("codex");
  });

  it("coerces Cursor model overrides to auto unless the escape env is enabled", () => {
    const coerced = resolveSpawnModelPolicy("cursor", "sonnet", {});

    expect(coerced.effective_model).toBe("auto");
    expect(coerced.launcher_model).toBeNull();
    expect(coerced.coerced).toBe(true);
    expect(coerced.warnings[0]).toContain("CURSOR MODEL POLICY");
    expect(coerced.warnings[0]).toContain("sonnet");

    const escaped = resolveSpawnModelPolicy("cursor", "sonnet", {
      [MODEL_OVERRIDE_ENV]: "1",
    });

    expect(escaped.effective_model).toBe("sonnet");
    expect(escaped.launcher_model).toBe("sonnet");
    expect(escaped.coerced).toBe(false);
    expect(escaped.override_allowed).toBe(true);
  });

  it("resolves omitted models to per-CLI defaults without pinning launcher args", () => {
    expect(resolveSpawnModelPolicy("cursor", undefined, {}).effective_model).toBe(
      "auto",
    );
    expect(resolveSpawnModelPolicy("claude", undefined, {}).effective_model).toBe(
      "opus-4-8[1m]",
    );
    expect(resolveSpawnModelPolicy("gemini", undefined, {}).effective_model).toBe(
      "pro",
    );
    expect(resolveSpawnModelPolicy("codex", undefined, {}).effective_model).toBe(
      "codex",
    );

    expect(resolveSpawnModelPolicy("gemini", undefined, {}).launcher_model).toBeNull();
  });

  it("passes Gemini aliases through for repoGolem canonical resolution", () => {
    expect(resolveModelAlias("gemini", "pro")).toBe("pro");
    expect(resolveModelAlias("gemini", "pro-high")).toBe("pro-high");
    expect(resolveModelAlias("gemini", "gemini-2.5-pro")).toBe(
      "gemini-2.5-pro",
    );
  });
});
