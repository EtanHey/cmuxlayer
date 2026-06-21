import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MODEL_OVERRIDE_ENV,
  MODEL_POLICY_CONTRACT,
  resolveSpawnModelPolicy,
} from "../src/model-policy.js";

function expectPatternMatches(patterns: string[], model: string): void {
  expect(
    patterns.some((pattern) => new RegExp(pattern, "i").test(model)),
    `expected one forbidden cursor pattern to match ${model}`,
  ).toBe(true);
}

function parseClaudeDefault(dispatchText: string): string {
  const branch = dispatchText.match(
    /else\s*\n\s*_claude_model="([^"]+)"\s*\n\s*fi/,
  );
  expect(
    branch,
    "could not parse golem-dispatch default _claude_model branch",
  ).not.toBeNull();
  return branch![1];
}

function parseCursorLauncher(dispatchText: string): string {
  const launcher = dispatchText.match(
    /_golem_launch_cursor\(\)\s*\{([\s\S]*?)\n\}/,
  );
  expect(
    launcher,
    "could not parse _golem_launch_cursor from golem-dispatch",
  ).not.toBeNull();
  return launcher![1];
}

describe("model-policy drift gate", () => {
  it("pins the server-side model policy contract used by spawn_agent", () => {
    expect(MODEL_OVERRIDE_ENV).toBe("REPOGOLEM_ALLOW_MODEL");
    expect(MODEL_POLICY_CONTRACT.escapeEnv).toBe(MODEL_OVERRIDE_ENV);

    const cursor = MODEL_POLICY_CONTRACT.cli.cursor;
    expect(cursor.allowModelOverrideByDefault).toBe(false);
    for (const model of ["claude-opus-4-8", "sonnet", "opus", "haiku"]) {
      expectPatternMatches(cursor.forbiddenModelPatterns, model);
    }

    expect(MODEL_POLICY_CONTRACT.cli.claude.defaultModel).toBe(
      "claude-opus-4-8[1m]",
    );

    const coerced = resolveSpawnModelPolicy("cursor", "sonnet-4", {});
    expect(coerced.coerced).toBe(true);
    expect(coerced.effective_model).toBe(cursor.defaultModel);
    expect(coerced.launcher_model).toBeNull();
    expect(coerced.warnings).toHaveLength(1);
    expect(coerced.warnings[0]).toContain("CURSOR MODEL POLICY");
    expect(coerced.warnings[0]).toContain("sonnet-4");

    const escaped = resolveSpawnModelPolicy("cursor", "sonnet-4", {
      [MODEL_OVERRIDE_ENV]: "1",
    });
    expect(escaped.coerced).toBe(false);
    expect(escaped.effective_model).toBe("sonnet-4");
    expect(escaped.launcher_model).toBe("sonnet-4");
    expect(escaped.override_allowed).toBe(true);
  });
});

const dispatchPath = join(
  homedir(),
  "Gits/golems/scripts/repogolem/golem-dispatch.zsh",
);
const golemsAbsent = !existsSync(dispatchPath);

describe.skipIf(golemsAbsent)("model-policy parity with golem-dispatch", () => {
  const dispatchText = readFileSync(dispatchPath, "utf8");

  it("shares the explicit model override escape hatch", () => {
    expect(dispatchText).toContain(MODEL_OVERRIDE_ENV);
    expect(MODEL_OVERRIDE_ENV).toBe("REPOGOLEM_ALLOW_MODEL");
  });

  it("keeps the Claude default model aligned across launch paths", () => {
    const dispatchDefault = parseClaudeDefault(dispatchText);
    const contractDefault = MODEL_POLICY_CONTRACT.cli.claude.defaultModel;

    expect(
      contractDefault,
      `golem-dispatch default ${dispatchDefault} must match MODEL_POLICY_CONTRACT cli.claude.defaultModel ${contractDefault}`,
    ).toBe(dispatchDefault);
  });

  it("refuses Cursor agent -m overrides in both policy paths", () => {
    const cursorLauncher = parseCursorLauncher(dispatchText);

    expect(cursorLauncher).toContain("_golem_refuse_agent_model_override");
    expect(MODEL_POLICY_CONTRACT.cli.cursor.allowModelOverrideByDefault).toBe(
      false,
    );
  });
});
