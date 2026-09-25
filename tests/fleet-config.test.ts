import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findLegacyCoordinationState,
  fleetConfigPath,
  legacyCoordinationWarning,
  loadFleetConfig,
  readFleetConfig,
  resetFleetConfigWarningsForTests,
} from "../src/fleet-config.js";
import {
  defaultWatchRegistryPath,
  httpNotifyWatch,
} from "../src/watch-spec.js";
import {
  defaultOutboxDrain,
  defaultOutboxPath,
  httpDeliver,
  resetNotifyBackoffForTests,
} from "../src/outbox-drainer.js";
import { defaultSeatRegistryPath } from "../src/seat-identity.js";

const GOLEMS_FIXTURE = join(__dirname, "fixtures", "fleet", "golems-fleet.json");
const tempDirs: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "cmuxlayer-fleet-home-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetFleetConfigWarningsForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetNotifyBackoffForTests();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("fleet config", () => {
  it("uses generic defaults when no fleet config exists", () => {
    const home = tempHome();
    const config = loadFleetConfig({}, home);

    expect(config).toEqual({
      source: null,
      coordinationDir: join(home, ".local", "state", "cmuxlayer"),
      outbox: false,
      outboxTitle: "cmuxlayer outbox",
      seatRegistryPath: join(home, ".config", "cmuxlayer", "seats.yaml"),
      notifyUrl: null,
      mcpLauncher: null,
      sleepGuardLabel: null,
      worktreeBootstrap: null,
    });
    expect(fleetConfigPath({}, home)).toBe(
      join(home, ".config", "cmuxlayer", "fleet.json"),
    );
  });

  it("reads the default fleet.json and expands ~ in path keys", () => {
    const home = tempHome();
    mkdirSync(join(home, ".config", "cmuxlayer"), { recursive: true });
    writeFileSync(
      join(home, ".config", "cmuxlayer", "fleet.json"),
      JSON.stringify({ coordinationDir: "~/.golems-zikaron", outbox: true }),
    );

    expect(loadFleetConfig({}, home)).toMatchObject({
      source: join(home, ".config", "cmuxlayer", "fleet.json"),
      coordinationDir: join(home, ".golems-zikaron"),
      outbox: true,
      notifyUrl: null,
    });
  });

  it("honours CMUXLAYER_FLEET_CONFIG with the golems values", () => {
    const home = tempHome();
    const config = loadFleetConfig(
      { CMUXLAYER_FLEET_CONFIG: GOLEMS_FIXTURE },
      home,
    );

    expect(config).toEqual({
      source: GOLEMS_FIXTURE,
      coordinationDir: join(home, ".golems-zikaron"),
      outbox: true,
      outboxTitle: "golems outbox",
      seatRegistryPath: join(home, ".golems", "config.yaml"),
      notifyUrl: "http://127.0.0.1:3847/notify",
      mcpLauncher: "~/.golems/bin/cmuxlayer-mcp",
      sleepGuardLabel: "com.golems.cmux-caffeinate",
      worktreeBootstrap: null,
    });
  });

  it("accepts absolute $HOME paths as written", () => {
    const home = tempHome();
    const path = join(home, "fleet.json");
    writeFileSync(
      path,
      JSON.stringify({
        coordinationDir: "/srv/fleet/.golems-zikaron",
        seatRegistryPath: "/srv/fleet/.golems/config.yaml",
        mcpLauncher: "/srv/fleet/.golems/bin/cmuxlayer-mcp",
      }),
    );

    expect(
      loadFleetConfig({ CMUXLAYER_FLEET_CONFIG: path }, home),
    ).toMatchObject({
      coordinationDir: "/srv/fleet/.golems-zikaron",
      seatRegistryPath: "/srv/fleet/.golems/config.yaml",
      mcpLauncher: "/srv/fleet/.golems/bin/cmuxlayer-mcp",
    });
  });

  it("reads a set worktreeBootstrap and expands ~", () => {
    const home = tempHome();
    const path = join(home, "fleet.json");
    writeFileSync(
      path,
      JSON.stringify({ worktreeBootstrap: "~/bin/worktree-bootstrap.sh" }),
    );

    expect(
      loadFleetConfig({ CMUXLAYER_FLEET_CONFIG: path }, home).worktreeBootstrap,
    ).toBe(join(home, "bin", "worktree-bootstrap.sh"));
  });

  it.each([
    ["invalid JSON", "{", /not valid JSON/],
    ["a non-object", "[]", /must be a JSON object/],
    ["an unknown key", '{"coordDir":"/x"}', /unknown key "coordDir"/],
    ["a wrong type", '{"outbox":"yes"}', /"outbox" must be a boolean/],
    ["an empty path", '{"coordinationDir":" "}', /"coordinationDir" must be a non-empty string/],
    ["a non-string worktreeBootstrap", '{"worktreeBootstrap":3}', /"worktreeBootstrap" must be a non-empty string/],
  ])("rejects %s and names the file", (_label, body, message) => {
    const home = tempHome();
    const path = join(home, "fleet.json");
    writeFileSync(path, body);

    expect(() =>
      readFleetConfig({ CMUXLAYER_FLEET_CONFIG: path }, home),
    ).toThrow(message);
    expect(() =>
      readFleetConfig({ CMUXLAYER_FLEET_CONFIG: path }, home),
    ).toThrow(path);
  });

  it("rejects an explicit CMUXLAYER_FLEET_CONFIG that does not exist", () => {
    const home = tempHome();
    const path = join(home, "missing.json");

    expect(() =>
      readFleetConfig({ CMUXLAYER_FLEET_CONFIG: path }, home),
    ).toThrow(/CMUXLAYER_FLEET_CONFIG points at a missing file/);
  });

  it("never throws at runtime: a bad file logs one line and yields generic defaults", () => {
    const home = tempHome();
    const path = join(home, "fleet.json");
    writeFileSync(path, '{"outbox":"yes"}');
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);

    for (let call = 0; call < 3; call += 1) {
      expect(
        loadFleetConfig({ CMUXLAYER_FLEET_CONFIG: path }, home, log),
      ).toEqual({ ...loadFleetConfig({}, home), source: null });
    }
    expect(
      loadFleetConfig({ CMUXLAYER_FLEET_CONFIG: join(home, "gone.json") }, home, log),
    ).toMatchObject({ source: null });

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(path);
    expect(lines[0]).toMatch(/"outbox" must be a boolean; using generic defaults/);
    expect(lines[1]).toMatch(/missing file/);
  });
});

