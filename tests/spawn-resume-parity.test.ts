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
import {
  loadLauncherRegistrySnapshot,
  resolveLauncherPrefix,
  resolveRepoRootFromLauncherRegistry,
} from "../src/launcher-registry.js";
import { StateManager } from "../src/state-manager.js";
import { AgentRegistry } from "../src/agent-registry.js";
import type { CmuxClient, CmuxNewSplitResult } from "../src/cmux-client.js";
import type { CliType } from "../src/agent-types.js";
import type { CmuxSurface } from "../src/types.js";
import { useHarnessHome } from "./helpers/harness-home.js";

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

/**
 * Approval-bypass token each lane must carry, in BOTH its launch and its
 * resume command. Asserted lane-INDEPENDENTLY below: a hand-written
 * per-lane expectation table cannot catch a divergence it encodes, which is
 * exactly how the first cut of this suite blessed a raw resume that had
 * silently dropped `--dangerously-skip-permissions` (review MUST_FIX 1).
 */
const RAW_BYPASS: Record<string, string> = {
  claude: " --dangerously-skip-permissions",
  codex: " --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust",
  cursor: " --force",
  gemini: " -y",
};

const LAUNCH_BYPASS: Record<LauncherPath, Record<string, string>> = {
  // repoGolem launchers take `-s` for every harness at launch.
  registry: { claude: " -s", codex: " -s", cursor: " -s", gemini: " -s" },
  raw: RAW_BYPASS,
};

const RESUME_BYPASS: Record<LauncherPath, Record<string, string>> = {
  // ...but the codex launcher's resume form spells it out in full.
  registry: {
    claude: " -s",
    codex: " --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust",
    cursor: " -s",
    gemini: " -s",
  },
  raw: RAW_BYPASS,
};

/**
 * `gemini --resume` takes "latest" or an index, never a UUID, so there is no
 * raw gemini resume to compare. The parity contract for it is a REFUSAL on
 * the raw lane, asserted explicitly rather than skipped.
 */
const RAW_RESUME_UNSUPPORTED: readonly CliType[] = ["gemini"];
const RESUMABLE_CLIS = CLIS.filter(
  (cli) => !RAW_RESUME_UNSUPPORTED.includes(cli),
);

