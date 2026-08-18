/**
 * How a spawned or resumed agent handles its CLI's tool-approval prompt.
 *
 * AIDEV-NOTE: this used to be an unconditional bypass. `cmuxlayer init` asks
 * about it, so the answer has to mean something — a fresh install must be able
 * to say "have agents ask me" and get CLIs launched in their normal mode. The
 * default is unchanged (`skip-permissions`), because an agent in a background
 * pane that stops on its first tool call reads as a hung pane.
 */

export type SpawnPermissionMode = "skip-permissions" | "default";

export const SPAWN_PERMISSION_MODE_ENV = "CMUXLAYER_SPAWN_PERMISSION_MODE";

export const DEFAULT_SPAWN_PERMISSION_MODE: SpawnPermissionMode =
  "skip-permissions";

/**
 * Resolve the mode from the environment. Anything unrecognised keeps the
 * default rather than failing a spawn over a typo'd profile line.
 */
export function resolveSpawnPermissionMode(
  env: Record<string, string | undefined> = process.env,
): SpawnPermissionMode {
  const value = env[SPAWN_PERMISSION_MODE_ENV]?.trim().toLowerCase();
  if (value === "default" || value === "ask" || value === "prompt") {
    return "default";
  }
  return DEFAULT_SPAWN_PERMISSION_MODE;
}

export function bypassesApprovals(mode: SpawnPermissionMode): boolean {
  return mode === "skip-permissions";
}