describe("legacy coordination state guard", () => {
  it("lists legacy ~/.golems-zikaron state when no fleet config claims it", () => {
    const home = tempHome();
    const legacy = join(home, ".golems-zikaron");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "watch-specs.json"), "{}");
    writeFileSync(join(legacy, "outbox.md"), "");

    expect(findLegacyCoordinationState(loadFleetConfig({}, home), home)).toEqual([
      join(legacy, "outbox.md"),
      join(legacy, "watch-specs.json"),
    ]);
  });

  it("builds one startup warning naming the orphaned files and the doc", () => {
    const home = tempHome();
    expect(legacyCoordinationWarning(loadFleetConfig({}, home), home)).toBeNull();

    const legacy = join(home, ".golems-zikaron");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "monitor-registry.json"), "{}");
    const warning = legacyCoordinationWarning(loadFleetConfig({}, home), home);

    expect(warning).toContain(join(legacy, "monitor-registry.json"));
    expect(warning).toContain("docs/guides/fresh-install.md#fleet-config");
    expect(warning?.split("\n")).toHaveLength(1);
  });

  it("stays quiet when a fleet config exists or nothing legacy remains", () => {
    const home = tempHome();
    expect(findLegacyCoordinationState(loadFleetConfig({}, home), home)).toEqual([]);

    const legacy = join(home, ".golems-zikaron");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "monitor-registry.json"), "{}");
    const config = loadFleetConfig(
      { CMUXLAYER_FLEET_CONFIG: GOLEMS_FIXTURE },
      home,
    );
    expect(findLegacyCoordinationState(config, home)).toEqual([]);
  });
});

describe("paths and switches follow the fleet config", () => {
  it("puts watch and outbox state under the coordination dir", () => {
    const home = tempHome();
    const path = join(home, "fleet.json");
    writeFileSync(path, JSON.stringify({ coordinationDir: join(home, "coord") }));
    vi.stubEnv("CMUXLAYER_FLEET_CONFIG", path);

    expect(defaultWatchRegistryPath()).toBe(join(home, "coord", "watch-specs.json"));
    expect(defaultOutboxPath()).toBe(join(home, "coord", "outbox.md"));
  });

  it("keeps CMUXLAYER_SEAT_REGISTRY_PATH ahead of the fleet seat registry", () => {
    expect(
      defaultSeatRegistryPath({
        CMUXLAYER_SEAT_REGISTRY_PATH: "/explicit/seats.yaml",
        CMUXLAYER_FLEET_CONFIG: GOLEMS_FIXTURE,
      }),
    ).toBe("/explicit/seats.yaml");
    expect(
      defaultSeatRegistryPath({ CMUXLAYER_FLEET_CONFIG: GOLEMS_FIXTURE }),
    ).toMatch(/\/\.golems\/config\.yaml$/);
  });

  it("disables the outbox drainer unless the fleet config enables it", () => {
    const home = tempHome();
    expect(defaultOutboxDrain(loadFleetConfig({}, home))).toBeUndefined();
    expect(
      defaultOutboxDrain(
        loadFleetConfig({ CMUXLAYER_FLEET_CONFIG: GOLEMS_FIXTURE }, home),
      ),
    ).toEqual(expect.any(Function));
  });
});

describe("notify delivery fails soft", () => {
  it("skips delivery without network I/O when no notifyUrl is configured", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      httpDeliver({ title: "t", body: "b", source: "s", priority: "default" }, null),
    ).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("treats watch notifications as skipped when no listener is configured", async () => {
    const transport = vi.fn();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      httpNotifyWatch(
        {
          watch_id: "w1",
          owner: "lead",
          target: "/tmp/x",
          reason: "predicate_matched",
          notify: true,
        } as Parameters<typeof httpNotifyWatch>[0],
        null,
        transport,
      ),
    ).resolves.toBe(true);
    expect(transport).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("logs an unreachable listener once and backs off instead of retrying every sweep", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchSpy);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const payload = { title: "t", body: "b", source: "s", priority: "default" };
    const url = "http://127.0.0.1:3847/notify";

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(httpDeliver(payload, url)).resolves.toBe(false);
    }

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0]?.[0])).toContain(url);
  });

  it("clears the backoff after a successful delivery", async () => {
    vi.useFakeTimers();
    try {
      const fetchSpy = vi
        .fn()
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchSpy);
      vi.spyOn(console, "error").mockImplementation(() => {});
      const payload = { title: "t", body: "b", source: "s", priority: "default" };
      const url = "http://127.0.0.1:3847/notify";

      await expect(httpDeliver(payload, url)).resolves.toBe(false);
      vi.advanceTimersByTime(60_001);
      await expect(httpDeliver(payload, url)).resolves.toBe(true);
      await expect(httpDeliver(payload, url)).resolves.toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
