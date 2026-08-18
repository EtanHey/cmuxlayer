import { describe, expect, it } from "vitest";
import {
  bypassesApprovals,
  DEFAULT_SPAWN_PERMISSION_MODE,
  resolveSpawnPermissionMode,
  SPAWN_PERMISSION_MODE_ENV,
} from "../src/permission-mode.js";
import {
  buildRawResumeCommand,
  buildResumeCommand,
} from "../src/agent-command.js";
import { buildLaunchCommand } from "../src/agent-engine.js";

const SESSION = "11111111-2222-4333-8444-555555555555";

describe("resolveSpawnPermissionMode", () => {
  it("defaults to skip-permissions so an unattended pane is not left waiting", () => {
    expect(resolveSpawnPermissionMode({})).toBe("skip-permissions");
    expect(DEFAULT_SPAWN_PERMISSION_MODE).toBe("skip-permissions");
  });

  it("reads default/ask/prompt as the prompting mode", () => {
    for (const value of ["default", "ask", "prompt", " ASK "]) {
      expect(
        resolveSpawnPermissionMode({ [SPAWN_PERMISSION_MODE_ENV]: value }),
      ).toBe("default");
    }
  });

  it("keeps the default for an unrecognised value rather than failing a spawn", () => {
    expect(
      resolveSpawnPermissionMode({ [SPAWN_PERMISSION_MODE_ENV]: "yolo" }),
    ).toBe("skip-permissions");
  });

  it("names which mode bypasses approvals", () => {
    expect(bypassesApprovals("skip-permissions")).toBe(true);
    expect(bypassesApprovals("default")).toBe(false);
  });
});

describe("raw launch honours the permission mode", () => {
  it("carries the approval bypass by default", () => {
    expect(
      buildLaunchCommand("claude", "alpha", undefined, undefined, {
        cwd: "/code/alpha",
        launchMode: "raw",
      }),
    ).toContain("--dangerously-skip-permissions");
  });

  it("drops the bypass for every raw CLI in default mode", () => {
    const cases: Array<[Parameters<typeof buildLaunchCommand>[0], string]> = [
      ["claude", "--dangerously-skip-permissions"],
      ["codex", "--dangerously-bypass-approvals-and-sandbox"],
      ["cursor", "--force"],
      ["gemini", "-y"],
    ];
    for (const [cli, flag] of cases) {
      const command = buildLaunchCommand(cli, "alpha", undefined, undefined, {
        cwd: "/code/alpha",
        launchMode: "raw",
        permissionMode: "default",
      });
      expect(command).not.toContain(flag);
      expect(command).toContain("cd '/code/alpha'");
    }
  });
});

describe("launcher launch honours the permission mode", () => {
  it("passes -s by default", () => {
    expect(
      buildLaunchCommand("claude", "alpha", undefined, "alphaClaude"),
    ).toBe("alphaClaude -s");
  });

  it("omits -s in default mode", () => {
    expect(
      buildLaunchCommand("claude", "alpha", undefined, "alphaClaude", {
        permissionMode: "default",
      }),
    ).toBe("alphaClaude");
  });
});

describe("resume honours the permission mode", () => {
  it("keeps the bypass on a raw resume by default", () => {
    expect(buildRawResumeCommand("claude", "alpha", SESSION)).toContain(
      "--dangerously-skip-permissions",
    );
  });

  it("drops the bypass on a raw resume in default mode", () => {
    const command = buildRawResumeCommand("claude", "alpha", SESSION, {
      cwd: "/code/alpha",
      permissionMode: "default",
    });
    expect(command).not.toContain("--dangerously-skip-permissions");
    expect(command).toContain(`--resume ${SESSION}`);
    expect(command).toContain("cd '/code/alpha'");
  });

  it("drops the launcher bypass on a launcher resume in default mode", () => {
    expect(
      buildResumeCommand("claude", "alpha", SESSION, "alphaClaude", {
        permissionMode: "default",
      }),
    ).toBe(`alphaClaude --resume ${SESSION}`);
    expect(
      buildResumeCommand("codex", "alpha", SESSION, "alphaCodex", {
        permissionMode: "default",
      }),
    ).toBe(`alphaCodex resume ${SESSION}`);
  });

  it("leaves the default-mode commands unchanged", () => {
    expect(buildResumeCommand("claude", "alpha", SESSION, "alphaClaude")).toBe(
      `alphaClaude -s --resume ${SESSION}`,
    );
  });
});
