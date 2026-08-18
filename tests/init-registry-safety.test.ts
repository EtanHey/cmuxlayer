/**
 * The registry the wizard writes to is a hand-maintained zsh file that happens
 * to contain `repoGolem` lines — source guards, aliases, and dozens of shell
 * function definitions live alongside them. Rebuilding that file from its
 * parseable entries destroys the setup the wizard was pointed at, so every
 * test here is about what SURVIVES a write.
 */

import { describe, expect, it } from "vitest";
import {
  backupPathFor,
  buildInitPlan,
  patchLauncherRegistry,
  runInitCommand,
  type InitAnswers,
  type InitEnvironment,
} from "../src/init-wizard.js";
import { parseLauncherRegistry } from "../src/launcher-registry.js";

/** A registry shaped like a real one: mostly NOT registration lines. */
const REAL_REGISTRY = `# launcher registry
if [[ -z "$RALPHTOOLS_LOADED" ]]; then
  export RALPHTOOLS_LOADED=1
fi

repoGolem alpha /original/place/alpha
repoGolem legacy /original/place/legacy

alias songClaude=songscriptClaude

function skillCreatorClaude() {
  cd ~/code/skill-creator && claude "$@"
}
`;

const DIRECTORIES = new Set(["/code", "/code/alpha", "/code/beta-tool"]);
const REGISTRY_PATH = "/home/tester/.config/ralphtools/launchers.zsh";
const CONFIG_PATH = "/home/tester/.config/cmuxlayer/env.sh";

function environment(files: Record<string, string> = {}): InitEnvironment {
  return {
    homeDir: "/home/tester",
    env: {},
    isDirectory: (path) => DIRECTORIES.has(path),
    fileExists: (path) => path in files,
    readFile: (path) => files[path] ?? null,
  };
}

function answers(overrides?: Partial<InitAnswers>): InitAnswers {
  return {
    repos: [{ name: "alpha", path: "/code/alpha" }],
    launchMode: "launcher",
    permissionMode: "skip-permissions",
    requireRegistry: false,
    registryPath: REGISTRY_PATH,
    configPath: CONFIG_PATH,
    ...overrides,
  };
}

describe("patchLauncherRegistry", () => {
  const repos = [
    { name: "alpha", path: "/code/alpha", launcherPrefix: "alpha" },
  ];

  it("preserves every line that is not a registration", () => {
    const patched = patchLauncherRegistry(repos, REAL_REGISTRY).contents;
    for (const line of [
      "# launcher registry",
      'if [[ -z "$RALPHTOOLS_LOADED" ]]; then',
      "  export RALPHTOOLS_LOADED=1",
      "fi",
      "alias songClaude=songscriptClaude",
      "function skillCreatorClaude() {",
      '  cd ~/code/skill-creator && claude "$@"',
      "}",
    ]) {
      expect(patched).toContain(line);
    }
  });

  it("rewrites a matching registration where it stands", () => {
    const patched = patchLauncherRegistry(repos, REAL_REGISTRY).contents;
    expect(patched).toContain("repoGolem alpha /code/alpha");
    expect(patched).not.toContain("/original/place/alpha");
    // ...and leaves the neighbouring registration alone.
    expect(patched).toContain("repoGolem legacy /original/place/legacy");
  });

  it("keeps the file's own ordering rather than regrouping it", () => {
    const patched = patchLauncherRegistry(repos, REAL_REGISTRY).contents;
    expect(patched.indexOf("repoGolem alpha")).toBeLessThan(
      patched.indexOf("alias songClaude"),
    );
  });

  it("reports a repoint instead of changing a path silently", () => {
    const { repoints } = patchLauncherRegistry(repos, REAL_REGISTRY);
    expect(repoints).toEqual([
      { prefix: "alpha", from: "/original/place/alpha", to: "/code/alpha" },
    ]);
  });

  it("reports no repoint when the path is unchanged", () => {
    const { repoints } = patchLauncherRegistry(
      [{ name: "alpha", path: "/original/place/alpha", launcherPrefix: "alpha" }],
      REAL_REGISTRY,
    );
    expect(repoints).toEqual([]);
  });

  it("appends a new registration without disturbing the rest", () => {
    const patched = patchLauncherRegistry(
      [{ name: "gamma", path: "/code/gamma", launcherPrefix: "gamma" }],
      REAL_REGISTRY,
    ).contents;
    expect(patched).toContain("repoGolem gamma /code/gamma");
    expect(patched).toContain("function skillCreatorClaude() {");
    expect(parseLauncherRegistry(patched, REGISTRY_PATH)).toHaveLength(3);
  });

  it("does not grow trailing blank lines on repeated runs", () => {
    const repo = [
      { name: "gamma", path: "/code/gamma", launcherPrefix: "gamma" },
    ];
    const once = patchLauncherRegistry(repo, REAL_REGISTRY).contents;
    const twice = patchLauncherRegistry(repo, once).contents;
    expect(twice).toBe(once);
  });

  it("writes a fresh file with its header when there is nothing to patch", () => {
    const created = patchLauncherRegistry(repos, null).contents;
    expect(created).toContain("# repoGolem launcher registry");
    expect(parseLauncherRegistry(created, REGISTRY_PATH)).toEqual([
      { prefix: "alpha", path: "/code/alpha", repoBasename: "alpha" },
    ]);
  });
});

