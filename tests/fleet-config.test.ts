import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findLegacyCoordinationState,
  fleetConfigPath,
  legacyCoordinationWarning,
  loadFleetConfig,
} from "../src/fleet-config.js";
import { defaultMonitorRegistryPath } from "../src/monitor-registry.js";
import { defaultWatchRegistryPath } from "../src/watch-spec.js";
import { defaultOutboxPath } from "../src/outbox-drainer.js";
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

  it.each([
    ["invalid JSON", "{", /not valid JSON/],
    ["a non-object", "[]", /must be a JSON object/],
    ["an unknown key", '{"coordDir":"/x"}', /unknown key "coordDir"/],
    ["a wrong type", '{"outbox":"yes"}', /"outbox" must be a boolean/],
    ["an empty path", '{"coordinationDir":" "}', /"coordinationDir" must be a non-empty string/],
  ])("rejects %s and names the file", (_label, body, message) => {
    const home = tempHome();
    const path = join(home, "fleet.json");
    writeFileSync(path, body);

    expect(() =>
      loadFleetConfig({ CMUXLAYER_FLEET_CONFIG: path }, home),
    ).toThrow(message);
    expect(() =>
      loadFleetConfig({ CMUXLAYER_FLEET_CONFIG: path }, home),
    ).toThrow(path);
  });

  it("rejects an explicit CMUXLAYER_FLEET_CONFIG that does not exist", () => {
    const home = tempHome();
    const path = join(home, "missing.json");

    expect(() =>
      loadFleetConfig({ CMUXLAYER_FLEET_CONFIG: path }, home),
    ).toThrow(/CMUXLAYER_FLEET_CONFIG points at a missing file/);
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
  it("puts monitor, watch, and outbox state under the coordination dir", () => {
    const home = tempHome();
    const path = join(home, "fleet.json");
    writeFileSync(path, JSON.stringify({ coordinationDir: join(home, "coord") }));
    vi.stubEnv("CMUXLAYER_FLEET_CONFIG", path);

    expect(defaultMonitorRegistryPath()).toBe(
      join(home, "coord", "monitor-registry.json"),
    );
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
});