function expectedLaunch(cli: CliType, path: LauncherPath, root: string): string {
  if (path === "registry") return `${EXPECTED_LAUNCHER_NAME[cli]} -s`;
  const cd = `cd '${root}' && `;
  switch (cli) {
    case "claude":
      return `${cd}${AGENT_ENV} claude --dangerously-skip-permissions`;
    case "codex":
      return `${cd}codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust`;
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
      ? `${EXPECTED_LAUNCHER_NAME[cli]} --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust resume ${SESSION}`
      : `${EXPECTED_LAUNCHER_NAME[cli]} -s --resume ${SESSION}`;
  }
  const cd = `cd '${root}' && `;
  switch (cli) {
    case "claude":
      return `${cd}${AGENT_ENV} claude --dangerously-skip-permissions --resume ${SESSION}`;
    case "codex":
      return `${cd}codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust resume ${SESSION}`;
    case "cursor":
      return `${cd}cursor agent --force --resume ${SESSION}`;
    default:
      throw new Error(`no raw resume form for ${cli}`);
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
    /** True when this lane read the HOST's registry instead of a stubbed one. */
    let registryIsAmbient = false;
    // Resume is only advertised for a session that EXISTS (#482), so every
    // harness whose resume this matrix exercises gets a transcript.
    const harnessHome = useHarnessHome();

    beforeEach(() => {
      for (const cli of ["claude", "codex", "cursor"] as const) {
        harnessHome.give(cli, SESSION);
      }
      rmSync(TEST_DIR, { recursive: true, force: true });
      mkdirSync(TEST_DIR, { recursive: true });
      registryIsAmbient = false;

      const repoHome = join(TEST_DIR, "checkouts");
      repoRoot = join(repoHome, REPO);
      mkdirSync(repoRoot, { recursive: true });

      // When the host already has a registry naming this repo (the `present`
      // leg of the launcher-parity CI matrix, or a dev machine with a
      // `parityrepo` registration), the registry lane runs against THAT file
      // rather than a stub -- so the planted registry is genuinely observed
      // instead of being shadowed by an env override.
      const ambient = loadLauncherRegistrySnapshot();
      const ambientRegistered =
        ambient.available && resolveLauncherPrefix(REPO, ambient.entries);

      if (path === "registry" && ambientRegistered) {
        registryIsAmbient = true;
        repoRoot = resolveRepoRootFromLauncherRegistry(REPO);
        mkdirSync(repoRoot, { recursive: true });
      } else {
        const registryPath = join(TEST_DIR, "launchers.zsh");
        if (path === "registry") {
          writeFileSync(registryPath, `repoGolem ${REPO} "${repoRoot}"\n`);
        }
        // The raw lane points at a path that does not exist: exactly what a
        // brew-install machine looks like.
        vi.stubEnv("CMUXLAYER_LAUNCHER_REGISTRY_PATH", registryPath);
      }
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
      // The ONLY receipt fields that legitimately differ between lanes.
      expect(record?.launcher_name).toBe(
        path === "registry" ? EXPECTED_LAUNCHER_NAME[cli] : null,
      );
      expect(record?.launch_mode).toBe(
        path === "registry" ? "launcher" : "raw",
      );
      if (registryIsAmbient) {
        // Proof the planted/host registry drove this, not a stubbed one: the
        // root came from launchers.zsh, outside the test's own scratch dir.
        expect(repoRoot.startsWith(TEST_DIR)).toBe(false);
      }

      // --- Launch command: launcher form vs raw form. ---
      const [, launchCmd] = (client.send as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(launchCmd).toBe(expectedLaunch(cli, path, repoRoot));

      // The tab title names the AGENT (#492), and must not vary by lane.
      expect(client.renameTab).toHaveBeenCalledWith(
        "surface:new",
        `${result.agent_id} [surface:new]`,
        expect.anything(),
      );
    });

    it.each(RESUMABLE_CLIS)(
      "resumes %s with a runnable command",
      async (cli) => {
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
      },
    );

    // --- Lane-INDEPENDENT invariants. These read the command the engine
    // actually sent and assert a property of it, so they hold no per-lane
    // expected string that could encode a divergence as intentional. ---

    it.each(CLIS)(
      "launches %s with an approval bypass on either lane",
      async (cli) => {
        await engine.spawnAgent({ repo: REPO, cli, prompt: "parity probe" });

        const [, launchCmd] = (client.send as ReturnType<typeof vi.fn>).mock
          .calls[0];
        expect(launchCmd).toContain(LAUNCH_BYPASS[path][cli]);
      },
    );

    it.each(RESUMABLE_CLIS)(
      "RESUMES %s with the same approval bypass it was launched with",
      async (cli) => {
        const spawned = await engine.spawnAgent({
          repo: REPO,
          cli,
          prompt: "parity probe",
        });
        const [, launchCmd] = (client.send as ReturnType<typeof vi.fn>).mock
          .calls[0];
        const updated = stateMgr.updateRecord(spawned.agent_id, {
          state: "done",
          cli_session_id: SESSION,
        });
        engine.getRegistry().set(spawned.agent_id, updated);
        (client.send as ReturnType<typeof vi.fn>).mockClear();

        await engine.resumeAgent(spawned.agent_id);
        const [, resumeCmd] = (client.send as ReturnType<typeof vi.fn>).mock
          .calls[0];

        // An agent that comes back WITHOUT its bypass blocks on its first tool
        // call and presents as a hung pane, not a failed resume.
        expect(launchCmd).toContain(LAUNCH_BYPASS[path][cli]);
        expect(resumeCmd).toContain(RESUME_BYPASS[path][cli]);
      },
    );

    it.each(RAW_RESUME_UNSUPPORTED)(
      "handles %s resume according to launcher availability",
      async (cli) => {
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

        if (path === "raw") {
          // `gemini --resume` takes "latest" or an index, never a UUID.
          await expect(engine.resumeAgent(spawned.agent_id)).rejects.toThrow(
            /no runnable resume command/i,
          );
          expect(client.send).not.toHaveBeenCalled();
          expect(engine.resolveAgentRoute(spawned.agent_id).resumable).toBe(
            false,
          );
          return;
        }

        // The registered launcher has a UUID resume form. Main's #486 policy
        // refuses only on proof of absence; an unreadable Gemini store leaves
        // the registry claim standing instead of fabricating a disk verdict.
        await engine.resumeAgent(spawned.agent_id);
        expect(client.send).toHaveBeenCalled();
        expect(engine.resolveAgentRoute(spawned.agent_id).resumable).toBe(true);
      },
    );

    it.each(CLIS)(
      "reports truthful model provenance for %s",
      async (cli) => {
        const result = await engine.spawnAgent({
          repo: REPO,
          cli,
          prompt: "parity probe",
        });
        const [, launchCmd] = (client.send as ReturnType<typeof vi.fn>).mock
          .calls[0];

        expect(result.launch_mode).toBe(path === "registry" ? "launcher" : "raw");
        expect(engine.getAgentState(result.agent_id)?.launch_mode).toBe(
          result.launch_mode,
        );

        // The receipt may claim a pin ONLY if the command applied one.
        const commandPinned = / (--model|-m) /.test(launchCmd);
        if (path === "registry") {
          expect(result.model_pin).toBe("launcher");
        } else if (commandPinned) {
          expect(result.model_pin).toBe("cli_flag");
        } else {
          expect(result.model_pin).toBe("cli_default");
          expect(result.warnings).toEqual(
            expect.arrayContaining([
              expect.stringContaining("MODEL PIN NOT APPLIED"),
            ]),
          );
        }
        expect(engine.getAgentState(result.agent_id)?.model_pin).toBe(
          result.model_pin,
        );
      },
    );

    it("discloses a raw launch that happened past a PRESENT registry", async () => {
      const result = await engine.spawnAgent({
        repo: REPO,
        cli: "claude",
        prompt: "parity probe",
      });

      if (path === "raw") {
        expect(result.warnings).toEqual(
          expect.arrayContaining([expect.stringContaining("RAW LAUNCH:")]),
        );
      } else {
        expect(result.warnings ?? []).not.toEqual(
          expect.arrayContaining([expect.stringContaining("RAW LAUNCH:")]),
        );
      }
    });

    it.each(RESUMABLE_CLIS)(
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
