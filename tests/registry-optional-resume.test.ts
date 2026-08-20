import { beforeEach, describe, expect, it } from "vitest";
import {
  buildRawResumeCommand,
  buildResumeCommand,
} from "../src/agent-command.js";
import {
  resumeCommandForAgent,
  resumeInvocationForAgent,
} from "../src/agent-facade.js";
import { useHarnessHome } from "./helpers/harness-home.js";

const SESSION = "019d9aa5-93c0-7a52-9c47-9be1f7625f3e";

describe("raw resume commands carry a working directory", () => {
  it("prefixes a cd for every harness when a cwd is known", () => {
    expect(
      buildRawResumeCommand("claude", "brainlayer", SESSION, {
        cwd: "/srv/repos/brainlayer",
      }),
    ).toBe(
      "cd '/srv/repos/brainlayer' && MCP_CONNECTION_NONBLOCKING=1 CLAUDE_CODE_NO_FLICKER=1 claude --dangerously-skip-permissions --resume " +
        SESSION,
    );
    expect(
      buildRawResumeCommand("codex", "brainlayer", SESSION, {
        cwd: "/srv/repos/brainlayer",
      }),
    ).toBe(`cd '/srv/repos/brainlayer' && codex --dangerously-bypass-approvals-and-sandbox resume ${SESSION}`);
    expect(
      buildRawResumeCommand("cursor", "brainlayer", SESSION, {
        cwd: "/srv/repos/brainlayer",
      }),
    ).toBe(`cd '/srv/repos/brainlayer' && cursor agent --force --resume ${SESSION}`);
  });

  it("quotes a cwd containing shell metacharacters", () => {
    expect(
      buildRawResumeCommand("codex", "brainlayer", SESSION, {
        cwd: "/tmp/a b'c",
      }),
    ).toBe(`cd '/tmp/a b'\\''c' && codex --dangerously-bypass-approvals-and-sandbox resume ${SESSION}`);
  });

  it("lets an explicit cwd override the kiro ~/Gits assumption", () => {
    expect(
      buildRawResumeCommand("kiro", "brainlayer", SESSION, {
        cwd: "/srv/repos/brainlayer",
      }),
    ).toBe(
      "cd '/srv/repos/brainlayer' && MCP_CONNECTION_NONBLOCKING=1 CLAUDE_CODE_NO_FLICKER=1 kiro-cli chat --resume-id " +
        SESSION,
    );
  });

  it("stays byte-identical to the pre-existing form when no cwd is supplied", () => {
    expect(buildRawResumeCommand("claude", "brainlayer", SESSION)).toBe(
      `MCP_CONNECTION_NONBLOCKING=1 CLAUDE_CODE_NO_FLICKER=1 claude --dangerously-skip-permissions --resume ${SESSION}`,
    );
    expect(buildRawResumeCommand("codex", "brainlayer", SESSION)).toBe(
      `codex --dangerously-bypass-approvals-and-sandbox resume ${SESSION}`,
    );
  });
});

describe("buildResumeCommand falls back to the raw CLI, never a guessed launcher", () => {
  it("keeps the launcher form when a launcher name is known", () => {
    expect(
      buildResumeCommand("claude", "brainlayer", SESSION, "brainlayerClaude", {
        cwd: "/srv/repos/brainlayer",
      }),
    ).toBe(`brainlayerClaude -s --resume ${SESSION}`);
    expect(
      buildResumeCommand("codex", "matchmat", SESSION, "mmCodex"),
    ).toBe(`mmCodex --dangerously-bypass-approvals-and-sandbox resume ${SESSION}`);
  });

  it("emits raw CLI resume when no launcher was recorded (fresh install)", () => {
    expect(buildResumeCommand("claude", "brainlayer", SESSION)).toBe(
      `MCP_CONNECTION_NONBLOCKING=1 CLAUDE_CODE_NO_FLICKER=1 claude --dangerously-skip-permissions --resume ${SESSION}`,
    );
    expect(buildResumeCommand("codex", "brainlayer", SESSION)).toBe(
      `codex --dangerously-bypass-approvals-and-sandbox resume ${SESSION}`,
    );
    expect(buildResumeCommand("cursor", "brainlayer", SESSION)).toBe(
      `cursor agent --force --resume ${SESSION}`,
    );
  });

  it("emits raw CLI resume with the recorded cwd when one is known", () => {
    expect(
      buildResumeCommand("claude", "brainlayer", SESSION, null, {
        cwd: "/srv/repos/brainlayer",
      }),
    ).toBe(
      "cd '/srv/repos/brainlayer' && MCP_CONNECTION_NONBLOCKING=1 CLAUDE_CODE_NO_FLICKER=1 claude --dangerously-skip-permissions --resume " +
        SESSION,
    );
  });

  it("falls back to raw when the recorded launcher name is unusable", () => {
    expect(
      buildResumeCommand("codex", "brainlayer", SESSION, "not a launcher!"),
    ).toBe(`codex --dangerously-bypass-approvals-and-sandbox resume ${SESSION}`);
  });

  it("never emits a nonexistent ${repo}${Suffix} binary", () => {
    for (const cli of ["claude", "codex", "cursor"] as const) {
      expect(buildResumeCommand(cli, "brainlayer", SESSION)).not.toMatch(
        /brainlayer(Claude|Codex|Cursor|Gemini)/,
      );
    }
  });

  it("carries the approval bypass into every raw resume", () => {
    // A resumed agent without its bypass blocks on its first tool call and
    // reads as a hung pane rather than a failed resume.
    expect(buildResumeCommand("claude", "brainlayer", SESSION)).toContain(
      "--dangerously-skip-permissions",
    );
    expect(buildResumeCommand("codex", "brainlayer", SESSION)).toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
    expect(buildResumeCommand("cursor", "brainlayer", SESSION)).toContain(
      "--force",
    );
  });

  it("refuses a raw gemini resume instead of emitting an index-shaped lie", () => {
    // `gemini --resume` takes "latest" or an index number, never a UUID.
    expect(() =>
      buildResumeCommand("gemini", "brainlayer", SESSION, null, {
        cwd: "/srv/repos/brainlayer",
      }),
    ).toThrow(/No raw gemini resume exists for a session UUID.*"latest" or an index/s);
    expect(() =>
      buildRawResumeCommand("gemini", "brainlayer", SESSION),
    ).toThrow(/No raw gemini resume/);
  });

  it("still emits the registered gemini launcher resume untouched", () => {
    expect(
      buildResumeCommand("gemini", "brainlayer", SESSION, "brainlayerGemini"),
    ).toBe(`brainlayerGemini -s --resume ${SESSION}`);
  });
});

