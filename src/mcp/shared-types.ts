// Types shared by createServer and the extracted MCP tool modules (moved out of
// server.ts, CX-3b S10b).

export type MonitorBootResult = {
  status: "bootstrapped" | "monitor-not-ready";
  heartbeat_written: boolean;
  heartbeat_source: "server_boot";
  monitor_command: string;
  /** Agent-owned consumption watermark; the engine never writes this file. */
  cursor_path: string;
  /** Run after handling with the message id supplied as CMUX_INBOX_MSG_ID. */
  cursor_update_command: string;
  cursor_update_env: "CMUX_INBOX_MSG_ID";
  error?: string;
};

export type FocusTarget = {
  workspace: string;
  surface?: string;
};

export type FocusRestoreLease = {
  prior: FocusTarget;
  expected: FocusTarget;
};

export type RawSurfaceMutationRoute = {
  surface: string;
  workspace?: string;
  /** Live cmux tab title for this surface when topology knows it. */
  title: string | null;
  stableSurfaceIdentity: string | null;
  remapped_from?: string;
  remapped_to?: string;
  assertCurrent: () => Promise<void>;
};
