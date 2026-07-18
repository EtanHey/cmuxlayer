import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import { rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  makeSelfRegistrationSessionResolver,
  parseSelfRegistrationLines,
  resolveSessionRegistryPath,
} from "../src/self-registration.js";
import type { AgentRecord } from "../src/agent-types.js";
import { AgentEngine } from "../src/agent-engine.js";
import { StateManager } from "../src/state-manager.js";
import { AgentRegistry } from "../src/agent-registry.js";
import type { CmuxClient } from "../src/cmux-client.js";

const TEST_DIR = join(tmpdir(), "cmux-self-registration-test");
const SURFACE_UUID_A = "11111111-2222-4333-8444-555555555555";
const SURFACE_UUID_B = "66666666-7777-4888-8999-aaaaaaaaaaaa";

/**
 * Minimal AgentRecord for resolver tests — the resolver only reads
 * `surface_uuid` and optionally `launch_cwd`; the composed-default tests need
 * `cli`/`repo`/`state`/`created_at`/`task_summary` for the scan guard.
 */
function agent(overrides: Partial<AgentRecord>): AgentRecord {
  return {
    agent_id: "cmuxlayerClaude-pending",
    surface_id: "surface:1",
    surface_uuid: SURFACE_UUID_A,
    state: "booting",
    repo: "cmuxlayer",
    model: "opus",
    cli: "claude",
    cli_session_id: null,
    task_summary: "do the thing",
    pid: null,
    version: 1,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    error: null,
    parent_agent_id: null,
    spawn_depth: 0,
    deletion_intent: false,
    quality: "unknown",
    max_cost_per_agent: null,
    launch_cwd: "/Users/e/Gits/cmuxlayer",
    ...overrides,
  } as AgentRecord;
}

/** Build a JSONL registry body from record objects (append-only, one/line). */
function jsonl(...records: Array<Record<string, unknown> | string>): string {
  return (
    records
      .map((r) =>
        typeof r === "string"
          ? r
          : JSON.stringify({ surface_uuid: SURFACE_UUID_A, ...r }),
      )
      .join("\n") + "\n"
  );
}

function resolverFor(text: string) {
  return makeSelfRegistrationSessionResolver({
    registryPath: "/fake/registry.jsonl",
    readFile: () => text,
  });
}

describe("resolveSessionRegistryPath", () => {
  it("prefers CMUXLAYER_SESSION_REGISTRY when set", () => {
    expect(
      resolveSessionRegistryPath({
        CMUXLAYER_SESSION_REGISTRY: "/custom/reg.jsonl",
      }),
    ).toBe("/custom/reg.jsonl");
  });

  it("defaults to ~/.cmuxlayer/session-registry.jsonl", () => {
    expect(resolveSessionRegistryPath({})).toBe(
      join(homedir(), ".cmuxlayer", "session-registry.jsonl"),
    );
  });
});

describe("parseSelfRegistrationLines", () => {
  it("ignores malformed lines and keeps valid records", () => {
    const text = jsonl(
      { session_id: "sid-1", cwd: "/w", pid: 10, ts: 1000 },
      "this is not json {{{",
      "",
      { session_id: "sid-2", cwd: "/w", pid: 20, ts: 2000 },
    );
    const entries = parseSelfRegistrationLines(text);
    expect(entries.map((e) => e.session_id)).toEqual(["sid-1", "sid-2"]);
  });

  it("requires session_id and surface_uuid while allowing cwd to be absent", () => {
    const text = jsonl(
      { session_id: "sid-1", cwd: "/w" },
      { session_id: "sid-no-cwd", cwd: null },
      { session_id: "no-surface", surface_uuid: null, cwd: "/w" },
      { cwd: "/no-session" },
      { session_id: "", cwd: "/w" },
    );
    const entries = parseSelfRegistrationLines(text);
    expect(entries.map((e) => e.session_id)).toEqual([
      "sid-1",
      "sid-no-cwd",
    ]);
  });

  it("tolerates unknown extra fields and preserves session_path", () => {
    const entries = parseSelfRegistrationLines(
      jsonl({
        session_id: "sid-1",
        cwd: "/w",
        pid: 10,
        cli: "codex",
        launcher: "cmuxlayerCodex",
        session_path: "/rollout/abc.jsonl",
        ts: 1234,
        somethingNew: "future-field",
      }),
    );
    expect(entries[0]).toMatchObject({
      session_id: "sid-1",
      surface_uuid: SURFACE_UUID_A,
      cwd: "/w",
      pid: 10,
      cli: "codex",
      session_path: "/rollout/abc.jsonl",
      ts: 1234,
    });
  });

  it("does not use fractional pid or timestamp values as integer identity metadata", () => {
    const entries = parseSelfRegistrationLines(
      jsonl({
        session_id: "sid-1",
        cwd: "/w",
        pid: 10.5,
        ts: 1234.5,
      }),
    );

    expect(entries[0]).toMatchObject({
      session_id: "sid-1",
      cwd: "/w",
      pid: null,
      ts: null,
    });
  });
});

