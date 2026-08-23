import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installSessionHooks } from "../src/self-registration-hooks-installer.js";

const repoRoot = join(__dirname, "..");
const hookAssets = join(repoRoot, "assets", "hooks");
const codexHook = join(hookAssets, "codex-cmux-self-register.py");
const claudeHook = join(hookAssets, "cmux-self-register.py");
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
}

async function runHook(
  hook: string,
  input: string,
  env: Record<string, string>,
  cwd?: string,
) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile(
      "python3",
      [hook],
      { cwd, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      },
    );
    child.stdin!.end(input);
  });
}

function runCodexHook(input: string, env: Record<string, string>) {
  return runHook(codexHook, input, env);
}

async function runConfiguredHook(
  command: string,
  input: string,
  env: Record<string, string>,
) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile(
      "sh",
      ["-c", command],
      { env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      },
    );
    child.stdin!.end(input);
  });
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("Codex self-registration hook", () => {
  it("writes the complete surface-bound registry contract with epoch milliseconds", async () => {
    const root = tempDir("cmux-codex-hook-");
    const registry = join(root, "registry.jsonl");
    const cwd = join(root, "worktree");
    mkdirSync(cwd);
    const before = Date.now();

    const result = await runCodexHook(
      JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
        transcript_path: "/tmp/rollout.jsonl",
        cwd,
        source: "startup",
      }),
      {
        CMUXLAYER_SESSION_REGISTRY: registry,
        CMUX_SURFACE_ID: "11111111-2222-4333-8444-555555555555",
        CMUX_LAUNCHER: "cmuxlayerCodex",
      },
    );
    const after = Date.now();

    expect(result).toEqual({ stdout: "", stderr: "" });
    const rows = readFileSync(registry, "utf8").trim().split("\n");
    expect(rows).toHaveLength(1);
    const row = JSON.parse(rows[0]!);
    expect(row).toMatchObject({
      session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
      surface_uuid: "11111111-2222-4333-8444-555555555555",
      cwd,
      pid: process.pid,
      cli: "codex",
      launcher: "cmuxlayerCodex",
      session_path: "/tmp/rollout.jsonl",
    });
    expect(Number.isSafeInteger(row.ts)).toBe(true);
    expect(row.ts).toBeGreaterThanOrEqual(before);
    expect(row.ts).toBeLessThanOrEqual(after);
  });

  it("fails open and writes no unusable row when identity or surface is absent", async () => {
    const root = tempDir("cmux-codex-hook-open-");
    const registry = join(root, "registry.jsonl");
    const baseEnv = {
      CMUXLAYER_SESSION_REGISTRY: registry,
      CMUX_SURFACE_ID: "",
    };

    await expect(runCodexHook("not json", baseEnv)).resolves.toEqual({
      stdout: "",
      stderr: "",
    });
    await expect(
      runCodexHook(
        JSON.stringify({ session_id: "session-without-surface" }),
        baseEnv,
      ),
    ).resolves.toEqual({ stdout: "", stderr: "" });
    await expect(
      runCodexHook(JSON.stringify({ cwd: root }), {
        ...baseEnv,
        CMUX_SURFACE_ID: "surface-without-session",
      }),
    ).resolves.toEqual({ stdout: "", stderr: "" });

    expect(existsSync(registry)).toBe(false);
  });

  it("exits zero when the registry cannot be written", async () => {
    const root = tempDir("cmux-codex-hook-error-");
    const result = await runCodexHook(
      JSON.stringify({ session_id: "session", cwd: root }),
      {
        CMUXLAYER_SESSION_REGISTRY: root,
        CMUX_SURFACE_ID: "surface",
      },
    );

    expect(result).toEqual({ stdout: "", stderr: "" });
  });
});

