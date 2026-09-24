import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Operator-fleet settings that a fresh install does not need.
 *
 * AIDEV-NOTE: cmuxlayer used to hardcode one operator's fleet paths
 * (`~/.golems-zikaron`, `~/.golems/…`). Those now live in an optional JSON
 * file owned by that fleet; without it every key falls back to a generic
 * default and the fleet-only features (outbox drainer, HTTP notify, doctor's
 * launcher and sleep-guard checks) stay off. See
 * docs/guides/fresh-install.md#fleet-config.
 */
export interface FleetConfig {
  /** File the values came from; null when running on generic defaults. */
  source: string | null;
  /** Holds monitor-registry.json, watch-specs.json and outbox.md. */
  coordinationDir: string;
  /** Drain `<coordinationDir>/outbox.md` to `notifyUrl` each sweep. */
  outbox: boolean;
  outboxTitle: string;
  seatRegistryPath: string;
  /** HTTP notify listener; null skips every notify POST. */
  notifyUrl: string | null;
  /** MCP launcher shim doctor expects `.mcp.json` entries to reference. */
  mcpLauncher: string | null;
  /** launchd label of an optional sleep guard doctor reports on. */
  sleepGuardLabel: string | null;
}

export const FLEET_CONFIG_DOC = "docs/guides/fresh-install.md#fleet-config";

const LEGACY_COORDINATION_DIR = ".golems-zikaron";
const LEGACY_COORDINATION_FILES = [
  "monitor-registry.json",
  "outbox.md",
  "watch-specs.json",
];

type KeyKind = "path" | "string" | "boolean";
const KEYS: Record<Exclude<keyof FleetConfig, "source">, KeyKind> = {
  coordinationDir: "path",
  outbox: "boolean",
  outboxTitle: "string",
  seatRegistryPath: "path",
  notifyUrl: "string",
  mcpLauncher: "string",
  sleepGuardLabel: "string",
};

export function fleetConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return (
    env.CMUXLAYER_FLEET_CONFIG?.trim() ||
    join(home, ".config", "cmuxlayer", "fleet.json")
  );
}

export function genericFleetConfig(home: string = homedir()): FleetConfig {
  return {
    source: null,
    coordinationDir: join(home, ".local", "state", "cmuxlayer"),
    outbox: false,
    outboxTitle: "cmuxlayer outbox",
    seatRegistryPath: join(home, ".config", "cmuxlayer", "seats.yaml"),
    notifyUrl: null,
    mcpLauncher: null,
    sleepGuardLabel: null,
  };
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

/** Load the fleet config; throws naming the file when it is present but invalid. */
export function loadFleetConfig(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): FleetConfig {
  const path = fleetConfigPath(env, home);
  const config = genericFleetConfig(home);
  if (!existsSync(path)) {
    if (env.CMUXLAYER_FLEET_CONFIG?.trim()) {
      throw new Error(
        `CMUXLAYER_FLEET_CONFIG points at a missing file: ${path}`,
      );
    }
    return config;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`fleet config ${path} is not valid JSON`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`fleet config ${path} must be a JSON object`);
  }

  const values: Record<string, unknown> = { ...config, source: path };
  for (const [key, value] of Object.entries(raw)) {
    const kind = KEYS[key as keyof typeof KEYS];
    if (!kind) {
      throw new Error(`fleet config ${path}: unknown key "${key}"`);
    }
    if (kind === "boolean") {
      if (typeof value !== "boolean") {
        throw new Error(`fleet config ${path}: "${key}" must be a boolean`);
      }
      values[key] = value;
      continue;
    }
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(
        `fleet config ${path}: "${key}" must be a non-empty string`,
      );
    }
    values[key] = kind === "path" ? expandHome(value.trim(), home) : value.trim();
  }
  return values as unknown as FleetConfig;
}

/** One startup line when legacy fleet state would otherwise be silently orphaned. */
export function legacyCoordinationWarning(
  config: FleetConfig,
  home: string = homedir(),
): string | null {
  const legacy = findLegacyCoordinationState(config, home);
  if (legacy.length === 0) return null;
  return `[cmuxlayer] no fleet config at ${fleetConfigPath({}, home)}, but legacy coordination state exists and is NOT read: ${legacy.join(", ")}. Set "coordinationDir" in a fleet config to keep it (${FLEET_CONFIG_DOC}).`;
}

/**
 * Legacy coordination files that nothing reads any more: present only when no
 * fleet config exists but the pre-config fleet directory still holds state.
 */
export function findLegacyCoordinationState(
  config: FleetConfig,
  home: string = homedir(),
): string[] {
  if (config.source !== null) return [];
  const dir = join(home, LEGACY_COORDINATION_DIR);
  return LEGACY_COORDINATION_FILES.map((name) => join(dir, name)).filter(
    (path) => existsSync(path),
  );
}
