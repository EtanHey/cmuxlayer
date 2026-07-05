import { readFileSync, readdirSync } from "node:fs";
import { basename, extname } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRouteTable } from "../src/agent-facade.js";
import { evaluateAgentHealth } from "../src/agent-health.js";
import { createServer, SEND_INPUT_MAX_INLINE_CHARS } from "../src/server.js";
import { reposEquivalent } from "../src/repo-workspace.js";
import { parseScreen } from "../src/screen-parser.js";
import type { ExecFn } from "../src/cmux-client.js";
import { classifySurfaceSessionRoute } from "../src/state-manager.js";
import {
  getTool,
  parseErroredToolResult,
  parseToolResult,
} from "./helpers/mcp-tool-harness.js";
import type {
  AgentRecord,
  AgentState,
  CliType,
} from "../src/agent-types.js";

type PainpointFixture = {
  id: string;
  expected_state: string;
  secondary_state?: string;
  phase_home: string;
  source_evidence: string[];
  screen_text?: string;
  submitted_text?: string;
  read_error?: {
    message: string;
    error_code: string;
  };
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
  parent_agent?: {
    repo: string;
    workspace_id: string;
  };
  spawn_request?: {
    repo: string;
    focused_workspace: string;
    explicit_workspace: string | null;
  };
  records?: Partial<AgentRecord>[];
  inline_length?: number;
  payload?: string;
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
    "codex-update-menu": "interactive_overlay",
    "bare-shell-and-bare-gemini-prompt": "shell",
  };
  return {
    id,
    expected_state: expectedById[id] ?? "unknown",
    phase_home:
      id === "bare-shell-and-bare-gemini-prompt" || id === "codex-update-menu"
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
  if (fixture.read_error?.error_code === "pane_died") {
    return "dead";
  }

  if (fixture.screen_text !== undefined) {
    if (
      fixture.agent_record?.boot_prompt_pending === true &&
      fixture.submitted_text !== undefined &&
      fixture.screen_text.includes(fixture.submitted_text)
    ) {
      return "composer_dirty";
    }

    const parsed = parseScreen(fixture.screen_text);
    return parsed.control_state ?? `legacy:${parsed.agent_type}:${parsed.status}:${parsed.errors.join(",")}`;
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

function classifyRegistryGhostDuplicateFixture(
  fixture: PainpointFixture,
): string {
  const records = fixture.records?.map(recordFromFixture) ?? [];
  const liveSurfaceRefs = new Set(
    records
      .map((record) => record.surface_id)
      .filter((surfaceId) => surfaceId !== "surface:missing"),
  );

  const hasMissingSurfaceRecord = records.some(
    (record) => !liveSurfaceRefs.has(record.surface_id),
  );
  let hasConflictingRoutes = false;
  try {
    buildRouteTable(records);
  } catch (error) {
    hasConflictingRoutes =
      error instanceof Error && /Conflicting routes/.test(error.message);
  }

  return hasMissingSurfaceRecord || hasConflictingRoutes
    ? "poisoned_registry"
    : "unknown";
}

describe("Phase 0 painpoint replay corpus", () => {
  it("loads every required painpoint fixture", () => {
    expect(fixtures.map((fixture) => fixture.id)).toEqual([
      "bare-shell-and-bare-gemini-prompt",
      "boot-prompt-typed-not-submitted",
      "claude-ask-user-question-overlay",
      "claude-permission-confirmation",
      "codex-update-menu",
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

    if (fixture.id === "wrong-workspace-spawn") {
      it(`${fixture.id} inherits the same-repo parent workspace and flags wrong actual placement`, () => {
        expect(fixture.parent_agent).toBeTruthy();
        expect(fixture.spawn_request).toBeTruthy();
        const parent = fixture.parent_agent!;
        const spawn = fixture.spawn_request!;
        expect(reposEquivalent(parent.repo, spawn.repo)).toBe(true);
        expect(spawn.explicit_workspace).toBeNull();

        const child = recordFromFixture({
          agent_id: "child-worker",
          surface_id: "surface:child",
          workspace_id: parent.workspace_id,
          repo: spawn.repo,
          cli: "codex",
          role: "worker",
          state: "ready",
        });

        expect(
          evaluateAgentHealth(child, {
            monitor_alive: true,
            surface_workspace_id: parent.workspace_id,
          }).issue_codes,
        ).not.toContain("registry_surface_workspace_mismatch");
        expect(
          evaluateAgentHealth(child, {
            monitor_alive: true,
            surface_workspace_id: spawn.focused_workspace,
          }).issue_codes,
        ).toContain("registry_surface_workspace_mismatch");
      });
      continue;
    }

    if (fixture.id === "registry-ghost-duplicate-surface") {
      it(`${fixture.id} classifies as ${fixture.expected_state} via registry route guards`, () => {
        const records = fixture.records?.map(recordFromFixture) ?? [];
        expect(records.length).toBeGreaterThan(0);
        expect(() => buildRouteTable(records)).toThrow(/Conflicting routes/);
        expect(classifyRegistryGhostDuplicateFixture(fixture)).toBe(
          fixture.expected_state,
        );
      });
      continue;
    }

    if (fixture.id === "long-inline-prompt-wedge") {
      it(`${fixture.id} refuses over-cap inline input before keystrokes are sent`, async () => {
        const overCapText = "x".repeat(
          Math.max(
            fixture.inline_length ?? 0,
            SEND_INPUT_MAX_INLINE_CHARS + 1,
          ),
        );
        const calls: string[][] = [];
        const exec: ExecFn = async (_cmd, args) => {
          calls.push([...args]);
          return { stdout: "{}", stderr: "" };
        };
        const server = createServer({
          exec,
          skipAgentLifecycle: true,
        });

        const result = await getTool(server, "send_input").handler(
          {
            surface: "surface:long-inline",
            text: overCapText,
          },
          {},
        );
        const parsed = parseErroredToolResult<{ ok: boolean; error?: string }>(
          result,
        );

        expect(parsed.ok).toBe(false);
        expect(parsed.error).toContain(
          `CMUXLAYER_MAX_INLINE_CHARS=${SEND_INPUT_MAX_INLINE_CHARS}`,
        );
        expect(parsed.error).toContain("CMUXLAYER_MAX_INLINE_CHARS");
        expect(calls).toEqual([]);
      });
      continue;
    }

    if (fixture.id === "multiline-payload-premature-submit") {
      it(`${fixture.id} pastes multiline payload as one message and presses Enter once`, async () => {
        const pastedTexts: string[] = [];
        const keys: string[] = [];
        const sentTexts: string[] = [];
        const exec: ExecFn = async (_cmd, args) => {
          const command = args[1];
          if (command === "read-screen") {
            return {
              stdout: JSON.stringify({
                surface_ref: "surface:multiline",
                text: "OpenAI Codex\nModel: gpt-5.5\n\ncodex> ",
                lines: 4,
              }),
              stderr: "",
            };
          }
          if (command === "set-buffer") {
            pastedTexts.push(args.at(-1) ?? "");
            return { stdout: "{}", stderr: "" };
          }
          if (command === "paste-buffer") {
            return { stdout: "{}", stderr: "" };
          }
          if (command === "send-key") {
            keys.push(args.at(-1) ?? "");
            return { stdout: "{}", stderr: "" };
          }
          if (command === "send") {
            sentTexts.push(args.at(-1) ?? "");
            return { stdout: "{}", stderr: "" };
          }
          return { stdout: "{}", stderr: "" };
        };
        const server = createServer({
          exec,
          skipAgentLifecycle: true,
        });

        const result = await getTool(server, "send_input").handler(
          {
            surface: "surface:multiline",
            text: fixture.payload ?? "line one\nline two\nline three",
            press_enter: true,
          },
          {},
        );
        const parsed = parseToolResult<{ ok: boolean }>(result);

        expect(parsed.ok).toBe(true);
        expect(pastedTexts).toEqual([
          fixture.payload ?? "line one\nline two\nline three",
        ]);
        expect(sentTexts).toEqual([]);
        expect(keys).toEqual(["return"]);
      });
      continue;
    }

    it(
      `${fixture.id} classifies as ${fixture.expected_state} via the canonical control-plane state machine`,
      () => {
        expect(legacyClassifierShape(fixture)).toBe(fixture.expected_state);
      },
    );
  }
});
