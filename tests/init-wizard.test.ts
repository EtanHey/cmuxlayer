import { describe, expect, it } from "vitest";
import {
  buildInitPlan,
  detectRepoGolem,
  parseInitArgs,
  renderEnvConfig,
  renderLauncherRegistry,
  resolveInitAnswers,
  runInitCommand,
  WIZARD_COPY,
  type InitEnvironment,
} from "../src/init-wizard.js";
import { parseLauncherRegistry } from "../src/launcher-registry.js";

function environment(overrides?: Partial<InitEnvironment>): InitEnvironment {
  const directories = new Set(["/code/alpha", "/code/beta-tool", "/code"]);
  return {
    homeDir: "/home/tester",
    env: {},
    isDirectory: (path) => directories.has(path),
    fileExists: () => false,
    ...overrides,
  };
}

describe("parseInitArgs", () => {
  it("parses repeated --repo name=path pairs", () => {
    const parsed = parseInitArgs([
      "--yes",
      "--repo",
      "alpha=/code/alpha",
      "--repo",
      "beta-tool=/code/beta-tool",
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.options.yes).toBe(true);
    expect(parsed.options.repos).toEqual([
      { name: "alpha", path: "/code/alpha" },
      { name: "beta-tool", path: "/code/beta-tool" },
    ]);
  });

  it("derives the repo name from the directory basename when only a path is given", () => {
    const parsed = parseInitArgs(["--repo", "/code/beta-tool"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.options.repos).toEqual([
      { name: "beta-tool", path: "/code/beta-tool" },
    ]);
  });

  it("accepts --repo=name=path inline form", () => {
    const parsed = parseInitArgs(["--repo=alpha=/code/alpha"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.options.repos).toEqual([
      { name: "alpha", path: "/code/alpha" },
    ]);
  });

  it("parses mode, permissions, and paths", () => {
    const parsed = parseInitArgs([
      "--mode",
      "raw",
      "--permissions",
      "ask",
      "--registry-path",
      "/tmp/launchers.zsh",
      "--config-path",
      "/tmp/env.sh",
      "--require-registry",
      "--print",
      "--force",
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.options.mode).toBe("raw");
    expect(parsed.options.permissionMode).toBe("default");
    expect(parsed.options.registryPath).toBe("/tmp/launchers.zsh");
    expect(parsed.options.configPath).toBe("/tmp/env.sh");
    expect(parsed.options.requireRegistry).toBe(true);
    expect(parsed.options.print).toBe(true);
    expect(parsed.options.force).toBe(true);
  });

  it("defaults to auto mode and skip-permissions", () => {
    const parsed = parseInitArgs([]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.options.mode).toBe("auto");
    expect(parsed.options.permissionMode).toBe("skip-permissions");
  });

  it("rejects unknown flags and bad values with an actionable message", () => {
    expect(parseInitArgs(["--nope"])).toEqual({
      ok: false,
      error: expect.stringContaining("--nope"),
    });
    expect(parseInitArgs(["--mode", "sideways"])).toEqual({
      ok: false,
      error: expect.stringContaining("sideways"),
    });
    expect(parseInitArgs(["--repo"])).toEqual({
      ok: false,
      error: expect.stringContaining("--repo"),
    });
  });
});

describe("detectRepoGolem", () => {
  it("reports unavailable on a machine with no launcher registry", () => {
    const detected = detectRepoGolem(environment());
    expect(detected.available).toBe(false);
    expect(detected.registryPath).toBe(
      "/home/tester/.config/ralphtools/launchers.zsh",
    );
    expect(detected.reason).toContain(
      "/home/tester/.config/ralphtools/launchers.zsh",
    );
  });

  it("reports available when the registry file exists", () => {
    const detected = detectRepoGolem(
      environment({
        fileExists: (path) =>
          path === "/home/tester/.config/ralphtools/launchers.zsh",
      }),
    );
    expect(detected.available).toBe(true);
  });

  it("honours CMUXLAYER_LAUNCHER_REGISTRY_PATH", () => {
    const detected = detectRepoGolem(
      environment({
        env: { CMUXLAYER_LAUNCHER_REGISTRY_PATH: "/elsewhere/launchers.zsh" },
        fileExists: (path) => path === "/elsewhere/launchers.zsh",
      }),
    );
    expect(detected.registryPath).toBe("/elsewhere/launchers.zsh");
    expect(detected.available).toBe(true);
  });
});

describe("resolveInitAnswers (non-interactive)", () => {
  it("auto-selects the raw lane when no launchers exist on the machine", () => {
    const answers = resolveInitAnswers(
      {
        yes: true,
        repos: [{ name: "alpha", path: "/code/alpha" }],
        mode: "auto",
        permissionMode: "skip-permissions",
        requireRegistry: false,
        print: false,
        force: false,
        help: false,
      },
      environment(),
    );
    expect(answers.launchMode).toBe("raw");
  });

  it("auto-selects the launcher lane when a registry is present", () => {
    const answers = resolveInitAnswers(
      {
        yes: true,
        repos: [{ name: "alpha", path: "/code/alpha" }],
        mode: "auto",
        permissionMode: "skip-permissions",
        requireRegistry: false,
        print: false,
        force: false,
        help: false,
      },
      environment({
        fileExists: (path) =>
          path === "/home/tester/.config/ralphtools/launchers.zsh",
      }),
    );
    expect(answers.launchMode).toBe("launcher");
  });

  it("refuses an explicit launcher lane when repoGolem is not installed", () => {
    expect(() =>
      resolveInitAnswers(
        {
          yes: true,
          repos: [{ name: "alpha", path: "/code/alpha" }],
          mode: "launcher",
          permissionMode: "skip-permissions",
          requireRegistry: false,
          print: false,
          force: false,
          help: false,
        },
        environment(),
      ),
    ).toThrow(/repoGolem/);
  });
});

describe("renderLauncherRegistry", () => {
  it("emits repoGolem lines the launcher registry parser reads back", () => {
    const rendered = renderLauncherRegistry([
      { name: "alpha", path: "/code/alpha", launcherPrefix: "alpha" },
      { name: "beta-tool", path: "/code/beta-tool", launcherPrefix: "betatool" },
    ]);
    const entries = parseLauncherRegistry(rendered, "/tmp/launchers.zsh");
    expect(entries).toEqual([
      { prefix: "alpha", path: "/code/alpha", repoBasename: "alpha" },
      { prefix: "betatool", path: "/code/beta-tool", repoBasename: "beta-tool" },
    ]);
  });

  it("quotes paths containing spaces so the generated file stays parseable", () => {
    const rendered = renderLauncherRegistry([
      { name: "alpha", path: "/code/my repos/alpha", launcherPrefix: "alpha" },
    ]);
    expect(parseLauncherRegistry(rendered, "/tmp/launchers.zsh")).toEqual([
      { prefix: "alpha", path: "/code/my repos/alpha", repoBasename: "alpha" },
    ]);
  });
});

describe("renderEnvConfig", () => {
  it("exports the repo roots the raw lane searches", () => {
    const rendered = renderEnvConfig({
      repoHomes: ["/code", "/work/src"],
      permissionMode: "skip-permissions",
      registryPath: null,
      requireRegistry: false,
    });
    expect(rendered).toContain(
      "export CMUXLAYER_REPO_HOME='/code:/work/src'",
    );
    expect(rendered).toContain(
      "export CMUXLAYER_SPAWN_PERMISSION_MODE='skip-permissions'",
    );
    expect(rendered).not.toContain("CMUXLAYER_REQUIRE_LAUNCHER_REGISTRY=1");
  });

  it("exports the registry path and strict mode when asked", () => {
    const rendered = renderEnvConfig({
      repoHomes: ["/code"],
      permissionMode: "default",
      registryPath: "/home/tester/.config/ralphtools/launchers.zsh",
      requireRegistry: true,
    });
    expect(rendered).toContain(
      "export CMUXLAYER_LAUNCHER_REGISTRY_PATH='/home/tester/.config/ralphtools/launchers.zsh'",
    );
    expect(rendered).toContain("export CMUXLAYER_REQUIRE_LAUNCHER_REGISTRY=1");
    expect(rendered).toContain(
      "export CMUXLAYER_SPAWN_PERMISSION_MODE='default'",
    );
  });

  it("omits CMUXLAYER_REPO_HOME when no roots could be derived", () => {
    const rendered = renderEnvConfig({
      repoHomes: [],
      permissionMode: "skip-permissions",
      registryPath: null,
      requireRegistry: false,
    });
    expect(rendered).not.toContain("CMUXLAYER_REPO_HOME=");
  });
});

describe("buildInitPlan", () => {
  const answers = {
    repos: [
      { name: "alpha", path: "/code/alpha" },
      { name: "beta-tool", path: "/code/beta-tool" },
    ],
    launchMode: "raw" as const,
    permissionMode: "skip-permissions" as const,
    requireRegistry: false,
    registryPath: "/home/tester/.config/ralphtools/launchers.zsh",
    configPath: "/home/tester/.config/cmuxlayer/env.sh",
  };

  it("writes only the env config on the raw lane", () => {
    const plan = buildInitPlan(answers, environment());
    expect(plan.artifacts.map((artifact) => artifact.kind)).toEqual(["env"]);
    expect(plan.artifacts[0]?.path).toBe(
      "/home/tester/.config/cmuxlayer/env.sh",
    );
    expect(plan.artifacts[0]?.contents).toContain(
      "export CMUXLAYER_REPO_HOME='/code'",
    );
  });

  it("writes the launcher registry and the env config on the launcher lane", () => {
    const plan = buildInitPlan(
      { ...answers, launchMode: "launcher" },
      environment({
        fileExists: (path) =>
          path === "/home/tester/.config/ralphtools/launchers.zsh",
      }),
    );
    expect(plan.artifacts.map((artifact) => artifact.kind)).toEqual([
      "launcher-registry",
      "env",
    ]);
    const registry = plan.artifacts[0];
    expect(registry?.path).toBe(
      "/home/tester/.config/ralphtools/launchers.zsh",
    );
    expect(
      parseLauncherRegistry(registry?.contents ?? "", registry?.path ?? ""),
    ).toHaveLength(2);
  });

  it("dedupes repo roots and keeps their order", () => {
    const plan = buildInitPlan(
      {
        ...answers,
        repos: [
          { name: "alpha", path: "/code/alpha" },
          { name: "gamma", path: "/work/src/gamma" },
          { name: "beta-tool", path: "/code/beta-tool" },
        ],
      },
      environment(),
    );
    expect(plan.artifacts[0]?.contents).toContain(
      "export CMUXLAYER_REPO_HOME='/code:/work/src'",
    );
  });

  it("warns when a repo directory does not exist", () => {
    const plan = buildInitPlan(
      { ...answers, repos: [{ name: "ghost", path: "/code/ghost" }] },
      environment(),
    );
    expect(plan.warnings.join("\n")).toContain("/code/ghost");
  });

  it("warns when the directory basename does not match the repo name", () => {
    const plan = buildInitPlan(
      { ...answers, repos: [{ name: "alpha", path: "/code/beta-tool" }] },
      environment(),
    );
    expect(plan.warnings.join("\n")).toMatch(/beta-tool/);
    expect(plan.warnings.join("\n")).toMatch(/alpha/);
  });

  it("does not warn about a basename mismatch on the launcher lane", () => {
    const plan = buildInitPlan(
      {
        ...answers,
        launchMode: "launcher",
        repos: [{ name: "alpha", path: "/code/beta-tool" }],
      },
      environment({
        fileExists: (path) =>
          path === "/home/tester/.config/ralphtools/launchers.zsh",
      }),
    );
    expect(plan.warnings.join("\n")).not.toMatch(/basename/i);
  });

  it("rejects a relative repo path", () => {
    expect(() =>
      buildInitPlan(
        { ...answers, repos: [{ name: "alpha", path: "code/alpha" }] },
        environment(),
      ),
    ).toThrow(/absolute/i);
  });

  it("rejects duplicate repo names", () => {
    expect(() =>
      buildInitPlan(
        {
          ...answers,
          repos: [
            { name: "alpha", path: "/code/alpha" },
            { name: "alpha", path: "/code/beta-tool" },
          ],
        },
        environment(),
      ),
    ).toThrow(/alpha/);
  });

  it("rejects an empty repo list", () => {
    expect(() =>
      buildInitPlan({ ...answers, repos: [] }, environment()),
    ).toThrow(/at least one repo/i);
  });

  it("strips hyphens from launcher prefixes (repoGolem naming)", () => {
    const plan = buildInitPlan(
      { ...answers, launchMode: "launcher" },
      environment({
        fileExists: (path) =>
          path === "/home/tester/.config/ralphtools/launchers.zsh",
      }),
    );
    expect(plan.artifacts[0]?.contents).toContain(
      "repoGolem betatool /code/beta-tool",
    );
  });
});

describe("runInitCommand", () => {
  function harness(overrides?: {
    answers?: string[];
    env?: Partial<InitEnvironment>;
  }) {
    const answers = [...(overrides?.answers ?? [])];
    const out: string[] = [];
    const err: string[] = [];
    const written = new Map<string, string>();
    const prompts: string[] = [];
    return {
      out,
      err,
      written,
      prompts,
      io: {
        question: async (prompt: string) => {
          prompts.push(prompt);
          return answers.shift() ?? "";
        },
        write: (text: string) => out.push(text),
        writeError: (text: string) => err.push(text),
      },
      environment: environment(overrides?.env),
      writer: async (path: string, contents: string) => {
        written.set(path, contents);
      },
    };
  }

  it("--help prints the wizard usage without writing anything", async () => {
    const h = harness();
    const code = await runInitCommand(["--help"], h.io, h.environment, h.writer);
    expect(code).toBe(0);
    expect(h.out.join("")).toContain("cmuxlayer init");
    expect(h.written.size).toBe(0);
  });

  it("--yes writes the generated artifacts without prompting", async () => {
    const h = harness();
    const code = await runInitCommand(
      [
        "--yes",
        "--repo",
        "alpha=/code/alpha",
        "--config-path",
        "/home/tester/.config/cmuxlayer/env.sh",
      ],
      h.io,
      h.environment,
      h.writer,
    );
    expect(code).toBe(0);
    expect(h.prompts).toEqual([]);
    expect(h.written.get("/home/tester/.config/cmuxlayer/env.sh")).toContain(
      "export CMUXLAYER_REPO_HOME='/code'",
    );
  });

  it("--yes with no repos fails instead of writing an empty config", async () => {
    const h = harness();
    const code = await runInitCommand(["--yes"], h.io, h.environment, h.writer);
    expect(code).toBe(2);
    expect(h.written.size).toBe(0);
    expect(h.err.join("")).toMatch(/--repo/);
  });

  it("--print writes nothing and shows the file contents", async () => {
    const h = harness();
    const code = await runInitCommand(
      ["--yes", "--repo", "alpha=/code/alpha", "--print"],
      h.io,
      h.environment,
      h.writer,
    );
    expect(code).toBe(0);
    expect(h.written.size).toBe(0);
    expect(h.out.join("")).toContain("export CMUXLAYER_REPO_HOME='/code'");
  });

  it("re-registers into an existing launcher registry without --force", async () => {
    const h = harness({
      env: {
        fileExists: (path) =>
          path === "/home/tester/.config/ralphtools/launchers.zsh",
        readFile: () => "repoGolem legacy /code/legacy\n",
      },
    });
    const code = await runInitCommand(
      ["--yes", "--repo", "alpha=/code/alpha", "--mode", "launcher"],
      h.io,
      h.environment,
      h.writer,
    );
    expect(code).toBe(0);
    expect(
      h.written.get("/home/tester/.config/ralphtools/launchers.zsh"),
    ).toContain("repoGolem legacy /code/legacy");
  });

  it("fails with a pointer to --yes when input ends mid-wizard", async () => {
    const h = harness();
    h.io.question = async () => {
      throw new Error("Input ended before setup finished. Use --yes.");
    };
    const code = await runInitCommand([], h.io, h.environment, h.writer);
    expect(code).toBe(2);
    expect(h.err.join("")).toContain("--yes");
    expect(h.written.size).toBe(0);
  });

  it("refuses to overwrite an existing file without --force", async () => {
    const h = harness({
      env: {
        fileExists: (path) => path === "/home/tester/.config/cmuxlayer/env.sh",
      },
    });
    const code = await runInitCommand(
      ["--yes", "--repo", "alpha=/code/alpha"],
      h.io,
      h.environment,
      h.writer,
    );
    expect(code).toBe(1);
    expect(h.written.size).toBe(0);
    expect(h.err.join("")).toMatch(/--force/);
  });

  it("overwrites with --force", async () => {
    const h = harness({
      env: {
        fileExists: (path) => path === "/home/tester/.config/cmuxlayer/env.sh",
      },
    });
    const code = await runInitCommand(
      ["--yes", "--repo", "alpha=/code/alpha", "--force"],
      h.io,
      h.environment,
      h.writer,
    );
    expect(code).toBe(0);
    expect(h.written.size).toBe(1);
  });

  it("prompts through the interactive path and writes what was answered", async () => {
    const h = harness({
      answers: [
        "/code/alpha", // first repo path
        "alpha", // its name
        "", // no more repos
        "2", // raw lane
        "1", // skip-permissions
      ],
    });
    const code = await runInitCommand([], h.io, h.environment, h.writer);
    expect(code).toBe(0);
    expect(h.prompts.length).toBeGreaterThan(0);
    const config = h.written.get("/home/tester/.config/cmuxlayer/env.sh");
    expect(config).toContain("export CMUXLAYER_REPO_HOME='/code'");
    expect(config).toContain(
      "export CMUXLAYER_SPAWN_PERMISSION_MODE='skip-permissions'",
    );
  });

  it("re-asks when the interactive repo path is not a directory", async () => {
    const h = harness({
      answers: ["/code/ghost", "/code/alpha", "alpha", "", "2", "1"],
    });
    const code = await runInitCommand([], h.io, h.environment, h.writer);
    expect(code).toBe(0);
    expect(h.err.join("")).toContain("/code/ghost");
    expect(h.written.size).toBe(1);
  });

  it("reports a bad flag on stderr and exits 2", async () => {
    const h = harness();
    const code = await runInitCommand(["--nope"], h.io, h.environment, h.writer);
    expect(code).toBe(2);
    expect(h.err.join("")).toContain("--nope");
  });
});

describe("launcher registry merge", () => {
  const existing = [
    "# hand-maintained",
    "repoGolem legacy /code/legacy",
    "repoGolem alpha /old/alpha",
    "",
  ].join("\n");

  it("keeps registrations the wizard is not replacing", () => {
    const rendered = renderLauncherRegistry(
      [{ name: "alpha", path: "/code/alpha", launcherPrefix: "alpha" }],
      existing,
    );
    expect(parseLauncherRegistry(rendered, "/tmp/launchers.zsh")).toEqual([
      { prefix: "legacy", path: "/code/legacy", repoBasename: "legacy" },
      { prefix: "alpha", path: "/code/alpha", repoBasename: "alpha" },
    ]);
  });

  it("lets the wizard's registration win over the old one for the same prefix", () => {
    const rendered = renderLauncherRegistry(
      [{ name: "alpha", path: "/code/alpha", launcherPrefix: "alpha" }],
      existing,
    );
    expect(rendered).not.toContain("/old/alpha");
  });

  it("reads the existing registry through the environment when planning", () => {
    const plan = buildInitPlan(
      {
        repos: [{ name: "alpha", path: "/code/alpha" }],
        launchMode: "launcher",
        permissionMode: "skip-permissions",
        requireRegistry: false,
        registryPath: "/home/tester/.config/ralphtools/launchers.zsh",
        configPath: "/home/tester/.config/cmuxlayer/env.sh",
      },
      environment({
        fileExists: (path) =>
          path === "/home/tester/.config/ralphtools/launchers.zsh",
        readFile: (path) =>
          path === "/home/tester/.config/ralphtools/launchers.zsh"
            ? existing
            : null,
      }),
    );
    expect(plan.artifacts[0]?.contents).toContain(
      "repoGolem legacy /code/legacy",
    );
  });
});

describe("WIZARD_COPY", () => {
  it("never names a personal setup, a private repo layout, or a fleet convention", () => {
    const copy = JSON.stringify(WIZARD_COPY);
    expect(copy).not.toMatch(
      /etanheyman|EtanHey|~\/Gits|orchestrator|\bfleet\b|\bcanon\b|\bseat\b/i,
    );
  });
});
