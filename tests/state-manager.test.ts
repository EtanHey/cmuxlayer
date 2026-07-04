import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  classifySurfaceSessionRoute,
  StateManager,
} from "../src/state-manager.js";
import type { AgentRecord } from "../src/agent-types.js";

const TEST_DIR = join(tmpdir(), "cmux-agents-test-state");

function makeRecord(overrides?: Partial<AgentRecord>): AgentRecord {
  return {
    agent_id: "codex-brainlayer-1710388800",
    surface_id: "surface:42",
    state: "creating",
    repo: "brainlayer",
    model: "codex",
    cli: "codex",
    cli_session_id: null,
    cli_session_path: null,
    task_summary: "Fix search gap F",
    pid: null,
    version: 0,
    created_at: "2026-03-14T03:40:00Z",
    updated_at: "2026-03-14T03:40:00Z",
    error: null,
    parent_agent_id: null,
    spawn_depth: 0,
    deletion_intent: false,
    quality: "unknown",
    max_cost_per_agent: null,
    ...overrides,
  };
}

describe("StateManager", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("writeState", () => {
    it("creates agent directory and state.json", () => {
      const mgr = new StateManager(TEST_DIR);
      const record = makeRecord();
      mgr.writeState(record);

      const stateFile = join(TEST_DIR, record.agent_id, "state.json");
      expect(existsSync(stateFile)).toBe(true);
    });

    it("writes valid JSON matching the AgentRecord schema", () => {
      const mgr = new StateManager(TEST_DIR);
      const record = makeRecord();
      mgr.writeState(record);

      const stateFile = join(TEST_DIR, record.agent_id, "state.json");
      const parsed = JSON.parse(readFileSync(stateFile, "utf-8"));
      expect(parsed.agent_id).toBe(record.agent_id);
      expect(parsed.surface_id).toBe(record.surface_id);
      expect(parsed.state).toBe(record.state);
      expect(parsed.repo).toBe(record.repo);
      expect(parsed.model).toBe(record.model);
      expect(parsed.cli).toBe(record.cli);
      expect(parsed.cli_session_id).toBeNull();
      expect(parsed.cli_session_path).toBeNull();
      expect(parsed.version).toBe(0);
    });

    it("uses atomic rename pattern (no partial reads)", () => {
      const mgr = new StateManager(TEST_DIR);
      const record = makeRecord();
      mgr.writeState(record);

      // The .tmp file should NOT exist after write
      const tmpFile = join(TEST_DIR, record.agent_id, "state.json.tmp");
      expect(existsSync(tmpFile)).toBe(false);
    });
  });

  describe("readState", () => {
    it("returns the agent record", () => {
      const mgr = new StateManager(TEST_DIR);
      const record = makeRecord();
      mgr.writeState(record);

      const read = mgr.readState(record.agent_id);
      expect(read).not.toBeNull();
      expect(read!.agent_id).toBe(record.agent_id);
      expect(read!.state).toBe("creating");
    });

    it("returns null for non-existent agent", () => {
      const mgr = new StateManager(TEST_DIR);
      expect(mgr.readState("nonexistent-agent")).toBeNull();
    });
  });

  describe("transition", () => {
    it("updates state and increments version", () => {
      const mgr = new StateManager(TEST_DIR);
      const record = makeRecord({ state: "creating", version: 0 });
      mgr.writeState(record);

      const updated = mgr.transition(record.agent_id, "booting");
      expect(updated.state).toBe("booting");
      expect(updated.version).toBe(1);
    });

    it("updates the updated_at timestamp", () => {
      const mgr = new StateManager(TEST_DIR);
      const record = makeRecord({
        state: "creating",
        updated_at: "2026-03-14T00:00:00Z",
      });
      mgr.writeState(record);

      const updated = mgr.transition(record.agent_id, "booting");
      expect(updated.updated_at).not.toBe("2026-03-14T00:00:00Z");
    });

    it("throws on invalid transition", () => {
      const mgr = new StateManager(TEST_DIR);
      const record = makeRecord({ state: "creating" });
      mgr.writeState(record);

      expect(() => mgr.transition(record.agent_id, "working")).toThrow(
        /Invalid state transition/,
      );
    });

    it("throws for non-existent agent", () => {
      const mgr = new StateManager(TEST_DIR);
      expect(() => mgr.transition("nonexistent", "booting")).toThrow(
        /Agent not found/,
      );
    });

    it("records transition in events.jsonl", () => {
      const mgr = new StateManager(TEST_DIR);
      const record = makeRecord({ state: "creating" });
      mgr.writeState(record);
      mgr.transition(record.agent_id, "booting");

      const events = mgr.getEventLog().readAll();
      // writeState logs "created", transition logs "transition"
      expect(events.length).toBeGreaterThanOrEqual(2);
      const last = events[events.length - 1];
      expect(last.from_state).toBe("creating");
      expect(last.to_state).toBe("booting");
      expect(last.event).toBe("transition");
    });
  });

  describe("listStates", () => {
    it("returns all agent records", () => {
      const mgr = new StateManager(TEST_DIR);
      mgr.writeState(makeRecord({ agent_id: "agent-a" }));
      mgr.writeState(makeRecord({ agent_id: "agent-b" }));
      mgr.writeState(makeRecord({ agent_id: "agent-c" }));

      const all = mgr.listStates();
      expect(all).toHaveLength(3);
      const ids = all.map((a) => a.agent_id).sort();
      expect(ids).toEqual(["agent-a", "agent-b", "agent-c"]);
    });

    it("returns empty array when no agents exist", () => {
      const mgr = new StateManager(TEST_DIR);
      expect(mgr.listStates()).toEqual([]);
    });
  });

  describe("removeState", () => {
    it("deletes the agent directory", () => {
      const mgr = new StateManager(TEST_DIR);
      const record = makeRecord();
      mgr.writeState(record);
      expect(mgr.readState(record.agent_id)).not.toBeNull();

      mgr.removeState(record.agent_id);
      expect(mgr.readState(record.agent_id)).toBeNull();
    });

    it("does not throw for non-existent agent", () => {
      const mgr = new StateManager(TEST_DIR);
      expect(() => mgr.removeState("nonexistent")).not.toThrow();
    });
  });

  describe("surface session route classification", () => {
    it("classifies an indexed old surface as stale after respawn moves the agent", () => {
      const mgr = new StateManager(TEST_DIR);
      const record = makeRecord({
        agent_id: "agent-stale-1",
        surface_id: "surface:old",
        workspace_id: "workspace:main",
        state: "ready",
        cli: "claude",
        cli_session_id: "claude-session-old",
      });
      mgr.writeState(record);
      const entry = mgr.getSurfaceSessionIndex().lookup({
        workspace_id: record.workspace_id,
        surface_id: record.surface_id,
      });

      expect(
        classifySurfaceSessionRoute({
          agent: record,
          index_entry: entry,
          live_surface_refs: ["surface:new"],
        }),
      ).toBe("stale_surface");
    });

    it("classifies a recycled surface as stale when the index occupant differs", () => {
      const mgr = new StateManager(TEST_DIR);
      const oldAgent = makeRecord({
        agent_id: "agent-old",
        surface_id: "surface:reused",
        workspace_id: "workspace:main",
        state: "ready",
        cli_session_id: "session-old",
      });
      const newAgent = makeRecord({
        agent_id: "agent-new",
        surface_id: "surface:reused",
        workspace_id: "workspace:main",
        state: "ready",
        cli_session_id: "session-new",
      });
      mgr.writeState(oldAgent);
      mgr.writeState(newAgent);
      const entry = mgr.getSurfaceSessionIndex().lookup({
        workspace_id: oldAgent.workspace_id,
        surface_id: oldAgent.surface_id,
      });

      expect(
        classifySurfaceSessionRoute({
          agent: oldAgent,
          index_entry: entry,
          live_surface_refs: ["surface:reused"],
        }),
      ).toBe("stale_surface");
    });

    it("returns null when newest lookup entries tie with distinct identities", () => {
      const mgr = new StateManager(TEST_DIR);
      const updatedAt = "2026-07-04T12:00:00.000Z";
      writeFileSync(
        join(TEST_DIR, "surface-session-index.json"),
        JSON.stringify(
          {
            version: 1,
            by_agent_id: {
              "agent-a": {
                agent_id: "agent-a",
                workspace_id: "workspace:main",
                surface_id: "surface:reused",
                cli_session_id: "session-a",
                updated_at: updatedAt,
              },
              "agent-b": {
                agent_id: "agent-b",
                workspace_id: "workspace:main",
                surface_id: "surface:reused",
                cli_session_id: "session-b",
                updated_at: updatedAt,
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      expect(
        mgr.getSurfaceSessionIndex().lookup({
          workspace_id: "workspace:main",
          surface_id: "surface:reused",
        }),
      ).toBeNull();
    });
  });

  describe("ensureAutoRecord", () => {
    it("does not enable TASK_DONE auto-archive for auto-discovered agents", () => {
      const mgr = new StateManager(TEST_DIR);

      const record = mgr.ensureAutoRecord("auto-codex", {
        surface_id: "surface:auto-codex",
        surface_title: "brainlayerCodex",
        cli: "codex",
        parsed_status: "idle",
        model: "gpt-5.4",
        token_count: null,
        context_pct: null,
        has_agent: true,
        read_error: false,
      });

      expect(record.role).toBe("worker");
      expect(record.auto_archive_on_done).toBe(false);
    });

    it("assigns orchestrator role for auto-discovered Claude agents", () => {
      const mgr = new StateManager(TEST_DIR);

      const record = mgr.ensureAutoRecord("auto-claude", {
        surface_id: "surface:auto-claude",
        surface_title: "brainlayerClaude",
        cli: "claude",
        parsed_status: "idle",
        model: "sonnet",
        token_count: null,
        context_pct: null,
        has_agent: true,
        read_error: false,
      });

      expect(record.role).toBe("orchestrator");
      expect(record.auto_archive_on_done).toBe(false);
    });

    it("preserves the discovered workspace for auto-discovered agents", () => {
      const mgr = new StateManager(TEST_DIR);

      const record = mgr.ensureAutoRecord("auto-coach", {
        surface_id: "surface:auto-coach",
        surface_title: "coachClaude",
        workspace_id: "workspace:coach",
        cli: "claude",
        parsed_status: "idle",
        model: "sonnet",
        token_count: null,
        context_pct: null,
        has_agent: true,
        read_error: false,
      } as any);

      expect(record.workspace_id).toBe("workspace:coach");
    });

    it("assigns orchestrator role when the discovered cli is unknown", () => {
      const mgr = new StateManager(TEST_DIR);

      const record = mgr.ensureAutoRecord("auto-unknown", {
        surface_id: "surface:auto-unknown",
        surface_title: "mystery-agent",
        cli: "unknown",
        parsed_status: "idle",
        model: null,
        token_count: null,
        context_pct: null,
        has_agent: true,
        read_error: false,
      });

      expect(record.role).toBe("orchestrator");
      expect(record.auto_archive_on_done).toBe(false);
    });
  });
});
