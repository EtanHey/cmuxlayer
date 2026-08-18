/**
 * Parity matrix for issue #392: the spawn/resume contract must hold on a
 * machine WITH a repoGolem launcher registry and on a fresh install WITHOUT
 * one. Every case below runs the real default spawn preflight -- the only
 * difference between the two lanes is whether `launchers.zsh` exists.
 *
 * AIDEV-NOTE: this file is the CI gate for the registry-optional contract
 * (`bun run test:parity`). CI runners have no registry, so the "raw" lane also
 * proves the fallback works in a genuinely launcher-free environment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AgentEngine,
  buildLaunchCommand,
  resolveSpawnLaunchPlan,
} from "../src/agent-engine.js";
import { StateManager } from "../src/state-manager.js";
import { AgentRegistry } from "../src/agent-registry.js";
import type { CmuxClient, CmuxNewSplitResult } from "../src/cmux-client.js";
import type { CliType } from "../src/agent-types.js";
import type { CmuxSurface } from "../src/types.js";

const TEST_DIR = join(tmpdir(), "cmux-parity-registry-optional");
const REPO = "parityrepo";
const SESSION = "019d9aa5-93c0-7a52-9c47-9be1f7625f3e";
const SPAWN_SURFACE_UUID = "11111111-2222-4333-8444-555555555555";

type LauncherPath = "registry" | "raw";

function makeMockClient(): CmuxClient {
  return {
    newSplit: vi.fn().mockImplementation(async (_direction, opts) => ({
      workspace: opts?.workspace ?? "ws:1",
      surface: "surface:new",
      surface_id: SPAWN_SURFACE_UUID,
      pane: "pane:1",
      title: "",
      type: "terminal",
    }) satisfies CmuxNewSplitResult),
    newSurface: vi.fn().mockImplementation(async (opts) => ({
      workspace: opts?.workspace ?? "ws:1",
      surface: "surface:new",
      surface_id: SPAWN_SURFACE_UUID,
      pane: opts.pane,
      title: "",
      type: "terminal",
    })),
    send: vi.fn().mockResolvedValue(undefined),
    sendKey: vi.fn().mockResolvedValue(undefined),
    readScreen: vi.fn().mockResolvedValue({
      surface: "surface:new",
      text: "$ ",
      lines: 20,
      scrollback_used: false,
    }),
    focusSurface: vi.fn().mockResolvedValue(undefined),
    renameTab: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn().mockResolvedValue(undefined),
    closeSurface: vi.fn().mockResolvedValue(undefined),
    moveSurface: vi.fn().mockResolvedValue({
      ok: true,
      workspace: "ws:1",
      surface: "surface:new",
      pane: "pane:1",
    }),
    listWorkspaces: vi.fn().mockResolvedValue({ workspaces: [] }),
    listPanes: vi.fn().mockResolvedValue({ panes: [] }),
    listPaneSurfaces: vi.fn().mockResolvedValue({ surfaces: [] }),
    selectWorkspace: vi.fn().mockResolvedValue(undefined),
    clearStatus: vi.fn().mockResolvedValue(undefined),
    setProgress: vi.fn().mockResolvedValue(undefined),
    clearProgress: vi.fn().mockResolvedValue(undefined),
    identify: vi.fn().mockResolvedValue({}),
    browser: vi.fn().mockResolvedValue({}),
    log: vi.fn().mockResolvedValue(undefined),
  } as unknown as CmuxClient;
}

/** Every launcher-registry CLI. `kiro` is excluded: it is raw on both lanes. */
const CLIS: readonly CliType[] = ["claude", "codex", "cursor", "gemini"];

const EXPECTED_LAUNCHER_NAME: Record<string, string> = {
  claude: `${REPO}Claude`,
  codex: `${REPO}Codex`,
  cursor: `${REPO}Cursor`,
  gemini: `${REPO}Gemini`,
};

const AGENT_ENV = "MCP_CONNECTION_NONBLOCKING=1 CLAUDE_CODE_NO_FLICKER=1";

function expectedLaunch(cli: CliType, path: LauncherPath, root: string): string {
  if (path === "registry") return `${EXPECTED_LAUNCHER_NAME[cli]} -s`;
  const cd = `cd '${root}' && `;
  switch (cli) {
    case "claude":
      return `${cd}${AGENT_ENV} claude --dangerously-skip-permissions`;
    case "codex":
      return `${cd}codex --dangerously-bypass-approvals-and-sandbox`;
    case "cursor":
      return `${cd}cursor agent --force`;
    case "gemini":
      return `${cd}${AGENT_ENV} gemini -y`;
    default:
      throw new Error(`unreachable cli ${cli}`);
  }
}

