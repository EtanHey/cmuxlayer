import { readFileSync, readdirSync } from "node:fs";
import { basename, extname } from "node:path";
import { describe, expect, it } from "vitest";
import { parseScreen } from "../src/screen-parser.js";
import { classifySurfaceSessionRoute } from "../src/state-manager.js";
import type {
  AgentRecord,
  AgentState,
  CliType,
} from "../src/agent-types.js";

type PainpointFixture = {
  id: string;
  expected_state: string;
  phase_home: string;
  source_evidence: string[];
  screen_text?: string;
  assertions?: string[];
  agent_record?: Partial<AgentRecord>;
  live_surfaces?: Array<{ ref: string }>;
  surface_session_index?: {
    agent_id: string;
    workspace_id: string | null;
    surface_id: string;
    cli_session_id: string;
    updated_at?: string;
  };
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
    return `legacy:${parsed.agent_type}:${parsed.status}:${parsed.errors.join(",")}`;
  }
  return "legacy:no-canonical-control-plane-classifier";
}

function recordFromFixture(record: Partial<AgentRecord>): AgentRecord {
  return {
    agent_id: record.agent_id ?? "fixture-agent",
    surface_id: record.surface_id ?? "surface:fixture",
    workspace_id: record.workspace_id ?? null,
    state: (record.state as AgentState | undefined) ?? "ready",
    repo: record.repo ?? "cmuxlayer",
    model: record.model ?? "unknown",
    cli: (record.cli as CliType | undefined) ?? "claude",
    cli_session_id: record.cli_session_id ?? null,
    cli_session_path: record.cli_session_path ?? null,
    task_summary: record.task_summary ?? "fixture replay",
    pid: record.pid ?? null,
    version: record.version ?? 1,
    created_at: record.created_at ?? "2026-07-04T00:00:00.000Z",
    updated_at: record.updated_at ?? "2026-07-04T00:00:00.000Z",
    error: record.error ?? null,
    parent_agent_id: record.parent_agent_id ?? null,
    spawn_depth: record.spawn_depth ?? 0,
    role: record.role ?? "worker",
    auto_archive_on_done: record.auto_archive_on_done ?? false,
    deletion_intent: record.deletion_intent ?? false,
    quality: record.quality ?? "unknown",
    max_cost_per_agent: record.max_cost_per_agent ?? null,
    crash_recover: record.crash_recover ?? false,
    respawn_attempts: record.respawn_attempts ?? 0,
    user_killed: record.user_killed ?? false,
  };
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
    if (fixture.id === "stale-surface-after-respawn") {
      it(`${fixture.id} classifies as ${fixture.expected_state} via the surface session index`, () => {
        expect(fixture.agent_record).toBeTruthy();
        expect(fixture.surface_session_index).toBeTruthy();
        const agent = recordFromFixture(fixture.agent_record ?? {});
        const indexEntry = fixture.surface_session_index
          ? {
              ...fixture.surface_session_index,
              updated_at:
                fixture.surface_session_index.updated_at ??
                "2026-07-04T00:00:00.000Z",
            }
          : null;

        expect(
          classifySurfaceSessionRoute({
            agent,
            index_entry: indexEntry,
            live_surface_refs:
              fixture.live_surfaces?.map((surface) => surface.ref) ?? [],
          }),
        ).toBe(fixture.expected_state);
      });
      continue;
    }

    it.todo(
      `${fixture.id} classifies as ${fixture.expected_state} via the canonical control-plane state machine`,
      () => {
        expect(legacyClassifierShape(fixture)).toBe(fixture.expected_state);
      },
    );
  }
});
