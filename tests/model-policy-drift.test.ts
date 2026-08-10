import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CODEX_EFFORT_VALUES,
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

function parseCodexEffortValues(dispatchText: string): string[] {
  const parser = dispatchText.match(
    /_golem_parse_codex_flags\(\)\s*\{([\s\S]*?)\n\}/,
  );
  expect(
    parser,
    "could not parse _golem_parse_codex_flags from installed launcher",
  ).not.toBeNull();
  const ladder = parser![1].match(
    /\n\s*([a-z]+(?:\|[a-z]+)+)\)\s+_flag_codex_effort="\$2"/,
  );
  expect(
    ladder,
    "could not parse Codex effort ladder from installed launcher",
  ).not.toBeNull();
  return ladder![1].split("|");
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
      "claude-opus-5[1m]",
    );

    const codex = MODEL_POLICY_CONTRACT.cli.codex;
    expect(codex.allowModelOverrideByDefault).toBe(false);

    const codexCoerced = resolveSpawnModelPolicy("codex", "gpt-5.5", {});
    expect(codexCoerced.coerced).toBe(true);
    expect(codexCoerced.effective_model).toBe(codex.defaultModel);
    expect(codexCoerced.launcher_model).toBeNull();
    expect(codexCoerced.warnings).toHaveLength(1);
    expect(codexCoerced.warnings[0]).toContain("CODEX MODEL POLICY");
    expect(codexCoerced.warnings[0]).toContain("gpt-5.5");

    const codexEscaped = resolveSpawnModelPolicy("codex", "gpt-5.5", {
      [MODEL_OVERRIDE_ENV]: "1",
    });
    expect(codexEscaped.coerced).toBe(false);
    expect(codexEscaped.effective_model).toBe("gpt-5.5");
    expect(codexEscaped.launcher_model).toBe("gpt-5.5");
    expect(codexEscaped.override_allowed).toBe(true);

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
  ".config/ralphtools/golem-dispatch.zsh",
);
const launcherAbsent = !existsSync(dispatchPath);

describe.skipIf(launcherAbsent)("model-policy parity with installed golem-dispatch", () => {
  // Read lazily in beforeAll, not at describe-body collection time: a skipped
  // suite (installed launcher absent, e.g. CI) still evaluates the describe
  // body, so a top-level readFileSync would throw before the skip takes effect.
  let dispatchText: string;
  beforeAll(() => {
    dispatchText = readFileSync(dispatchPath, "utf8");
  });

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

  it("keeps the advertised Codex effort ladder compatible with the launcher", () => {
    const installedValues = parseCodexEffortValues(dispatchText);
    expect(
      CODEX_EFFORT_VALUES,
      "spawn_agent must advertise exactly the values accepted by the launcher sourced by fresh interactive shells",
    ).toEqual(installedValues);
  });

  it("states the launcher's REAL effort default, not a stale one", () => {
    const declared = dispatchText.match(/_flag_codex_effort="([a-z]+)"/)?.[1];
    expect(declared, "could not parse _flag_codex_effort default").toBeTruthy();

    // The tool description is the text agents read at dispatch time. If it names
    // a different default than the launcher actually uses, every agent inherits
    // the wrong one.
    const serverText = readFileSync(
      join(process.cwd(), "src", "server.ts"),
      "utf8",
    );
    const claimed = serverText.match(
      /launcher defaults to ([A-Za-z]+) when omitted/i,
    )?.[1];
    if (claimed) {
      expect(
        claimed.toLowerCase(),
        `spawn_agent effort description claims "${claimed}" but golem-dispatch.zsh defaults to "${declared}"`,
      ).toBe(declared);
    }
  });

  it("refuses Cursor agent -m overrides in both policy paths", () => {
    const cursorLauncher = parseCursorLauncher(dispatchText);

    expect(cursorLauncher).toContain("_golem_refuse_agent_model_override");
    expect(MODEL_POLICY_CONTRACT.cli.cursor.allowModelOverrideByDefault).toBe(
      false,
    );
  });
});
