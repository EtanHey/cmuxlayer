/**
 * Mode enforcement for cmux surfaces.
 * Manual surfaces are read-only for mutating tools.
 */

import type { ControlMode } from "./types.js";

/** Tools that only read state — always allowed */
const READ_ONLY_TOOLS = new Set([
  "list_surfaces",
  "control_health",
  "read_screen",
]);

/** Tools that mutate state — blocked in manual mode */
const MUTATING_TOOLS = new Set([
  "select_workspace",
  "delete_workspace",
  "new_split",
  "new_surface",
  "move_surface",
  "send_input",
  "send_command",
  "boot_prompt",
  "send_key",
  "rename_tab",
  "focus_surface",
  "close_surface",
  "spawn_agent",
  "stop_agent",
  "send_to",
  "agent_engine",
]);

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