describe("shipped self-registration hooks", () => {
  it("writes no Claude row when the required surface identity is absent", async () => {
    const root = tempDir("cmux-claude-hook-open-");
    const registry = join(root, "registry.jsonl");

    await expect(
      runHook(
        claudeHook,
        JSON.stringify({ session_id: "session-without-surface", cwd: root }),
        {
          CMUXLAYER_SESSION_REGISTRY: registry,
          CMUX_SURFACE_ID: "",
        },
      ),
    ).resolves.toEqual({ stdout: "", stderr: "" });

    expect(existsSync(registry)).toBe(false);
  });

  it.each([
    ["Claude", claudeHook],
    ["Codex", codexHook],
  ])("trims the %s registry override before writing", async (_cli, hook) => {
    const root = tempDir("cmux-hook-trimmed-registry-");
    const registry = join(root, "registry.jsonl");

    await runHook(
      hook,
      JSON.stringify({ session_id: "trimmed-session", cwd: root }),
      {
        CMUXLAYER_SESSION_REGISTRY: `  ${registry}  `,
        CMUX_SURFACE_ID: "trimmed-surface",
      },
    );

    expect(readFileSync(registry, "utf8")).toContain("trimmed-session");
  });

  it.each([
    ["Claude", claudeHook],
    ["Codex", codexHook],
  ])("allows a relative %s registry override", async (_cli, hook) => {
    const root = tempDir("cmux-hook-relative-registry-");

    await runHook(
      hook,
      JSON.stringify({ session_id: "relative-session", cwd: root }),
      {
        CMUXLAYER_SESSION_REGISTRY: "registry.jsonl",
        CMUX_SURFACE_ID: "relative-surface",
      },
      root,
    );

    expect(readFileSync(join(root, "registry.jsonl"), "utf8")).toContain(
      "relative-session",
    );
  });
});

