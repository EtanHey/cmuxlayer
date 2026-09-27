// #905: list_agents must never render a pane whose composer holds unsent text
// as `working` -- the non-boot twin of #863. Real Codex 0.157 captures.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseScreen } from "../src/screen-parser.js";
import { evaluateAgentHealth } from "../src/agent-health.js";
import type { AgentRecord } from "../src/agent-types.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/codex-0.157/${name}.txt`, import.meta.url), "utf8");

describe("#905 list_agents never renders a pending draft as working", () => {
  const agent = {
    agent_id: "codex-worker", surface_id: "surface:1", state: "working", cli: "codex", repo: "cmuxlayer",
    model: "gpt-6-sol", created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  } as unknown as AgentRecord;

  it.each(["idle-wrapped-draft", "midturn-draft-under-queues"])("masks the draft in %s", (name) => {
    const parsed = parseScreen(fixture(name));
    const health = evaluateAgentHealth(agent, {
      screen_status: parsed.status, screen_agent_type: parsed.agent_type,
      screen_control_state: parsed.control_state, screen_errors: parsed.errors,
    });
    expect(health.reconciled_state).toBe("idle");
    expect(health.issue_codes).toContain("composer_draft_pending");
  });
});

describe("#905 r2: a terminal record keeps its state under a draft", () => {
  it.each(["done", "error"] as const)("keeps %s, flags the draft, and drops the screen verdict", (state) => {
    const parsed = parseScreen(fixture("idle-wrapped-draft"));
    const health = evaluateAgentHealth({
      agent_id: "codex-worker", surface_id: "surface:1", state, cli: "codex", repo: "cmuxlayer",
      model: "gpt-6-sol", created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    } as unknown as AgentRecord, {
      screen_status: parsed.status, screen_agent_type: parsed.agent_type,
      screen_control_state: parsed.control_state, screen_errors: parsed.errors,
    });
    expect(health.reconciled_state).toBeUndefined();
    expect(health.screen_confirmed_state).toBeUndefined();
    expect(health.issue_codes).toContain("composer_draft_pending");
  });
});