describe("backupPathFor", () => {
  it("uses .bak when it is free", () => {
    expect(backupPathFor("/a/launchers.zsh", () => false)).toBe(
      "/a/launchers.zsh.bak",
    );
  });

  it("never overwrites an earlier backup", () => {
    const taken = new Set(["/a/f.bak", "/a/f.bak.1"]);
    expect(backupPathFor("/a/f", (path) => taken.has(path))).toBe("/a/f.bak.2");
  });
});

describe("buildInitPlan backs up what it rewrites", () => {
  it("plans a backup before an update, and marks the modes", () => {
    const plan = buildInitPlan(
      answers(),
      environment({ [REGISTRY_PATH]: REAL_REGISTRY }),
    );
    const kinds = plan.artifacts.map((a) => `${a.kind}:${a.mode}`);
    expect(kinds).toEqual([
      "backup:create",
      "launcher-registry:update",
      "env:create",
    ]);
    // The backup carries the ORIGINAL contents, not the new ones.
    expect(plan.artifacts[0]?.contents).toBe(REAL_REGISTRY);
    expect(plan.artifacts[0]?.path).toBe(`${REGISTRY_PATH}.bak`);
    expect(plan.artifacts[1]?.backupPath).toBe(`${REGISTRY_PATH}.bak`);
  });

  it("marks nothing as an update on a clean machine", () => {
    const plan = buildInitPlan(answers({ launchMode: "raw" }), environment());
    expect(plan.updates).toEqual([]);
    expect(plan.artifacts.every((a) => a.mode === "create")).toBe(true);
  });

  it("warns about a silent repoint", () => {
    const plan = buildInitPlan(
      answers(),
      environment({ [REGISTRY_PATH]: REAL_REGISTRY }),
    );
    expect(plan.warnings.join("\n")).toContain("/original/place/alpha");
  });
});

describe("runInitCommand never rewrites without a yes", () => {
  function harness(files: Record<string, string> = {}, answersIn: string[] = []) {
    const queued = [...answersIn];
    const out: string[] = [];
    const err: string[] = [];
    const written = new Map<string, string>();
    return {
      out,
      err,
      written,
      io: {
        question: async () => queued.shift() ?? "",
        write: (text: string) => out.push(text),
        writeError: (text: string) => err.push(text),
      },
      environment: environment(files),
      writer: async (path: string, contents: string) => {
        written.set(path, contents);
      },
    };
  }

  it("--yes refuses to rewrite an existing registry without --force", async () => {
    const h = harness({ [REGISTRY_PATH]: REAL_REGISTRY });
    const code = await runInitCommand(
      ["--yes", "--mode", "launcher", "--repo", "alpha=/code/alpha"],
      h.io,
      h.environment,
      h.writer,
    );
    expect(code).toBe(1);
    expect(h.written.size).toBe(0);
    expect(h.err.join("")).toContain("--force");
  });

  it("--force writes the backup before the rewrite, and keeps the shell code", async () => {
    const h = harness({ [REGISTRY_PATH]: REAL_REGISTRY });
    const code = await runInitCommand(
      ["--yes", "--mode", "launcher", "--repo", "alpha=/code/alpha", "--force"],
      h.io,
      h.environment,
      h.writer,
    );
    expect(code).toBe(0);
    expect(h.written.get(`${REGISTRY_PATH}.bak`)).toBe(REAL_REGISTRY);
    const rewritten = h.written.get(REGISTRY_PATH) ?? "";
    expect(rewritten).toContain("function skillCreatorClaude() {");
    expect(rewritten).toContain("repoGolem alpha /code/alpha");
  });

  it("an interactive no writes nothing at all", async () => {
    const h = harness({ [REGISTRY_PATH]: REAL_REGISTRY }, [
      "/code/alpha", // repo path
      "alpha", // name
      "", // done adding
      "1", // launcher lane
      "1", // unattended
      "n", // do NOT rewrite
    ]);
    const code = await runInitCommand([], h.io, h.environment, h.writer);
    expect(code).toBe(1);
    expect(h.written.size).toBe(0);
  });

  it("an interactive yes rewrites, after backing up", async () => {
    const h = harness({ [REGISTRY_PATH]: REAL_REGISTRY }, [
      "/code/alpha",
      "alpha",
      "",
      "1",
      "1",
      "y",
    ]);
    const code = await runInitCommand([], h.io, h.environment, h.writer);
    expect(code).toBe(0);
    expect(h.written.get(`${REGISTRY_PATH}.bak`)).toBe(REAL_REGISTRY);
    expect(h.written.get(REGISTRY_PATH)).toContain("alias songClaude");
  });

  it("tells the user which file it would rewrite, and where the backup goes", async () => {
    const h = harness({ [REGISTRY_PATH]: REAL_REGISTRY }, [
      "/code/alpha",
      "alpha",
      "",
      "1",
      "1",
      "n",
    ]);
    await runInitCommand([], h.io, h.environment, h.writer);
    const shown = h.out.join("");
    expect(shown).toContain(REGISTRY_PATH);
    expect(shown).toContain(`${REGISTRY_PATH}.bak`);
  });
});
