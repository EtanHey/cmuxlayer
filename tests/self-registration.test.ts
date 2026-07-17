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

/**
 * Minimal AgentRecord for resolver tests — the resolver only reads
 * `launch_cwd` and `pid`; the composed-default tests additionally need
 * `cli`/`repo`/`state`/`created_at`/`task_summary` for the scan guard.
 */
function agent(overrides: Partial<AgentRecord>): AgentRecord {
  return {
    agent_id: "cmuxlayerClaude-pending",
    surface_id: "surface:1",
    state: "booting",
    repo: "cmuxlayer",
    model: "opus",
    cli: "claude",
    cli_session_id: null,
    task_summary: "do the thing",
    pid: null,
    version: 1,
    created_at: "2026-07-18T00:00:00.000Z",
    updated_at: "2026-07-18T00:00:00.000Z",
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
      .map((r) => (typeof r === "string" ? r : JSON.stringify(r)))
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

  it("requires session_id AND cwd; drops records missing either", () => {
    const text = jsonl(
      { session_id: "sid-1", cwd: "/w" },
      { session_id: "no-cwd" },
      { cwd: "/no-session" },
      { session_id: "", cwd: "/w" },
    );
    const entries = parseSelfRegistrationLines(text);
    expect(entries.map((e) => e.session_id)).toEqual(["sid-1"]);
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
      cwd: "/w",
      pid: 10,
      cli: "codex",
      session_path: "/rollout/abc.jsonl",
      ts: 1234,
    });
  });
});

describe("makeSelfRegistrationSessionResolver", () => {
  it("returns the registered session_id on a cwd-exact match", () => {
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

  it("disambiguates 3 worktrees by cwd — each agent binds ONLY its own (no cross-binding)", () => {
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

  it("same-cwd, pid known and matching: pid wins even against a newer-ts entry", () => {
    const resolve = resolverFor(
      jsonl(
        { session_id: "sid-old", cwd: "/w", pid: 100, ts: 1000 },
        { session_id: "sid-new", cwd: "/w", pid: 200, ts: 2000 },
      ),
    );
    expect(resolve(agent({ launch_cwd: "/w", pid: 100 }))?.session_id).toBe(
      "sid-old",
    );
  });

  it("same-cwd, pid known but no entry matches: falls back to newest ts", () => {
    const resolve = resolverFor(
      jsonl(
        { session_id: "sid-old", cwd: "/w", pid: 100, ts: 1000 },
        { session_id: "sid-new", cwd: "/w", pid: 200, ts: 2000 },
      ),
    );
    expect(resolve(agent({ launch_cwd: "/w", pid: 999 }))?.session_id).toBe(
      "sid-new",
    );
  });

  it("no cwd match returns null (never fabricates)", () => {
    const resolve = resolverFor(
      jsonl({ session_id: "sid-1", cwd: "/other", pid: 1, ts: 1 }),
    );
    expect(resolve(agent({ launch_cwd: "/w" }))).toBeNull();
  });

  it("returns null when the agent has no launch_cwd", () => {
    const resolve = resolverFor(
      jsonl({ session_id: "sid-1", cwd: "/w", pid: 1, ts: 1 }),
    );
    expect(resolve(agent({ launch_cwd: null }))).toBeNull();
  });

  it("skips malformed lines but still binds a valid same-cwd entry", () => {
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
  function makeEngine(
    selfRegistrationSessionResolver:
      ReturnType<typeof makeSelfRegistrationSessionResolver> | (() => null),
  ): AgentEngine {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    const stateMgr = new StateManager(TEST_DIR);
    const registry = new AgentRegistry(stateMgr, async () => []);
    const client = {
      readScreen: vi.fn(),
      log: vi.fn(),
    } as unknown as CmuxClient;
    return new AgentEngine(stateMgr, registry, client, {
      spawnPreflight: async () => {},
      selfRegistrationSessionResolver,
    });
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
});
