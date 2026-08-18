import { describe, expect, it } from "vitest";
import {
  buildRawResumeCommand,
  buildResumeCommand,
} from "../src/agent-command.js";
import { resumeCommandForAgent } from "../src/agent-facade.js";

const SESSION = "019d9aa5-93c0-7a52-9c47-9be1f7625f3e";

describe("raw resume commands carry a working directory", () => {
  it("prefixes a cd for every harness when a cwd is known", () => {
    expect(
      buildRawResumeCommand("claude", "brainlayer", SESSION, {
        cwd: "/srv/repos/brainlayer",
      }),
    ).toBe(
      "cd '/srv/repos/brainlayer' && MCP_CONNECTION_NONBLOCKING=1 CLAUDE_CODE_NO_FLICKER=1 claude --resume " +
        SESSION,
    );
    expect(
      buildRawResumeCommand("codex", "brainlayer", SESSION, {
        cwd: "/srv/repos/brainlayer",
      }),
    ).toBe(`cd '/srv/repos/brainlayer' && codex resume ${SESSION}`);
    expect(
      buildRawResumeCommand("cursor", "brainlayer", SESSION, {
        cwd: "/srv/repos/brainlayer",
      }),
    ).toBe(`cd '/srv/repos/brainlayer' && cursor agent --resume ${SESSION}`);
  });

  it("quotes a cwd containing shell metacharacters", () => {
    expect(
      buildRawResumeCommand("codex", "brainlayer", SESSION, {
        cwd: "/tmp/a b'c",
      }),
    ).toBe(`cd '/tmp/a b'\\''c' && codex resume ${SESSION}`);
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
      `MCP_CONNECTION_NONBLOCKING=1 CLAUDE_CODE_NO_FLICKER=1 claude --resume ${SESSION}`,
    );
    expect(buildRawResumeCommand("codex", "brainlayer", SESSION)).toBe(
      `codex resume ${SESSION}`,
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
      `MCP_CONNECTION_NONBLOCKING=1 CLAUDE_CODE_NO_FLICKER=1 claude --resume ${SESSION}`,
    );
    expect(buildResumeCommand("codex", "brainlayer", SESSION)).toBe(
      `codex resume ${SESSION}`,
    );
    expect(buildResumeCommand("cursor", "brainlayer", SESSION)).toBe(
      `cursor agent --resume ${SESSION}`,
    );
  });

  it("emits raw CLI resume with the recorded cwd when one is known", () => {
    expect(
      buildResumeCommand("claude", "brainlayer", SESSION, null, {
        cwd: "/srv/repos/brainlayer",
      }),
    ).toBe(
      "cd '/srv/repos/brainlayer' && MCP_CONNECTION_NONBLOCKING=1 CLAUDE_CODE_NO_FLICKER=1 claude --resume " +
        SESSION,
    );
  });

  it("falls back to raw when the recorded launcher name is unusable", () => {
    expect(
      buildResumeCommand("codex", "brainlayer", SESSION, "not a launcher!"),
    ).toBe(`codex resume ${SESSION}`);
  });

  it("never emits a nonexistent ${repo}${Suffix} binary", () => {
    for (const cli of ["claude", "codex", "cursor", "gemini"] as const) {
      expect(buildResumeCommand(cli, "brainlayer", SESSION)).not.toMatch(
        /brainlayer(Claude|Codex|Cursor|Gemini)/,
      );
    }
  });
});

describe("resumeCommandForAgent (public agent payload)", () => {
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
      "cd '/srv/repos/brainlayer' && MCP_CONNECTION_NONBLOCKING=1 CLAUDE_CODE_NO_FLICKER=1 claude --resume " +
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
      "cd '/srv/repos/brainlayer/.worktrees/lane' && MCP_CONNECTION_NONBLOCKING=1 CLAUDE_CODE_NO_FLICKER=1 claude --resume " +
        SESSION,
    );
  });

  it("keeps the registered launcher form untouched", () => {
    expect(
      resumeCommandForAgent({ ...base, launcher_name: "brainlayerClaude" }),
    ).toBe(`brainlayerClaude -s --resume ${SESSION}`);
  });
});
