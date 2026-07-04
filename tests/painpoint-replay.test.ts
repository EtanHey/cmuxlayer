import { readFileSync, readdirSync } from "node:fs";
import { basename, extname } from "node:path";
import { describe, expect, it } from "vitest";
import { parseScreen } from "../src/screen-parser.js";

type PainpointFixture = {
  id: string;
  expected_state: string;
  phase_home: string;
  source_evidence: string[];
  screen_text?: string;
  assertions?: string[];
};

const fixtureDir = new URL("./fixtures/painpoints/", import.meta.url);

function readPainpointFixture(fileName: string): PainpointFixture {
  const raw = readFileSync(new URL(fileName, fixtureDir), "utf8");
  if (fileName.endsWith(".json")) {
    return JSON.parse(raw) as PainpointFixture;
  }
  const id = basename(fileName, extname(fileName));
  const expectedById: Record<string, string> = {
    "claude-ask-user-question-overlay": "interactive_overlay",
    "claude-permission-confirmation": "permission_prompt",
    "bare-shell-and-bare-gemini-prompt": "shell",
  };
  return {
    id,
    expected_state: expectedById[id] ?? "unknown",
    phase_home:
      id === "bare-shell-and-bare-gemini-prompt"
        ? "phase-3-spawn-readiness-monitor-boot"
        : "phase-1-delivery-safety-gate",
    source_evidence: [fileName],
    screen_text: raw,
    assertions: ["canonical classifier emits the expected control-plane state"],
  };
}

const fixtureNames = readdirSync(fixtureDir)
  .filter((name) => name.endsWith(".json") || name.endsWith(".txt"))
  .sort();

const fixtures = fixtureNames.map(readPainpointFixture);

function legacyClassifierShape(fixture: PainpointFixture): string {
  if (fixture.screen_text !== undefined) {
    const parsed = parseScreen(fixture.screen_text);
    return parsed.control_state ?? `legacy:${parsed.agent_type}:${parsed.status}:${parsed.errors.join(",")}`;
  }
  return "legacy:no-canonical-control-plane-classifier";
}

describe("Phase 0 painpoint replay corpus", () => {
  it("loads every required painpoint fixture", () => {
    expect(fixtures.map((fixture) => fixture.id)).toEqual([
      "bare-shell-and-bare-gemini-prompt",
      "boot-prompt-typed-not-submitted",
      "claude-ask-user-question-overlay",
      "claude-permission-confirmation",
      "empty-dead-pane-submit",
      "long-inline-prompt-wedge",
      "multiline-payload-premature-submit",
      "registry-ghost-duplicate-surface",
      "stale-surface-after-respawn",
      "wrong-workspace-spawn",
    ]);
  });

  it("documents phase ownership and source evidence for every fixture", () => {
    for (const fixture of fixtures) {
      expect(fixture.phase_home).toBeTruthy();
      expect(fixture.source_evidence.length).toBeGreaterThan(0);
      expect(fixture.assertions?.length ?? 0).toBeGreaterThan(0);
    }
  });

  for (const fixture of fixtures) {
    const testFn =
      fixture.id === "claude-ask-user-question-overlay" ||
      fixture.id === "claude-permission-confirmation"
        ? it
        : it.todo;
    testFn(
      `${fixture.id} classifies as ${fixture.expected_state} via the canonical control-plane state machine`,
      () => {
        expect(legacyClassifierShape(fixture)).toBe(fixture.expected_state);
      },
    );
  }
});