function expectedResume(cli: CliType, path: LauncherPath, root: string): string {
  if (path === "registry") {
    return cli === "codex"
      ? `${EXPECTED_LAUNCHER_NAME[cli]} --dangerously-bypass-approvals-and-sandbox resume ${SESSION}`
      : `${EXPECTED_LAUNCHER_NAME[cli]} -s --resume ${SESSION}`;
  }
  const cd = `cd '${root}' && `;
  switch (cli) {
    case "claude":
      return `${cd}${AGENT_ENV} claude --resume ${SESSION}`;
    case "codex":
      return `${cd}codex resume ${SESSION}`;
    case "cursor":
      return `${cd}cursor agent --resume ${SESSION}`;
    case "gemini":
      return `${cd}${AGENT_ENV} gemini --resume ${SESSION}`;
    default:
      throw new Error(`unreachable cli ${cli}`);
  }
}

describe.each<LauncherPath>(["registry", "raw"])(
  "spawn/resume contract parity — %s launcher path",
  (path) => {
    let stateMgr: StateManager;
    let client: CmuxClient;
    let engine: AgentEngine;
    let repoRoot: string;
    let liveSurfaces: CmuxSurface[];

    beforeEach(() => {
      rmSync(TEST_DIR, { recursive: true, force: true });
      mkdirSync(TEST_DIR, { recursive: true });

      const repoHome = join(TEST_DIR, "checkouts");
      repoRoot = join(repoHome, REPO);
      mkdirSync(repoRoot, { recursive: true });

      const registryPath = join(TEST_DIR, "launchers.zsh");
      if (path === "registry") {
        writeFileSync(registryPath, `repoGolem ${REPO} "${repoRoot}"\n`);
      }
      // The raw lane points at a path that does not exist: exactly what a
      // brew-install machine looks like.
      vi.stubEnv("CMUXLAYER_LAUNCHER_REGISTRY_PATH", registryPath);
      vi.stubEnv("CMUXLAYER_REPO_HOME", repoHome);
      delete process.env.CMUXLAYER_REQUIRE_LAUNCHER_REGISTRY;

      stateMgr = new StateManager(TEST_DIR);
      client = makeMockClient();
      liveSurfaces = [];
      const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
      engine = new AgentEngine(stateMgr, registry, client, {
        sessionIdentityResolver: () => null,
        inboxOpts: { baseDir: TEST_DIR },
        codexModelListRunner: async () => ({ stdout: "codex\n" }),
      });
    });

    afterEach(() => {
      engine.dispose();
      vi.unstubAllEnvs();
      rmSync(TEST_DIR, { recursive: true, force: true });
    });

    it.each(CLIS)("spawns %s and records an equivalent receipt", async (cli) => {
      const result = await engine.spawnAgent({
        repo: REPO,
        cli,
        prompt: "parity probe",
      });

      // --- Receipt equivalence: identical across both lanes. ---
      expect(result).toMatchObject({
        parent_agent_id: null,
        surface_id: "surface:new",
        workspace_id: "ws:1",
        state: "booting",
        cwd: repoRoot,
      });
      // Agent id naming is lane-independent: the seat name is derived from
      // the repo+cli, never from whether a launcher binary exists.
      expect(result.agent_id).toMatch(
        new RegExp(`^${EXPECTED_LAUNCHER_NAME[cli]}-[0-9a-f]+$`),
      );

      const record = engine.getAgentState(result.agent_id);
      expect(record).toMatchObject({
        repo: REPO,
        cli,
        state: "booting",
        launch_cwd: repoRoot,
        role: "worker",
      });
      // The ONLY receipt field that legitimately differs between lanes.
      expect(record?.launcher_name).toBe(
        path === "registry" ? EXPECTED_LAUNCHER_NAME[cli] : null,
      );

      // --- Launch command: launcher form vs raw form. ---
      const [, launchCmd] = (client.send as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(launchCmd).toBe(expectedLaunch(cli, path, repoRoot));

      // The tab title is a discovery contract and must NOT vary by lane.
      expect(client.renameTab).toHaveBeenCalledWith(
        "surface:new",
        `${EXPECTED_LAUNCHER_NAME[cli]} [surface:new]`,
        expect.anything(),
      );
    });

    it.each(CLIS)("resumes %s with a runnable command", async (cli) => {
      const spawned = await engine.spawnAgent({
        repo: REPO,
        cli,
        prompt: "parity probe",
      });
      const updated = stateMgr.updateRecord(spawned.agent_id, {
        state: "done",
        cli_session_id: SESSION,
      });
      engine.getRegistry().set(spawned.agent_id, updated);
      (client.send as ReturnType<typeof vi.fn>).mockClear();

      const resumed = await engine.resumeAgent(spawned.agent_id);

      // Public identity survives a resume on BOTH lanes (U5 spawn-resume law).
      expect(resumed.agent_id).toBe(spawned.agent_id);
      expect(resumed.state).toBe("booting");

      const [, resumeCmd] = (client.send as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(resumeCmd).toBe(expectedResume(cli, path, repoRoot));
      // Whatever the lane, the resumed command names the captured session.
      expect(resumeCmd).toContain(SESSION);
    });

    it.each(CLIS)(
      "advertises the same resumability for %s through the public projection",
      async (cli) => {
        const spawned = await engine.spawnAgent({
          repo: REPO,
          cli,
          prompt: "parity probe",
        });
        const updated = stateMgr.updateRecord(spawned.agent_id, {
          cli_session_id: SESSION,
        });
        engine.getRegistry().set(spawned.agent_id, updated);

        const route = engine.resolveAgentRoute(spawned.agent_id);
        expect(route.resumable).toBe(true);
        expect(route.resume_command).toBe(expectedResume(cli, path, repoRoot));
      },
    );
  },
);

/**
 * Ambient-environment gate. Nothing here stubs the registry path, so this runs
 * against whatever the HOST actually has: a developer machine with repoGolem
 * installed, and a CI runner with none. Both must satisfy the same invariant.
 * The CI matrix runs it once with a registry planted and once without.
 */
describe("ambient environment (no stubbed registry path)", () => {
  const repoHome = join(TEST_DIR, "ambient");
  let ambientRoot: string;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    ambientRoot = join(repoHome, REPO);
    mkdirSync(ambientRoot, { recursive: true });
    vi.stubEnv("CMUXLAYER_REPO_HOME", repoHome);
    delete process.env.CMUXLAYER_REQUIRE_LAUNCHER_REGISTRY;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it.each(CLIS)(
    "resolves a launchable %s plan whether or not this host has a registry",
    (cli) => {
      const plan = resolveSpawnLaunchPlan(REPO, cli);

      // Invariant: exactly one of the two doors answers, and either way the
      // plan carries a real working directory. A fresh install must never end
      // up with "no launcher AND no cwd".
      expect(plan.repoRoot).toBeTruthy();
      if (plan.launchMode === "launcher") {
        expect(plan.launcherName).toBeTruthy();
      } else {
        expect(plan.launchMode).toBe("raw");
        expect(plan.launcherName).toBeUndefined();
        expect(plan.repoRoot).toBe(ambientRoot);
      }

      // And the launch command it produces is runnable in that directory.
      const cmd = buildLaunchCommand(cli, REPO, undefined, plan.launcherName, {
        cwd: plan.launchMode === "raw" ? plan.repoRoot : undefined,
        launchMode: plan.launchMode,
      });
      expect(cmd.trim()).not.toBe("");
      if (plan.launchMode === "raw") {
        expect(cmd.startsWith(`cd '${ambientRoot}' && `)).toBe(true);
        expect(cmd).not.toMatch(/parityrepo(Claude|Codex|Cursor|Gemini)/);
      }
    },
  );
});

describe("registry-optional escape hatch", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("keeps the strict registry requirement available for registered installs", async () => {
    const repoHome = join(TEST_DIR, "checkouts");
    mkdirSync(join(repoHome, REPO), { recursive: true });
    vi.stubEnv(
      "CMUXLAYER_LAUNCHER_REGISTRY_PATH",
      join(TEST_DIR, "absent-launchers.zsh"),
    );
    vi.stubEnv("CMUXLAYER_REPO_HOME", repoHome);
    vi.stubEnv("CMUXLAYER_REQUIRE_LAUNCHER_REGISTRY", "1");

    const stateMgr = new StateManager(TEST_DIR);
    const client = makeMockClient();
    const registry = new AgentRegistry(stateMgr, async () => []);
    const engine = new AgentEngine(stateMgr, registry, client, {
      sessionIdentityResolver: () => null,
      inboxOpts: { baseDir: TEST_DIR },
    });
    try {
      await expect(
        engine.spawnAgent({ repo: REPO, cli: "claude", prompt: "" }),
      ).rejects.toThrow(/Launcher registry unavailable/);
      expect(client.newSplit).not.toHaveBeenCalled();
    } finally {
      engine.dispose();
    }
  });
});
