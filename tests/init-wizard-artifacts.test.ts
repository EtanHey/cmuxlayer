/**
 * The wizard's real deliverable is the FILES it writes, not its prompts.
 *
 * Every test here takes an artifact `cmuxlayer init` generated and feeds it to
 * the code that consumes it in production — the launcher registry parser and
 * the registry-optional spawn preflight from #453 — so a change that makes the
 * wizard emit config the engine cannot read fails here.
 */

import { describe, expect, it } from "vitest";
import {
  buildInitPlan,
  type InitAnswers,
  type InitEnvironment,
} from "../src/init-wizard.js";
import { buildLaunchCommand, resolveSpawnLaunchPlan } from "../src/agent-engine.js";
import { buildResumeCommand } from "../src/agent-command.js";
import { resolveSpawnPermissionMode } from "../src/permission-mode.js";

const HOME = "/home/tester";
const REPOS = [
  { name: "alpha", path: "/code/alpha" },
  { name: "beta-tool", path: "/code/beta-tool" },
];
const DIRECTORIES = new Set(["/code", "/code/alpha", "/code/beta-tool"]);

function environment(registryExists = false): InitEnvironment {
  return {
    homeDir: HOME,
    env: {},
    isDirectory: (path) => DIRECTORIES.has(path),
    fileExists: (path) =>
      registryExists && path === `${HOME}/.config/ralphtools/launchers.zsh`,
  };
}

function answers(overrides?: Partial<InitAnswers>): InitAnswers {
  return {
    repos: REPOS,
    launchMode: "raw",
    permissionMode: "skip-permissions",
    requireRegistry: false,
    registryPath: `${HOME}/.config/ralphtools/launchers.zsh`,
    configPath: `${HOME}/.config/cmuxlayer/env.sh`,
    ...overrides,
  };
}

