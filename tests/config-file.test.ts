/**
 * The config `cmuxlayer init` writes has to reach the SERVER, not just a shell.
 *
 * A GUI-launched MCP client (Claude Desktop, VS Code, a launchd agent) never
 * sources a shell profile, so anything that depends on a sourced `env.sh` is
 * invisible there. The end-to-end tests at the bottom start from a completely
 * empty environment — the GUI case — and assert the wizard's answers still
 * reach repo resolution and the approval mode.
 */

import { describe, expect, it } from "vitest";
import {
  CONFIGURABLE_KEYS,
  CONFIG_FILE_ENV,
  defaultConfigFilePath,
  loadCmuxlayerConfigFile,
  parseShellEnvFile,
} from "../src/config-file.js";
import { buildInitPlan, type InitEnvironment } from "../src/init-wizard.js";
import { buildLaunchCommand, resolveSpawnLaunchPlan } from "../src/agent-engine.js";
import { resolveSpawnPermissionMode } from "../src/permission-mode.js";
import { checkInitConfig } from "../src/doctor.js";
import { getLoadedConfigFile, resetLoadedConfigFile } from "../src/config-file.js";

describe("defaultConfigFilePath", () => {
  it("defaults under the home config directory", () => {
    expect(defaultConfigFilePath({ HOME: "/home/tester" })).toBe(
      "/home/tester/.config/cmuxlayer/env.sh",
    );
  });

  it("honours the override", () => {
    expect(
      defaultConfigFilePath({
        HOME: "/home/tester",
        [CONFIG_FILE_ENV]: "/etc/cmuxlayer.sh",
      }),
    ).toBe("/etc/cmuxlayer.sh");
  });
});

describe("parseShellEnvFile", () => {
  it("reads exported, bare, single- and double-quoted assignments", () => {
    expect(
      parseShellEnvFile(
        [
          "# a comment",
          "",
          "export CMUXLAYER_REPO_HOME='/code:/work'",
          'export CMUXLAYER_SPAWN_PERMISSION_MODE="default"',
          "CMUXLAYER_REQUIRE_LAUNCHER_REGISTRY=1",
        ].join("\n"),
      ),
    ).toEqual({
      CMUXLAYER_REPO_HOME: "/code:/work",
      CMUXLAYER_SPAWN_PERMISSION_MODE: "default",
      CMUXLAYER_REQUIRE_LAUNCHER_REGISTRY: "1",
    });
  });

  it("recovers an escaped single quote the writer emitted", () => {
    expect(
      parseShellEnvFile(`export CMUXLAYER_REPO_HOME='/code/o'\\''brien'`),
    ).toEqual({ CMUXLAYER_REPO_HOME: "/code/o'brien" });
  });

  it("is not a shell: no substitution, no execution, no expansion", () => {
    const parsed = parseShellEnvFile(
      [
        "export CMUXLAYER_REPO_HOME='$HOME/code'",
        "export EVIL=$(rm -rf /)",
        "rm -rf /",
        "source ~/.zshrc",
      ].join("\n"),
    );
    expect(parsed.CMUXLAYER_REPO_HOME).toBe("$HOME/code");
    expect(parsed.EVIL).toBe("$(rm -rf /)");
    expect(Object.keys(parsed)).toEqual(["CMUXLAYER_REPO_HOME", "EVIL"]);
  });
});

describe("startup-load bookkeeping", () => {
  it("does not record a scratch load as the startup load", () => {
    resetLoadedConfigFile();
    loadCmuxlayerConfigFile({
      path: "/cfg/env.sh",
      env: {},
      target: {},
      readFile: () => "export CMUXLAYER_REPO_HOME='/code'",
    });
    expect(getLoadedConfigFile()).toBeNull();
  });
});