describe("makeSelfRegistrationSessionResolver", () => {
  it("returns the registered session_id on a surface_uuid-exact match", () => {
    const resolve = resolverFor(
      jsonl({
        session_id: "sid-exact",
        cwd: "/Users/e/Gits/cmuxlayer",
        pid: 111,
        session_path: "/rollout/exact.jsonl",
        ts: 5000,
      }),
    );
    expect(resolve(agent({ launch_cwd: "/Users/e/Gits/cmuxlayer" }))).toEqual({
      session_id: "sid-exact",
      path: "/rollout/exact.jsonl",
    });
  });

  it("returns path:null when the entry has no session_path", () => {
    const resolve = resolverFor(
      jsonl({ session_id: "sid-1", cwd: "/w", pid: 1, ts: 1 }),
    );
    expect(resolve(agent({ launch_cwd: "/w" }))).toEqual({
      session_id: "sid-1",
      path: null,
    });
  });

  it("uses exact cwd as an optional secondary among records for one surface", () => {
    const cwdA = "/Users/e/Gits/repo.wt/alpha";
    const cwdB = "/Users/e/Gits/repo.wt/beta";
    const cwdC = "/Users/e/Gits/repo";
    const resolve = resolverFor(
      jsonl(
        { session_id: "sid-A", cwd: cwdA, pid: 1, ts: 1000 },
        { session_id: "sid-B", cwd: cwdB, pid: 2, ts: 1001 },
        { session_id: "sid-C", cwd: cwdC, pid: 3, ts: 1002 },
      ),
    );
    expect(resolve(agent({ launch_cwd: cwdA, pid: null }))?.session_id).toBe(
      "sid-A",
    );
    expect(resolve(agent({ launch_cwd: cwdB, pid: null }))?.session_id).toBe(
      "sid-B",
    );
    expect(resolve(agent({ launch_cwd: cwdC, pid: null }))?.session_id).toBe(
      "sid-C",
    );
  });

  it("binds distinct surface UUIDs without cwd and never cross-binds them", () => {
    const resolve = resolverFor(
      jsonl(
        {
          session_id: "sid-A",
          surface_uuid: SURFACE_UUID_A,
          cwd: null,
          ts: 2000,
        },
        {
          session_id: "sid-B",
          surface_uuid: SURFACE_UUID_B,
          cwd: "/wrong/cwd",
          ts: 3000,
        },
      ),
    );

    expect(
      resolve(
        agent({ surface_uuid: SURFACE_UUID_A, launch_cwd: "/agent/a" }),
      )?.session_id,
    ).toBe("sid-A");
    expect(
      resolve(
        agent({ surface_uuid: SURFACE_UUID_B, launch_cwd: "/agent/b" }),
      )?.session_id,
    ).toBe("sid-B");
  });

  it("same-cwd, pid unknown (production reality): newest ts wins", () => {
    const resolve = resolverFor(
      jsonl(
        { session_id: "sid-old", cwd: "/w", pid: 100, ts: 1000 },
        { session_id: "sid-new", cwd: "/w", pid: 200, ts: 2000 },
      ),
    );
    expect(resolve(agent({ launch_cwd: "/w", pid: null }))?.session_id).toBe(
      "sid-new",
    );
  });

  it("ignores AgentRecord.pid because production does not populate the CLI pid", () => {
    const resolve = resolverFor(
      jsonl(
        { session_id: "sid-old", cwd: "/w", pid: 100, ts: 1000 },
        { session_id: "sid-new", cwd: "/w", pid: 200, ts: 2000 },
      ),
    );
    expect(resolve(agent({ launch_cwd: "/w", pid: 100 }))?.session_id).toBe(
      "sid-new",
    );
  });

  it("uses the UUID match when cwd is mismatched", () => {
    const resolve = resolverFor(
      jsonl({ session_id: "sid-1", cwd: "/other", pid: 1, ts: 1 }),
    );
    expect(resolve(agent({ launch_cwd: "/w" }))?.session_id).toBe("sid-1");
  });

  it("uses the UUID match when the agent has no launch_cwd", () => {
    const resolve = resolverFor(
      jsonl({ session_id: "sid-1", cwd: "/w", pid: 1, ts: 1 }),
    );
    expect(resolve(agent({ launch_cwd: null }))?.session_id).toBe("sid-1");
  });

  it("returns null when the agent has no surface_uuid", () => {
    const resolve = resolverFor(
      jsonl({ session_id: "sid-1", cwd: "/w", pid: 1, ts: 1 }),
    );
    expect(resolve(agent({ surface_uuid: null, launch_cwd: "/w" }))).toBeNull();
  });

  it("rejects a same-surface record older than the current launch window", () => {
    const createdAt = Date.parse("2026-07-18T00:00:10.000Z");
    const resolve = resolverFor(
      jsonl({
        session_id: "sid-stale",
        cwd: "/w",
        ts: createdAt - 5_001,
      }),
    );

    expect(
      resolve(
        agent({
          launch_cwd: "/w",
          surface_provenance: "cmuxlayer_spawn",
          created_at: new Date(createdAt).toISOString(),
        }),
      ),
    ).toBeNull();
  });

  it("accepts a hook record within the five-second launch tolerance", () => {
    const createdAt = Date.parse("2026-07-18T00:00:10.000Z");
    const resolve = resolverFor(
      jsonl({
        session_id: "sid-current",
        cwd: "/w",
        ts: createdAt - 5_000,
      }),
    );

    expect(
      resolve(
        agent({
          launch_cwd: "/w",
          surface_provenance: "cmuxlayer_spawn",
          created_at: new Date(createdAt).toISOString(),
        }),
      )?.session_id,
    ).toBe("sid-current");
  });

  it("rejects a same-surface record without an epoch timestamp", () => {
    const resolve = resolverFor(
      jsonl({ session_id: "sid-undated", cwd: "/w" }),
    );

    expect(resolve(agent({ launch_cwd: "/w" }))).toBeNull();
  });

  it("ignores a future-dated row instead of letting it dominate the current registration", () => {
    const now = Date.parse("2026-07-18T00:01:00.000Z");
    const createdAt = now - 30_000;
    const resolve = makeSelfRegistrationSessionResolver({
      registryPath: "/fake/registry.jsonl",
      readFile: () =>
        jsonl(
          { session_id: "sid-current", cwd: "/w", ts: now },
          {
            session_id: "sid-future-stale",
            cwd: "/w",
            ts: now + 5_001,
          },
        ),
      now: () => now,
    });

    expect(
      resolve(
        agent({
          launch_cwd: "/w",
          created_at: new Date(createdAt).toISOString(),
        }),
      )?.session_id,
    ).toBe("sid-current");
  });

  it.each([
    {
      label: "auto-discovered",
      overrides: {
        surface_provenance: "unknown" as const,
        task_summary: "(auto-discovered)",
        launcher_name: null,
        launch_cwd: null,
        worktree_path: null,
      },
    },
    {
      label: "resync-repaired",
      overrides: {
        surface_provenance: undefined,
        task_summary: "(resync-repaired)",
        launch_cwd: null,
        worktree_path: null,
      },
    },
  ])(
    "accepts a valid $label registration older than its discovery record",
    ({ overrides }) => {
      const now = Date.parse("2026-07-18T00:10:00.000Z");
      const discoveredAt = now - 10_000;
      const resolve = makeSelfRegistrationSessionResolver({
        registryPath: "/fake/registry.jsonl",
        readFile: () =>
          jsonl({
            session_id: "sid-already-running",
            cwd: "/actual/agent/cwd",
            ts: discoveredAt - 60_000,
          }),
        now: () => now,
      });

      expect(
        resolve(
          agent({
            ...overrides,
            created_at: new Date(discoveredAt).toISOString(),
          }),
        )?.session_id,
      ).toBe("sid-already-running");
    },
  );

  it("accepts a timestamp at the reader-clock skew boundary", () => {
    const now = Date.parse("2026-07-18T00:01:00.000Z");
    const createdAt = now - 30_000;
    const resolve = makeSelfRegistrationSessionResolver({
      registryPath: "/fake/registry.jsonl",
      readFile: () =>
        jsonl({
          session_id: "sid-skew-boundary",
          cwd: "/w",
          ts: now + 5_000,
        }),
      now: () => now,
    });

    expect(
      resolve(
        agent({
          launch_cwd: "/w",
          created_at: new Date(createdAt).toISOString(),
        }),
      )?.session_id,
    ).toBe("sid-skew-boundary");
  });

  it("skips malformed lines but still binds a valid same-surface entry", () => {
    const resolve = resolverFor(
      jsonl("corrupt line not json", {
        session_id: "sid-good",
        cwd: "/w",
        pid: 1,
        ts: 1,
      }),
    );
    expect(resolve(agent({ launch_cwd: "/w" }))?.session_id).toBe("sid-good");
  });

  it("empty file returns null (no throw)", () => {
    const resolve = resolverFor("");
    expect(() => resolve(agent({ launch_cwd: "/w" }))).not.toThrow();
    expect(resolve(agent({ launch_cwd: "/w" }))).toBeNull();
  });

  it("missing/unreadable file (readFile throws) returns null (no throw)", () => {
    const resolve = makeSelfRegistrationSessionResolver({
      registryPath: "/does/not/exist.jsonl",
      readFile: () => {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      },
    });
    expect(() => resolve(agent({ launch_cwd: "/w" }))).not.toThrow();
    expect(resolve(agent({ launch_cwd: "/w" }))).toBeNull();
  });

  it("readFile returning null returns null (no throw)", () => {
    const resolve = makeSelfRegistrationSessionResolver({
      registryPath: "/does/not/exist.jsonl",
      readFile: () => null,
    });
    expect(resolve(agent({ launch_cwd: "/w" }))).toBeNull();
  });
});

