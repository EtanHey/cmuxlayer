import { readFileSync } from "node:fs";
import {
  defaultFleetSidebarPath,
  fleetLaneLabel,
  FleetSidebarCollapseStore,
  type FleetLaneKey,
} from "./fleet-sidebar.js";

const USAGE =
  "Usage: cmuxlayer fleet-sidebar <collapse|expand|toggle|state> [lane]";

const LANE_KEYS: FleetLaneKey[] = [
  "orc",
  "golems",
  "voicelayer",
  "skillCreator",
  "cmuxlayer",
  "coach",
  "mm",
  "other",
];

const LANE_BY_INPUT = new Map<string, FleetLaneKey>(
  [
    ...LANE_KEYS.flatMap((key) => {
      const normalized = normalizeLaneInput(key);
      return [[normalized, key] as const];
    }),
    ["matchmat", "mm"] as const,
  ],
);

export interface FleetSidebarCommandResult {
  ok: boolean;
  message: string;
}

export interface FleetSidebarCommandOptions {
  store?: FleetSidebarCollapseStore;
  sidebarPath?: string;
}

/**
 * Fallback for cmux's remote-Swift action gap: ButtonAction can dispatch only
 * cmux commands, while the V2 socket exposes no side-effect-free callback that
 * can carry a lane id back to cmuxlayer. The generator owner therefore persists
 * the preference here; the publisher watches that state file and regenerates
 * its last authoritative snapshot inside the existing 500 ms write gate.
 */
export function runFleetSidebarCommand(
  args: string[],
  opts: FleetSidebarCommandOptions = {},
): FleetSidebarCommandResult {
  const [action, laneInput] = args;
  const store = opts.store ?? new FleetSidebarCollapseStore();
  if (action === "state" && laneInput === undefined) {
    return { ok: true, message: JSON.stringify(store.read()) };
  }
  if (!isMutationAction(action) || laneInput === undefined) {
    return { ok: false, message: USAGE };
  }

  const lane = LANE_BY_INPUT.get(normalizeLaneInput(laneInput));
  if (!lane) {
    return {
      ok: false,
      message: `Unknown fleet lane "${laneInput}"; expected ${LANE_KEYS.join(", ")}`,
    };
  }

  let collapsed: boolean;
  if (action === "collapse") {
    collapsed = true;
    store.setLaneCollapsed(lane, collapsed);
  } else if (action === "expand") {
    collapsed = false;
    store.setLaneCollapsed(lane, collapsed);
  } else {
    const rendered = readRenderedLaneState(
      opts.sidebarPath ?? defaultFleetSidebarPath(),
      lane,
    );
    collapsed = store.toggleLane(lane, rendered);
  }

  return {
    ok: true,
    message: `${lane} lane ${collapsed ? "collapsed" : "expanded"}`,
  };
}

function isMutationAction(
  action: string | undefined,
): action is "collapse" | "expand" | "toggle" {
  return action === "collapse" || action === "expand" || action === "toggle";
}

function normalizeLaneInput(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function readRenderedLaneState(
  sidebarPath: string,
  lane: FleetLaneKey,
): boolean | undefined {
  try {
    const source = readFileSync(sidebarPath, "utf8");
    const renderedLabels = new Set([fleetLaneLabel(lane), lane]);
    for (const renderedLabel of renderedLabels) {
      const label = JSON.stringify(renderedLabel);
      const match = source.match(
        new RegExp(
          `fleetLane\\(${escapeRegExp(label)},\\s*\\d+,\\s*\\d+,\\s*(true|false),`,
        ),
      );
      if (match?.[1] === "true") return true;
      if (match?.[1] === "false") return false;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