describe("loadCmuxlayerConfigFile", () => {
  const contents = [
    "export CMUXLAYER_REPO_HOME='/code'",
    "export CMUXLAYER_SPAWN_PERMISSION_MODE='default'",
  ].join("\n");

  it("fills variables the environment does not set", () => {
    const env: Record<string, string | undefined> = {};
    const loaded = loadCmuxlayerConfigFile({
      path: "/cfg/env.sh",
      env,
      readFile: () => contents,
    });
    expect(loaded.found).toBe(true);
    expect(loaded.applied).toEqual([
      "CMUXLAYER_REPO_HOME",
      "CMUXLAYER_SPAWN_PERMISSION_MODE",
    ]);
    expect(env.CMUXLAYER_REPO_HOME).toBe("/code");
  });

  it("never overrides a value the real environment already set", () => {
    const env: Record<string, string | undefined> = {
      CMUXLAYER_REPO_HOME: "/explicit",
    };
    const loaded = loadCmuxlayerConfigFile({
      path: "/cfg/env.sh",
      env,
      readFile: () => contents,
    });
    expect(env.CMUXLAYER_REPO_HOME).toBe("/explicit");
    expect(loaded.overridden).toEqual(["CMUXLAYER_REPO_HOME"]);
    expect(loaded.applied).toEqual(["CMUXLAYER_SPAWN_PERMISSION_MODE"]);
  });

  it("refuses to import anything outside the configurable set", () => {
    const env: Record<string, string | undefined> = {};
    const loaded = loadCmuxlayerConfigFile({
      path: "/cfg/env.sh",
      env,
      readFile: () =>
        ["export PATH='/evil'", "export NODE_OPTIONS='--require /evil.js'"].join(
          "\n",
        ),
    });
    expect(env.PATH).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(loaded.ignored).toEqual(["PATH", "NODE_OPTIONS"]);
    expect(CONFIGURABLE_KEYS).not.toContain("PATH");
  });

  it("treats a missing file as a supported state, not an error", () => {
    const loaded = loadCmuxlayerConfigFile({
      path: "/cfg/env.sh",
      env: {},
      readFile: () => {
        throw new Error("ENOENT: no such file");
      },
    });
    expect(loaded.found).toBe(false);
    expect(loaded.applied).toEqual([]);
    expect(loaded.error).toContain("ENOENT");
  });

  it("is idempotent", () => {
    const env: Record<string, string | undefined> = {};
    const read = () => contents;
    loadCmuxlayerConfigFile({ path: "/cfg/env.sh", env, readFile: read });
    const second = loadCmuxlayerConfigFile({
      path: "/cfg/env.sh",
      env,
      readFile: read,
    });
    expect(second.applied).toEqual([]);
    expect(env.CMUXLAYER_REPO_HOME).toBe("/code");
  });
});

describe("end to end: a GUI-launched server sees the wizard's answers", () => {
  const DIRECTORIES = new Set(["/code", "/code/alpha"]);

  function wizardEnvironment(): InitEnvironment {
    return {
      homeDir: "/home/tester",
      env: {},
      isDirectory: (path) => DIRECTORIES.has(path),
      fileExists: () => false,
      readFile: () => null,
    };
  }

  /** Exactly what `cmuxlayer init` would write, for these answers. */
  function writtenConfig(permissionMode: "skip-permissions" | "default") {
    const plan = buildInitPlan(
      {
        repos: [{ name: "alpha", path: "/code/alpha" }],
        launchMode: "raw",
        permissionMode,
        requireRegistry: false,
        registryPath: "/home/tester/.config/ralphtools/launchers.zsh",
        configPath: "/home/tester/.config/cmuxlayer/env.sh",
      },
      wizardEnvironment(),
    );
    const artifact = plan.artifacts.find((entry) => entry.kind === "env");
    if (!artifact) throw new Error("wizard wrote no env config");
    return artifact;
  }

  /** A process started from the GUI: no shell profile, no cmuxlayer vars. */
  function guiProcessEnv(): Record<string, string | undefined> {
    return { HOME: "/home/tester", PATH: "/usr/bin" };
  }

  it("resolves a repo that a shell-less environment could not have found", () => {
    const artifact = writtenConfig("skip-permissions");
    const env = guiProcessEnv();

    // Before the loader runs, the raw lane has nothing to go on.
    expect(() =>
      resolveSpawnLaunchPlan("alpha", "claude", {
        registryOptions: {
          readRegistry: () => {
            throw new Error("ENOENT");
          },
        },
        repoRootFallback: {
          cwd: "/somewhere/else",
          homeDir: "/home/tester",
          env,
          isDirectory: (path) => DIRECTORIES.has(path),
        },
        env,
      }),
    ).toThrow(/Cannot resolve a working directory/);

    loadCmuxlayerConfigFile({
      path: artifact.path,
      env,
      readFile: () => artifact.contents,
    });

    const resolved = resolveSpawnLaunchPlan("alpha", "claude", {
      registryOptions: {
        readRegistry: () => {
          throw new Error("ENOENT");
        },
      },
      repoRootFallback: {
        cwd: "/somewhere/else",
        homeDir: "/home/tester",
        env,
        isDirectory: (path) => DIRECTORIES.has(path),
      },
      env,
    });
    expect(resolved.launchMode).toBe("raw");
    expect(resolved.repoRoot).toBe("/code/alpha");
  });

  it("does not let --permissions ask fail open on a GUI-launched server", () => {
    const artifact = writtenConfig("default");
    const env = guiProcessEnv();

    // This is the bug: an unset variable resolves to the permissive default.
    expect(resolveSpawnPermissionMode(env)).toBe("skip-permissions");

    loadCmuxlayerConfigFile({
      path: artifact.path,
      env,
      readFile: () => artifact.contents,
    });

    expect(resolveSpawnPermissionMode(env)).toBe("default");
    expect(
      buildLaunchCommand("claude", "alpha", undefined, undefined, {
        cwd: "/code/alpha",
        launchMode: "raw",
        permissionMode: resolveSpawnPermissionMode(env),
      }),
    ).not.toContain("--dangerously-skip-permissions");
  });
});

