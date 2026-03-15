/**
 * Mode enforcement for cmux surfaces.
 * Manual surfaces are read-only for mutating tools.
 */

import type { ControlMode, IntentMode } from "./types.js";

/** Tools that only read state — always allowed */
const READ_ONLY_TOOLS = new Set(["list_surfaces", "read_screen"]);

/** Tools that mutate state — blocked in manual mode */
const MUTATING_TOOLS = new Set([
  "send_input",
  "send_key",
  "close_surface",
  "browser_surface",
]);

const VALID_CONTROL_MODES = new Set<string>(["autonomous", "manual"]);
const VALID_INTENT_MODES = new Set<string>(["chat", "audit"]);

export function isReadOnlyTool(toolName: string): boolean {
  return READ_ONLY_TOOLS.has(toolName);
}

export function isMutatingTool(toolName: string): boolean {
  return MUTATING_TOOLS.has(toolName);
}

/**
 * Assert that a tool call is allowed given the surface's control mode.
 * Throws if a mutating tool is called on a manual surface.
 */
export function assertMutationAllowed(
  toolName: string,
  controlMode: ControlMode,
): void {
  if (controlMode === "manual" && MUTATING_TOOLS.has(toolName)) {
    throw new Error(`Tool "${toolName}" is blocked: surface is in manual mode`);
  }
}

/**
 * Parse reserved mode keys from set_status calls.
 * Returns the mode update if the key is a reserved mode key, null otherwise.
 */
export function parseReservedModeKey(
  key: string,
  value: string,
): { control?: ControlMode; intent?: IntentMode } | null {
  if (key === "mode.control") {
    if (!VALID_CONTROL_MODES.has(value)) {
      throw new Error(
        `Invalid control mode "${value}". Must be "autonomous" or "manual"`,
      );
    }
    return { control: value as ControlMode };
  }
  if (key === "mode.intent") {
    if (!VALID_INTENT_MODES.has(value)) {
      throw new Error(
        `Invalid intent mode "${value}". Must be "chat" or "audit"`,
      );
    }
    return { intent: value as IntentMode };
  }
  return null;
}
