// Shared types for cmuxlayer MCP server

export type ControlMode = "autonomous" | "manual";
export type IntentMode = "chat" | "audit";

export interface SurfaceMode {
  control: ControlMode;
  intent: IntentMode;
}

export interface CmuxWorkspace {
  id?: string;
  ref: string;
  title: string;
  index: number;
  selected: boolean;
  pinned: boolean;
  current_directory?: string | null;
}

export type SurfaceWorkingDirectorySource =
  | "terminal_metadata"
  | "surface"
  | "pane"
  | "workspace_fallback"
  | "unavailable";

export interface CmuxSurface {
  id?: string;
  ref: string;
  title: string;
  type: "terminal" | "browser";
  index: number;
  selected: boolean;
  workspace_ref?: string;
  pane_ref?: string;
  pane_id?: string;
  current_directory?: string | null;
  cwd?: string | null;
  working_directory?: string | null;
  requested_working_directory?: string | null;
  working_directory_source?: SurfaceWorkingDirectorySource;
  working_directory_fallback?: boolean;
}

export interface CmuxPane {
  id?: string;
  ref: string;
  index: number;
  focused: boolean;
  surface_count: number;
  surface_refs: string[];
  surface_ids?: string[];
  selected_surface_ref?: string;
  current_directory?: string | null;
  cwd?: string | null;
  working_directory?: string | null;
  requested_working_directory?: string | null;
  pixel_frame?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface CmuxPaneSurfaces {
  workspace_ref: string;
  window_ref: string;
  pane_ref: string;
  surfaces: CmuxSurface[];
}

export interface CmuxTerminalMetadata {
  surface_ref?: string | null;
  surface_id?: string | null;
  ref?: string | null;
  workspace_ref?: string | null;
  pane_ref?: string | null;
  current_directory?: string | null;
  cwd?: string | null;
  working_directory?: string | null;
  requested_working_directory?: string | null;
}

export interface CmuxNewSplitResult {
  workspace: string;
  surface: string;
  /** Stable cmux surface UUID; `surface` remains the mutable process-local ref. */
  surface_id?: string;
  pane: string;
  title: string;
  type: "terminal" | "browser";
}

export interface CmuxNewSurfaceResult {
  workspace: string;
  surface: string;
  /** Stable cmux surface UUID; `surface` remains the mutable process-local ref. */
  surface_id?: string;
  pane: string;
  title: string;
  type: "terminal" | "browser";
}

export interface CmuxMoveSurfaceResult {
  ok: boolean;
  workspace: string;
  surface: string;
  pane: string;
}

export interface CmuxReorderSurfaceResult {
  ok: boolean;
  surface: string;
}

export interface CmuxReadScreenResult {
  surface: string;
  text: string;
  lines: number;
  scrollback_used: boolean;
}

export interface CmuxSendOptions {
  workspace?: string;
  chunk_size?: number;
  chunk_delay_ms?: number;
}

export type ParsedScreenAgentType =
  | "claude"
  | "codex"
  | "gemini"
  | "cursor"
  | "unknown";
export type ParsedScreenStatus =
  | "frozen"
  | "thinking"
  | "working"
  | "idle"
  | "done";
export type ParsedCliUpdateState = "updating" | "update_complete";
export type ParsedControlPlaneState =
  | "unknown"
  | "shell"
  | "agent_booting"
  | "ready"
  | "busy"
  | "interactive_overlay"
  | "permission_prompt"
  | "composer_dirty"
  | "dead"
  | "stale_surface"
  | "poisoned_registry";
export type PauseSource = "cmux-reported" | "inferred";
/** Pause forms the detector can actually see. UI pause is not among them today. */
export type PauseCoverage = "harness_only";

export const HARNESS_ONLY_PAUSE_NOTE =
  "cmux-UI pause not detectable; see #447";

/** Caveat attached to inferred pause so value:false is not read as authoritative. */
export function pauseHonestyFields(source: PauseSource): {
  coverage?: PauseCoverage;
  note?: string;
} {
  if (source === "cmux-reported") return {};
  return {
    coverage: "harness_only",
    note: HARNESS_ONLY_PAUSE_NOTE,
  };
}

export interface ParsedScreenResult {
  agent_type: ParsedScreenAgentType;
  status: ParsedScreenStatus;
  control_state: ParsedControlPlaneState;
  token_count: number | null;
  context_pct: number | null;
  context_window: number | null;
  done_signal: string | null;
  response: string | null;
  current_action: string | null;
  errors: string[];
  model: string | null;
  cost: number | null;
  cli_update_state?: ParsedCliUpdateState;
  actions?: string[];
  /** Visible pause chrome. Absent cmux field means this is always inferred. */
  paused: boolean;
  paused_source: PauseSource;
  /** Present while source is inferred; omitted once a cmux-reported pause exists. */
  paused_coverage?: PauseCoverage;
  paused_note?: string;
}

export interface CmuxStatusEntry {
  key: string;
  value: string;
  icon?: string;
  color?: string;
}

export interface CmuxStatusUpdate extends CmuxStatusEntry {
  workspace?: string;
  surface?: string;
}

export interface ToolResult {
  ok: boolean;
  surface?: string;
  workspace?: string;
  title?: string;
  applied?: string;
  error?: string;
}
