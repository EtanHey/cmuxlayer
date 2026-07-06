import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliType } from "./agent-types.js";
import { reposEquivalent } from "./repo-workspace.js";

export type SeatIdentityStatus = "ok" | "mismatch" | "unknown";

export interface SeatRegistryEntry {
  repo: string;
  launchers: Partial<Record<CliType, string>>;
  lane: string;
  aliases?: string[];
  role?: string;
}

export type SeatRegistry = Record<string, SeatRegistryEntry>;

export interface SeatIdentityAssertion {
  seat_id: string | null;
  seat_lane: string | null;
  seat_role: string | null;
  seat_identity_status: SeatIdentityStatus;
  seat_identity_error: string | null;
}

export interface AssertSeatIdentityInput {
  repo: string;
  cli: CliType;
  launcherName?: string | null;
  lane?: string | null;
  registry?: SeatRegistry | null;
}

const REPO_ALIASES: Record<string, string[]> = {
  orchestrator: ["orc"],
  orc: ["orchestrator"],
};

function cleanScalar(value: string): string {
  const withoutComment = value.replace(/\s+#.*$/, "").trim();
  if (
    (withoutComment.startsWith('"') && withoutComment.endsWith('"')) ||
    (withoutComment.startsWith("'") && withoutComment.endsWith("'"))
  ) {
    return withoutComment.slice(1, -1);
  }
  return withoutComment;
}

export function parseSeatRegistryConfig(raw: string): SeatRegistry {
  const lines = raw.split(/\r?\n/);
  const registry: SeatRegistry = {};
  const startIndex = lines.findIndex((line) => /^seatRegistry:\s*$/.test(line));
  if (startIndex === -1) return registry;

  let currentSeatId: string | null = null;
  let inLaunchers = false;

  for (const line of lines.slice(startIndex + 1)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.match(/^ */)?.[0].length ?? 0;
    if (indent === 0) break;

    const seatMatch = line.match(/^  ([^:\s][^:]*):\s*$/);
    if (seatMatch) {
      currentSeatId = seatMatch[1].trim();
      registry[currentSeatId] = {
        repo: "",
        launchers: {},
        lane: "",
      };
      inLaunchers = false;
      continue;
    }

    if (!currentSeatId) continue;
    const entry = registry[currentSeatId];
    if (!entry) continue;

    if (/^    launchers:\s*$/.test(line)) {
      inLaunchers = true;
      continue;
    }

    const fieldMatch = line.match(/^    ([^:\s][^:]*):\s*(.*)$/);
    if (fieldMatch) {
      inLaunchers = false;
      const [, key, rawValue] = fieldMatch;
      if (key === "repo") entry.repo = cleanScalar(rawValue);
      if (key === "lane") entry.lane = cleanScalar(rawValue);
      if (key === "role") entry.role = cleanScalar(rawValue);
      continue;
    }

    if (inLaunchers) {
      const launcherMatch = line.match(/^      ([^:\s][^:]*):\s*(.*)$/);
      if (launcherMatch) {
        const [, key, rawValue] = launcherMatch;
        if (isCliType(key)) {
          entry.launchers[key] = cleanScalar(rawValue);
        }
      }
    }
  }

  return Object.fromEntries(
    Object.entries(registry).filter(
      ([, entry]) =>
        entry.repo && entry.lane && Object.keys(entry.launchers).length > 0,
    ),
  );
}

export function defaultSeatRegistryPath(): string {
  return join(homedir(), ".golems", "config.yaml");
}

export function loadSeatRegistryFromConfig(
  configPath = defaultSeatRegistryPath(),
): SeatRegistry | null {
  if (!existsSync(configPath)) return null;
  return parseSeatRegistryConfig(readFileSync(configPath, "utf8"));
}

function isCliType(value: string): value is CliType {
  return (
    value === "claude" ||
    value === "codex" ||
    value === "gemini" ||
    value === "kiro" ||
    value === "cursor"
  );
}

function entryAssertion(
  seatId: string,
  entry: SeatRegistryEntry,
  status: SeatIdentityStatus,
  error: string | null,
): SeatIdentityAssertion {
  return {
    seat_id: seatId,
    seat_lane: entry.lane || null,
    seat_role: entry.role ?? null,
    seat_identity_status: status,
    seat_identity_error: error,
  };
}

function unknownAssertion(reason: string | null = null): SeatIdentityAssertion {
  return {
    seat_id: null,
    seat_lane: null,
    seat_role: null,
    seat_identity_status: "unknown",
    seat_identity_error: reason,
  };
}

function launcherFor(entry: SeatRegistryEntry, cli: CliType): string | null {
  return entry.launchers[cli] ?? null;
}

function seatReposEquivalent(a: string, b: string): boolean {
  if (reposEquivalent(a, b)) return true;
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  return (
    (REPO_ALIASES[left] ?? []).includes(right) ||
    (REPO_ALIASES[right] ?? []).includes(left)
  );
}

export function assertSeatIdentity(
  input: AssertSeatIdentityInput,
): SeatIdentityAssertion {
  const registryEntries = Object.entries(input.registry ?? {});
  if (registryEntries.length === 0) return unknownAssertion();

  const launcherName = input.launcherName?.trim() || null;
  const lane = input.lane?.trim() || null;
  const repoEntries = registryEntries.filter(([, entry]) =>
    seatReposEquivalent(entry.repo, input.repo),
  );
  const launcherEntries = launcherName
    ? registryEntries.filter(
        ([, entry]) => launcherFor(entry, input.cli) === launcherName,
      )
    : [];

  const exactMatch = registryEntries.find(
    ([, entry]) =>
      launcherName &&
      seatReposEquivalent(entry.repo, input.repo) &&
      launcherFor(entry, input.cli) === launcherName &&
      (!lane || entry.lane === lane),
  );
  if (exactMatch) {
    const [seatId, entry] = exactMatch;
    return entryAssertion(seatId, entry, "ok", null);
  }

  const launcherMatch = launcherEntries[0];
  if (launcherMatch) {
    const [seatId, entry] = launcherMatch;
    const reasons = [
      seatReposEquivalent(entry.repo, input.repo)
        ? null
        : `repo=${entry.repo} expected ${input.repo}`,
      lane && entry.lane !== lane ? `lane=${entry.lane} expected ${lane}` : null,
    ].filter((reason): reason is string => Boolean(reason));
    return entryAssertion(
      seatId,
      entry,
      "mismatch",
      `launcher ${launcherName} belongs to seat ${seatId} ${reasons.join(", ")}`,
    );
  }

  const repoMatch = repoEntries[0];
  if (repoMatch && launcherName) {
    const [seatId, entry] = repoMatch;
    const expectedLauncher = launcherFor(entry, input.cli);
    return entryAssertion(
      seatId,
      entry,
      "mismatch",
      `repo ${input.repo} expects ${input.cli} launcher ${expectedLauncher ?? "unregistered"}, got ${launcherName}`,
    );
  }

  return unknownAssertion(
    launcherName
      ? `no seat registry entry matched repo=${input.repo} launcher=${launcherName}`
      : `no seat registry entry matched repo=${input.repo}`,
  );
}