describe("resumeCommandForAgent (public agent payload)", () => {
  const harnessHome = useHarnessHome();
  beforeEach(() => harnessHome.give("claude", SESSION));
  const base = {
    cli: "claude" as const,
    repo: "brainlayer",
    cli_session_id: SESSION,
    launcher_name: null,
    launch_cwd: "/srv/repos/brainlayer",
    worktree_path: null,
  };

  it("uses launch_cwd for the raw form", () => {
    expect(resumeCommandForAgent(base)).toBe(
      "cd '/srv/repos/brainlayer' && MCP_CONNECTION_NONBLOCKING=1 CLAUDE_CODE_NO_FLICKER=1 claude --dangerously-skip-permissions --resume " +
        SESSION,
    );
  });

  it("prefers the worktree path when the agent runs in one", () => {
    expect(
      resumeCommandForAgent({
        ...base,
        worktree_path: "/srv/repos/brainlayer/.worktrees/lane",
      }),
    ).toBe(
      "cd '/srv/repos/brainlayer/.worktrees/lane' && MCP_CONNECTION_NONBLOCKING=1 CLAUDE_CODE_NO_FLICKER=1 claude --dangerously-skip-permissions --resume " +
        SESSION,
    );
  });

  it("keeps the registered launcher form untouched", () => {
    expect(
      resumeCommandForAgent({ ...base, launcher_name: "brainlayerClaude" }),
    ).toBe(`brainlayerClaude -s --resume ${SESSION}`);
  });
});

describe("advertised resumability and actual resume never disagree", () => {
  const harnessHome = useHarnessHome();
  beforeEach(() => harnessHome.give("claude", SESSION));
  const base = {
    cli: "claude" as const,
    repo: "brainlayer",
    cli_session_id: SESSION,
    launcher_name: null,
    launch_cwd: null,
    worktree_path: null,
  };

  // Regression guard for the ~/Gits divergence: the engine used to build its
  // resume through harnessCwdForAgent, which never returns null, so an agent
  // reported NOT resumable could still be sent `cd ~/Gits/<repo> && claude
  // --resume <id>` -- silently starting a new session in a lookalike tree.
  it("refuses, with a reason, exactly when it declines to advertise", () => {
    const invocation = resumeInvocationForAgent(base);

    expect(resumeCommandForAgent(base)).toBeUndefined();
    expect(invocation.command).toBeNull();
    expect(invocation.reason).toMatch(/needs a recorded working directory/);
  });

  it("explains a gemini refusal rather than reporting it as merely unaimed", () => {
    const invocation = resumeInvocationForAgent({
      ...base,
      cli: "gemini",
      launch_cwd: "/srv/repos/brainlayer",
    });

    expect(invocation.command).toBeNull();
    expect(invocation.reason).toMatch(/no raw resume form that takes a session UUID/);
  });

  it("explains a malformed session id instead of flattening it to unresumable", () => {
    const invocation = resumeInvocationForAgent({
      ...base,
      cli: "codex",
      cli_session_id: "019d9aa5",
    });

    expect(invocation.command).toBeNull();
    expect(invocation.reason).toMatch(/full session UUID/i);
  });

  it("agrees with itself whenever it DOES advertise", () => {
    const record = { ...base, launch_cwd: "/srv/repos/brainlayer" };

    expect(resumeInvocationForAgent(record).command).toBe(
      resumeCommandForAgent(record),
    );
  });
});