/** Read the generated shell config the way a sourcing shell would. */
function sourceEnvConfig(contents: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of contents.split("\n")) {
    const match = /^export ([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!key || rawValue === undefined) continue;
    env[key] = rawValue.startsWith("'")
      ? rawValue.slice(1, -1).replace(/'\\''/g, "'")
      : rawValue;
  }
  return env;
}

function artifactOf(plan: ReturnType<typeof buildInitPlan>, kind: string) {
  const artifact = plan.artifacts.find((entry) => entry.kind === kind);
  if (!artifact) throw new Error(`no ${kind} artifact in plan`);
  return artifact;
}

describe("generated raw config drives a registry-optional spawn", () => {
  const plan = buildInitPlan(answers(), environment());
  const env = sourceEnvConfig(artifactOf(plan, "env").contents);

  it("exports a CMUXLAYER_REPO_HOME the fallback resolver reads", () => {
    expect(env.CMUXLAYER_REPO_HOME).toBe("/code");
  });

  it("resolves both registered repos to their real roots on the raw lane", () => {
    for (const repo of REPOS) {
      const resolved = resolveSpawnLaunchPlan(repo.name, "claude", {
        // No registry on this machine — the fresh-install case.
        registryOptions: {
          readRegistry: () => {
            throw new Error("ENOENT");
          },
        },
        repoRootFallback: {
          cwd: "/somewhere/else",
          homeDir: HOME,
          env,
          isDirectory: (path) => DIRECTORIES.has(path),
        },
        env,
      });
      expect(resolved.launchMode).toBe("raw");
      expect(resolved.repoRoot).toBe(repo.path);
      expect(resolved.launcherName).toBeUndefined();
    }
  });

  it("produces a launch command that cds into the generated root", () => {
    const resolved = resolveSpawnLaunchPlan("alpha", "claude", {
      registryOptions: {
        readRegistry: () => {
          throw new Error("ENOENT");
        },
      },
      repoRootFallback: {
        cwd: "/somewhere/else",
        homeDir: HOME,
        env,
        isDirectory: (path) => DIRECTORIES.has(path),
      },
      env,
    });
    const command = buildLaunchCommand("claude", "alpha", undefined, undefined, {
      cwd: resolved.repoRoot,
      launchMode: resolved.launchMode,
      permissionMode: resolveSpawnPermissionMode(env),
    });
    expect(command).toContain("cd '/code/alpha' &&");
    expect(command).toContain("claude --dangerously-skip-permissions");
  });

  it("carries the chosen prompting mode into launch and resume alike", () => {
    const askingPlan = buildInitPlan(
      answers({ permissionMode: "default" }),
      environment(),
    );
    const askingEnv = sourceEnvConfig(
      artifactOf(askingPlan, "env").contents,
    );
    expect(askingEnv.CMUXLAYER_SPAWN_PERMISSION_MODE).toBe("default");
    const permissionMode = resolveSpawnPermissionMode(askingEnv);
    expect(permissionMode).toBe("default");

    expect(
      buildLaunchCommand("claude", "alpha", undefined, undefined, {
        cwd: "/code/alpha",
        launchMode: "raw",
        permissionMode,
      }),
    ).not.toContain("--dangerously-skip-permissions");
    expect(
      buildResumeCommand(
        "claude",
        "alpha",
        "11111111-2222-4333-8444-555555555555",
        null,
        { cwd: "/code/alpha", permissionMode },
      ),
    ).not.toContain("--dangerously-skip-permissions");
  });

  it("does not export a registry path when there is no registry", () => {
    expect(env.CMUXLAYER_LAUNCHER_REGISTRY_PATH).toBeUndefined();
  });

  it("exports strict mode only when the install asked for it", () => {
    const strict = sourceEnvConfig(
      artifactOf(
        buildInitPlan(answers({ requireRegistry: true }), environment()),
        "env",
      ).contents,
    );
    expect(strict.CMUXLAYER_REQUIRE_LAUNCHER_REGISTRY).toBe("1");
  });
});

describe("generated launcher registry drives a registered spawn", () => {
  const plan = buildInitPlan(
    answers({ launchMode: "launcher" }),
    environment(true),
  );
  const registry = artifactOf(plan, "launcher-registry");
  const env = sourceEnvConfig(artifactOf(plan, "env").contents);

  it("points CMUXLAYER_LAUNCHER_REGISTRY_PATH at the file it wrote", () => {
    expect(env.CMUXLAYER_LAUNCHER_REGISTRY_PATH).toBe(registry.path);
  });

  it("resolves launcher names and roots the engine will actually use", () => {
    const resolved = resolveSpawnLaunchPlan("alpha", "claude", {
      registryOptions: { readRegistry: () => registry.contents },
      env,
    });
    expect(resolved.launchMode).toBe("launcher");
    expect(resolved.launcherName).toBe("alphaClaude");
    expect(resolved.repoRoot).toBe("/code/alpha");
  });

  it("matches a hyphenated repo through its hyphen-stripped launcher prefix", () => {
    const resolved = resolveSpawnLaunchPlan("beta-tool", "codex", {
      registryOptions: { readRegistry: () => registry.contents },
      env,
    });
    expect(resolved.launchMode).toBe("launcher");
    expect(resolved.launcherName).toBe("betatoolCodex");
    expect(resolved.repoRoot).toBe("/code/beta-tool");
  });

  it("falls back to the raw lane for a repo the wizard never registered", () => {
    const resolved = resolveSpawnLaunchPlan("alpha", "claude", {
      registryOptions: { readRegistry: () => registry.contents },
      repoRootFallback: {
        cwd: "/somewhere/else",
        homeDir: HOME,
        env: {},
        isDirectory: (path) => DIRECTORIES.has(path),
      },
      env: {},
    });
    expect(resolved.launcherName).toBe("alphaClaude");

    const unregistered = resolveSpawnLaunchPlan("gamma", "claude", {
      registryOptions: { readRegistry: () => registry.contents },
      repoRootFallback: {
        cwd: "/code/gamma",
        homeDir: HOME,
        env: {},
        isDirectory: (path) => path === "/code/gamma",
      },
      env: {},
    });
    expect(unregistered.launchMode).toBe("raw");
    expect(unregistered.launchModeReason).toContain("no entry");
  });

  it("still gives the raw lane a repo home, so an unregistered repo resolves", () => {
    expect(env.CMUXLAYER_REPO_HOME).toBe("/code");
  });
});