describe("doctor reports what this process can actually see", () => {
  it("reports what the STARTUP load did, not a re-load of its own work", () => {
    // The startup loader has already put these into the process environment;
    // a re-load would see them set and call them environment-supplied.
    const startup = {
      path: "/cfg/env.sh",
      found: true,
      applied: ["CMUXLAYER_SPAWN_PERMISSION_MODE" as const],
      overridden: [],
      ignored: [],
      error: null,
    };
    const report = checkInitConfig(
      { HOME: "/home/tester", CMUXLAYER_SPAWN_PERMISSION_MODE: "default" },
      () => {
        throw new Error("must not re-load when a startup load is known");
      },
      startup,
    );
    expect(report.applied).toEqual(["CMUXLAYER_SPAWN_PERMISSION_MODE"]);
    expect(report.overridden).toEqual([]);
    expect(report.note).toContain("applied CMUXLAYER_SPAWN_PERMISSION_MODE");
    expect(report.effective.permissionMode).toBe("default");
  });

  it("names the file and the effective settings it produced", () => {
    const report = checkInitConfig({ HOME: "/home/tester" }, () => ({
      path: "/home/tester/.config/cmuxlayer/env.sh",
      found: true,
      applied: ["CMUXLAYER_REPO_HOME"],
      overridden: [],
      ignored: [],
      error: null,
    }), null);
    expect(report.found).toBe(true);
    expect(report.note).toContain("/home/tester/.config/cmuxlayer/env.sh");
    expect(report.note).toContain("CMUXLAYER_REPO_HOME");
  });

  it("says the wizard has not been run when there is no file", () => {
    const report = checkInitConfig({ HOME: "/home/tester" }, () => ({
      path: "/home/tester/.config/cmuxlayer/env.sh",
      found: false,
      applied: [],
      overridden: [],
      ignored: [],
      error: "ENOENT",
    }), null);
    expect(report.note).toContain("cmuxlayer init");
    expect(report.effective.permissionMode).toBe("skip-permissions");
  });

  it("reports the effective values, combining file and environment", () => {
    const report = checkInitConfig(
      { HOME: "/home/tester", CMUXLAYER_REPO_HOME: "/from-env" },
      ({ target }) => {
        if (target) target.CMUXLAYER_SPAWN_PERMISSION_MODE = "default";
        return {
          path: "/cfg",
          found: true,
          applied: ["CMUXLAYER_SPAWN_PERMISSION_MODE"],
          overridden: ["CMUXLAYER_REPO_HOME"],
          ignored: [],
          error: null,
        };
      },
      null,
    );
    expect(report.effective.repoHome).toBe("/from-env");
    expect(report.effective.permissionMode).toBe("default");
  });

  it("does not mutate the environment it was given", () => {
    const env: Record<string, string | undefined> = { HOME: "/home/tester" };
    checkInitConfig(env, ({ target }) => {
      if (target) target.CMUXLAYER_REPO_HOME = "/code";
      return {
        path: "/cfg",
        found: true,
        applied: ["CMUXLAYER_REPO_HOME"],
        overridden: [],
        ignored: [],
        error: null,
      };
    }, null);
    expect(env.CMUXLAYER_REPO_HOME).toBeUndefined();
  });
});
