import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventLog } from "../src/event-log.js";
import type { StateTransition } from "../src/agent-types.js";

const TEST_DIR = join(tmpdir(), "cmux-agents-test-eventlog");

function makeTransition(overrides?: Partial<StateTransition>): StateTransition {
  return {
    ts: "2026-03-14T03:40:00Z",
    agent_id: "codex-brainlayer-1710388800",
    event: "transition",
    from_state: "creating",
    to_state: "booting",
    surface_id: "surface:42",
    source: "spawn_agent",
    error: null,
    ...overrides,
  };
}

describe("EventLog", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("creates the events.jsonl file on first append", () => {
    const log = new EventLog(TEST_DIR);
    const filePath = join(TEST_DIR, "events.jsonl");

    expect(existsSync(filePath)).toBe(false);
    log.append(makeTransition());
    expect(existsSync(filePath)).toBe(true);
  });

  it("writes valid JSONL — one JSON object per line", () => {
    const log = new EventLog(TEST_DIR);
    log.append(makeTransition({ to_state: "booting" }));
    log.append(makeTransition({ from_state: "booting", to_state: "ready" }));

    const lines = readFileSync(join(TEST_DIR, "events.jsonl"), "utf-8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]);
    expect(first.to_state).toBe("booting");

    const second = JSON.parse(lines[1]);
    expect(second.to_state).toBe("ready");
  });

  it("includes all StateTransition fields in each line", () => {
    const log = new EventLog(TEST_DIR);
    const transition = makeTransition();
    log.append(transition);

    const line = readFileSync(join(TEST_DIR, "events.jsonl"), "utf-8").trim();
    const parsed = JSON.parse(line);
    expect(parsed.ts).toBe(transition.ts);
    expect(parsed.agent_id).toBe(transition.agent_id);
    expect(parsed.event).toBe(transition.event);
    expect(parsed.from_state).toBe(transition.from_state);
    expect(parsed.to_state).toBe(transition.to_state);
    expect(parsed.surface_id).toBe(transition.surface_id);
    expect(parsed.source).toBe(transition.source);
    expect(parsed.error).toBeNull();
  });

  it("creates parent directories if they don't exist", () => {
    const nestedDir = join(TEST_DIR, "deep", "nested");
    const log = new EventLog(nestedDir);
    log.append(makeTransition());
    expect(existsSync(join(nestedDir, "events.jsonl"))).toBe(true);
  });

  it("readAll returns all transitions in order", () => {
    const log = new EventLog(TEST_DIR);
    log.append(makeTransition({ to_state: "booting", event: "created" }));
    log.append(
      makeTransition({
        from_state: "booting",
        to_state: "ready",
        event: "transition",
      }),
    );
    log.append(
      makeTransition({
        from_state: "ready",
        to_state: "working",
        event: "transition",
      }),
    );

    const all = log.readAll();
    expect(all).toHaveLength(3);
    expect(all[0].to_state).toBe("booting");
    expect(all[1].to_state).toBe("ready");
    expect(all[2].to_state).toBe("working");
  });

  it("readAll returns empty array when no file exists", () => {
    const emptyDir = join(TEST_DIR, "empty");
    mkdirSync(emptyDir, { recursive: true });
    const log = new EventLog(emptyDir);
    expect(log.readAll()).toEqual([]);
  });

  it("readForAgent filters by agent_id", () => {
    const log = new EventLog(TEST_DIR);
    log.append(makeTransition({ agent_id: "agent-a", to_state: "booting" }));
    log.append(makeTransition({ agent_id: "agent-b", to_state: "booting" }));
    log.append(makeTransition({ agent_id: "agent-a", to_state: "ready" }));

    const agentA = log.readForAgent("agent-a");
    expect(agentA).toHaveLength(2);
    expect(agentA[0].to_state).toBe("booting");
    expect(agentA[1].to_state).toBe("ready");
  });
});