describe("installSessionHooks", () => {
  it("backs up and merges both hook configs without clobbering existing settings", async () => {
    const homeDir = tempDir("cmux-hook-home-");
    const claudeDir = join(homeDir, ".claude");
    const codexDir = join(homeDir, ".codex");
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });
    const claudeSettings = join(claudeDir, "settings.json");
    const codexHooks = join(codexDir, "hooks.json");
    const codexConfig = join(codexDir, "config.toml");
    const originalClaude = {
      permissions: { allow: ["Read"] },
      hooks: {
        SessionStart: [
          {
            matcher: ".*",
            hooks: [{ type: "command", command: "python3 existing.py" }],
          },
        ],
        Stop: [{ hooks: [{ type: "command", command: "python3 stop.py" }] }],
      },
    };
    const originalCodex = {
      description: "keep me",
      hooks: {
        SessionEnd: [
          { hooks: [{ type: "command", command: "python3 end.py" }] },
        ],
      },
    };
    const originalToml = 'notify = ["existing", "turn-ended"]\n';
    writeFileSync(
      claudeSettings,
      JSON.stringify(originalClaude, null, 2) + "\n",
    );
    writeFileSync(codexHooks, JSON.stringify(originalCodex, null, 2) + "\n");
    writeFileSync(codexConfig, originalToml);

    const first = await installSessionHooks({ homeDir, assetsDir: hookAssets });
    const firstClaudeText = readFileSync(claudeSettings, "utf8");
    const firstCodexText = readFileSync(codexHooks, "utf8");
    const installedClaude = JSON.parse(firstClaudeText);
    const installedCodex = JSON.parse(firstCodexText);

    expect(installedClaude.permissions).toEqual(originalClaude.permissions);
    expect(installedClaude.hooks.Stop).toEqual(originalClaude.hooks.Stop);
    expect(installedClaude.hooks.SessionStart[0]).toEqual(
      originalClaude.hooks.SessionStart[0],
    );
    expect(
      installedClaude.hooks.SessionStart.flatMap((group: any) => group.hooks),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "command",
          command: expect.stringContaining("cmux-self-register.py"),
          timeout: 5,
        }),
      ]),
    );
    expect(installedCodex.description).toBe("keep me");
    expect(installedCodex.hooks.SessionEnd).toEqual(
      originalCodex.hooks.SessionEnd,
    );
    expect(installedCodex.hooks.SessionStart).toEqual([
      expect.objectContaining({
        matcher: "startup|resume",
        hooks: [
          expect.objectContaining({
            type: "command",
            command: expect.stringContaining("codex-cmux-self-register.py"),
            timeout: 5,
          }),
        ],
      }),
    ]);
    expect(readFileSync(codexConfig, "utf8")).toBe(originalToml);
    expect(readFileSync(`${claudeSettings}.bak`, "utf8")).toBe(
      JSON.stringify(originalClaude, null, 2) + "\n",
    );
    expect(readFileSync(`${codexHooks}.bak`, "utf8")).toBe(
      JSON.stringify(originalCodex, null, 2) + "\n",
    );
    expect(first.changed).toEqual(
      expect.arrayContaining([claudeSettings, codexHooks]),
    );

    const second = await installSessionHooks({
      homeDir,
      assetsDir: hookAssets,
    });
    expect(second.changed).toEqual([]);
    expect(readFileSync(claudeSettings, "utf8")).toBe(firstClaudeText);
    expect(readFileSync(codexHooks, "utf8")).toBe(firstCodexText);
    expect(existsSync(`${claudeSettings}.bak.1`)).toBe(false);
    expect(existsSync(`${codexHooks}.bak.1`)).toBe(false);
  });

  it("refuses invalid existing JSON before mutating anything", async () => {
    const homeDir = tempDir("cmux-hook-invalid-");
    const codexDir = join(homeDir, ".codex");
    mkdirSync(codexDir, { recursive: true });
    const codexHooks = join(codexDir, "hooks.json");
    writeFileSync(codexHooks, "{not valid json\n");

    await expect(
      installSessionHooks({ homeDir, assetsDir: hookAssets }),
    ).rejects.toThrow(/hooks\.json.*valid JSON/i);
    expect(readFileSync(codexHooks, "utf8")).toBe("{not valid json\n");
    expect(existsSync(join(homeDir, ".claude", "hooks"))).toBe(false);
    expect(existsSync(join(homeDir, ".codex", "hooks"))).toBe(false);
  });

  it("does not mistake a command containing the hook path for the installed hook", async () => {
    const homeDir = tempDir("cmux-hook-exact-command-");
    const claudeDir = join(homeDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const claudeSettings = join(claudeDir, "settings.json");
    const installedHook = join(
      claudeDir,
      "hooks",
      "cmux-self-register.py",
    );
    writeFileSync(
      claudeSettings,
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: `exec python3 '${installedHook}.old'`,
                },
              ],
            },
          ],
        },
      }),
    );

    await installSessionHooks({ homeDir, assetsDir: hookAssets });

    const installed = JSON.parse(readFileSync(claudeSettings, "utf8"));
    const commands = installed.hooks.SessionStart.flatMap((group: any) =>
      group.hooks.map((handler: any) => handler.command),
    );
    expect(commands).toContain(`exec python3 '${installedHook}'`);
    expect(commands).toContain(`exec python3 '${installedHook}.old'`);
  });

  it("preserves restrictive modes on existing config files", async () => {
    const homeDir = tempDir("cmux-hook-config-mode-");
    const claudeDir = join(homeDir, ".claude");
    const codexDir = join(homeDir, ".codex");
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });
    const claudeSettings = join(claudeDir, "settings.json");
    const codexHooks = join(codexDir, "hooks.json");
    writeFileSync(claudeSettings, "{}\n");
    writeFileSync(codexHooks, "{}\n");
    chmodSync(claudeSettings, 0o600);
    chmodSync(codexHooks, 0o640);

    await installSessionHooks({ homeDir, assetsDir: hookAssets });

    expect(statSync(claudeSettings).mode & 0o777).toBe(0o600);
    expect(statSync(codexHooks).mode & 0o777).toBe(0o640);
  });

  it("creates new config files with owner-only permissions", async () => {
    const homeDir = tempDir("cmux-hook-new-config-mode-");

    await installSessionHooks({ homeDir, assetsDir: hookAssets });

    expect(
      statSync(join(homeDir, ".claude", "settings.json")).mode & 0o777,
    ).toBe(0o600);
    expect(statSync(join(homeDir, ".codex", "hooks.json")).mode & 0o777).toBe(
      0o600,
    );
  });

  it("execs both configured hooks so they record the long-lived CLI pid", async () => {
    const homeDir = tempDir("cmux-hook-cli-pid-");
    await installSessionHooks({ homeDir, assetsDir: hookAssets });
    const configurations = [
      join(homeDir, ".claude", "settings.json"),
      join(homeDir, ".codex", "hooks.json"),
    ];

    for (const [index, configPath] of configurations.entries()) {
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      const command = config.hooks.SessionStart[0].hooks[0].command;
      expect(command).toMatch(/^exec python3 /);
      const registry = join(homeDir, `registry-${index}.jsonl`);
      await runConfiguredHook(
        command,
        JSON.stringify({ session_id: `session-${index}`, cwd: homeDir }),
        {
          CMUXLAYER_SESSION_REGISTRY: registry,
          CMUX_SURFACE_ID: `surface-${index}`,
        },
      );
      const row = JSON.parse(readFileSync(registry, "utf8"));
      expect(row.pid).toBe(process.pid);
    }
  });

  it("updates symlink targets without replacing managed config symlinks", async () => {
    const homeDir = tempDir("cmux-hook-symlink-config-");
    const claudeDir = join(homeDir, ".claude");
    const dotfilesDir = join(homeDir, "dotfiles");
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(dotfilesDir, { recursive: true });
    const target = join(dotfilesDir, "claude-settings.json");
    const claudeSettings = join(claudeDir, "settings.json");
    writeFileSync(target, "{}\n");
    chmodSync(target, 0o600);
    symlinkSync(target, claudeSettings);

    await installSessionHooks({ homeDir, assetsDir: hookAssets });

    expect(lstatSync(claudeSettings).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toContain("cmux-self-register.py");
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });
});
