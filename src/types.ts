// Shared types for cmux MCP server

export type ControlMode = "autonomous" | "manual";
export type IntentMode = "chat" | "audit";

export interface SurfaceMode {
  control: ControlMode;
  intent: IntentMode;
}

export interface CmuxWorkspace {
  ref: string;
  title: string;
  index: number;
  selected: boolean;
  pinned: boolean;
}

export interface CmuxSurface {
  ref: string;
  title: string;
  type: "terminal" | "browser";
  index: number;
  selected: boolean;
}

export interface CmuxPane {
  ref: string;
  index: number;
  focused: boolean;
  surface_count: number;
  surface_refs: string[];
  selected_surface_ref?: string;
}

export interface CmuxPaneSurfaces {
  workspace_ref: string;
  window_ref: string;
  pane_ref: string;
  surfaces: CmuxSurface[];
}

export interface CmuxNewSplitResult {
  workspace: string;
  surface: string;
  pane: string;
  title: string;
  type: "terminal" | "browser";
}

export interface CmuxReadScreenResult {
  surface: string;
  text: string;
  lines: number;
  scrollback_used: boolean;
}

export interface CmuxStatusEntry {
  key: string;
  value: string;
  icon?: string;
  color?: string;
}

export interface ToolResult {
  ok: boolean;
  surface?: string;
  workspace?: string;
  title?: string;
  applied?: string;
  error?: string;
}
