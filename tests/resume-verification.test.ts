/**
 * Lane T1 — #482: `resumable` must be an observation, not a formatting result.
 *
 * Measured 2026-08-19: 13 rows advertised `resumable: true`; 2 of them (both
 * LEAD seats) pointed at session files that exist nowhere on disk, while the
 * live pane was writing a different session. Running those `resume_command`s
 * restores nothing — at best it opens a fresh session wearing a lead's name.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveResumeArtifact,
  setResumeArtifactResolver,
  resetResumeArtifactResolver,
} from "../src/resume-verification.js";
import {
  resumeInvocationForAgent,
  toObservedPublicAgent,
  toPublicAgent,
} from "../src/agent-facade.js";
import type { AgentRecord } from "../src/agent-types.js";

const TEST_HOME = join(tmpdir(), "cmux-resume-verification-home");
const PRESENT_SESSION = "b9e7f86f-f96c-43a3-a35b-e1ff0d3ef8a9";
const MISSING_SESSION = "3c37f59c-6604-4892-9179-66a422102dbe";

function makeRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    agent_id: "brainClaude",
    surface_id: "surface:1",
    state: "done",
    repo: "brainlayer",
    model: "claude",
    cli: "claude",
    cli_session_id: PRESENT_SESSION,
    launcher_name: "brainlayerClaude",
    task_summary: "t1",
    pid: null,
    version: 1,
    created_at: "2026-08-19T10:00:00.000Z",
    updated_at: "2026-08-19T10:00:00.000Z",
    error: null,
    parent_agent_id: null,
    spawn_depth: 0,
    role: "orchestrator",
    deletion_intent: false,
    quality: "unknown",
    max_cost_per_agent: null,
    ...overrides,
  } as AgentRecord;
}

describe("T1 #482 — resumable is verified against the session artifact", () => {
  beforeEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
    mkdirSync(join(TEST_HOME, ".claude", "projects", "-Users-x-brainlayer"), {
      recursive: true,
    });
    writeFileSync(
      join(
        TEST_HOME,
        ".claude",
        "projects",
        "-Users-x-brainlayer",
        `${PRESENT_SESSION}.jsonl`,
      ),
      "{}\n",
    );
    setResumeArtifactResolver((cli, sessionId) =>
      resolveResumeArtifact(cli, sessionId, { home: TEST_HOME }),
    );
  });

  afterEach(() => {
    resetResumeArtifactResolver();
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it("reports present / missing / unverifiable from the harness store", () => {
    expect(
      resolveResumeArtifact("claude", PRESENT_SESSION, { home: TEST_HOME }),
    ).toBe("present");
    expect(
      resolveResumeArtifact("claude", MISSING_SESSION, { home: TEST_HOME }),
    ).toBe("missing");
    // No harness store on this machine at all: absence of evidence is not
    // evidence of absence, so the claim stays unverified rather than false.
    expect(
      resolveResumeArtifact("claude", MISSING_SESSION, {
        home: join(TEST_HOME, "no-such-home"),
      }),
    ).toBe("unverifiable");
    // gemini/kiro sessions are not stored anywhere cmuxlayer can read.
    expect(
      resolveResumeArtifact("gemini", PRESENT_SESSION, { home: TEST_HOME }),
    ).toBe("unverifiable");
  });

  it("refuses a resume invocation whose session file is not on disk", () => {
    const invocation = resumeInvocationForAgent(
      makeRecord({ cli_session_id: MISSING_SESSION }),
    );
    expect(invocation.command).toBeNull();
    expect(invocation.reason).toMatch(/session/i);
    expect(invocation.reason).toContain(MISSING_SESSION);
  });

  it("keeps advertising a resume whose session file exists", () => {
    const invocation = resumeInvocationForAgent(makeRecord());
    expect(invocation.reason).toBeNull();
    expect(invocation.command).toBe(
      `brainlayerClaude -s --resume ${PRESENT_SESSION}`,
    );
  });

  it("downgrades resumable to false with disk provenance in list_agents rows", () => {
    const observed = toObservedPublicAgent(
      makeRecord({ cli_session_id: MISSING_SESSION }),
    );
    expect(observed.resumable.value).toBe(false);
    expect(observed.resumable.source).toBe("disk");
    expect(observed.resume_command).toBeUndefined();

    const publicAgent = toPublicAgent(
      makeRecord({ cli_session_id: MISSING_SESSION }),
    );
    expect(publicAgent.resumable).toBe(false);
    expect(publicAgent.resume_command).toBeUndefined();
  });

  it("marks a verified resume with disk provenance", () => {
    const observed = toObservedPublicAgent(makeRecord());
    expect(observed.resumable.value).toBe(true);
    expect(observed.resumable.source).toBe("disk");
    expect(observed.resume_command).toBe(
      `brainlayerClaude -s --resume ${PRESENT_SESSION}`,
    );
  });

  it("does not downgrade a claim it cannot check", () => {
    setResumeArtifactResolver(() => "unverifiable");
    const observed = toObservedPublicAgent(makeRecord());
    expect(observed.resumable.value).toBe(true);
    // Provenance stays `registry`: nothing on disk confirmed this.
    expect(observed.resumable.source).toBe("registry");
  });
});