/**
 * Engine-composition tests: self-registration is the PRIMARY resolver; the
 * transcript scan (findTranscriptSessionIdentity → findLatestHarnessSessionIdentity)
 * is only a deprecated last-resort fallback reached when self-registration
 * returns null. Exercised via the engine's composed default resolver directly so
 * the assertion is hermetic (no real HOME I/O).
 */
describe("AgentEngine self-registration wiring", () => {
  function makeEngineHarness(
    selfRegistrationSessionResolver:
      ReturnType<typeof makeSelfRegistrationSessionResolver> | (() => null),
  ): {
    engine: AgentEngine;
    stateMgr: StateManager;
    registry: AgentRegistry;
  } {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    const stateMgr = new StateManager(TEST_DIR);
    const registry = new AgentRegistry(stateMgr, async () => []);
    const client = {
      readScreen: vi.fn(),
      log: vi.fn(),
    } as unknown as CmuxClient;
    return {
      engine: new AgentEngine(stateMgr, registry, client, {
        spawnPreflight: async () => {},
        selfRegistrationSessionResolver,
      }),
      stateMgr,
      registry,
    };
  }

  function makeEngine(
    selfRegistrationSessionResolver:
      ReturnType<typeof makeSelfRegistrationSessionResolver> | (() => null),
  ): AgentEngine {
    return makeEngineHarness(selfRegistrationSessionResolver).engine;
  }

  it("uses the self-registration hit and does NOT call the transcript scan", () => {
    const engine = makeEngine(() => ({
      session_id: "sid-self-reg",
      path: "/rollout/x.jsonl",
    }));
    const scanSpy = vi.spyOn(
      engine as unknown as {
        findTranscriptSessionIdentity: (a: AgentRecord) => unknown;
      },
      "findTranscriptSessionIdentity",
    );
    const resolver = (
      engine as unknown as {
        sessionIdentityResolver: (a: AgentRecord) => unknown;
      }
    ).sessionIdentityResolver;

    const result = resolver(agent({ launch_cwd: "/w" }));

    expect(result).toEqual({
      session_id: "sid-self-reg",
      path: "/rollout/x.jsonl",
    });
    expect(scanSpy).not.toHaveBeenCalled();
    engine.dispose();
  });

  it("falls back to the transcript scan when self-registration returns null", () => {
    const engine = makeEngine(() => null);
    const scanSpy = vi
      .spyOn(
        engine as unknown as {
          findTranscriptSessionIdentity: (a: AgentRecord) => unknown;
        },
        "findTranscriptSessionIdentity",
      )
      .mockReturnValue({ session_id: "sid-scan", path: null });
    const resolver = (
      engine as unknown as {
        sessionIdentityResolver: (a: AgentRecord) => unknown;
      }
    ).sessionIdentityResolver;

    const result = resolver(agent({ launch_cwd: "/w" }));

    expect(result).toEqual({ session_id: "sid-scan", path: null });
    expect(scanSpy).toHaveBeenCalledTimes(1);
    engine.dispose();
  });

  it("captures a raw auto-discovered agent using only its stable surface UUID", async () => {
    const selfRegistrationSessionResolver = vi.fn(() => ({
      session_id: "sid-raw",
      path: "/rollout/raw.jsonl",
    }));
    const { engine, stateMgr, registry } = makeEngineHarness(
      selfRegistrationSessionResolver,
    );
    const rawAgent = agent({
      agent_id: "auto-claude-surface-live",
      state: "working",
      launcher_name: null,
      launch_cwd: null,
      worktree_path: null,
      task_summary: "(auto-discovered)",
    });
    stateMgr.writeState(rawAgent);
    registry.set(rawAgent.agent_id, rawAgent);

    const captured = await engine.captureBootSessionId(rawAgent.agent_id);

    expect(captured).toMatchObject({
      cli_session_id: "sid-raw",
      cli_session_path: "/rollout/raw.jsonl",
    });
    expect(selfRegistrationSessionResolver).toHaveBeenCalledTimes(1);
    engine.dispose();
  });

  it("captures self-registration on first connect without invoking the scan", async () => {
    const selfRegistrationSessionResolver = vi.fn(() => ({
      session_id: "sid-first-connect",
      path: null,
    }));
    const { engine, stateMgr, registry } = makeEngineHarness(
      selfRegistrationSessionResolver,
    );
    const rawAgent = agent({
      agent_id: "auto-claude-surface-first-connect",
      state: "ready",
      launcher_name: null,
      launch_cwd: null,
      worktree_path: null,
      task_summary: "(auto-discovered)",
    });
    stateMgr.writeState(rawAgent);
    registry.set(rawAgent.agent_id, rawAgent);
    const scanSpy = vi.spyOn(
      engine as unknown as {
        findTranscriptSessionIdentity: (a: AgentRecord) => unknown;
      },
      "findTranscriptSessionIdentity",
    );

    const captured = await (
      engine as unknown as {
        maybeCaptureBootSessionId(
          a: AgentRecord,
          ctx: Record<string, never>,
          opts: { resolveTranscript: boolean },
        ): Promise<AgentRecord>;
      }
    ).maybeCaptureBootSessionId(rawAgent, {}, { resolveTranscript: false });

    expect(captured.cli_session_id).toBe("sid-first-connect");
    expect(selfRegistrationSessionResolver).toHaveBeenCalledTimes(1);
    expect(scanSpy).not.toHaveBeenCalled();
    engine.dispose();
  });
});
