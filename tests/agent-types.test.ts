import { describe, it, expect } from "vitest";
import {
  isValidTransition,
  assertValidTransition,
  generateAgentId,
  VALID_TRANSITIONS,
  type AgentState,
} from "../src/agent-types.js";

describe("VALID_TRANSITIONS", () => {
  it("creating can go to booting or error", () => {
    expect(VALID_TRANSITIONS.creating).toEqual(["booting", "error"]);
  });

  it("booting can go to ready or error", () => {
    expect(VALID_TRANSITIONS.booting).toEqual(["ready", "error"]);
  });

  it("ready can go to working, done, or error", () => {
    expect(VALID_TRANSITIONS.ready).toEqual(["working", "done", "error"]);
  });

  it("working can go to idle, done, or error", () => {
    expect(VALID_TRANSITIONS.working).toEqual(["idle", "done", "error"]);
  });

  it("idle can go to working, done, or error", () => {
    expect(VALID_TRANSITIONS.idle).toEqual(["working", "done", "error"]);
  });

  it("done is terminal — no transitions allowed", () => {
    expect(VALID_TRANSITIONS.done).toEqual([]);
  });

  it("error can only go to creating (restart)", () => {
    expect(VALID_TRANSITIONS.error).toEqual(["creating"]);
  });
});

describe("isValidTransition", () => {
  it("allows valid forward transitions", () => {
    expect(isValidTransition("creating", "booting")).toBe(true);
    expect(isValidTransition("booting", "ready")).toBe(true);
    expect(isValidTransition("ready", "working")).toBe(true);
    expect(isValidTransition("working", "done")).toBe(true);
    expect(isValidTransition("working", "idle")).toBe(true);
    expect(isValidTransition("idle", "working")).toBe(true);
  });

  it("allows error transitions from any non-terminal state", () => {
    expect(isValidTransition("creating", "error")).toBe(true);
    expect(isValidTransition("booting", "error")).toBe(true);
    expect(isValidTransition("ready", "error")).toBe(true);
    expect(isValidTransition("working", "error")).toBe(true);
    expect(isValidTransition("idle", "error")).toBe(true);
  });

  it("allows restart from error", () => {
    expect(isValidTransition("error", "creating")).toBe(true);
  });

  it("rejects backward transitions", () => {
    expect(isValidTransition("ready", "booting")).toBe(false);
    expect(isValidTransition("working", "ready")).toBe(false);
    expect(isValidTransition("done", "working")).toBe(false);
  });

  it("rejects transitions from terminal done state", () => {
    expect(isValidTransition("done", "creating")).toBe(false);
    expect(isValidTransition("done", "error")).toBe(false);
    expect(isValidTransition("done", "working")).toBe(false);
  });

  it("rejects skipping states", () => {
    expect(isValidTransition("creating", "ready")).toBe(false);
    expect(isValidTransition("creating", "working")).toBe(false);
    expect(isValidTransition("booting", "working")).toBe(false);
  });
});

describe("assertValidTransition", () => {
  it("does not throw for valid transitions", () => {
    expect(() => assertValidTransition("creating", "booting")).not.toThrow();
    expect(() => assertValidTransition("working", "done")).not.toThrow();
  });

  it("throws with descriptive message for invalid transitions", () => {
    expect(() => assertValidTransition("done", "working")).toThrow(
      /Invalid state transition: done → working/,
    );
    expect(() => assertValidTransition("creating", "ready")).toThrow(
      /Allowed from creating: \[booting, error\]/,
    );
  });
});

describe("generateAgentId", () => {
  it("produces a model-repo-timestamp pattern", () => {
    const id = generateAgentId("codex", "brainlayer");
    expect(id).toMatch(/^codex-brainlayer-\d+$/);
  });

  it("sanitizes repo names with special characters", () => {
    const id = generateAgentId("claude", "my/weird repo");
    expect(id).toMatch(/^claude-my-weird-repo-\d+$/);
  });

  it("generates unique IDs for sequential calls", () => {
    const id1 = generateAgentId("sonnet", "test");
    // Ensure different even at same second by checking format
    expect(id1).toMatch(/^sonnet-test-\d+$/);
  });
});
